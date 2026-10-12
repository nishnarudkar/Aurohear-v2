/** Mirror of audiometry/qc_probe.py — QC probe at T and T + 5 dB (spec §6.3, §10 #7). */

import type { Presentation } from '../session/types';
import { type LevelLattice, STEP_UP_DB } from './levels';
import type { EngineUnit, ThresholdResult } from './types';

export class QcProbe implements EngineUnit {
  private readonly levels: number[];
  private readonly responses: boolean[] = [];

  constructor(
    private readonly measured: ThresholdResult,
    lattice: LevelLattice,
  ) {
    if (measured.status !== 'measured' || measured.thresholdDbHl === null) {
      throw new Error('QC probes follow measured thresholds only');
    }
    const t = measured.thresholdDbHl;
    this.levels = t + STEP_UP_DB <= lattice.ceiling ? [t, t + STEP_UP_DB] : [t];
  }

  get isComplete(): boolean {
    return this.responses.length === this.levels.length;
  }

  nextPresentation(): Presentation | null {
    if (this.isComplete) return null;
    const r = this.measured;
    return {
      ear: r.ear,
      frequencyHz: r.frequencyHz,
      levelDbHl: this.levels[this.responses.length]!,
      phase: 'qc_probe',
      testRole: r.testRole,
    };
  }

  recordResponse(responded: boolean): void {
    if (this.isComplete) throw new Error('QC probe has already terminated');
    this.responses.push(responded);
  }

  apply(): ThresholdResult {
    if (!this.isComplete) throw new Error('QC probe has not terminated yet');
    return {
      ...this.measured,
      qcProbeAtThresholdHeard: this.responses[0]!,
      qcProbePlus5Heard: this.responses.length > 1 ? this.responses[1]! : null,
    };
  }
}
