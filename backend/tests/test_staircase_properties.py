"""Property-based tests for the Hughson–Westlake staircase.

Three families of properties:

1. Safety — for ANY response sequence (adversarial, random, inconsistent) the staircase
   terminates within its presentation limit, stays on the lattice and obeys the
   10-down / 5-up step rule exactly.
2. Correctness — whenever a threshold is reported it satisfies the reversal-counting
   criterion, and it is the lowest level that does.
3. Accuracy — against synthetic listeners the estimate converges to the true threshold
   (exactly for an ideal observer; within a tight bound for steep psychometric listeners).
"""

from __future__ import annotations

from collections import Counter

from hypothesis import assume, given, note
from hypothesis import strategies as st

from aurohear.audiometry import (
    Ear,
    HughsonWestlakeStaircase,
    LevelLattice,
    StaircaseConfig,
    ThresholdResult,
    ThresholdStatus,
)
from aurohear.audiometry.simulation import DeterministicListener, PsychometricListener, drive
from strategies import continuous_thresholds, grid_thresholds, lattices

CFG = StaircaseConfig()


@st.composite
def staircase_on_lattice(draw: st.DrawFn) -> HughsonWestlakeStaircase:
    lattice = draw(lattices())
    start = draw(st.sampled_from(lattice.levels))
    return HughsonWestlakeStaircase(Ear.LEFT, 2000, start, lattice=lattice)


def run_responses(sc: HughsonWestlakeStaircase, responses: list[bool]) -> ThresholdResult:
    """Drive with a scripted sequence; pad with alternating answers if it runs out."""
    it = iter(responses)
    i = 0

    def answer(_p: object) -> bool:
        nonlocal i
        i += 1
        return next(it, i % 2 == 0)

    drive(sc, answer, max_steps=CFG.max_presentations + 1)
    return sc.result()


# ============================================================== 1. safety


@given(staircase_on_lattice(), st.lists(st.booleans(), max_size=60))
def test_any_response_sequence_terminates_within_limit(
    sc: HughsonWestlakeStaircase, responses: list[bool]
) -> None:
    res = run_responses(sc, responses)
    assert sc.is_complete
    assert 1 <= res.presentations <= CFG.max_presentations
    assert res.ascents_completed <= CFG.max_ascents


@given(staircase_on_lattice(), st.lists(st.booleans(), max_size=60))
def test_every_level_is_on_the_lattice(sc: HughsonWestlakeStaircase, responses: list[bool]) -> None:
    res = run_responses(sc, responses)
    for t in res.trials:
        assert t.level_db_hl in sc.lattice


@given(staircase_on_lattice(), st.lists(st.booleans(), max_size=60))
def test_step_rule_is_exactly_down10_up5(sc: HughsonWestlakeStaircase, responses: list[bool]) -> None:
    res = run_responses(sc, responses)
    lat = sc.lattice
    for prev, nxt in zip(res.trials, res.trials[1:]):
        if prev.responded:
            expected, clamped = lat.clamp(prev.level_db_hl - 10)
        else:
            expected, clamped = lat.clamp(prev.level_db_hl + 5)
        assert nxt.level_db_hl == expected
        assert nxt.level_clamped == clamped


@given(staircase_on_lattice(), st.lists(st.booleans(), max_size=60))
def test_only_ascending_or_floor_presentations_are_counted(
    sc: HughsonWestlakeStaircase, responses: list[bool]
) -> None:
    res = run_responses(sc, responses)
    in_ascent = False
    for t in res.trials:
        assert t.counted_as_ascending == (in_ascent or t.level_db_hl == sc.lattice.floor)
        in_ascent = not t.responded


@given(staircase_on_lattice(), st.lists(st.booleans(), max_size=60))
def test_never_exceeds_ceiling_and_nr_only_after_ceiling_misses(
    sc: HughsonWestlakeStaircase, responses: list[bool]
) -> None:
    res = run_responses(sc, responses)
    assert max(t.level_db_hl for t in res.trials) <= sc.lattice.ceiling
    if res.status is ThresholdStatus.NO_RESPONSE:
        tail = res.trials[-CFG.ceiling_confirmations :]
        assert all(t.level_db_hl == sc.lattice.ceiling and not t.responded for t in tail)
        assert res.threshold_db_hl == sc.lattice.ceiling


# ============================================================== 2. criterion correctness


def ascending_counts(res: ThresholdResult) -> tuple[Counter[int], Counter[int]]:
    hits: Counter[int] = Counter()
    trials: Counter[int] = Counter()
    for t in res.trials:
        if t.counted_as_ascending:
            trials[t.level_db_hl] += 1
            hits[t.level_db_hl] += t.responded
    return hits, trials


def meets(hits: int, trials: int) -> bool:
    return hits >= 2 and 2 * hits >= trials


