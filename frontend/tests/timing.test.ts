import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assertValidTiming,
  DEFAULT_RAMP_MS,
  DEFAULT_TIMING,
  drawTrialTiming,
  mulberry32,
  type StimulusTimingConfig,
} from '../src/audio';

describe('randomised trial timing', () => {
  it('defaults are tone 1.0–1.5 s and ISI 1.5–3.0 s (CLAUDE.md)', () => {
    expect(DEFAULT_TIMING).toEqual({ minDurationMs: 1000, maxDurationMs: 1500, minIsiMs: 1500, maxIsiMs: 3000 });
  });

  it('every draw is in range, whole ms, and ISI is never shorter than the tone', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const rng = mulberry32(seed);
        for (let i = 0; i < 50; i++) {
          const { durationMs, isiMs } = drawTrialTiming(DEFAULT_TIMING, rng);
          expect(Number.isInteger(durationMs) && Number.isInteger(isiMs)).toBe(true);
          expect(durationMs).toBeGreaterThanOrEqual(1000);
          expect(durationMs).toBeLessThanOrEqual(1500);
          expect(isiMs).toBeGreaterThanOrEqual(1500);
          expect(isiMs).toBeLessThanOrEqual(3000);
          expect(isiMs).toBeGreaterThanOrEqual(durationMs);
        }
      }),
    );
  });

  it('holds for any valid custom config (e.g. the spec §4 1.2–1.8 s / 1.5–4.5 s variant)', () => {
    const config = fc
      .record({
        minDurationMs: fc.integer({ min: 2 * DEFAULT_RAMP_MS, max: 3000 }),
        durSpan: fc.integer({ min: 0, max: 2000 }),
        minIsiMs: fc.integer({ min: 0, max: 5000 }),
        isiSpan: fc.integer({ min: 0, max: 5000 }),
      })
      .map(({ minDurationMs, durSpan, minIsiMs, isiSpan }): StimulusTimingConfig => {
        const maxDurationMs = minDurationMs + durSpan;
        return { minDurationMs, maxDurationMs, minIsiMs, maxIsiMs: Math.max(minIsiMs + isiSpan, maxDurationMs) };
      });
    fc.assert(
      fc.property(config, fc.integer(), (cfg, seed) => {
        assertValidTiming(cfg, DEFAULT_RAMP_MS);
        const rng = mulberry32(seed);
        for (let i = 0; i < 20; i++) {
          const { durationMs, isiMs } = drawTrialTiming(cfg, rng);
          expect(durationMs).toBeGreaterThanOrEqual(cfg.minDurationMs);
          expect(durationMs).toBeLessThanOrEqual(cfg.maxDurationMs);
          expect(isiMs).toBeLessThanOrEqual(cfg.maxIsiMs);
          expect(isiMs).toBeGreaterThanOrEqual(Math.max(cfg.minIsiMs, durationMs));
        }
      }),
    );
  });

  it('is unpredictable: draws spread across the whole range (seeded, 10 bins)', () => {
    const rng = mulberry32(2026);
    const n = 20000;
    const durBins = new Array<number>(10).fill(0);
    const isiBins = new Array<number>(10).fill(0);
    for (let i = 0; i < n; i++) {
      const { durationMs, isiMs } = drawTrialTiming(DEFAULT_TIMING, rng);
      durBins[Math.min(9, Math.floor((durationMs - 1000) / 50))]! += 1;
      isiBins[Math.min(9, Math.floor((isiMs - 1500) / 150))]! += 1;
    }
    for (const bins of [durBins, isiBins]) {
      for (const b of bins) expect(Math.abs(b - n / 10)).toBeLessThan(0.1 * (n / 10)); // within ±10 %
    }
  });

  it('rejects configs that could violate the rules', () => {
    const bad: StimulusTimingConfig[] = [
      { ...DEFAULT_TIMING, minDurationMs: 1600 }, // min > max
      { ...DEFAULT_TIMING, maxIsiMs: 1000, minIsiMs: 500 }, // ISI range below tone
      { ...DEFAULT_TIMING, minDurationMs: 40 }, // shorter than rise + fall
      { ...DEFAULT_TIMING, maxIsiMs: Number.NaN },
    ];
    for (const cfg of bad) expect(() => assertValidTiming(cfg, DEFAULT_RAMP_MS)).toThrow(RangeError);
  });

  it('rejects a broken random source', () => {
    expect(() => drawTrialTiming(DEFAULT_TIMING, () => 1)).toThrow(RangeError);
    expect(() => drawTrialTiming(DEFAULT_TIMING, () => -0.1)).toThrow(RangeError);
  });
});
