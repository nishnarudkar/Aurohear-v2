"""Hypothesis strategies shared across test modules."""

from __future__ import annotations

from hypothesis import strategies as st

from aurohear.audiometry import Ear, LevelLattice
from aurohear.audiometry.protocol import FIRST_EAR_SEQUENCE

DEFAULT_LATTICE = LevelLattice()
TEST_FREQUENCIES: tuple[int, ...] = tuple(sorted({f for f, _ in FIRST_EAR_SEQUENCE}))


def lattice_levels(lattice: LevelLattice = DEFAULT_LATTICE) -> st.SearchStrategy[int]:
    return st.sampled_from(lattice.levels)


@st.composite
def lattices(draw: st.DrawFn) -> LevelLattice:
    """Profile caps from 50 to 90 dB HL (a cap below 90 models a weak transducer)."""
    ceiling = draw(st.sampled_from(range(50, 91, 5)))
    return LevelLattice(ceiling=ceiling)


def grid_thresholds() -> st.SearchStrategy[int]:
    """True thresholds on the 5 dB grid, including beyond both ends of the lattice."""
    return st.sampled_from(range(-30, 121, 5))


def continuous_thresholds() -> st.SearchStrategy[float]:
    return st.floats(min_value=-20.0, max_value=100.0, allow_nan=False)


@st.composite
def grid_audiograms(draw: st.DrawFn) -> dict[Ear, dict[int, float]]:
    return {
        ear: {f: float(draw(grid_thresholds())) for f in TEST_FREQUENCIES} for ear in Ear
    }