@given(staircase_on_lattice(), st.lists(st.booleans(), max_size=60))
def test_measured_threshold_satisfies_criterion_and_is_lowest(
    sc: HughsonWestlakeStaircase, responses: list[bool]
) -> None:
    res = run_responses(sc, responses)
    hits, trials = ascending_counts(res)
    qualifying = sorted(lv for lv in trials if meets(hits[lv], trials[lv]))
    if res.status is ThresholdStatus.MEASURED:
        assert res.threshold_db_hl == qualifying[0]
        assert res.trials[-1].responded and res.trials[-1].level_db_hl == res.threshold_db_hl
        assert (res.ascending_hits, res.ascending_trials) == (
            hits[res.threshold_db_hl],
            trials[res.threshold_db_hl],
        )
    else:
        # Terminated for another reason: the criterion must never have been met.
        assert qualifying == []


@given(staircase_on_lattice(), st.lists(st.booleans(), max_size=60))
def test_never_terminates_on_trial_count_while_criterion_met(
    sc: HughsonWestlakeStaircase, responses: list[bool]
) -> None:
    """GAP_ANALYSIS #2: a threshold is never produced by the trial-count guard."""
    res = run_responses(sc, responses)
    if res.status is ThresholdStatus.UNRESOLVED:
        assert res.threshold_db_hl is None


# ============================================================== 3. accuracy


@given(
    threshold=grid_thresholds(),
    lattice=lattices(),
    data=st.data(),
)
def test_ideal_observer_converges_exactly(threshold: int, lattice: LevelLattice, data: st.DataObject) -> None:
    start = data.draw(st.sampled_from(lattice.levels), label="start")
    sc = HughsonWestlakeStaircase(Ear.RIGHT, 4000, start, lattice=lattice)
    drive(sc, DeterministicListener({Ear.RIGHT: {4000: threshold}}))
    res = sc.result()
    if threshold > lattice.ceiling:
        assert res.status is ThresholdStatus.NO_RESPONSE
        assert res.threshold_db_hl == lattice.ceiling
    else:
        assert res.status is ThresholdStatus.MEASURED
        assert res.threshold_db_hl == max(threshold, lattice.floor)
        assert res.floor_limited == (threshold <= lattice.floor)
    # An ideal observer needs at most: traverse the lattice once + two short ascents.
    assert res.presentations <= len(lattice.levels) + 6


@given(threshold=continuous_thresholds(), start=st.sampled_from(LevelLattice().levels))
def test_ideal_observer_off_grid_rounds_up(threshold: float, start: int) -> None:
    assume(-10 < threshold <= 90)
    sc = HughsonWestlakeStaircase(Ear.RIGHT, 1000, start)
    drive(sc, DeterministicListener({Ear.RIGHT: {1000: threshold}}))
    res = sc.result()
    assert res.status is ThresholdStatus.MEASURED
    assert res.threshold_db_hl is not None
    assert res.threshold_db_hl == min(lv for lv in sc.lattice.levels if lv >= threshold)


@given(
    threshold=st.floats(min_value=0.0, max_value=80.0, allow_nan=False),
    start=st.sampled_from(range(0, 91, 5)),
    seed=st.integers(min_value=0, max_value=2**32 - 1),
)
def test_steep_psychometric_listener_within_one_step(threshold: float, start: int, seed: int) -> None:
    """Spread 0.5 dB ≈ near-ideal listener with internal noise.

    P(yes) 2.5 dB below T is ~0.7 %; reaching criterion ≥ 10 dB off would require several
    such improbable events, so the bound is effectively deterministic.
    """
    listener = PsychometricListener({Ear.RIGHT: {1000: threshold}}, spread_db=0.5, seed=seed)
    sc = HughsonWestlakeStaircase(Ear.RIGHT, 1000, start)
    drive(sc, listener)
    res = sc.result()
    note(f"trials={[(t.level_db_hl, t.responded) for t in res.trials]}")
    assert res.status is ThresholdStatus.MEASURED
    assert res.threshold_db_hl is not None
    assert -5 - 1e-9 <= res.threshold_db_hl - threshold <= 10


@given(
    threshold=st.floats(min_value=0.0, max_value=80.0, allow_nan=False),
    seed=st.integers(min_value=0, max_value=2**32 - 1),
    spread=st.floats(min_value=0.5, max_value=8.0),
    fa=st.floats(min_value=0.0, max_value=0.3),
    lapse=st.floats(min_value=0.0, max_value=0.3),
)
def test_noisy_listener_always_terminates_with_valid_status(
    threshold: float, seed: int, spread: float, fa: float, lapse: float
) -> None:
    """Shallow slopes, false alarms and lapses: never hangs, never loops, always valid."""
    listener = PsychometricListener(
        {Ear.RIGHT: {1000: threshold}},
        spread_db=spread,
        false_alarm_rate=fa,
        lapse_rate=lapse,
        seed=seed,
    )
    sc = HughsonWestlakeStaircase(Ear.RIGHT, 1000, 40)
    drive(sc, listener, max_steps=CFG.max_presentations + 1)
    res = sc.result()  # pydantic validators re-check status/criterion consistency
    assert res.presentations <= CFG.max_presentations
