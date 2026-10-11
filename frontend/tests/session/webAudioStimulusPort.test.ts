import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';

import { mulberry32, ToneStimulusEngine } from '../../src/audio';
import { contextToPerformanceMs, createWebAudioStimulusPort } from '../../src/session';
import { SAMPLE_RATE, TEST_PROFILE } from '../helpers';

describe('AudioContext → performance.now() mapping', () => {
  it('uses getOutputTimestamp (includes output latency) when available', () => {
    const ctx = {
      currentTime: 10.2,
      getOutputTimestamp: () => ({ contextTime: 10.0, performanceTime: 50_000 }),
    } as unknown as BaseAudioContext;
    const map = contextToPerformanceMs(ctx);
    expect(map(10.0)).toBe(50_000);
    expect(map(12.5)).toBe(52_500);
  });

  it('falls back to currentTime + reported latency before the context renders', () => {
    const ctx = {
      currentTime: 3,
      outputLatency: 0.02,
      baseLatency: 0.005,
      getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }),
    } as unknown as BaseAudioContext;
    const map = contextToPerformanceMs(ctx, () => 1000);
    expect(map(3)).toBeCloseTo(1025, 9);
    expect(map(4)).toBeCloseTo(2025, 9);
  });
});

describe('createWebAudioStimulusPort over the real engine', () => {
  it('maps a scheduled tone onto the session clock without changing its timing', () => {
    const ctx = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new ToneStimulusEngine(ctx, { calibration: TEST_PROFILE, requireRunningContext: false, random: mulberry32(3) });
    const port = createWebAudioStimulusPort(engine, { random: mulberry32(4), perfNow: () => 7000 });
    const s = port.present({ ear: 'left', frequencyHz: 4000, levelDbHl: 30, phase: 'descent', testRole: 'initial' });
    expect(s.offsetMs - s.onsetMs).toBeCloseTo(s.durationMs, 6);
    expect(s.onsetMs - 7000).toBeCloseTo(s.isiMs, 6); // context time 0 ↔ perf 7000
    expect(s.audioContextOnsetS).toBeCloseTo(s.isiMs / 1000, 9);
    expect(s.presentedLevelDbHl).toBe(30);
    expect(engine.activeToneCount).toBe(1);
    s.cancel();
  });

  it('catch-trial timing uses the same distribution as real tones', () => {
    const ctx = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const engine = new ToneStimulusEngine(ctx, { calibration: TEST_PROFILE, requireRunningContext: false });
    const port = createWebAudioStimulusPort(engine, { random: mulberry32(9) });
    for (let i = 0; i < 200; i++) {
      const { durationMs, isiMs } = port.drawTiming();
      expect(durationMs).toBeGreaterThanOrEqual(engine.timing.minDurationMs);
      expect(durationMs).toBeLessThanOrEqual(engine.timing.maxDurationMs);
      expect(isiMs).toBeGreaterThanOrEqual(Math.max(engine.timing.minIsiMs, durationMs));
      expect(isiMs).toBeLessThanOrEqual(engine.timing.maxIsiMs);
    }
    expect(engine.activeToneCount).toBe(0); // drawing timing plays nothing
  });
});
