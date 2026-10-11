# Digitizing Pure-Tone Audiometry for a Browser-Based Interface

**Technical specification and design report**
Version 1.0 · Prepared from primary standards and peer-reviewed validation literature

---

## 0. How to read this document

Every substantive parameter is tagged with its provenance so you can separate what is
*mandated by a standard or reported in a validated study* from what is *our engineering
proposal*:

| Tag | Meaning |
|---|---|
| **[STD]** | Taken directly from a published standard or professional recommended procedure (ASHA 2005, BSA 2018, ISO/ANSI/IEC as cited). Reference given inline. |
| **[LIT]** | Taken from a peer-reviewed validation study. Reference and effect size given inline. |
| **[DESIGN]** | Our engineering decision. Defensible, but not standards-mandated. Must be signed off by your clinical lead and confirmed in your own validation study. |
| **[VERIFY]** | A parameter that exists in a paywalled standard we have not reproduced here. You must procure the standard and fill in the value. Do **not** guess. |

Three standards are cited repeatedly and are the operative sources for the protocol:

- **ASHA (2005)**, *Guidelines for Manual Pure-Tone Threshold Audiometry* — freely readable, full procedure. [R1]
- **BSA (2018)**, *Recommended Procedure: Pure-tone air-conduction and bone-conduction threshold audiometry with and without masking*, OD104-32 — freely readable, full procedure. [R2]
- **WHO (2021)**, *World report on hearing* grading of hearing loss. [R3]

Both ASHA and BSA are consensus operationalisations of **ANSI S3.21** / **ISO 8253-1**
respectively; where they differ (e.g. frequency order), that difference is called out.

---

## 1. Scope, intended use, and honest limits

### 1.1 What this system is

A **self-administered or technician-assisted, boothless, air-conduction pure-tone
threshold screening audiometer delivered in a web browser**, producing a per-ear
audiogram, an audiometric descriptor, and a stratified likelihood of hearing loss.

### 1.2 What this system is *not* [DESIGN, grounded in R1/R2]

State this in the product, the report footer, and the consent text. Not as legal
boilerplate — as a design constraint that shapes the whole build.

| Cannot be done in a browser | Why | Consequence for the product |
|---|---|---|
| **Bone conduction** | Requires a calibrated bone vibrator (Radioear B71/B81) with controlled static headband force per ANSI S3.13 / ISO 389-3 [R1, R2]. No consumer hardware. | You cannot distinguish **conductive** from **sensorineural** loss. Never output a site-of-lesion claim. |
| **Contralateral masking** | Requires narrow-band noise calibrated in effective masking level per ISO 389-4 and a plateau-seeking procedure [R2 §8]. Also requires knowing bone-conduction thresholds (BSA Rules 2 and 3). | Any threshold in an ear where the interaural difference is large may be a **shadow** of the better ear. Must be flagged, not silently reported. |
| **Otoscopy / cerumen check** | Physical examination; ASHA and BSA both require it *before* audiometry [R1, R2 §5.1]. | Replace with a screening questionnaire + explicit "not examined" statement on the report. |
| **Guaranteed absolute SPL** | The browser cannot read or lock OS volume, and consumer transducers have no traceable RETSPL. | Drives the whole calibration architecture in §3. |
| **Extended high frequencies (9–16 kHz)** | Requires circumaural transducers with characterised response in that band [R1]. | Optional Tier-A-only module; out of scope for v1. |

### 1.3 Interaural attenuation — the single most important clinical caveat [STD, R2 §8.1]

BSA reports interaural attenuation (transcranial transmission loss) of **40–80 dB** for
supra-aural / circumaural earphones and a **minimum of 55 dB** for correctly inserted
insert earphones. Masking is indicated when the left–right unmasked air-conduction
difference at a frequency reaches **≥40 dB** (supra-/circumaural) or **≥55 dB** (insert).

Because you cannot mask, your rule is:

> **[DESIGN]** If |threshold_L − threshold_R| ≥ 40 dB at any frequency, mark the
> poorer-ear threshold as **"possible shadow — unmasked"**, render it as a half-filled
> symbol, exclude it from the PTA used for classification, and force a clinical referral
> outcome. Do not report a numeric threshold for that point as if it were valid.

### 1.4 Regulatory posture [DESIGN — confirm with regulatory counsel]

Software that measures hearing thresholds and returns a likelihood of hearing loss is
very likely a **medical device** in most jurisdictions (EU MDR, US FDA, India CDSCO under
the Medical Devices Rules 2017 / MDR-2017 software provisions). Two defensible product
postures:

1. **Wellness / screening tool** — outputs "you may benefit from a professional hearing
   test", no numeric threshold shown to the lay user, no diagnostic language. Lower
   regulatory burden, lower clinical utility.
2. **Regulated screening audiometer** — outputs an audiogram and classification; requires
   a quality system, clinical evaluation, and conformity to IEC 60645-1 (audiometer
   performance) and IEC 62304 (software lifecycle).

For a research deployment, an IRB/IEC protocol plus explicit "research use only, not for
diagnosis" labelling is the minimum. Decide this **before** you build the results screen,
because it determines what you are allowed to render there.

---

## 2. Reference standards to procure

| Standard | Covers | Why you need it |
|---|---|---|
| ISO 8253-1 | Basic pure-tone air/bone threshold audiometry — the test method | Normative source for the ascending method and ambient noise tables |
| ISO 389-1 | RETSPL, supra-aural earphones | Convert dB SPL → dB HL |
| ISO 389-2 | RETSPL, insert earphones | As above |
| ISO 389-8 | RETSPL, circumaural earphones | As above — the relevant one for consumer over-ear headphones |
| ISO 389-4 | Reference levels for narrow-band masking noise | Only if you later add masking |
| ISO 7029 | Statistical distribution of thresholds by age | Age-normalised reporting, expected-threshold priors |
| ANSI S3.6 | Specifications for audiometers | Output accuracy, linearity, crosstalk, distortion limits |
| ANSI S3.21 | Methods for manual pure-tone threshold audiometry | Normative source behind ASHA 2005; Annex B covers test-retest variability |
| ANSI S3.1-1999 (R2018) | Maximum permissible ambient noise levels (MPANLs) | Environment gate (§5) |
| IEC 60645-1 | Pure-tone audiometers, electroacoustic requirements | Tone rise/fall, frequency tolerance, harmonic distortion, crosstalk **[VERIFY]** |
| IEC 62304 | Medical device software lifecycle | If regulated |

BSA Appendix B lists the same standard set. [R2]

---

## 3. Calibration architecture

This is the hardest problem in browser audiometry and the dominant error term. Masalski &
Kręcicki decomposed the error in self-administered web audiometry and found calibration
error contributed **σ_cal = 6.19 dB**, second only to the threshold-search procedure
itself (σ_proc = 6.64 dB), with frequency-response non-linearity adding **7.28 dB at
250 Hz** specifically. [LIT, R4]

### 3.1 Three calibration tiers [DESIGN, error terms from R4]

The product must know which tier a given session ran in, store it, and propagate it into
the confidence model (§9). Never mix tiers in a longitudinal comparison.

| Tier | Setup | Method | Empirical σ of the 4-frequency mean threshold |
|---|---|---|---|
| **A — Reference** | Audiometric transducer (e.g. Radioear DD65v2, DD450, Sennheiser HDA200) on a known audio interface, coupler-verified against ANSI S3.6 / IEC 60645-1 | Electroacoustic calibration, RETSPL from ISO 389-8 | ≈ **4–5 dB** (clinical single-measurement SD estimated at 4.25 dB [R4]; automated-vs-manual mean absolute difference 3.6 dB [R5]) |
| **B — Profiled consumer** | Known headphone model + known device, wired, from a curated allow-list, with a published or in-house measured ETSPL correction table | Model-specific lookup, no per-user calibration | ≈ **5.4 dB** (supervised web test on a pre-calibrated PC: mean difference −1.52 dB, SD 5.42 dB vs clinical audiometer [R4]) |
| **C — Biological** | Arbitrary wired headphones, self-calibrated at home by a normally-hearing reference listener | Reference-listener calibration at 1 kHz + model-based extrapolation | ≈ **7.6 dB** (unsupervised home test: mean difference −1.44 dB, SD 7.59 dB [R4]) |

