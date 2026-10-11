/**
 * Integration tests: every assertion is made on samples rendered by a real Web Audio
 * implementation (node-web-audio-api OfflineAudioContext), not on mocked calls.
 */

import fc from 'fast-check';
import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it, vi } from 'vitest';

import {
  AudioContextNotRunningError,
  dbHlToLinearGain,
  type Ear,
  gateEnvelope,
  mulberry32,
  type ScheduledTone,
  SUPPORTED_FREQUENCIES_HZ,
  ToneStimulusEngine,
} from '../src/audio';
import {
  firstNonZero,
  fixedTone,
  lastNonZero,
  maxAbs,
  render,
  SAMPLE_RATE,
  segmentLevelDb,
  sineAmplitude,
  TEST_PROFILE,
} from './helpers';

const sampleAt = (t: number): number => Math.round(t * SAMPLE_RATE);
const EPS = 1e-6;

/**
 * Largest sample-to-sample step a smoothly gated sine can make:
 *   |d/dt (g·e(t)·sin ωt)| ≤ g·(ω + max|e′|),  max|e′| = π / (2·T_ramp) for a Hann ramp.
 * A click (discontinuity) shows up as a step far above this bound.
 */
const maxSmoothStep = (gain: number, f: number, rampMs = 20): number =>
  (gain * (2 * Math.PI * f + Math.PI / (2 * (rampMs / 1000))) / SAMPLE_RATE) * 1.01 + EPS;

function maxStep(a: Float32Array): number {
  let m = 0;
  for (let i = 1; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - a[i - 1]!));
  return m;
}

function testChannel(r: { left: Float32Array; right: Float32Array }, ear: Ear): [Float32Array, Float32Array] {
  return ear === 'left' ? [r.left, r.right] : [r.right, r.left];
}

describe('ear routing (ChannelMergerNode)', () => {
  it('the non-test channel is digital zero for every frequency and ear', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...SUPPORTED_FREQUENCIES_HZ),
        fc.constantFrom<Ear>('left', 'right'),
        fc.integer({ min: -10, max: 90 }),
        async (f, ear, level) => {
          const r = await render(0.5, (e) => [e.presentTone(fixedTone({ ear, frequencyHz: f, levelDbHl: level }))]);
          const [test, other] = testChannel(r, ear);
          expect(other.every((v) => v === 0)).toBe(true);
          expect(maxAbs(test)).toBeGreaterThan(0);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe('Hann gating on the rendered signal', () => {
  it('silence before onset and after offset; never exceeds the Hann gate; plateau = calibrated gain', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...SUPPORTED_FREQUENCIES_HZ),
        fc.constantFrom(20, 25, 35, 50),
        fc.integer({ min: 0, max: 80 }),
        async (f, rampMs, level) => {
          const r = await render(0.5, (e) => [e.presentTone(fixedTone({ frequencyHz: f, levelDbHl: level }))], { rampMs });
          const tone = r.tones[0]!;
          const sig = r.right;
          const on = sampleAt(tone.onsetTime);
          const off = sampleAt(tone.offsetTime);
          expect(firstNonZero(sig)).toBeGreaterThanOrEqual(on);
          expect(lastNonZero(sig)).toBeLessThanOrEqual(off + 1);
          const dur = tone.durationMs / 1000;
          for (let i = on; i <= off; i++) {
            // ±1 sample tolerance for where the renderer places the curve's first point.
            const env = (k: number): number => gateEnvelope((i - on + k) / SAMPLE_RATE, dur, rampMs / 1000);
            const bound = tone.linearGain * Math.max(env(-1), env(0), env(1));
            expect(Math.abs(sig[i]!)).toBeLessThanOrEqual(bound * 1.001 + EPS);
          }
          const pStart = on + sampleAt(rampMs / 1000) + 10;
          const pEnd = off - sampleAt(rampMs / 1000) - 10;
          expect(Math.abs(20 * Math.log10(sineAmplitude(sig, pStart, pEnd) / tone.linearGain))).toBeLessThan(0.05);
          expect(maxAbs(sig, pStart, pEnd)).toBeLessThanOrEqual(tone.linearGain * 1.0001);
          expect(maxStep(sig)).toBeLessThanOrEqual(maxSmoothStep(tone.linearGain, f, rampMs));
        },
      ),
      { numRuns: 25 },
    );
  });

  it.each([250, 1000, 4000, 8000])('rendered onset at %i Hz has no click (splatter < −50 dB)', async (f) => {
    const r = await render(0.6, (e) => [e.presentTone(fixedTone({ frequencyHz: f, durationMs: 400, isiMs: 100 }))]);
    const on = sampleAt(r.tones[0]!.onsetTime);
    const win = sampleAt(0.128);
    const start = on - win / 2;
    const tone = segmentLevelDb(r.right, start, win, f);
    for (const p of [f / 2, f * 2, f * 3].filter((x) => x >= 100 && x < SAMPLE_RATE / 2 - 1000)) {
      expect(segmentLevelDb(r.right, start, win, p) - tone).toBeLessThan(-50);
    }
  });
});

