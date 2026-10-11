"""Tests for 1 kHz familiarisation (spec §6.2)."""

from __future__ import annotations

import pytest
from hypothesis import given
from hypothesis import strategies as st

from aurohear.audiometry import (
    Ear,
    Familiarisation,
    FamiliarisationConfig,
    FamiliarisationStatus,
    LevelLattice,
    Phase,
)
from aurohear.audiometry.simulation import DeterministicListener, drive
from strategies import grid_thresholds, lattices


def fam_levels(threshold: float, lattice: LevelLattice | None = None) -> tuple[list[int], Familiarisation]:
    f = Familiarisation(Ear.RIGHT, lattice=lattice)
    log = drive(f, DeterministicListener({Ear.RIGHT: {1000: threshold}}))
    assert all(p.phase is Phase.FAMILIARISATION and p.frequency_hz == 1000 for p, _ in log)
    return [p.level_db_hl for p, _ in log], f


def test_normal_listener_completes_at_40_with_two_responses() -> None:
    levels, f = fam_levels(10)
    assert levels == [40, 40]
    res = f.result()
    assert res.status is FamiliarisationStatus.COMPLETE
    assert res.level_db_hl == 40


def test_ascends_10_db_to_80_then_5_db() -> None:
    levels, f = fam_levels(88)
    assert levels == [40, 50, 60, 70, 80, 85, 90, 90]
    assert f.result().level_db_hl == 90


def test_no_response_at_cap() -> None:
    levels, f = fam_levels(200)
    assert levels == [40, 50, 60, 70, 80, 85, 90, 90]
    res = f.result()
    assert res.status is FamiliarisationStatus.NO_RESPONSE
    assert res.level_db_hl == 90


def test_inconsistent_responder_is_bounded() -> None:
    f = Familiarisation(Ear.LEFT)
    flip = iter([True, False] * 100)
    log = drive(f, lambda _p: next(flip))
    res = f.result()
    assert res.status is FamiliarisationStatus.INCONSISTENT
    assert len(log) == FamiliarisationConfig().max_presentations
    assert res.level_db_hl == max(p.level_db_hl for p, heard in log if heard)


def test_respects_low_profile_cap() -> None:
    levels, f = fam_levels(200, LevelLattice(ceiling=60))
    assert max(levels) == 60
    assert f.result().status is FamiliarisationStatus.NO_RESPONSE


def test_cannot_respond_after_completion() -> None:
    _, f = fam_levels(0)
    with pytest.raises(RuntimeError):
        f.record_response(True)


@given(threshold=grid_thresholds(), lattice=lattices())
def test_ideal_observer_familiarisation_level_is_first_audible_step(
    threshold: int, lattice: LevelLattice
) -> None:
    levels, f = fam_levels(threshold, lattice)
    res = f.result()
    if res.status is FamiliarisationStatus.COMPLETE:
        assert res.level_db_hl >= threshold
        assert levels[-2:] == [res.level_db_hl, res.level_db_hl]
    else:
        assert res.status is FamiliarisationStatus.NO_RESPONSE
        assert threshold > lattice.ceiling


@given(st.lists(st.booleans(), max_size=50), lattices())
def test_any_response_sequence_terminates(responses: list[bool], lattice: LevelLattice) -> None:
    f = Familiarisation(Ear.RIGHT, lattice=lattice)
    it = iter(responses)
    log = drive(f, lambda _p: next(it, False), max_steps=50)
    assert len(log) <= FamiliarisationConfig().max_presentations
    assert all(p.level_db_hl in lattice for p, _ in log)
    # Levels never decrease during familiarisation.
    assert all(a.level_db_hl <= b.level_db_hl for (a, _), (b, _) in zip(log, log[1:]))
