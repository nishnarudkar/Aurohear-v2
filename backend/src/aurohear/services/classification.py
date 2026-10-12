"""Hearing-loss classification and likelihood model (spec §9; §1.3 shadow rule).

Everything here is a pure function of the accepted audiogram, the session's QC and its
calibration tier. All numbers come from `Browser_audiometry_digitization_spec.md`:

§9.1  PTA₄ (500/1000/2000/4000 Hz) → WHO 2021 grade on the better ear;
      BSA average (250/500/1000/2000/4000 Hz) → BSA 2018 descriptor per ear,
      no-response assigned 130 dB HL in the BSA average.
§9.2  P(hearing loss) = Φ((PTA_better + bias(tier) − 20) / σ_PTA(tier)),
      banded Low < 0.25 ≤ Medium ≤ 0.75 < High, then the mandatory overrides.
§9.4  Referral routing.
§1.3  Possible-shadow thresholds are excluded from the PTA and force a referral.

[DESIGN] choices the spec leaves open are marked as such below. σ, bias and band
cut-points are spec defaults that the spec itself says must be re-estimated from the
validation study (§9.2, §11) — they are versioned via MODEL_VERSION and stored with
each classification so past results never change silently.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from enum import IntEnum, StrEnum

MODEL_VERSION = "aurohear-classification-0.1.0"

PTA4_FREQUENCIES_HZ = (500, 1000, 2000, 4000)
BSA_AVG5_FREQUENCIES_HZ = (250, 500, 1000, 2000, 4000)
WHO_NORMAL_CUTOFF_DB_HL = 20.0
BSA_NO_RESPONSE_DB_HL = 130.0  # §9.1: BSA averaging rule for severity no-responses


# ------------------------------------------------------------------ enums


class CalibrationTier(StrEnum):
    A = "A"
    B = "B"
    C = "C"


class WhoGrade(StrEnum):
    NORMAL = "normal"
    MILD = "mild"
    MODERATE = "moderate"
    MODERATELY_SEVERE = "moderately_severe"
    SEVERE = "severe"
    PROFOUND = "profound"
    COMPLETE = "complete"


class BsaDescriptor(StrEnum):
    NONE = "none"  # average ≤ 20 dB HL: BSA defines no descriptor
    MILD = "mild"
    MODERATE = "moderate"
    SEVERE = "severe"
    PROFOUND = "profound"


class LikelihoodBand(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    INDETERMINATE = "indeterminate"  # §9.2 Step 4: QC Poor — band suppressed


class QcComposite(StrEnum):
    GOOD = "good"
    FAIR = "fair"
    POOR = "poor"


class Confidence(StrEnum):
    HIGH = "high"
    MODERATE = "moderate"
    LOW = "low"


class Referral(StrEnum):
    """§9.4. Ordered by urgency via REFERRAL_RANK."""

    URGENT_ENT = "urgent_ent"
    AUDIOLOGIST = "audiologist"
    RETEST_REQUIRED = "retest_required"  # indeterminate result
    REPEAT_THEN_REFER = "repeat_then_refer"  # medium band
    RETEST_AFTER_NOISE_FREE_INTERVAL = "retest_after_noise_free_interval"
    SPEECH_IN_NOISE_TEST = "speech_in_noise_test"
    ROUTINE_RETEST = "routine_retest"


class _Rank(IntEnum):
    ROUTINE = 1
    SPEECH_IN_NOISE = 2
    RETEST = 3
    AUDIOLOGIST = 4
    URGENT = 5


REFERRAL_RANK: dict[Referral, int] = {
    Referral.ROUTINE_RETEST: _Rank.ROUTINE,
    Referral.SPEECH_IN_NOISE_TEST: _Rank.SPEECH_IN_NOISE,
    Referral.RETEST_AFTER_NOISE_FREE_INTERVAL: _Rank.RETEST,
    Referral.REPEAT_THEN_REFER: _Rank.RETEST,
    Referral.RETEST_REQUIRED: _Rank.RETEST,
    Referral.AUDIOLOGIST: _Rank.AUDIOLOGIST,
    Referral.URGENT_ENT: _Rank.URGENT,
}


# ------------------------------------------------------------------ spec constants


@dataclass(frozen=True, slots=True)
class TierModel:
    sigma_pta_db: float
    bias_correction_db: float
    bias_specified: bool


TIER_MODELS: dict[CalibrationTier, TierModel] = {
    # §9.2 Step 1. Tier A bias is not given in the spec: 0 is used and flagged.
    CalibrationTier.A: TierModel(sigma_pta_db=4.5, bias_correction_db=0.0, bias_specified=False),
    CalibrationTier.B: TierModel(sigma_pta_db=5.4, bias_correction_db=1.5, bias_specified=True),
    CalibrationTier.C: TierModel(sigma_pta_db=7.6, bias_correction_db=1.4, bias_specified=True),
}

BAND_LOW_BELOW = 0.25  # §9.2 Step 3
BAND_HIGH_ABOVE = 0.75

ASYMMETRY_PTA_DB = 15.0  # §9.2 Step 4 (clinical-lead decision, spec default)
ASYMMETRY_ADJACENT_DB = 20.0

SHADOW_INTERAURAL_DB_SUPRA_CIRCUM = 40  # §1.3
SHADOW_INTERAURAL_DB_INSERT = 55


def shadow_interaural_db(transducer_type: str | None) -> int:
    """§1.3: ≥ 55 dB for insert earphones, ≥ 40 dB for supra-/circumaural (and unknown)."""
    return SHADOW_INTERAURAL_DB_INSERT if transducer_type == "insert" else SHADOW_INTERAURAL_DB_SUPRA_CIRCUM


# ------------------------------------------------------------------ inputs


@dataclass(frozen=True, slots=True)
class ThresholdPoint:
    """One accepted audiogram value (ear × frequency)."""

    ear: str  # "right" | "left"
    frequency_hz: int
    status: str  # "measured" | "no_response" | "unresolved"
    threshold_db_hl: int | None
    possible_shadow: bool = False


@dataclass(frozen=True, slots=True)
class QcInputs:
    false_positive_rate: float | None
    protocol_complete: bool
    unstable_1k: bool
    unresolved_thresholds: int
    discarded_trials: int
    tone_trials: int
    ambient_exceedance_rate: float | None = None  # §5 / §10 #10 — not measured yet
    qc_probe_fail_rate: float | None = None  # §10 #7


@dataclass(frozen=True, slots=True)
class IntakeInputs:
    """§7.3 IntakeForm / RedFlagScreener answers. Not collected by the app yet."""

    red_flags: tuple[str, ...] = ()
    reports_difficulty_in_noise: bool | None = None
    recent_noise_exposure_24h: bool | None = None


# ------------------------------------------------------------------ outputs


@dataclass(frozen=True, slots=True)
class Average:
    value_db_hl: float | None
    frequencies_used: tuple[int, ...]
    partial: bool  # some frequencies missing, unresolved or excluded as possible shadow
    includes_no_response: bool  # true average is at least this value


@dataclass(frozen=True, slots=True)
class EarSummary:
    ear: str
    pta4: Average
    bsa_avg5: Average
    bsa_descriptor: BsaDescriptor | None


@dataclass(frozen=True, slots=True)
class Override:
    code: str
    reason: str


@dataclass(frozen=True, slots=True)
class Classification:
    model_version: str
    calibration_tier: CalibrationTier
    ears: tuple[EarSummary, ...]
    pta4_right: float | None
    pta4_left: float | None
    pta4_better: float | None
    better_ear: str | None
    who_grade_better_ear: WhoGrade | None
    who_grade_is_lower_bound: bool
    bsa_avg5_right: float | None
    bsa_avg5_left: float | None
    bsa_descriptor_right: BsaDescriptor | None
    bsa_descriptor_left: BsaDescriptor | None
    bias_correction_db: float
    sigma_pta_db: float
    pta_adjusted: float | None
    p_hearing_loss: float | None  # None when suppressed (red flag, indeterminate, no PTA)
    computed_band: LikelihoodBand | None  # before overrides
    band: LikelihoodBand | None  # after overrides; None only under a red flag
    qc_composite: QcComposite
    confidence: Confidence
    asymmetry_db: float | None
    overrides_applied: tuple[Override, ...]
    annotations: tuple[str, ...]
    referral: Referral
    statement: str
    caveats: tuple[str, ...] = field(default=())


# ------------------------------------------------------------------ §9.1 deterministic


def who_grade(pta4_better_db_hl: float) -> WhoGrade:
    """WHO 2021, half-open bands on the better-ear PTA₄ (§9.1)."""
    p = pta4_better_db_hl
    if p < 20:
        return WhoGrade.NORMAL
    if p < 35:
        return WhoGrade.MILD
    if p < 50:
        return WhoGrade.MODERATE
    if p < 65:
        return WhoGrade.MODERATELY_SEVERE
    if p < 80:
        return WhoGrade.SEVERE
    if p < 95:
        return WhoGrade.PROFOUND
    return WhoGrade.COMPLETE


def bsa_descriptor(avg_db_hl: float) -> BsaDescriptor:
    """BSA 2018 (§9.1): Mild 21–40, Moderate 41–70, Severe 71–95, Profound > 95.

    [DESIGN] The integer bands are applied as (20, 40], (40, 70], (70, 95], (95, ∞) so a
    non-integer average (partial data) falls into exactly one band.
    """
    a = avg_db_hl
    if a <= 20:
        return BsaDescriptor.NONE
    if a <= 40:
        return BsaDescriptor.MILD
    if a <= 70:
        return BsaDescriptor.MODERATE
    if a <= 95:
        return BsaDescriptor.SEVERE
    return BsaDescriptor.PROFOUND


def _average(
    points: dict[int, ThresholdPoint], freqs: Sequence[int], *, no_response_value: float | None
) -> Average:
    """Mean over `freqs`. Unresolved, missing and possible-shadow points are excluded
    (§1.3) and mark the average partial. No-response uses `no_response_value`, or the
    recorded ceiling when None, and marks the average as a lower bound."""
    values: list[float] = []
    used: list[int] = []
    partial = False
    nr = False
    for f in freqs:
        p = points.get(f)
        if p is None or p.status == "unresolved" or p.threshold_db_hl is None or p.possible_shadow:
            partial = True
            continue
        if p.status == "no_response":
            nr = True
            values.append(no_response_value if no_response_value is not None else float(p.threshold_db_hl))
        else:
            values.append(float(p.threshold_db_hl))
        used.append(f)
    return Average(
        value_db_hl=sum(values) / len(values) if values else None,
        frequencies_used=tuple(used),
        partial=partial,
        includes_no_response=nr,
    )


def summarise_ear(ear: str, points: Iterable[ThresholdPoint]) -> EarSummary:
    by_f = {p.frequency_hz: p for p in points if p.ear == ear}
    # [DESIGN] For PTA₄ a no-response enters at its ceiling value (a lower bound); the
    # spec's 130 dB HL substitution is defined for the BSA average only.
    pta4 = _average(by_f, PTA4_FREQUENCIES_HZ, no_response_value=None)
    bsa = _average(by_f, BSA_AVG5_FREQUENCIES_HZ, no_response_value=BSA_NO_RESPONSE_DB_HL)
    return EarSummary(
        ear=ear,
        pta4=pta4,
        bsa_avg5=bsa,
        bsa_descriptor=bsa_descriptor(bsa.value_db_hl) if bsa.value_db_hl is not None else None,
    )


# ------------------------------------------------------------------ §9.2 probabilistic


def normal_cdf(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def p_hearing_loss(pta_better_db_hl: float, tier: CalibrationTier) -> float:
    m = TIER_MODELS[tier]
    return normal_cdf((pta_better_db_hl + m.bias_correction_db - WHO_NORMAL_CUTOFF_DB_HL) / m.sigma_pta_db)


def band_for(p: float) -> LikelihoodBand:
    if p < BAND_LOW_BELOW:
        return LikelihoodBand.LOW
    if p > BAND_HIGH_ABOVE:
        return LikelihoodBand.HIGH
    return LikelihoodBand.MEDIUM


# ------------------------------------------------------------------ QC composite


def qc_composite(qc: QcInputs) -> tuple[QcComposite, list[str]]:
    """[DESIGN — PROVISIONAL] The spec's QUALIND composite is a regression fitted on
    validation data (§10 #1), which does not exist yet. Until it does, this explicit
    rule set stands in; every reason is reported.

    Poor: protocol not finished · catch-trial false-alarm rate > 20 % ·
          ≥ 2 unresolved thresholds · ambient exceedance > 15 % of trials (§9.2 Step 4)
    Fair: false-alarm rate > 10 % · 1 unresolved threshold · > 15 % trials discarded ·
          any QC-probe failure (no response at threshold + 5 dB, §6.3)
    """
    poor: list[str] = []
    fair: list[str] = []
    if not qc.protocol_complete:
        poor.append("test did not finish")
    if qc.false_positive_rate is not None and qc.false_positive_rate > 0.20:
        poor.append(f"false-alarm rate {qc.false_positive_rate:.0%} on silent catch trials (> 20%)")
    elif qc.false_positive_rate is not None and qc.false_positive_rate > 0.10:
        fair.append(f"false-alarm rate {qc.false_positive_rate:.0%} on silent catch trials (> 10%)")
    if qc.unresolved_thresholds >= 2:
        poor.append(f"{qc.unresolved_thresholds} thresholds could not be resolved")
    elif qc.unresolved_thresholds == 1:
        fair.append("1 threshold could not be resolved")
    if qc.ambient_exceedance_rate is not None and qc.ambient_exceedance_rate > 0.15:
        poor.append(f"ambient noise over limit on {qc.ambient_exceedance_rate:.0%} of trials (> 15%)")
    if qc.qc_probe_fail_rate:
        fair.append(f"no response at threshold + 5 dB on {qc.qc_probe_fail_rate:.0%} of quality-check probes")
    total = qc.tone_trials + qc.discarded_trials
    if total and qc.discarded_trials / total > 0.15:
        fair.append(f"{qc.discarded_trials} trials discarded (> 15%)")
    if poor:
        return QcComposite.POOR, poor
    if fair:
        return QcComposite.FAIR, fair
    return QcComposite.GOOD, []


_CONFIDENCE_FROM_QC = {QcComposite.GOOD: Confidence.HIGH, QcComposite.FAIR: Confidence.MODERATE, QcComposite.POOR: Confidence.LOW}
_DOWNGRADE = {Confidence.HIGH: Confidence.MODERATE, Confidence.MODERATE: Confidence.LOW, Confidence.LOW: Confidence.LOW}


# ------------------------------------------------------------------ overrides


def adjacent_asymmetry(points: Sequence[ThresholdPoint], threshold_db: float = ASYMMETRY_ADJACENT_DB) -> tuple[int, int] | None:
    """First pair of adjacent tested frequencies where |L − R| ≥ threshold at both.

    Uses measured and no-response (at ceiling) values; unresolved points break adjacency.
    """
    right = {p.frequency_hz: p for p in points if p.ear == "right"}
    left = {p.frequency_hz: p for p in points if p.ear == "left"}
    freqs = sorted(set(right) | set(left))
    big: list[bool] = []
    for f in freqs:
        r, lt = right.get(f), left.get(f)
        ok = (
            r is not None and lt is not None
            and r.threshold_db_hl is not None and lt.threshold_db_hl is not None
            and r.status != "unresolved" and lt.status != "unresolved"
        )
        big.append(ok and abs(r.threshold_db_hl - lt.threshold_db_hl) >= threshold_db)  # type: ignore[union-attr, operator]
    for i in range(1, len(freqs)):
        if big[i - 1] and big[i]:
            return freqs[i - 1], freqs[i]
    return None


def _escalate(current: Referral, candidate: Referral) -> Referral:
    """A referral is only ever escalated, never downgraded (e.g. by poor QC)."""
    return candidate if REFERRAL_RANK[candidate] > REFERRAL_RANK[current] else current


def _band_rank(b: LikelihoodBand) -> int:
    return {LikelihoodBand.LOW: 0, LikelihoodBand.MEDIUM: 1, LikelihoodBand.HIGH: 2}.get(b, -1)


# ------------------------------------------------------------------ main entry point


CAVEATS: tuple[str, ...] = (
    "This is a screening result, not a diagnosis.",
    "Bone conduction was not tested, so the type of any hearing loss cannot be determined.",
    "No masking was used; large differences between ears may reflect sound crossing to the other ear.",
    "Detecting tones in quiet does not show how well you hear speech in noise, and these "
    "descriptors must not be the only basis for deciding whether you need hearing support (BSA 2018).",
)

_TIER_DESCRIPTION = {
    CalibrationTier.A: "a reference-calibrated test",
    CalibrationTier.B: "a test on a profiled consumer headphone",
    CalibrationTier.C: "an unsupervised, self-calibrated test",
}


def classify(
    points: Sequence[ThresholdPoint],
    qc: QcInputs,
    tier: CalibrationTier,
    intake: IntakeInputs | None = None,
) -> Classification:
    intake = intake or IntakeInputs()
    model = TIER_MODELS[tier]
    ears = tuple(summarise_ear(e, points) for e in ("right", "left"))
    right, left = ears
    overrides: list[Override] = []
    annotations: list[str] = []

    # --- §9.1 better ear and WHO grade
    candidates = [(s.pta4.value_db_hl, s) for s in ears if s.pta4.value_db_hl is not None]
    better: EarSummary | None = min(candidates, key=lambda c: c[0])[1] if candidates else None
    pta_better = better.pta4.value_db_hl if better else None
    grade = who_grade(pta_better) if pta_better is not None else None
    if better and better.pta4.partial:
        annotations.append(
            f"Better-ear PTA₄ uses {len(better.pta4.frequencies_used)} of 4 frequencies "
            "(others unresolved, untested or excluded as possible shadow)."
        )
    if len(candidates) < 2 and candidates:
        annotations.append("PTA₄ is available for one ear only.")

    # --- §9.2 probability and computed band
    p = p_hearing_loss(pta_better, tier) if pta_better is not None else None
    pta_adj = pta_better + model.bias_correction_db if pta_better is not None else None
    computed = band_for(p) if p is not None else None
    band: LikelihoodBand | None = computed
    if not model.bias_specified:
        annotations.append("Tier A bias correction is not specified by the protocol; 0 dB was used.")

    # --- QC
    composite, qc_reasons = qc_composite(qc)
    confidence = _CONFIDENCE_FROM_QC[composite]
    if qc.unstable_1k:
        confidence = _DOWNGRADE[confidence]
        overrides.append(Override("unstable_1k", "1 kHz retest differed by more than 5 dB; confidence lowered one level."))

    def force_high(code: str, reason: str) -> None:
        nonlocal band
        overrides.append(Override(code, reason))
        if band is None or band is not LikelihoodBand.INDETERMINATE:
            band = LikelihoodBand.HIGH

    # --- Mandatory overrides (§9.2 Step 4, §1.3), in precedence order below.
    referral = Referral.ROUTINE_RETEST
    asymmetry = (
        abs(right.pta4.value_db_hl - left.pta4.value_db_hl)
        if right.pta4.value_db_hl is not None and left.pta4.value_db_hl is not None
        else None
    )
    if asymmetry is not None and asymmetry >= ASYMMETRY_PTA_DB:
        force_high("asymmetry_pta", f"Interaural PTA₄ difference of {asymmetry:.1f} dB (≥ {ASYMMETRY_PTA_DB:.0f} dB): possible asymmetric loss.")
        referral = _escalate(referral, Referral.AUDIOLOGIST)
    pair = adjacent_asymmetry(points)
    if pair is not None:
        force_high("asymmetry_adjacent", f"Interaural difference ≥ {ASYMMETRY_ADJACENT_DB:.0f} dB at adjacent frequencies {pair[0]} and {pair[1]} Hz.")
        referral = _escalate(referral, Referral.AUDIOLOGIST)
    nr = [pt for pt in points if pt.status == "no_response"]
    if nr:
        where = ", ".join(f"{pt.ear} {pt.frequency_hz} Hz" for pt in nr)
        force_high("no_response", f"No response at the output limit ({where}).")
        referral = _escalate(referral, Referral.AUDIOLOGIST)
    shadow = [pt for pt in points if pt.possible_shadow]
    if shadow:
        where = ", ".join(f"{pt.ear} {pt.frequency_hz} Hz" for pt in shadow)
        overrides.append(Override("possible_shadow", f"Possible shadow (unmasked) at {where}; excluded from PTA₄."))
        referral = _escalate(referral, Referral.AUDIOLOGIST)

    if composite is QcComposite.POOR:
        band = LikelihoodBand.INDETERMINATE
        overrides.append(Override("qc_poor", "Indeterminate — retest required: " + "; ".join(qc_reasons) + "."))
        referral = _escalate(referral, Referral.RETEST_REQUIRED)
    elif qc_reasons:
        annotations.extend(f"Quality: {r}." for r in qc_reasons)

    if band is None and composite is not QcComposite.POOR:
        band = LikelihoodBand.INDETERMINATE  # no usable PTA at all
        overrides.append(Override("no_pta", "No usable PTA₄ could be computed."))
        referral = _escalate(referral, Referral.RETEST_REQUIRED)

    # --- §9.4 referral from the final band
    if band is LikelihoodBand.HIGH:
        referral = _escalate(referral, Referral.AUDIOLOGIST)
    elif band is LikelihoodBand.MEDIUM:
        referral = _escalate(referral, Referral.REPEAT_THEN_REFER)
    elif band is LikelihoodBand.LOW and intake.reports_difficulty_in_noise:
        referral = _escalate(referral, Referral.SPEECH_IN_NOISE_TEST)
    if intake.recent_noise_exposure_24h:
        referral = _escalate(referral, Referral.RETEST_AFTER_NOISE_FREE_INTERVAL)
        annotations.append("Recent loud-noise exposure reported: results may reflect a temporary threshold shift.")

    # Red flag beats everything: urgent referral, no probability shown (§9.2 Step 4, §9.4).
    if intake.red_flags:
        overrides.append(Override("red_flag", "Red flag reported: " + ", ".join(intake.red_flags) + "."))
        referral = Referral.URGENT_ENT
        band = None

    # Suppress the number whenever the band is not a computed one we stand behind.
    shown_p = p if band in (LikelihoodBand.LOW, LikelihoodBand.MEDIUM, LikelihoodBand.HIGH) else None

    return Classification(
        model_version=MODEL_VERSION,
        calibration_tier=tier,
        ears=ears,
        pta4_right=right.pta4.value_db_hl,
        pta4_left=left.pta4.value_db_hl,
        pta4_better=pta_better,
        better_ear=better.ear if better else None,
        who_grade_better_ear=grade,
        who_grade_is_lower_bound=bool(better and better.pta4.includes_no_response),
        bsa_avg5_right=right.bsa_avg5.value_db_hl,
        bsa_avg5_left=left.bsa_avg5.value_db_hl,
        bsa_descriptor_right=right.bsa_descriptor,
        bsa_descriptor_left=left.bsa_descriptor,
        bias_correction_db=model.bias_correction_db,
        sigma_pta_db=model.sigma_pta_db,
        pta_adjusted=pta_adj,
        p_hearing_loss=shown_p,
        computed_band=computed,
        band=band,
        qc_composite=composite,
        confidence=confidence,
        asymmetry_db=asymmetry,
        overrides_applied=tuple(overrides),
        annotations=tuple(annotations),
        referral=referral,
        statement=_statement(band, computed, pta_better, tier, referral, {o.code for o in overrides}),
        caveats=CAVEATS,
    )


_OVERRIDE_PHRASES = {
    "asymmetry_pta": "your two ears gave noticeably different results",
    "asymmetry_adjacent": "your two ears gave noticeably different results at neighbouring pitches",
    "no_response": "at one or more pitches you did not respond even at the loudest level this test can play",
    "possible_shadow": "your two ears differed so much at some pitches that the poorer ear could not be measured reliably",
}


def _statement(
    band: LikelihoodBand | None,
    computed: LikelihoodBand | None,
    pta_better: float | None,
    tier: CalibrationTier,
    referral: Referral,
    override_codes: set[str],
) -> str:
    """§9.2 Step 5: never 'you have hearing loss'; say what kind of test it was; the
    advice always matches the final referral, and an override is explained by its reason
    rather than by a PTA statement that would not be true."""
    what = _TIER_DESCRIPTION[tier]
    disclaimer = (
        f"This is a screening result from {what} — it is not a diagnosis, it did not test "
        "bone conduction, and no one examined your ears."
    )
    if band is None:
        return (
            "Your answers to the health questions mean you should see a doctor or ear "
            "specialist promptly. A hearing result is not shown."
        )
    if band is LikelihoodBand.INDETERMINATE:
        return (
            "We could not get a reliable result from this test. Please repeat it in a quiet "
            "room, following the instructions closely."
        )
    avg = f"about {pta_better:.0f} dB HL" if pta_better is not None else None
    reasons = [_OVERRIDE_PHRASES[c] for c in _OVERRIDE_PHRASES if c in override_codes]
    if reasons and computed is not LikelihoodBand.HIGH:
        head = "Your result should be checked by an audiologist."
        body = "This screening test found that " + "; and ".join(reasons) + "."
        return f"{head} {body} {disclaimer} Please arrange a full hearing test with an audiologist."
    if band is LikelihoodBand.HIGH:
        head = "Higher likelihood of hearing loss."
        body = (
            f"This screening test suggests your hearing in the better ear averages {avg} across the "
            "speech frequencies, which is above the 20 dB HL that the World Health Organization uses "
            "as the boundary for normal hearing."
        )
        if reasons:
            body += " It also found that " + "; and ".join(reasons) + "."
    elif band is LikelihoodBand.MEDIUM:
        head = "Possible hearing loss."
        body = (
            f"This screening test suggests your hearing in the better ear averages {avg} across the "
            "speech frequencies, close to the 20 dB HL boundary the World Health Organization uses for "
            "normal hearing."
        )
    else:
        head = "Lower likelihood of hearing loss."
        body = (
            f"This screening test suggests your hearing in the better ear averages {avg} across the "
            "speech frequencies, within the range the World Health Organization treats as normal."
        )
    advice = {
        Referral.AUDIOLOGIST: "Please arrange a full hearing test with an audiologist.",
        Referral.REPEAT_THEN_REFER: "Please repeat the test in a quiet room; if the result is similar, arrange a hearing test with an audiologist.",
        Referral.RETEST_AFTER_NOISE_FREE_INTERVAL: "Because you were recently exposed to loud noise, please repeat the test after a day without loud noise.",
        Referral.SPEECH_IN_NOISE_TEST: "Because you find conversation in noise difficult, a speech-in-noise test is recommended; tones in quiet do not measure that.",
        Referral.ROUTINE_RETEST: "Consider repeating the test as part of routine hearing checks.",
    }.get(referral, "Please arrange a full hearing test with an audiologist.")
    return f"{head} {body} {disclaimer} {advice}"
