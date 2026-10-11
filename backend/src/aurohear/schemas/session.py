"""Session schemas (spec §12.1 Session)."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal
from uuid import UUID

from pydantic import (
    AwareDatetime,
    Field,
    StrictFloat,
    StrictInt,
    StrictStr,
    field_validator,
)

from .common import Ear, InputModel, OutputModel, Phase, SearchRole


class SessionStatus(StrEnum):
    IN_PROGRESS = "in_progress"
    COMPLETE = "complete"
    INCOMPLETE = "incomplete"  # finalized before the protocol finished
    ABORTED = "aborted"
    INVALIDATED = "invalidated"  # set by a clinician override (not exposed yet)


class AbortReason(StrEnum):
    # spec §12.1
    USER = "user"
    TIMEOUTS = "timeouts"
    DEVICE_CHANGE = "device_change"
    NOISE = "noise"
    # client engine faults (frontend AbortReason)
    CONTEXT_SUSPENDED = "context_suspended"
    CONTEXT_CLOSED = "context_closed"
    CONTEXT_INTERRUPTED = "context_interrupted"
    PROCEDURE_ERROR = "procedure_error"
    STIMULUS_ERROR = "stimulus_error"


class DeviceInfo(InputModel):
    user_agent: StrictStr | None = Field(default=None, max_length=512)
    platform: StrictStr | None = Field(default=None, max_length=128)
    audio_output_label: StrictStr | None = Field(default=None, max_length=256)
    sample_rate: StrictInt | None = Field(default=None, gt=0)
    headphone_profile_id: StrictStr | None = Field(default=None, max_length=128)
    transducer_type: Literal["circumaural", "supra_aural", "insert", "other"] | None = None
    connection: Literal["wired", "bluetooth", "unknown"]

    @field_validator("connection")
    @classmethod
    def _no_bluetooth(cls, v: str) -> str:
        if v == "bluetooth":
            raise ValueError("Bluetooth output is not permitted (spec §3.3: wired only)")
        return v


class CalibrationInfo(InputModel):
    tier: Literal["A", "B", "C"]
    method: Literal["coupler", "model_profile", "biological_1k"]
    profile_version: StrictStr = Field(min_length=1, max_length=64)
    spread_db: StrictFloat | None = Field(default=None, ge=0)
    cross_check_250hz_delta_db: StrictFloat | None = None
    calibrated_at: AwareDatetime | None = None


class EnvironmentInfo(InputModel):
    pretest_dba: StrictFloat | None = None
    pretest_third_octave: dict[str, StrictFloat] | None = None
    mpanl_table: StrictStr | None = Field(default=None, max_length=128)
    test_floor_db: StrictFloat | None = None


class SessionCreate(InputModel):
    participant_id: UUID = Field(description="Pseudonymous id; never a name or email (spec §12.3)")
    consent_version: StrictStr = Field(min_length=1, max_length=64)
    mode: Literal["threshold"] = Field(
        description="Only threshold mode is implemented; screening mode is kept separate (spec §6.5)"
    )
    supervision: Literal["unsupervised", "technician", "clinician"]
    better_ear: Ear | None = Field(
        default=None, description="Self-reported better ear; tested first. Right if unknown."
    )
    profile_cap_db_hl: StrictInt = Field(
        default=90, description="Headphone profile ceiling, ≤ 90 dB HL (spec §3.4)"
    )
    client_time_origin_ms: StrictFloat | None = Field(
        default=None,
        description="performance.timeOrigin (Unix ms): maps client *_ms clocks to wall time",
    )
    device: DeviceInfo
    calibration: CalibrationInfo
    environment: EnvironmentInfo | None = None

    @field_validator("profile_cap_db_hl")
    @classmethod
    def _cap_on_lattice(cls, v: int) -> int:
        if v % 5 or not -10 < v <= 90:
            raise ValueError("profile_cap_db_hl must be a multiple of 5 in (−10, 90]")
        return v


class AbortRequest(InputModel):
    reason: AbortReason


class PresentationOut(OutputModel):
    """The next tone the client must present (mirrors the engine Presentation)."""

    ear: Ear
    frequency_hz: int
    level_db_hl: int
    phase: Phase
    test_role: SearchRole


class SessionOut(OutputModel):
    id: UUID
    participant_id: UUID
    protocol_version: str
    consent_version: str
    mode: str
    supervision: str
    better_ear: Ear | None
    profile_cap_db_hl: int
    status: SessionStatus
    abort_reason: AbortReason | None
    client_time_origin_ms: float | None
    device: dict[str, object]
    calibration: dict[str, object]
    environment: dict[str, object] | None
    started_at: datetime
    completed_at: datetime | None


class SessionState(OutputModel):
    session: SessionOut
    trial_count: int
    next_presentation: PresentationOut | None
    protocol_complete: bool
