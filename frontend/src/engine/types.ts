/**
 * Engine result types — a TypeScript mirror of backend/src/aurohear/audiometry/models.py.
 *
 * The browser engine is a port of the Python reference engine so a session can keep
 * presenting tones while offline. The server still replays and validates every trial;
 * tests/engine/conformance.test.ts proves the two engines agree on golden traces
 * exported from Python (backend/scripts/export_golden_traces.py).
 */

import type { Ear, Presentation, StaircasePhase, TestRole } from '../session/types';

export type { Ear, Presentation, StaircasePhase, TestRole };

export type ThresholdStatus = 'measured' | 'no_response' | 'unresolved';
export type FamiliarisationStatus = 'complete' | 'no_response' | 'inconsistent';

export interface StaircaseTrial {
  readonly seq: number;
  readonly levelDbHl: number;
  readonly phase: 'descent' | 'ascent';
  readonly responded: boolean;
  readonly runIndex: number;
  readonly countedAsAscending: boolean;
  readonly levelClamped: boolean;
}

export interface ThresholdResult {
  readonly ear: Ear;
  readonly frequencyHz: number;
  readonly testRole: TestRole;
  readonly status: ThresholdStatus;
  readonly thresholdDbHl: number | null;
  readonly provisionalDbHl: number | null;
  readonly ascendingHits: number;
  readonly ascendingTrials: number;
  readonly ascentsCompleted: number;
  readonly presentations: number;
  readonly floorLimited: boolean;
  readonly clampEvents: number;
  readonly trials: readonly StaircaseTrial[];
  readonly isInteroctave: boolean;
  readonly qcProbeAtThresholdHeard: boolean | null;
  readonly qcProbePlus5Heard: boolean | null;
}

export interface FamiliarisationResult {
  readonly ear: Ear;
  readonly frequencyHz: number;
  readonly status: FamiliarisationStatus;
  readonly levelDbHl: number;
  readonly responses: readonly boolean[];
}

export interface EarResult {
  readonly ear: Ear;
  readonly familiarisation: FamiliarisationResult;
  readonly thresholds: readonly ThresholdResult[];
  /** One accepted result per frequency, keyed by Hz. */
  readonly audiogram: ReadonlyMap<number, ThresholdResult>;
  readonly retest1kDeltaDb: number | null;
  readonly unstable1k: boolean;
}

/** Common contract of every engine unit (mirrors the Python event-driven API). */
export interface EngineUnit {
  readonly isComplete: boolean;
  nextPresentation(): Presentation | null;
  recordResponse(responded: boolean): void;
}
