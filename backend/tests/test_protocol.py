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

FREQS = (250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000)


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


# ====================================================================== Prompt 2
# Inter-octaves (spec §6.4), QC probes (§6.3), per-frequency ceilings (§3.4).

from hypothesis import given, settings  # noqa: E402
from hypothesis import strategies as st  # noqa: E402

from aurohear.audiometry import FrequencyLattices, Phase, QcProbe, inter_octaves_needed  # noqa: E402
from aurohear.audiometry.levels import floor_to_grid  # noqa: E402
from strategies import grid_audiograms  # noqa: E402


def with_levels(base: float, **overrides: float) -> dict[Ear, dict[int, float]]:
    """flat(base) with per-frequency overrides like right_500=30 or both_1000=10."""
    aud = flat(base)
    for key, v in overrides.items():
        ear, f = key.split("_")
        for e in (Ear.RIGHT, Ear.LEFT) if ear == "both" else (Ear(ear),):
            aud[e][int(f)] = v
    return aud


def searched(ear_res, phase_filter=None) -> list[int]:  # type: ignore[no-untyped-def]
    return [r.frequency_hz for r in ear_res.thresholds]


# ---------------------------------------------------------------- inter-octaves


@pytest.mark.parametrize(
    ("t500", "t1000", "t2000", "expected"),
    [
        (10, 10, 10, []),
        (25, 10, 10, []),  # 15 dB: below the rule
        (30, 10, 10, [750]),  # exactly 20 dB fires
        (10, 30, 10, [750, 1500]),
        (10, 10, 30, [1500]),
        (60, 10, 60, [750, 1500]),
    ],
)
def test_inter_octave_rule_triggers(t500: int, t1000: int, t2000: int, expected: list[int]) -> None:
    proto = AudiometryProtocol()
    drive(proto, DeterministicListener(with_levels(10, both_500=t500, both_1000=t1000, both_2000=t2000)))
    for ear_res in proto.result().ears:
        freqs = searched(ear_res)
        inserted = [f for f in freqs if f in (750, 1500)]
        assert inserted == expected
        assert all(ear_res.audiogram[f].is_interoctave for f in inserted)
        assert not any(r.is_interoctave for r in ear_res.thresholds if r.frequency_hz not in (750, 1500))
        # Inter-octaves come after every octave of that ear (after 250 Hz).
        if inserted:
            assert freqs.index(inserted[0]) > freqs.index(250)


def test_inter_octaves_are_per_ear_and_before_the_ear_switch() -> None:
    aud = with_levels(10, right_500=40)  # only the right ear triggers 750
    proto = AudiometryProtocol()
    log = drive(proto, DeterministicListener(aud))
    right, left = proto.result().ears
    assert 750 in right.audiogram and 750 not in left.audiogram
    ears = [p.ear for p, _ in log]
    last_right = max(i for i, e in enumerate(ears) if e is Ear.RIGHT)
    last_750 = max(i for i, (p, _) in enumerate(log) if p.frequency_hz == 750)
    assert last_750 <= last_right  # tested before switching ears
    assert aud[Ear.RIGHT][750] == right.audiogram[750].threshold_db_hl


def test_inter_octave_uses_the_accepted_1k_value_not_the_retest() -> None:
    # Initial 1 kHz = 10, retest reads 30 (unstable → verification also 30); accepted = 10.
    aud = with_levels(10, both_500=30)
    proto = AudiometryProtocol()
    drive(proto, RetestShiftListener(DeterministicListener(aud), shift_db=20))
    right = proto.result().ears[0]
    assert right.audiogram[1000].threshold_db_hl == 10
    assert 750 in right.audiogram  # |30 − 10| = 20 fires; |30 − 30| would not


def test_no_response_counts_at_the_ceiling_for_the_rule() -> None:
    aud = with_levels(10, both_500=200, both_1000=60, both_2000=60)
    proto = AudiometryProtocol()
    drive(proto, DeterministicListener(aud))
    right = proto.result().ears[0]
    assert right.audiogram[500].status is ThresholdStatus.NO_RESPONSE
    assert 750 in right.audiogram  # 90 (NR at cap) vs 60


