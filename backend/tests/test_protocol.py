"""Unit tests for the ASHA 2005 two-ear sequence (spec §6.4)."""

from __future__ import annotations

import pytest

from aurohear.audiometry import (
    FIRST_EAR_SEQUENCE,
    PROTOCOL_VERSION,
    SECOND_EAR_SEQUENCE,
    AudiometryProtocol,
    Ear,
    LevelLattice,
    Phase,
    Presentation,
    SearchRole,
    ThresholdStatus,
    accept_threshold,
)
from aurohear.audiometry.simulation import DeterministicListener, RetestShiftListener, drive

FREQS = (250, 500, 1000, 2000, 3000, 4000, 6000, 8000)


def flat(level: float) -> dict[Ear, dict[int, float]]:
    return {ear: {f: level for f in FREQS} for ear in Ear}


def search_order(log: list[tuple[Presentation, bool]]) -> list[tuple[Ear, str, int, SearchRole]]:
    """Collapse the presentation log into the ordered list of distinct searches."""
    order: list[tuple[Ear, str, int, SearchRole]] = []
    prev_phase_family = None
    for p, _ in log:
        family = "fam" if p.phase is Phase.FAMILIARISATION else "hw"
        key = (p.ear, family, p.frequency_hz, p.test_role)
        if not order or order[-1] != key or family != prev_phase_family:
            order.append(key)
        prev_phase_family = family
    return order


def test_sequences_match_asha_2005() -> None:
    assert [f for f, _ in FIRST_EAR_SEQUENCE] == [1000, 2000, 3000, 4000, 6000, 8000, 1000, 500, 250]
    assert FIRST_EAR_SEQUENCE[6] == (1000, SearchRole.RETEST)
    assert [f for f, _ in SECOND_EAR_SEQUENCE] == [1000, 2000, 3000, 4000, 6000, 8000, 500, 250]
    assert all(role is SearchRole.INITIAL for _, role in SECOND_EAR_SEQUENCE)


@pytest.mark.parametrize(("better", "first"), [(None, Ear.RIGHT), (Ear.RIGHT, Ear.RIGHT), (Ear.LEFT, Ear.LEFT)])
def test_full_presentation_order_one_ear_at_a_time(better: Ear | None, first: Ear) -> None:
    proto = AudiometryProtocol(better_ear=better)
    log = drive(proto, DeterministicListener(flat(15)))
    second = first.opposite

    expected = [(first, "fam", 1000, SearchRole.INITIAL)]
    expected += [(first, "hw", f, r) for f, r in FIRST_EAR_SEQUENCE]
    expected += [(second, "fam", 1000, SearchRole.INITIAL)]
    expected += [(second, "hw", f, r) for f, r in SECOND_EAR_SEQUENCE]
    assert search_order(log) == expected

    # Ears never interleave: once the second ear starts, the first never returns.
    ears = [p.ear for p, _ in log]
    switch = ears.index(second)
    assert set(ears[:switch]) == {first} and set(ears[switch:]) == {second}

    res = proto.result()
    assert res.ear_order == (first, second)
    assert res.protocol_version == PROTOCOL_VERSION


def test_ideal_listener_audiogram_is_exact() -> None:
    audiogram = {
        Ear.RIGHT: {250: 10, 500: 15, 1000: 20, 2000: 30, 3000: 45, 4000: 60, 6000: 75, 8000: 85},
        Ear.LEFT: {250: 0, 500: 5, 1000: 5, 2000: 10, 3000: 20, 4000: 35, 6000: 50, 8000: 70},
    }
    proto = AudiometryProtocol()
    drive(proto, DeterministicListener(audiogram))
    res = proto.result()
    for ear_res in res.ears:
        got = {f: r.threshold_db_hl for f, r in ear_res.audiogram.items()}
        assert got == audiogram[ear_res.ear]
        assert all(r.status is ThresholdStatus.MEASURED for r in ear_res.audiogram.values())
    assert res.ears[0].retest_1k_delta_db == 0
    assert not res.unstable_1k


def test_start_levels_follow_previous_threshold_plus_30() -> None:
    audiogram = flat(10) | {Ear.RIGHT: {**flat(10)[Ear.RIGHT], 2000: 50}}
    proto = AudiometryProtocol()
    drive(proto, DeterministicListener(audiogram))
    right = proto.result().ears[0]
    starts = [(r.frequency_hz, r.trials[0].level_db_hl) for r in right.thresholds]
    fam_level = right.familiarisation.level_db_hl
    assert starts[0] == (1000, fam_level)  # first frequency starts at familiarisation level
    assert starts[1] == (2000, 10 + 30)  # 1000 Hz threshold + 30
    assert starts[2] == (3000, 50 + 30)  # 2000 Hz threshold + 30
    assert starts[3] == (4000, 10 + 30)  # 3000 Hz threshold + 30
    assert starts[6] == (1000, 10 + 30)  # retest starts from the 8000 Hz threshold


