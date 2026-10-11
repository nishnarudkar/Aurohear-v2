"""Threshold and quality-metric schemas (spec §12.1 Threshold, §10 QUALIND)."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import Field

from .common import Ear, OutputModel, SearchRole, ThresholdStatus
from .session import SessionOut


class ThresholdResultOut(OutputModel):
    ear: Ear
    frequency_hz: int
    test_role: SearchRole
    search_index: int = Field(description="Order of this search within the session")
    status: ThresholdStatus
    threshold_db_hl: int | None = Field(
        description="Measured threshold; the ceiling for no_response (plot ↓ arrow); null if unresolved"
    )
    provisional_db_hl: int | None
    ascending_hits: int
    ascending_trials: int
    ascents_completed: int
    presentations: int
    floor_limited: bool = Field(description="Threshold ≤ −10 dB HL (lattice floor)")
    clamp_events: int
    is_accepted: bool = Field(description="The value reported on the audiogram for this ear × frequency")
    possible_shadow: bool = Field(
        description="Interaural Δ ≥ 40 dB, poorer ear, unmasked: possible cross-hearing (spec §1.3)"
    )
    computed_at: datetime


class QualityMetricsOut(OutputModel):
    session_id: UUID
    tone_trials: int
    catch_trials: int
    catch_false_alarms: int
    false_positive_rate: float | None = Field(description="QUALIND #5: catch responses ÷ catch trials")
    discarded_trials: int = Field(description="Session-integrity events (spec §10 #12)")
    level_clamp_events: int = Field(description="Spec §10 #13")
    extra_responses: int
    mean_latency_ms: float | None = Field(description="QUALIND #4: onset → response, tone hits")
    sd_latency_ms: float | None
    median_latency_ms: float | None
    retest_1k_delta_db: int | None = Field(description="QUALIND #6")
    unstable_1k: bool
    unresolved_thresholds: int
    no_response_thresholds: int
    possible_shadow_count: int
    protocol_complete: bool
    computed_at: datetime


class SessionResults(OutputModel):
    session: SessionOut
    protocol_complete: bool
    thresholds: list[ThresholdResultOut] = Field(description="Every search, in test order")
    audiogram: list[ThresholdResultOut] = Field(description="Accepted value per ear × frequency")
    quality_metrics: QualityMetricsOut
