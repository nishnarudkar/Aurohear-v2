"""REST endpoints (all under /api/v1). Routers are thin: logic lives in services/."""

from __future__ import annotations

import secrets
from collections.abc import Iterator
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request, status
from sqlalchemy.orm import Session

from aurohear.schemas import (
    AbortRequest,
    FeedbackCreate,
    FeedbackOut,
    FeedbackReceipt,
    NlpInsightCreate,
    NlpInsightOut,
    SessionCreate,
    SessionInsightsOut,
    SessionResults,
    SessionState,
    TrialAccepted,
    TrialCreate,
    TrialOut,
)
from aurohear.services import feedback, results, sessions
from aurohear.services.errors import DomainError


def get_db() -> Iterator[Session]:  # replaced by create_app via dependency_overrides
    raise RuntimeError("database dependency not configured")
    yield  # pragma: no cover


Db = Annotated[Session, Depends(get_db)]
router = APIRouter()


class AdminRequired(DomainError):
    status_code = 401
    code = "admin_required"


class AdminDisabled(DomainError):
    status_code = 403
    code = "admin_disabled"


def require_admin(request: Request, authorization: Annotated[str | None, Header()] = None) -> None:
    """NLP insights are admin-only (NLP module doc, Access Control). Bearer token from
    AUROHEAR_ADMIN_TOKEN; with no token configured the admin endpoints are disabled."""
    token: str | None = request.app.state.admin_token
    if not token:
        raise AdminDisabled("admin endpoints are disabled: set AUROHEAR_ADMIN_TOKEN")
    supplied = (authorization or "").removeprefix("Bearer ").strip()
    if not secrets.compare_digest(supplied.encode(), token.encode()):
        raise AdminRequired("a valid admin bearer token is required")


Admin = Depends(require_admin)


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


@router.post(
    "/sessions/{session_id}/feedback",
    status_code=status.HTTP_201_CREATED,
    tags=["feedback"],
    responses={409: {"description": "The test is still in progress (feedback is post-test only)"}},
)
def create_feedback(session_id: UUID, body: FeedbackCreate, db: Db) -> FeedbackReceipt:
    """Store the participant's free-text self-report (after the test) and analyse it.
    Returns a receipt only — NLP results are never shown to the participant."""
    return feedback.create_feedback(db, session_id, body)


@router.get("/sessions/{session_id}/feedback", tags=["admin"], dependencies=[Admin])
def list_feedback(session_id: UUID, db: Db) -> list[FeedbackOut]:
    """Admin: feedback text with all insights."""
    return feedback.list_feedback(db, session_id)


@router.get("/sessions/{session_id}/insights", tags=["admin"], dependencies=[Admin])
def list_insights(session_id: UUID, db: Db) -> SessionInsightsOut:
    """Admin: NLP insights for a session, with the symptom ↔ audiometry correlation
    (a research annotation; it never changes the clinical result)."""
    return feedback.list_insights(db, session_id)


@router.post("/feedback/{feedback_id}/insights", status_code=status.HTTP_201_CREATED, tags=["admin"], dependencies=[Admin])
def add_insight(feedback_id: UUID, body: NlpInsightCreate, db: Db) -> NlpInsightOut:
    """Admin: store a versioned analysis from an external NLP model (append-only)."""
    return feedback.add_insight(db, feedback_id, body)
