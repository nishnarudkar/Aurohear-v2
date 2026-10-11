# Conference Paper Upgrade Strategy
## AuroHear — From Prototype to Publication-Ready System

**Context:** This document outlines the strategic decisions, technology upgrades, and
research positioning required to prepare AuroHear for conference paper submission.
The professor's spec (`Browser_audiometry_digitization_spec.md`) defines the clinical
and engineering bar that reviewers will hold the system to.

---

## 1. Understanding What a Conference Reviewer Will Look For

Before deciding what to build, understand what the paper must demonstrate. A conference
paper on a browser-based audiometry system will be evaluated on four axes:

**1. Clinical validity** — Does the system implement the actual standard (Hughson-Westlake,
ASHA 2005, BSA 2018)? Reviewers will be audiologists or biomedical engineers who know
the protocol. The current implementation has correctness bugs (wrong level cap, wrong
termination criterion, wrong frequency order) that will be spotted immediately.

**2. Engineering contribution** — What is novel? "We made a web audiometer" is not
publishable — there are dozens. The contribution must be *specific*: a calibration
architecture, a validated noise-gating approach, a probabilistic classification model,
or a QC indicator set adapted for unsupervised browser delivery.

**3. Validation** — Do you have data comparing your system against a clinical reference?
The spec's §11 validation plan is not optional for publication. Without it, reviewers
will reject with "no evidence of accuracy." Even a small pilot (≥30 participants vs. a
clinical audiometer) is needed.

**4. Reproducibility** — Is the system described precisely enough for another team to
replicate it? This means: protocol version pinned in every session record, calibration
tier documented, data available (even pseudonymised).

---

## 2. The Actual Novel Contribution of This Project

Most browser audiometers in the literature (AMTAS, uHear, Shoebox, HEARZAP) are either:
- Proprietary / closed-source, or
- Validated on controlled hardware with no ambient noise handling, or
- Basic pass/fail screeners without a full adaptive threshold algorithm

AuroHear's defensible novelty **as currently positioned** is the combination of:

1. **Open-source, standards-compliant adaptive threshold audiometry** (Hughson-Westlake)
   in a browser, with all parameters transparent and auditable
2. **NLP-assisted qualitative feedback analysis** alongside quantitative thresholds —
   this is genuinely novel; no published browser audiometer does this
3. **WHO/BSA probabilistic classification with calibration-tier-aware uncertainty** —
   the Masalski-derived σ model from the spec is publishable on its own if you implement
   and validate it
4. **Trial-level QC indicators (QUALIND adapted for browser)** surfaced to the clinician
   console — the existing literature only reports final thresholds, not per-session QC

Frame the paper around points 2 and 3. Point 1 is necessary but not sufficient. Point 4
makes the system trustworthy enough to be used in practice.

---

## 3. Repository Strategy

### Create a New Repository

Do not continue building in this repo for the conference version. Reasons:

- The commit history mixes a prototype with incorrect clinical logic — a reviewer given
  the repo link will see that and question the rigor
- The new version requires architectural changes that will conflict badly with existing
  code (staircase rewrite, new data model, FSM-based test runner)
- A clean repo lets you set up CI, code coverage, and a proper README from day one

**What to migrate from the current repo:**
- Supabase auth integration (`backend/routes/auth.py`)
- NLP/feedback module (`backend/nlp_engine/`, `backend/routes/feedback.py`, `backend/routes/nlp.py`)
- CSS design system (`static/styles.css`, `static/auth_styles.css`)
- Docker + Gunicorn configuration
- The `docs/` folder (gap analysis, this document)
- Test infrastructure structure (not the test content — tests need rewriting)

**What to rewrite from scratch:**
- Staircase algorithm (`backend/utils/algorithms.py`)
- Audio generation (`backend/utils/audio.py`)
- Frontend test runner (`static/script.js` test flow)
- Database models (Session, Trial, Threshold, Classification)
- All database migrations (switch to Alembic)

**Suggested new repo name:** `aurohear-v2` or `aurohear-clinical`

---

## 4. Recommended Tech Stack for the Conference Version

### Backend

| Component | Current | Recommended | Reason |
|---|---|---|---|
| Web framework | Flask | **FastAPI** (test API) + Flask (auth/NLP/static) | FastAPI's Pydantic models enforce the spec's Session/Trial/Threshold entities; async support needed for WebSocket ambient noise streaming |
| Data validation | None (manual dict access) | **Pydantic v2** | Validates every API input/output against the spec's data model at the boundary — prevents the class of bugs where a missing field silently defaults |
| Database migrations | Raw ALTER TABLE in helpers.py | **Alembic** | Version-controlled migrations; works with both SQLite (dev) and PostgreSQL (production); reviewers expect this |
| Audio generation | NumPy + SciPy (fixed amplitude) | NumPy + SciPy **(with correct dB HL mapping)** | Keep the library; fix the amplitude calculation to actually apply level_db |
| Test framework | pytest (existing) | pytest + **pytest-asyncio** + **hypothesis** | Hypothesis for property-based testing of the staircase — generate thousands of synthetic listener responses and verify the algorithm converges to the correct threshold |

