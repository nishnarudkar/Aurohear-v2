"""Session lifecycle and trial recording."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from aurohear.audiometry import PROTOCOL_VERSION, AudiometryProtocol
from aurohear.db import SessionRow, TrialRow
from aurohear.db.models import utcnow
from aurohear.schemas import (
    AbortRequest,
    PresentationOut,
    SessionCreate,
    SessionOut,
    SessionState,
    SessionStatus,
    TrialAccepted,
    TrialCreate,
    TrialOut,
)

from .errors import Conflict, IntegrityFailure, NotFound
from .replay import ReplayError, advances_protocol, mismatch, replay

OPEN_STATUSES = {SessionStatus.IN_PROGRESS.value}


def presentation_out(proto: AudiometryProtocol) -> PresentationOut | None:
    p = proto.next_presentation()
    if p is None:
        return None
    return PresentationOut(
        ear=p.ear, frequency_hz=p.frequency_hz, level_db_hl=p.level_db_hl, phase=p.phase, test_role=p.test_role
    )


def get_session(db: Session, session_id: UUID) -> SessionRow:
    row = db.get(SessionRow, session_id)
    if row is None:
        raise NotFound("session not found", session_id=str(session_id))
    return row


def replay_session(row: SessionRow) -> AudiometryProtocol:
    try:
        return replay(row, row.trials)
    except ReplayError as e:
        raise IntegrityFailure(str(e), session_id=str(row.id)) from e


def session_state(row: SessionRow) -> SessionState:
    proto = replay_session(row)
    return SessionState(
        session=SessionOut.model_validate(row),
        trial_count=len(row.trials),
        next_presentation=presentation_out(proto) if row.status in OPEN_STATUSES else None,
        protocol_complete=proto.is_complete,
    )


def create_session(db: Session, body: SessionCreate) -> SessionState:
    row = SessionRow(
        participant_id=body.participant_id,
        protocol_version=PROTOCOL_VERSION,  # pinned by the server, never by the client
        consent_version=body.consent_version,
        mode=body.mode,
        supervision=body.supervision,
        better_ear=body.better_ear.value if body.better_ear else None,
        profile_cap_db_hl=body.profile_cap_db_hl,
        status=SessionStatus.IN_PROGRESS.value,
        client_time_origin_ms=body.client_time_origin_ms,
        device=body.device.model_dump(mode="json"),
        calibration=body.calibration.model_dump(mode="json"),
        environment=body.environment.model_dump(mode="json") if body.environment else None,
        trials=[],
    )
    db.add(row)
    db.flush()
    return session_state(row)


def abort_session(db: Session, session_id: UUID, body: AbortRequest) -> SessionState:
    row = get_session(db, session_id)
    if row.status not in OPEN_STATUSES:
        raise Conflict(f"session is {row.status}; only in-progress sessions can be aborted")
    row.status = SessionStatus.ABORTED.value
    row.abort_reason = body.reason.value
    row.completed_at = utcnow()
    db.flush()
    return session_state(row)


# ------------------------------------------------------------------ trials

_COMPARED_FIELDS = [
    name for name in TrialCreate.model_fields if name != "trial_id"
]


def _same_trial(row: TrialRow, body: TrialCreate) -> bool:
    for name in _COMPARED_FIELDS:
        stored = getattr(row, name)
        sent = getattr(body, name)
        sent = sent.value if hasattr(sent, "value") else sent
        if stored != sent:
            return False
    return True


def _row_from(session_id: UUID, body: TrialCreate) -> TrialRow:
    data = body.model_dump(mode="json")
    trial_id = data.pop("trial_id")
    return TrialRow(id=UUID(trial_id), session_id=session_id, **data)


def record_trial(db: Session, session_id: UUID, body: TrialCreate) -> TrialAccepted:
    row = get_session(db, session_id)

    # Idempotent retry: same trial_id + same content → same answer, no second write.
    existing = db.get(TrialRow, body.trial_id)
    if existing is not None:
        if existing.session_id != session_id or not _same_trial(existing, body):
            raise Conflict("trial_id already used for a different trial", trial_id=str(body.trial_id))
        proto = replay_session(row)
        return TrialAccepted(
            trial=TrialOut.model_validate(existing),
            advanced_protocol=advances_protocol(existing),
            idempotent_replay=True,
            next_presentation=presentation_out(proto) if row.status in OPEN_STATUSES else None,
            protocol_complete=proto.is_complete,
        )

    if row.status not in OPEN_STATUSES:
        raise Conflict(f"session is {row.status}; trials can no longer be recorded")

    expected_seq = db.scalar(select(func.count()).where(TrialRow.session_id == session_id)) or 0
    if body.seq != expected_seq:
        raise Conflict("trial seq out of order", expected_seq=expected_seq, got=body.seq)

    proto = replay_session(row)
    advanced = advances_protocol(body)
    # Every trial — tone, catch or discarded — must belong to the pending presentation.
    # Catch trials are inserted *before* it and reuse its ear, frequency and role (their
    # level and phase differ by definition), so those two fields are not compared.
    expected = proto.next_presentation()
    if expected is None:
        raise Conflict("the protocol is complete; no further trials are expected")
    diff = mismatch(expected, body)
    if body.is_catch_trial:
        diff = [d for d in diff if not d.startswith(("level_db_hl", "phase"))]
    if diff:
        raise Conflict(
            "trial does not match the presentation the protocol requested",
            mismatches=diff,
            expected=PresentationOut(
                ear=expected.ear,
                frequency_hz=expected.frequency_hz,
                level_db_hl=expected.level_db_hl,
                phase=expected.phase,
                test_role=expected.test_role,
            ).model_dump(mode="json"),
        )
    if advanced:
        proto.record_response(body.responded)

    trial_row = _row_from(session_id, body)
    db.add(trial_row)
    try:
        db.flush()
    except IntegrityError as e:  # concurrent writer took this seq, or a CHECK failed
        raise Conflict("trial could not be stored (concurrent write or constraint)", error=str(e.orig)) from e
    row.trials.append(trial_row)

    return TrialAccepted(
        trial=TrialOut.model_validate(trial_row),
        advanced_protocol=advanced,
        idempotent_replay=False,
        next_presentation=presentation_out(proto),
        protocol_complete=proto.is_complete,
    )


def list_trials(db: Session, session_id: UUID) -> list[TrialOut]:
    row = get_session(db, session_id)
    return [TrialOut.model_validate(t) for t in row.trials]
