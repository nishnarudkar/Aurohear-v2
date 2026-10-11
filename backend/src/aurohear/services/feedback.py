"""Qualitative self-report and NLP insight storage.

The NLP engine itself runs elsewhere (v1 `nlp_engine`, to be migrated); this layer
stores its versioned output. Insights are append-only: a new model version adds a row.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from aurohear.db import FeedbackRow, NlpInsightRow
from aurohear.schemas import FeedbackCreate, FeedbackOut, NlpInsightCreate, NlpInsightOut

from .errors import NotFound
from .sessions import get_session


def create_feedback(db: Session, session_id: UUID, body: FeedbackCreate) -> FeedbackOut:
    get_session(db, session_id)
    row = FeedbackRow(
        session_id=session_id, text=body.text, ratings=body.ratings, language=body.language, insights=[]
    )
    db.add(row)
    db.flush()
    return FeedbackOut.model_validate(row)


def list_feedback(db: Session, session_id: UUID) -> list[FeedbackOut]:
    get_session(db, session_id)
    rows = db.scalars(
        select(FeedbackRow).where(FeedbackRow.session_id == session_id).order_by(FeedbackRow.submitted_at)
    )
    return [FeedbackOut.model_validate(r) for r in rows]


def add_insight(db: Session, feedback_id: UUID, body: NlpInsightCreate) -> NlpInsightOut:
    fb = db.get(FeedbackRow, feedback_id)
    if fb is None:
        raise NotFound("feedback not found", feedback_id=str(feedback_id))
    row = NlpInsightRow(
        feedback_id=feedback_id,
        model_name=body.model_name,
        model_version=body.model_version,
        sentiment=body.sentiment,
        emotions=dict(body.emotions),
        uncertainty=body.uncertainty,
        issues=[i.model_dump(mode="json") for i in body.issues],
        intent=body.intent,
    )
    db.add(row)
    db.flush()
    return NlpInsightOut.model_validate(row)
