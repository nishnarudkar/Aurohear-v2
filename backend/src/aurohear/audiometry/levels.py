"""The presentation-level lattice (spec §6.3, §6.5).

    L = {−10, −5, 0, 5, ..., min(profile_cap, 90)}  dB HL, 5 dB grid

Every level the engine ever presents is a member of this lattice. Requests outside it
are clamped and the clamp is reported to the caller so it can be logged as a QC
"level-clamp event" (spec §10, indicator 13).
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field

FLOOR_DB_HL: int = -10
"""ASHA audiogram minimum [R1]."""

MAX_CEILING_DB_HL: int = 90
"""Absolute ceiling for this system. Never lowered to 40 dB HL (GAP_ANALYSIS #1)."""

STEP_DB: int = 5
"""Lattice resolution."""

STEP_DOWN_DB: int = 10
"""Hughson–Westlake: down 10 dB after every response."""

STEP_UP_DB: int = 5
"""Hughson–Westlake: up 5 dB after every non-response."""


@dataclass(frozen=True, slots=True)
class LevelLattice:
    """A 5 dB grid from ``floor`` to ``ceiling`` inclusive (both in dB HL).

    ``ceiling`` is the headphone profile cap (spec §3.4); it may be lower than 90 dB HL
    for a transducer that cannot deliver 90 dB HL without distortion, but never higher.
    """

    floor: int = FLOOR_DB_HL
    ceiling: int = MAX_CEILING_DB_HL

    def __post_init__(self) -> None:
        if self.floor % STEP_DB or self.ceiling % STEP_DB:
            raise ValueError("floor and ceiling must lie on the 5 dB grid")
        if self.floor < FLOOR_DB_HL:
            raise ValueError(f"floor must be >= {FLOOR_DB_HL} dB HL")
        if self.ceiling > MAX_CEILING_DB_HL:
            raise ValueError(f"ceiling must be <= {MAX_CEILING_DB_HL} dB HL")
        if self.ceiling <= self.floor:
            raise ValueError("ceiling must be above floor")

    @property
    def levels(self) -> tuple[int, ...]:
        return tuple(range(self.floor, self.ceiling + 1, STEP_DB))

    def __contains__(self, level: object) -> bool:
        return (
            isinstance(level, int)
            and self.floor <= level <= self.ceiling
            and level % STEP_DB == 0
        )

    def snap(self, level: float) -> int:
        """Round an arbitrary dB value up to the next grid point, then clamp.

        Rounding *up* is the conservative choice for a start level: it guarantees the
        start is at least as audible as requested.
        """
        snapped = -(-int(round(level)) // STEP_DB) * STEP_DB  # ceil to multiple of 5
        return self.clamp(snapped)[0]

    def clamp(self, level: int) -> tuple[int, bool]:
        """Clamp ``level`` into the lattice. Returns ``(level, was_clamped)``."""
        if level < self.floor:
            return self.floor, True
        if level > self.ceiling:
            return self.ceiling, True
        return level, False


def floor_to_grid(level_db_hl: float) -> int:
    """Largest 5 dB grid level ≤ `level_db_hl` (a cap is never rounded *up*)."""
    return math.floor(level_db_hl / STEP_DB) * STEP_DB


@dataclass(frozen=True, slots=True)
class FrequencyLattices:
    """Per-frequency output ceilings (spec §3.4: min(profile_max_f, 90 dB HL)).

    `caps_db_hl` holds the transducer profile's maximum deliverable level per frequency,
    which need not lie on the grid (e.g. 84 dB HL at 8 kHz). It is floored to the 5 dB
    grid so the engine never requests a level the hardware cannot produce. Frequencies
    without an entry use `default`.
    """

    default: LevelLattice = field(default_factory=LevelLattice)
    caps_db_hl: Mapping[int, float] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for f, cap in self.caps_db_hl.items():
            if not math.isfinite(cap) or floor_to_grid(cap) <= self.default.floor:
                raise ValueError(f"cap {cap} dB HL at {f} Hz leaves no testable range above the floor")

    def for_frequency(self, frequency_hz: int) -> LevelLattice:
        cap = self.caps_db_hl.get(frequency_hz)
        if cap is None:
            return self.default
        ceiling = min(self.default.ceiling, floor_to_grid(cap))
        if ceiling == self.default.ceiling:
            return self.default
        return LevelLattice(floor=self.default.floor, ceiling=ceiling)
