"""Strict Pydantic v2 schemas for everything the audiometry engine emits.

Field names follow the spec's data model (§12.1) so they can be persisted as-is.
All models are frozen: an emitted record is an immutable fact about the session.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


class _Frozen(BaseModel):
    model_config = ConfigDict(strict=True, frozen=True, extra="forbid")


class Ear(StrEnum):
    RIGHT = "right"
    LEFT = "left"

    @property
    def opposite(self) -> Ear:
        return Ear.LEFT if self is Ear.RIGHT else Ear.RIGHT


class Phase(StrEnum):
    """Trial phase (spec §12.1 Trial.phase).

    ``qc_probe`` and ``catch`` are emitted by the test runner (Phase 3), not by the
    staircase; they are listed so the schema matches the spec's enum.
    """

    FAMILIARISATION = "familiarisation"
    DESCENT = "descent"
    ASCENT = "ascent"
    QC_PROBE = "qc_probe"
    CATCH = "catch"


class SearchRole(StrEnum):
    """Why a frequency is being tested."""


    INITIAL = "initial"
    RETEST = "retest"  # ASHA 1 kHz retest in the first ear
    VERIFICATION = "verification"  # extra test inserted after an unstable 1 kHz retest


class ThresholdStatus(StrEnum):
    MEASURED = "measured"
    NO_RESPONSE = "no_response"  # no response at the ceiling; plot as NR arrow at cap
    UNRESOLVED = "unresolved"  # safety limit hit before the criterion was met


class FamiliarisationStatus(StrEnum):
    COMPLETE = "complete"
    NO_RESPONSE = "no_response"
    INCONSISTENT = "inconsistent"


class Presentation(_Frozen):
    """A request to present one tone. The engine's only output during a test."""

    ear: Ear
    frequency_hz: int = Field(gt=0)
    level_db_hl: int
    phase: Phase
    test_role: SearchRole = SearchRole.INITIAL


class StaircaseTrial(_Frozen):
    """One presentation + response inside a single threshold search."""

    seq: int = Field(ge=0)
    level_db_hl: int
    phase: Phase
    responded: bool
    run_index: int = Field(ge=0, description="0 = initial descent, n = n-th run after it")
    counted_as_ascending: bool
    level_clamped: bool = Field(
        description="True if the level the rule asked for was outside the lattice"
    )


class ThresholdResult(_Frozen):
    """Outcome of one Hughson–Westlake threshold search (spec §12.1 Threshold)."""

    ear: Ear
    frequency_hz: int = Field(gt=0)
    test_role: SearchRole
    status: ThresholdStatus
    threshold_db_hl: int | None = Field(
        description="Measured threshold, or the ceiling level for no_response, "
        "or None when unresolved. Never silently defaulted (GAP_ANALYSIS #6)."
    )
    provisional_db_hl: int | None = Field(
        default=None,
        description="Unresolved only: lowest level with ≥1 ascending hit and ≥50% "
        "ascending hit rate. For clinician review, never for classification.",
    )
    ascending_hits: int = Field(ge=0, description="Ascending responses at threshold level")
    ascending_trials: int = Field(ge=0, description="Ascending presentations at threshold level")
    ascents_completed: int = Field(ge=0)
    presentations: int = Field(ge=0)
    floor_limited: bool = Field(
        description="Threshold is at the lattice floor, i.e. true threshold ≤ floor"
    )
    clamp_events: int = Field(ge=0, description="QC indicator 13")
    trials: tuple[StaircaseTrial, ...]

    @model_validator(mode="after")
    def _status_consistency(self) -> Self:
        if self.status is ThresholdStatus.MEASURED:
            if self.threshold_db_hl is None:
                raise ValueError("measured threshold requires threshold_db_hl")
            if self.ascending_hits < 2 or 2 * self.ascending_hits < self.ascending_trials:
                raise ValueError("measured threshold must satisfy ≥2 hits on ≥50% ascents")
        elif self.status is ThresholdStatus.NO_RESPONSE:
            if self.threshold_db_hl is None:
                raise ValueError("no_response must record the ceiling level")
        elif self.threshold_db_hl is not None:
            raise ValueError("unresolved threshold must not carry threshold_db_hl")
        if self.presentations != len(self.trials):
            raise ValueError("presentations must equal len(trials)")
        return self


class FamiliarisationTrial(_Frozen):
    seq: int = Field(ge=0)
    level_db_hl: int
    responded: bool


class FamiliarisationResult(_Frozen):
    ear: Ear
    frequency_hz: int
    status: FamiliarisationStatus
    level_db_hl: int = Field(
        description="Level from which the 1 kHz threshold search starts"
    )
    trials: tuple[FamiliarisationTrial, ...]


class EarResult(_Frozen):
    ear: Ear
    familiarisation: FamiliarisationResult
    thresholds: tuple[ThresholdResult, ...] = Field(description="In test order")
    audiogram: dict[int, ThresholdResult] = Field(
        description="One accepted result per frequency (see protocol.accept_threshold)"
    )
    retest_1k_delta_db: int | None = Field(
        default=None, description="|T_retest − T_initial| at 1 kHz; first ear only"
    )
    unstable_1k: bool = False


class ProtocolResult(_Frozen):
    protocol_version: str
    ear_order: tuple[Ear, Ear]
    ears: tuple[EarResult, ...]

    @property
    def unstable_1k(self) -> bool:
        return any(e.unstable_1k for e in self.ears)
