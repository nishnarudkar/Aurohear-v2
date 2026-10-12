/**
 * Mirror of audiometry/protocol.py — the two-ear ASHA 2005 sequence with 1 kHz retest
 * and verification, conditional inter-octaves, QC probes and per-frequency ceilings.
 * Line-by-line port; the Python module holds the clinical rationale and spec citations.
 */

import type { Ear, Presentation, TestRole } from '../session/types';
import { Familiarisation, type FamiliarisationConfig, DEFAULT_FAMILIARISATION_CONFIG } from './familiarisation';
import { FrequencyLattices, LevelLattice } from './levels';
import { QcProbe } from './qcProbe';
import { DEFAULT_STAIRCASE_CONFIG, HughsonWestlakeStaircase, type StaircaseConfig } from './staircase';
import type { EarResult, FamiliarisationResult, ThresholdResult } from './types';

/** Must equal backend PROTOCOL_VERSION; checked by the conformance test. */
export const PROTOCOL_VERSION = 'aurohear-asha2005-ac-0.1.0';

const FAMILIARISATION_FREQUENCY_HZ = 1000;
const RETEST_FREQUENCY_HZ = 1000;
const VERIFICATION_EXTRA_FREQUENCY_HZ = 2000;
const RETEST_TOLERANCE_DB = 5;
const SUBSEQUENT_START_OFFSET_DB = 30;
const INTER_OCTAVE_DIFFERENCE_DB = 20;

type Step = readonly [frequencyHz: number, role: TestRole];

export const FIRST_EAR_SEQUENCE: readonly Step[] = [
  [1000, 'initial'], [2000, 'initial'], [3000, 'initial'], [4000, 'initial'], [6000, 'initial'],
  [8000, 'initial'], [1000, 'retest'], [500, 'initial'], [250, 'initial'],
];
export const SECOND_EAR_SEQUENCE: readonly Step[] = FIRST_EAR_SEQUENCE.filter(([, r]) => r !== 'retest');
export const INTER_OCTAVE_RULES: readonly (readonly [number, number, number])[] = [
  [750, 500, 1000],
  [1500, 1000, 2000],
];

export function acceptThreshold(results: readonly ThresholdResult[]): ThresholdResult {
  if (results.length === 0) throw new Error('no results for this frequency');
  let best: ThresholdResult | null = null;
  for (const r of results) {
    if (r.status === 'measured' && (best === null || r.thresholdDbHl! < best.thresholdDbHl!)) best = r;
  }
  if (best) return best;
  const nr = results.filter((r) => r.status === 'no_response');
  return nr.length ? nr[nr.length - 1]! : results[results.length - 1]!;
}

export function retestIsStable(initial: ThresholdResult, retest: ThresholdResult): [boolean, number | null] {
  if (initial.status === 'measured' && retest.status === 'measured') {
    const delta = Math.abs(retest.thresholdDbHl! - initial.thresholdDbHl!);
    return [delta <= RETEST_TOLERANCE_DB, delta];
  }
  return [initial.status === 'no_response' && retest.status === 'no_response', null];
}

export function interOctavesNeeded(audiogram: ReadonlyMap<number, ThresholdResult>): number[] {
  const out: number[] = [];
  for (const [f, lo, hi] of INTER_OCTAVE_RULES) {
    const a = audiogram.get(lo);
    const b = audiogram.get(hi);
    if (!a || !b || a.thresholdDbHl === null || b.thresholdDbHl === null) continue;
    if (Math.abs(a.thresholdDbHl - b.thresholdDbHl) >= INTER_OCTAVE_DIFFERENCE_DB && !audiogram.has(f)) out.push(f);
  }
  return out;
}

class EarState {
  familiarisation: FamiliarisationResult | null = null;
  readonly thresholds: ThresholdResult[] = [];
  retestDeltaDb: number | null = null;
  unstable1k = false;
  interOctavesEvaluated = false;
  readonly interOctaveFrequencies = new Set<number>();

  constructor(
    readonly ear: Ear,
    readonly plan: Step[],
  ) {}

  lastMeasuredThreshold(): number | null {
    for (let i = this.thresholds.length - 1; i >= 0; i--) {
      const r = this.thresholds[i]!;
      if (r.status === 'measured') return r.thresholdDbHl;
    }
    return null;
  }

  toResult(): EarResult {
    if (!this.familiarisation) throw new Error('ear has no familiarisation result');
    const byFreq = new Map<number, ThresholdResult[]>();
    for (const r of this.thresholds) {
      const list = byFreq.get(r.frequencyHz) ?? [];
      list.push(r);
      byFreq.set(r.frequencyHz, list);
    }
    const audiogram = new Map(
      [...byFreq.entries()].sort(([a], [b]) => a - b).map(([f, rs]) => [f, acceptThreshold(rs)] as const),
    );
    return {
      ear: this.ear,
      familiarisation: this.familiarisation,
      thresholds: [...this.thresholds],
      audiogram,
      retest1kDeltaDb: this.retestDeltaDb,
      unstable1k: this.unstable1k,
    };
  }
}

export interface AudiometryProtocolOptions {
  readonly betterEar?: Ear | null;
  readonly lattice?: LevelLattice;
  /** Transducer profile maximum per frequency (spec §3.4); floored to the grid. */
  readonly frequencyCapsDbHl?: ReadonlyMap<number, number> | Readonly<Record<number, number>>;
  readonly staircaseConfig?: StaircaseConfig;
  readonly familiarisationConfig?: FamiliarisationConfig;
  readonly qcProbes?: boolean;
  readonly interOctaves?: boolean;
}

