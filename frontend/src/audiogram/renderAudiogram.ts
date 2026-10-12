/**
 * Standards-compliant audiogram as SVG (spec §8, ASHA 1990 symbols, BSA §10).
 *
 * Symbols   right ear O (red) · left ear X (blue), joined by CONTINUOUS straight lines
 *           (spec §8 — both ears; ear identity is carried by symbol shape, not line style
 *           or colour alone, WCAG 1.4.1).
 * NR        symbol at the highest level presented with an arrow at the lower outer
 *           corner (right ↙, left ↘), never joined to neighbouring symbols.
 * Shadow    possible-shadow (unmasked Δ ≥ 40/55 dB, §1.3) points are half-filled, not
 *           joined, and flagged in the legend: not a valid threshold.
 * Legend    always present (spec §8).
 *
 * Modes: 'normal' — clean plot with the WHO normal range shaded (< 20 dB HL);
 *        'clinician' — adds ±σ bars and every search (e.g. 1 kHz initial / retest /
 *        verification) as small secondary symbols.
 */

import { frequencyLabel, INTER_OCTAVE_FREQUENCIES_HZ, makeLayout, noResponseArrow, OCTAVE_FREQUENCIES_HZ, type AudiogramLayout, type AudiogramLayoutOptions } from './geometry';
import { h, type SvgNode } from './svg';

export type AudiogramEar = 'right' | 'left';

export interface AudiogramPoint {
  readonly ear: AudiogramEar;
  readonly frequencyHz: number;
  readonly status: 'measured' | 'no_response' | 'unresolved';
  /** Threshold, or the highest level presented for a no-response; null if unresolved. */
  readonly thresholdDbHl: number | null;
  readonly possibleShadow: boolean;
  readonly testRole: 'initial' | 'retest' | 'verification';
  /** The value reported for this ear × frequency (other searches are clinician-only). */
  readonly accepted: boolean;
}

export interface AudiogramData {
  readonly points: readonly AudiogramPoint[];
  /** Model σ for clinician error bars (σ_PTA of the calibration tier). */
  readonly sigmaDb?: number | null;
  readonly calibrationTier?: string | null;
}

export interface Palette {
  readonly background: string;
  readonly text: string;
  readonly mutedText: string;
  readonly gridMajor: string;
  readonly gridMinor: string;
  readonly right: string;
  readonly left: string;
  readonly normalBand: string;
  readonly shadowFillRight: string;
  readonly shadowFillLeft: string;
}

/** Text ≥ 7:1 against the background (WCAG AAA); symbols ≥ 4.5:1. */
export const PALETTES: Readonly<Record<'light' | 'dark', Palette>> = {
  light: {
    background: '#ffffff',
    text: '#111111',
    mutedText: '#3d3d3d',
    gridMajor: '#8a8f98',
    gridMinor: '#d5d8dd',
    right: '#b0001a',
    left: '#003fa3',
    normalBand: '#e6f2e8',
    shadowFillRight: '#b0001a',
    shadowFillLeft: '#003fa3',
  },
  dark: {
    background: '#101317',
    text: '#f2f2f2',
    mutedText: '#c9ccd1',
    gridMajor: '#7d838c',
    gridMinor: '#2c3138',
    right: '#ff8a8a',
    left: '#8ab8ff',
    normalBand: '#16271b',
    shadowFillRight: '#ff8a8a',
    shadowFillLeft: '#8ab8ff',
  },
};

export interface RenderOptions {
  readonly mode?: 'normal' | 'clinician';
  readonly theme?: 'light' | 'dark';
  readonly layout?: AudiogramLayoutOptions;
  readonly title?: string;
  /** Prefix for element ids (unique per page if several audiograms are shown). */
  readonly idPrefix?: string;
}

const EAR_NAME: Record<AudiogramEar, string> = { right: 'Right ear', left: 'Left ear' };

// ------------------------------------------------------------------ symbols

