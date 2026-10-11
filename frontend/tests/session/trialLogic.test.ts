import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  type ActiveTrial,
  classifyResponse,
  type ClassifyInput,
  isFalseAlarm,
  isFamiliarisationStart,
  isRetest1kStart,
  type Presentation,
  shouldInsertCatchTrial,
  summariseQc,
  toResponseRecord,
  toTrialRecord,
} from '../../src/session';

const pres = (o: Partial<Presentation> = {}): Presentation => ({
  ear: 'right',
  frequencyHz: 1000,
  levelDbHl: 40,
  phase: 'descent',
  testRole: 'initial',
  ...o,
});

const trial = (o: Partial<ActiveTrial> = {}): ActiveTrial => ({
  trialId: 't1',
  seq: 0,
  presentation: pres(),
  isCatchTrial: false,
  scheduledAtMs: 0,
  durationMs: 1200,
  isiMs: 2000,
  onsetMs: 2000,
  offsetMs: 3200,
  windowEndMs: 5200,
  audioContextOnsetS: 2.5,
  presentedLevelDbHl: 40,
  levelClamped: false,
  cancel: () => {},
  responseTimestampMs: null,
  extraResponses: 0,
  ...o,
});

const base = (o: Partial<ClassifyInput> = {}): ClassifyInput => ({
  timestampMs: 2500,
  lastAcceptedPressMs: null,
  inTrialLoop: true,
  trial: trial(),
  lastScoredWindowEndMs: null,
  debounceMs: 150,
  ...o,
});

describe('classifyResponse', () => {
  it('window is [onset, offset + 2 s], inclusive at both ends', () => {
    expect(classifyResponse(base({ timestampMs: 1999.9 }))).toBe('out_of_window');
    expect(classifyResponse(base({ timestampMs: 2000 }))).toBe('hit');
    expect(classifyResponse(base({ timestampMs: 5200 }))).toBe('hit');
    expect(classifyResponse(base({ timestampMs: 5200.1 }))).toBe('out_of_window');
  });

  it('catch trial presses are catch false alarms; second press is a repeat', () => {
    const c = trial({ isCatchTrial: true });
    expect(classifyResponse(base({ trial: c }))).toBe('catch_false_alarm');
    expect(classifyResponse(base({ trial: { ...c, responseTimestampMs: 2300 } }))).toBe('repeat');
  });

  it('debounce takes precedence over everything', () => {
    expect(classifyResponse(base({ lastAcceptedPressMs: 2400 }))).toBe('debounced');
    expect(classifyResponse(base({ lastAcceptedPressMs: 2350 }))).toBe('hit');
    expect(classifyResponse(base({ lastAcceptedPressMs: 2400, inTrialLoop: false }))).toBe('debounced');
  });

  it('presses on instruction/break screens are not trials', () => {
    expect(classifyResponse(base({ inTrialLoop: false }))).toBe('no_trial');
  });

  it('a stale event inside the previous window is late_after_scoring, not a false alarm', () => {
    expect(classifyResponse(base({ trial: null, timestampMs: 900, lastScoredWindowEndMs: 1000 }))).toBe('late_after_scoring');
    expect(classifyResponse(base({ trial: null, timestampMs: 1100, lastScoredWindowEndMs: 1000 }))).toBe('out_of_window');
  });

  it('property: classification depends only on the timestamp vs the trial timeline', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -5000, max: 10000, noNaN: true }),
        fc.boolean(),
        fc.boolean(),
        (t, isCatch, already) => {
          const tr = trial({ isCatchTrial: isCatch, responseTimestampMs: already ? 2100 : null });
          const c = classifyResponse(base({ timestampMs: t, trial: tr }));
          const inWindow = t >= tr.onsetMs && t <= tr.windowEndMs;
          if (!inWindow) expect(c).toBe('out_of_window');
          else if (already) expect(c).toBe('repeat');
          else expect(c).toBe(isCatch ? 'catch_false_alarm' : 'hit');
          expect(isFalseAlarm(c)).toBe(c === 'out_of_window' || c === 'catch_false_alarm');
          const rec = toResponseRecord(base({ timestampMs: t, trial: tr }), c, 'keyboard');
          if (c === 'hit') expect(rec.latencyMs).toBe(t - tr.onsetMs);
          if (c === 'out_of_window') expect(rec.trialId).toBeNull();
        },
      ),
    );
  });
});

