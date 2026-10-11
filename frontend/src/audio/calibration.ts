/**
 * dB HL → linear digital gain (spec §4.1):
 *
 *   gain = 10 ^ ((HL_dB + ETSPL_f + cal_offset − full_scale_SPL_f) / 20)
 *
 * where `full_scale_SPL_f` is the SPL the transducer produces at frequency f for a
 * full-scale (peak amplitude 1.0) sine at the locked system volume, `ETSPL_f` the
 * equivalent threshold SPL for that transducer, and `cal_offset` the session's
 * calibration correction (biological Tier C, or 0 for Tier A/B).
 *
 * Every profile value is required per frequency — a missing entry throws instead of
 * silently defaulting (GAP_ANALYSIS #6/#7). Numbers in a profile must come from
 * measurement, never from memory (spec §3.3 [VERIFY]).
 */

import type { FrequencyHz } from './types';

/** Absolute presentation ceiling for unsupervised sessions (spec §3.4). */
export const ABSOLUTE_MAX_DB_HL = 90;
export const MIN_DB_HL = -10;

export type CalibrationTier = 'A' | 'B' | 'C';

export interface CalibrationProfile {
  readonly profileId: string;
  readonly profileVersion: string;
  readonly tier: CalibrationTier;
  /** ETSPL (dB SPL) per frequency for this transducer. */
  readonly etsplDbSpl: Readonly<Partial<Record<FrequencyHz, number>>>;
  /** SPL (dB) at digital full scale, per frequency, at the locked volume. */
  readonly fullScaleDbSpl: Readonly<Partial<Record<FrequencyHz, number>>>;
  /** Optional per-frequency safety limit (dB HL) from the profile table (spec §3.3). */
  readonly maxSafeDbHl?: Readonly<Partial<Record<FrequencyHz, number>>>;
  /** Session calibration correction in dB (0 for Tier A/B). */
  readonly calOffsetDb: number;
  /** Digital headroom kept below full scale (dB) — margin for DAC/intersample peaks. */
  readonly headroomDb: number;
}

export interface LevelResolution {
  readonly requestedDbHl: number;
  readonly presentedDbHl: number;
  readonly clamped: boolean;
  readonly ceilingDbHl: number;
  readonly linearGain: number;
}

function required(
  table: Readonly<Partial<Record<FrequencyHz, number>>>,
  f: FrequencyHz,
  name: string,
): number {
  const v = table[f];
  if (v === undefined || !Number.isFinite(v)) {
    throw new Error(`calibration profile is missing ${name} at ${f} Hz`);
  }
  return v;
}

/** Highest dB HL deliverable at f without exceeding full scale minus headroom. */
export function maxAchievableDbHl(profile: CalibrationProfile, f: FrequencyHz): number {
  return (
    required(profile.fullScaleDbSpl, f, 'fullScaleDbSpl') -
    required(profile.etsplDbSpl, f, 'etsplDbSpl') -
    profile.calOffsetDb -
    profile.headroomDb
  );
}

/** Presentation ceiling at f: min(achievable, profile safety limit, 90 dB HL). */
export function ceilingDbHl(profile: CalibrationProfile, f: FrequencyHz): number {
  const safe = profile.maxSafeDbHl?.[f] ?? ABSOLUTE_MAX_DB_HL;
  return Math.min(maxAchievableDbHl(profile, f), safe, ABSOLUTE_MAX_DB_HL);
}

export function dbHlToLinearGain(profile: CalibrationProfile, f: FrequencyHz, dbHl: number): number {
  const exponent =
    dbHl +
    required(profile.etsplDbSpl, f, 'etsplDbSpl') +
    profile.calOffsetDb -
    required(profile.fullScaleDbSpl, f, 'fullScaleDbSpl');
  return 10 ** (exponent / 20);
}

/**
 * Resolve a requested level to a deliverable one. Requests above the ceiling are
 * clamped and flagged (QC indicator 13, spec §10) — never silently delivered louder
 * than the safety cap, and never silently delivered quieter without a flag.
 */
export function resolveLevel(
  profile: CalibrationProfile,
  f: FrequencyHz,
  requestedDbHl: number,
): LevelResolution {
  if (!Number.isFinite(requestedDbHl) || requestedDbHl < MIN_DB_HL) {
    throw new RangeError(`level must be ≥ ${MIN_DB_HL} dB HL, got ${requestedDbHl}`);
  }
  const ceiling = ceilingDbHl(profile, f);
  const clamped = requestedDbHl > ceiling;
  const presented = clamped ? ceiling : requestedDbHl;
  return {
    requestedDbHl,
    presentedDbHl: presented,
    clamped,
    ceilingDbHl: ceiling,
    linearGain: dbHlToLinearGain(profile, f, presented),
  };
}
