# Gap Analysis: Professor's Spec vs. Current Implementation

**Source spec:** `Browser_audiometry_digitization_spec.md`  
**Date:** September 2026  
**Analyst:** Kiro (AI-assisted review)

This document compares the current AuroHear implementation against the technical
specification provided in `Browser_audiometry_digitization_spec.md`. Each gap is tagged
with the relevant spec section and the affected source file(s).

---

## 🔴 Critical — Core Audiometry Protocol Errors

These gaps directly compromise the correctness of measured thresholds.

### 1. Level range capped at 40 dB HL

**Spec §6.3:** Level lattice runs from −10 dB HL to `min(profile_cap, 90 dB HL)`.  
**Current:** `algorithms.py` hard-caps the upper bound at `min(40, old_level + 5)`.  
Anyone with moderate-to-profound hearing loss (>40 dB HL) will never be detected — the
staircase loops at the ceiling instead of ascending further.  
**Files:** `backend/utils/algorithms.py` → `process_test_response()`

---

### 2. Threshold termination criterion is wrong

**Spec §6.3:** Threshold = lowest level with ≥2 responses on ≥50% of ascending runs
(minimum 2 ascending hits at that level) — the actual Hughson-Westlake reversal-counting
criterion.  
**Current:** Threshold fires after 12 total trials (trial-count-based). The condition
`heard AND new_level == old_level` that exists in the code is practically impossible to
trigger naturally.  
**Files:** `backend/utils/algorithms.py` → `process_test_response()`, `compute_threshold()`

---

### 3. Frequency order is non-standard

**Spec §6.4 (ASHA order):** `1000 → 2000 → 3000 → 4000 → 6000 → 8000 → 1000 (retest)
→ 500 → 250 Hz`, starting in the better ear.  
**Current:** `[5000, 4000, 2000, 1000, 500, 250]` — descending order, no familiarization
at 1000 Hz, and the test alternates right-left at each frequency instead of completing
one ear first.  
**Files:** `backend/utils/algorithms.py` → `initialize_test_state()`

---

### 4. Missing frequencies (3000 Hz, 6000 Hz, inter-octaves)

**Spec §6.4:** ASHA 2005 explicitly includes **3000 Hz and 6000 Hz** (important for
noise-induced and occupational loss). Additionally, inter-octave frequencies (750, 1500,
3000, 6000 Hz) must be conditionally inserted when adjacent octave thresholds differ by
≥20 dB.  
**Current:** Tests only 6 frequencies; 3000 Hz and 6000 Hz are absent; no inter-octave
insertion logic exists.  
**Files:** `backend/utils/algorithms.py` → `initialize_test_state()`, `static/script.js`

---

### 5. Starting level per frequency is always 40 dB

**Spec §6.3:** After the first frequency, each subsequent frequency starts at
`previous_threshold + 30 dB` (clamped to the profile cap).  
**Current:** Every frequency restarts from a fixed 40 dB HL regardless of prior results.  
**Files:** `backend/utils/algorithms.py` → `initialize_test_state()`, `process_test_response()`

---

### 6. No "No Response" (NR) handling

**Spec §3.4 / §8:** When the ceiling level is reached without a response, the threshold
must be recorded as **NR at that level** and plotted with a downward arrow, unconnected
to adjacent symbols.  
**Current:** Missing thresholds are silently filled with `40.0 dB` as a default, masking
the true ceiling-hit condition.  
**Files:** `backend/utils/algorithms.py` → `finalize_test_results()`

---

### 7. Server ignores `level_db` for WAV amplitude

**Spec §4:** The dB HL level must drive the actual output amplitude.  
**Current:** `audio.py` receives `level_db` but always generates the tone at a fixed
amplitude of `0.6`. The dB→gain mapping only works in the Web Audio API path. In the
`<audio>` element fallback path, the conversion is non-calibrated custom scaling.  
**Files:** `backend/utils/audio.py` → `generate_tone_response()`

---

### 8. Tone duration too short and non-randomised

**Spec §4:** Tone duration = **1.5 s ± 0.3 s randomised**.  
**Current:** Fixed at 0.35 s. Short, predictable tones increase false-positive rates and
deviate from both ASHA and BSA guidelines (1–3 s).  
**Files:** `backend/utils/audio.py`, `static/script.js` → `playTestTone()`