function symbol(ear: AudiogramEar, cx: number, cy: number, r: number, p: Palette, opts: { shadow: boolean; scale?: number }): SvgNode {
  const s = opts.scale ?? 1;
  const rr = r * s;
  const color = ear === 'right' ? p.right : p.left;
  const sw = Math.max(1.5, 2.2 * s);
  if (ear === 'right') {
    return h(
      'g',
      {},
      h('circle', { cx, cy, r: rr, fill: p.background, stroke: color, 'stroke-width': sw }),
      opts.shadow &&
        h('path', {
          d: `M ${cx - rr} ${cy} A ${rr} ${rr} 0 0 0 ${cx + rr} ${cy} Z`, // lower half
          fill: p.shadowFillRight,
          'data-shadow-fill': 'true',
        }),
    );
  }
  const k = rr * 0.95;
  return h(
    'g',
    {},
    opts.shadow &&
      h('rect', { x: cx - rr, y: cy, width: 2 * rr, height: rr, fill: p.shadowFillLeft, opacity: 0.45, 'data-shadow-fill': 'true' }),
    opts.shadow && h('rect', { x: cx - rr, y: cy - rr, width: 2 * rr, height: 2 * rr, fill: 'none', stroke: color, 'stroke-width': 1 }),
    h('line', { x1: cx - k, y1: cy - k, x2: cx + k, y2: cy + k, stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round' }),
    h('line', { x1: cx - k, y1: cy + k, x2: cx + k, y2: cy - k, stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round' }),
  );
}

function arrow(ear: AudiogramEar, cx: number, cy: number, r: number, p: Palette): SvgNode {
  const a = noResponseArrow(cx, cy, r, ear);
  const color = ear === 'right' ? p.right : p.left;
  return h(
    'g',
    { 'data-nr-arrow': ear === 'right' ? 'down-left' : 'down-right' },
    h('line', { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, stroke: color, 'stroke-width': 2 }),
    h('polyline', { points: a.head.map(([x, y]) => `${x},${y}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' }),
  );
}

// ------------------------------------------------------------------ connecting lines

/** Segments between frequency-adjacent valid thresholds of one ear. A no-response,
 *  possible shadow or unresolved point breaks the line (spec §8, §1.3). */
export function connectingSegments(points: readonly AudiogramPoint[], ear: AudiogramEar): [AudiogramPoint, AudiogramPoint][] {
  const tested = points.filter((q) => q.ear === ear && q.accepted).sort((a, b) => a.frequencyHz - b.frequencyHz);
  const valid = (q: AudiogramPoint): boolean => q.status === 'measured' && !q.possibleShadow && q.thresholdDbHl !== null;
  const out: [AudiogramPoint, AudiogramPoint][] = [];
  for (let i = 1; i < tested.length; i++) {
    const a = tested[i - 1]!;
    const b = tested[i]!;
    if (valid(a) && valid(b)) out.push([a, b]);
  }
  return out;
}

// ------------------------------------------------------------------ text alternative

export function audiogramTextSummary(data: AudiogramData): string {
  const parts: string[] = [];
  for (const ear of ['right', 'left'] as const) {
    const pts = data.points.filter((q) => q.ear === ear && q.accepted).sort((a, b) => a.frequencyHz - b.frequencyHz);
    if (!pts.length) continue;
    const items = pts.map((q) => {
      const f = `${q.frequencyHz} Hz`;
      if (q.status === 'unresolved' || q.thresholdDbHl === null) return `${f} not determined`;
      if (q.status === 'no_response') return `${f} no response at ${q.thresholdDbHl} dB HL`;
      return `${f} ${q.thresholdDbHl} dB HL${q.possibleShadow ? ' (possible shadow, unmasked)' : ''}`;
    });
    parts.push(`${EAR_NAME[ear]}: ${items.join(', ')}.`);
  }
  return parts.join(' ') || 'No thresholds recorded.';
}

// ------------------------------------------------------------------ main

export function renderAudiogram(data: AudiogramData, opts: RenderOptions = {}): SvgNode {
  const mode = opts.mode ?? 'normal';
  const p = PALETTES[opts.theme ?? 'light'];
  const id = opts.idPrefix ?? 'ah-audiogram';
  const maxPoint = Math.max(90, ...data.points.map((q) => q.thresholdDbHl ?? -10));
  const L: AudiogramLayout = makeLayout({ ...opts.layout, dbMax: Math.max(opts.layout?.dbMax ?? 90, maxPoint) });
  const r = L.symbolRadius;
  const { plot } = L;
  const font = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const title = opts.title ?? 'Pure-tone air-conduction audiogram';

  // --- grid
  const grid: SvgNode[] = [];
  for (let db = L.dbMin; db <= L.dbMax; db += 5) {
    const major = db % 10 === 0;
    grid.push(h('line', {
      x1: plot.x, x2: plot.x + plot.width, y1: L.y(db), y2: L.y(db),
      stroke: major ? p.gridMajor : p.gridMinor, 'stroke-width': db === 0 ? 1.6 : major ? 1 : 0.6,
      'data-grid': major ? 'db-major' : 'db-minor',
    }));
  }
  for (const f of OCTAVE_FREQUENCIES_HZ) {
    if (f < L.fMinHz || f > L.fMaxHz) continue;
    grid.push(h('line', { x1: L.x(f), x2: L.x(f), y1: plot.y, y2: plot.y + plot.height, stroke: p.gridMajor, 'stroke-width': 1, 'data-grid': 'octave' }));
  }
  for (const f of INTER_OCTAVE_FREQUENCIES_HZ) {
    grid.push(h('line', {
      x1: L.x(f), x2: L.x(f), y1: plot.y, y2: plot.y + plot.height,
      stroke: p.gridMinor, 'stroke-width': 1, 'stroke-dasharray': '3 4', 'data-grid': 'inter-octave',
    }));
  }

  // --- axes labels (frequency on top, conventional for audiograms)
  const labels: SvgNode[] = [];
  for (const f of [...OCTAVE_FREQUENCIES_HZ, ...INTER_OCTAVE_FREQUENCIES_HZ]) {
    const octave = (OCTAVE_FREQUENCIES_HZ as readonly number[]).includes(f);
    labels.push(h('text', {
      x: L.x(f), y: plot.y - 10, 'text-anchor': 'middle', 'font-size': octave ? 13 : 10.5,
      fill: octave ? p.text : p.mutedText, 'data-tick': 'frequency',
    }, frequencyLabel(f)));
  }
  for (let db = L.dbMin; db <= L.dbMax; db += 10) {
    labels.push(h('text', { x: plot.x - 8, y: L.y(db) + 4, 'text-anchor': 'end', 'font-size': 12, fill: p.text, 'data-tick': 'db' }, String(db)));
  }
  labels.push(
    h('text', { x: plot.x + plot.width / 2, y: 18, 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 600, fill: p.text }, 'Frequency (Hz)'),
    h('text', {
      x: 16, y: plot.y + plot.height / 2, 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 600, fill: p.text,
      transform: `rotate(-90 16 ${plot.y + plot.height / 2})`,
    }, 'Hearing level (dB HL)'),
  );

  // --- WHO normal range band (< 20 dB HL)
  const band = h(
    'g',
    { 'data-layer': 'normal-band' },
    // No in-plot label: any position can collide with real data; the legend explains it.
    h('rect', { x: plot.x, y: L.y(L.dbMin), width: plot.width, height: L.y(20) - L.y(L.dbMin), fill: p.normalBand, 'data-band': 'who-normal' }),
  );

  // --- lines
  const lines: SvgNode[] = [];
  for (const ear of ['right', 'left'] as const) {
    for (const [a, b] of connectingSegments(data.points, ear)) {
      lines.push(h('line', {
        x1: L.x(a.frequencyHz), y1: L.y(a.thresholdDbHl!), x2: L.x(b.frequencyHz), y2: L.y(b.thresholdDbHl!),
        stroke: ear === 'right' ? p.right : p.left, 'stroke-width': 2, 'data-ear': ear, 'data-segment': `${a.frequencyHz}-${b.frequencyHz}`,
      }));
    }
  }

  // --- clinician overlays
  const overlays: SvgNode[] = [];
  if (mode === 'clinician') {
    const sigma = data.sigmaDb ?? null;
    if (sigma) {
      for (const q of data.points) {
        // No bar on a possible shadow: it is not a valid threshold (spec §1.3).
        if (!q.accepted || q.status !== 'measured' || q.thresholdDbHl === null || q.possibleShadow) continue;
        const x = L.x(q.frequencyHz) + (q.ear === 'right' ? -r * 1.6 : r * 1.6);
        const y1 = L.y(q.thresholdDbHl - sigma);
        const y2 = L.y(q.thresholdDbHl + sigma);
        const c = q.ear === 'right' ? p.right : p.left;
        overlays.push(h('g', { 'data-error-bar': `${q.ear}-${q.frequencyHz}`, opacity: 0.8 },
          h('line', { x1: x, x2: x, y1, y2, stroke: c, 'stroke-width': 1.4 }),
          h('line', { x1: x - 4, x2: x + 4, y1, y2: y1, stroke: c, 'stroke-width': 1.4 }),
          h('line', { x1: x - 4, x2: x + 4, y1: y2, y2, stroke: c, 'stroke-width': 1.4 }),
        ));
      }
    }
    // Non-accepted searches (e.g. 1 kHz initial vs retest), small and labelled by role.
    for (const q of data.points) {
      if (q.accepted || q.thresholdDbHl === null) continue;
      const dx = (q.testRole === 'retest' ? 1 : q.testRole === 'verification' ? 2 : -1) * r * 1.2;
      const x = L.x(q.frequencyHz) + dx;
      const y = L.y(q.thresholdDbHl);
      overlays.push(h('g', { 'data-secondary': `${q.ear}-${q.frequencyHz}-${q.testRole}`, opacity: 0.75 },
        symbol(q.ear, x, y, r, p, { shadow: false, scale: 0.6 }),
        h('text', { x: x, y: y - r * 0.9, 'text-anchor': 'middle', 'font-size': 9, fill: p.mutedText },
          q.testRole === 'retest' ? 'R' : q.testRole === 'verification' ? 'V' : 'I'),
        h('title', {}, `${EAR_NAME[q.ear]} ${q.frequencyHz} Hz, ${q.testRole} search: ${q.status === 'no_response' ? 'no response at ' : ''}${q.thresholdDbHl} dB HL`),
      ));
    }
  }

  // --- symbols (accepted values)
  const symbols: SvgNode[] = [];
  const unresolved: AudiogramPoint[] = [];
  for (const q of data.points) {
    if (!q.accepted) continue;
    if (q.status === 'unresolved' || q.thresholdDbHl === null) {
      unresolved.push(q);
      continue;
    }
    const cx = L.x(q.frequencyHz);
    const cy = L.y(q.thresholdDbHl);
    const nr = q.status === 'no_response';
    symbols.push(h('g', {
      'data-ear': q.ear, 'data-frequency': q.frequencyHz, 'data-db': q.thresholdDbHl,
      'data-kind': nr ? 'no_response' : 'measured', 'data-shadow': q.possibleShadow ? 'true' : 'false',
    },
      symbol(q.ear, cx, cy, r, p, { shadow: q.possibleShadow }),
      nr && arrow(q.ear, cx, cy, r, p),
      h('title', {}, `${EAR_NAME[q.ear]} ${q.frequencyHz} Hz: ${nr ? `no response at ${q.thresholdDbHl} dB HL` : `${q.thresholdDbHl} dB HL`}${q.possibleShadow ? ' — possible shadow (unmasked)' : ''}`),
    ));
  }

  // --- legend (always present, spec §8)
  const lx = plot.x;
  const ly = L.legendTop;
  const col = Math.min(250, plot.width / 2);
  const row = 24;
  const entry = (x: number, y: number, glyph: SvgNode, text: string): SvgNode =>
    h('g', { 'data-legend-entry': text }, glyph, h('text', { x: x + 22, y: y + 4, 'font-size': 12, fill: p.text }, text));
  const legend = h('g', { 'data-layer': 'legend', 'font-family': font },
    h('text', { x: lx, y: ly - 14, 'font-size': 12.5, 'font-weight': 600, fill: p.text }, 'Key'),
    entry(lx, ly, symbol('right', lx + 8, ly, 7, p, { shadow: false }), 'Right ear, air conduction (O)'),
    entry(lx + col, ly, symbol('left', lx + col + 8, ly, 7, p, { shadow: false }), 'Left ear, air conduction (X)'),
    entry(lx, ly + row, h('g', {}, symbol('right', lx + 6, ly + row - 3, 6, p, { shadow: false }), arrow('right', lx + 6, ly + row - 3, 6, p)), 'No response at the maximum level (right)'),
    entry(lx + col, ly + row, h('g', {}, symbol('left', lx + col + 6, ly + row - 3, 6, p, { shadow: false }), arrow('left', lx + col + 6, ly + row - 3, 6, p)), 'No response at the maximum level (left)'),
    entry(lx, ly + 2 * row, symbol('right', lx + 8, ly + 2 * row, 7, p, { shadow: true }), 'Possible shadow, unmasked (right)'),
    entry(lx + col, ly + 2 * row, symbol('left', lx + col + 8, ly + 2 * row, 7, p, { shadow: true }), 'Possible shadow, unmasked (left)'),
    entry(lx, ly + 3 * row, h('rect', { x: lx, y: ly + 3 * row - 7, width: 16, height: 12, fill: p.normalBand, stroke: p.gridMajor, 'stroke-width': 0.5 }), 'WHO normal range (< 20 dB HL)'),
    mode === 'clinician' && data.sigmaDb
      ? h('g', { 'data-legend-entry': 'sigma' },
          h('text', { x: lx + col, y: ly + 3 * row - 2, 'font-size': 11, fill: p.mutedText }, `Bars: ±${data.sigmaDb} dB = model σ of the PTA (tier ${data.calibrationTier ?? '?'}),`),
          h('text', { x: lx + col, y: ly + 3 * row + 11, 'font-size': 11, fill: p.mutedText }, 'not a per-frequency confidence interval.'))
      : false,
    h('text', { x: lx, y: ly + 4 * row + 2, 'font-size': 11, fill: p.mutedText },
      'Air conduction only: bone conduction not tested; no masking used.' +
        (unresolved.length ? ` Not determined: ${unresolved.map((q) => `${q.ear} ${q.frequencyHz} Hz`).join(', ')}.` : '')),
  );

  return h(
    'svg',
    {
      xmlns: 'http://www.w3.org/2000/svg',
      viewBox: `0 0 ${L.width} ${L.height}`,
      width: L.width,
      height: L.height,
      role: 'img',
      'aria-labelledby': `${id}-title ${id}-desc`,
      'font-family': font,
      'data-mode': mode,
      'data-octave-px': L.octavePx,
      'data-px-per-db': L.pxPerDb,
    },
    h('title', { id: `${id}-title` }, title),
    h('desc', { id: `${id}-desc` }, audiogramTextSummary(data)),
    h('rect', { x: 0, y: 0, width: L.width, height: L.height, fill: p.background }),
    band,
    h('g', { 'data-layer': 'grid' }, ...grid),
    h('rect', { x: plot.x, y: plot.y, width: plot.width, height: plot.height, fill: 'none', stroke: p.gridMajor, 'stroke-width': 1.2 }),
    h('g', { 'data-layer': 'axes' }, ...labels),
    h('g', { 'data-layer': 'overlays' }, ...overlays),
    h('g', { 'data-layer': 'lines' }, ...lines),
    h('g', { 'data-layer': 'symbols' }, ...symbols),
    legend,
  );
}
