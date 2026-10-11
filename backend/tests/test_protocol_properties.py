"""Property-based tests for the full two-ear ASHA protocol."""

from __future__ import annotations

from hypothesis import given
from hypothesis import strategies as st

from aurohear.audiometry import (
    FIRST_EAR_SEQUENCE,
    AudiometryProtocol,
    Ear,
    LevelLattice,
    SearchRole,
    StaircaseConfig,
    ThresholdStatus,
)
from aurohear.audiometry.familiarisation import FamiliarisationConfig
from aurohear.audiometry.simulation import (
    DeterministicListener,
    PsychometricListener,
    RetestShiftListener,
    drive,
)
from strategies import TEST_FREQUENCIES, grid_audiograms, lattices

# Upper bound on presentations for a whole session: 2 familiarisations + 9 + 8 searches
# + 2 possible verification searches, each at its own hard limit.
SESSION_BOUND = 2 * FamiliarisationConfig().max_presentations + (9 + 8 + 2) * StaircaseConfig().max_presentations


@given(audiogram=grid_audiograms(), lattice=lattices(), better=st.sampled_from([None, *Ear]))
def test_ideal_listener_full_session_is_exact(
    audiogram: dict[Ear, dict[int, float]], lattice: LevelLattice, better: Ear | None
) -> None:
    proto = AudiometryProtocol(better_ear=better, lattice=lattice)
    log = drive(proto, DeterministicListener(audiogram), max_steps=SESSION_BOUND + 1)
    res = proto.result()

    assert res.ear_order[0] is (better or Ear.RIGHT)
    assert set(res.ear_order) == set(Ear)
    for ear_res in res.ears:
        assert set(ear_res.audiogram) == set(TEST_FREQUENCIES)
        for f, r in ear_res.audiogram.items():
            truth = audiogram[ear_res.ear][f]
            if truth > lattice.ceiling:
                assert r.status is ThresholdStatus.NO_RESPONSE
                assert r.threshold_db_hl == lattice.ceiling
            else:
                assert r.status is ThresholdStatus.MEASURED
                assert r.threshold_db_hl == max(truth, lattice.floor)
    # Consistent listener → 1 kHz retest is never flagged.
    assert not res.unstable_1k
    assert len(log) <= SESSION_BOUND


@given(audiogram=grid_audiograms(), better=st.sampled_from([None, *Ear]))
def test_one_ear_completed_before_the_other(
    audiogram: dict[Ear, dict[int, float]], better: Ear | None
) -> None:
    proto = AudiometryProtocol(better_ear=better)
    log = drive(proto, DeterministicListener(audiogram), max_steps=SESSION_BOUND + 1)
    ears = [p.ear for p, _ in log]
    switches = sum(a is not b for a, b in zip(ears, ears[1:]))
    assert switches == 1
    assert ears[0] is (better or Ear.RIGHT)


@given(audiogram=grid_audiograms())
def test_first_ear_frequency_order_is_asha(audiogram: dict[Ear, dict[int, float]]) -> None:
    proto = AudiometryProtocol()
    drive(proto, DeterministicListener(audiogram), max_steps=SESSION_BOUND + 1)
    first = proto.result().ears[0]
    order = [(r.frequency_hz, r.test_role) for r in first.thresholds]
    assert order == list(FIRST_EAR_SEQUENCE)


@given(
    audiogram=grid_audiograms(),
    shift=st.sampled_from(range(-30, 31, 5)),
)
def test_retest_flag_iff_delta_exceeds_5_db(audiogram: dict[Ear, dict[int, float]], shift: int) -> None:
    proto = AudiometryProtocol()
    listener = RetestShiftListener(DeterministicListener(audiogram), shift_db=shift)
    drive(proto, listener, max_steps=SESSION_BOUND + 1)
    first = proto.result().ears[0]
    initial = next(r for r in first.thresholds if r.frequency_hz == 1000 and r.test_role is SearchRole.INITIAL)
    retest = next(r for r in first.thresholds if r.test_role is SearchRole.RETEST)
    if initial.status is retest.status is ThresholdStatus.MEASURED:
        assert initial.threshold_db_hl is not None and retest.threshold_db_hl is not None
        delta = abs(retest.threshold_db_hl - initial.threshold_db_hl)
        assert first.retest_1k_delta_db == delta
        assert first.unstable_1k == (delta > 5)
    n_verification = sum(r.test_role is SearchRole.VERIFICATION for r in first.thresholds)
    assert n_verification == (2 if first.unstable_1k else 0)


@given(
    audiogram=st.fixed_dictionaries(
        {ear: st.fixed_dictionaries({f: st.floats(-5, 85) for f in TEST_FREQUENCIES}) for ear in Ear}
    ),
    seed=st.integers(0, 2**32 - 1),
    spread=st.floats(0.5, 6.0),
    fa=st.floats(0.0, 0.25),
    lapse=st.floats(0.0, 0.25),
)
def test_noisy_listener_session_always_terminates(
    audiogram: dict[Ear, dict[int, float]], seed: int, spread: float, fa: float, lapse: float
) -> None:
    """No hang, no loop: bounded session length whatever the listener does."""
    listener = PsychometricListener(
        audiogram, spread_db=spread, false_alarm_rate=fa, lapse_rate=lapse, seed=seed
    )
    proto = AudiometryProtocol()
    log = drive(proto, listener, max_steps=SESSION_BOUND + 1)
    assert proto.is_complete
    assert len(log) <= SESSION_BOUND
    res = proto.result()
    assert all(set(e.audiogram) == set(TEST_FREQUENCIES) for e in res.ears)
