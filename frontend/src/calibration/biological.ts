/**
 * Tier C biological calibration (spec §3.2, Masalski & Kręcicki [R4]).
 *
 *   1. System volume at a fixed maximum position (VolumeLockPanel instruction).
 *   2. Two 1 kHz tones alternate, 1 s each, binaurally, 5 dB apart.
 *   3. A normally-hearing REFERENCE LISTENER (< ~35 years, no hearing problems) moves a
 *      1 dB slider until only the louder tone is audible.
 *   4. The mean of the two levels defines 0 dB HL for the rig ("0 dB RP-HL").
 *   5. Other frequencies come from an A-weighting-based model (Masalski's model).
 *  [DESIGN] ≥ 3 runs, rejected if their spread exceeds 5 dB; independent 250 Hz and 4 kHz
 *  checks against the model — disagreement > 10 dB at 250 Hz means 250 Hz is not reported.
 *
 * Levels here are digital (dBFS: 0 dBFS = full-scale sine). The resulting profile maps
 * dB HL → digital gain through the engine's CalibrationProfile, with fullScaleDbSpl = 0
 * and etsplDbSpl = the dBFS level of 0 dB HL at that frequency (the fields keep their
 * SPL names, but for Tier C both are relative digital levels — only their difference is
 * used by `gain = 10^((HL + ETSPL + cal − fullScale)/20)`).
 */

import type { CalibrationProfile } from '../audio/calibration';
import { SUPPORTED_FREQUENCIES_HZ, type FrequencyHz } from '../audio/types';

export const TIER_C_PROFILE_VERSION = 'biological-aweighting-v1';
export const TONE_LEVEL_DIFFERENCE_DB = 5;
export const MIN_RUNS = 3;
export const MAX_RUN_SPREAD_DB = 5;
export const CROSS_CHECK_LIMIT_DB = 10;
/** Minimum deliverable level at 1 kHz for a usable session (else the output is too quiet). */
export const MIN_USABLE_MAX_DB_HL_AT_1K = 50;

/**
 * Raw-digital playback for the calibration screen itself: with this profile the engine's
 * `levelDbHl` argument equals dBFS + RAW_OFFSET_DB (the engine refuses levels < −10).
 */
export const RAW_OFFSET_DB = 100;
export const RAW_DIGITAL_PROFILE: CalibrationProfile = {
  profileId: 'raw-digital',
  profileVersion: 'raw-1',
  tier: 'C',
  etsplDbSpl: Object.fromEntries(SUPPORTED_FREQUENCIES_HZ.map((f) => [f, -RAW_OFFSET_DB])),
  fullScaleDbSpl: Object.fromEntries(SUPPORTED_FREQUENCIES_HZ.map((f) => [f, 0])),
  calOffsetDb: 0,
  headroomDb: 1,
};
export const dbfsToRawLevel = (dbfs: number): number => dbfs + RAW_OFFSET_DB;

/** IEC 61672-1 A-weighting (dB), ≈ 0 at 1 kHz. A standard formula, not a lookup table. */
export function aWeightingDb(f: number): number {
  const f2 = f * f;
  const ra =
    (12194 ** 2 * f2 * f2) /
    ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return 20 * Math.log10(ra) + 2.0;
}

/** Model level (dBFS) of 0 dB HL at f, from the 1 kHz reference (spec §3.2 step 5). */
export function modelZeroHlDbfs(ref1kDbfs: number, f: number): number {
  return ref1kDbfs - (aWeightingDb(f) - aWeightingDb(1000));
}

/** One run: the louder tone's level when only it is audible → reference = mean of both. */
export function runReferenceDbfs(louderDbfs: number): number {
  return louderDbfs - TONE_LEVEL_DIFFERENCE_DB / 2;
}

export interface RunSummary {
  readonly runsDbfs: readonly number[];
  readonly referenceDbfs: number;
  readonly spreadDb: number;
  readonly accepted: boolean;
  readonly reason: string | null;
}

export function summariseRuns(runsDbfs: readonly number[]): RunSummary {
  if (runsDbfs.length === 0) throw new RangeError('no calibration runs');
  const referenceDbfs = runsDbfs.reduce((a, b) => a + b, 0) / runsDbfs.length;
  const spreadDb = Math.max(...runsDbfs) - Math.min(...runsDbfs);
  let reason: string | null = null;
  if (runsDbfs.length < MIN_RUNS) reason = `at least ${MIN_RUNS} runs are required`;
  else if (spreadDb > MAX_RUN_SPREAD_DB) reason = `runs differ by ${spreadDb.toFixed(1)} dB (more than ${MAX_RUN_SPREAD_DB} dB)`;
  return { runsDbfs: [...runsDbfs], referenceDbfs, spreadDb, accepted: reason === null, reason };
}

export interface CrossCheck {
  readonly frequencyHz: FrequencyHz;
  readonly measuredDbfs: number;
  readonly predictedDbfs: number;
  /** measured − model prediction. */
  readonly deltaDb: number;
  readonly withinLimit: boolean;
}

export function crossCheck(ref1kDbfs: number, frequencyHz: FrequencyHz, measuredDbfs: number): CrossCheck {
  const predictedDbfs = modelZeroHlDbfs(ref1kDbfs, frequencyHz);
  const deltaDb = measuredDbfs - predictedDbfs;
  return { frequencyHz, measuredDbfs, predictedDbfs, deltaDb, withinLimit: Math.abs(deltaDb) <= CROSS_CHECK_LIMIT_DB };
}

/** The Tier C CalibrationProfile for the tone engine. */
export function biologicalProfile(ref1kDbfs: number): CalibrationProfile {
  return {
    profileId: 'biological',
    profileVersion: TIER_C_PROFILE_VERSION,
    tier: 'C',
    etsplDbSpl: Object.fromEntries(SUPPORTED_FREQUENCIES_HZ.map((f) => [f, modelZeroHlDbfs(ref1kDbfs, f)])),
    fullScaleDbSpl: Object.fromEntries(SUPPORTED_FREQUENCIES_HZ.map((f) => [f, 0])),
    calOffsetDb: 0,
    headroomDb: 1,
  };
}
