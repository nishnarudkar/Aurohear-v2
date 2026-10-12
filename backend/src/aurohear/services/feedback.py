"""Qualitative self-report, NLP analysis and insight storage (docs/NLP_RELIABILITY_MODULE.md).

Rules from the NLP module design, enforced here:
  * Temporal separation — feedback (and so analysis) only after the test: an in-progress
    session rejects feedback (409).
  * Clinical independence — the analysis and the symptom↔audiometry correlation only READ
    the stored, already-computed audiogram; nothing here writes to trials, thresholds,
    quality metrics or the classification.
  * Graceful degradation — if analysis fails the feedback is still stored.
  * Access control — the participant receives a receipt only; insights are admin-only.
  * Audit trail — every NLP operation is logged (logger "aurohear.nlp").
  * Insights are append-only: a newer model adds a row, never overwrites one.
"""

from __future__ import annotations

import logging
from dataclasses import asdict
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from aurohear.db import FeedbackRow, NlpInsightRow, SessionRow
from aurohear.schemas import (
    FeedbackCreate,
    FeedbackOut,
    FeedbackReceipt,
    NlpInsightCreate,
    NlpInsightOut,
    SessionInsightsOut,
    SessionStatus,
)

from .errors import Conflict, NotFound
from .nlp import Analysis, FeedbackAnalyzer, LexiconFeedbackAnalyzer, correlate
from .sessions import get_session

log = logging.getLogger("aurohear.nlp")

_default_analyzer: FeedbackAnalyzer = LexiconFeedbackAnalyzer()


def accepted_audiogram(session: SessionRow) -> dict[str, dict[int, float | None]] | None:
    """The finalised, accepted thresholds (read-only). None if the session is not finalised."""
    if session.quality is None:
        return None
    out: dict[str, dict[int, float | None]] = {"right": {}, "left": {}}
    for t in session.thresholds:
        if t.is_accepted:
            out[t.ear][t.frequency_hz] = None if t.status == "unresolved" else float(t.threshold_db_hl)  # type: ignore[arg-type]
    return out


def _insight_row(feedback: FeedbackRow, a: Analysis | NlpInsightCreate, session: SessionRow) -> NlpInsightRow:
    if isinstance(a, Analysis):
        issues = [asdict(i) for i in a.issues]
        symptoms = [asdict(s) for s in a.symptoms]
        review, reasons = a.requires_clinical_review, list(a.review_reasons)
        emotions = dict(a.emotions)
    else:
        issues = [i.model_dump(mode="json") for i in a.issues]
        symptoms = [s.model_dump(mode="json") for s in a.symptoms]
        review, reasons = False, []
        emotions = dict(a.emotions)
    correlations = [asdict(c) for c in correlate([s["symptom"] for s in symptoms], accepted_audiogram(session))]
    return NlpInsightRow(
        feedback_id=feedback.id,
        model_name=a.model_name,
        model_version=a.model_version,
        sentiment=a.sentiment,
        emotions=emotions,
        uncertainty=a.uncertainty,
        issues=issues,
        intent=a.intent,
        polarity=a.polarity,
        subjectivity=a.subjectivity,
        symptoms=symptoms,
        correlations=correlations,
        requires_clinical_review=review,
        review_reasons=reasons,
    )


def create_feedback(
    db: Session, session_id: UUID, body: FeedbackCreate, analyzer: FeedbackAnalyzer | None = None
) -> FeedbackReceipt:
    session = get_session(db, session_id)
    if session.status == SessionStatus.IN_PROGRESS.value:
        raise Conflict("feedback is collected after the test (the session is still in progress)")
    fb = FeedbackRow(session_id=session_id, text=body.text, ratings=body.ratings, language=body.language, insights=[])
    db.add(fb)
    db.flush()
    try:
        # A savepoint: a failing analysis must never lose the participant's feedback.
        with db.begin_nested():
            analysis = (analyzer or _default_analyzer).analyze(body.text)
            row = _insight_row(fb, analysis, session)
            db.add(row)
            db.flush()
        log.info(
            "nlp.analysed feedback=%s session=%s model=%s/%s sentiment=%s review=%s",
            fb.id, session_id, analysis.model_name, analysis.model_version, analysis.sentiment, analysis.requires_clinical_review,
        )
    except Exception:
        log.exception("nlp.analysis_failed feedback=%s session=%s — feedback stored without analysis", fb.id, session_id)
    return FeedbackReceipt(id=fb.id, session_id=session_id, submitted_at=fb.submitted_at)


def list_feedback(db: Session, session_id: UUID) -> list[FeedbackOut]:
    get_session(db, session_id)
    rows = db.scalars(select(FeedbackRow).where(FeedbackRow.session_id == session_id).order_by(FeedbackRow.submitted_at))
    log.info("nlp.feedback_listed session=%s", session_id)
    return [FeedbackOut.model_validate(r) for r in rows]


def list_insights(db: Session, session_id: UUID) -> SessionInsightsOut:
    get_session(db, session_id)
    rows = list(
        db.scalars(
            select(NlpInsightRow)
            .join(FeedbackRow, NlpInsightRow.feedback_id == FeedbackRow.id)
            .where(FeedbackRow.session_id == session_id)
            .order_by(NlpInsightRow.created_at)
        )
    )
    log.info("nlp.insights_read session=%s count=%d", session_id, len(rows))
    return SessionInsightsOut(session_id=session_id, count=len(rows), insights=[NlpInsightOut.model_validate(r) for r in rows])


def add_insight(db: Session, feedback_id: UUID, body: NlpInsightCreate) -> NlpInsightOut:
    fb = db.get(FeedbackRow, feedback_id)
    if fb is None:
        raise NotFound("feedback not found", feedback_id=str(feedback_id))
    row = _insight_row(fb, body, get_session(db, fb.session_id))
    db.add(row)
    db.flush()
    log.info("nlp.external_insight feedback=%s model=%s/%s", feedback_id, body.model_name, body.model_version)
    return NlpInsightOut.model_validate(row)