describe('catch-trial placement', () => {
  it('never in familiarisation, never twice in a row, otherwise at the configured rate', () => {
    expect(shouldInsertCatchTrial(pres({ phase: 'familiarisation' }), false, 1, () => 0)).toBe(false);
    expect(shouldInsertCatchTrial(pres(), true, 1, () => 0)).toBe(false);
    expect(shouldInsertCatchTrial(pres(), false, 0, () => 0)).toBe(false);
    expect(shouldInsertCatchTrial(pres(), false, 0.1, () => 0.05)).toBe(true);
    expect(shouldInsertCatchTrial(pres(), false, 0.1, () => 0.15)).toBe(false);
  });
});

describe('search boundaries', () => {
  it('detects a new ear familiarisation and the 1 kHz retest once each', () => {
    const fam = pres({ phase: 'familiarisation' });
    expect(isFamiliarisationStart(fam, null)).toBe(true);
    expect(isFamiliarisationStart(fam, 'right|1000|initial|fam')).toBe(false);
    expect(isFamiliarisationStart(pres({ phase: 'familiarisation', ear: 'left' }), 'right|1000|initial|fam')).toBe(true);
    const retest = pres({ testRole: 'retest' });
    expect(isRetest1kStart(retest, 'right|1000|initial|fam')).toBe(true);
    expect(isRetest1kStart(retest, 'right|1000|retest|hw')).toBe(false);
    expect(isRetest1kStart(pres(), null)).toBe(false);
    expect(isRetest1kStart(pres({ testRole: 'verification', frequencyHz: 2000 }), null)).toBe(false);
  });
});

describe('records and QC summary', () => {
  it('trial record carries exact timing and latency', () => {
    const r = toTrialRecord(trial({ responseTimestampMs: 2640 }));
    expect(r).toMatchObject({
      onsetMs: 2000,
      offsetMs: 3200,
      windowEndMs: 5200,
      responded: true,
      responseTimestampMs: 2640,
      responseLatencyMs: 640,
      phase: 'descent',
      discarded: false,
    });
    const c = toTrialRecord(trial({ isCatchTrial: true, presentedLevelDbHl: null }));
    expect(c.phase).toBe('catch');
    expect(c.requestedLevelDbHl).toBeNull();
    expect(toTrialRecord(trial(), { reason: 'visibility_hidden' }).discarded).toBe(true);
  });

  it('discarded trials are excluded from rates', () => {
    const trials = [
      toTrialRecord(trial({ trialId: 'a', isCatchTrial: true, responseTimestampMs: 2500 })),
      toTrialRecord(trial({ trialId: 'b', isCatchTrial: true })),
      toTrialRecord(trial({ trialId: 'c', isCatchTrial: true, responseTimestampMs: 2500 }), { reason: 'x' }),
      toTrialRecord(trial({ trialId: 'd', responseTimestampMs: 2300 })),
      toTrialRecord(trial({ trialId: 'e', responseTimestampMs: 2700 })),
    ];
    const qc = summariseQc(trials, [], 0);
    expect(qc.catchTrials).toBe(2);
    expect(qc.falsePositiveRate).toBe(0.5);
    expect(qc.discardedTrials).toBe(1);
    expect(qc.meanLatencyMs).toBe(500);
    expect(qc.medianLatencyMs).toBe(500);
    expect(qc.sdLatencyMs).toBeCloseTo(Math.sqrt(2 * 200 ** 2), 9);
  });
});