def test_unresolved_threshold_cannot_trigger_an_inter_octave() -> None:
    proto = AudiometryProtocol()
    drive(proto, DeterministicListener(with_levels(10, both_500=40)))
    aud = dict(proto.result().ears[0].audiogram)
    assert inter_octaves_needed({f: r for f, r in aud.items() if f != 750}) == [750]
    unresolved = aud[500].model_copy(update={"status": ThresholdStatus.UNRESOLVED, "threshold_db_hl": None})
    assert inter_octaves_needed({**aud, 500: unresolved}) == []
    assert inter_octaves_needed({}) == []


def test_inter_octaves_can_be_disabled() -> None:
    proto = AudiometryProtocol(inter_octaves=False)
    drive(proto, DeterministicListener(with_levels(10, both_500=60)))
    assert all(750 not in e.audiogram for e in proto.result().ears)


# ---------------------------------------------------------------- QC probes


def test_every_measured_search_is_followed_by_probes_at_t_and_t_plus_5() -> None:
    proto = AudiometryProtocol()
    log = drive(proto, DeterministicListener(flat(25)))
    probes = [(p.ear, p.frequency_hz, p.test_role, p.level_db_hl) for p, _ in log if p.phase is Phase.QC_PROBE]
    results = [r for e in proto.result().ears for r in e.thresholds]
    assert len(probes) == 2 * len(results)
    for i, r in enumerate(results):
        assert probes[2 * i] == (r.ear, r.frequency_hz, r.test_role, 25)
        assert probes[2 * i + 1] == (r.ear, r.frequency_hz, r.test_role, 30)
        assert r.qc_probe_at_threshold_heard is True and r.qc_probe_plus5_heard is True
        assert r.qc_probe_pass is True
    # Each probe pair immediately follows its search and precedes the next one.
    phases = [p.phase for p, _ in log]
    for i in range(1, len(phases)):
        if phases[i] is Phase.QC_PROBE and phases[i - 1] is not Phase.QC_PROBE:
            assert phases[i + 1] is Phase.QC_PROBE


def test_missed_plus5_probe_is_a_qc_failure_and_never_changes_the_threshold() -> None:
    base = DeterministicListener(flat(25))

    def unreliable(p):  # type: ignore[no-untyped-def]
        if p.phase is Phase.QC_PROBE and p.level_db_hl == 30:
            return False  # misses the +5 dB probe
        return base(p)

    proto = AudiometryProtocol()
    drive(proto, unreliable)
    for e in proto.result().ears:
        for r in e.thresholds:
            assert r.threshold_db_hl == 25
            assert r.qc_probe_plus5_heard is False and r.qc_probe_pass is False
            assert r.qc_probe_at_threshold_heard is True


def test_no_probe_after_no_response_and_single_probe_at_the_cap() -> None:
    proto = AudiometryProtocol()
    drive(proto, DeterministicListener(with_levels(20, both_8000=200, both_6000=90)))
    right = proto.result().ears[0]
    nr = right.audiogram[8000]
    assert nr.status is ThresholdStatus.NO_RESPONSE
    assert nr.qc_probe_at_threshold_heard is None and nr.qc_probe_pass is None
    at_cap = right.audiogram[6000]
    assert at_cap.threshold_db_hl == 90
    assert at_cap.qc_probe_at_threshold_heard is True
    assert at_cap.qc_probe_plus5_heard is None  # 95 dB HL is above the cap: not presented


def test_probes_off_gives_identical_thresholds() -> None:
    aud = AUDIOGRAMS_FOR_PROBE_EQUIVALENCE = with_levels(15, both_500=40, both_4000=55)  # noqa: N806
    on, off = AudiometryProtocol(), AudiometryProtocol(qc_probes=False)
    drive(on, DeterministicListener(aud))
    log_off = drive(off, DeterministicListener(aud))
    assert not any(p.phase is Phase.QC_PROBE for p, _ in log_off)
    for a, b in zip(on.result().ears, off.result().ears, strict=True):
        assert {f: r.threshold_db_hl for f, r in a.audiogram.items()} == {f: r.threshold_db_hl for f, r in b.audiogram.items()}
    del AUDIOGRAMS_FOR_PROBE_EQUIVALENCE


def test_qc_probe_unit_contract() -> None:
    proto = AudiometryProtocol(qc_probes=False)
    drive(proto, DeterministicListener(flat(30)))
    measured = proto.result().ears[0].audiogram[1000]
    probe = QcProbe(measured, LevelLattice())
    p1 = probe.next_presentation()
    assert p1 is not None and p1.phase is Phase.QC_PROBE and p1.level_db_hl == 30
    probe.record_response(True)
    probe.record_response(False)
    assert probe.is_complete and probe.next_presentation() is None
    assert probe.apply().qc_probe_pass is False
    with pytest.raises(RuntimeError):
        probe.record_response(True)
    nr = measured.model_copy(update={"status": ThresholdStatus.NO_RESPONSE})
    with pytest.raises(ValueError):
        QcProbe(nr, LevelLattice())


