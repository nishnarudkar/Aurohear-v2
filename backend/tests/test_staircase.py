"""Unit tests for the Hughson–Westlake staircase (spec §6.3, §6.5)."""

from __future__ import annotations

import pytest

from aurohear.audiometry import (
    Ear,
    HughsonWestlakeStaircase,
    LevelLattice,
    Phase,
    StaircaseConfig,
    ThresholdStatus,
)
from aurohear.audiometry.simulation import DeterministicListener, drive


def make(start: int = 40, *, lattice: LevelLattice | None = None, **cfg: int) -> HughsonWestlakeStaircase:
    return HughsonWestlakeStaircase(
        Ear.RIGHT, 1000, start, lattice=lattice, config=StaircaseConfig(**cfg) if cfg else None
    )


def run_script(sc: HughsonWestlakeStaircase, responses: list[bool]) -> list[int]:
    """Feed a fixed response script; return the levels that were presented."""
    levels = []
    for r in responses:
        p = sc.next_presentation()
        assert p is not None, "staircase terminated before the script ended"
        levels.append(p.level_db_hl)
        sc.record_response(r)
    return levels


def deterministic(threshold: float, start: int = 40, **kw: object) -> HughsonWestlakeStaircase:
    sc = make(start, **kw)  # type: ignore[arg-type]
    drive(sc, DeterministicListener({Ear.RIGHT: {1000: threshold}}))
    return sc


# --------------------------------------------------------------------- spec worked trace


def test_spec_worked_trace_true_threshold_25() -> None:
    """Spec §6.5 worked trace (catch trial and QC probes are runner concerns)."""
    sc = make(40)
    levels = run_script(sc, [True, True, False, True, False, False, True])
    assert levels == [40, 30, 20, 25, 15, 20, 25]
    assert sc.is_complete
    res = sc.result()
    assert res.status is ThresholdStatus.MEASURED
    assert res.threshold_db_hl == 25
    assert (res.ascending_hits, res.ascending_trials) == (2, 2)
    assert res.ascents_completed == 2
    phases = [t.phase for t in res.trials]
    assert phases == [
        Phase.DESCENT, Phase.DESCENT, Phase.DESCENT, Phase.ASCENT,
        Phase.DESCENT, Phase.ASCENT, Phase.ASCENT,
    ]


# --------------------------------------------------------------------- step rules


def test_down_10_on_response_up_5_on_no_response() -> None:
    sc = make(50)
    levels = run_script(sc, [True, True, False, False, True])
    assert levels == [50, 40, 30, 35, 40]


def test_descending_responses_never_count_toward_threshold() -> None:
    """Hits reached from above are not ascending trials (ascending technique)."""
    sc = make(60)
    run_script(sc, [True, True, True])  # 60, 50, 40 all heard on descent
    assert not sc.is_complete
    assert all(not t.counted_as_ascending for t in sc._trials)  # noqa: SLF001


def test_two_of_three_ascending_criterion() -> None:
    """ANSI S3.21: 2 responses out of 3 ascending presentations at one level."""
    # 40✓ 30✗ 35✓(1/1@35) | 25✗ 30✗ 35✗(1/2@35) 40✓(1/1@40) | 30✗ 35✓ → 2/3 @35
    sc = make(40)
    levels = run_script(sc, [True, False, True, False, False, False, True, False, True])
    assert levels == [40, 30, 35, 25, 30, 35, 40, 30, 35]
    res = sc.result()
    assert res.status is ThresholdStatus.MEASURED
    assert res.threshold_db_hl == 35
    assert (res.ascending_hits, res.ascending_trials) == (2, 3)


def test_one_of_two_does_not_terminate() -> None:
    sc = make(40)
    run_script(sc, [True, False, True, False, False, False])  # 1 hit / 2 trials at 35
    assert not sc.is_complete


def test_two_of_five_is_below_fifty_percent() -> None:
    """Ratio must be ≥50 %: 2/5 is not a threshold, 2/4 is (BSA "2 out of 4 ascents")."""
    sc = make(30)
    sc._asc_hits[30], sc._asc_trials[30] = 2, 5  # noqa: SLF001
    assert sc._lowest_level_meeting_criterion() is None  # noqa: SLF001
    sc._asc_trials[30] = 4  # noqa: SLF001
    assert sc._lowest_level_meeting_criterion() == 30  # noqa: SLF001


# --------------------------------------------------------------------- convergence


@pytest.mark.parametrize("threshold", list(range(-10, 91, 5)))
@pytest.mark.parametrize("start", [-10, 0, 20, 40, 60, 90])
def test_deterministic_listener_converges_exactly(threshold: int, start: int) -> None:
    res = deterministic(threshold, start).result()
    assert res.status is ThresholdStatus.MEASURED
    assert res.threshold_db_hl == threshold


