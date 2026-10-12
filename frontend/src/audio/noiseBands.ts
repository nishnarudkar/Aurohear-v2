/**
 * One-third-octave band analysis for the ambient-noise gate (spec §5.3: "FFT →
 * one-third-octave band levels, 250 Hz–8 kHz").
 *
 * Band centres and edges are the exact base-10 series (IEC 61260): f_c = 1000·10^(n/10),
 * edges f_c·10^(±1/20); nominal labels 250 … 8000. Levels are in dB relative to the
 * analyser's own digital reference until a microphone calibration offset is applied.
 */

import { aWeightingDb } from '../calibration/biological';

/** Nominal centres, 250 Hz – 8 kHz (16 bands). */
export const THIRD_OCTAVE_BANDS_HZ = [
  250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000,
] as const;
export type BandHz = (typeof THIRD_OCTAVE_BANDS_HZ)[number];
export type BandLevels = Readonly<Record<BandHz, number>>;

const N_OF: Record<BandHz, number> = Object.fromEntries(THIRD_OCTAVE_BANDS_HZ.map((f, i) => [f, i - 6])) as Record<BandHz, number>;

export function exactCentreHz(band: BandHz): number {
  return 1000 * 10 ** (N_OF[band] / 10);
}

export function bandEdgesHz(band: BandHz): [number, number] {
  const c = exactCentreHz(band);
  return [c * 10 ** (-1 / 20), c * 10 ** (1 / 20)];
}

const SILENT_DB = -200;

/**
 * Band levels from an AnalyserNode `getFloatFrequencyData` spectrum (dB per bin):
 * power is summed over every bin whose centre lies inside the band.
 */
export function bandLevelsFromSpectrum(spectrumDb: ArrayLike<number>, sampleRate: number, fftSize: number): BandLevels {
  const binHz = sampleRate / fftSize;
  const out = {} as Record<BandHz, number>;
  for (const band of THIRD_OCTAVE_BANDS_HZ) {
    const [lo, hi] = bandEdgesHz(band);
    let power = 0;
    for (let k = Math.ceil(lo / binHz); k * binHz < hi && k < spectrumDb.length; k++) {
      const db = spectrumDb[k]!;
      if (Number.isFinite(db)) power += 10 ** (db / 10);
    }
    out[band] = power > 0 ? 10 * Math.log10(power) : SILENT_DB;
  }
  return out;
}

/** Broadband A-weighted level from band levels (energy sum, A-weighted at each centre). */
export function aWeightedLevelDb(bands: BandLevels): number {
  let power = 0;
  for (const band of THIRD_OCTAVE_BANDS_HZ) power += 10 ** ((bands[band] + aWeightingDb(exactCentreHz(band))) / 10);
  return power > 0 ? 10 * Math.log10(power) : SILENT_DB;
}

/** Energy (not dB) average over frames, per band — the correct way to average levels. */
export function energyMean(frames: readonly BandLevels[]): BandLevels {
  if (frames.length === 0) throw new RangeError('no frames');
  const out = {} as Record<BandHz, number>;
  for (const band of THIRD_OCTAVE_BANDS_HZ) {
    const mean = frames.reduce((s, f) => s + 10 ** (f[band] / 10), 0) / frames.length;
    out[band] = mean > 0 ? 10 * Math.log10(mean) : SILENT_DB;
  }
  return out;
}

export function offsetBands(bands: BandLevels, offsetDb: number): BandLevels {
  return Object.fromEntries(THIRD_OCTAVE_BANDS_HZ.map((b) => [b, bands[b] + offsetDb])) as unknown as BandLevels;
}

export function isSilent(bands: BandLevels): boolean {
  return THIRD_OCTAVE_BANDS_HZ.every((b) => bands[b] <= SILENT_DB + 1);
}
