# AuroHear v2 (Clinical)

> **A standards-compliant, browser-based pure-tone threshold screening audiometer with adaptive staircase protocols and qualitative feedback analysis.**

[![Standards: ASHA 2005](https://img.shields.io/badge/Standard-ASHA%202005-blue.svg)](https://www.asha.org)
[![Standards: BSA 2018](https://img.shields.io/badge/Standard-BSA%202018-blue.svg)](https://www.thebsa.org.uk)
[![ISO 8253-1](https://img.shields.io/badge/Compliant-ISO%208253--1-green.svg)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 📌 Overview

**AuroHear v2** is a digital health platform designed for unsupervised and technician-assisted pure-tone air-conduction threshold audiometry in a standard web browser. Built to bridge the gap between preliminary screening prototypes and publication-ready clinical standards, AuroHear v2 implements:

- **Rigorous Adaptive Staircase (Hughson-Westlake)**: Reversal-counting termination criterion across standard frequencies (1000 Hz familiarization, octaves, and inter-octaves: 250 Hz to 8000 Hz, −10 to 90 dB HL).
- **Web Audio Stimulus Engine**: Precise stimulus duration, calibrated rise/fall Hann/Blackman gating windows to eliminate acoustic transients/clicks, and inter-stimulus interval (ISI) randomization.
- **Trial-Level Quality Control (QUALIND-adapted)**: Continuous monitoring of false-positive rate, catch trials, response-latency variance, and ambient noise gating.
- **Calibration-Tier Uncertainty Modeling**: Probabilistic hearing loss classification incorporating hardware profile uncertainty bounds.
- **Multimodal Qualitative NLP**: Intelligent screening of user-reported auditory symptoms and qualitative descriptions alongside quantitative threshold audiograms.

---

## 🏛️ Clinical & Engineering Specifications

The system design strictly follows international audiological standards:
- **ASHA (2005)**: *Guidelines for Manual Pure-Tone Threshold Audiometry*
- **BSA (2018)**: *Recommended Procedure: Pure-tone air-conduction and bone-conduction threshold audiometry* (OD104-32)
- **ANSI S3.21 / ISO 8253-1**: Pure-tone test methods
- **WHO (2021)**: *World report on hearing* grading of hearing impairment

Refer to the primary specification documents:
- [Browser Audiometry Digitization Spec](Browser_audiometry_digitization_spec.md)
- [Gap Analysis: V1 Prototype vs. Clinical Spec](docs/GAP_ANALYSIS.md)
- [Conference Paper Upgrade Strategy](docs/CONFERENCE_UPGRADE_STRATEGY.md)

---

## 🏗️ Architecture & Technology Stack

| Layer | Technology | Role |
| :--- | :--- | :--- |
| **Frontend Framework** | React / TypeScript + Vite | Type-safe UI and component isolation |
| **Test State Machine** | XState v5 | Deterministic Finite State Machine (FSM) enforcing ASHA protocol flow |
| **Audio Generation** | Web Audio API / AudioWorklet | Low-jitter tone synthesis with windowed gating |
| **Audiogram Rendering**| D3.js | Compliant audiogram aspect ratio (1 octave = 20 dB), O/X symbols, NR flags |
| **Backend API** | FastAPI (Python 3.11+) | Asynchronous REST & WebSocket endpoints with strict Pydantic v2 schemas |
| **NLP Engine** | Spacy / Transformers | Qualitative symptom classification & tone perception feedback |
| **Data & Migrations** | PostgreSQL / SQLite + Alembic | Version-controlled audit log of Sessions, Trials, and Thresholds |
| **Testing** | pytest + Hypothesis | Property-based testing of staircase convergence against synthetic listeners |

---

## 🗺️ Project Roadmap

- [x] **Spec & Architecture Blueprint**: Formalization of clinical protocol and gap analysis
- [ ] **Phase 1: Staircase Engine**: Pure-tone Hughson-Westlake implementation with 1000 Hz familiarization and retest
- [ ] **Phase 2: Audio Synthesis & Gating**: Web Audio generator with 20-50ms rise/fall smoothing
- [ ] **Phase 3: FSM Test Runner**: Client-side state machine with catch trials and response windowing
- [ ] **Phase 4: Ambient Noise Gate**: Web Audio AnalyserNode 1/3-octave ambient noise check
- [ ] **Phase 5: Validation Study**: Data collection comparing AuroHear thresholds against clinical audiometers

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
