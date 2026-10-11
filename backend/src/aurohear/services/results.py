"""Finalisation: compute thresholds and quality metrics from the trial log.

Idempotent: results are a pure function of the stored trials (which are frozen once a
session leaves `in_progress`), so re-finalising replaces rows with identical values.
"""

from __future__ import annotations

import statistics
from uuid import UUID

from sqlalchemy import delete
from sqlalchemy.orm import Session

from aurohear.audiometry import Ear, EarResult, ThresholdResult, ThresholdStatus
from aurohear.db import QualityMetricsRow, SessionRow, ThresholdResultRow, TrialRow
from aurohear.db.models import utcnow
from aurohear.schemas import (
    QualityMetricsOut,
    SessionOut,
    SessionResults,
    SessionStatus,
    ThresholdResultOut,
)

from .errors import Conflict
from .sessions import get_session, replay_session

SHADOW_INTERAURAL_DB = 40
"""Spec §1.3: unmasked interaural difference ≥ 40 dB → poorer-ear result may be a shadow."""

_FINALISABLE = {
    SessionStatus.IN_PROGRESS.value,
    SessionStatus.ABORTED.value,
    SessionStatus.COMPLETE.value,
    SessionStatus.INCOMPLETE.value,
}


def _shadowed(ears: tuple[EarResult, ...]) -> set[tuple[Ear, int]]:
    """(ear, frequency) of accepted results that may be cross-heard from the other ear.

    No-response counts as 'at least the ceiling'. Unresolved results are not compared.
    """
    if len(ears) < 2:
        return set()
    a, b = ears[0], ears[1]
    out: set[tuple[Ear, int]] = set()
    for f in set(a.audiogram) & set(b.audiogram):
        ra, rb = a.audiogram[f], b.audiogram[f]
        if ra.threshold_db_hl is None or rb.threshold_db_hl is None:
            continue
        if abs(ra.threshold_db_hl - rb.threshold_db_hl) >= SHADOW_INTERAURAL_DB:
            poorer = a if ra.threshold_db_hl > rb.threshold_db_hl else b
            out.add((poorer.ear, f))
    return out


def _threshold_rows(session_id: UUID, ears: tuple[EarResult, ...]) -> list[ThresholdResultRow]:
    shadow = _shadowed(ears)
    rows: list[ThresholdResultRow] = []
    index = 0
    for ear_res in ears:
        for r in ear_res.thresholds:
            # Value equality: searches at one frequency always differ (role, trials).
            accepted = ear_res.audiogram.get(r.frequency_hz) == r
            rows.append(_row(session_id, r, index, accepted, accepted and (r.ear, r.frequency_hz) in shadow))
            index += 1
    return rows


def _row(session_id: UUID, r: ThresholdResult, index: int, accepted: bool, shadow: bool) -> ThresholdResultRow:
    return ThresholdResultRow(
        session_id=session_id,
        ear=r.ear.value,
        frequency_hz=r.frequency_hz,
        test_role=r.test_role.value,
        search_index=index,
        status=r.status.value,
        threshold_db_hl=r.threshold_db_hl,
        provisional_db_hl=r.provisional_db_hl,
        ascending_hits=r.ascending_hits,
        ascending_trials=r.ascending_trials,
        ascents_completed=r.ascents_completed,
        presentations=r.presentations,
        floor_limited=r.floor_limited,
        clamp_events=r.clamp_events,
        is_accepted=accepted,
        possible_shadow=shadow,
    )


def _quality_row(
    session_id: UUID,
    trials: list[TrialRow],
    ears: tuple[EarResult, ...],
    thresholds: list[ThresholdResultRow],
    protocol_complete: bool,
) -> QualityMetricsRow:
    kept = [t for t in trials if not t.discarded]
    catches = [t for t in kept if t.is_catch_trial]
    tones = [t for t in kept if not t.is_catch_trial]
    fas = sum(t.responded for t in catches)
    latencies = [t.response_latency_ms for t in tones if t.response_latency_ms is not None]
    accepted = [t for t in thresholds if t.is_accepted]
    first = ears[0] if ears else None
    return QualityMetricsRow(
        session_id=session_id,
        tone_trials=len(tones),
        catch_trials=len(catches),
        catch_false_alarms=fas,
        false_positive_rate=fas / len(catches) if catches else None,
        discarded_trials=len(trials) - len(kept),
        level_clamp_events=sum(t.level_clamped for t in trials),
        extra_responses=sum(t.extra_responses for t in trials),
        mean_latency_ms=statistics.fmean(latencies) if latencies else None,
        sd_latency_ms=statistics.stdev(latencies) if len(latencies) > 1 else None,
        median_latency_ms=statistics.median(latencies) if latencies else None,
        retest_1k_delta_db=first.retest_1k_delta_db if first else None,
        unstable_1k=any(e.unstable_1k for e in ears),
        unresolved_thresholds=sum(t.status == ThresholdStatus.UNRESOLVED.value for t in accepted),
        no_response_thresholds=sum(t.status == ThresholdStatus.NO_RESPONSE.value for t in accepted),
        possible_shadow_count=sum(t.possible_shadow for t in thresholds),
        protocol_complete=protocol_complete,
    )


def finalize_session(db: Session, session_id: UUID) -> SessionResults:
    row = get_session(db, session_id)
    if row.status not in _FINALISABLE:
        raise Conflict(f"session is {row.status}; it cannot be finalised")
    proto = replay_session(row)
    ears = proto.ear_results_so_far()

    db.execute(delete(ThresholdResultRow).where(ThresholdResultRow.session_id == session_id))
    db.execute(delete(QualityMetricsRow).where(QualityMetricsRow.session_id == session_id))
    db.flush()
    db.expire(row, ["thresholds", "quality"])

    thresholds = _threshold_rows(session_id, ears)
    quality = _quality_row(session_id, list(row.trials), ears, thresholds, proto.is_complete)
    db.add_all([*thresholds, quality])

    if row.status == SessionStatus.IN_PROGRESS.value:
        row.status = (SessionStatus.COMPLETE if proto.is_complete else SessionStatus.INCOMPLETE).value
    if row.completed_at is None:
        row.completed_at = utcnow()
    db.flush()
    return _results(row, thresholds, quality, proto.is_complete)


def get_results(db: Session, session_id: UUID) -> SessionResults:
    row = get_session(db, session_id)
    if row.quality is None:
        raise Conflict("session has not been finalised yet")
    thresholds = sorted(row.thresholds, key=lambda t: t.search_index)
    return _results(row, thresholds, row.quality, row.quality.protocol_complete)


def _results(
    row: SessionRow,
    thresholds: list[ThresholdResultRow],
    quality: QualityMetricsRow,
    complete: bool,
) -> SessionResults:
    out = [ThresholdResultOut.model_validate(t) for t in thresholds]
    return SessionResults(
        session=SessionOut.model_validate(row),
        protocol_complete=complete,
        thresholds=out,
        audiogram=[t for t in out if t.is_accepted],
        quality_metrics=QualityMetricsOut.model_validate(quality),
    )
