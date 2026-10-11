import pytest
from hypothesis import given
from hypothesis import strategies as st

from aurohear.audiometry import FLOOR_DB_HL, MAX_CEILING_DB_HL, LevelLattice


def test_default_lattice_spans_minus10_to_90() -> None:
    lat = LevelLattice()
    assert lat.levels[0] == -10
    assert lat.levels[-1] == 90
    assert len(lat.levels) == 21
    assert all(b - a == 5 for a, b in zip(lat.levels, lat.levels[1:]))


def test_lattice_is_never_capped_at_40() -> None:
    """GAP_ANALYSIS #1 regression guard."""
    assert MAX_CEILING_DB_HL == 90
    assert 45 in LevelLattice()
    assert 90 in LevelLattice()


@pytest.mark.parametrize(
    ("floor", "ceiling"),
    [(-15, 90), (-10, 95), (-10, 87), (-7, 90), (40, 40), (50, 40)],
)
def test_invalid_lattices_rejected(floor: int, ceiling: int) -> None:
    with pytest.raises(ValueError):
        LevelLattice(floor=floor, ceiling=ceiling)


def test_membership() -> None:
    lat = LevelLattice()
    assert -10 in lat and 0 in lat and 85 in lat
    assert -15 not in lat and 95 not in lat and 7 not in lat and 5.0 not in lat


@given(st.integers(min_value=-200, max_value=200))
def test_clamp_always_lands_in_lattice(level: int) -> None:
    lat = LevelLattice()
    clamped, was_clamped = lat.clamp(level)
    assert lat.floor <= clamped <= lat.ceiling
    assert was_clamped == (level < FLOOR_DB_HL or level > MAX_CEILING_DB_HL)


@given(st.floats(min_value=-100, max_value=200, allow_nan=False))
def test_snap_rounds_up_onto_grid(value: float) -> None:
    lat = LevelLattice()
    snapped = lat.snap(value)
    assert snapped in lat
    if lat.floor <= value <= lat.ceiling:
        assert snapped >= round(value)
        assert snapped - round(value) < 5