---

### 9. Inter-stimulus interval is fixed and too short

**Spec §4:** ISI must be varied and **never shorter than the tone** (~1.5–4.5 s uniform
random). Predictable timing is the primary source of false positives.  
**Current:** Fixed 300 ms (`INTER_TONE_GAP_MS`).  
**Files:** `static/script.js` → `AudioStateManager`, `INTER_TONE_GAP_MS`

---

### 10. Tone ramp is linear, not raised-cosine

**Spec §4:** Rise/fall must be a **raised-cosine ramp** conforming to IEC 60645-1. An
un-ramped or linear gate produces a broadband click detectable well below the tone
threshold.  
**Current:** 10 ms `np.linspace` (linear) fade in both the server WAV path and the Web
Audio API path.  
**Files:** `backend/utils/audio.py`, `static/script.js` → `playWebAudioTone()`

---

### 11. No `AudioContext` suspension / device-change abort

**Spec §4.1:** If the output device changes mid-session (`navigator.mediaDevices.
ondevicechange`), the session must be aborted. If the tab is hidden (`Page Visibility
API`), the active trial must be discarded.  
**Current:** Neither event is monitored.  
**Files:** `static/script.js`

---

## 🟠 Important — Missing Clinical & Protocol Features

### 12. No familiarization procedure

**Spec §6.2:** Before threshold search, run a familiarization at 1000 Hz starting at
40 dB HL, ascending in 10 dB steps until 2 consecutive consistent responses are obtained.  
**Current:** Not implemented. The test jumps straight into threshold search.  
**Files:** `backend/utils/algorithms.py`, `static/script.js`

---

### 13. No 1000 Hz retest

**Spec §6.4 (ASHA):** After completing all frequencies on the first ear, **retest 1000 Hz**.
If Δ > 5 dB, re-instruct, retest a third time, and set QC flag `unstable_1k = true`.  
**Current:** Not implemented.  
**Files:** `backend/utils/algorithms.py`

---

### 14. No false-alarm re-instruction modal

**Spec §6.3:** On the **second false alarm** (response to a catch trial), display an
on-screen re-instruction modal: "respond only when you are sure you heard the tone."  
**Current:** Catch trials are tracked client-side, but no intervention fires on repeated
false alarms.  
**Files:** `static/script.js` → `processCatchTrialResponse()`

---

### 15. No inter-ear break

**Spec §6.6 / §7.2:** A mandatory **30-second break** with an explicit "Continue" button
is required between ears.  
**Current:** Not implemented — the test transitions between ears without pause.  
**Files:** `static/script.js`, `templates/index.html`

---

### 16. No timeout handling

**Spec §6.3:** If no response for **10 seconds**, show a "Still there?" prompt. After **3
timeouts** in a session, abort to the finish screen.  
**Current:** Not implemented. Silent non-responses just wait indefinitely.  
**Files:** `static/script.js` → `runTest()`

---

### 17. No Quality Control (QUALIND) indicators

**Spec §10:** Defines 9–13 QC indicators including: false alarm rate, time per trial,
quality check probe at threshold+5 dB, 1 kHz retest Δ, ambient noise exceedance rate,
calibration spread, session integrity events, level-clamp events. A composite QC score
drives the "Indeterminate — retest required" outcome that suppresses the likelihood band.  
**Current:** Only a client-side false-alarm ratio is tracked. No composite QC score, no
QC probe after each threshold, no "Indeterminate" output.  
**Files:** `backend/utils/algorithms.py`, `static/script.js`

---

### 18. Audiogram aspect ratio is wrong

**Spec §8:** One octave on the x-axis must equal **20 dB** on the y-axis (a 1-octave ×
20 dB region is a square).  
**Current:** Chart.js chart uses `maintainAspectRatio: false` with no enforcement of the
clinical 20 dB : 1 octave ratio.  
**Files:** `static/script.js` → `showResultsScreen()` Chart.js config

---

### 19. Wrong audiometric symbols

