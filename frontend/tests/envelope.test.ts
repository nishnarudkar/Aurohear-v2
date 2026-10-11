import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assertValidRampMs,
  gateEnvelope,
  hannFallCurve,
  hannRise,
  hannRiseCurve,
  MAX_RAMP_MS,
  MIN_RAMP_MS,
} from '../src/audio';
import { SAMPLE_RATE, segmentLevelDb } from './helpers';

const rampMs = fc.integer({ min: MIN_RAMP_MS, max: MAX_RAMP_MS });
const sampleRate = fc.constantFrom(44100, 48000, 96000);

describe('Hann ramp', () => {
  it('rejects ramps outside 20–50 ms', () => {
    for (const bad of [0, 5, 19.9, 50.1, 100, Number.NaN]) {
      expect(() => assertValidRampMs(bad)).toThrow(RangeError);
    }
    expect(() => assertValidRampMs(20)).not.toThrow();
    expect(() => assertValidRampMs(50)).not.toThrow();
  });

  it('is ½(1−cos πx) with zero value and zero slope at both ends', () => {
    expect(hannRise(0)).toBe(0);
    expect(hannRise(1)).toBe(1);
    expect(hannRise(0.5)).toBeCloseTo(0.5, 12);
    const h = 1e-6;
    expect(hannRise(h) / h).toBeLessThan(1e-5); // slope → 0 at onset
    expect((1 - hannRise(1 - h)) / h).toBeLessThan(1e-5); // slope → 0 at plateau
  });

  it('curve is sampled at ≥ sample rate, exact endpoints, monotone, within [0,1]', () => {
    fc.assert(
      fc.property(rampMs, sampleRate, (ms, sr) => {
        const c = hannRiseCurve(ms, sr);
        expect(c.length).toBeGreaterThanOrEqual(Math.ceil((ms / 1000) * sr) + 1);
        expect(c[0]).toBe(0);
        expect(c[c.length - 1]).toBe(1);
        for (let i = 1; i < c.length; i++) {
          expect(c[i]!).toBeGreaterThanOrEqual(c[i - 1]!);
          expect(c[i]!).toBeLessThanOrEqual(1);
        }
      }),
    );
  });

  it('fall curve is the exact time-reverse of the rise', () => {
    fc.assert(
      fc.property(rampMs, sampleRate, (ms, sr) => {
        const rise = hannRiseCurve(ms, sr);
        const fall = hannFallCurve(ms, sr);
        expect(fall.length).toBe(rise.length);
        for (let i = 0; i < rise.length; i++) expect(fall[i]).toBe(rise[rise.length - 1 - i]);
      }),
    );
  });

  it('gate envelope never overshoots 1 and is symmetric about the tone centre', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.1, max: 2, noNaN: true }),
        rampMs,
        fc.double({ min: 0, max: 1, noNaN: true }),
        (dur, ms, u) => {
          const ramp = ms / 1000;
          const t = u * dur;
          const e = gateEnvelope(t, dur, ramp);
          expect(e).toBeGreaterThanOrEqual(0);
          expect(e).toBeLessThanOrEqual(1);
          expect(e).toBeCloseTo(gateEnvelope(dur - t, dur, ramp), 9);
        },
      ),
    );
  });
});

describe('click suppression (pure-signal check, independent of Web Audio)', () => {
  /** Synthesise a gated tone, either Hann-ramped or rectangular. */
  function gated(f: number, rampMsValue: number | null): Float32Array {
    const n = Math.round(0.5 * SAMPLE_RATE);
    const onset = Math.round(0.1 * SAMPLE_RATE);
    const dur = 0.3;
    const out = new Float32Array(n);
    for (let i = onset; i < n; i++) {
      const t = (i - onset) / SAMPLE_RATE;
      const env = rampMsValue === null ? (t < dur ? 1 : 0) : gateEnvelope(t, dur, rampMsValue / 1000);
      out[i] = env * Math.sin(2 * Math.PI * f * t + 0.7); // non-zero phase: worst case
    }
    return out;
  }

  /**
   * Off-frequency energy around the onset, relative to the tone (dB). A 128 ms analysis
   * window is needed to resolve the f/2 probe at 250 Hz (125 Hz away); shorter windows
   * measure the analyser's own leakage, not the gate.
   */
  function splatterDb(sig: Float32Array, f: number): number {
    const win = Math.round(0.128 * SAMPLE_RATE);
    const start = Math.round(0.1 * SAMPLE_RATE) - win / 2;
    const tone = segmentLevelDb(sig, start, win, f);
    const probes = [f / 2, f * 2, f * 3].filter((p) => p >= 100 && p < SAMPLE_RATE / 2 - 1000);
    return Math.max(...probes.map((p) => segmentLevelDb(sig, start, win, p))) - tone;
  }

  it.each([250, 500, 1000, 2000, 4000, 8000])(
    'Hann splatter at %i Hz is ≥ 50 dB below the tone and ≥ 25 dB better than a hard gate',
    (f) => {
      for (const ramp of [MIN_RAMP_MS, 25, MAX_RAMP_MS]) {
        const hann = splatterDb(gated(f, ramp), f);
        const rect = splatterDb(gated(f, null), f);
        expect(hann).toBeLessThan(-50);
        expect(rect - hann).toBeGreaterThan(25); // proves the probe actually detects clicks
      }
    },
  );
});
