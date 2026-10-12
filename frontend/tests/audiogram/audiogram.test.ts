/** Audiogram geometry and symbology (spec §8). The tree is inspected directly. */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  audiogramFromResults,
  audiogramSvgString,
  audiogramTextSummary,
  connectingSegments,
  findAll,
  makeLayout,
  noResponseArrow,
  PALETTES,
  renderAudiogram,
  serialize,
  type AudiogramData,
  type AudiogramPoint,
  type SvgNode,
} from '../../src/audiogram';
import type { SessionResultsDto } from '../../src/api/types';

const P = (ear: 'right' | 'left', f: number, t: number | null, o: Partial<AudiogramPoint> = {}): AudiogramPoint => ({
  ear, frequencyHz: f, status: 'measured', thresholdDbHl: t, possibleShadow: false, testRole: 'initial', accepted: true, ...o,
});

const SAMPLE: AudiogramData = {
  sigmaDb: 7.6,
  calibrationTier: 'C',
  points: [
    P('right', 250, 10), P('right', 500, 15), P('right', 1000, 20), P('right', 1000, 30, { testRole: 'retest', accepted: false }),
    P('right', 2000, 40), P('right', 4000, 60), P('right', 6000, 75), P('right', 8000, 90, { status: 'no_response' }),
    P('left', 250, 0), P('left', 500, 5), P('left', 1000, 5), P('left', 2000, 10), P('left', 3000, null, { status: 'unresolved' }),
    P('left', 4000, 0), P('left', 6000, 50, { possibleShadow: true }), P('left', 8000, 25),
  ],
};

const attr = (n: SvgNode, k: string): number => Number(n.attrs[k]);
const byData = (root: SvgNode, key: string, value?: string): SvgNode[] =>
  findAll(root, (n) => key in n.attrs && (value === undefined || String(n.attrs[key]) === value));

// ================================================================ geometry

describe('geometry (spec §8)', () => {
  it('one octave occupies exactly the same distance as 20 dB, at any scale', () => {
    fc.assert(
      fc.property(fc.double({ min: 20, max: 400, noNaN: true }), fc.constantFrom(125, 250, 500, 1000, 2000, 4000), fc.integer({ min: -10, max: 70 }), (octavePx, f, db) => {
        const L = makeLayout({ octavePx });
        const oneOctave = L.x(f * 2) - L.x(f);
        const twentyDb = L.y(db + 20) - L.y(db);
        expect(oneOctave).toBeCloseTo(octavePx, 9);
        expect(twentyDb).toBeCloseTo(oneOctave, 9);
      }),
    );
  });

  it('frequency is logarithmic, ascending left → right; inter-octaves sit at log₂ positions', () => {
    const L = makeLayout({ octavePx: 100 });
    expect(L.x(250)).toBeLessThan(L.x(500));
    expect(L.x(1500) - L.x(1000)).toBeCloseTo(100 * Math.log2(1.5), 9);
    expect(L.x(3000) - L.x(2000)).toBeCloseTo(L.x(1500) - L.x(1000), 9);
    expect(L.x(125)).toBeGreaterThan(L.plot.x); // padded, not on the frame
    expect(L.x(8000)).toBeLessThan(L.plot.x + L.plot.width);
  });

  it('hearing level is linear and increases downward from −10 dB HL to the maximum', () => {
    const L = makeLayout();
    expect(L.y(-10)).toBeLessThan(L.y(0));
    expect(L.y(90) - L.y(80)).toBeCloseTo(L.y(10) - L.y(0), 9);
    expect(L.dbMin).toBe(-10);
    expect(L.dbMax).toBe(90);
    expect(L.y(L.dbMin)).toBeGreaterThan(L.plot.y);
    expect(L.y(L.dbMax)).toBeLessThan(L.plot.y + L.plot.height); // room for NR arrows below
    expect(makeLayout({ dbMax: 113 }).dbMax).toBe(120);
  });

  it('no-response arrows: right ↙, left ↘, at 45° from the lower outer corner', () => {
    for (const [ear, sign] of [['right', -1], ['left', 1]] as const) {
      const a = noResponseArrow(100, 100, 10, ear);
      expect(Math.sign(a.x2 - a.x1)).toBe(sign);
      expect(a.y2).toBeGreaterThan(a.y1);
      expect(Math.abs(a.x2 - a.x1)).toBeCloseTo(a.y2 - a.y1, 9); // 45°
      expect(Math.sign(a.x1 - 100)).toBe(sign); // starts on the outer side
      expect(a.y1).toBeGreaterThan(100); // lower half
    }
  });
});

// ================================================================ symbology

