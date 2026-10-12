/**
 * Mirror of audiometry/staircase.py — modified Hughson–Westlake for one ear × frequency.
 * See the Python module for the clinical rationale; this file is a line-by-line port.
 */

import type { Ear, Presentation, TestRole } from '../session/types';
import { LevelLattice, STEP_DOWN_DB, STEP_UP_DB } from './levels';
import type { EngineUnit, StaircaseTrial, ThresholdResult, ThresholdStatus } from './types';

export interface StaircaseConfig {
  readonly minHits: number;
  readonly minHitRatio: number;
  readonly maxAscents: number;
  readonly maxPresentations: number;
  readonly ceilingConfirmations: number;
}

export const DEFAULT_STAIRCASE_CONFIG: StaircaseConfig = {
  minHits: 2,
  minHitRatio: 0.5,
  maxAscents: 6,
  maxPresentations: 25,
  ceilingConfirmations: 2,
};

export class HughsonWestlakeStaircase implements EngineUnit {
  private level: number;
  private levelClamped = false;
  private inAscent = false;
  private runIndex = 0;
  private ascentsCompleted = 0;
  private ceilingMisses = 0;
  private clampEvents = 0;
  private readonly ascTrials = new Map<number, number>();
  private readonly ascHits = new Map<number, number>();
  private readonly trials: StaircaseTrial[] = [];
  private status: ThresholdStatus | null = null;
  private threshold: number | null = null;

  constructor(
    readonly ear: Ear,
    readonly frequencyHz: number,
    startLevelDbHl: number,
    readonly lattice: LevelLattice = new LevelLattice(),
    readonly config: StaircaseConfig = DEFAULT_STAIRCASE_CONFIG,
    readonly role: TestRole = 'initial',
  ) {
    if (!lattice.contains(startLevelDbHl)) {
      throw new RangeError(`start level ${startLevelDbHl} dB HL is not on the lattice`);
    }
    this.level = startLevelDbHl;
  }

  get isComplete(): boolean {
    return this.status !== null;
  }

  private get currentPhase(): 'descent' | 'ascent' {
    return this.inAscent ? 'ascent' : 'descent';
  }

  nextPresentation(): Presentation | null {
    if (this.isComplete) return null;
    return { ear: this.ear, frequencyHz: this.frequencyHz, levelDbHl: this.level, phase: this.currentPhase, testRole: this.role };
  }

  recordResponse(responded: boolean): void {
    if (this.isComplete) throw new Error('staircase has already terminated');
    const level = this.level;
    const counted = this.inAscent || level === this.lattice.floor;
    this.trials.push({
      seq: this.trials.length,
      levelDbHl: level,
      phase: this.currentPhase,
      responded,
      runIndex: this.runIndex,
      countedAsAscending: counted,
      levelClamped: this.levelClamped,
    });
    if (counted) {
      this.ascTrials.set(level, (this.ascTrials.get(level) ?? 0) + 1);
      if (responded) this.ascHits.set(level, (this.ascHits.get(level) ?? 0) + 1);
    }
    if (responded) this.onResponse(level, counted);
    else this.onNoResponse(level);
    if (!this.isComplete) this.applySafetyLimits();
  }

  private onResponse(level: number, counted: boolean): void {
    this.ceilingMisses = 0;
    if (this.inAscent) {
      this.ascentsCompleted += 1;
      this.runIndex += 1;
    }
    if (counted) {
      const met = this.lowestLevelMeeting(this.config.minHits);
      if (met !== null) {
        this.finish('measured', met);
        return;
      }
    }
    this.inAscent = false;
    this.moveTo(level - STEP_DOWN_DB);
  }

  private onNoResponse(level: number): void {
    if (level === this.lattice.ceiling) {
      this.ceilingMisses += 1;
      if (this.ceilingMisses >= this.config.ceilingConfirmations) {
        this.finish('no_response', this.lattice.ceiling);
        return;
      }
    } else {
      this.ceilingMisses = 0;
    }
    this.inAscent = true;
    this.moveTo(level + STEP_UP_DB);
  }

  private applySafetyLimits(): void {
    if (this.ascentsCompleted >= this.config.maxAscents || this.trials.length >= this.config.maxPresentations) {
      this.finish('unresolved', null);
    }
  }

  private moveTo(requested: number): void {
    [this.level, this.levelClamped] = this.lattice.clamp(requested);
    if (this.levelClamped) this.clampEvents += 1;
  }

  private finish(status: ThresholdStatus, threshold: number | null): void {
    this.status = status;
    this.threshold = threshold;
  }

  private meets(level: number, minHits: number): boolean {
    const hits = this.ascHits.get(level) ?? 0;
    return hits >= minHits && hits >= this.config.minHitRatio * (this.ascTrials.get(level) ?? 0);
  }

  private lowestLevelMeeting(minHits: number): number | null {
    let best: number | null = null;
    for (const lv of this.ascHits.keys()) if (this.meets(lv, minHits) && (best === null || lv < best)) best = lv;
    return best;
  }

  result(): ThresholdResult {
    if (this.status === null) throw new Error('staircase has not terminated yet');
    const provisional = this.status === 'unresolved' ? this.lowestLevelMeeting(1) : null;
    const ref = this.status === 'unresolved' ? provisional : this.threshold;
    return {
      ear: this.ear,
      frequencyHz: this.frequencyHz,
      testRole: this.role,
      status: this.status,
      thresholdDbHl: this.threshold,
      provisionalDbHl: provisional,
      ascendingHits: ref !== null ? (this.ascHits.get(ref) ?? 0) : 0,
      ascendingTrials: ref !== null ? (this.ascTrials.get(ref) ?? 0) : 0,
      ascentsCompleted: this.ascentsCompleted,
      presentations: this.trials.length,
      floorLimited: this.status === 'measured' && this.threshold === this.lattice.floor,
      clampEvents: this.clampEvents,
      trials: [...this.trials],
      isInteroctave: false,
      qcProbeAtThresholdHeard: null,
      qcProbePlus5Heard: null,
    };
  }
}
