/**
 * Raised-cosine (Hann) gating envelope (spec §3.4, §4; CLAUDE.md: 20–50 ms rise/fall).
 *
 *   rise(t) = ½·(1 − cos(π·t / T)),  0 ≤ t ≤ T
 *   fall(t) = rise(T − t)
 *
 * A rectangular gate puts broadband energy ("click") into the ear that is audible well
 * below the tone's own threshold and silently invalidates the measurement. The Hann
 * ramp starts and ends with zero value AND zero slope, so the spectral splatter falls
 * off steeply; it also has no overshoot, so the plateau gain is the peak gain.
 *
 * [VERIFY] Final ramp duration must be confirmed against IEC 60645-1 (spec §4).
 */

export const MIN_RAMP_MS = 20;
export const MAX_RAMP_MS = 50;
export const DEFAULT_RAMP_MS = 25;

export function assertValidRampMs(rampMs: number): void {
  if (!Number.isFinite(rampMs) || rampMs < MIN_RAMP_MS || rampMs > MAX_RAMP_MS) {
    throw new RangeError(`rise/fall must be ${MIN_RAMP_MS}–${MAX_RAMP_MS} ms, got ${rampMs}`);
  }
}

/** Hann rise value at fractional position x ∈ [0, 1]. */
export function hannRise(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return 0.5 * (1 - Math.cos(Math.PI * x));
}

/**
 * Sampled rise curve for `AudioParam.setValueCurveAtTime`.
 *
 * Web Audio linearly interpolates between curve points, so the curve is sampled at
 * (at least) the context sample rate: the rendered ramp is then the exact Hann value at
 * every output sample. Endpoints are exactly 0 and 1.
 */
export function hannRiseCurve(rampMs: number, sampleRate: number): Float32Array {
  assertValidRampMs(rampMs);
  const n = Math.max(2, Math.ceil((rampMs / 1000) * sampleRate) + 1);
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = hannRise(i / (n - 1));
  curve[0] = 0;
  curve[n - 1] = 1;
  return curve;
}

/** The fall curve: the rise reversed (1 → 0). */
export function hannFallCurve(rampMs: number, sampleRate: number): Float32Array {
  return hannRiseCurve(rampMs, sampleRate).reverse();
}

/** Scale a unit curve by a constant gain (used for the click-free abort fade). */
export function scaleCurve(curve: Float32Array, gain: number): Float32Array {
  return curve.map((v) => v * gain);
}

/**
 * Analytic envelope of a gated tone at time t (seconds from onset). Used by tests and by
 * any offline rendering; mirrors exactly what the engine schedules.
 */
export function gateEnvelope(t: number, durationS: number, rampS: number): number {
  if (t <= 0 || t >= durationS) return 0;
  if (t < rampS) return hannRise(t / rampS);
  if (t > durationS - rampS) return hannRise((durationS - t) / rampS);
  return 1;
}