describe('calibrated level', () => {
  it('rendered plateau amplitude equals the dB HL → gain formula', async () => {
    const levels = [-10, 0, 20, 40, 60, 80, 90];
    const r = await render(levels.length * 0.45 + 0.2, (e) =>
      levels.map((l) => e.presentTone(fixedTone({ levelDbHl: l, isiMs: 100 }))),
    );
    for (const tone of r.tones) {
      const on = sampleAt(tone.onsetTime);
      const amp = sineAmplitude(r.right, on + sampleAt(0.05), sampleAt(tone.offsetTime) - sampleAt(0.05));
      const expected = dbHlToLinearGain(TEST_PROFILE, 1000, tone.presentedLevelDbHl);
      expect(Math.abs(20 * Math.log10(amp / expected))).toBeLessThan(0.05);
    }
    expect(r.tones.every((t) => !t.levelClamped)).toBe(true);
  });

  it('a request above the profile ceiling is clamped and flagged (8 kHz cap = 84 dB HL)', async () => {
    const r = await render(0.5, (e) => [e.presentTone(fixedTone({ frequencyHz: 8000, levelDbHl: 90 }))]);
    const tone = r.tones[0]!;
    expect(tone.levelClamped).toBe(true);
    expect(tone.requestedLevelDbHl).toBe(90);
    expect(tone.presentedLevelDbHl).toBe(84);
    expect(maxAbs(r.right)).toBeLessThanOrEqual(dbHlToLinearGain(TEST_PROFILE, 8000, 84) * 1.0001);
    expect(maxAbs(r.right)).toBeLessThan(1);
  });
});

describe('randomised trial timing on the AudioContext clock', () => {
  it('durations 1.0–1.5 s, ISI 1.5–3.0 s, ISI ≥ tone, and silence between tones', async () => {
    const n = 4;
    const r = await render(n * 4.6, (e) =>
      Array.from({ length: n }, () => e.presentTrialTone({ ear: 'left', frequencyHz: 2000, levelDbHl: 50 })),
      { random: mulberry32(7) },
    );
    let prevOffset = 0;
    for (const tone of r.tones) {
      expect(tone.durationMs).toBeGreaterThanOrEqual(1000);
      expect(tone.durationMs).toBeLessThanOrEqual(1500);
      expect(tone.isiMs).toBeGreaterThanOrEqual(Math.max(1500, tone.durationMs));
      expect(tone.isiMs).toBeLessThanOrEqual(3000);
      expect(tone.onsetTime - prevOffset).toBeCloseTo(tone.isiMs / 1000, 6);
      expect(tone.offsetTime - tone.onsetTime).toBeCloseTo(tone.durationMs / 1000, 6);
      // The silent gap is truly silent.
      expect(maxAbs(r.left, sampleAt(prevOffset) + 2, sampleAt(tone.onsetTime) - 1)).toBe(0);
      prevOffset = tone.offsetTime;
    }
    expect(r.right.every((v) => v === 0)).toBe(true);
  });

  it('draws differ from trial to trial (timing is not predictable)', () => {
    const ctx = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const e = new ToneStimulusEngine(ctx, { calibration: TEST_PROFILE, requireRunningContext: false, random: mulberry32(1) });
    const tones = Array.from({ length: 20 }, () => e.presentTrialTone({ ear: 'right', frequencyHz: 1000, levelDbHl: 40 }));
    expect(new Set(tones.map((t) => t.durationMs)).size).toBeGreaterThan(15);
    expect(new Set(tones.map((t) => t.isiMs)).size).toBeGreaterThan(15);
  });
});