@pytest.mark.parametrize("threshold", [45, 55, 70, 85, 90])
def test_thresholds_above_40_are_measured(threshold: int) -> None:
    """GAP_ANALYSIS #1: moderate-to-profound loss must be measurable."""
    res = deterministic(threshold, start=40).result()
    assert res.status is ThresholdStatus.MEASURED
    assert res.threshold_db_hl == threshold


def test_off_grid_threshold_rounds_up_to_next_grid_level() -> None:
    res = deterministic(22.5, start=40).result()
    assert res.threshold_db_hl == 25


# --------------------------------------------------------------------- floor & ceiling


@pytest.mark.parametrize("threshold", [-10, -15, -40])
def test_floor_threshold_is_measured_and_flagged(threshold: int) -> None:
    res = deterministic(threshold, start=40).result()
    assert res.status is ThresholdStatus.MEASURED
    assert res.threshold_db_hl == -10
    assert res.floor_limited
    assert res.clamp_events >= 1


def test_no_response_above_ceiling_reports_nr_at_cap() -> None:
    res = deterministic(110, start=40).result()
    assert res.status is ThresholdStatus.NO_RESPONSE
    assert res.threshold_db_hl == 90
    levels = [t.level_db_hl for t in res.trials]
    assert levels[-2:] == [90, 90]
    assert max(levels) == 90


def test_single_lapse_at_ceiling_is_not_nr() -> None:
    sc = make(80)
    # 80✗ 85✗ 90✗(lapse) 90✓ → down to 80 … threshold should still be found.
    run_script(sc, [False, False, False, True])
    assert not sc.is_complete


def test_profile_cap_below_90_is_respected() -> None:
    lat = LevelLattice(ceiling=70)
    sc = make(40, lattice=lat)
    drive(sc, DeterministicListener({Ear.RIGHT: {1000: 80}}))
    res = sc.result()
    assert res.status is ThresholdStatus.NO_RESPONSE
    assert res.threshold_db_hl == 70
    assert max(t.level_db_hl for t in res.trials) == 70


# --------------------------------------------------------------------- safety limits


def test_max_ascents_guard_on_drifting_responder() -> None:
    """Alternating yes/no drifts down 5 dB per run and never hits one level twice.

    40✓ 30✗ 35✓ | 25✗ 30✓ | 20✗ 25✓ | 15✗ 20✓ | 10✗ 15✓ | 5✗ 10✓ → 6 ascents, no criterion.
    """
    sc = make(40)
    flip = iter([True, False] * 50)
    drive(sc, lambda _p: next(flip))
    res = sc.result()
    assert res.status is ThresholdStatus.UNRESOLVED
    assert res.threshold_db_hl is None
    assert res.ascents_completed == 6
    assert res.presentations == 13
    assert res.provisional_db_hl == 10


def test_always_no_response_until_cap_is_nr() -> None:
    sc = make(-10)
    drive(sc, lambda _p: False)
    res = sc.result()
    assert res.status is ThresholdStatus.NO_RESPONSE
    assert res.presentations == 21 + 1  # −10 → 90 is 21 levels, then one confirmation


def test_always_responds_is_floor_limited() -> None:
    sc = make(90)
    drive(sc, lambda _p: True)
    res = sc.result()
    assert res.status is ThresholdStatus.MEASURED
    assert res.threshold_db_hl == -10 and res.floor_limited


def test_max_presentations_guard() -> None:
    sc = make(40, max_presentations=5)
    drive(sc, lambda _p: False)
    res = sc.result()
    assert res.status is ThresholdStatus.UNRESOLVED
    assert res.threshold_db_hl is None
    assert res.presentations == 5


def test_unresolved_carries_provisional_level() -> None:
    sc = make(40, max_presentations=4)
    run_script(sc, [True, False, True, False])  # 1/1 at 35 ascending
    res = sc.result()
    assert res.status is ThresholdStatus.UNRESOLVED
    assert res.provisional_db_hl == 35


# --------------------------------------------------------------------- API contract


def test_start_level_must_be_on_lattice() -> None:
    with pytest.raises(ValueError):
        make(42)
    with pytest.raises(ValueError):
        make(95)


def test_cannot_respond_after_completion() -> None:
    sc = deterministic(30)
    assert sc.next_presentation() is None
    with pytest.raises(RuntimeError):
        sc.record_response(True)


def test_result_before_completion_raises() -> None:
    with pytest.raises(RuntimeError):
        make().result()


@pytest.mark.parametrize(
    "kwargs", [{"min_hits": 1}, {"min_hit_ratio": 0.4}, {"max_ascents": 1}, {"max_presentations": 0}]
)
def test_config_cannot_be_looser_than_asha(kwargs: dict[str, float]) -> None:
    with pytest.raises(ValueError):
        StaircaseConfig(**kwargs)  # type: ignore[arg-type]
