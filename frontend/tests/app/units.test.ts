/** Pure app logic: calibration maths (§3.2), device checks (§3.3), progress, app flow. */

import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';

import { ceilingDbHl, dbHlToLinearGain } from '../../src/audio/calibration';
import {
  aWeightingDb,
  biologicalProfile,
  crossCheck,
  dbfsToRawLevel,
  modelZeroHlDbfs,
  RAW_DIGITAL_PROFILE,
  runReferenceDbfs,
  summariseRuns,
} from '../../src/calibration/biological';
import { channelCheckOrder, looksLikeBluetooth } from '../../src/calibration/device';
import { appFlowMachine } from '../../src/app/appFlowMachine';
import { EMPTY_INTAKE, type IntakeAnswers, intakeComplete, positiveRedFlags } from '../../src/app/intake';
import { progressFromTrials } from '../../src/app/progress';
import type { TrialRecord } from '../../src/session/types';
import { sampleRecord } from '../api/fixtures';

describe('biological calibration (spec §3.2)', () => {
  it('A-weighting matches the IEC 61672-1 table (nominal-frequency values are rounded to 0.1 dB)', () => {
    // The table lists nominal frequencies (e.g. "250" is 251.19 Hz on the base-10 series)
    // rounded to 0.1 dB, so the exact formula at 250 Hz gives −8.67 vs the tabulated −8.6.
    const within = (got: number, table: number): void => expect(Math.abs(got - table)).toBeLessThan(0.1);
    expect(Math.abs(aWeightingDb(1000))).toBeLessThan(0.01);
    within(aWeightingDb(250), -8.6);
    within(aWeightingDb(500), -3.2);
    within(aWeightingDb(2000), 1.2);
    within(aWeightingDb(4000), 1.0);
    within(aWeightingDb(8000), -1.1);
  });

  it('a run is the mean of the two tones (5 dB apart)', () => {
    expect(runReferenceDbfs(-70)).toBe(-72.5);
  });

  it('needs ≥ 3 runs within 5 dB', () => {
    expect(summariseRuns([-72, -73, -71]).accepted).toBe(true);
    expect(summariseRuns([-72, -73, -71]).referenceDbfs).toBeCloseTo(-72, 9);
    expect(summariseRuns([-72, -73]).accepted).toBe(false);
    const wide = summariseRuns([-70, -72, -76]);
    expect(wide.accepted).toBe(false);
    expect(wide.spreadDb).toBe(6);
    expect(wide.reason).toMatch(/differ by 6\.0 dB/);
  });

  it('cross-checks compare against the model and flag > 10 dB', () => {
    const pred250 = modelZeroHlDbfs(-80, 250);
    expect(pred250).toBeCloseTo(-80 - (aWeightingDb(250) - aWeightingDb(1000)), 9); // ear less sensitive at 250 Hz → higher digital level
    expect(pred250).toBeGreaterThan(-80);
    expect(crossCheck(-80, 250, pred250 + 4).withinLimit).toBe(true);
    expect(crossCheck(-80, 250, pred250 + 11).withinLimit).toBe(false);
    expect(crossCheck(-80, 250, pred250 - 3).deltaDb).toBeCloseTo(-3, 9);
  });

  it('the Tier C profile puts 0 dB HL at the reference digital level and caps output', () => {
    const p = biologicalProfile(-80);
    expect(20 * Math.log10(dbHlToLinearGain(p, 1000, 0))).toBeCloseTo(-80, 9);
    expect(20 * Math.log10(dbHlToLinearGain(p, 250, 0))).toBeCloseTo(modelZeroHlDbfs(-80, 250), 9);
    expect(ceilingDbHl(p, 1000)).toBeCloseTo(79, 6); // 80 dB of range − 1 dB headroom
    expect(ceilingDbHl(biologicalProfile(-120), 1000)).toBe(90); // never above 90 dB HL
  });

  it('raw-digital playback maps dBFS exactly', () => {
    expect(20 * Math.log10(dbHlToLinearGain(RAW_DIGITAL_PROFILE, 1000, dbfsToRawLevel(-45)))).toBeCloseTo(-45, 9);
  });
});

describe('device checks (spec §3.3)', () => {
  it.each(['AirPods Pro', 'Headset (Bluetooth Hands-Free)', 'Galaxy Buds2', 'WH-1000XM4', 'Jabra Elite 75t', 'BT Speaker'])(
    'blocks wireless output "%s"',
    (label) => expect(looksLikeBluetooth(label)).toBe(true),
  );
  it.each(['Headphones (Realtek(R) Audio)', 'External Headphones', 'Speakers (USB Audio Device)', 'Built-in Output'])(
    'does not flag wired output "%s"',
    (label) => expect(looksLikeBluetooth(label)).toBe(false),
  );
  it('channel check uses both ears equally, in random order', () => {
    let s = 7;
    const rnd = (): number => ((s = (s * 16807) % 2147483647) / 2147483647);
    const o = channelCheckOrder(rnd, 6);
    expect(o.filter((e) => e === 'left')).toHaveLength(3);
    expect(o.filter((e) => e === 'right')).toHaveLength(3);
  });
});

