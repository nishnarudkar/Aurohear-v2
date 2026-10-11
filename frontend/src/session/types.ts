/**
 * Types for the client-side test-session FSM (spec §7.2) and its two ports.
 *
 * All timestamps are milliseconds on ONE monotonic clock: `performance.now()` in the
 * browser (the same clock as `Event.timeStamp`), a simulated clock in tests. Audio
 * context times are converted into this domain by the stimulus port.
 */

import type { Ear } from '../audio/types';

export type { Ear };

/** Mirrors backend `Phase` (spec §12.1 Trial.phase). */
export type StaircasePhase = 'familiarisation' | 'descent' | 'ascent';
export type TrialPhase = StaircasePhase | 'catch';

/** Mirrors backend `SearchRole`. */
export type TestRole = 'initial' | 'retest' | 'verification';

/** One tone requested by the threshold procedure (mirrors backend `Presentation`). */
export interface Presentation {
  readonly ear: Ear;
  readonly frequencyHz: number;
  readonly levelDbHl: number;
  readonly phase: StaircasePhase;
  readonly testRole: TestRole;
}

/**
 * Port to the Hughson–Westlake / ASHA engine (backend `AudiometryProtocol`).
 * Async so it can be served over HTTP; `null` means the protocol is complete.
 * Catch trials are never reported to it — they must not move the staircase.
 */
export interface ThresholdProcedure {
  start(): Promise<Presentation | null>;
  respond(heard: boolean): Promise<Presentation | null>;
}

export interface StimulusTiming {
  readonly durationMs: number;
  readonly isiMs: number;
}

/** A tone handed to the audio layer, with its onset/offset on the session clock. */
export interface ScheduledStimulus extends StimulusTiming {
  readonly onsetMs: number;
  readonly offsetMs: number;
  /** AudioContext clock (s) of the onset — spec §12.1 `presented_at_ms` source. */
  readonly audioContextOnsetS: number | null;
  readonly presentedLevelDbHl: number;
  readonly levelClamped: boolean;
  cancel(): void;
}

/** Port to the audio layer (implemented over ToneStimulusEngine). */
export interface StimulusPort {
  /** Same randomised distribution as real tones — used for silent catch trials. */
  drawTiming(): StimulusTiming;
  /** Schedule a tone after a randomised ISI; must not block. */
  present(presentation: Presentation): ScheduledStimulus;
}

export interface SessionDeps {
  readonly procedure: ThresholdProcedure;
  readonly stimulus: StimulusPort;
  /** Monotonic ms clock shared with response `timestampMs` values. */
  readonly now: () => number;
  /** Uniform [0, 1) — catch-trial placement. */
  readonly random: () => number;
  readonly createId: () => string;
  /**
   * Receives every committed trial record exactly once, in `seq` order — tone, catch
   * and discarded trials alike (the API adapter uploads them). Must not block or throw.
   */
  readonly trialLog?: (trial: TrialRecord) => void;
}

export interface SessionConfig {
  /** Fraction of eligible trials replaced by a silent catch trial (spec §6.3: ~10 %). */
  readonly catchTrialRate: number;
  /** Response window after tone offset (spec §6.3: offset + 2.0 s). */
  readonly responseWindowAfterOffsetMs: number;
  /**
   * Scoring waits this long after the window closes, so a press time-stamped inside the
   * window but dispatched late by a busy main thread is still counted. Classification
   * remains strictly by timestamp; this does not widen the window.
   */
  readonly scoringGraceMs: number;
  /** Presses closer together than this are one press (spec §7.4: 150 ms). */
  readonly debounceMs: number;
  /** False alarms (catch or out-of-window) that trigger re-instruction (spec §6.3: 2). */
  readonly falseAlarmsBeforeReinstruction: number;
  /** Mandatory break before the second ear's familiarisation (spec §6.6: 30 s). */
  readonly interEarBreakMs: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  catchTrialRate: 0.1,
  responseWindowAfterOffsetMs: 2000,
  scoringGraceMs: 100,
  debounceMs: 150,
  falseAlarmsBeforeReinstruction: 2,
  interEarBreakMs: 30_000,
};

// ------------------------------------------------------------------ log records

export type ResponseClassification =
  | 'hit' //                 first press inside a tone trial's window
  | 'repeat' //              further press inside the same window (logged, not scored)
  | 'catch_false_alarm' //   press inside a silent catch trial's window
  | 'out_of_window' //       press between trials, before the next onset
  | 'late_after_scoring' //  timestamp inside a window already scored (dispatch lag)
  | 'debounced' //           within debounceMs of the previous accepted press
  | 'no_trial'; //           press on an instruction / break screen

/** Every press, append-only. */
export interface ResponseRecord {
  readonly timestampMs: number;
  readonly classification: ResponseClassification;
  readonly trialId: string | null;
  readonly latencyMs: number | null;
  readonly source: ResponseSource;
}

export type ResponseSource = 'keyboard' | 'pointer' | 'touch' | 'switch' | 'unknown';

/** One presentation (tone or catch), append-only — spec §12.1 Trial. */
export interface TrialRecord {
  readonly trialId: string;
  readonly seq: number;
  readonly ear: Ear;
  readonly frequencyHz: number;
  readonly requestedLevelDbHl: number | null;
  readonly presentedLevelDbHl: number | null;
  readonly levelClamped: boolean;
  readonly phase: TrialPhase;
  readonly testRole: TestRole;
  readonly isCatchTrial: boolean;
  readonly scheduledAtMs: number;
  readonly onsetMs: number;
  readonly offsetMs: number;
  readonly windowEndMs: number;
  readonly audioContextOnsetS: number | null;
  readonly durationMs: number;
  readonly isiMs: number;
  readonly responded: boolean;
  readonly responseTimestampMs: number | null;
  readonly responseLatencyMs: number | null;
  readonly responseInWindow: boolean;
  readonly extraResponses: number;
  readonly discarded: boolean;
  readonly discardReason: string | null;
}

export type AbortReason =
  | 'user'
  | 'context_suspended'
  | 'context_closed'
  | 'context_interrupted'
  | 'device_change'
  | 'procedure_error'
  | 'stimulus_error';

export type ReinstructionReason = 'false_alarms' | 'unstable_retest';

export interface TransitionRecord {
  readonly atMs: number;
  readonly state: string;
}