### Frontend

| Component | Current | Recommended | Reason |
|---|---|---|---|
| Architecture | Vanilla JS, global state | **React + TypeScript** | Component isolation prevents the global-state bugs; TypeScript catches frequency/level type errors at compile time |
| State machine | Ad-hoc if/else in submitResponse() | **XState v5** | The spec explicitly requires an FSM (§7.2). XState maps directly to the spec's state diagram, produces an audit log of every transition, and has a visual inspector for debugging |
| Build tooling | None (raw script tags) | **Vite** | Fast HMR during development; tree-shaking for production; handles TypeScript without configuration |
| Audiogram chart | Chart.js | **D3.js** (for the audiogram) + Chart.js (for trends) | D3 gives pixel-level control needed for the spec's strict aspect ratio (1 octave = 20 dB), O/X symbols, NR arrows, and shadow symbols. Chart.js stays for the multi-session trend chart |
| Ambient noise | Not implemented | **Meyda.js** or raw Web Audio AnalyserNode | Real-time one-third-octave FFT in the browser for the noise gate (spec §5) |
| Audio worklet | OscillatorNode (main thread) | **AudioWorklet API** | Moves tone generation to the audio rendering thread — eliminates the timer jitter that affects ISI precision |

### Infrastructure

| Tool | Purpose |
|---|---|
| **Alembic** | Database schema migrations |
| **Pydantic v2** | Data validation for all API contracts |
| **Hypothesis** | Property-based testing of the staircase algorithm |
| **Playwright** | End-to-end tests for the test runner FSM |
| **GitHub Actions** | CI: run tests + Alembic migration check on every PR |
| **Render / Railway** | Same deployment target as current, no change needed |

---

## 5. What to Build in What Order (For Conference Submission)

Conference papers are judged on what you *demonstrated*, not what you planned. This
order maximises what you can show in a paper:

### Phase 1 — Correctness (Must Have for Submission)

Fix the things that will cause outright rejection if a reviewer tests the system:

1. Staircase algorithm: correct level range (−10 to 90 dB HL), reversal-counting
   termination criterion, ASHA frequency order (1000→2000→3000→4000→6000→8000→retest→500→250)
2. Familiarization procedure at 1000 Hz
3. 1000 Hz retest with Δ>5 dB flag
4. Correct tone duration (1.5 s ± 0.3 s randomised) and variable ISI (1.5–4.5 s)
5. Raised-cosine ramps on tone onset/offset
6. Server-side correct dB HL → amplitude mapping
7. WHO 2021 grade + BSA descriptor output
8. Audiogram rendering with correct aspect ratio, O/X symbols, extended Y-axis

**Deliverable:** A system that implements the standard correctly. This is the baseline;
without this you cannot publish.

### Phase 2 — Novel Contribution (Core of the Paper)

The section of the paper that answers "why should we read this":

9. Probabilistic classification model: P(hearing loss) = Φ((PTA_adj − 20)/σ_tier) with
   calibration tier affecting σ (Tier C σ=7.6, Tier B σ=5.4 from Masalski)
10. QUALIND-adapted QC indicators (false alarm rate, quality check probe at threshold+5 dB,
    time per trial, ambient noise exceedance rate, session integrity events)
11. "Indeterminate — retest required" outcome when QC composite is Poor
12. NLP feedback analysis integrated with quantitative results — this is your unique angle
13. Trial-level data model (every presentation logged — this enables your validation study)

**Deliverable:** The system produces not just a threshold but a calibrated confidence
estimate and a QC assessment. This is the publishable claim.

### Phase 3 — Validation Study (Required to Publish)

No conference in biomedical engineering or health informatics will accept a diagnostic
tool paper without validation data. This is non-negotiable.

14. Recruit ≥30 participants (stratified: ~15 normal hearing, ~15 with known loss)
15. Each participant: AuroHear test (Tier C, home environment) + clinical audiometer
    test (reference standard) within the same session or same day
16. Compute: mean difference per frequency, SD, Bland-Altman limits of agreement,
    % thresholds within ±5 dB and ±10 dB of reference
17. Compute: sensitivity and specificity for WHO PTA₄ ≥ 20 dB HL
18. Report QC indicators for each session and show correlation with accuracy

**Deliverable:** Table of agreement statistics. This becomes the Results section of the paper.

### Phase 4 — Polish (Nice to Have)

16. Ambient noise gate (microphone pre-test capture + continuous monitoring)
17. Headphone selection with Bluetooth block
18. FHIR export
19. Clinician console with staircase plot and manual override

---

## 6. Structuring the Paper

### Suggested Title
*"AuroHear: An Open-Source, Standards-Compliant Browser-Based Audiometric Screening
System with Calibration-Tier-Aware Probabilistic Classification"*

Or if emphasising the NLP angle:
*"AuroHear: Integrating Quantitative Audiometric Thresholds with NLP-Assisted Qualitative
Self-Report for Browser-Based Hearing Screening"*

