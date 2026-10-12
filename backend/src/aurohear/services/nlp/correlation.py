"""Self-reported symptoms vs measured audiometry — a READ-ONLY research annotation.

Clinical independence (docs/NLP_RELIABILITY_MODULE.md): these correlations are stored on
the NLP insight for researchers/administrators. They never modify thresholds, the
classification or the referral, and they are never shown to the participant.

Rules:
  unilateral_hearing_loss ↔ interaural PTA₄ difference ≥ 15 dB (spec §9.2 asymmetry rule)
  tinnitus ↔ elevated high-frequency threshold: any of 3/4/6 kHz > 20 dB HL in either ear
              [DESIGN — research annotation only; the spec defines no "notch" criterion]
  dizziness_vertigo, ear_fullness → no pure-tone correlate (reported as such)
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Literal

Concordance = Literal["consistent", "symptom_without_finding", "not_assessable", "no_audiometric_correlate"]

ASYMMETRY_PTA_DB = 15.0
HF_FREQUENCIES_HZ = (3000, 4000, 6000)
HF_ELEVATED_ABOVE_DB_HL = 20.0
PTA4 = (500, 1000, 2000, 4000)


@dataclass(frozen=True, slots=True)
class Correlation:
    symptom: str
    finding: str
    concordance: Concordance
    measured: dict[str, float | None]


Audiogram = Mapping[str, Mapping[int, float | None]]
"""ear → frequency → accepted threshold (no-response at its ceiling; None if unresolved)."""


def _pta(ear: Mapping[int, float | None]) -> float | None:
    vals = [ear.get(f) for f in PTA4]
    present = [v for v in vals if v is not None]
    return sum(present) / len(present) if len(present) == len(PTA4) else None


def correlate(symptoms: Iterable[str], audiogram: Audiogram | None) -> list[Correlation]:
    out: list[Correlation] = []
    for s in dict.fromkeys(symptoms):  # unique, order kept
        if s in ("dizziness_vertigo", "ear_fullness"):
            out.append(Correlation(s, "no pure-tone audiometric correlate", "no_audiometric_correlate", {}))
            continue
        if not audiogram:
            out.append(Correlation(s, "no finalised audiogram", "not_assessable", {}))
            continue
        if s == "unilateral_hearing_loss":
            r, l = _pta(audiogram.get("right", {})), _pta(audiogram.get("left", {}))
            if r is None or l is None:
                out.append(Correlation(s, "PTA₄ unavailable in one or both ears", "not_assessable", {"pta4_right": r, "pta4_left": l}))
                continue
            diff = abs(r - l)
            out.append(
                Correlation(
                    s,
                    f"interaural PTA₄ difference ≥ {ASYMMETRY_PTA_DB:.0f} dB",
                    "consistent" if diff >= ASYMMETRY_PTA_DB else "symptom_without_finding",
                    {"pta4_right": r, "pta4_left": l, "difference_db": diff},
                )
            )
        elif s == "tinnitus":
            hf = {
                f"{ear}_{f}": audiogram.get(ear, {}).get(f)
                for ear in ("right", "left")
                for f in HF_FREQUENCIES_HZ
            }
            known = [v for v in hf.values() if v is not None]
            if not known:
                out.append(Correlation(s, "no high-frequency thresholds", "not_assessable", hf))
                continue
            elevated = max(known) > HF_ELEVATED_ABOVE_DB_HL
            out.append(
                Correlation(
                    s,
                    f"a 3–6 kHz threshold above {HF_ELEVATED_ABOVE_DB_HL:.0f} dB HL",
                    "consistent" if elevated else "symptom_without_finding",
                    hf,
                )
            )
    return out
