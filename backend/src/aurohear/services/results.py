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
from aurohear.db import ClassificationRow, QualityMetricsRow, SessionRow, ThresholdResultRow, TrialRow
from aurohear.db.models import utcnow
from aurohear.schemas import (
    ClassificationOut,
    QualityMetricsOut,
    SessionOut,
    SessionResults,
    SessionStatus,
    ThresholdResultOut,
)

from .classification import CalibrationTier, QcInputs, ThresholdPoint, classify, shadow_interaural_db
from .errors import Conflict
from .sessions import get_session, replay_session


_FINALISABLE = {
    SessionStatus.IN_PROGRESS.value,
    SessionStatus.ABORTED.value,
    SessionStatus.COMPLETE.value,
    SessionStatus.INCOMPLETE.value,
}


def _shadowed(ears: tuple[EarResult, ...], interaural_db: int) -> set[tuple[Ear, int]]:
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
        if abs(ra.threshold_db_hl - rb.threshold_db_hl) >= interaural_db:
            poorer = a if ra.threshold_db_hl > rb.threshold_db_hl else b
            out.add((poorer.ear, f))
    return out


def _threshold_rows(
    session_id: UUID, ears: tuple[EarResult, ...], interaural_db: int
) -> list[ThresholdResultRow]:
    shadow = _shadowed(ears, interaural_db)
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
        is_interoctave=r.is_interoctave,
        qc_probe_at_threshold_heard=r.qc_probe_at_threshold_heard,
        qc_probe_plus5_heard=r.qc_probe_plus5_heard,
        qc_probe_pass=r.qc_probe_pass,
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
    # QUALIND #7 over every search that could be probed at threshold + 5 dB.
    probed = [t for t in thresholds if t.qc_probe_pass is not None]
    probe_failures = sum(not t.qc_probe_pass for t in probed)
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
        qc_probes=len(probed),
        qc_probe_failures=probe_failures,
        qc_probe_fail_rate=probe_failures / len(probed) if probed else None,
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
    db.execute(delete(ClassificationRow).where(ClassificationRow.session_id == session_id))
    db.flush()
    db.expire(row, ["thresholds", "quality", "classification"])

    # §1.3: masking criterion is ≥ 55 dB for insert earphones, ≥ 40 dB otherwise.
    interaural_db = shadow_interaural_db(row.device.get("transducer_type"))
    thresholds = _threshold_rows(session_id, ears, interaural_db)
    quality = _quality_row(session_id, list(row.trials), ears, thresholds, proto.is_complete)
    classification = _classify(row, thresholds, quality)
    db.add_all([*thresholds, quality, _classification_row(session_id, classification)])

    if row.status == SessionStatus.IN_PROGRESS.value:
        row.status = (SessionStatus.COMPLETE if proto.is_complete else SessionStatus.INCOMPLETE).value
    if row.completed_at is None:
        row.completed_at = utcnow()
    db.flush()
    return _results(row, thresholds, quality, proto.is_complete, classification)


def get_results(db: Session, session_id: UUID) -> SessionResults:
    row = get_session(db, session_id)
    if row.quality is None:
        raise Conflict("session has not been finalised yet")
    thresholds = sorted(row.thresholds, key=lambda t: t.search_index)
    stored = row.classification
    classification = (
        ClassificationOut.model_validate(stored.payload)
        if stored is not None
        else _classify(row, thresholds, row.quality)  # finalised before classifications existed
    )
    return _results(row, thresholds, row.quality, row.quality.protocol_complete, classification)


def _results(
    row: SessionRow,
    thresholds: list[ThresholdResultRow],
    quality: QualityMetricsRow,
    complete: bool,
    classification: ClassificationOut,
) -> SessionResults:
    out = [ThresholdResultOut.model_validate(t) for t in thresholds]
    return SessionResults(
        session=SessionOut.model_validate(row),
        protocol_complete=complete,
        thresholds=out,
        audiogram=[t for t in out if t.is_accepted],
        quality_metrics=QualityMetricsOut.model_validate(quality),
        classification=classification,
    )


# ------------------------------------------------------------------ classification (§9)


def _classify(
    row: SessionRow, thresholds: list[ThresholdResultRow], quality: QualityMetricsRow
) -> ClassificationOut:
    points = [
        ThresholdPoint(
            ear=t.ear,
            frequency_hz=t.frequency_hz,
            status=t.status,
            threshold_db_hl=t.threshold_db_hl,
            possible_shadow=t.possible_shadow,
        )
        for t in thresholds
        if t.is_accepted
    ]
    qc = QcInputs(
        false_positive_rate=quality.false_positive_rate,
        protocol_complete=quality.protocol_complete,
        unstable_1k=quality.unstable_1k,
        unresolved_thresholds=quality.unresolved_thresholds,
        discarded_trials=quality.discarded_trials,
        tone_trials=quality.tone_trials,
        qc_probe_fail_rate=quality.qc_probe_fail_rate,
    )
    tier = CalibrationTier(row.calibration["tier"])
    # Intake (red flags, noise exposure, difficulty in noise) is not collected yet.
    return ClassificationOut.model_validate(classify(points, qc, tier))


def _classification_row(session_id: UUID, c: ClassificationOut) -> ClassificationRow:
    return ClassificationRow(
        session_id=session_id,
        model_version=c.model_version,
        calibration_tier=c.calibration_tier.value,
        pta4_better=c.pta4_better,
        who_grade=c.who_grade_better_ear.value if c.who_grade_better_ear else None,
        p_hearing_loss=c.p_hearing_loss,
        band=c.band.value if c.band else None,
        qc_composite=c.qc_composite.value,
        referral=c.referral.value,
        payload=c.model_dump(mode="json"),
    )