const allNo = (): IntakeAnswers => ({
  redFlags: Object.fromEntries(Object.keys(EMPTY_INTAKE.redFlags).map((k) => [k, false])) as IntakeAnswers['redFlags'],
  noiseExposure24h: false,
  tinnitus: false,
  difficultyInNoise: false,
  betterEar: 'unsure',
});

describe('intake and app flow (spec §7.2)', () => {
  it('intake is complete only when every question is answered', () => {
    expect(intakeComplete(EMPTY_INTAKE)).toBe(false);
    expect(intakeComplete(allNo())).toBe(true);
    expect(intakeComplete({ ...allNo(), tinnitus: null })).toBe(false);
  });

  it('any red flag halts before the test (HALT_REFER)', () => {
    const a = createActor(appFlowMachine).start();
    a.send({ type: 'CONSENT_ACCEPTED' });
    const answers = { ...allNo(), redFlags: { ...allNo().redFlags, vertigo: true } };
    expect(positiveRedFlags(answers)).toEqual(['vertigo']);
    a.send({ type: 'INTAKE_SUBMITTED', answers });
    expect(a.getSnapshot().value).toBe('halted');
    expect(a.getSnapshot().status).toBe('done'); // nothing can start a test from here
    a.send({ type: 'DEVICE_CONFIRMED', device: {} as never });
    expect(a.getSnapshot().value).toBe('halted');
  });

  it('the setup sequence is fixed: intake → device → calibration → environment → instructions → testing', () => {
    const a = createActor(appFlowMachine).start();
    a.send({ type: 'BEGIN_TEST' }); // cannot skip ahead
    expect(a.getSnapshot().value).toBe('welcome');
    a.send({ type: 'CONSENT_ACCEPTED' });
    a.send({ type: 'INTAKE_SUBMITTED', answers: allNo() });
    expect(a.getSnapshot().value).toBe('device');
    a.send({ type: 'CALIBRATED', calibration: {} as never }); // out of order: ignored
    expect(a.getSnapshot().value).toBe('device');
    a.send({ type: 'DEVICE_CONFIRMED', device: { transducerType: 'circumaural', outputLabel: null, wiredAttested: true, channelCheckPassed: true } });
    a.send({ type: 'CALIBRATED', calibration: {} as never });
    expect(a.getSnapshot().value).toBe('environment');
    a.send({ type: 'BEGIN_TEST' }); // no test without the noise check (spec §5.2)
    expect(a.getSnapshot().value).toBe('environment');
    a.send({ type: 'ENVIRONMENT_PASSED', environment: { pass: false } as never }); // a failed check cannot advance
    expect(a.getSnapshot().value).toBe('environment');
    a.send({ type: 'ENVIRONMENT_PASSED', environment: { pass: true } as never });
    expect(a.getSnapshot().value).toBe('instructions');
    a.send({ type: 'BEGIN_TEST' });
    expect(a.getSnapshot().value).toBe('testing');
  });
});

const t = (o: Partial<TrialRecord>): TrialRecord => ({ ...sampleRecord, ...o });

describe('runner progress (spec §7.3: coarse, no level)', () => {
  it('advances only when a search completes; ignores familiarisation and catch trials', () => {
    const fam = t({ phase: 'familiarisation' });
    const s1 = t({ phase: 'descent', frequencyHz: 1000 });
    const c = t({ phase: 'catch', isCatchTrial: true, frequencyHz: 2000 });
    const s2 = t({ phase: 'descent', frequencyHz: 2000 });
    expect(progressFromTrials([fam, fam], 'right').percent).toBe(0);
    expect(progressFromTrials([fam, s1, s1, s1], 'right').percent).toBe(0); // first search still running
    expect(progressFromTrials([fam, s1, s1, c], 'right').percent).toBe(0); // catch does not count
    expect(progressFromTrials([fam, s1, s1, s2], 'right').percent).toBe(Math.floor(100 / 17));
    expect(progressFromTrials([s1, t({ ear: 'left', frequencyHz: 1000, phase: 'descent' })], 'right').earNumber).toBe(2);
  });

  it('never reaches 100% before the end and never reveals frequency or level', () => {
    const many = Array.from({ length: 40 }, (_, i) => t({ phase: 'descent', frequencyHz: 1000 + i }));
    const p = progressFromTrials(many, 'right');
    expect(p.percent).toBeLessThan(100);
    expect(Object.keys(p).sort()).toEqual(['earNumber', 'percent']);
  });
});
