/** Ambient-noise gate (spec §5): band maths, limits, pre-test decision, live gate, real FFT path. */

import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';

import { aWeightingDb } from '../../src/calibration/biological';
import {
  aWeightedLevelDb,
  bandEdgesHz,
  bandLevelsFromSpectrum,
  type BandLevels,
  energyMean,
  exactCentreHz,
  THIRD_OCTAVE_BANDS_HZ,
} from '../../src/audio/noiseBands';
import {
  absoluteBandLimits,
  type AbsoluteConfig,
  assess,
  BROADBAND_GATE_DBA,
  NoiseGate,
  NoiseMonitor,
  pretestDecision,
  RELATIVE_MARGIN_DB,
  relativeBandLimits,
} from '../../src/audio/NoiseGate';

const flat = (db: number): BandLevels => Object.fromEntries(THIRD_OCTAVE_BANDS_HZ.map((b) => [b, db])) as unknown as BandLevels;
const withBand = (base: BandLevels, band: number, db: number): BandLevels => ({ ...base, [band]: db }) as BandLevels;

/** SYNTHETIC values for exercising the arithmetic only — NOT the ISO 8253-1 table. */
const TEST_TABLE: AbsoluteConfig = {
  mic: { source: 'sound_level_meter', offsetDb: 120, uncertaintyDb: 2, reference: 'test' },
  mpanl: { id: 'synthetic-test-table', source: 'test', bandsDbSpl: Object.fromEntries(THIRD_OCTAVE_BANDS_HZ.map((b) => [b, 20])) },
  testFloorDbHl: 10,
  transducerCreditDb: { 4000: 5 },
};

describe('one-third-octave bands (IEC 61260 base-10)', () => {
  it('16 contiguous bands from 250 Hz to 8 kHz, centres a third of an octave apart', () => {
    expect(THIRD_OCTAVE_BANDS_HZ).toHaveLength(16);
    for (let i = 1; i < THIRD_OCTAVE_BANDS_HZ.length; i++) {
      const a = THIRD_OCTAVE_BANDS_HZ[i - 1]!;
      const b = THIRD_OCTAVE_BANDS_HZ[i]!;
      expect(bandEdgesHz(a)[1]).toBeCloseTo(bandEdgesHz(b)[0], 9);
      expect(exactCentreHz(b) / exactCentreHz(a)).toBeCloseTo(10 ** 0.1, 12);
    }
    expect(exactCentreHz(1000)).toBe(1000);
  });

  it('sums bin power inside each band; white noise rises ~1 dB per band', () => {
    const sr = 48000;
    const fft = 8192;
    const white = new Float32Array(fft / 2).fill(-60);
    const bands = bandLevelsFromSpectrum(white, sr, fft);
    const steps = THIRD_OCTAVE_BANDS_HZ.slice(1).map((b, i) => bands[b] - bands[THIRD_OCTAVE_BANDS_HZ[i]!]);
    const meanStep = steps.reduce((a, x) => a + x, 0) / steps.length;
    expect(meanStep).toBeCloseTo(1, 0); // bandwidth ∝ f → +10·log10(10^0.1) = 1 dB
    const tone = new Float32Array(fft / 2).fill(-Infinity);
    tone[Math.round(1000 / (sr / fft))] = -30;
    const t = bandLevelsFromSpectrum(tone, sr, fft);
    expect(t[1000]).toBeCloseTo(-30, 6);
    expect(t[800]).toBeLessThan(-150);
  });

  it('A-weighted sum and energy averaging', () => {
    expect(aWeightedLevelDb(withBand(flat(-300), 1000, 40))).toBeCloseTo(40, 2);
    expect(aWeightedLevelDb(withBand(flat(-300), 250, 40))).toBeCloseTo(40 + aWeightingDb(exactCentreHz(250)), 6);
    expect(energyMean([flat(0), flat(-300)])[1000]).toBeCloseTo(-3.01, 2);
  });
});

describe('limits (spec §5.3.1)', () => {
  it('absolute: MPANL + test floor + transducer credit; bands absent from the table are not gated', () => {
    const lim = absoluteBandLimits({ ...TEST_TABLE, mpanl: { ...TEST_TABLE.mpanl, bandsDbSpl: { 1000: 20, 4000: 20 } } });
    expect(lim).toEqual({ 1000: 30, 4000: 35 });
  });

  it('relative: the room’s own baseline + margin', () => {
    expect(relativeBandLimits(flat(-90))[2000]).toBe(-90 + RELATIVE_MARGIN_DB);
  });

  it('assess: band limits and the 35 dB(A) broadband backstop', () => {
    expect(assess(flat(20), { 1000: 25 }, null).ok).toBe(true);
    expect(assess(withBand(flat(20), 1000, 26), { 1000: 25 }, null).exceededBands).toEqual([1000]);
    const loud = assess(flat(30), {}, BROADBAND_GATE_DBA); // 16 bands at 30 dB ≫ 35 dB(A)
    expect(loud.broadbandExceeded).toBe(true);
  });
});

