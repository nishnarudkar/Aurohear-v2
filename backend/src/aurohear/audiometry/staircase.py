"""Modified Hughson–Westlake threshold search for one ear × one frequency (spec §6.3).

Rules, verbatim from the spec:

    2. DOWN 10 dB after every response, until no response.
    3. UP 5 dB after every non-response, until a response.
    4. After the first ascending response: DOWN 10 dB, begin a new ascending run.
    6. THRESHOLD = the lowest level at which the subject responds on at least 50% of
       ascending trials, with a MINIMUM OF TWO responses at that level.

An *ascending trial* is a presentation reached by a 5 dB step up, i.e. one that follows
at least one non-response in the current run. Presentations reached from above (the
initial descent and the first tone of each run after the 10 dB drop) are not ascending
trials and never count toward the criterion — this is what makes the method an
ascending threshold technique.

The search terminates ONLY on one of:

* ``measured``    — the reversal-counting criterion above is met;
* ``no_response`` — the listener fails to respond at the ceiling on
  ``ceiling_confirmations`` consecutive presentations;
* ``unresolved``  — a safety limit (max ascents / max presentations, spec §6.3 design
  table) is reached first. This is a fatigue/loop guard that yields *no* threshold; it is
  NOT a trial-count termination rule (GAP_ANALYSIS #2).

Clinical trade-off — the lattice floor (−10 dB HL): a level reached from above cannot be
ascended into when there is nothing below it. Presentations *at the floor* are therefore
counted as ascending trials even when they were reached by a descending step. Without
this, a listener with true threshold ≤ −10 dB HL could never satisfy the criterion and
would always end ``unresolved``. Such thresholds are reported with ``floor_limited=True``
("≤ −10 dB HL").
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from .levels import STEP_DOWN_DB, STEP_UP_DB, LevelLattice
from .models import (
    Ear,
    Phase,
    Presentation,
    SearchRole,
    StaircaseTrial,
    ThresholdResult,
    ThresholdStatus,
)


@dataclass(frozen=True, slots=True)
class StaircaseConfig:
    """Parameters the standards leave open (spec §6.3 "Implementation decisions")."""

    min_hits: int = 2
    """Minimum ascending responses at the threshold level (ASHA 2005 / ANSI S3.21)."""

    min_hit_ratio: float = 0.5
    """Responses ÷ ascending presentations at the threshold level must be ≥ this."""

    max_ascents: int = 6
    """Completed ascending runs without meeting the criterion → ``unresolved``."""

    max_presentations: int = 25
    """Hard fatigue guard per frequency → ``unresolved``."""

    ceiling_confirmations: int = 2
    """Consecutive non-responses at the ceiling required to record ``no_response``.

    Trade-off: 1 would be faster, but a single lapse at the ceiling would then be
    reported as profound loss. 2 costs at most one extra presentation.
    """

    def __post_init__(self) -> None:
        # The criterion may be made stricter than ASHA 2005, never looser.
        if self.min_hits < 2:
            raise ValueError("min_hits must be >= 2 (ASHA 2005 minimum)")
        if not 0.5 <= self.min_hit_ratio <= 1.0:
            raise ValueError("min_hit_ratio must be in [0.5, 1] (ASHA 2005 minimum)")
        if self.max_ascents < self.min_hits:
            raise ValueError("max_ascents must allow at least min_hits ascents")
        if self.max_presentations < 1 or self.ceiling_confirmations < 1:
            raise ValueError("limits must be positive")


class HughsonWestlakeStaircase:
    """Event-driven staircase: call :meth:`next_presentation`, present the tone, then
    :meth:`record_response`. Repeat until :attr:`is_complete`, then read :meth:`result`.

    The object holds no clock and performs no I/O, so it is fully deterministic and can
    be driven equally by the browser runner, the API, or a synthetic listener.
    """

    def __init__(
        self,
        ear: Ear,
        frequency_hz: int,
        start_level_db_hl: int,
        *,
        lattice: LevelLattice | None = None,
        config: StaircaseConfig | None = None,
        role: SearchRole = SearchRole.INITIAL,
    ) -> None:
        self.ear = ear
        self.frequency_hz = frequency_hz
        self.role = role
        self.lattice = lattice or LevelLattice()
        self.config = config or StaircaseConfig()
        if start_level_db_hl not in self.lattice:
            raise ValueError(
                f"start level {start_level_db_hl} dB HL is not on the lattice "
                f"[{self.lattice.floor}, {self.lattice.ceiling}] / 5 dB"
            )

        self._level = start_level_db_hl
        self._level_clamped = False
        self._in_ascent = False
        self._run_index = 0
        self._ascents_completed = 0
        self._ceiling_misses = 0
        self._clamp_events = 0
        self._asc_trials: Counter[int] = Counter()
        self._asc_hits: Counter[int] = Counter()
        self._trials: list[StaircaseTrial] = []
        self._status: ThresholdStatus | None = None
        self._threshold: int | None = None

    # ------------------------------------------------------------------ queries

    @property
    def is_complete(self) -> bool:
        return self._status is not None

    @property
    def current_phase(self) -> Phase:
        return Phase.ASCENT if self._in_ascent else Phase.DESCENT

    def next_presentation(self) -> Presentation | None:
        """The tone to present next, or ``None`` once the search has terminated."""
        if self.is_complete:
            return None
        return Presentation(
            ear=self.ear,
            frequency_hz=self.frequency_hz,
            level_db_hl=self._level,
            phase=self.current_phase,
            test_role=self.role,
        )

    # ------------------------------------------------------------------ commands

    def record_response(self, responded: bool) -> None:
        """Apply the listener's response to the tone from :meth:`next_presentation`."""
        if self.is_complete:
            raise RuntimeError("staircase has already terminated")

        level = self._level
        counted = self._in_ascent or level == self.lattice.floor
        self._trials.append(
            StaircaseTrial(
                seq=len(self._trials),
                level_db_hl=level,
                phase=self.current_phase,
                responded=responded,
                run_index=self._run_index,
                counted_as_ascending=counted,
                level_clamped=self._level_clamped,
            )
        )
        if counted:
            self._asc_trials[level] += 1
            if responded:
                self._asc_hits[level] += 1

        if responded:
            self._on_response(level, counted)
        else:
            self._on_no_response(level)

        if not self.is_complete:
            self._apply_safety_limits()

    def _on_response(self, level: int, counted: bool) -> None:
        self._ceiling_misses = 0
        if self._in_ascent:
            self._ascents_completed += 1
            self._run_index += 1
        if counted:
            met = self._lowest_level_meeting_criterion()
            if met is not None:
                self._finish(ThresholdStatus.MEASURED, met)
                return
        self._in_ascent = False
        self._move_to(level - STEP_DOWN_DB)

    def _on_no_response(self, level: int) -> None:
        if level == self.lattice.ceiling:
            self._ceiling_misses += 1
            if self._ceiling_misses >= self.config.ceiling_confirmations:
                self._finish(ThresholdStatus.NO_RESPONSE, self.lattice.ceiling)
                return
        else:
            self._ceiling_misses = 0
        self._in_ascent = True
        self._move_to(level + STEP_UP_DB)

    def _apply_safety_limits(self) -> None:
        cfg = self.config
        if (
            self._ascents_completed >= cfg.max_ascents
            or len(self._trials) >= cfg.max_presentations
        ):
            self._finish(ThresholdStatus.UNRESOLVED, None)

    def _move_to(self, requested: int) -> None:
        self._level, self._level_clamped = self.lattice.clamp(requested)
        if self._level_clamped:
            self._clamp_events += 1

    def _finish(self, status: ThresholdStatus, threshold: int | None) -> None:
        self._status = status
        self._threshold = threshold

    # ------------------------------------------------------------------ criterion

    def _meets(self, level: int, min_hits: int) -> bool:
        hits = self._asc_hits[level]
        return hits >= min_hits and hits >= self.config.min_hit_ratio * self._asc_trials[level]

    def _lowest_level_meeting_criterion(self) -> int | None:
        qualifying = [lv for lv in self._asc_hits if self._meets(lv, self.config.min_hits)]
        return min(qualifying, default=None)

    def _provisional(self) -> int | None:
        qualifying = [lv for lv in self._asc_hits if self._meets(lv, 1)]
        return min(qualifying, default=None)

    # ------------------------------------------------------------------ result

    def result(self) -> ThresholdResult:
        if self._status is None:
            raise RuntimeError("staircase has not terminated yet")
        status = self._status
        if status is ThresholdStatus.UNRESOLVED:
            provisional = self._provisional()
            ref_level = provisional
        else:
            provisional = None
            ref_level = self._threshold
        return ThresholdResult(
            ear=self.ear,
            frequency_hz=self.frequency_hz,
            test_role=self.role,
            status=status,
            threshold_db_hl=self._threshold,
            provisional_db_hl=provisional,
            ascending_hits=self._asc_hits[ref_level] if ref_level is not None else 0,
            ascending_trials=self._asc_trials[ref_level] if ref_level is not None else 0,
            ascents_completed=self._ascents_completed,
            presentations=len(self._trials),
            floor_limited=(
                status is ThresholdStatus.MEASURED and self._threshold == self.lattice.floor
            ),
            clamp_events=self._clamp_events,
            trials=tuple(self._trials),
        )
