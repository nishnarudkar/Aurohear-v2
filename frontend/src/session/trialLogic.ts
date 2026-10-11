/**
 * Pure trial logic used by the session machine: catch-trial placement, response
 * classification and the QC summary. No XState, no I/O — property-tested directly.
 */

import type {
  Presentation,
  ResponseClassification,
  ResponseRecord,
  SessionConfig,
  StimulusTiming,
  TrialRecord,
} from './types';

/** The trial currently being presented (tone or silent catch). */
export interface ActiveTrial extends StimulusTiming {
  readonly trialId: string;
  readonly seq: number;
  /** For a catch trial: the staircase presentation it was inserted before. */
  readonly presentation: Presentation;
  readonly isCatchTrial: boolean;
  readonly scheduledAtMs: number;
  readonly onsetMs: number;
  readonly offsetMs: number;
  readonly windowEndMs: number;
  readonly audioContextOnsetS: number | null;
  readonly presentedLevelDbHl: number | null;
  readonly levelClamped: boolean;
  readonly cancel: () => void;
  readonly responseTimestampMs: number | null;
  readonly extraResponses: number;
}

// ------------------------------------------------------------------ catch trials

/**
 * Should the next trial be a silent catch trial?
 *
 * Never during familiarisation (the listener is still learning the task) and never
 * twice in a row (a run of silences is itself a cue and stalls the test).
 */
export function shouldInsertCatchTrial(
  next: Presentation,
  previousWasCatch: boolean,
  rate: number,
  random: () => number,
): boolean {
  if (next.phase === 'familiarisation' || previousWasCatch || rate <= 0) return false;
  return random() < rate;
}

// ------------------------------------------------------------------ search boundaries

/** Identifies one threshold search, so the machine can detect when a new one starts. */
export function searchKey(p: Presentation): string {
  const family = p.phase === 'familiarisation' ? 'fam' : 'hw';
  return `${p.ear}|${p.frequencyHz}|${p.testRole}|${family}`;
}

export function isFamiliarisationStart(next: Presentation, previousKey: string | null): boolean {
  return next.phase === 'familiarisation' && searchKey(next) !== previousKey;
}

export function isRetest1kStart(next: Presentation, previousKey: string | null): boolean {
  return (
    next.frequencyHz === 1000 &&
    next.testRole !== 'initial' &&
    next.phase !== 'familiarisation' &&
    searchKey(next) !== previousKey
  );
}

// ------------------------------------------------------------------ responses

export interface ClassifyInput {
  readonly timestampMs: number;
  readonly lastAcceptedPressMs: number | null;
  /** True while the machine is in ISI / TonePresenting / CatchTrial / ResponseWindow. */
  readonly inTrialLoop: boolean;
  readonly trial: ActiveTrial | null;
  /** Window end of the most recently scored trial (for late-dispatched events). */
  readonly lastScoredWindowEndMs: number | null;
  readonly debounceMs: number;
}

/**
 * Classify a press purely from its timestamp relative to the trial timeline — never
 * from which state the machine happens to be in when the event is processed, so timer
 * jitter cannot turn a hit into a false alarm or vice versa.
 */
export function classifyResponse(i: ClassifyInput): ResponseClassification {
  const t = i.timestampMs;
  if (i.lastAcceptedPressMs !== null && t - i.lastAcceptedPressMs < i.debounceMs) return 'debounced';
  if (!i.inTrialLoop) return 'no_trial';
  if (i.lastScoredWindowEndMs !== null && t <= i.lastScoredWindowEndMs && (!i.trial || t < i.trial.onsetMs)) {
    return 'late_after_scoring';
  }
  const tr = i.trial;
  if (!tr || t < tr.onsetMs || t > tr.windowEndMs) return 'out_of_window';
  // Only the first press in a window is scored — for catch trials too, so one listener
  // pressing twice in a silent interval is one false alarm, not two.
  if (tr.responseTimestampMs !== null) return 'repeat';
  return tr.isCatchTrial ? 'catch_false_alarm' : 'hit';
}

/** Presses that count toward the re-instruction trigger (spec §6.3, §7.2). */
export function isFalseAlarm(c: ResponseClassification): boolean {
  return c === 'catch_false_alarm' || c === 'out_of_window';
}