describe('pre-test decision', () => {
  const steady = Array.from({ length: 150 }, () => flat(-95));

  it('relative mode: a steady room passes, with the level reported as unknown (±8 dB)', () => {
    const r = pretestDecision(steady, { absolute: null, framesPerSecond: 10 });
    expect(r).toMatchObject({ mode: 'relative', pass: true, dba: null, uncertaintyDb: 8 });
    expect(r.limits[1000]).toBeCloseTo(-95 + RELATIVE_MARGIN_DB, 6);
  });

  it('fails a fluctuating room, and a silent (muted) microphone', () => {
    const noisy = steady.map((f, i) => (Math.floor(i / 10) % 2 ? withBand(f, 500, -70) : f));
    expect(pretestDecision(noisy, { absolute: null, framesPerSecond: 10 }).pass).toBe(false);
    const muted = steady.map(() => flat(-300));
    expect(pretestDecision(muted, { absolute: null, framesPerSecond: 10 }).reasons[0]).toMatch(/No sound reached the microphone/);
  });

  it('absolute mode applies the mic offset, band limits and the 35 dB(A) gate', () => {
    const quiet = steady.map(() => flat(-120)); // 0 dB SPL per band after the +120 offset
    const ok = pretestDecision(quiet, { absolute: TEST_TABLE, framesPerSecond: 10 });
    expect(ok.pass).toBe(true);
    expect(ok.dba).not.toBeNull();
    const hum = quiet.map((f) => withBand(f, 250, -85)); // 35 dB SPL at 250 Hz > 30 limit
    const bad = pretestDecision(hum, { absolute: TEST_TABLE, framesPerSecond: 10 });
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(' ')).toMatch(/250 Hz/);
  });
});

describe('NoiseGate (continuous, spec §5.3.2)', () => {
  const limits = relativeBandLimits(flat(-95));
  const quiet = flat(-95);
  const loud = withBand(flat(-95), 1000, -60);

  it('needs a sustained exceedance, then holds until quiet for 2 s', () => {
    const g = new NoiseGate({ limits, broadbandLimitDb: null, offsetDb: 0 });
    expect(g.ingest(0, loud)).toBeNull(); // one frame: a transient
    expect(g.ingest(100, quiet)).toBeNull();
    expect(g.ingest(200, loud)).toBeNull();
    expect(g.ingest(300, loud)).toBe('exceeded');
    expect(g.isNoisy).toBe(true);
    expect(g.ingest(400, quiet)).toBeNull();
    expect(g.ingest(2300, quiet)).toBeNull();
    expect(g.ingest(2400, quiet)).toBe('cleared');
    expect(g.exceedances).toBe(1);
  });

  it('ignores excluded frames (tones, key presses)', () => {
    const g = new NoiseGate({ limits, broadbandLimitDb: null, offsetDb: 0 });
    g.setExclusion((t) => t < 1000);
    for (let t = 0; t < 1000; t += 100) expect(g.ingest(t, loud)).toBeNull();
    expect(g.isNoisy).toBe(false);
  });
});

describe('real Web Audio analyser → bands', () => {
  /** Steady tone through the real AnalyserNode; read once rendering has finished
   *  (no suspend() — avoids the offline renderer's occasional missed suspend points). */
  async function analyse(freq: number): Promise<BandLevels> {
    const ctx = new OfflineAudioContext(1, 48000, 48000);
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const level = ctx.createGain();
    level.gain.value = 0.1;
    osc.connect(level);
    osc.start(0);
    const monitor = NoiseMonitor.fromNode(ctx, level);
    await ctx.startRendering();
    return monitor.readFrame();
  }

  it.each([250, 1000, 4000])('a %i Hz tone lands in its own band, ≥ 30 dB above bands two away', async (f) => {
    const b = await analyse(f);
    const loudest = THIRD_OCTAVE_BANDS_HZ.reduce((x, y) => (b[y] > b[x] ? y : x));
    expect(loudest).toBe(f);
    const i = THIRD_OCTAVE_BANDS_HZ.indexOf(f as never);
    for (const j of [i - 2, i + 2]) {
      const other = THIRD_OCTAVE_BANDS_HZ[j];
      if (other !== undefined) expect(b[f as never] - b[other]).toBeGreaterThan(30);
    }
  });

  it('the band pipeline is flat: equal-amplitude tones read the same level in their bands', async () => {
    const levels = await Promise.all([250, 1000, 4000].map(async (f) => (await analyse(f))[f as never]));
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(0.5);
  });
});
