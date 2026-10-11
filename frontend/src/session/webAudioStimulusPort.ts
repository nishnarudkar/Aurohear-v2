/**
 * StimulusPort over ToneStimulusEngine: converts AudioContext times to the session's
 * performance.now() clock so tone onsets and key presses share one time base.
 *
 * Conversion uses AudioContext.getOutputTimestamp(), which pairs the context time
 * currently *leaving the output device* with a performance.now() value — so the onset
 * timestamp includes output latency and the logged response latency is measured from
 * the moment the tone is actually emitted, not from when it was scheduled.
 */

import type { ToneStimulusEngine } from '../audio/ToneStimulusEngine';
import { drawTrialTiming, type RandomSource } from '../audio/timing';
import type { ScheduledStimulus, StimulusPort } from './types';

export type ContextToPerformance = (contextTimeS: number) => number;

/** Build a context-time → performance.now() (ms) mapping for this instant. */
export function contextToPerformanceMs(ctx: BaseAudioContext, perfNow: () => number = () => performance.now()): ContextToPerformance {
  const ac = ctx as Partial<AudioContext>;
  if (typeof ac.getOutputTimestamp === 'function') {
    const ts = ac.getOutputTimestamp();
    if (ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      const { contextTime, performanceTime } = ts;
      return (t) => performanceTime + (t - contextTime) * 1000;
    }
  }
  // Fallback (context not yet rendering): currentTime is "now" plus reported latency.
  const refPerf = perfNow();
  const refCtx = ctx.currentTime;
  const latencyS = (ac.outputLatency ?? 0) + (ac.baseLatency ?? 0);
  return (t) => refPerf + (t - refCtx + latencyS) * 1000;
}

export function createWebAudioStimulusPort(
  engine: ToneStimulusEngine,
  options: { random?: RandomSource; perfNow?: () => number } = {},
): StimulusPort {
  const random = options.random ?? Math.random;
  return {
    drawTiming: () => drawTrialTiming(engine.timing, random),
    present: (p): ScheduledStimulus => {
      const tone = engine.presentTrialTone({ ear: p.ear, frequencyHz: p.frequencyHz, levelDbHl: p.levelDbHl });
      const toPerf = contextToPerformanceMs(engine.context, options.perfNow);
      return {
        durationMs: tone.durationMs,
        isiMs: tone.isiMs,
        onsetMs: toPerf(tone.onsetTime),
        offsetMs: toPerf(tone.offsetTime),
        audioContextOnsetS: tone.onsetTime,
        presentedLevelDbHl: tone.presentedLevelDbHl,
        levelClamped: tone.levelClamped,
        cancel: () => tone.cancel(),
      };
    },
  };
}