**Spec §8 (ASHA 1990):** Right ear = **O** (circle), Left ear = **X** (cross), connected
by continuous straight lines.  
**Current:** Both ears use generic circle points, distinguished only by color (blue/red).  
**Files:** `static/script.js` → Chart.js dataset config

---

### 20. Y-axis range too small on audiogram

**Spec §8:** Y-axis must run from **−10 dB HL** at the top to the audiometer maximum
(≥90 dB HL) at the bottom.  
**Current:** Y-axis is `min: -10, max: 40` — moderate and severe hearing loss is off the
chart.  
**Files:** `static/script.js` → Chart.js `scales.y` config

---

### 21. No "No Response" arrow on audiogram

**Spec §8:** NR thresholds must render as a **downward arrow at the cap level, not
connected to adjacent symbols**.  
**Current:** No NR symbol logic exists.  
**Files:** `static/script.js` → `showResultsScreen()`

---

### 22. No shadow/unmasked threshold symbol

**Spec §1.3:** If |threshold_L − threshold_R| ≥ 40 dB at any frequency, the poorer-ear
threshold must be rendered as a **half-filled symbol** labeled "possible shadow —
unmasked", excluded from PTA, and a clinical referral outcome forced.  
**Current:** Not implemented. A >40 dB interaural difference is not flagged differently
from any other asymmetry.  
**Files:** `static/script.js`, `backend/utils/algorithms.py`

---

### 23. Classification uses asymmetry only — missing WHO grading and BSA descriptor

**Spec §9.1–9.2:** Results must include:
- **WHO 2021 grade** — 4-frequency PTA (500, 1000, 2000, 4000 Hz) in the better ear,
  with grades: Normal (<20), Mild (20–34), Moderate (35–49), Moderately severe (50–64),
  Severe (65–79), Profound (80–94), Complete (≥95).
- **BSA descriptor** — average of 250, 500, 1000, 2000, 4000 Hz per individual ear.
- **Probabilistic likelihood band** (Low/Medium/High) derived from
  `P = Φ((PTA_adj − 20) / σ_tier)`, with calibration tier affecting σ.

**Current:** Binary asymmetry flag only (≥20 dB max difference). No WHO grade, no BSA
descriptor, no probabilistic model.  
**Files:** `backend/utils/algorithms.py` → `finalize_test_results()`, `static/script.js`
→ `showResultsScreen()`

---

## 🟡 Moderate — Setup, Calibration & Environment

### 24. No headphone selection or wired-only enforcement

**Spec §3.3:** User must select a headphone model from a versioned allow-list; Bluetooth
headphones must be blocked (via output device label heuristics + user attestation).  
**Current:** No headphone selection step; Bluetooth detection absent.  
**Files:** `templates/index.html`, `static/script.js`

---

### 25. No proper channel verification gate

**Spec §7.3 (`ChannelCheck`):** Plays a distinct tone in each cup; user must identify
left vs. right correctly before proceeding. Wrong answer is blocking.  
**Current:** The device check screen has L/R buttons but no gating — the user can proceed
regardless of response.  
**Files:** `templates/index.html`, `static/script.js`

---

### 26. No calibration tiers or biological calibration procedure

**Spec §3.2:** A validated two-tone 1 kHz biological calibration procedure (Masalski
method) must be offered as Tier C. Tiers A (reference transducer) and B (profiled
consumer headphone) affect the σ used in the likelihood model.  
**Current:** Only a volume slider exists with no structured calibration logic. The
calibration tier is never recorded.  
**Files:** `static/script.js`, `backend/models/screening_sessions.py`

---

### 27. No ambient noise gate

**Spec §5:** Requires:
1. Pre-test 15 s microphone capture with FFT → one-third-octave bands vs. MPANL table.
2. Broadband 35 dB(A) backstop gate.
3. Continuous monitoring during the test — any trial where noise exceeds the limit must
   be discarded and re-presented.
4. Ambient spectrum stored with the session record.

**Current:** No microphone capture, no noise gate.  
**Files:** `static/script.js`, `backend/models/screening_sessions.py`

---

### 28. Trial-level data is not stored