export function toResponseRecord(
  i: ClassifyInput,
  classification: ResponseClassification,
  source: ResponseRecord['source'],
): ResponseRecord {
  const tr = i.trial;
  const attached = classification === 'hit' || classification === 'repeat' || classification === 'catch_false_alarm';
  return {
    timestampMs: i.timestampMs,
    classification,
    trialId: attached && tr ? tr.trialId : null,
    latencyMs: attached && tr ? i.timestampMs - tr.onsetMs : null,
    source,
  };
}

// ------------------------------------------------------------------ trial records

export function toTrialRecord(
  tr: ActiveTrial,
  discard: { readonly reason: string } | null = null,
): TrialRecord {
  const responded = tr.responseTimestampMs !== null;
  const p = tr.presentation;
  return {
    trialId: tr.trialId,
    seq: tr.seq,
    ear: p.ear,
    frequencyHz: p.frequencyHz,
    requestedLevelDbHl: tr.isCatchTrial ? null : p.levelDbHl,
    presentedLevelDbHl: tr.presentedLevelDbHl,
    levelClamped: tr.levelClamped,
    phase: tr.isCatchTrial ? 'catch' : p.phase,
    testRole: p.testRole,
    isCatchTrial: tr.isCatchTrial,
    scheduledAtMs: tr.scheduledAtMs,
    onsetMs: tr.onsetMs,
    offsetMs: tr.offsetMs,
    windowEndMs: tr.windowEndMs,
    audioContextOnsetS: tr.audioContextOnsetS,
    durationMs: tr.durationMs,
    isiMs: tr.isiMs,
    responded,
    responseTimestampMs: tr.responseTimestampMs,
    responseLatencyMs: responded ? tr.responseTimestampMs! - tr.onsetMs : null,
    responseInWindow: responded,
    extraResponses: tr.extraResponses,
    discarded: discard !== null,
    discardReason: discard?.reason ?? null,
  };
}

// ------------------------------------------------------------------ QC summary

export interface SessionQc {
  readonly toneTrials: number;
  readonly catchTrials: number;
  readonly catchFalseAlarms: number;
  /** QUALIND #5 (spec §10): catch-trial responses ÷ catch trials. null if no catch trials. */
  readonly falsePositiveRate: number | null;
  readonly outOfWindowResponses: number;
  readonly hits: number;
  /** QUALIND #4 (spec §10): stimulus-onset → response latency of hits. */
  readonly meanLatencyMs: number | null;
  readonly sdLatencyMs: number | null;
  readonly medianLatencyMs: number | null;
  readonly discardedTrials: number;
  readonly reinstructions: number;
}

export function summariseQc(
  trials: readonly TrialRecord[],
  responses: readonly ResponseRecord[],
  reinstructions: number,
): SessionQc {
  const kept = trials.filter((t) => !t.discarded);
  const catches = kept.filter((t) => t.isCatchTrial);
  const tones = kept.filter((t) => !t.isCatchTrial);
  const catchFAs = catches.filter((t) => t.responded).length;
  const latencies = tones
    .map((t) => t.responseLatencyMs)
    .filter((l): l is number => l !== null)
    .sort((a, b) => a - b);
  const n = latencies.length;
  const mean = n ? latencies.reduce((s, x) => s + x, 0) / n : null;
  const sd =
    n > 1 && mean !== null
      ? Math.sqrt(latencies.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1))
      : null;
  const median = n ? (n % 2 ? latencies[(n - 1) / 2]! : (latencies[n / 2 - 1]! + latencies[n / 2]!) / 2) : null;
  return {
    toneTrials: tones.length,
    catchTrials: catches.length,
    catchFalseAlarms: catchFAs,
    falsePositiveRate: catches.length ? catchFAs / catches.length : null,
    outOfWindowResponses: responses.filter((r) => r.classification === 'out_of_window').length,
    hits: n,
    meanLatencyMs: mean,
    sdLatencyMs: sd,
    medianLatencyMs: median,
    discardedTrials: trials.length - kept.length,
    reinstructions,
  };
}