def test_start_level_is_clamped_to_profile_cap() -> None:
    lattice = LevelLattice(ceiling=70)
    proto = AudiometryProtocol(lattice=lattice)
    drive(proto, DeterministicListener(flat(60)))
    for ear_res in proto.result().ears:
        for r in ear_res.thresholds:
            assert r.trials[0].level_db_hl <= 70
            assert all(t.level_db_hl <= 70 for t in r.trials)


def test_profound_loss_reports_no_response_everywhere_and_terminates() -> None:
    proto = AudiometryProtocol()
    log = drive(proto, DeterministicListener(flat(120)))
    res = proto.result()
    for ear_res in res.ears:
        assert all(r.status is ThresholdStatus.NO_RESPONSE for r in ear_res.audiogram.values())
        assert all(r.threshold_db_hl == 90 for r in ear_res.audiogram.values())
        assert ear_res.familiarisation.status.value == "no_response"
    # Both 1 kHz searches were NR → consistent, not flagged.
    assert not res.ears[0].unstable_1k
    assert len(log) < 400


# ------------------------------------------------------------------ 1 kHz retest


@pytest.mark.parametrize("shift", [0, 5, -5])
def test_retest_within_5_db_is_stable(shift: int) -> None:
    proto = AudiometryProtocol()
    drive(proto, RetestShiftListener(DeterministicListener(flat(20)), shift_db=shift))
    right = proto.result().ears[0]
    assert right.retest_1k_delta_db == abs(shift)
    assert not right.unstable_1k
    assert [r.test_role for r in right.thresholds].count(SearchRole.VERIFICATION) == 0
    # ASHA: accept the lower (better) of the two.
    assert right.audiogram[1000].threshold_db_hl == min(20, 20 + shift)


@pytest.mark.parametrize("shift", [10, -10, 25])
def test_retest_beyond_5_db_flags_and_inserts_verification(shift: int) -> None:
    proto = AudiometryProtocol()
    log = drive(proto, RetestShiftListener(DeterministicListener(flat(30)), shift_db=shift))
    res = proto.result()
    right = res.ears[0]
    assert right.unstable_1k and res.unstable_1k
    assert right.retest_1k_delta_db == abs(shift)

    seq = [(r.frequency_hz, r.test_role) for r in right.thresholds]
    i = seq.index((1000, SearchRole.RETEST))
    assert seq[i + 1 : i + 3] == [(1000, SearchRole.VERIFICATION), (2000, SearchRole.VERIFICATION)]
    assert seq[i + 3 :] == [(500, SearchRole.INITIAL), (250, SearchRole.INITIAL)]

    # Accepted 1 kHz value is the best of all three searches.
    assert right.audiogram[1000].threshold_db_hl == min(30, 30 + shift)
    # The second ear is never retested at 1 kHz.
    left = res.ears[1]
    assert all(r.test_role is SearchRole.INITIAL for r in left.thresholds)
    assert left.retest_1k_delta_db is None
    assert log[-1][0].ear is Ear.LEFT


def test_accept_threshold_prefers_measured_then_nr() -> None:
    proto = AudiometryProtocol()
    drive(proto, DeterministicListener(flat(40)))
    measured = proto.result().ears[0].audiogram[1000]
    with pytest.raises(ValueError):
        accept_threshold([])
    assert accept_threshold([measured]) is measured


def test_protocol_api_contract() -> None:
    proto = AudiometryProtocol()
    assert proto.current_ear is Ear.RIGHT
    with pytest.raises(RuntimeError):
        proto.result()
    drive(proto, DeterministicListener(flat(0)))
    assert proto.is_complete and proto.current_ear is None
    assert proto.next_presentation() is None
    with pytest.raises(RuntimeError):
        proto.record_response(True)


def test_ear_results_so_far_reports_partial_progress() -> None:
    proto = AudiometryProtocol()
    assert proto.ear_results_so_far() == ()
    listener = DeterministicListener(flat(30))
    # Run until the first ear has finished 1000 + 2000 Hz.
    while True:
        p = proto.next_presentation()
        assert p is not None
        proto.record_response(listener(p))
        partial = proto.ear_results_so_far()
        if partial and len(partial[0].thresholds) == 2:
            break
    (right,) = partial
    assert right.ear is Ear.RIGHT
    assert set(right.audiogram) == {1000, 2000}
    assert all(r.threshold_db_hl == 30 for r in right.audiogram.values())
    # When complete, the partial view equals the final result.
    drive(proto, listener)
    assert proto.ear_results_so_far() == proto.result().ears