**Spec §12.1:** The `Trial` entity is the "atomic research record": every presentation
logged with `trial_id`, timestamp (AudioContext clock), frequency, level, phase, whether
a catch trial, response, latency, ambient dB(A), and whether discarded.  
**Current:** Only the final threshold per frequency/ear is stored (12 rows per session).
No per-trial records exist.  
**Files:** `backend/models/screening_sessions.py`, database schema

---

### 29. Session-level metadata is not stored

**Spec §12.1:** The `Session` entity must include: `protocol_version`, `consent_version`,
`mode` (threshold/screening), `supervision`, `abort_reason`, `device` (headphone profile,
connection type, user agent), `calibration` (tier, spread, profile version), and
`environment` (pretest dB(A), noise spectrum, exceedance rate).  
**Current:** Session record contains only `session_id`, `user_id`, `timestamp`,
`ear`, `frequency_hz`, `threshold_db`.  
**Files:** `backend/models/screening_sessions.py`

---

### 30. No FHIR export

**Spec §12.2:** Audiograms should be exportable as HL7 FHIR `Observation` resources
(LOINC codes exist for frequency-specific air-conduction thresholds) bundled under a
`DiagnosticReport`.  
**Current:** Only PNG (canvas screenshot) and basic PDF export.  
**Files:** `static/script.js` → report generation functions

---

## 🟡 Moderate — UI & Accessibility

### 31. Tone indicator is a visual cue (prohibited)

**Spec §7.3:** "No animation, no colour change synchronised to the stimulus — that is a
visual cue and it will inflate hit rates."  
**Current:** The testing screen shows an animated "tone indicator" element that changes
state when a tone plays — exactly the prohibited synchronised visual cue.  
**Files:** `static/script.js` → `showToneIndicator()`, `templates/index.html`

---

### 32. Response button keyboard bindings and minimum size

**Spec §7.4:** Response button must have a **≥96×96 px hit area** and be bound to `Space`
and `Enter`.  
**Current:** Button size and keyboard bindings should be verified and enforced.  
**Files:** `templates/index.html`, `static/styles.css`

---

### 33. Progress indicator must not leak current level

**Spec §7.3:** "Never show the current level or the running threshold — it cues the
user."  
**Current:** Verify that `updateTestGuidance()` and progress elements do not display the
dB level being tested.  
**Files:** `static/script.js`, `templates/index.html`

---

### 34. Mandatory report metadata is incomplete

**Spec §8:** Every audiogram report must carry (per ASHA): test date/location, tester
credentials (or "self-administered, unsupervised"), equipment description (device,
transducer model, software version), calibration information (tier, method, date, profile
version), explanation of all symbols, ambient noise events, assessment of test
reliability, and a statement that bone conduction was not performed.  
**Current:** The canvas report shows basic demographics and the Chart.js audiogram, but
omits calibration tier, equipment info, symbol legend, reliability assessment, and the
bone-conduction disclaimer.  
**Files:** `static/script.js` → `generateReportCanvas()`

---

## Priority Summary

| Priority | Area | Gap count |
|---|---|---|
| 🔴 Critical | Core staircase, level range, frequency order, audio engine | 11 |
| 🟠 Important | Familiarization, retest, QC indicators, audiogram symbols/classification | 12 |
| 🟡 Moderate | Calibration, ambient noise, data model, FHIR, UI polish | 11 |

---

## Recommended Implementation Order

1. **Fix level range** (40 → 90 dB HL) in `algorithms.py` — largest correctness bug
2. **Fix threshold termination** to proper reversal-counting Hughson-Westlake
3. **Fix frequency order** and add 3000/6000 Hz; complete one ear before switching
4. **Fix tone duration and ISI** to spec (1.5 s ± 0.3 s tone, 1.5–4.5 s ISI)
5. **Fix audiogram rendering** — aspect ratio, O/X symbols, extended Y-axis, NR arrows
6. **Add WHO/BSA classification** and probabilistic likelihood band
7. **Add familiarization**, 1 kHz retest, timeout handling, and inter-ear break
8. **Implement QC indicators** and suppress results on poor quality
9. **Add calibration tiers**, ambient noise gate, and headphone selection
10. **Expand data model** to trial-level records and full session metadata
