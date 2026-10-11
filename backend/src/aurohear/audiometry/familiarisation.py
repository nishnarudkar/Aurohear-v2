"""1 kHz familiarisation, run once per ear before threshold search (spec §6.2).

[DESIGN] procedure for unsupervised web use (BSA-derived):

* start at 40 dB HL;
* on non-response ascend in 10 dB steps up to 80 dB HL, then 5 dB steps, hard-stopping
  at the profile ceiling;
* complete when the listener responds on two *consecutive* presentations at the same
  level — that level seeds the 1 kHz threshold search.

Termination is guaranteed: non-responses only move the level upward, two consecutive
non-responses at the ceiling end with ``no_response``, and an erratic responder is cut
off at ``max_presentations`` with ``inconsistent`` (the runner should re-instruct).
"""

from __future__ import annotations

from dataclasses import dataclass

from .levels import LevelLattice
from .models import (
    Ear,
    FamiliarisationResult,
    FamiliarisationStatus,
    FamiliarisationTrial,
    Phase,
    Presentation,
    SearchRole,
)


@dataclass(frozen=True, slots=True)
class FamiliarisationConfig:
    start_level_db_hl: int = 40
    coarse_step_db: int = 10
    fine_step_db: int = 5
    fine_above_db_hl: int = 80
    consecutive_required: int = 2
    ceiling_confirmations: int = 2
    max_presentations: int = 12


class Familiarisation:
    """Event-driven familiarisation, same protocol as the staircase:
    :meth:`next_presentation` → present → :meth:`record_response`."""

    def __init__(
        self,
        ear: Ear,
        frequency_hz: int = 1000,
        *,
        lattice: LevelLattice | None = None,
        config: FamiliarisationConfig | None = None,
    ) -> None:
        self.ear = ear
        self.frequency_hz = frequency_hz
        self.lattice = lattice or LevelLattice()
        self.config = config or FamiliarisationConfig()
        self._level = self.lattice.snap(self.config.start_level_db_hl)
        self._consecutive_hits = 0
        self._ceiling_misses = 0
        self._highest_heard: int | None = None
        self._trials: list[FamiliarisationTrial] = []
        self._status: FamiliarisationStatus | None = None
        self._final_level: int | None = None

    @property
    def is_complete(self) -> bool:
        return self._status is not None

    def next_presentation(self) -> Presentation | None:
        if self.is_complete:
            return None
        return Presentation(
            ear=self.ear,
            frequency_hz=self.frequency_hz,
            level_db_hl=self._level,
            phase=Phase.FAMILIARISATION,
            test_role=SearchRole.INITIAL,
        )

    def record_response(self, responded: bool) -> None:
        if self.is_complete:
            raise RuntimeError("familiarisation has already terminated")
        cfg = self.config
        level = self._level
        self._trials.append(
            FamiliarisationTrial(seq=len(self._trials), level_db_hl=level, responded=responded)
        )

        if responded:
            self._ceiling_misses = 0
            self._consecutive_hits += 1
            self._highest_heard = max(level, self._highest_heard or level)
            if self._consecutive_hits >= cfg.consecutive_required:
                self._finish(FamiliarisationStatus.COMPLETE, level)
                return
            # Stay at this level to confirm the response.
        else:
            self._consecutive_hits = 0
            if level == self.lattice.ceiling:
                self._ceiling_misses += 1
                if self._ceiling_misses >= cfg.ceiling_confirmations:
                    self._finish(FamiliarisationStatus.NO_RESPONSE, level)
                    return
            self._level = self._step_up(level)

        if len(self._trials) >= cfg.max_presentations:
            fallback = self._highest_heard if self._highest_heard is not None else self.lattice.ceiling
            self._finish(FamiliarisationStatus.INCONSISTENT, fallback)

    def _step_up(self, level: int) -> int:
        cfg = self.config
        if level < cfg.fine_above_db_hl:
            requested = min(level + cfg.coarse_step_db, cfg.fine_above_db_hl)
        else:
            requested = level + cfg.fine_step_db
        return self.lattice.clamp(requested)[0]

    def _finish(self, status: FamiliarisationStatus, level: int) -> None:
        self._status = status
        self._final_level = level

    def result(self) -> FamiliarisationResult:
        if self._status is None or self._final_level is None:
            raise RuntimeError("familiarisation has not terminated yet")
        return FamiliarisationResult(
            ear=self.ear,
            frequency_hz=self.frequency_hz,
            status=self._status,
            level_db_hl=self._final_level,
            trials=tuple(self._trials),
        )
