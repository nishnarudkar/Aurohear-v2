"""SQLAlchemy 2.0 ORM models (spec §12.1).

Tables
  sessions            one test session; protocol version and consent version pinned
  trials              append-only log of every presentation (the atomic research record)
  threshold_results   per-search results computed server-side by replaying `trials`
  quality_metrics     QUALIND-adapted indicators (spec §10), one row per session
  feedback            participant free-text self-report
  nlp_insights        model-generated analysis of a feedback row

Privacy (spec §12.3): no direct identifiers are stored here. `participant_id` is a
pseudonymous UUID; the key linking it to a person lives in a separate store.

Integrity is enforced in the database too, not only in Pydantic: CHECK constraints
mirror the clinical invariants so a bad row cannot be written by any other path.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    false,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


EARS = "('right', 'left')"


class SessionRow(Base):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    participant_id: Mapped[uuid.UUID] = mapped_column(Uuid, index=True)
    protocol_version: Mapped[str] = mapped_column(String(64))
    consent_version: Mapped[str] = mapped_column(String(64))
    mode: Mapped[str] = mapped_column(String(16))
    supervision: Mapped[str] = mapped_column(String(16))
    better_ear: Mapped[str | None] = mapped_column(String(8))
    profile_cap_db_hl: Mapped[int] = mapped_column(Integer)
    frequency_caps_db_hl: Mapped[dict[str, float] | None] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(16), index=True)
    abort_reason: Mapped[str | None] = mapped_column(String(32))
    client_time_origin_ms: Mapped[float | None] = mapped_column(Float)
    device: Mapped[dict[str, Any]] = mapped_column(JSON)
    calibration: Mapped[dict[str, Any]] = mapped_column(JSON)
    environment: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    trials: Mapped[list[TrialRow]] = relationship(
        back_populates="session", order_by="TrialRow.seq", cascade="all, delete-orphan"
    )
    thresholds: Mapped[list[ThresholdResultRow]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    quality: Mapped[QualityMetricsRow | None] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    classification: Mapped[ClassificationRow | None] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )

    __table_args__ = (
        CheckConstraint("mode IN ('threshold', 'screening')", name="mode"),
        CheckConstraint("supervision IN ('unsupervised', 'technician', 'clinician')", name="supervision"),
        CheckConstraint(f"better_ear IS NULL OR better_ear IN {EARS}", name="better_ear"),
        CheckConstraint(
            "status IN ('in_progress', 'complete', 'incomplete', 'aborted', 'invalidated')",
            name="status",
        ),
        CheckConstraint(
            "profile_cap_db_hl % 5 = 0 AND profile_cap_db_hl > -10 AND profile_cap_db_hl <= 90",
            name="profile_cap",
        ),
        CheckConstraint("(status = 'aborted') = (abort_reason IS NOT NULL)", name="abort_reason"),
    )


class TrialRow(Base):
    __tablename__ = "trials"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)  # client-generated: idempotency key
    session_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    seq: Mapped[int] = mapped_column(Integer)
    ear: Mapped[str] = mapped_column(String(8))
    frequency_hz: Mapped[int] = mapped_column(Integer)
    level_db_hl: Mapped[int | None] = mapped_column(Integer)
    presented_level_db_hl: Mapped[float | None] = mapped_column(Float)
    level_clamped: Mapped[bool] = mapped_column(Boolean)
    phase: Mapped[str] = mapped_column(String(16))
    test_role: Mapped[str] = mapped_column(String(16))
    is_catch_trial: Mapped[bool] = mapped_column(Boolean)
    scheduled_at_ms: Mapped[float] = mapped_column(Float)
    presented_at_ms: Mapped[float] = mapped_column(Float)
    offset_at_ms: Mapped[float] = mapped_column(Float)
    audio_context_onset_s: Mapped[float | None] = mapped_column(Float)
    duration_ms: Mapped[float] = mapped_column(Float)
    isi_ms: Mapped[float] = mapped_column(Float)
    responded: Mapped[bool] = mapped_column(Boolean)
    response_at_ms: Mapped[float | None] = mapped_column(Float)
    response_latency_ms: Mapped[float | None] = mapped_column(Float)
    extra_responses: Mapped[int] = mapped_column(Integer)
    ambient_dba_at_trial: Mapped[float | None] = mapped_column(Float)
    discarded: Mapped[bool] = mapped_column(Boolean)
    discard_reason: Mapped[str | None] = mapped_column(String(64))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    session: Mapped[SessionRow] = relationship(back_populates="trials")

    __table_args__ = (
        UniqueConstraint("session_id", "seq"),
        CheckConstraint(f"ear IN {EARS}", name="ear"),
        CheckConstraint("seq >= 0", name="seq"),
        CheckConstraint(
            "phase IN ('familiarisation', 'descent', 'ascent', 'qc_probe', 'catch')", name="phase"
        ),
        CheckConstraint("test_role IN ('initial', 'retest', 'verification')", name="test_role"),
        # A catch trial is silent: no level, phase 'catch'. A tone trial has a level.
        CheckConstraint(
            "(is_catch_trial AND phase = 'catch' AND level_db_hl IS NULL) OR "
            "(NOT is_catch_trial AND phase <> 'catch' AND level_db_hl IS NOT NULL)",
            name="catch_consistency",
        ),
        CheckConstraint(
            "level_db_hl IS NULL OR (level_db_hl >= -10 AND level_db_hl <= 90 AND level_db_hl % 5 = 0)",
            name="level_lattice",
        ),
        # Latency exists iff a response was made, and is non-negative (window starts at onset).
        CheckConstraint(
            # Explicit IS NOT NULL: a CHECK passes when its expression is NULL, so
            # "latency >= 0" alone would let a responded row with NULL latency through.
            "(responded AND response_at_ms IS NOT NULL AND response_latency_ms IS NOT NULL "
            "AND response_latency_ms >= 0) OR "
            "(NOT responded AND response_at_ms IS NULL AND response_latency_ms IS NULL)",
            name="response_consistency",
        ),
        CheckConstraint("discarded = (discard_reason IS NOT NULL)", name="discard_reason"),
        CheckConstraint("duration_ms > 0 AND isi_ms >= 0", name="timing"),
        # (session_id, seq) lookups use the unique constraint's index.
    )


class ThresholdResultRow(Base):
    __tablename__ = "threshold_results"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    ear: Mapped[str] = mapped_column(String(8))
    frequency_hz: Mapped[int] = mapped_column(Integer)
    test_role: Mapped[str] = mapped_column(String(16))
    search_index: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16))
    threshold_db_hl: Mapped[int | None] = mapped_column(Integer)
    provisional_db_hl: Mapped[int | None] = mapped_column(Integer)
    ascending_hits: Mapped[int] = mapped_column(Integer)
    ascending_trials: Mapped[int] = mapped_column(Integer)
    ascents_completed: Mapped[int] = mapped_column(Integer)
    presentations: Mapped[int] = mapped_column(Integer)
    floor_limited: Mapped[bool] = mapped_column(Boolean)
    clamp_events: Mapped[int] = mapped_column(Integer)
    is_accepted: Mapped[bool] = mapped_column(Boolean)
    possible_shadow: Mapped[bool] = mapped_column(Boolean)
    is_interoctave: Mapped[bool] = mapped_column(Boolean, server_default=false())
    qc_probe_at_threshold_heard: Mapped[bool | None] = mapped_column(Boolean)
    qc_probe_plus5_heard: Mapped[bool | None] = mapped_column(Boolean)
    qc_probe_pass: Mapped[bool | None] = mapped_column(Boolean)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    session: Mapped[SessionRow] = relationship(back_populates="thresholds")

    __table_args__ = (
        UniqueConstraint("session_id", "search_index"),
        CheckConstraint(f"ear IN {EARS}", name="ear"),
        CheckConstraint("status IN ('measured', 'no_response', 'unresolved')", name="status"),
        CheckConstraint(
            "(status = 'unresolved') = (threshold_db_hl IS NULL)", name="threshold_presence"
        ),
        CheckConstraint(
            "status <> 'measured' OR (ascending_hits >= 2 AND 2 * ascending_hits >= ascending_trials)",
            name="hughson_westlake_criterion",
        ),
        # Only a measured threshold can be probed; pass status is the +5 dB response.
        CheckConstraint(
            "status = 'measured' OR (qc_probe_at_threshold_heard IS NULL AND qc_probe_plus5_heard IS NULL)",
            name="probe_needs_threshold",
        ),
        CheckConstraint(
            "(qc_probe_pass IS NULL AND qc_probe_plus5_heard IS NULL) OR "
            "(qc_probe_pass IS NOT NULL AND qc_probe_plus5_heard IS NOT NULL AND qc_probe_pass = qc_probe_plus5_heard)",
            name="probe_pass_definition",
        ),
    )


class QualityMetricsRow(Base):
    __tablename__ = "quality_metrics"

    session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), primary_key=True
    )
    tone_trials: Mapped[int] = mapped_column(Integer)
    catch_trials: Mapped[int] = mapped_column(Integer)
    catch_false_alarms: Mapped[int] = mapped_column(Integer)
    false_positive_rate: Mapped[float | None] = mapped_column(Float)
    discarded_trials: Mapped[int] = mapped_column(Integer)
    level_clamp_events: Mapped[int] = mapped_column(Integer)
    extra_responses: Mapped[int] = mapped_column(Integer)
    mean_latency_ms: Mapped[float | None] = mapped_column(Float)
    sd_latency_ms: Mapped[float | None] = mapped_column(Float)
    median_latency_ms: Mapped[float | None] = mapped_column(Float)
    retest_1k_delta_db: Mapped[int | None] = mapped_column(Integer)
    unstable_1k: Mapped[bool] = mapped_column(Boolean)
    unresolved_thresholds: Mapped[int] = mapped_column(Integer)
    no_response_thresholds: Mapped[int] = mapped_column(Integer)
    possible_shadow_count: Mapped[int] = mapped_column(Integer)
    qc_probes: Mapped[int] = mapped_column(Integer, server_default="0")
    qc_probe_failures: Mapped[int] = mapped_column(Integer, server_default="0")
    qc_probe_fail_rate: Mapped[float | None] = mapped_column(Float)
    ambient_noise_discards: Mapped[int] = mapped_column(Integer, server_default="0")
    visibility_discards: Mapped[int] = mapped_column(Integer, server_default="0")
    ambient_exceedance_rate: Mapped[float | None] = mapped_column(Float)
    protocol_complete: Mapped[bool] = mapped_column(Boolean)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    session: Mapped[SessionRow] = relationship(back_populates="quality")

    __table_args__ = (
        CheckConstraint(
            "false_positive_rate IS NULL OR (false_positive_rate >= 0 AND false_positive_rate <= 1)",
            name="fp_rate_range",
        ),
        CheckConstraint(
            "ambient_exceedance_rate IS NULL OR (ambient_exceedance_rate >= 0 AND ambient_exceedance_rate <= 1)",
            name="ambient_rate_range",
        ),
    )


class ClassificationRow(Base):
    """Spec §12.1 Classification. Stored (not recomputed on read) together with the
    model version, so re-fitting σ/bias/cut-points never silently changes a past result."""

    __tablename__ = "classifications"

    session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), primary_key=True
    )
    model_version: Mapped[str] = mapped_column(String(64))
    calibration_tier: Mapped[str] = mapped_column(String(1))
    pta4_better: Mapped[float | None] = mapped_column(Float)
    who_grade: Mapped[str | None] = mapped_column(String(24))
    p_hearing_loss: Mapped[float | None] = mapped_column(Float)
    band: Mapped[str | None] = mapped_column(String(16), index=True)
    qc_composite: Mapped[str] = mapped_column(String(8))
    referral: Mapped[str] = mapped_column(String(40), index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    session: Mapped[SessionRow] = relationship(back_populates="classification")

    __table_args__ = (
        CheckConstraint("calibration_tier IN ('A', 'B', 'C')", name="tier"),
        CheckConstraint(
            "band IS NULL OR band IN ('low', 'medium', 'high', 'indeterminate')", name="band"
        ),
        CheckConstraint("qc_composite IN ('good', 'fair', 'poor')", name="qc_composite"),
        CheckConstraint(
            "p_hearing_loss IS NULL OR (p_hearing_loss >= 0 AND p_hearing_loss <= 1)", name="p_range"
        ),
        # A probability is only ever shown with a computed band (never when indeterminate).
        CheckConstraint(
            "p_hearing_loss IS NULL OR (band IS NOT NULL AND band IN ('low', 'medium', 'high'))", name="p_needs_band"
        ),
    )


class FeedbackRow(Base):
    __tablename__ = "feedback"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    text: Mapped[str] = mapped_column(Text)
    ratings: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    language: Mapped[str | None] = mapped_column(String(16))
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    insights: Mapped[list[NlpInsightRow]] = relationship(
        back_populates="feedback", cascade="all, delete-orphan", order_by="NlpInsightRow.created_at"
    )


class NlpInsightRow(Base):
    __tablename__ = "nlp_insights"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    feedback_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("feedback.id", ondelete="CASCADE"), index=True
    )
    model_name: Mapped[str] = mapped_column(String(128))
    model_version: Mapped[str] = mapped_column(String(64))
    sentiment: Mapped[str] = mapped_column(String(16), index=True)
    emotions: Mapped[dict[str, float]] = mapped_column(JSON)
    uncertainty: Mapped[float] = mapped_column(Float)
    issues: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    intent: Mapped[str | None] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    feedback: Mapped[FeedbackRow] = relationship(back_populates="insights")

    __table_args__ = (
        CheckConstraint("sentiment IN ('positive', 'negative', 'neutral', 'mixed')", name="sentiment"),
        CheckConstraint("uncertainty >= 0 AND uncertainty <= 1", name="uncertainty_range"),
        CheckConstraint(
            "intent IS NULL OR intent IN ('complaint', 'suggestion', 'praise', 'question')",
            name="intent",
        ),
    )