type Unit = Familiarisation | HughsonWestlakeStaircase | QcProbe;

export class AudiometryProtocol {
  readonly lattices: FrequencyLattices;
  readonly earOrder: readonly [Ear, Ear];
  private readonly staircaseConfig: StaircaseConfig;
  private readonly familiarisationConfig: FamiliarisationConfig;
  private readonly qcProbes: boolean;
  private readonly interOctaves: boolean;
  private readonly ears: [EarState, EarState];
  private earIndex = 0;
  private unit: Unit | null;
  private pending: ThresholdResult | null = null;

  constructor(opts: AudiometryProtocolOptions = {}) {
    this.lattices = new FrequencyLattices(opts.lattice ?? new LevelLattice(), opts.frequencyCapsDbHl ?? new Map());
    this.staircaseConfig = opts.staircaseConfig ?? DEFAULT_STAIRCASE_CONFIG;
    this.familiarisationConfig = opts.familiarisationConfig ?? DEFAULT_FAMILIARISATION_CONFIG;
    this.qcProbes = opts.qcProbes ?? true;
    this.interOctaves = opts.interOctaves ?? true;
    const first: Ear = opts.betterEar ?? 'right';
    const second: Ear = first === 'right' ? 'left' : 'right';
    this.earOrder = [first, second];
    this.ears = [new EarState(first, [...FIRST_EAR_SEQUENCE]), new EarState(second, [...SECOND_EAR_SEQUENCE])];
    this.unit = this.newFamiliarisation();
  }

  get isComplete(): boolean {
    return this.unit === null;
  }

  nextPresentation(): Presentation | null {
    return this.unit ? this.unit.nextPresentation() : null;
  }

  recordResponse(responded: boolean): void {
    if (!this.unit) throw new Error('protocol is complete');
    this.unit.recordResponse(responded);
    if (this.unit.isComplete) this.advance();
  }

  earResultsSoFar(): EarResult[] {
    return this.ears.filter((e) => e.familiarisation !== null).map((e) => e.toResult());
  }

  private get ear(): EarState {
    return this.ears[this.earIndex]!;
  }

  private newFamiliarisation(): Familiarisation {
    return new Familiarisation(
      this.ear.ear,
      FAMILIARISATION_FREQUENCY_HZ,
      this.lattices.forFrequency(FAMILIARISATION_FREQUENCY_HZ),
      this.familiarisationConfig,
    );
  }

  private advance(): void {
    const unit = this.unit;
    const ear = this.ear;
    if (unit instanceof Familiarisation) {
      ear.familiarisation = unit.result();
    } else if (unit instanceof HughsonWestlakeStaircase) {
      let res = unit.result();
      if (ear.interOctaveFrequencies.has(res.frequencyHz)) res = { ...res, isInteroctave: true };
      if (this.qcProbes && res.status === 'measured') {
        this.pending = res;
        this.unit = new QcProbe(res, this.lattices.forFrequency(res.frequencyHz));
        return;
      }
      this.commit(ear, res);
    } else if (unit instanceof QcProbe) {
      if (!this.pending) throw new Error('QC probe without a pending result');
      this.pending = null;
      this.commit(ear, unit.apply());
    }

    if (ear.plan.length === 0 && this.interOctaves && !ear.interOctavesEvaluated) {
      ear.interOctavesEvaluated = true;
      const added = interOctavesNeeded(ear.toResult().audiogram);
      for (const f of added) {
        ear.interOctaveFrequencies.add(f);
        ear.plan.push([f, 'initial']);
      }
    }

    if (ear.plan.length > 0) {
      this.unit = this.nextStaircase(ear);
    } else if (this.earIndex + 1 < this.ears.length) {
      this.earIndex += 1;
      this.unit = this.newFamiliarisation();
    } else {
      this.unit = null;
    }
  }

  private commit(ear: EarState, res: ThresholdResult): void {
    ear.thresholds.push(res);
    if (res.testRole === 'retest') this.evaluateRetest(ear, res);
  }

  private nextStaircase(ear: EarState): HughsonWestlakeStaircase {
    const [frequency, role] = ear.plan.shift()!;
    const lattice = this.lattices.forFrequency(frequency);
    return new HughsonWestlakeStaircase(ear.ear, frequency, this.startLevel(ear, lattice), lattice, this.staircaseConfig, role);
  }

  private startLevel(ear: EarState, lattice: LevelLattice): number {
    if (!ear.familiarisation) throw new Error('no familiarisation result');
    const previous = ear.thresholds.length ? ear.lastMeasuredThreshold() : null;
    const base = previous === null ? ear.familiarisation.levelDbHl : previous + SUBSEQUENT_START_OFFSET_DB;
    return lattice.clamp(base)[0];
  }

  private evaluateRetest(ear: EarState, retest: ThresholdResult): void {
    const initial = ear.thresholds.find((r) => r.frequencyHz === RETEST_FREQUENCY_HZ && r.testRole === 'initial');
    if (!initial) throw new Error('retest without an initial 1 kHz search');
    const [stable, delta] = retestIsStable(initial, retest);
    ear.retestDeltaDb = delta;
    if (!stable) {
      ear.unstable1k = true;
      ear.plan.unshift([VERIFICATION_EXTRA_FREQUENCY_HZ, 'verification']);
      ear.plan.unshift([RETEST_FREQUENCY_HZ, 'verification']);
    }
  }
}