describe('lifecycle: completion, cancel, faults', () => {
  it('ended resolves "completed" and nodes are released', async () => {
    const r = await render(0.5, (e) => [e.presentTone(fixedTone())]);
    await expect(r.tones[0]!.ended).resolves.toBe('completed');
    expect(r.engine.activeToneCount).toBe(0);
  });

  it('cancel mid-plateau fades to exact silence within the fade, without a click', async () => {
    const cancelAt = 0.2;
    const r = await render(
      0.6,
      (e) => [e.presentTone(fixedTone({ durationMs: 400 }))],
      {},
      [{ time: cancelAt, run: (tones) => tones[0]!.cancel() }],
    );
    const tone = r.tones[0]!;
    await expect(tone.ended).resolves.toBe('cancelled');
    // Fade is 20 ms; allow one render quantum (128 samples) for the suspend point.
    expect(lastNonZero(r.right)).toBeLessThanOrEqual(sampleAt(cancelAt + 0.02 + 0.01) + 128);
    expect(lastNonZero(r.right)).toBeLessThan(sampleAt(tone.offsetTime) - sampleAt(0.05));
    expect(maxStep(r.right)).toBeLessThanOrEqual(maxSmoothStep(tone.linearGain, 1000));
  });

  it('cancel before onset produces no sound at all', async () => {
    const r = await render(0.6, (e) => {
      const t = e.presentTone(fixedTone({ isiMs: 300 }));
      t.cancel();
      return [t];
    });
    expect(maxAbs(r.right)).toBe(0);
    await expect(r.tones[0]!.ended).resolves.toBe('cancelled');
  });

  it('stopAll cancels every pending tone', async () => {
    const r = await render(1.5, (e) => {
      const ts = [e.presentTone(fixedTone({ isiMs: 100 })), e.presentTone(fixedTone({ isiMs: 100 }))];
      e.stopAll();
      return ts;
    });
    expect(maxAbs(r.right)).toBe(0);
    await expect(Promise.all(r.tones.map((t) => t.ended))).resolves.toEqual(['cancelled', 'cancelled']);
  });

  it('refuses to schedule on a context that is not running', () => {
    const ctx = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE); // offline = 'suspended' before render
    const e = new ToneStimulusEngine(ctx, { calibration: TEST_PROFILE });
    expect(() => e.presentTrialTone({ ear: 'left', frequencyHz: 1000, levelDbHl: 40 })).toThrow(AudioContextNotRunningError);
  });

  it('context suspension mid-tone releases tones and reports a fault', async () => {
    const ctx = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    let state: AudioContextState = 'running';
    Object.defineProperty(ctx, 'state', { get: () => state, configurable: true });
    const onFault = vi.fn();
    const e = new ToneStimulusEngine(ctx, { calibration: TEST_PROFILE, onFault });
    const tone: ScheduledTone = e.presentTrialTone({ ear: 'right', frequencyHz: 1000, levelDbHl: 40 });
    state = 'suspended';
    ctx.dispatchEvent(new Event('statechange'));
    expect(onFault).toHaveBeenCalledWith('context_suspended');
    await expect(tone.ended).resolves.toBe('cancelled');
    expect(e.activeToneCount).toBe(0);
  });
});

describe('input validation', () => {
  const ctx = (): OfflineAudioContext => new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
  const engine = (): ToneStimulusEngine => new ToneStimulusEngine(ctx(), { calibration: TEST_PROFILE, requireRunningContext: false });

  it.each([125, 100, 1234, 10000, 12000])('rejects non-audiometric frequency %i Hz', (f) => {
    expect(() => engine().presentTone(fixedTone({ frequencyHz: f }))).toThrow(RangeError);
  });

  it('rejects levels below −10 dB HL', () => {
    expect(() => engine().presentTone(fixedTone({ levelDbHl: -15 }))).toThrow(RangeError);
  });

  it('rejects ramps outside 20–50 ms and tones shorter than rise + fall', () => {
    for (const rampMs of [10, 60]) {
      expect(() => new ToneStimulusEngine(ctx(), { calibration: TEST_PROFILE, rampMs, requireRunningContext: false })).toThrow(RangeError);
    }
    expect(() => engine().presentTone(fixedTone({ durationMs: 50 }))).toThrow(RangeError);
  });

  it('cannot be used after dispose', () => {
    const e = engine();
    e.dispose();
    expect(() => e.presentTone(fixedTone())).toThrow(/disposed/);
  });
});
