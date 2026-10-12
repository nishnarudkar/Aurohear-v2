"""Trial schemas — the atomic, append-only research record (spec §12.1 Trial).

All `*_ms` times are on the client's monotonic session clock (performance.now(),
the same clock as key-event timestamps); `audio_context_onset_s` is the AudioContext
clock. `Session.client_time_origin_ms` maps them to wall time.
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Self
from uuid import UUID

from pydantic import Field, StrictBool, StrictFloat, StrictInt, StrictStr, model_validator

from .common import (
    RESPONSE_WINDOW_AFTER_OFFSET_MS,
    SUPPORTED_FREQUENCIES_HZ,
    Ear,
    InputModel,
    OutputModel,
    Phase,
    SearchRole,
)
from .session import PresentationOut

# Tolerance for client-computed differences of float timestamps.
_TIME_EPS_MS = 0.01


class TrialCreate(InputModel):
    trial_id: UUID = Field(description="Client-generated; also the idempotency key for retries")
    seq: StrictInt = Field(ge=0, description="0-based, gapless order within the session")
    ear: Ear
    frequency_hz: StrictInt
    level_db_hl: StrictInt | None = Field(description="Requested level; null for catch trials")
    presented_level_db_hl: StrictFloat | None = Field(
        default=None, description="Delivered level after output-ceiling clamping"
    )
    level_clamped: StrictBool = Field(default=False, description="QC indicator 13 (spec §10)")
    phase: Phase
    test_role: SearchRole
    is_catch_trial: StrictBool
    scheduled_at_ms: StrictFloat
    presented_at_ms: StrictFloat = Field(description="Stimulus onset (session clock)")
    offset_at_ms: StrictFloat = Field(description="Stimulus offset (session clock)")
    audio_context_onset_s: StrictFloat | None = None
    duration_ms: StrictFloat = Field(gt=0)
    isi_ms: StrictFloat = Field(ge=0)
    responded: StrictBool = Field(description="A press inside onset → offset + 2 s")
    response_at_ms: StrictFloat | None = None
    response_latency_ms: StrictFloat | None = Field(default=None, description="response − onset")
    extra_responses: StrictInt = Field(default=0, ge=0)
    ambient_dba_at_trial: StrictFloat | None = None
    discarded: StrictBool = False
    discard_reason: StrictStr | None = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def _clinical_invariants(self) -> Self:
        errors: list[str] = []
        floats = [self.scheduled_at_ms, self.presented_at_ms, self.offset_at_ms, self.duration_ms, self.isi_ms]
        if not all(math.isfinite(x) for x in floats):
            errors.append("timestamps must be finite")
        if self.frequency_hz not in SUPPORTED_FREQUENCIES_HZ:
            errors.append(f"frequency_hz {self.frequency_hz} is not an audiometric test frequency")
        # Catch trials are silent.
        if self.is_catch_trial != (self.phase is Phase.CATCH):
            errors.append("is_catch_trial must be true exactly when phase is 'catch'")
        if self.is_catch_trial and (self.level_db_hl is not None or self.presented_level_db_hl is not None):
            errors.append("a catch trial has no level")
        if not self.is_catch_trial:
            if self.level_db_hl is None:
                errors.append("a tone trial requires level_db_hl")
            elif self.level_db_hl % 5 or not -10 <= self.level_db_hl <= 90:
                errors.append("level_db_hl must be on the 5 dB lattice −10…90 dB HL")
        # Timeline.
        if self.presented_at_ms < self.scheduled_at_ms:
            errors.append("presented_at_ms precedes scheduled_at_ms")
        if abs((self.offset_at_ms - self.presented_at_ms) - self.duration_ms) > 1.0:
            errors.append("offset_at_ms − presented_at_ms must equal duration_ms")
        # Responses: present iff responded; inside the window; latency consistent.
        if self.responded:
            if self.response_at_ms is None or self.response_latency_ms is None:
                errors.append("responded trials require response_at_ms and response_latency_ms")
            else:
                window_end = self.offset_at_ms + RESPONSE_WINDOW_AFTER_OFFSET_MS
                if not self.presented_at_ms <= self.response_at_ms <= window_end + _TIME_EPS_MS:
                    errors.append("response_at_ms is outside the response window (onset → offset + 2 s)")
                if abs(self.response_latency_ms - (self.response_at_ms - self.presented_at_ms)) > _TIME_EPS_MS:
                    errors.append("response_latency_ms must equal response_at_ms − presented_at_ms")
        elif self.response_at_ms is not None or self.response_latency_ms is not None:
            errors.append("non-responded trials must not carry response_at_ms / response_latency_ms")
        if self.discarded != (self.discard_reason is not None):
            errors.append("discard_reason is required exactly when discarded is true")
        if errors:
            raise ValueError("; ".join(errors))
        return self


class TrialOut(OutputModel):
    id: UUID
    session_id: UUID
    seq: int
    ear: Ear
    frequency_hz: int
    level_db_hl: int | None
    presented_level_db_hl: float | None
    level_clamped: bool
    phase: Phase
    test_role: SearchRole
    is_catch_trial: bool
    scheduled_at_ms: float
    presented_at_ms: float
    offset_at_ms: float
    audio_context_onset_s: float | None
    duration_ms: float
    isi_ms: float
    responded: bool
    response_at_ms: float | None
    response_latency_ms: float | None
    extra_responses: int
    ambient_dba_at_trial: float | None
    discarded: bool
    discard_reason: str | None
    received_at: datetime


class TrialAccepted(OutputModel):
    trial: TrialOut
    advanced_protocol: bool = Field(
        description="False for catch and discarded trials: they never move the staircase"
    )
    idempotent_replay: bool = Field(description="True when this exact trial was already stored")
    next_presentation: PresentationOut | None
    protocol_complete: bool
