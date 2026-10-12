/**
 * Audiogram geometry (spec §8).
 *
 *   - Aspect ratio: one octave on x occupies exactly the same distance as 20 dB on y,
 *     so an octave × 20 dB cell is a square (ASHA [R1]; BSA §10.1 "20 dB : 1 octave").
 *   - x: frequency, logarithmic (log₂), ascending left → right.
 *   - y: hearing level, linear, ascending DOWNWARD, from −10 dB HL to the audiometer
 *     maximum (the system ceiling, 90 dB HL; extended if a higher cap is supplied).
 *
 * Pure functions only — fully unit-testable without a DOM.
 */

export const OCTAVE_FREQUENCIES_HZ = [125, 250, 500, 1000, 2000, 4000, 8000] as const;
export const INTER_OCTAVE_FREQUENCIES_HZ = [750, 1500, 3000, 6000] as const;
export const DB_PER_OCTAVE = 20;

export interface AudiogramLayoutOptions {
  /** Pixels per octave (= pixels per 20 dB). */
  readonly octavePx?: number;
  readonly fMinHz?: number;
  readonly fMaxHz?: number;
  readonly dbMin?: number;
  /** Audiometer maximum (bottom of the scale). Rounded up to a multiple of 10. */
  readonly dbMax?: number;
}

export interface AudiogramLayout {
  readonly octavePx: number;
  readonly pxPerDb: number;
  readonly fMinHz: number;
  readonly fMaxHz: number;
  readonly dbMin: number;
  readonly dbMax: number;
  /** Plot rectangle (gridded area). */
  readonly plot: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** Whole canvas including axis labels and legend area. */
  readonly width: number;
  readonly height: number;
  readonly legendTop: number;
  readonly symbolRadius: number;
  x(frequencyHz: number): number;
  y(dbHl: number): number;
}

const PAD_OCTAVES = 0.5; // half an octave of breathing room left/right of 125/8000 Hz
const PAD_TOP_DB = 5;
const PAD_BOTTOM_DB = 15; // room for no-response arrows below the maximum
const MARGIN = { left: 64, right: 24, top: 56 } as const;
const LEGEND_HEIGHT = 132;

export function makeLayout(opts: AudiogramLayoutOptions = {}): AudiogramLayout {
  const octavePx = opts.octavePx ?? 80;
  const fMinHz = opts.fMinHz ?? 125;
  const fMaxHz = opts.fMaxHz ?? 8000;
  const dbMin = opts.dbMin ?? -10;
  const dbMax = Math.ceil((opts.dbMax ?? 90) / 10) * 10;
  if (!(octavePx > 0) || !(fMaxHz > fMinHz) || !(dbMax > dbMin)) throw new RangeError('invalid audiogram layout');
  const pxPerDb = octavePx / DB_PER_OCTAVE;
  const octaves = Math.log2(fMaxHz / fMinHz);
  const plot = {
    x: MARGIN.left,
    y: MARGIN.top,
    width: (octaves + 2 * PAD_OCTAVES) * octavePx,
    height: (dbMax - dbMin + PAD_TOP_DB + PAD_BOTTOM_DB) * pxPerDb,
  };
  const legendTop = plot.y + plot.height + 40;
  return {
    octavePx,
    pxPerDb,
    fMinHz,
    fMaxHz,
    dbMin,
    dbMax,
    plot,
    width: plot.x + plot.width + MARGIN.right,
    height: legendTop + LEGEND_HEIGHT,
    legendTop,
    symbolRadius: Math.max(5, octavePx * 0.1),
    x: (f) => plot.x + (PAD_OCTAVES + Math.log2(f / fMinHz)) * octavePx,
    y: (db) => plot.y + (PAD_TOP_DB + (db - dbMin)) * pxPerDb,
  };
}

/** Frequency tick label: 125, 250, 500, 1k, 1.5k, 2k … */
export function frequencyLabel(f: number): string {
  return f >= 1000 ? `${f / 1000}k` : String(f);
}

/** End point and arrowhead of a no-response arrow (spec §8; ASHA 1990: right ear points
 *  down-left, left ear down-right, attached to the lower outer corner of the symbol). */
export function noResponseArrow(
  cx: number,
  cy: number,
  r: number,
  ear: 'right' | 'left',
): { x1: number; y1: number; x2: number; y2: number; head: [number, number][] } {
  const dir = ear === 'right' ? -1 : 1; // x direction
  const k = Math.SQRT1_2;
  const x1 = cx + dir * r * k;
  const y1 = cy + r * k;
  const len = r * 1.9;
  const x2 = x1 + dir * len * k;
  const y2 = y1 + len * k;
  // Arrowhead: two short strokes back from the tip at ±25° to the shaft.
  const h = r * 0.8;
  const back = (angle: number): [number, number] => {
    const theta = Math.atan2(y1 - y2, x1 - x2) + angle;
    return [x2 + h * Math.cos(theta), y2 + h * Math.sin(theta)];
  };
  return { x1, y1, x2, y2, head: [back(Math.PI / 7), [x2, y2], back(-Math.PI / 7)] };
}
