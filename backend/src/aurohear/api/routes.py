"""REST endpoints (all under /api/v1). Routers are thin: logic lives in services/."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from aurohear.schemas import (
    AbortRequest,
    FeedbackCreate,
    FeedbackOut,
    NlpInsightCreate,
    NlpInsightOut,
    SessionCreate,
    SessionResults,
    SessionState,
    TrialAccepted,
    TrialCreate,
    TrialOut,
)
from aurohear.services import feedback, results, sessions


def get_db() -> Iterator[Session]:  # replaced by create_app via dependency_overrides
    raise RuntimeError("database dependency not configured")
    yield  # pragma: no cover


Db = Annotated[Session, Depends(get_db)]
router = APIRouter()


# ------------------------------------------------------------------ sessions


@router.post("/sessions", status_code=status.HTTP_201_CREATED, tags=["sessions"])
def create_session(body: SessionCreate, db: Db) -> SessionState:
    """Initialise a session. Returns the first presentation to play."""
    return sessions.create_session(db, body)


@router.get("/sessions/{session_id}", tags=["sessions"])
def get_session(session_id: UUID, db: Db) -> SessionState:
    """Current status and the next expected presentation (rebuilt from the trial log)."""
    return sessions.session_state(sessions.get_session(db, session_id))


@router.post("/sessions/{session_id}/abort", tags=["sessions"])
def abort_session(session_id: UUID, body: AbortRequest, db: Db) -> SessionState:
    """Mark the session aborted. Its trials are kept (partial data is research data)."""
    return sessions.abort_session(db, session_id, body)


# ------------------------------------------------------------------ trials


@router.post(
    "/sessions/{session_id}/trials",
    tags=["trials"],
    responses={409: {"description": "Out-of-order seq, mismatch with the protocol, or closed session"}},
)
def record_trial(session_id: UUID, body: TrialCreate, db: Db) -> TrialAccepted:
    """Append one trial. Tone trials advance the staircase; the response carries the
    next presentation. Retrying with the same `trial_id` and body is safe."""
    return sessions.record_trial(db, session_id, body)


@router.get("/sessions/{session_id}/trials", tags=["trials"])
def list_trials(session_id: UUID, db: Db) -> list[TrialOut]:
    return sessions.list_trials(db, session_id)


# ------------------------------------------------------------------ results


@router.post("/sessions/{session_id}/finalize", tags=["results"])
def finalize_session(session_id: UUID, db: Db) -> SessionResults:
    """Compute thresholds and quality metrics from the trial log and close the session."""
    return results.finalize_session(db, session_id)


@router.get("/sessions/{session_id}/results", tags=["results"])
def get_results(session_id: UUID, db: Db) -> SessionResults:
    return results.get_results(db, session_id)


# ------------------------------------------------------------------ qualitative / NLP


@router.post("/sessions/{session_id}/feedback", status_code=status.HTTP_201_CREATED, tags=["feedback"])
def create_feedback(session_id: UUID, body: FeedbackCreate, db: Db) -> FeedbackOut:
    """Store the participant's free-text self-report."""
    return feedback.create_feedback(db, session_id, body)


@router.get("/sessions/{session_id}/feedback", tags=["feedback"])
def list_feedback(session_id: UUID, db: Db) -> list[FeedbackOut]:
    return feedback.list_feedback(db, session_id)


@router.post("/feedback/{feedback_id}/insights", status_code=status.HTTP_201_CREATED, tags=["feedback"])
def add_insight(feedback_id: UUID, body: NlpInsightCreate, db: Db) -> NlpInsightOut:
    """Store a versioned NLP analysis of one feedback entry (append-only)."""
    return feedback.add_insight(db, feedback_id, body)
