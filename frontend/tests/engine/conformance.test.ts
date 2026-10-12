/**
 * Conformance: the browser engine must reproduce the Python reference engine exactly.
 *
 * golden-traces.json is exported from backend/src/aurohear/audiometry by
 * backend/scripts/export_golden_traces.py (a backend test fails if it is stale). For each
 * scenario we feed the recorded responses to the TypeScript AudiometryProtocol and require
 * the identical presentation at every step and identical final results — so the offline
 * engine can never send a session down a path the server would reject.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AudiometryProtocol, LevelLattice, PROTOCOL_VERSION, type ThresholdResult } from '../../src/engine';
import type { Presentation } from '../../src/session';

type Encoded = [ear: 'R' | 'L', f: number, level: number, phase: 'F' | 'D' | 'A' | 'Q', role: 'I' | 'R' | 'V'];
type EncodedThreshold = [
  number, 'I' | 'R' | 'V', string, number | null, number | null, number, number, number, number,
  boolean, number, boolean, boolean | null, boolean | null,
];
interface Scenario {
  id: number;
  kind: string;
  config: {
    better_ear: 'right' | 'left' | null;
    profile_cap_db_hl: number;
    frequency_caps_db_hl: Record<string, number>;
    qc_probes: boolean;
    inter_octaves: boolean;
  };
  responses: string;
  presentations: Encoded[];
  ears: {
    ear: 'right' | 'left';
    familiarisation: [string, number];
    retest_1k_delta_db: number | null;
    unstable_1k: boolean;
    audiogram: Record<string, number>;
    thresholds: EncodedThreshold[];
  }[];
}

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('./golden-traces.json', import.meta.url)), 'utf-8'),
) as { header: { protocol_version: string }; scenarios: Scenario[] };

const PHASE = { F: 'familiarisation', D: 'descent', A: 'ascent', Q: 'qc_probe' } as const;
const ROLE = { I: 'initial', R: 'retest', V: 'verification' } as const;

const decode = ([e, f, l, ph, r]: Encoded): Presentation => ({
  ear: e === 'R' ? 'right' : 'left',
  frequencyHz: f,
  levelDbHl: l,
  phase: PHASE[ph],
  testRole: ROLE[r],
});

const encodeThreshold = (r: ThresholdResult): EncodedThreshold => [
  r.frequencyHz, (r.testRole === 'initial' ? 'I' : r.testRole === 'retest' ? 'R' : 'V'), r.status, r.thresholdDbHl,
  r.provisionalDbHl, r.ascendingHits, r.ascendingTrials, r.ascentsCompleted, r.presentations, r.floorLimited,
  r.clampEvents, r.isInteroctave, r.qcProbeAtThresholdHeard, r.qcProbePlus5Heard,
];

function run(s: Scenario) {
  const proto = new AudiometryProtocol({
    betterEar: s.config.better_ear,
    lattice: new LevelLattice(-10, s.config.profile_cap_db_hl),
    frequencyCapsDbHl: Object.fromEntries(Object.entries(s.config.frequency_caps_db_hl).map(([f, v]) => [Number(f), v])),
    qcProbes: s.config.qc_probes,
    interOctaves: s.config.inter_octaves,
  });
  for (let i = 0; i < s.responses.length; i++) {
    const got = proto.nextPresentation();
    const want = decode(s.presentations[i]!);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`scenario ${s.id} (${s.kind}) diverged at step ${i}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
    proto.recordResponse(s.responses[i] === '1');
  }
  return proto;
}

describe('browser engine ≡ Python reference engine (golden traces)', () => {
  it('pins the same protocol version as the backend that produced the traces', () => {
    expect(PROTOCOL_VERSION).toBe(golden.header.protocol_version);
  });

  it('covers the hard paths', () => {
    const kinds = new Set(golden.scenarios.map((s) => s.kind));
    expect(kinds).toEqual(new Set(['ideal', 'psychometric', 'retest_shift', 'adversarial', 'inter_octave', 'capped', 'alternating']));
    const statuses = new Set(golden.scenarios.flatMap((s) => s.ears.flatMap((e) => e.thresholds.map((t) => t[2]))));
    expect(statuses).toEqual(new Set(['measured', 'no_response', 'unresolved']));
    const fam = new Set(golden.scenarios.flatMap((s) => s.ears.map((e) => e.familiarisation[0])));
    expect(fam).toEqual(new Set(['complete', 'no_response', 'inconsistent']));
  });

  it.each(golden.scenarios.map((s) => [s.id, s.kind, s] as const))(
    'scenario %i (%s): identical presentations and results',
    (_id, _kind, s) => {
      const proto = run(s);
      expect(proto.isComplete).toBe(true);
      expect(proto.nextPresentation()).toBeNull();
      const ears = proto.earResultsSoFar();
      expect(ears.map((e) => e.ear)).toEqual(s.ears.map((e) => e.ear));
      for (const [i, e] of ears.entries()) {
        const want = s.ears[i]!;
        expect([e.familiarisation.status, e.familiarisation.levelDbHl]).toEqual(want.familiarisation);
        expect(e.retest1kDeltaDb).toEqual(want.retest_1k_delta_db);
        expect(e.unstable1k).toBe(want.unstable_1k);
        expect(e.thresholds.map(encodeThreshold)).toEqual(want.thresholds);
        const accepted = Object.fromEntries([...e.audiogram.entries()].map(([f, r]) => [String(f), e.thresholds.indexOf(r)]));
        expect(accepted).toEqual(want.audiogram);
      }
    },
  );
});
