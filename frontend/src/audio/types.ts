/**
 * Shared types for the AuroHear stimulus layer.
 *
 * Field names mirror the backend Trial schema (spec §12.1) so a ScheduledTone can be
 * logged without renaming: `ear`, `frequency_hz` ↔ `frequencyHz`, `duration_ms`, `isi_ms`.
 */

export type Ear = 'left' | 'right';

/** Output channel index on a 2-channel destination (Web Audio discrete stereo order). */
export const EAR_CHANNEL: Readonly<Record<Ear, 0 | 1>> = { left: 0, right: 1 };

/** Frequencies this engine will generate (spec §6.5 F ∪ F+); 250–8000 Hz. */
export const SUPPORTED_FREQUENCIES_HZ = [
  250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000,
] as const;
export type FrequencyHz = (typeof SUPPORTED_FREQUENCIES_HZ)[number];

export function isSupportedFrequency(f: number): f is FrequencyHz {
  return (SUPPORTED_FREQUENCIES_HZ as readonly number[]).includes(f);
}

/** Why a tone stopped sounding. */
export type ToneOutcome = 'completed' | 'cancelled';

/** Everything the runner needs to log and score one presentation. */
export interface ScheduledTone {
  readonly id: number;
  readonly ear: Ear;
  readonly frequencyHz: FrequencyHz;
  /** Level the staircase asked for. */
  readonly requestedLevelDbHl: number;
  /** Level actually delivered (≤ requested when clamped to the output ceiling). */
  readonly presentedLevelDbHl: number;
  /** True when the request exceeded the ceiling — QC indicator 13 (spec §10). */
  readonly levelClamped: boolean;
  /** Linear gain applied at the envelope plateau (digital full scale = 1). */
  readonly linearGain: number;
  /** Gate duration, onset to offset, rise and fall included. */
  readonly durationMs: number;
  /** Silent interval preceding the onset. */
  readonly isiMs: number;
  readonly rampMs: number;
  /** AudioContext clock (s) at which the rise begins. */
  readonly onsetTime: number;
  /** AudioContext clock (s) at which the fall reaches zero. */
  readonly offsetTime: number;
  /** Resolves once the oscillator has stopped and the nodes are released. */
  readonly ended: Promise<ToneOutcome>;
  /**
   * Abort this tone with a click-free fade. Use for session aborts only — a listener
   * response must NOT truncate the tone (spec §4, BSA §6.5).
   */
  cancel(): void;
}