### Abstract Structure
- Problem: hearing loss underdiagnosed globally; clinical audiometry inaccessible
- Gap: existing browser audiometers lack standards compliance, calibration-aware uncertainty, or open-source reproducibility
- Method: AuroHear implements Hughson-Westlake per ASHA 2005, with WHO/BSA classification, Masalski-derived probabilistic model, QUALIND-adapted QC, and NLP-integrated feedback analysis
- Results: validation against clinical audiometer (N=XX, mean difference X dB, SD X dB, sensitivity X%, specificity X%)
- Conclusion: platform is suitable for population-level screening with explicit uncertainty quantification

### Sections
1. Introduction — burden of hearing loss, limitations of current browser tools
2. Related Work — AMTAS, uHear, Shoebox, HEARZAP, Masalski 2013
3. System Design — architecture, audio engine, calibration tiers, FSM test runner
4. Clinical Protocol — Hughson-Westlake implementation, frequency sequence, QC indicators
5. Classification Model — probabilistic framework, Masalski σ values, WHO/BSA grading
6. NLP Integration — feedback analysis alongside quantitative results (your novel angle)
7. Validation Study — design, participants, results (Bland-Altman, sensitivity/specificity)
8. Discussion — limitations (no masking, no bone conduction, uncalibrated microphone),
   comparison to related work, future work
9. Conclusion

### Target Conferences
These are appropriate venues for this type of work:

| Conference | Focus | Deadline pattern |
|---|---|---|
| **IEEE EMBC** (Engineering in Medicine and Biology) | Biomedical engineering, digital health | January for August |
| **CBMS** (IEEE Symposium on Computer-Based Medical Systems) | Clinical decision support, medical software | February for June |
| **HEALTHINF** (International Conference on Health Informatics) | Health IT, mHealth | October for February |
| **ACM CHI** (if UX/accessibility angle is strong) | HCI, accessible computing | September for May |
| **MedInfo** (IMIA) | Medical informatics, clinical systems | Varies |

For a student's first paper, CBMS and HEALTHINF have lower bars than IEEE EMBC or CHI,
and they're more likely to accept a well-validated tool paper.

---

## 7. What Makes This Publishable That the Current Version Doesn't Have

| Criterion | Current | What's Needed |
|---|---|---|
| Standards compliance | Partial (wrong staircase, wrong frequencies) | Full Hughson-Westlake per ASHA 2005 |
| Uncertainty quantification | None | Masalski-derived probabilistic model (P = Φ(z)) |
| QC indicators | Client-side false alarm ratio only | QUALIND-adapted set (13 indicators) |
| Clinical classification | Binary asymmetry flag | WHO 2021 grade + BSA descriptor |
| Validation data | None | ≥30 participants vs. clinical audiometer |
| Trial-level logging | Not stored | Append-only trial table (needed for Bland-Altman) |
| Novel angle | NLP feedback (underused) | NLP + probabilistic QC-gated output together |
| Reproducibility | Partial (open source but undocumented protocol) | Protocol version pinned in every session; data model published |

---

## 8. Timeline Estimate

Assuming you are working on this alongside coursework:

| Milestone | Estimated time |
|---|---|
| New repo setup + Phase 1 algorithm fixes | 3–4 weeks |
| Phase 2 novel features (QC, probabilistic model, D3 audiogram) | 4–5 weeks |
| Phase 3 validation study (recruitment + data collection) | 4–6 weeks (this is the long pole) |
| Data analysis + paper writing | 3–4 weeks |
| Submission | ~16–19 weeks total from now |

The validation study is the rate-limiting step. Start recruiting as soon as Phase 1 is
complete enough to produce valid thresholds — you don't need Phase 2 features to collect
validation data, just correct thresholds.

---

## 9. What to Keep From This Repo

Despite the rewrites needed, several things in the current codebase are genuinely good
and should be preserved:

- **NLP engine** (`backend/nlp_engine/`) — qualitative feedback analysis is differentiated
- **Supabase auth + guest mode** — works well, saves time
- **Interaural analysis** in `ScreeningSessions.compute_interaural_differences()` — solid
- **CSS design system** — professional medical UI aesthetic
- **Docker + Gunicorn setup** — no changes needed
- **The `docs/` folder** — gap analysis and this document become the Methods section

---

## 10. Key References to Cite in the Paper

These are the papers your system will be compared against and must cite:

1. Masalski & Kręcicki (2013) — the error decomposition model your σ values come from
2. Margolis et al. (2010) — AMTAS validation (the system you are most similar to)
3. Swanepoel et al. (2015) — boothless audiometry with noise monitoring
4. ASHA (2005) Guidelines for Manual Pure-Tone Threshold Audiometry
5. BSA (2018) Recommended Procedure for Pure-Tone Audiometry
6. WHO (2021) World Report on Hearing — the grading scale you implement
7. The 2025 systematic review (R12 in the spec) — positions your work in the current landscape
8. Lombardo (2018) — AMTAS QUALIND indicators you are adapting

All references are listed in full in `Browser_audiometry_digitization_spec.md §15`.