# ---------------------------------------------------------------- per-frequency ceilings


def test_floor_to_grid_never_rounds_a_cap_up() -> None:
    assert [floor_to_grid(x) for x in (84, 84.9, 85, 89.99, 90, -7)] == [80, 80, 85, 85, 90, -10]


def test_frequency_lattices() -> None:
    fl = FrequencyLattices(caps_db_hl={8000: 84, 250: 70.5, 1000: 120})
    assert fl.for_frequency(8000).ceiling == 80
    assert fl.for_frequency(250).ceiling == 70
    assert fl.for_frequency(1000).ceiling == 90  # never above the global 90 dB HL cap
    assert fl.for_frequency(2000).ceiling == 90
    with pytest.raises(ValueError):
        FrequencyLattices(caps_db_hl={4000: -10})
    with pytest.raises(ValueError):
        FrequencyLattices(caps_db_hl={4000: float("nan")})


def test_per_frequency_cap_is_never_exceeded_and_nr_is_at_that_cap() -> None:
    caps = {8000: 84, 250: 70}
    proto = AudiometryProtocol(frequency_caps_db_hl=caps)
    log = drive(proto, DeterministicListener(with_levels(30, both_8000=85, both_250=60, both_4000=88)))
    assert max(p.level_db_hl for p, _ in log if p.frequency_hz == 8000) == 80
    assert max(p.level_db_hl for p, _ in log if p.frequency_hz == 250) <= 70
    # An uncapped frequency still reaches the global 90 dB HL when the listener needs it.
    assert max(p.level_db_hl for p, _ in log if p.frequency_hz == 4000) == 90
    assert proto.result().ears[0].audiogram[4000].threshold_db_hl == 90
    for e in proto.result().ears:
        assert e.audiogram[8000].status is ThresholdStatus.NO_RESPONSE
        assert e.audiogram[8000].threshold_db_hl == 80
        assert e.audiogram[250].threshold_db_hl == 60  # measurable below its cap


def test_familiarisation_respects_the_1k_cap() -> None:
    proto = AudiometryProtocol(frequency_caps_db_hl={1000: 35})
    log = drive(proto, DeterministicListener(flat(120)))
    assert max(p.level_db_hl for p, _ in log if p.frequency_hz == 1000) == 35


caps_strategy = st.dictionaries(
    st.sampled_from([250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000]),
    st.floats(min_value=-4.9, max_value=110, allow_nan=False),
    max_size=6,
)


@settings(max_examples=60, deadline=None)
@given(audiogram=grid_audiograms(), caps=caps_strategy)
def test_property_caps_inter_octaves_and_probes(audiogram, caps) -> None:  # type: ignore[no-untyped-def]
    proto = AudiometryProtocol(frequency_caps_db_hl=caps)
    log = drive(proto, DeterministicListener(audiogram), max_steps=5000)
    lat = proto.lattices
    # 1. No presentation ever exceeds its frequency's (floored) ceiling.
    for p, _ in log:
        assert p.level_db_hl <= lat.for_frequency(p.frequency_hz).ceiling
    for e in proto.result().ears:
        octave_audiogram = {f: r for f, r in e.audiogram.items() if f not in (750, 1500)}
        # 2. Inter-octaves present exactly when the rule fires on the accepted values.
        assert sorted(f for f in e.audiogram if f in (750, 1500)) == inter_octaves_needed(octave_audiogram)
        for f, r in e.audiogram.items():
            ceiling = lat.for_frequency(f).ceiling
            truth = audiogram[e.ear][f]
            # 3. Ideal listener: exact below the cap, no-response at the cap above it.
            if truth > ceiling:
                assert r.status is ThresholdStatus.NO_RESPONSE and r.threshold_db_hl == ceiling
            else:
                assert r.threshold_db_hl == max(truth, -10)
                # 4. Probes: heard at T; +5 heard unless above the cap.
                assert r.qc_probe_at_threshold_heard is True
                assert r.qc_probe_plus5_heard is (True if r.threshold_db_hl + 5 <= ceiling else None)
