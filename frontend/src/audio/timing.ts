/**
 * Randomised stimulus timing.
 *
 * Defaults follow the project directive (CLAUDE.md): tone 1.0–1.5 s, ISI 1.5–3.0 s,
 * both uniform. Spec §4 suggests 1.5 s ± 0.3 s and 1.5–4.5 s; both fit this config, so
 * pick one per study, record it in the protocol version, and keep it fixed.
 *
 * Hard rule from spec §4: the ISI is never shorter than the tone. It is enforced on
 * every draw, not just on the config, so no configuration can violate it.
 *
 * Unpredictable timing is the primary defence against false positives (BSA §6.5).
 */

/** Returns a uniform random number in [0, 1). */
export type RandomSource = () => number;

export interface StimulusTimingConfig {
  readonly minDurationMs: number;
  readonly maxDurationMs: number;
  readonly minIsiMs: number;
  readonly maxIsiMs: number;
}

export const DEFAULT_TIMING: StimulusTimingConfig = {
  minDurationMs: 1000,
  maxDurationMs: 1500,
  minIsiMs: 1500,
  maxIsiMs: 3000,
};

export interface TrialTiming {
  readonly durationMs: number;
  readonly isiMs: number;
}

export function assertValidTiming(cfg: StimulusTimingConfig, rampMs: number): void {
  const { minDurationMs, maxDurationMs, minIsiMs, maxIsiMs } = cfg;
  const all = [minDurationMs, maxDurationMs, minIsiMs, maxIsiMs];
  if (!all.every(Number.isFinite)) throw new RangeError('timing values must be finite');
  if (minDurationMs > maxDurationMs || minIsiMs > maxIsiMs) {
    throw new RangeError('timing ranges must have min ≤ max');
  }
  if (minDurationMs < 2 * rampMs) {
    throw new RangeError(`tone duration must be ≥ rise + fall (${2 * rampMs} ms)`);
  }
  if (maxIsiMs < maxDurationMs) {
    throw new RangeError('ISI range cannot satisfy "ISI never shorter than the tone"');
  }
}

function uniform(rng: RandomSource, lo: number, hi: number): number {
  const u = rng();
  if (!(u >= 0 && u < 1)) throw new RangeError(`random source returned ${u}, expected [0, 1)`);
  return lo + u * (hi - lo);
}

/** Draw one trial's duration and ISI, rounded to whole ms (the Trial log unit). */
export function drawTrialTiming(cfg: StimulusTimingConfig, rng: RandomSource): TrialTiming {
  const durationMs = Math.round(uniform(rng, cfg.minDurationMs, cfg.maxDurationMs));
  // ISI ≥ this tone: draw from the part of the ISI range that is ≥ durationMs.
  const isiLo = Math.max(cfg.minIsiMs, durationMs);
  const isiMs = Math.round(uniform(rng, isiLo, Math.max(isiLo, cfg.maxIsiMs)));
  return { durationMs, isiMs: Math.max(isiMs, durationMs) };
}

/**
 * Small seedable PRNG (mulberry32) for reproducible tests and simulations.
 * Production uses `Math.random`; the drawn values are logged per trial anyway.
 */
export function mulberry32(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
