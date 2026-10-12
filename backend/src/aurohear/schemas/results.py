"""Threshold and quality-metric schemas (spec §12.1 Threshold, §10 QUALIND)."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import Field

from aurohear.services.classification import (
    BsaDescriptor,
    CalibrationTier,
    Confidence,
    LikelihoodBand,
    QcComposite,
    Referral,
    WhoGrade,
)

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
    is_interoctave: bool = Field(description="Inserted by the ≥ 20 dB inter-octave rule (spec §6.4)")
    qc_probe_at_threshold_heard: bool | None
    qc_probe_plus5_heard: bool | None
    qc_probe_pass: bool | None = Field(
        description="Spec §6.3: false = no response at threshold + 5 dB; null = not probed"
    )
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
    qc_probes: int = Field(description="Thresholds probed at threshold + 5 dB")
    qc_probe_failures: int
    qc_probe_fail_rate: float | None = Field(
        description="QUALIND #7: non-responses at threshold + 5 dB ÷ thresholds probed"
    )
    protocol_complete: bool
    computed_at: datetime


class AverageOut(OutputModel):
    value_db_hl: float | None
    frequencies_used: list[int]
    partial: bool = Field(description="Some frequencies unresolved, untested or excluded as possible shadow")
    includes_no_response: bool = Field(description="A no-response entered the mean: the true average is at least this")


class EarSummaryOut(OutputModel):
    ear: Ear
    pta4: AverageOut = Field(description="Mean of 500, 1000, 2000, 4000 Hz (spec §9.1)")
    bsa_avg5: AverageOut = Field(description="Mean of 250–4000 Hz; no-response counted as 130 dB HL (BSA)")
    bsa_descriptor: BsaDescriptor | None


class OverrideOut(OutputModel):
    code: str
    reason: str


class ClassificationOut(OutputModel):
    """Spec §12.1 Classification, computed per §9 and stored at finalize."""

    model_version: str
    calibration_tier: CalibrationTier
    ears: list[EarSummaryOut]
    pta4_right: float | None
    pta4_left: float | None
    pta4_better: float | None
    better_ear: Ear | None
    who_grade_better_ear: WhoGrade | None = Field(description="WHO 2021, better-ear PTA₄")
    who_grade_is_lower_bound: bool
    bsa_avg5_right: float | None
    bsa_avg5_left: float | None
    bsa_descriptor_right: BsaDescriptor | None
    bsa_descriptor_left: BsaDescriptor | None
    bias_correction_db: float
    sigma_pta_db: float
    pta_adjusted: float | None
    p_hearing_loss: float | None = Field(
        description="Φ((PTA_adj − 20)/σ_tier); null when suppressed (red flag or indeterminate)"
    )
    computed_band: LikelihoodBand | None = Field(description="Band from P alone, before overrides")
    band: LikelihoodBand | None = Field(description="Final band after §9.2 Step 4 overrides; null under a red flag")
    qc_composite: QcComposite = Field(description="PROVISIONAL rule-based stand-in for the QUALIND composite")
    confidence: Confidence
    asymmetry_db: float | None
    overrides_applied: list[OverrideOut]
    annotations: list[str]
    referral: Referral
    statement: str = Field(description="Participant-facing wording per §9.2 Step 5")
    caveats: list[str]


class SessionResults(OutputModel):
    session: SessionOut
    protocol_complete: bool
    thresholds: list[ThresholdResultOut] = Field(description="Every search, in test order")
    audiogram: list[ThresholdResultOut] = Field(description="Accepted value per ear × frequency")
    quality_metrics: QualityMetricsOut
    classification: ClassificationOut
