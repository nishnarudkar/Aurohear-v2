"""Export golden traces from the Python reference engine for the TypeScript port.

Writes frontend/tests/engine/golden-traces.json. The frontend conformance test replays
every scenario's responses through the browser engine and requires an identical
presentation sequence and identical results. The backend test
`test_golden_traces_are_current` fails if this file is stale. Regenerate after any
engine change:

    python backend/scripts/export_golden_traces.py

Scenarios are fully deterministic (seeded) and deliberately cover the hard paths:
noisy, adversarial and alternating listeners (unresolved searches, inconsistent
familiarisation),
1 kHz retest shifts (unstable retest → verification searches), inter-octave triggers,
non-grid per-frequency caps, probes on/off, every ear order.
"""

from __future__ import annotations

import json
import math
import random
import sys
from pathlib import Path
from typing import Any

BACKEND = Path(__file__).resolve().parents[1]
SNAPSHOT = BACKEND.parent / "frontend" / "tests" / "engine" / "golden-traces.json"
N_SCENARIOS = 180
ALL_FREQS = (250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000)

PHASE = {"familiarisation": "F", "descent": "D", "ascent": "A", "qc_probe": "Q"}
ROLE = {"initial": "I", "retest": "R", "verification": "V"}


def _scenario(i: int) -> dict[str, Any]:
    from aurohear.audiometry import AudiometryProtocol, Ear, LevelLattice

    rng = random.Random(10_000 + i)
    kind = ("ideal", "psychometric", "retest_shift", "adversarial", "inter_octave", "capped", "alternating")[i % 7]

    # ---- configuration
    better = rng.choice([None, "right", "left"])
    profile_cap = rng.choice([90, 90, 90, 90, 80, 70, 60])
    caps: dict[int, float] = {}
    if kind == "capped" or rng.random() < 0.3:
        for f in rng.sample(ALL_FREQS, rng.randint(1, 4)):
            caps[f] = round(rng.uniform(25.0, 100.0), 1)
    qc_probes = rng.random() < 0.8
    inter_octaves = rng.random() < 0.85

    # ---- listener (recorded as a response string; TS replays the responses)
    def grid() -> dict[str, dict[int, float]]:
        return {e: {f: float(rng.choice(range(-30, 121, 5))) for f in ALL_FREQS} for e in ("right", "left")}

    truth = grid()
    if kind == "inter_octave":
        for e in truth:
            truth[e][500] = float(rng.choice(range(40, 81, 5)))
            truth[e][1000] = float(rng.choice(range(-10, 21, 5)))
            truth[e][2000] = float(rng.choice(range(40, 81, 5)))
    if kind in ("psychometric", "capped"):
        truth = {e: {f: rng.uniform(-15.0, 100.0) for f in ALL_FREQS} for e in truth}
    spread = rng.uniform(0.5, 6.0)
    fa = rng.uniform(0.0, 0.2)
    lapse = rng.uniform(0.0, 0.1)
    shift = rng.choice(range(-25, 26, 5))
    coin = rng.uniform(0.15, 0.85)
    lrng = random.Random(20_000 + i)
    flip = [rng.random() < 0.5]

    def listener(p: Any) -> bool:
        t = truth[p.ear.value][p.frequency_hz]
        if kind == "adversarial":
            return lrng.random() < coin
        if kind == "alternating":  # never two hits in a row → inconsistent familiarisation
            flip[0] = not flip[0]
            return flip[0]
        if kind == "retest_shift" and p.frequency_hz == 1000 and p.test_role.value != "initial":
            t += shift
        if kind in ("psychometric", "capped"):
            z = (p.level_db_hl - t) / spread
            sig = 1.0 / (1.0 + math.exp(-z)) if z > -700 else 0.0
            return lrng.random() < fa + (1.0 - fa - lapse) * sig
        return p.level_db_hl >= t

    proto = AudiometryProtocol(
        better_ear=Ear(better) if better else None,
        lattice=LevelLattice(ceiling=profile_cap),
        frequency_caps_db_hl=caps,
        qc_probes=qc_probes,
        inter_octaves=inter_octaves,
    )
    presentations: list[list[Any]] = []
    responses: list[str] = []
    while (p := proto.next_presentation()) is not None:
        heard = listener(p)
        presentations.append([p.ear.value[0].upper(), p.frequency_hz, p.level_db_hl, PHASE[p.phase.value], ROLE[p.test_role.value]])
        responses.append("1" if heard else "0")
        proto.record_response(heard)
        if len(responses) > 10_000:
            raise RuntimeError(f"scenario {i} did not terminate")

    ears = []
    for e in proto.result().ears:
        thresholds = [
            [
                r.frequency_hz, ROLE[r.test_role.value], r.status.value, r.threshold_db_hl, r.provisional_db_hl,
                r.ascending_hits, r.ascending_trials, r.ascents_completed, r.presentations,
                r.floor_limited, r.clamp_events, r.is_interoctave,
                r.qc_probe_at_threshold_heard, r.qc_probe_plus5_heard,
            ]
            for r in e.thresholds
        ]
        ears.append({
            "ear": e.ear.value,
            "familiarisation": [e.familiarisation.status.value, e.familiarisation.level_db_hl],
            "retest_1k_delta_db": e.retest_1k_delta_db,
            "unstable_1k": e.unstable_1k,
            # accepted search for each frequency, as an index into `thresholds`
            "audiogram": {str(f): e.thresholds.index(r) for f, r in e.audiogram.items()},
            "thresholds": thresholds,
        })
    return {
        "id": i,
        "kind": kind,
        "config": {
            "better_ear": better,
            "profile_cap_db_hl": profile_cap,
            "frequency_caps_db_hl": {str(f): v for f, v in sorted(caps.items())},
            "qc_probes": qc_probes,
            "inter_octaves": inter_octaves,
        },
        "responses": "".join(responses),
        "presentations": presentations,
        "ears": ears,
    }


def render() -> str:
    sys.path.insert(0, str(BACKEND / "src"))
    from aurohear.audiometry import PROTOCOL_VERSION

    header = {
        "protocol_version": PROTOCOL_VERSION,
        "generated_by": "backend/scripts/export_golden_traces.py",
        "encoding": {
            "presentation": "[ear R|L, frequency_hz, level_db_hl, phase F|D|A|Q, role I|R|V]",
            "threshold": "[frequency_hz, role, status, threshold, provisional, ascending_hits, ascending_trials, "
            "ascents_completed, presentations, floor_limited, clamp_events, is_interoctave, "
            "qc_probe_at_threshold_heard, qc_probe_plus5_heard]",
        },
    }
    lines = [json.dumps(_scenario(i), separators=(",", ":")) for i in range(N_SCENARIOS)]
    return '{"header":' + json.dumps(header) + ',"scenarios":[\n' + ",\n".join(lines) + "\n]}\n"


if __name__ == "__main__":
    SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
    SNAPSHOT.write_text(render(), encoding="utf-8")
    print(f"wrote {SNAPSHOT} ({SNAPSHOT.stat().st_size // 1024} KiB)")