describe('symbols, lines and no-response (spec §8)', () => {
  const tree = renderAudiogram(SAMPLE);
  const L = makeLayout();
  const symbols = byData(tree, 'data-kind');

  it('plots every accepted threshold with O for right and X for left', () => {
    expect(symbols).toHaveLength(SAMPLE.points.filter((q) => q.accepted && q.status !== 'unresolved').length);
    for (const s of symbols) {
      const circles = findAll(s, (n) => n.tag === 'circle');
      const crosses = findAll(s, (n) => n.tag === 'line' && !('data-nr-arrow' in n.attrs));
      if (s.attrs['data-ear'] === 'right') expect(circles).toHaveLength(1);
      else expect(circles).toHaveLength(0);
      const circle = circles[0];
      const f = Number(s.attrs['data-frequency']);
      const db = Number(s.attrs['data-db']);
      if (circle) {
        expect(attr(circle, 'cx')).toBeCloseTo(L.x(f), 6);
        expect(attr(circle, 'cy')).toBeCloseTo(L.y(db), 6);
      } else {
        expect(crosses.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('no-response is drawn at the maximum level with an arrow, and is never joined', () => {
    const nr = symbols.filter((s) => s.attrs['data-kind'] === 'no_response');
    expect(nr).toHaveLength(1);
    expect(nr[0]!.attrs['data-db']).toBe(90);
    expect(byData(nr[0]!, 'data-nr-arrow', 'down-left')).toHaveLength(1);
    const rightSegs = byData(tree, 'data-segment').filter((n) => n.attrs['data-ear'] === 'right').map((n) => String(n.attrs['data-segment']));
    expect(rightSegs).toEqual(['250-500', '500-1000', '1000-2000', '2000-4000', '4000-6000']);
    expect(rightSegs.some((s) => s.split('-').includes('8000'))).toBe(false); // NR at 8 kHz never joined
  });

  it('possible shadow is half-filled, not joined, and gets no error bar', () => {
    const shadow = symbols.filter((s) => s.attrs['data-shadow'] === 'true');
    expect(shadow).toHaveLength(1);
    expect(findAll(shadow[0]!, (n) => n.attrs['data-shadow-fill'] === 'true').length).toBeGreaterThan(0);
    const leftSegs = byData(tree, 'data-ear', 'left').filter((n) => 'data-segment' in n.attrs).map((n) => String(n.attrs['data-segment']));
    expect(leftSegs).toEqual(['250-500', '500-1000', '1000-2000']); // 3000 unresolved, 6000 shadow break the line
    const clin = renderAudiogram(SAMPLE, { mode: 'clinician' });
    expect(byData(clin, 'data-error-bar', 'left-6000')).toHaveLength(0);
  });

  it('both ears use continuous (non-dashed) connecting lines (spec §8)', () => {
    const lines = byData(tree, 'data-segment');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => !('stroke-dasharray' in l.attrs))).toBe(true);
    expect(new Set(lines.map((l) => l.attrs['data-ear']))).toEqual(new Set(['right', 'left']));
  });

  it('property: segments only ever join frequency-adjacent valid thresholds', () => {
    const point = fc.record({
      ear: fc.constantFrom<'right' | 'left'>('right', 'left'),
      frequencyHz: fc.constantFrom(250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000),
      status: fc.constantFrom<AudiogramPoint['status']>('measured', 'measured', 'measured', 'no_response', 'unresolved'),
      thresholdDbHl: fc.integer({ min: -2, max: 18 }).map((n) => n * 5),
      possibleShadow: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
      testRole: fc.constant<'initial'>('initial'),
      accepted: fc.constant(true),
    });
    fc.assert(
      fc.property(fc.uniqueArray(point, { selector: (q) => `${q.ear}${q.frequencyHz}`, maxLength: 20 }), (pts) => {
        for (const ear of ['right', 'left'] as const) {
          const mine: AudiogramPoint[] = pts.filter((q) => q.ear === ear).sort((a, b) => a.frequencyHz - b.frequencyHz);
          for (const [a, b] of connectingSegments(pts, ear)) {
            expect(a.status).toBe('measured');
            expect(b.status).toBe('measured');
            expect(a.possibleShadow || b.possibleShadow).toBe(false);
            expect(mine.indexOf(b) - mine.indexOf(a)).toBe(1); // adjacent tested frequencies
          }
        }
      }),
    );
  });

  it('shades the WHO normal range from −10 to 20 dB HL', () => {
    const band = byData(tree, 'data-band', 'who-normal')[0]!;
    expect(attr(band, 'y')).toBeCloseTo(L.y(-10), 6);
    expect(attr(band, 'y') + attr(band, 'height')).toBeCloseTo(L.y(20), 6);
  });

  it('draws gridlines every 5 dB (10 dB major), octave lines solid, inter-octaves dashed', () => {
    expect(byData(tree, 'data-grid', 'db-major')).toHaveLength(11); // −10 … 90
    expect(byData(tree, 'data-grid', 'db-minor')).toHaveLength(10);
    expect(byData(tree, 'data-grid', 'octave')).toHaveLength(7); // 125 … 8000
    const inter = byData(tree, 'data-grid', 'inter-octave');
    expect(inter).toHaveLength(4);
    expect(inter.every((n) => 'stroke-dasharray' in n.attrs)).toBe(true);
  });

  it('the legend is always present and explains every symbol', () => {
    for (const mode of ['normal', 'clinician'] as const) {
      const entries = byData(renderAudiogram(SAMPLE, { mode }), 'data-legend-entry').map((n) => String(n.attrs['data-legend-entry']));
      for (const needle of ['Right ear', 'Left ear', 'No response', 'Possible shadow', 'WHO normal']) {
        expect(entries.some((e) => e.includes(needle)), `${mode}: ${needle}`).toBe(true);
      }
    }
    expect(serialize(tree)).toContain('bone conduction not tested');
    expect(serialize(tree)).toContain('Not determined: left 3000 Hz');
  });
});

// ================================================================ modes, theme, a11y, export

describe('display modes', () => {
  it('normal mode has no clinician overlays', () => {
    const t = renderAudiogram(SAMPLE, { mode: 'normal' });
    expect(byData(t, 'data-error-bar')).toHaveLength(0);
    expect(byData(t, 'data-secondary')).toHaveLength(0);
  });

  it('clinician mode: ±σ bars on valid thresholds, and every non-accepted search shown', () => {
    const t = renderAudiogram(SAMPLE, { mode: 'clinician' });
    const L = makeLayout();
    const bars = byData(t, 'data-error-bar');
    const valid = SAMPLE.points.filter((q) => q.accepted && q.status === 'measured' && !q.possibleShadow && q.thresholdDbHl !== null);
    expect(bars).toHaveLength(valid.length);
    const shaft = findAll(bars[0]!, (n) => n.tag === 'line')[0]!;
    expect(attr(shaft, 'y2') - attr(shaft, 'y1')).toBeCloseTo(2 * 7.6 * L.pxPerDb, 6);
    expect(byData(t, 'data-secondary', 'right-1000-retest')).toHaveLength(1);
    expect(serialize(t)).toContain('not a per-frequency confidence interval');
  });

  it('extends the scale when asked (e.g. a 120 dB HL clinical layout)', () => {
    const t = renderAudiogram(SAMPLE, { layout: { dbMax: 120 } });
    expect(byData(t, 'data-grid', 'db-major')).toHaveLength(14);
  });
});

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
const contrast = (a: string, b: string): number => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
};

describe('accessibility', () => {
  it.each(['light', 'dark'] as const)('%s palette: text ≥ 7:1 (AAA), ear colours ≥ 4.5:1 against the background', (theme) => {
    const p = PALETTES[theme];
    expect(contrast(p.text, p.background)).toBeGreaterThanOrEqual(7);
    expect(contrast(p.mutedText, p.background)).toBeGreaterThanOrEqual(7);
    expect(contrast(p.right, p.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.left, p.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.text, p.normalBand)).toBeGreaterThanOrEqual(7);
  });

  it('has an accessible name and a full text alternative', () => {
    const t = renderAudiogram(SAMPLE, { idPrefix: 'x' });
    expect(t.attrs['role']).toBe('img');
    expect(t.attrs['aria-labelledby']).toBe('x-title x-desc');
    const summary = audiogramTextSummary(SAMPLE);
    expect(summary).toContain('Right ear: 250 Hz 10 dB HL');
    expect(summary).toContain('8000 Hz no response at 90 dB HL');
    expect(summary).toContain('3000 Hz not determined');
    expect(summary).toContain('6000 Hz 50 dB HL (possible shadow, unmasked)');
    expect(summary).not.toContain('1000 Hz 30'); // non-accepted retest is not the reported value
  });
});

describe('export', () => {
  it('standalone SVG: XML header, concrete colours (no CSS variables), escaped text', () => {
    const svg = audiogramSvgString(SAMPLE, { title: 'R&D <test>' });
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg ')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).not.toContain('var(');
    expect(svg).toContain('R&amp;D &lt;test&gt;');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('maps API results (accepted vs all searches, σ and tier)', () => {
    const results = {
      thresholds: [
        { ear: 'right', frequency_hz: 1000, test_role: 'initial', status: 'measured', threshold_db_hl: 20, possible_shadow: false, is_accepted: true },
        { ear: 'right', frequency_hz: 1000, test_role: 'retest', status: 'measured', threshold_db_hl: 30, possible_shadow: false, is_accepted: false },
      ],
      classification: { sigma_pta_db: 5.4, calibration_tier: 'B' },
    } as unknown as SessionResultsDto;
    const d = audiogramFromResults(results);
    expect(d.sigmaDb).toBe(5.4);
    expect(d.calibrationTier).toBe('B');
    expect(d.points.map((q) => [q.testRole, q.accepted])).toEqual([['initial', true], ['retest', false]]);
  });
});
