"""The presentation-level lattice (spec §6.3, §6.5).

    L = {−10, −5, 0, 5, ..., min(profile_cap, 90)}  dB HL, 5 dB grid

Every level the engine ever presents is a member of this lattice. Requests outside it
are clamped and the clamp is reported to the caller so it can be logged as a QC
"level-clamp event" (spec §10, indicator 13).
"""

from __future__ import annotations

from dataclasses import dataclass

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
