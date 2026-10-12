import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ABSOLUTE_MAX_DB_HL,
  type CalibrationProfile,
  ceilingDbHl,
  frequencyCapsDbHl,
  dbHlToLinearGain,
  maxAchievableDbHl,
  resolveLevel,
  SUPPORTED_FREQUENCIES_HZ,
} from '../src/audio';
import { TEST_PROFILE } from './helpers';

const freq = fc.constantFrom(...SUPPORTED_FREQUENCIES_HZ);
const level = fc.double({ min: -10, max: 120, noNaN: true });

describe('dB HL → linear gain (spec §4.1 formula)', () => {
  it('matches the formula exactly', () => {
    // 60 + 10 + 0 − 110 = −40 dB → 0.01
    expect(dbHlToLinearGain(TEST_PROFILE, 1000, 60)).toBeCloseTo(0.01, 12);
    const withOffset = { ...TEST_PROFILE, calOffsetDb: 6 };
    expect(dbHlToLinearGain(withOffset, 1000, 60)).toBeCloseTo(10 ** (-34 / 20), 12);
  });

  it('a Δ dB change in level is exactly a Δ dB change in gain', () => {
    fc.assert(
      fc.property(freq, fc.double({ min: -10, max: 80, noNaN: true }), fc.double({ min: 0, max: 10, noNaN: true }), (f, l, d) => {
        const ratioDb = 20 * Math.log10(dbHlToLinearGain(TEST_PROFILE, f, l + d) / dbHlToLinearGain(TEST_PROFILE, f, l));
        expect(ratioDb).toBeCloseTo(d, 9);
      }),
    );
  });
});

describe('output ceiling and clamping (spec §3.4, QC indicator 13)', () => {
  it('ceiling is min(achievable, safe limit, 90)', () => {
    expect(maxAchievableDbHl(TEST_PROFILE, 1000)).toBe(99);
    expect(ceilingDbHl(TEST_PROFILE, 1000)).toBe(ABSOLUTE_MAX_DB_HL);
    expect(ceilingDbHl(TEST_PROFILE, 8000)).toBe(84);
    const safe: CalibrationProfile = { ...TEST_PROFILE, maxSafeDbHl: { 2000: 70 } };
    expect(ceilingDbHl(safe, 2000)).toBe(70);
  });

  it('never delivers above the ceiling or full scale, and flags every clamp', () => {
    fc.assert(
      fc.property(freq, level, (f, l) => {
        const r = resolveLevel(TEST_PROFILE, f, l);
        const ceiling = ceilingDbHl(TEST_PROFILE, f);
        expect(r.presentedDbHl).toBeLessThanOrEqual(ceiling);
        expect(r.presentedDbHl).toBeLessThanOrEqual(ABSOLUTE_MAX_DB_HL);
        expect(r.clamped).toBe(l > ceiling);
        expect(r.presentedDbHl).toBe(r.clamped ? ceiling : l);
        expect(r.linearGain).toBeLessThanOrEqual(10 ** (-TEST_PROFILE.headroomDb / 20) + 1e-12);
        expect(r.linearGain).toBeGreaterThan(0);
      }),
    );
  });

  it('rejects levels below −10 dB HL and non-finite levels', () => {
    for (const bad of [-10.5, -20, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveLevel(TEST_PROFILE, 1000, bad)).toThrow(RangeError);
    }
  });

  it('a profile missing a frequency throws instead of defaulting (GAP_ANALYSIS #6/#7)', () => {
    const partial: CalibrationProfile = { ...TEST_PROFILE, etsplDbSpl: { 1000: 10 } };
    expect(() => resolveLevel(partial, 2000, 40)).toThrow(/missing etsplDbSpl at 2000 Hz/);
    expect(() => resolveLevel(partial, 1000, 40)).not.toThrow();
  });
});

describe('per-frequency caps for the API (spec §3.4)', () => {
  it('reports each frequency ceiling, keyed by Hz', () => {
    const caps = frequencyCapsDbHl(TEST_PROFILE, SUPPORTED_FREQUENCIES_HZ);
    expect(caps['8000']).toBe(84);
    expect(caps['1000']).toBe(90);
    expect(Object.keys(caps)).toHaveLength(SUPPORTED_FREQUENCIES_HZ.length);
  });
});
