import { OfflineAudioContext } from 'node-web-audio-api';

import {
  type CalibrationProfile,
  type FixedToneRequest,
  type ScheduledTone,
  SUPPORTED_FREQUENCIES_HZ,
  ToneStimulusEngine,
  type ToneStimulusEngineOptions,
} from '../src/audio';

export const SAMPLE_RATE = 48000;

/**
 * SYNTHETIC test profile — round numbers chosen for easy arithmetic, NOT measured ETSPL
 * data and never to be used for a real session (spec §3.3 [VERIFY]).
 *
 * fullScale 110 dB SPL, ETSPL 10 dB SPL, headroom 1 dB → 99 dB HL achievable → ceiling 90.
 * 8 kHz is deliberately weak (fullScale 95 → 84 dB HL achievable) to exercise clamping.
 */
export const TEST_PROFILE: CalibrationProfile = {
  profileId: 'synthetic-test-profile',
  profileVersion: 'test-0',
  tier: 'B',
  etsplDbSpl: Object.fromEntries(SUPPORTED_FREQUENCIES_HZ.map((f) => [f, 10])),
  fullScaleDbSpl: Object.fromEntries(
    SUPPORTED_FREQUENCIES_HZ.map((f) => [f, f === 8000 ? 95 : 110]),
  ),
  calOffsetDb: 0,
  headroomDb: 1,
};

/** Blackman–Harris (4-term) window value; sidelobes ≈ −92 dB. */
function blackmanHarris(i: number, n: number): number {
  const x = (2 * Math.PI * i) / (n - 1);
  return 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
}

/** Magnitude (dB re 1) of a Blackman–Harris-windowed segment at one frequency. */
export function segmentLevelDb(
  signal: Float32Array,
  startSample: number,
  lengthSamples: number,
  frequencyHz: number,
  sampleRate = SAMPLE_RATE,
): number {
  let re = 0;
  let im = 0;
  let wsum = 0;
  for (let i = 0; i < lengthSamples; i++) {
    const idx = startSample + i;
    const s = idx >= 0 && idx < signal.length ? (signal[idx] ?? 0) : 0;
    const w = blackmanHarris(i, lengthSamples);
    wsum += w;
    const ph = (2 * Math.PI * frequencyHz * i) / sampleRate;
    re += s * w * Math.cos(ph);
    im -= s * w * Math.sin(ph);
  }
  const mag = (2 * Math.hypot(re, im)) / wsum;
  return 20 * Math.log10(Math.max(mag, 1e-20));
}

export interface Rendered {
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly tones: ScheduledTone[];
  readonly engine: ToneStimulusEngine;
}

/**
 * Render tones through the real Web Audio graph offline.
 * `actions` runs before rendering; `at` callbacks run at suspend points mid-render.
 */
export async function render(
  seconds: number,
  actions: (engine: ToneStimulusEngine) => ScheduledTone[],
  opts: Partial<ToneStimulusEngineOptions> = {},
  at: ReadonlyArray<{ time: number; run: (tones: ScheduledTone[]) => void }> = [],
): Promise<Rendered> {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  const engine = new ToneStimulusEngine(ctx, {
    calibration: TEST_PROFILE,
    requireRunningContext: false,
    ...opts,
  });
  const tones = actions(engine);
  // Suspend points are harness machinery: if one is rejected or never runs, fail with
  // that diagnosis rather than letting an engine assertion fail misleadingly.
  const ran: boolean[] = at.map(() => false);
  const errors: unknown[] = [];
  at.forEach(({ time, run }, i) => {
    ctx
      .suspend(time)
      .then(() => {
        run(tones);
        ran[i] = true;
        return ctx.resume();
      })
      .catch((e: unknown) => errors.push(e));
  });
  const buf = await ctx.startRendering();
  if (errors.length || ran.some((r) => !r)) {
    throw new Error(
      `offline render harness: suspend points ran=${JSON.stringify(ran)} errors=${errors.map(String).join('; ')}`,
    );
  }
  return {
    left: buf.getChannelData(0),
    right: buf.getChannelData(1),
    tones,
    engine,
  };
}

export const fixedTone = (overrides: Partial<FixedToneRequest> = {}): FixedToneRequest => ({
  ear: 'right',
  frequencyHz: 1000,
  levelDbHl: 60,
  durationMs: 300,
  isiMs: 0,
  ...overrides,
});

export const maxAbs = (a: Float32Array, from = 0, to = a.length): number => {
  let m = 0;
  for (let i = Math.max(0, from); i < Math.min(a.length, to); i++) m = Math.max(m, Math.abs(a[i] ?? 0));
  return m;
};

/**
 * Sine amplitude from RMS (√2·RMS). Unlike the sample peak, this does not depend on
 * where samples fall on the waveform (at 8 kHz / 48 kHz the peak can miss by −1.25 dB).
 */
export const sineAmplitude = (a: Float32Array, from: number, to: number): number => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (a[i] ?? 0) ** 2;
  return Math.sqrt((2 * sum) / (to - from));
};

export const firstNonZero = (a: Float32Array): number => a.findIndex((v) => v !== 0);
export const lastNonZero = (a: Float32Array): number => {
  for (let i = a.length - 1; i >= 0; i--) if (a[i] !== 0) return i;
  return -1;
};
