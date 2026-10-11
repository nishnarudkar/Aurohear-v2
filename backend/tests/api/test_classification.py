"""Classification and likelihood model (spec §9, §1.3) — unit, property and API tests."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from hypothesis import given
from hypothesis import strategies as st

from aurohear.services.classification import (
    BsaDescriptor,
    CalibrationTier,
    Confidence,
    IntakeInputs,
    LikelihoodBand,
    QcComposite,
    QcInputs,
    REFERRAL_RANK,
    Referral,
    ThresholdPoint,
    WhoGrade,
    band_for,
    bsa_descriptor,
    classify,
    p_hearing_loss,
    shadow_interaural_db,
    summarise_ear,
    who_grade,
)
from client_sim import SimClient, threshold_listener

FREQS = (250, 500, 1000, 2000, 3000, 4000, 6000, 8000)
GOOD_QC = QcInputs(
    false_positive_rate=0.0, protocol_complete=True, unstable_1k=False,
    unresolved_thresholds=0, discarded_trials=0, tone_trials=150,
)


def audiogram(right: dict[int, int] | int, left: dict[int, int] | int | None = None, **status: str) -> list[ThresholdPoint]:
    """Build accepted points. `status` maps 'right_4000'→'no_response'/'unresolved'/'shadow'."""
    left = right if left is None else left
    pts = []
    for ear, levels in (("right", right), ("left", left)):
        for f in FREQS:
            v = levels if isinstance(levels, int) else levels.get(f, 0)
            s = status.get(f"{ear}_{f}", "measured")
            pts.append(ThresholdPoint(
                ear=ear, frequency_hz=f,
                status="measured" if s == "shadow" else s,
                threshold_db_hl=None if s == "unresolved" else v,
                possible_shadow=s == "shadow",
            ))
    return pts


# ============================================================== §9.1 deterministic


@pytest.mark.parametrize(
    ("pta", "grade"),
    [
        (-10, WhoGrade.NORMAL), (19.99, WhoGrade.NORMAL), (20, WhoGrade.MILD), (34.99, WhoGrade.MILD),
        (35, WhoGrade.MODERATE), (49.99, WhoGrade.MODERATE), (50, WhoGrade.MODERATELY_SEVERE),
        (64.99, WhoGrade.MODERATELY_SEVERE), (65, WhoGrade.SEVERE), (79.99, WhoGrade.SEVERE),
        (80, WhoGrade.PROFOUND), (94.99, WhoGrade.PROFOUND), (95, WhoGrade.COMPLETE), (120, WhoGrade.COMPLETE),
    ],
)
def test_who_2021_grade_boundaries(pta: float, grade: WhoGrade) -> None:
    assert who_grade(pta) is grade


@pytest.mark.parametrize(
    ("avg", "desc"),
    [
        (0, BsaDescriptor.NONE), (20, BsaDescriptor.NONE), (21, BsaDescriptor.MILD), (40, BsaDescriptor.MILD),
        (41, BsaDescriptor.MODERATE), (70, BsaDescriptor.MODERATE), (71, BsaDescriptor.SEVERE),
        (95, BsaDescriptor.SEVERE), (96, BsaDescriptor.PROFOUND), (130, BsaDescriptor.PROFOUND),
    ],
)
def test_bsa_2018_descriptor_boundaries(avg: float, desc: BsaDescriptor) -> None:
    assert bsa_descriptor(avg) is desc


def test_pta4_and_bsa_use_their_own_frequency_sets() -> None:
    pts = audiogram({250: 50, 500: 10, 1000: 20, 2000: 30, 4000: 40, 3000: 99, 6000: 99, 8000: 99})
    s = summarise_ear("right", pts)
    assert s.pta4.value_db_hl == 25.0  # (10+20+30+40)/4 — 250/3k/6k/8k ignored
    assert s.pta4.frequencies_used == (500, 1000, 2000, 4000)
    assert s.bsa_avg5.value_db_hl == 30.0  # (50+10+20+30+40)/5
    assert s.bsa_descriptor is BsaDescriptor.MILD


def test_no_response_is_130_in_bsa_average_and_ceiling_in_pta4() -> None:
    pts = audiogram(20, right_4000="no_response")
    pts = [p if not (p.ear == "right" and p.frequency_hz == 4000) else ThresholdPoint("right", 4000, "no_response", 90) for p in pts]
    s = summarise_ear("right", pts)
    assert s.bsa_avg5.value_db_hl == (20 * 4 + 130) / 5
    assert s.pta4.value_db_hl == (20 * 3 + 90) / 4
    assert s.pta4.includes_no_response and s.bsa_avg5.includes_no_response


def test_unresolved_and_shadow_points_are_excluded_and_flag_partial() -> None:
    pts = audiogram(20, right_1000="unresolved", right_2000="shadow")
    s = summarise_ear("right", pts)
    assert s.pta4.frequencies_used == (500, 4000)
    assert s.pta4.partial
    assert s.pta4.value_db_hl == 20.0


def test_better_ear_is_the_lower_pta4() -> None:
    c = classify(audiogram(10, 30), GOOD_QC, CalibrationTier.B)
    assert c.better_ear == "right" and c.pta4_better == 10.0
    assert c.pta4_left == 30.0


# ============================================================== §9.2 probabilistic


@pytest.mark.parametrize(
    ("pta", "p", "band"),
    [  # spec §9.2 worked examples, Tier C (σ 7.6, bias +1.4)
        (8, 0.08, LikelihoodBand.LOW),
        (15, 0.32, LikelihoodBand.MEDIUM),
        (20, 0.57, LikelihoodBand.MEDIUM),
        (28, 0.89, LikelihoodBand.HIGH),
    ],
)
def test_spec_worked_examples_tier_c(pta: float, p: float, band: LikelihoodBand) -> None:
    got = p_hearing_loss(pta, CalibrationTier.C)
    assert round(got, 2) == p
    assert band_for(got) is band


def test_spec_worked_example_45_db_is_above_099() -> None:
    assert p_hearing_loss(45, CalibrationTier.C) > 0.99


def test_tier_constants_are_the_spec_defaults() -> None:
    for tier, sigma, bias in [("A", 4.5, 0.0), ("B", 5.4, 1.5), ("C", 7.6, 1.4)]:
        c = classify(audiogram(10), GOOD_QC, CalibrationTier(tier))
        assert (c.sigma_pta_db, c.bias_correction_db) == (sigma, bias)
    a = classify(audiogram(10), GOOD_QC, CalibrationTier.A)
    assert any("Tier A bias" in n for n in a.annotations)


@pytest.mark.parametrize(("p", "band"), [(0.2499, LikelihoodBand.LOW), (0.25, LikelihoodBand.MEDIUM), (0.75, LikelihoodBand.MEDIUM), (0.7501, LikelihoodBand.HIGH)])
def test_band_cut_points_are_inclusive_medium(p: float, band: LikelihoodBand) -> None:
    assert band_for(p) is band


tiers = st.sampled_from(list(CalibrationTier))
ptas = st.floats(min_value=-10, max_value=120, allow_nan=False)


@given(a=ptas, b=ptas, tier=tiers)
def test_property_probability_is_monotone_and_bounded(a: float, b: float, tier: CalibrationTier) -> None:
    lo, hi = sorted((a, b))
    assert 0.0 <= p_hearing_loss(lo, tier) <= p_hearing_loss(hi, tier) <= 1.0


@given(tier=tiers)
def test_property_p_is_half_at_the_bias_adjusted_who_cutoff(tier: CalibrationTier) -> None:
    from aurohear.services.classification import TIER_MODELS

    assert p_hearing_loss(20 - TIER_MODELS[tier].bias_correction_db, tier) == pytest.approx(0.5)


@given(pta=ptas)
def test_property_better_calibration_gives_a_more_decisive_probability(pta: float) -> None:
    """Spec §9.2: bands narrow at Tier A and widen at Tier C.

    Tier A's smaller σ makes its z-score at least as large as Tier C's, EXCEPT in the
    band between the two tiers' bias-adjusted cut-offs: Tier C adds +1.4 dB (cut-off
    at PTA 18.6) and Tier A adds 0 (cut-off at 20), so for 18.6 < PTA < ~22.03 Tier C
    can be the more decisive one. Crossover: (x−20)/4.5 = (x−18.6)/7.6 → x = 68.3/3.1.
    """
    from aurohear.services.classification import TIER_MODELS

    def z(tier: CalibrationTier) -> float:
        m = TIER_MODELS[tier]
        return abs((pta + m.bias_correction_db - 20) / m.sigma_pta_db)

    crossover = 68.3 / 3.1
    if pta <= 18.6 or pta >= crossover + 1e-9:
        assert z(CalibrationTier.A) >= z(CalibrationTier.C) - 1e-12


def test_tier_decisiveness_crossover_is_where_the_math_says() -> None:
    from aurohear.services.classification import TIER_MODELS

    def z(p: float, t: CalibrationTier) -> float:
        m = TIER_MODELS[t]
        return abs((p + m.bias_correction_db - 20) / m.sigma_pta_db)

    assert z(22.0, CalibrationTier.A) < z(22.0, CalibrationTier.C)
    assert z(22.05, CalibrationTier.A) > z(22.05, CalibrationTier.C)


@given(a=ptas, b=ptas)
def test_property_who_grade_is_monotone(a: float, b: float) -> None:
    order = list(WhoGrade)
    lo, hi = sorted((a, b))
    assert order.index(who_grade(lo)) <= order.index(who_grade(hi))


# ============================================================== overrides (§9.2 Step 4, §1.3)


def test_asymmetry_pta_15_db_forces_high_and_referral() -> None:
    c = classify(audiogram(0, 15), GOOD_QC, CalibrationTier.B)
    assert c.computed_band is LikelihoodBand.LOW
    assert c.band is LikelihoodBand.HIGH
    assert c.referral is Referral.AUDIOLOGIST
    assert "asymmetry_pta" in {o.code for o in c.overrides_applied}
    assert c.asymmetry_db == 15.0
    assert "two ears" in c.statement and "above the 20 dB HL" not in c.statement


def test_asymmetry_14_db_is_not_flagged() -> None:
    left = {f: 15 for f in FREQS} | {500: 10}  # PTA4 diff = 13.75 dB
    c = classify(audiogram(0, left), GOOD_QC, CalibrationTier.B)
    assert "asymmetry_pta" not in {o.code for o in c.overrides_applied}


def test_asymmetry_at_two_adjacent_frequencies_forces_high() -> None:
    left = {f: 0 for f in FREQS} | {6000: 25, 8000: 25}  # PTA4 identical; 6k & 8k differ by 25
    c = classify(audiogram(0, left), GOOD_QC, CalibrationTier.B)
    codes = {o.code for o in c.overrides_applied}
    assert "asymmetry_adjacent" in codes and "asymmetry_pta" not in codes
    assert c.band is LikelihoodBand.HIGH
    single = classify(audiogram(0, {f: 0 for f in FREQS} | {6000: 25}), GOOD_QC, CalibrationTier.B)
    assert "asymmetry_adjacent" not in {o.code for o in single.overrides_applied}  # one frequency is not enough


def test_any_no_response_forces_high_and_referral() -> None:
    c = classify(audiogram(5, right_8000="no_response"), GOOD_QC, CalibrationTier.B)
    assert c.band is LikelihoodBand.HIGH and c.referral is Referral.AUDIOLOGIST
    assert "no_response" in {o.code for o in c.overrides_applied}


def test_possible_shadow_forces_referral_and_leaves_pta() -> None:
    c = classify(audiogram(0, {f: 0 for f in FREQS} | {4000: 45}, left_4000="shadow"), GOOD_QC, CalibrationTier.B)
    assert c.referral is Referral.AUDIOLOGIST
    assert c.ears[1].pta4.frequencies_used == (500, 1000, 2000)
    assert "audiologist" in c.statement


def test_shadow_criterion_is_55_db_for_insert_earphones() -> None:
    assert shadow_interaural_db("insert") == 55
    assert shadow_interaural_db("circumaural") == shadow_interaural_db("supra_aural") == shadow_interaural_db(None) == 40


def test_poor_qc_suppresses_band_and_probability() -> None:
    qc = QcInputs(0.25, True, False, 0, 0, 150)
    c = classify(audiogram(30), qc, CalibrationTier.B)
    assert c.qc_composite is QcComposite.POOR
    assert c.band is LikelihoodBand.INDETERMINATE
    assert c.p_hearing_loss is None
    assert c.computed_band is LikelihoodBand.HIGH  # still recorded for research
    assert c.referral is Referral.RETEST_REQUIRED
    assert "Indeterminate — retest required" in next(o.reason for o in c.overrides_applied if o.code == "qc_poor")


def test_fp_rate_exactly_20_percent_is_not_poor() -> None:
    c = classify(audiogram(10), QcInputs(0.20, True, False, 0, 0, 150), CalibrationTier.B)
    assert c.qc_composite is QcComposite.FAIR


def test_poor_qc_never_downgrades_a_clinical_referral() -> None:
    c = classify(audiogram(5, right_8000="no_response"), QcInputs(0.5, True, False, 0, 0, 150), CalibrationTier.B)
    assert c.band is LikelihoodBand.INDETERMINATE
    assert c.referral is Referral.AUDIOLOGIST  # NR still refers despite poor QC


def test_unstable_1k_downgrades_confidence_one_level() -> None:
    ok = classify(audiogram(10), GOOD_QC, CalibrationTier.B)
    unstable = classify(audiogram(10), QcInputs(0.0, True, True, 0, 0, 150), CalibrationTier.B)
    assert ok.confidence is Confidence.HIGH and unstable.confidence is Confidence.MODERATE
    assert unstable.band == ok.band


def test_red_flag_overrides_everything_and_hides_probability() -> None:
    c = classify(audiogram(10), GOOD_QC, CalibrationTier.B, IntakeInputs(red_flags=("sudden_onset",)))
    assert c.referral is Referral.URGENT_ENT
    assert c.band is None and c.p_hearing_loss is None


def test_referral_routing_by_band() -> None:
    assert classify(audiogram(0), GOOD_QC, CalibrationTier.B).referral is Referral.ROUTINE_RETEST
    assert classify(audiogram(17), GOOD_QC, CalibrationTier.B).referral is Referral.REPEAT_THEN_REFER
    assert classify(audiogram(30), GOOD_QC, CalibrationTier.B).referral is Referral.AUDIOLOGIST
    noisy = classify(audiogram(0), GOOD_QC, CalibrationTier.B, IntakeInputs(reports_difficulty_in_noise=True))
    assert noisy.referral is Referral.SPEECH_IN_NOISE_TEST
    tts = classify(audiogram(0), GOOD_QC, CalibrationTier.B, IntakeInputs(recent_noise_exposure_24h=True))
    assert tts.referral is Referral.RETEST_AFTER_NOISE_FREE_INTERVAL


def test_statement_never_states_a_diagnosis() -> None:
    for lvl in (0, 17, 30, 60):
        s = classify(audiogram(lvl), GOOD_QC, CalibrationTier.C).statement
        assert "you have hearing loss" not in s.lower()
        assert "not a diagnosis" in s and "self-calibrated" in s


levels = st.sampled_from(range(-10, 91, 5))
statuses = st.sampled_from(["measured"] * 6 + ["no_response", "unresolved", "shadow"])


@st.composite
def random_audiograms(draw: st.DrawFn) -> list[ThresholdPoint]:
    pts = []
    for ear in ("right", "left"):
        for f in FREQS:
            s = draw(statuses)
            v = draw(levels)
            pts.append(ThresholdPoint(ear, f, "measured" if s == "shadow" else s, None if s == "unresolved" else v, s == "shadow"))
    return pts


qcs = st.builds(
    QcInputs,
    false_positive_rate=st.one_of(st.none(), st.floats(0, 1)),
    protocol_complete=st.booleans(),
    unstable_1k=st.booleans(),
    unresolved_thresholds=st.integers(0, 4),
    discarded_trials=st.integers(0, 30),
    tone_trials=st.integers(0, 200),
)


@given(pts=random_audiograms(), qc=qcs, tier=tiers)
def test_property_invariants_for_any_audiogram(pts: list[ThresholdPoint], qc: QcInputs, tier: CalibrationTier) -> None:
    c = classify(pts, qc, tier)
    # Better ear is the minimum PTA4.
    present = [v for v in (c.pta4_right, c.pta4_left) if v is not None]
    if present:
        assert c.pta4_better == min(present)
    # A probability is shown only alongside a computed band.
    if c.p_hearing_loss is not None:
        assert c.band in (LikelihoodBand.LOW, LikelihoodBand.MEDIUM, LikelihoodBand.HIGH)
        assert 0 <= c.p_hearing_loss <= 1
    # Overrides only ever raise the band (or suppress it), never lower it.
    order = {LikelihoodBand.LOW: 0, LikelihoodBand.MEDIUM: 1, LikelihoodBand.HIGH: 2}
    if c.band in order and c.computed_band in order:
        assert order[c.band] >= order[c.computed_band]  # type: ignore[index]
    # Mandatory clinical overrides always refer, whatever the QC.
    codes = {o.code for o in c.overrides_applied}
    if codes & {"asymmetry_pta", "asymmetry_adjacent", "no_response", "possible_shadow"}:
        assert REFERRAL_RANK[c.referral] >= REFERRAL_RANK[Referral.AUDIOLOGIST]
    if c.qc_composite is QcComposite.POOR:
        assert c.band is LikelihoodBand.INDETERMINATE and c.p_hearing_loss is None
    assert "you have hearing loss" not in c.statement.lower()


@given(pts=random_audiograms(), tier=tiers)
def test_property_adding_a_no_response_never_lowers_the_referral(pts: list[ThresholdPoint], tier: CalibrationTier) -> None:
    before = classify(pts, GOOD_QC, tier)
    worse = [*pts[:-1], ThresholdPoint(pts[-1].ear, pts[-1].frequency_hz, "no_response", 90)]
    after = classify(worse, GOOD_QC, tier)
    assert REFERRAL_RANK[after.referral] >= REFERRAL_RANK[Referral.AUDIOLOGIST]
    assert REFERRAL_RANK[after.referral] >= REFERRAL_RANK[before.referral]


# ============================================================== API wiring


def flat(level: int) -> dict[str, dict[int, int]]:
    return {e: {f: level for f in FREQS} for e in ("right", "left")}


def run(client: TestClient, aud: dict[str, dict[int, int]], **session: Any) -> dict[str, Any]:
    sim = SimClient.start(client, **session)
    sim.run(threshold_listener(aud))
    res = sim.finalize()
    got = client.get(f"/api/v1/sessions/{sim.session_id}/results").json()
    assert got["classification"] == res["classification"]  # stored, not recomputed differently
    return res["classification"]


def test_api_normal_hearing_tier_c_is_low(client: TestClient) -> None:
    calib = {"tier": "C", "method": "biological_1k", "profile_version": "t"}
    c = run(client, flat(0), calibration=calib)
    assert c["who_grade_better_ear"] == "normal"
    assert c["bsa_descriptor_right"] == "none"
    assert c["band"] == "low" and c["referral"] == "routine_retest"
    assert c["p_hearing_loss"] == pytest.approx(p_hearing_loss(0, CalibrationTier.C))
    assert c["model_version"].startswith("aurohear-classification")


def test_api_mild_loss_tier_b_is_high(client: TestClient) -> None:
    c = run(client, flat(30))
    assert c["pta4_better"] == 30.0
    assert c["who_grade_better_ear"] == "mild" and c["bsa_descriptor_left"] == "mild"
    assert c["band"] == "high" and c["referral"] == "audiologist"
    assert c["statement"].startswith("Higher likelihood of hearing loss.")


def test_api_asymmetric_loss_refers(client: TestClient) -> None:
    aud = {"right": {f: 0 for f in FREQS}, "left": {f: 25 for f in FREQS}}
    c = run(client, aud)
    assert {o["code"] for o in c["overrides_applied"]} >= {"asymmetry_pta"}
    assert c["band"] == "high"


def test_api_shadow_uses_55_db_for_insert_earphones(client: TestClient) -> None:
    aud = {"right": {f: 0 for f in FREQS}, "left": {f: 0 for f in FREQS} | {4000: 45}}  # Δ 45 dB
    circum = SimClient.start(client)
    circum.run(threshold_listener(aud))
    assert any(t["possible_shadow"] for t in circum.finalize()["audiogram"])
    insert = SimClient.start(client, device={"connection": "wired", "transducer_type": "insert"})
    insert.run(threshold_listener(aud))
    assert not any(t["possible_shadow"] for t in insert.finalize()["audiogram"])


def test_api_high_false_alarm_rate_is_indeterminate(client: TestClient) -> None:
    sim = SimClient.start(client)
    sim.run(threshold_listener(flat(10)), insert_catch=lambda i: i % 3 == 0, catch_response=lambda _i: True)
    c = sim.finalize()["classification"]
    assert c["qc_composite"] == "poor"
    assert c["band"] == "indeterminate" and c["p_hearing_loss"] is None
    assert c["referral"] == "retest_required"


def test_api_aborted_session_is_indeterminate(client: TestClient) -> None:
    sim = SimClient.start(client)
    for _ in range(5):
        sim.post(sim.trial_body(sim.next_presentation, responded=True))  # type: ignore[arg-type]
    client.post(f"/api/v1/sessions/{sim.session_id}/abort", json={"reason": "user"})
    c = sim.finalize()["classification"]
    assert c["band"] == "indeterminate"
    assert "test did not finish" in " ".join(o["reason"] for o in c["overrides_applied"])
