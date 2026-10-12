/** Mirror of audiometry/familiarisation.py — 1 kHz familiarisation (spec §6.2). */

import type { Ear, Presentation } from '../session/types';
import { LevelLattice } from './levels';
import type { EngineUnit, FamiliarisationResult, FamiliarisationStatus } from './types';

export interface FamiliarisationConfig {
  readonly startLevelDbHl: number;
  readonly coarseStepDb: number;
  readonly fineStepDb: number;
  readonly fineAboveDbHl: number;
  readonly consecutiveRequired: number;
  readonly ceilingConfirmations: number;
  readonly maxPresentations: number;
}

export const DEFAULT_FAMILIARISATION_CONFIG: FamiliarisationConfig = {
  startLevelDbHl: 40,
  coarseStepDb: 10,
  fineStepDb: 5,
  fineAboveDbHl: 80,
  consecutiveRequired: 2,
  ceilingConfirmations: 2,
  maxPresentations: 12,
};

export class Familiarisation implements EngineUnit {
  private level: number;
  private consecutiveHits = 0;
  private ceilingMisses = 0;
  private highestHeard: number | null = null;
  private readonly responses: boolean[] = [];
  private status: FamiliarisationStatus | null = null;
  private finalLevel: number | null = null;

  constructor(
    readonly ear: Ear,
    readonly frequencyHz = 1000,
    readonly lattice: LevelLattice = new LevelLattice(),
    readonly config: FamiliarisationConfig = DEFAULT_FAMILIARISATION_CONFIG,
  ) {
    this.level = lattice.snap(config.startLevelDbHl);
  }

  get isComplete(): boolean {
    return this.status !== null;
  }

  nextPresentation(): Presentation | null {
    if (this.isComplete) return null;
    return { ear: this.ear, frequencyHz: this.frequencyHz, levelDbHl: this.level, phase: 'familiarisation', testRole: 'initial' };
  }

  recordResponse(responded: boolean): void {
    if (this.isComplete) throw new Error('familiarisation has already terminated');
    const cfg = this.config;
    const level = this.level;
    this.responses.push(responded);
    if (responded) {
      this.ceilingMisses = 0;
      this.consecutiveHits += 1;
      this.highestHeard = Math.max(level, this.highestHeard ?? level);
      if (this.consecutiveHits >= cfg.consecutiveRequired) {
        this.finish('complete', level);
        return;
      }
    } else {
      this.consecutiveHits = 0;
      if (level === this.lattice.ceiling) {
        this.ceilingMisses += 1;
        if (this.ceilingMisses >= cfg.ceilingConfirmations) {
          this.finish('no_response', level);
          return;
        }
      }
      this.level = this.stepUp(level);
    }
    if (this.responses.length >= cfg.maxPresentations) {
      this.finish('inconsistent', this.highestHeard ?? this.lattice.ceiling);
    }
  }

  private stepUp(level: number): number {
    const cfg = this.config;
    const requested = level < cfg.fineAboveDbHl ? Math.min(level + cfg.coarseStepDb, cfg.fineAboveDbHl) : level + cfg.fineStepDb;
    return this.lattice.clamp(requested)[0];
  }

  private finish(status: FamiliarisationStatus, level: number): void {
    this.status = status;
    this.finalLevel = level;
  }

  result(): FamiliarisationResult {
    if (this.status === null || this.finalLevel === null) throw new Error('familiarisation has not terminated yet');
    return { ear: this.ear, frequencyHz: this.frequencyHz, status: this.status, levelDbHl: this.finalLevel, responses: [...this.responses] };
  }
}