Tier A and B are the recommended operating points. Tier C is acceptable for population
screening only, and its results should never be rendered as a numeric audiogram to a lay
user without a visible uncertainty band.

### 3.2 The biological calibration procedure (Tier C) [LIT, R4]

Masalski's method, which is validated and worth copying rather than inventing:

1. Set system volume to a fixed, maximum position; calibration and test both run at that
   position.
2. Present **two 1 kHz tones alternately, 1 s each, binaurally**, with a **fixed 5 dB
   level difference** between them.
3. The reference listener adjusts a **1 dB-step slider** until *only the louder of the two
   is audible*. Unlimited listening time, unlimited adjustments, confirm with a button.
4. The **mean of the two levels** defines 0 dB HL for that rig (Masalski's "0 dB RP-HL").
5. Reference levels at other frequencies are derived from a model — Masalski used an
   **A-weighting-based model**. [R4]

Two improvements over the published method, both flagged as [DESIGN]:

- **Repeat calibration ≥3 times** (Masalski's controlled series averaged six runs by three
  listeners) and reject if the spread exceeds 5 dB.
- **Independently calibrate at 250 Hz and 4 kHz** and check agreement with the model
  prediction. The 250 Hz non-linearity term (7.28 dB) is the largest single frequency
  error and is exactly where the A-weighting model breaks down against real headphone
  RETSPL spread. [R4] If disagreement > 10 dB, refuse to report 250 Hz.

The reference listener must be **under ~35 years old with no history of hearing problems**
— Masalski's own instruction to home participants. [LIT, R4]

### 3.3 Headphone allow-list policy [DESIGN]

| Rule | Rationale |
|---|---|
| **Wired only. Block Bluetooth.** | Codec processing, dynamic range compression, automatic gain, and loudness normalisation in the wireless chain destroy level accuracy. Detect via output device label heuristics + an explicit user attestation gate. |
| **Prefer circumaural** | Circumaural cups give materially more ambient attenuation than supra-aural, which is what makes boothless testing viable at all. [LIT, R6, R7] |
| **Ban headphones with active EQ/ANC modes on** | Same reason as Bluetooth. ANC on changes the effective transfer function. |
| **Maintain a versioned profile table** | `{model_id, transducer_type, ETSPL_by_frequency[], max_safe_HL_by_frequency[], source, measured_date}`. Version it; a threshold measured under profile v3 is not comparable to one under v4. |

Published ETSPLs exist for some audiometric circumaural headphones (e.g. the DD65v2
[R8]); for consumer models you must measure them yourself on an artificial ear.
**[VERIFY]** — do not copy RETSPL numbers from memory or from the web.

### 3.4 Output ceiling and safety [DESIGN]

- Compute, per profile per frequency, the **maximum achievable dB HL** at full digital
  scale with headroom for the ramp. Typical consumer circumaural on a laptop output:
  roughly 80–95 dB HL mid-frequency, materially less at 250 Hz and 8 kHz. Measure it;
  don't assume.
- **Hard-cap presentation at min(profile_max, 90 dB HL)** for unsupervised sessions. A
  self-administered test has no clinician watching for discomfort. BSA advises caution
  above 100 dB HL tones even in clinic. [R2 §8.8]
- Any frequency where threshold is not reached at the cap is recorded as **No Response
  (NR)** at that level and plotted with a downward arrow, unconnected to adjacent
  symbols. [STD, R2 §10.2]
- Ramp all onsets/offsets. An un-ramped gate produces an audible click that is broadband
  and detectable well below the tone's threshold — it will silently invalidate every
  threshold you measure.

---

## 4. Signal specification

| Parameter | Value | Provenance |
|---|---|---|
| Stimulus | Pure tone, sinusoidal, continuous or pulsed | [STD] R1 (ASHA permits both; notes pulsed tones increase stimulus awareness, citing Burk & Wiley 2004) |
| Pulsed mode | Recommended default for tinnitus and for self-administered use | [STD/DESIGN] R1 Table 1 recommends pulsed or warble for tinnitus. Note BSA advises *against* pulsed tones on calibration/perception grounds [R2 §6.8] — a genuine disagreement between the two guidelines. **Pick one, document it, keep it fixed across a study.** |
| Tone duration | **1–2 s** (ASHA) / **1–3 s, varied** (BSA). Use **1.5 s ± 0.3 s randomised** | [STD] R1, R2 §6.5 |
| Inter-stimulus interval | Varied, **never shorter than the tone**. Use **1.5–4.5 s uniform random** | [STD] R1, R2 §6.5 |
| Predictability | Timing must not be predictable — this is the primary defence against false positives | [STD] R2 §6.5 |
| Tone must not truncate on response | Present the full duration even after the button is pressed | [STD] R2 §6.5 |
| Rise/fall | Raised-cosine ramp; conform to IEC 60645-1 overshoot limits | **[VERIFY]** — procure IEC 60645-1. Typical implementations use 20–50 ms; confirm against the standard, do not assume. |
| Frequency accuracy | Per IEC 60645-1 tolerance | **[VERIFY]** |
| Total harmonic distortion | Per ANSI S3.6 / IEC 60645-1 limits, measured at the transducer | **[VERIFY]** |
| Crosstalk | Non-test channel must be at digital zero; verify measured crosstalk against ANSI S3.6 | **[VERIFY]** — Bastianelli-type tablet audiometer validations have failed initial crosstalk checks; test yours. [LIT, R9] |

### 4.1 Web Audio implementation notes [DESIGN]

```
AudioContext(sampleRate: 48000)
  └─ OscillatorNode (type: 'sine', frequency: f)
       └─ GainNode  (envelope; automate with setValueCurveAtTime / exponentialRamp)
            └─ ChannelMergerNode (2ch) — test ear channel only, other channel = 0
                 └─ destination
```

- Schedule everything on the **AudioContext clock** (`currentTime + offset`), never
  `setTimeout`. Timer jitter of tens of milliseconds corrupts short-duration gating.
- Create the oscillator **per trial** and stop it; do not leave one running and gate it,
  because residual leakage through a "closed" gain node is a real failure mode. Verify
  with a loopback recording.
- Convert dB HL → linear gain:
  `gain = 10 ^ ((HL_dB + ETSPL_f + cal_offset − full_scale_SPL) / 20)`
  Keep `full_scale_SPL` per profile. Clamp and log any clamp event as a QC failure.
- Instantiate the `AudioContext` **only inside a user gesture** (autoplay policy), and
  handle `statechange` → `suspended` as an immediate test abort.
- **`navigator.mediaDevices.ondevicechange`** → if the output device changes mid-session,
  abort. A user unplugging headphones and continuing on laptop speakers is the single
  most common invalidating event.
- **Page Visibility API** → tab hidden or window blurred mid-trial invalidates that trial.
  Discard it and re-present, and count the event.
- For the ambient noise measurement, request the microphone with all processing
  **disabled**: `{ echoCancellation: false, autoGainControl: false, noiseSuppression:
  false }`. With AGC on, your noise measurement is meaningless.

---

## 5. Test environment gate

### 5.1 The requirement [STD]

- ASHA: the test environment **shall at all times** meet ANSI S3.1 maximum permissible
  ambient noise levels. [R1]
- BSA reproduces the ISO 8253-1 one-third-octave MPANL table and adds a practical rule:
  **if ambient noise exceeds ~35 dB(A), audiometry should not proceed.** [R2 §4.2,
  Appendix C]
- BSA's table is for measuring down to **0 dB HL**. To measure only down to a higher
  floor, **add that floor to every table value** — e.g. to test only down to 10 dB HL, add
  10 dB throughout. [STD, R2 Appendix C] This is the mechanism that makes boothless
  testing legitimate rather than a fudge.

### 5.2 Boothless operation is defensible if — and only if — noise is measured [LIT]

The literature supports boothless audiometry specifically when ambient noise is
**monitored and enforced**, not merely assumed:

- Swanepoel et al. (2015) demonstrated valid pure-tone audiometry outside a booth using
  the combination of **earphone attenuation + integrated noise monitoring + automation**.
  [R6]
- Margolis, Saly & Wilson (2022) derived **modified MPANLs that credit the extra
  attenuation of circumaural earphones** relative to supra-aural. [R7]
- Meinke & Martin (2023) review boothless ambient noise practice and stress that MPANLs
  depend on transducer type and that the noise **spectrum**, and its variability over
  time, must be accounted for continuously during the test — not sampled once. [R10]

### 5.3 Implementation [DESIGN, thresholds from R2/R7]

1. **Pre-test gate.** 15 s microphone capture. FFT → one-third-octave band levels,
   250 Hz–8 kHz. Compare each band against `MPANL_band + test_floor_dB +
   transducer_attenuation_credit_band`. Also compute broadband dB(A) and gate at 35 dB(A)
   as a coarse backstop.
2. **Continuous monitoring.** Sample the microphone in the inter-stimulus gaps (never
   during a tone — you would just record your own stimulus). If a band exceeds the limit,
   **discard the trial in flight**, show a "too noisy, waiting" state, and resume when
   clear. Count and store every such event.
3. **Uncalibrated microphone problem.** A laptop/phone microphone has unknown absolute
   sensitivity. Options, in descending order of rigour:
   - Tier A/B: calibrate the microphone against a sound level meter at deployment.
   - Tier C: maintain per-device-model microphone sensitivity profiles (the same approach
     used for the transducer).
   - Fallback: use the microphone only for **relative** change detection and enforce the
     dB(A) gate with a documented ±5–8 dB uncertainty, stated on the report.
4. **Store the ambient spectrum with the session.** It is part of the record — ASHA
   requires the test environment be documented on the audiogram. [R1, Record Keeping]

---

## 6. The threshold procedure — exact digitization

### 6.1 Method: modified Hughson–Westlake ascending technique

Both guidelines converge on an ascending method (Carhart & Jerger 1959, from Hughson &
Westlake 1944), operationalised in ANSI S3.21 / ISO 8253-1. ASHA states plainly that the
**ascending technique beginning with an inaudible signal is the recommended standard**.
[STD, R1]

### 6.2 Familiarisation [STD]

Run **once per ear** before threshold search, at 1000 Hz.

| Guideline | Procedure |
|---|---|
| ASHA (Method 2) [R1] | Present 1 kHz at **30 dB HL**. If a clear response → begin threshold measurement. If not → **50 dB HL**, then **+10 dB steps** until response. |
| BSA [R2 §6.6] | Present 1 kHz at a clearly audible level: **40 dB HL** for a normally-hearing subject, or **~30 dB above estimated threshold** for an impaired subject, but **never above 80 dB HL**. No response → **+10 dB steps**. Still inaudible at 80 dB HL → **+5 dB steps**, monitoring for discomfort. |

**[DESIGN] Recommended for unsupervised web use:** start at **40 dB HL** (BSA), ascend in
10 dB steps, switch to 5 dB steps above 80 dB HL, and hard-stop at the profile cap (§3.4).
Require **two consecutive consistent responses** before declaring familiarisation
complete. If the responses are not consistent with tone onset/offset, **repeat**; if still
unsatisfactory, **re-instruct** and repeat. [STD, R2 §6.6]

### 6.3 The staircase [STD, R1 §Threshold determination; R2 §6.7]

```
1. Start at a clearly audible level.
   - First frequency of an ear: level established during familiarisation.
   - Subsequent frequencies:   previous frequency's threshold + 30 dB (BSA §6.7 step 5),
                               clamped to the profile cap.
2. DOWN 10 dB after every response, until no response.
3. UP 5 dB after every non-response, until a response.
4. After the first ascending response: DOWN 10 dB, begin a new ascending run.
5. Repeat 10-down / 5-up.
6. THRESHOLD = the lowest level at which the subject responds on
   at least 50% of ascending trials, with a MINIMUM OF TWO responses at that level.
   ANSI S3.21 operationalises the minimum as 2 responses out of 3 presentations
   at a single level.  (ASHA 2005)
   BSA phrases it as 2-out-of-2, 2-out-of-3 or 2-out-of-4 ascents.  (BSA 2018 §6.7.4)
```

**[DESIGN] Implementation decisions the standards leave open:**

| Decision | Recommendation | Note |
|---|---|---|
| Level lattice | **5 dB grid**, −10 dB HL to profile cap | ASHA specifies −10 dB as the audiogram minimum [R1] |
| Max ascents per frequency | **6**, then declare "unresolved" and log it | Prevents infinite loops on inconsistent responders |
| Max total presentations per frequency | **25** | Fatigue guard |
| Response window | **Onset of tone → tone offset + 2.0 s** | A response outside this window is a false positive, not a hit |
| Timeout | **10 s** with no response after a presentation → show a "still there?" prompt; **3 timeouts in a session → abort to the finish screen** | Matches the AMTAS behaviour [LIT, R11] |
| Quality-check probe | After each threshold is fixed, **re-present at threshold and at threshold + 5 dB**; a non-response at +5 dB is a quality-check failure | AMTAS does exactly this and tracks it as a QUALIND metric [LIT, R11] |
| Catch trials | **~10% of trials are silent trials** (no stimulus). A response = false alarm. On the second false alarm, interrupt with an on-screen re-instruction. | ASHA: reinstruction reduces false-response rate [R1]; AMTAS delivers exactly this on-screen message [R11] |

### 6.4 Frequency order — exact sequence

Both guidelines start at **1000 Hz in the better ear** (better ear by the participant's own
report if unknown). [STD, R1, R2 §5.1, §6.4]

They then diverge. Pick one and hold it constant:

**Option 1 — ASHA diagnostic order** [STD, R1] *(recommended: includes 3 and 6 kHz, which
ASHA explicitly added in 2005 and which matter for noise-induced and occupational loss)*

| Step | Ear 1 (better) | Ear 2 |
|---|---|---|
| 1 | 1000 Hz | 1000 Hz |
| 2 | 2000 Hz | 2000 Hz |
| 3 | 3000 Hz | 3000 Hz |
| 4 | 4000 Hz | 4000 Hz |
| 5 | 6000 Hz | 6000 Hz |
| 6 | 8000 Hz | 8000 Hz |
| 7 | **1000 Hz (retest)** | — *(retest not required in the second ear)* |
| 8 | 500 Hz | 500 Hz |
| 9 | 250 Hz | 250 Hz |
| 10 | *(125 Hz only if low-frequency loss present)* | *(same)* |

**Option 2 — BSA order** [STD, R2 §6.4]

`1000 → 2000 → 4000 → 8000 → 500 → 250 → 1000 (retest, first ear only)`, with 750, 1500,
3000, 6000 added "where needed and practicable".

**Inter-octave rule** [STD]: when adjacent octave thresholds differ by **≥20 dB**, insert
the inter-octave frequency. ASHA scopes this to 500–2000 Hz [R1]; the automated AMTAS
implementation applies the same ≥20 dB trigger to inter-octaves generally [R11]. So:
750 Hz if |500−1000| ≥ 20; 1500 Hz if |1000−2000| ≥ 20; 3000 Hz if |2000−4000| ≥ 20;
6000 Hz if |4000−8000| ≥ 20.

**1 kHz retest rule** [STD]:

- ASHA: if the retest differs by **more than 5 dB**, accept the **lower (better)** of the
  two and **retest at least one other frequency**. [R1 Special Considerations]
- BSA: if retest is within 5 dB, take the more sensitive value; if it differs by more than
  5 dB, **investigate the reason** — re-instruct and potentially repeat the whole ear.
  Note the variability on the audiogram. [R2 §6.4]

**[DESIGN]** Implement both: auto-accept the better value when Δ ≤ 5 dB; when Δ > 5 dB,
re-instruct, retest 1 kHz a third time and one other frequency, and set a QC flag
`unstable_1k = true` that feeds the confidence model.

### 6.5 The frequency–intensity pair space, stated explicitly

The requester asked for "exact frequency–intensity pairs". In a state-of-the-art protocol
these are **generated adaptively, not enumerated in advance** — that is precisely what
distinguishes Hughson–Westlake from a fixed-grid screen. The exact specification is
therefore the *lattice plus the rules*:

```
F  = [1000, 2000, 3000, 4000, 6000, 8000, 1000r, 500, 250]      Hz   (ASHA order)
F+ = [750, 1500, 3000, 6000]  conditional on the ≥20 dB inter-octave rule
L  = {−10, −5, 0, 5, 10, ..., min(profile_cap, 90)}              dB HL, 5 dB grid
Start(f₁) = familiarisation level (40 dB HL default)
Start(fₙ) = threshold(fₙ₋₁) + 30 dB, clamped to L
Transition: response → −10 dB ; no response → +5 dB
Stop:       ≥2 responses at the same level on ≥50% of ascending runs
```

#### Worked trace — a real presentation sequence (1000 Hz, true threshold 25 dB HL)

| # | Freq (Hz) | Level (dB HL) | Type | Response | Staircase action |
|---|---|---|---|---|---|
| 1 | 1000 | 40 | familiarisation | ✓ | begin descent |
| 2 | 1000 | 30 | descent | ✓ | −10 |
| 3 | 1000 | 20 | descent | ✗ | +5 |
| 4 | 1000 | 25 | ascent 1 | ✓ | **ascent hit @25**; −10 |
| 5 | 1000 | 15 | ascent 2 start | ✗ | +5 |
| 6 | 1000 | 20 | ascent 2 | ✗ | +5 |
| 7 | — | silent | catch trial | ✗ (correct) | continue |
| 8 | 1000 | 25 | ascent 2 | ✓ | **2nd ascent hit @25** → criterion met |
| 9 | 1000 | 25 | QC probe | ✓ | quality check pass |
| 10 | 1000 | 30 | QC probe (+5) | ✓ | quality check pass |

→ **Threshold(1000 Hz, R) = 25 dB HL**, 2/2 ascending responses, QC pass.
Next frequency 2000 Hz starts at 25 + 30 = **55 dB HL**.

#### Fixed-grid fallback (screening mode only) [DESIGN]

For a 90-second triage screen rather than a threshold test, use a fixed pass/fail grid —
present at a single suprathreshold level and score responses. AMTAS's screening
configuration uses a **minimum of three frequencies at either 20 or 25 dB HL** with a
configurable pass criterion. [LIT, R11] This mode produces **no audiogram** and only a
pass/refer outcome. Keep the two modes strictly separate in the data model.

### 6.6 Session timing [STD]

BSA: if the test exceeds **20 minutes**, offer a break — fatigue degrades reliability.
[R2 §5.2] AMTAS full diagnostic sessions run about **15–20 minutes**. [LIT, R11]

**[DESIGN]** Budget: setup+calibration 3–5 min, environment check 1 min, instructions
1 min, ~7 min per ear. Insert a mandatory 30 s break between ears with an explicit
"Continue" button, and a soft break prompt at the 20-minute mark.

---

## 7. Application architecture

### 7.1 Route map

```
/                       Landing, plain-language description, "not a diagnosis" notice
/auth/login             Email+password or magic link; MFA for clinician/admin roles
/auth/register          Includes research consent version pinning
/consent/:version       Versioned consent; must be re-accepted when version increments
/dashboard              Participant: past sessions, "Start new test", trend view
/test/new               Session creation → runs the wizard below
  ├─ /test/:id/intake         Case history + red-flag screener
  ├─ /test/:id/device         Headphone selection, wired check, L/R channel check
  ├─ /test/:id/calibrate      Tier A/B/C branch
  ├─ /test/:id/environment    Ambient noise gate
  ├─ /test/:id/instructions   Instructions + practice trials
  ├─ /test/:id/run            The test runner (per ear, per frequency)
  └─ /test/:id/complete       Debrief
/results/:id            Audiogram, descriptor, likelihood band, confidence
/results/:id/report     Printable / PDF clinical report
/clinician              Queue of sessions for review, sign-off, override
/clinician/session/:id  Full trial-level log, QC panel, manual re-classification
/admin/protocols        Protocol versioning, frequency set, step rules, thresholds
/admin/profiles         Headphone/device calibration profile registry
/settings               Accessibility, language, data export, deletion request
```

### 7.2 Test-runner state machine

This is the core of the build. Implement it as an explicit finite state machine (XState or
equivalent) — not as nested React effects. Every transition must be logged.

```
IDLE
 └→ INTAKE ─(red flag)→ HALT_REFER
 └→ DEVICE_CHECK ─(fail)→ BLOCKED_DEVICE
 └→ CALIBRATION ─(fail/out-of-tolerance)→ BLOCKED_CALIBRATION
 └→ ENVIRONMENT_CHECK ─(fail)→ NOISY_WAIT ⇄ ENVIRONMENT_CHECK
 └→ INSTRUCTIONS
 └→ PRACTICE ─(fail ×2)→ REINSTRUCT → PRACTICE
 └→ EAR_LOOP {
      FAMILIARISATION ─(inconsistent)→ REINSTRUCT → FAMILIARISATION
      FREQ_LOOP {
        PRESENT_TONE → AWAIT_RESPONSE
          ├ response in window        → SCORE_HIT
          ├ response outside window   → SCORE_FALSE_ALARM → (×2) REINSTRUCT_MODAL
          ├ no response, t<10s        → SCORE_MISS
          └ no response, t≥10s        → TIMEOUT → (×3) ABORT_SESSION
        SCORE_* → UPDATE_STAIRCASE
          ├ criterion met     → QC_PROBE → COMMIT_THRESHOLD → next freq
          ├ ceiling reached   → COMMIT_NO_RESPONSE → next freq
          ├ max ascents       → COMMIT_UNRESOLVED → next freq
          └ otherwise         → PRESENT_TONE
        NOISE_EXCEEDED (any point) → DISCARD_TRIAL → NOISY_WAIT
      }
      RETEST_1K (first ear only) → Δ>5dB? → REINSTRUCT + RETEST_EXTRA
    }
 └→ INTER_EAR_BREAK → EAR_LOOP (second ear)
 └→ QC_EVALUATION → CLASSIFICATION → COMPLETE
```

### 7.3 Component inventory

#### Global

| Component | Purpose | Key states |
|---|---|---|
| `AppShell` | Layout, nav, role-based routing | authenticated / anonymous / clinician |
| `ConsentGate` | Blocks all test routes until current consent version accepted | pending / accepted / stale |
| `AudioEngineProvider` | Owns the `AudioContext`, exposes `presentTone()`, `stopAll()` | suspended / running / closed / faulted |
| `SessionStateMachine` | The FSM above; single source of truth | (see §7.2) |
| `TelemetryLogger` | Append-only trial log; buffers and flushes | online / buffering / flushing |
| `AbortBanner` | Persistent "Stop test" affordance, always reachable | — |
| `DeviceWatchdog` | Listens for `devicechange`, `visibilitychange`, `AudioContext.statechange` | ok / device_changed / backgrounded |

#### Setup screens

| Component | Purpose | Notes |
|---|---|---|
| `IntakeForm` | Age, ear surgery, noise exposure in last 24 h, tinnitus, current symptoms | BSA requires asking about **recent loud noise exposure** (temporary threshold shift) and **tinnitus** [R2 §5.1] — both must be fields, not optional |
| `RedFlagScreener` | Sudden/rapid loss, unilateral, pain, discharge, vertigo, pulsatile tinnitus | Any positive → halt and route to clinical referral, do not run the test |
| `HeadphoneSelector` | Searchable allow-list + "my model isn't listed" → Tier C path | Shows an image of the model to prevent misselection |
| `WiredCheck` | Attestation + heuristic Bluetooth detection | Blocking |
| `ChannelCheck` | Plays a distinct tone in each cup; user must identify left vs right | Catches reversed headphones — Masalski explicitly lists swapped sides as an error an audiologist would otherwise catch [R4] |
| `VolumeLockPanel` | Instructs setting system volume to the fixed calibration position; explains it must not change | Cannot be enforced programmatically; must be instructed and re-attested |
| `CalibrationWizard` | Tier A/B/C branch; hosts the two-tone reference procedure | Progress, retry, spread-check |
| `AmbientNoiseMeter` | Live one-third-octave bar display + pass/fail per band + dB(A) readout | Give the user actionable advice ("close the window / move away from the fan") |
| `InstructionsPanel` | Text + captioned video + illustration | Must not depend on audio |
| `PracticeTrialRunner` | 3–5 clearly audible trials, no scoring | Confirms the user understands the response task |

#### Test runner

| Component | Purpose | Detail |
|---|---|---|
| `TestRunnerScreen` | Container; deliberately visually sparse | No animation, no colour change synchronised to the stimulus — that is a visual cue and it will inflate hit rates |
| `EarIndicator` | Shows which ear is under test | Static text + icon |
| `ResponseButton` | The single most important control | Min 96×96 px hit area; `Space` and `Enter` bound; press-and-hold optional (BSA's canonical response is *hold while audible, release when it stops* [R2 §6.1]) |
| `ListenPrompt` | "Listen…" / "Did you hear it?" | AMTAS uses a two-screen listen→confirm pattern, with icons deliberately spaced apart to prevent mis-taps [R11] |
| `ProgressIndicator` | Coarse progress only (e.g. "Ear 1 of 2, tone 4 of 9") | **Never** show the current level or the running threshold — it cues the user |
| `TimeoutPrompt` | "Still with us?" after 10 s | Counts toward the 3-timeout abort |
| `FalseAlarmModal` | Re-instruction after repeated responses to silent trials | Wording mirrors AMTAS: respond only when you are sure you heard the tone [R11] |
| `NoiseInterruptOverlay` | Blocks testing while ambient noise is over limit | Shows live meter and a "resume when quiet" state |
| `BreakScreen` | Between ears and at 20 min | Explicit Continue |
| `AbortConfirmDialog` | Confirms intent to stop, saves partial data | Partial sessions are still research data — keep them, mark them `incomplete` |

#### Results

| Component | Purpose | Detail |
|---|---|---|
| `AudiogramChart` | The per-ear plot | Spec in §8 — this is the component most often built wrong |
| `ThresholdTable` | Numeric thresholds with uncertainty | e.g. "25 dB HL (±8)" |
| `DescriptorCard` | Audiometric descriptor per ear | §9.1 |
| `LikelihoodBadge` | Low / Medium / High | Must be accompanied by the confidence tier; never shown alone |
| `ConfidencePanel` | Quality indicators, tier, ambient noise summary, false-alarm rate | §10 |
| `CaveatBlock` | Unmasked/shadow warnings, no bone conduction, no otoscopy | Non-dismissible |
| `ReferralCard` | What to do next; locality-aware | Driven by rules in §9.4 |
| `ExportMenu` | PDF report, CSV of thresholds, JSON of full trial log, FHIR bundle | Research export must include trial-level data |
| `TrendChart` | Threshold over time, same-tier sessions only | Grey out cross-tier comparisons with an explanation |

#### Clinician / researcher console

| Component | Purpose |
|---|---|
| `SessionQueue` | Filter by QC flag, likelihood band, red flag, date |
| `TrialLogViewer` | Every presentation: timestamp, freq, level, response, latency, ambient level |
| `StaircasePlot` | Level-vs-trial-number plot per frequency — the fastest way to spot a bad run |
| `QCPanel` | The nine indicators of §10 with pass/fail |
| `ManualOverride` | Clinician can invalidate a threshold or reclassify, with a mandatory reason and audit trail |
| `ProtocolEditor` | Version-controlled protocol JSON; changing it mints a new version, never mutates in place |
| `ProfileRegistry` | Headphone ETSPL tables, measurement provenance, effective dates |

### 7.4 Button inventory with bindings

| Button | Screen | Keyboard | Behaviour |
|---|---|---|---|
| **I heard it** | Runner | `Space`, `Enter` | Primary response. Debounced 150 ms. Records press *and* release timestamps. |
| **I didn't hear it** | Runner (confirm pattern only) | `N` | Explicit miss; alternative to waiting out the window |
| Start test | Dashboard | — | Creates session, pins protocol version |
| Play tone / Replay | Calibration, channel check | `P` | Unlimited replays in calibration [R4] |
| Louder / Softer (1 dB) | Calibration slider | `↑` / `↓` | 1 dB steps per the validated method [R4] |
| Confirm calibration | Calibration | `Enter` | Locks the value; triggers repeat-run check |
| Left ear / Right ear | Channel check | `L` / `R` | Must be answered correctly to proceed |
| Recheck noise | Environment | `R` | Re-runs the 15 s capture |
| Continue | Every wizard step | `Enter` | Disabled until the step's gate passes |
| Take a break | Runner | `B` | Pauses the FSM; audio suspended |
| Resume | Break | `Enter` | Re-checks ambient noise before resuming |
| **Stop test** | Runner (persistent) | `Esc` | Opens confirm dialog; never stops silently |
| Repeat instructions | Runner | `I` | Re-shows instructions without losing state |
| Download report | Results | — | PDF |
| Export raw data | Results / console | — | JSON trial log |
| Share with clinician | Results | — | Generates a scoped, expiring link |
| Request deletion | Settings | — | Initiates the erasure workflow |
| Sign off / Override | Clinician console | — | Requires reason text; audit-logged |

### 7.5 Accessibility [DESIGN]

- **WCAG 2.2 AA minimum.** Note the obvious: your users have hearing loss, so *nothing*
  procedural may be conveyed by sound. All instructions in text + captioned video.
- Response control must be operable by keyboard, switch device, and touch.
- Respect `prefers-reduced-motion`; there should be almost no motion anyway.
- Do not use colour alone to convey the likelihood band — pair with text and icon.
- Provide instruction text at a low reading level, and translate it. Instructions must be
  in a language and manner appropriate to the participant. [STD, R1]

---

## 8. Audiogram rendering specification

Getting this wrong makes the output unreadable to any clinician. The rules are explicit in
both standards.

| Rule | Value | Source |
|---|---|---|
| **Aspect ratio** | One octave on the x-axis must occupy the same physical distance as **20 dB** on the y-axis (i.e. an octave × 20 dB region is a square) | [STD] R1; R2 §10.1 states it as "20 dB : 1 octave" |
| X-axis | Frequency, **logarithmic**, ascending left → right | [STD] R1 |
| Y-axis | Hearing level in dB, **linear**, ascending **downward**, from **−10 dB** to the audiometer maximum | [STD] R1 |
| Air conduction symbols | Right = **O**, Left = **X**; connect with **continuous straight lines** | [STD] R1 (ASHA 1990 symbols), R2 §10.2 |
| No response | Symbol with a **downward arrow** attached to the corner, plotted at the highest level presented, and **not connected** to adjacent symbols | [STD] R2 §10.2 |
| Possible shadow (unmasked, interaural Δ ≥ 40 dB) | Shaded/half-filled symbol per BSA "working audiogram" convention | [STD] R2 §10.3 |
| Legend | Explanation of all symbols, always present | [STD] R1 |

**Mandatory report metadata** — ASHA lists these as the minimum contents of any audiogram,
graphic or tabular. Your PDF must carry all of them: [STD, R1]

- Date and location of test
- Names of participant, tester, referral source
- Tester credentials (or, here, an explicit "self-administered, unsupervised" statement)
- Description of test equipment: device, transducer model, software version
- **Calibration information** — tier, method, date, profile version
- Thresholds for every frequency, each ear, by air conduction (and a statement that bone
  conduction was not performed)
- Explanation of all symbols
- Observations about conditions that may have influenced results (ambient noise events,
  device changes, tinnitus reported)
- **Assessment of test reliability** — this is where the QC panel of §10 belongs
- Reason for the evaluation
- Description of any non-standard method used (e.g. "pulsed tone substituted",
  "self-administered web-based ascending method")

---

## 9. Classification and hearing-loss likelihood

### 9.1 Descriptor (deterministic, standards-based)

Compute both; they answer different questions and use different frequency sets.

**WHO 2021 grades** — based on the **four-frequency PTA (500, 1000, 2000, 4000 Hz)** in the
**better ear**; normal is **< 20 dB HL**. [STD, R3]

| Grade | PTA₄, better ear (dB HL) |
|---|---|
| Normal hearing | < 20 |
| Mild | 20 – < 35 |
| Moderate | 35 – < 50 |
| Moderately severe | 50 – < 65 |
| Severe | 65 – < 80 |
| Profound | 80 – < 95 |
| Complete / total | ≥ 95 |

**BSA descriptors** — based on the average of **250, 500, 1000, 2000 and 4000 Hz** for an
**individual ear**. Note the different frequency set and different bands; do not conflate
the two. [STD, R2 §9]

| Descriptor | Average (dB HL) |
|---|---|
| Mild | 21 – 40 |
| Moderate | 41 – 70 |
| Severe | 71 – 95 |
| Profound | > 95 |

BSA rule for averaging when a frequency is a no-response due to severity: **assign it
130 dB HL**. [STD, R2 §9]

BSA also attaches an important caveat that should be surfaced in your UI: descriptors
must **not** be the sole determinant of whether someone needs hearing support, and the
ability to detect pure tones in quiet is **not** a reliable indicator of real-world
disability in noise — which is the primary complaint of most people with hearing loss.
[STD, R2 §9]

### 9.2 The likelihood model — low / medium / high

The requester asked for a probability. The defensible way to produce one — rather than
inventing a score — is to treat it as **the probability that the participant's true PTA₄
exceeds the WHO normal-hearing cut-off of 20 dB HL, given a measurement with known
error**.

#### Step 1 — measurement uncertainty by tier [LIT, derived from R4]

Masalski & Kręcicki report, for the **mean threshold across frequencies** (which is what a
PTA is), a difference from clinical audiometry of:

- **supervised, pre-calibrated PC (≈ our Tier B): −1.52 dB, SD 5.42 dB, r = .94**
- **unsupervised at home, biologically calibrated (≈ our Tier C): −1.44 dB, SD 7.59 dB,
  r = .89** [R4, Table 1, "Mean" rows]

This is empirically consistent with their error decomposition, since calibration error
(σ_cal = 6.19 dB) is **common to all frequencies and therefore does not average down**,
while the per-frequency procedural error (σ_proc = 6.64 dB) does:

```
σ_PTA ≈ √( σ_cal² + σ_proc²/k )    with k = 4 frequencies
      ≈ √( 6.19² + 6.64²/4 ) ≈ 7.0 dB      → matches the observed 7.59 dB
```

Use these defaults, and **re-estimate them from your own validation study**:

| Tier | σ_PTA (dB) | Bias correction (dB) |
|---|---|---|
| A — reference transducer, coupler-calibrated | **4.5** [DESIGN, bracketed by R4's 4.25 dB clinical single-measurement SD and R5's 3.6 dB automated-vs-manual mean absolute difference] |
| B — profiled consumer headphone | **5.4** [LIT, R4] | +1.5 |
| C — biological calibration | **7.6** [LIT, R4] | +1.4 |

(The bias corrections are the sign-flipped mean differences from R4; web tests read
slightly *better* than clinical, so correct upward.)

#### Step 2 — the probability [DESIGN]

```
PTA₄(ear)   = mean of thresholds at 500, 1000, 2000, 4000 Hz
PTA_better  = min(PTA₄_left, PTA₄_right)          # WHO uses the better ear
PTA_adj     = PTA_better + bias_correction(tier)

P(hearing loss) = Φ( (PTA_adj − 20) / σ_PTA(tier) )
```

where Φ is the standard normal CDF and 20 dB HL is the WHO normal-hearing boundary. [R3]

#### Step 3 — banding [DESIGN — thresholds must be tuned on your own ROC]

| Band | Probability | Equivalent measured PTA₄ at Tier C (σ = 7.6) |
|---|---|---|
| **Low** | P < 0.25 | < ~14 dB HL |
| **Medium** | 0.25 ≤ P ≤ 0.75 | ~14 – 24 dB HL |
| **High** | P > 0.75 | > ~24 dB HL |

Worked examples (Tier C):

| Measured PTA₄ (better ear) | Adjusted | z | P | Band |
|---|---|---|---|---|
| 8 dB HL | 9.4 | −1.39 | 0.08 | Low |
| 15 dB HL | 16.4 | −0.47 | 0.32 | Medium |
| 20 dB HL | 21.4 | +0.18 | 0.57 | Medium |
| 28 dB HL | 29.4 | +1.24 | 0.89 | High |
| 45 dB HL | 46.4 | +3.47 | >0.99 | High |

Note how the band widths narrow at Tier A and widen at Tier C. That is the point: the
same audiogram should not produce the same confidence from a coupler-calibrated rig and a
self-calibrated laptop, and this model makes that difference explicit rather than hiding
it.

#### Step 4 — mandatory overrides [DESIGN]

These take precedence over the computed band:

| Condition | Outcome |
|---|---|
| Any red flag from the intake screener | **Refer urgently.** Do not display a probability at all. |
| Interaural PTA₄ difference ≥ 15 dB, or ≥ 20 dB at any two adjacent frequencies | **High + refer** (possible asymmetric loss; also invokes the unmasked-shadow caveat of §1.3). Thresholds for this rule are a clinical-lead decision, not a standard. |
| Any threshold recorded as **No Response** at the output cap | **High + refer** |
| QC composite = *Poor* (§10) | Suppress the band. Show **"Indeterminate — retest required"** and the specific reason. A wrong number is worse than no number. |
| Ambient noise limit exceeded on > 15% of trials | Same as above |
| `unstable_1k = true` (retest Δ > 5 dB) | Downgrade confidence one level; annotate the report |

#### Step 5 — what to *say*

Never render "you have hearing loss". Render, for example:

> **Higher likelihood of hearing loss.** This screening test suggests your hearing in the
> better ear averages about 28 dB HL across the speech frequencies, which is above the
> 20 dB HL that the World Health Organization uses as the boundary for normal hearing.
> This is a screening result from an unsupervised, self-calibrated test — it is not a
> diagnosis, it did not test bone conduction, and no one examined your ears. Please
> arrange a full hearing test with an audiologist.

### 9.3 Expected diagnostic performance, for realistic expectations [LIT]

- Masalski & Kręcicki's self-administered home web audiometry achieved **sensitivity 0.89
  (95% CI 0.74–1.0) and specificity 0.89 (0.76–1.0)** for detecting a noise-induced
  hearing loss pattern; the supervised, pre-calibrated condition reached 0.92 / 0.96. [R4]
- A 2025 systematic review of self-administered web- and app-based audiometric tools found
  **sensitivity ranging from 18% to 100% and specificity from 35.5% to 99.1%** across
  studies, with heterogeneity in hearing-loss definitions, environments, and headphone
  types cited as the limiting factor. [R12]

The spread in that second figure is the most important number in this document. It means
**a browser audiometer's accuracy is a property of your specific implementation, not of
the category**, and it is why §11 is non-optional.

### 9.4 Referral routing [DESIGN — requires clinical sign-off]

| Trigger | Action |
|---|---|
| Any red flag (sudden onset, unilateral, otalgia, otorrhoea, vertigo, pulsatile tinnitus) | Urgent ENT referral; test not run or results suppressed |
| High band | Audiologist referral |
| Medium band | Repeat test under better conditions; if still Medium, audiologist referral |
| Low band, symptomatic (self-reported difficulty in noise) | Recommend a speech-in-noise test — pure-tone thresholds in quiet do not capture this [STD, R2 §9] |
| Low band, asymptomatic | Retest interval per your programme (e.g. annual, or per occupational schedule) |
| Recent loud-noise exposure reported (< 24 h) | BSA: results may reflect temporary threshold shift — **retest after a noise-free interval** [STD, R2 §5.1] |

---

## 10. Quality control

Adopt the AMTAS **QUALIND** indicator set, which was developed precisely to let an
automated test tell you when to distrust its own output. In the validation of AMTAS in
children and adults, QUALIND identified inaccurate audiograms with **sensitivity 71% and
specificity 91%**; when QUALIND-flagged audiograms were excluded, the automated test's
accuracy approached that of manual audiometry. [LIT, R13]

The nine indicators, as documented for the commercial implementation: [LIT, R11]

| # | Indicator | Browser implementation |
|---|---|---|
| 1 | Predicted accuracy (Good / Fair / Poor) | Composite regression over indicators 3–9; fit on your own validation data |
| 2 | Predicted average absolute difference | Model output in dB; the headline "how far off are we" number |
| 3 | Masker alerts | **N/A** — no masking. Replace with **shadow alerts** per §1.3 |
| 4 | Time per trial | Mean stimulus→response latency; long or erratic latency signals inattention |
| 5 | False alarm rate | Responses on silent catch trials ÷ number of catch trials |
| 6 | Average test–retest difference | The 1 kHz retest Δ (§6.4) |
| 7 | Quality check fail rate | Non-responses to the threshold + 5 dB probe ÷ number of thresholds |
| 8 | Air–bone gap > 35 dB count | **N/A** — no bone conduction |
| 9 | Air–bone gap < −10 dB count | **N/A** — no bone conduction |

**[DESIGN] Add four indicators specific to browser delivery**, replacing the three that
require bone conduction and masking:

| # | Indicator | Fail condition (starting values — tune them) |
|---|---|---|
| 10 | Ambient noise exceedance rate | > 15% of trials interrupted, or any band > MPANL + 10 dB |
| 11 | Calibration spread | Repeat-calibration range > 5 dB, or 250 Hz / 4 kHz check disagrees with the model by > 10 dB |
| 12 | Session integrity | Any output-device change, tab-hidden event during a trial, or `AudioContext` suspension |
| 13 | Level-clamp events | Any request for a level above the profile cap |

Every indicator is stored with the session and rendered in the `ConfidencePanel`. The
composite drives the *Indeterminate* override in §9.4.

---

## 11. Validation plan for your own build

Do not ship a likelihood number that has not been validated against a reference. Minimum
credible design:

| Element | Specification |
|---|---|
| Design | Prospective, within-subject, counterbalanced order, cross-sectional validation — the design used by both Masalski [R4] and the HEARZAP web-audiometer validation [R14] |
| Reference standard | Clinical audiometer calibrated to ANSI S3.6 / IEC 60645-1, supra-aural or insert earphones, sound-treated booth, manual ascending method by a qualified audiologist |
| Sample | ≥ 50 participants / 100 ears, **stratified** to include normal hearing and each severity band. HEARZAP used 50 participants split 25 normal / 25 with loss [R14]; Masalski used 51 (102 ears) with a spread across severities [R4] |
| Frequencies | Every frequency your product reports |
| Conditions | Test each tier (A/B/C) separately; test in booth **and** in the intended real-world environment |
| Primary endpoints | Mean difference and SD per frequency; **Bland–Altman** limits of agreement; **% of thresholds within ±5 dB and ±10 dB** of reference (a widely used benchmark; e.g. extended-high-frequency smartphone audiometry reported 86.7–93.4% of test–retest thresholds within 10 dB [R15]) |
| Reliability | Test–retest ICC per frequency; within-subject SD |
| Diagnostic accuracy | Sensitivity, specificity, PPV, NPV, Youden index against the WHO PTA₄ ≥ 20 dB HL criterion, with 95% CIs. Report the full ROC and choose your Low/Medium/High cut-points from it rather than the defaults in §9.3 |
| Regression | Deming regression, not OLS — the reference measurement also carries error [R4] |
| Reporting | Follow STARD for diagnostic accuracy, and CONSORT-EHEALTH for the digital intervention description |

**Benchmark to beat:** two experienced audiologists testing the same patient differ by a
mean absolute **4.1 dB** for air conduction. [LIT, R5] If your Tier A pipeline lands
within that, it is performing at the level of inter-clinician variability. Tier C will
not, and should not claim to.

---

## 12. Data model

### 12.1 Core entities

```jsonc
// Session
{
  "session_id": "uuid",
  "participant_id": "uuid",
  "protocol_version": "asha-ac-v1.3",       // immutable pin
  "consent_version": "2026-03-01",
  "mode": "threshold | screening",
  "supervision": "unsupervised | technician | clinician",
  "started_at": "ISO8601", "completed_at": "ISO8601",
  "status": "complete | incomplete | aborted | invalidated",
  "abort_reason": "timeouts | device_change | user | noise | null",
  "device": {
    "user_agent": "...", "platform": "...",
    "audio_output_label": "...", "sample_rate": 48000,
    "headphone_profile_id": "sennheiser-hd280-v2",
    "transducer_type": "circumaural",
    "connection": "wired"
  },
  "calibration": {
    "tier": "A|B|C",
    "method": "coupler | model_profile | biological_1k",
    "reference_runs": [{"level_db": 0.0, "operator_age_band": "18-35"}],
    "spread_db": 2.5,
    "cross_check_250hz_delta_db": 4.0,
    "profile_version": "2026-02-10",
    "calibrated_at": "ISO8601"
  },
  "environment": {
    "pretest_dba": 31.2,
    "pretest_third_octave": {"250": 18.0, "500": 17.1, "...": 0},
    "mpanl_table": "iso8253-1_supra_0dbhl + circumaural_credit",
    "test_floor_db": 0,
    "exceedance_trial_count": 3,
    "exceedance_rate": 0.04
  }
}
```

```jsonc
// Trial — the atomic research record. Append-only.
{
  "trial_id": "uuid", "session_id": "uuid", "seq": 47,
  "ear": "right|left",
  "frequency_hz": 2000,
  "level_db_hl": 25,
  "phase": "familiarisation | descent | ascent | qc_probe | catch",
  "is_catch_trial": false,
  "presented_at_ms": 1234567.89,          // AudioContext clock
  "duration_ms": 1520,
  "isi_ms": 3120,
  "responded": true,
  "response_latency_ms": 640,
  "response_in_window": true,
  "ambient_dba_at_trial": 30.8,
  "discarded": false, "discard_reason": null
}
```

```jsonc
// Threshold
{
  "ear": "right", "frequency_hz": 2000,
  "threshold_db_hl": 25,
  "status": "measured | no_response | unresolved | invalidated",
  "ascending_hits": 2, "ascending_trials": 3,
  "qc_probe_pass": true,
  "possible_shadow": false,
  "uncertainty_db": 7.6,
  "is_interoctave": false
}
```

```jsonc
// Classification
{
  "pta4_right": 22.5, "pta4_left": 27.5, "pta4_better": 22.5,
  "bsa_avg5_right": 21.0, "bsa_avg5_left": 26.0,
  "who_grade_better_ear": "mild",
  "bsa_descriptor_right": "mild", "bsa_descriptor_left": "mild",
  "bias_correction_db": 1.4, "sigma_pta_db": 7.6,
  "p_hearing_loss": 0.62,
  "band": "medium",
  "overrides_applied": ["none"],
  "asymmetry_db": 5.0,
  "qc_composite": "fair",
  "referral": "repeat_then_refer"
}
```

### 12.2 Interoperability [DESIGN]

Export audiograms as **HL7 FHIR** `Observation` resources (LOINC codes exist for
frequency-specific air-conduction thresholds), bundled under a `DiagnosticReport`, so the
data can enter an EHR. In India, align with **ABDM** requirements if the deployment is
clinical.

### 12.3 Privacy and security [DESIGN]

- Audiometric data is health data: **DPDP Act 2023** (India), **GDPR** Art. 9 (EU),
  **HIPAA** (US) as applicable.
- Encrypt at rest and in transit; separate identifiers from measurement data with a
  pseudonymisation key held in a separate store.
- Role-based access: participant / clinician / researcher / admin. Researchers get
  pseudonymised exports by default.
- Full audit log for every clinician override.
- Explicit retention schedule and a working deletion workflow.
- Consent must be **versioned** and re-collected when the version changes, with the
  version pinned into every session record.

---

## 13. Build sequence [DESIGN]

| Phase | Deliverable | Exit criterion |
|---|---|---|
| 0 | Standards procurement (§2), clinical lead and regulatory posture agreed | Signed protocol document |
| 1 | Audio engine + Tier A calibration on reference hardware; coupler verification | Measured output within ANSI S3.6 tolerance at every frequency; crosstalk and distortion verified |
| 2 | Staircase FSM + trial logging + `StaircasePlot` | Simulated-listener test suite: recovers a known threshold within ±5 dB over 10,000 synthetic runs at varying false-alarm rates |
| 3 | Full runner UI, instructions, practice, QC probes, catch trials | Usability round with 10 naive users; zero procedural misunderstandings |
| 4 | Environment gate + ambient monitoring | Verified against a calibrated sound level meter |
| 5 | Audiogram renderer + report per §8 | Reviewed and accepted by two audiologists as clinically legible |
| 6 | Tier B profile registry; Tier C biological calibration | Repeat-calibration spread < 5 dB in 90% of runs |
| 7 | **Validation study per §11** | Pre-registered; results published or filed |
| 8 | Classification model re-fit on validation ROC; QUALIND composite fit | Cut-points and σ values replaced with empirical ones |
| 9 | Clinician console, exports, referral routing | Clinical sign-off |

Phases 7 and 8 are where the product actually becomes defensible. Everything before them
is scaffolding.

---

## 14. Summary of the operating flow

```
LOGIN
  → consent (versioned)
  → intake + red-flag screener ──(flag)──▶ HALT, urgent referral
  → headphone selection (allow-list, wired only)
  → L/R channel verification
  → system volume set to fixed position, attested
  → calibration  (Tier A coupler | Tier B profile | Tier C biological 1 kHz two-tone)
  → ambient noise gate  (1/3-octave vs MPANL + transducer credit; 35 dB(A) backstop)
  → instructions (text + captioned video) + practice trials
  → EAR 1 (better ear by self-report)
        familiarisation @ 1 kHz, 40 dB HL, +10 dB steps
        1000 → 2000 → 3000 → 4000 → 6000 → 8000 Hz
        staircase: 10 dB down after response, 5 dB up after miss
        threshold: ≥2 responses at the lowest level on ≥50% of ascents
        QC probe at threshold and threshold+5 dB after each frequency
        catch trials ~10%, re-instruction after 2 false alarms
        retest 1000 Hz  → Δ ≤ 5 dB: take better | Δ > 5 dB: re-instruct + retest
        500 → 250 Hz
        inter-octaves inserted where adjacent octaves differ ≥ 20 dB
  → 30 s break
  → EAR 2 (same order, no 1 kHz retest unless ear 1 was unstable)
  → QC evaluation (13 indicators)
  → audiogram render (20 dB : 1 octave, O/X, arrows for NR, shaded for shadow)
  → PTA₄ → WHO grade + BSA descriptor
  → P(hearing loss) = Φ((PTA_adj − 20)/σ_tier) → Low / Medium / High
  → overrides (red flag, asymmetry, NR, poor QC → Indeterminate)
  → report + referral + export
```

---

## 15. References

**[R1]** American Speech-Language-Hearing Association. (2005). *Guidelines for Manual
Pure-Tone Threshold Audiometry* [Guidelines]. doi:10.1044/policy.GL2005-00014 —
https://www.asha.org/policy/gl2005-00014/

**[R2]** British Society of Audiology. (2018). *Recommended Procedure: Pure-tone
air-conduction and bone-conduction threshold audiometry with and without masking*,
OD104-32, August 2018 —
https://www.thebsa.org.uk/wp-content/uploads/2023/10/OD104-32-Recommended-Procedure-Pure-Tone-Audiometry-August-2018-FINAL-1.pdf

**[R3]** World Health Organization. (2021). *World report on hearing*. Grades of hearing
loss based on the four-frequency (500, 1000, 2000, 4000 Hz) pure-tone average in the
better ear; normal hearing defined as thresholds of 20 dB or better —
https://www.who.int/news-room/fact-sheets/detail/deafness-and-hearing-loss

**[R4]** Masalski, M., & Kręcicki, T. (2013). Self-test web-based pure-tone audiometry:
validity evaluation and measurement error analysis. *Journal of Medical Internet
Research*, 15(4), e71. doi:10.2196/jmir.2222 — PMC3636315

**[R5]** Margolis, R. H., Glasberg, B. R., Creeke, S., & Moore, B. C. J. (2010). AMTAS®:
Automated method for testing auditory sensitivity: Validation studies. *International
Journal of Audiology*, 49(3), 185–194. doi:10.3109/14992020903092608

**[R6]** Swanepoel, D. W., Matthysen, C., Eikelboom, R. H., Clark, J. L., & Hall, J. W.
(2015). Pure-tone audiometry outside a sound booth using earphone attenuation, integrated
noise monitoring, and automation. *International Journal of Audiology*, 54(11), 777–785.

**[R7]** Margolis, R. H., Saly, G. L., & Wilson, R. H. (2022). Ambient noise monitoring
during pure-tone audiometry. *Journal of the American Academy of Audiology*, 33(1), 45–56.
doi:10.1055/s-0041-1735803

**[R8]** Referenced within R7: equivalent threshold sound pressure levels for Radioear
DD65v2 circumaural audiometric headphones, *International Journal of Audiology*, 59(8),
624–630 (2020). Use as a worked example of how a transducer ETSPL table is established.

**[R9]** Tablet-audiometer validation reporting calibration crosstalk and linearity
failures on initial assessment (summarised in the hearTest/uHear comparative literature) —
see R12 for the systematic synthesis.

**[R10]** Meinke, D. K., & Martin, W. H. (2023). Boothless audiometry: Ambient noise
considerations. *Journal of the Acoustical Society of America*, 153(1), 26–39.
doi:10.1121/10.0016362

**[R11]** Lombardo, T. (2018). GSI AMTAS: Automated hearing assessment. *AudiologyOnline*,
Article 24086. Documents the nine QUALIND quality indicators, the 10-second timeout /
three-timeout abort behaviour, the listen→confirm screen pattern, catch-trial
re-instruction, the threshold+5 dB quality check, the ≥20 dB inter-octave trigger, and the
screening configuration (≥3 frequencies at 20 or 25 dB HL). Vendor-sponsored article —
cross-check technical claims against R5 and R13.

**[R12]** *The Accuracy of Self-Administered Web- and App-Based Tools for Audiometric
Tests — A Systematic Review*. (2025). *Audiology Research*, 15(3), 73.
doi:10.3390/audiolres15030073 — reports sensitivity 18–100%, specificity 35.5–99.1% across
studies.

**[R13]** Margolis, R. H., Frisina, R., & Walton, J. P. (2011). AMTAS®: Automated method
for testing auditory sensitivity: II. Air conduction audiograms in children and adults.
*International Journal of Audiology*. QUALIND detected inaccurate audiograms with 71%
sensitivity and 91% specificity. PMID 21417674.
Underlying method: Margolis, R. H., Saly, G. L., Le, C., & Laurence, J. (2007). Qualind™:
A method for assessing the accuracy of automated tests. *JAAA*, 18(12).

**[R14]** Renganath, P. P., & Ramkumar, V. (2023). Validation of web-based audiometry
version of HEARZAP. *PLOS ONE*, 18(3), e0283519. doi:10.1371/journal.pone.0283519 —
50 participants (100 ears), 25 normal / 25 with hearing loss, web audiometer with Radioear
DD65v2 and B71 calibrated to ANSI S3.6 and IEC 60645-1.

**[R15]** Extended high-frequency smartphone audiometry: validity and reliability.
*Journal of the American Academy of Audiology*, 30(3) (2019) — test–retest thresholds
within 10 dB in 86.7% (audiometric headphones) and 93.4% (non-standard headphones) of
cases.

**Foundational method references** (cited within R1):
Carhart, R., & Jerger, J. F. (1959). Preferred method for clinical determination of
pure-tone thresholds. *Journal of Speech and Hearing Disorders*, 24, 330–345.
Hughson, W., & Westlake, H. D. (1944). Manual for program outline for rehabilitation of
aural casualties both military and civilian. *Transactions of the American Academy of
Ophthalmology and Otolaryngology*, 48(Suppl.), 1–15.

---

## 16. Open items requiring your decision or procurement

1. **[VERIFY]** IEC 60645-1: tone rise/fall time limits, frequency tolerance, harmonic
   distortion limits, crosstalk limits. Fill into §4.
2. **[VERIFY]** ISO 389-8 RETSPL values for circumaural earphones; measured ETSPLs for
   every headphone on your allow-list.
3. **[VERIFY]** ISO 8253-1 / ANSI S3.1 one-third-octave MPANL tables (BSA Appendix C
   reproduces the ISO 8253-1 air-conduction table if you need a starting point).
4. **[DECIDE]** Pulsed vs continuous tone — ASHA permits pulsed and notes it improves
   stimulus awareness; BSA advises against it. Pick one, document it, hold it fixed.
5. **[DECIDE]** ASHA frequency order (includes 3 and 6 kHz) vs BSA order.
6. **[DECIDE]** Regulatory posture: wellness tool, regulated screening device, or
   research-use-only.
7. **[DECIDE]** Asymmetry referral thresholds — clinical lead sign-off required.
8. **[DO]** Run the validation study of §11 before the likelihood model ships with
   anything other than the literature-default σ values.
