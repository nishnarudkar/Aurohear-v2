/**
 * ToneStimulusEngine — calibrated, click-free, ear-isolated pure-tone presentation.
 *
 * Signal graph (spec §4.1), one oscillator + two gains created per trial:
 *
 *   OscillatorNode(sine, f) → GainNode[envelope: Hann rise / plateau / Hann fall]
 *                           → GainNode[level: calibrated dB HL → linear gain]
 *                           → ChannelMergerNode input {0: left, 1: right}  (shared)
 *                           → destination (2 ch, discrete)
 *
 * Design decisions:
 * - Ear routing uses a ChannelMergerNode rather than a StereoPannerNode: the non-test
 *   merger input is simply unconnected, so that channel is digital zero by
 *   construction rather than by a pan law (spec §4 crosstalk row).
 * - A fresh oscillator per trial, stopped after the fall: no "closed gate" leakage
 *   (spec §4.1).
 * - Envelope and level live on separate GainNodes, so an abort can fade the level gain
 *   with its own Hann curve without having to cancel the envelope's automation.
 * - Every time is on the AudioContext clock; nothing uses setTimeout (spec §4.1).
 * - A tone is never truncated by a response; only `cancel()`/`stopAll()` stop it early,
 *   and they also fade out without a click.
 *
 * Out of scope here (owned by DeviceWatchdog / the test runner, spec §7.3): device
 * change and page visibility events, response windows, catch trials.
 */

import {
  type CalibrationProfile,
  type LevelResolution,
  resolveLevel,
} from './calibration';
import {
  assertValidRampMs,
  DEFAULT_RAMP_MS,
  hannFallCurve,
  hannRiseCurve,
  MIN_RAMP_MS,
  scaleCurve,
} from './envelope';
import {
  assertValidTiming,
  DEFAULT_TIMING,
  drawTrialTiming,
  type RandomSource,
  type StimulusTimingConfig,
} from './timing';
import {
  EAR_CHANNEL,
  type Ear,
  type FrequencyHz,
  isSupportedFrequency,
  type ScheduledTone,
  type ToneOutcome,
} from './types';

export type EngineFault = 'context_suspended' | 'context_closed' | 'context_interrupted';

export interface ToneStimulusEngineOptions {
  readonly calibration: CalibrationProfile;
  readonly timing?: StimulusTimingConfig;
  /** Rise and fall duration, 20–50 ms. */
  readonly rampMs?: number;
  /** Uniform [0, 1) source for timing draws. Defaults to Math.random. */
  readonly random?: RandomSource;
  /** Minimum look-ahead between scheduling and onset, so the onset is never late. */
  readonly schedulingLeadMs?: number;
  /** Fade length used by cancel()/stopAll(). */
  readonly abortFadeMs?: number;
  /**
   * Refuse to schedule unless `context.state === 'running'`. Disable only for
   * OfflineAudioContext rendering (tests, offline verification).
   */
  readonly requireRunningContext?: boolean;
  /** Called when the context leaves 'running' while tones are active (→ abort trial). */
  readonly onFault?: (fault: EngineFault) => void;
}

/** A trial tone: timing is always drawn at random (no overrides possible). */
export interface TrialToneRequest {
  readonly ear: Ear;
  readonly frequencyHz: number;
  readonly levelDbHl: number;
}

/** A setup-screen tone (channel check, calibration) with explicit timing. */
export interface FixedToneRequest extends TrialToneRequest {
  readonly durationMs: number;
  /** Silence before onset, measured from the later of now and the previous offset. */
  readonly isiMs: number;
}

export class AudioContextNotRunningError extends Error {
  constructor(state: string) {
    super(`AudioContext is '${state}'; tones can only be scheduled while it is running`);
    this.name = 'AudioContextNotRunningError';
  }
}

const STOP_TAIL_S = 0.01;

interface ActiveTone {
  readonly osc: OscillatorNode;
  readonly nodes: readonly AudioNode[];
  readonly onsetTime: number;
  readonly offsetTime: number;
  readonly linearGain: number;
  readonly levelGain: GainNode;
  cancelled: boolean;
  settled: boolean;
  resolve: (outcome: ToneOutcome) => void;
}

export class ToneStimulusEngine {
  readonly context: BaseAudioContext;
  readonly calibration: CalibrationProfile;
  readonly timing: StimulusTimingConfig;
  readonly rampMs: number;

  private readonly random: RandomSource;
  private readonly leadS: number;
  private readonly abortFadeS: number;
  private readonly requireRunning: boolean;
  private readonly onFault: ((fault: EngineFault) => void) | undefined;
  private readonly merger: ChannelMergerNode;
  private readonly riseCurve: Float32Array;
  private readonly fallCurve: Float32Array;
  private readonly abortFallCurve: Float32Array;
  private readonly active = new Map<number, ActiveTone>();
  private lastOffsetTime = 0;
  private nextId = 1;
  private disposed = false;

  constructor(context: BaseAudioContext, options: ToneStimulusEngineOptions) {
    this.context = context;
    this.calibration = options.calibration;
    this.rampMs = options.rampMs ?? DEFAULT_RAMP_MS;
    assertValidRampMs(this.rampMs);
    this.timing = options.timing ?? DEFAULT_TIMING;
    assertValidTiming(this.timing, this.rampMs);
    this.random = options.random ?? Math.random;
    this.leadS = (options.schedulingLeadMs ?? 50) / 1000;
    const abortFadeMs = options.abortFadeMs ?? MIN_RAMP_MS;
    assertValidRampMs(abortFadeMs);
    this.abortFadeS = abortFadeMs / 1000;
    this.requireRunning = options.requireRunningContext ?? true;
    this.onFault = options.onFault;

    const sr = context.sampleRate;
    this.riseCurve = hannRiseCurve(this.rampMs, sr);
    this.fallCurve = hannFallCurve(this.rampMs, sr);
    this.abortFallCurve = hannFallCurve(abortFadeMs, sr);

    const dest = context.destination;
    if (dest.maxChannelCount < 2) {
      throw new Error('output device is not stereo; ear-specific testing is impossible');
    }
    dest.channelCount = 2;
    dest.channelCountMode = 'explicit';
    dest.channelInterpretation = 'discrete';

    this.merger = context.createChannelMerger(2);
    this.merger.channelInterpretation = 'discrete';
    this.merger.connect(dest);

    // Offline contexts report 'suspended' during normal rendering, so state is only
    // watched where it is meaningful: real-time contexts.
    if (this.requireRunning) context.addEventListener('statechange', this.handleStateChange);
  }

  /**
   * Create the AudioContext and engine. MUST be called from inside a user gesture
   * (click / key handler) to satisfy browser autoplay policy (spec §4.1).
   */
  static async fromUserGesture(
    options: Omit<ToneStimulusEngineOptions, 'requireRunningContext'>,
  ): Promise<ToneStimulusEngine> {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await ctx.resume();
    if (ctx.state !== 'running') {
      await ctx.close();
      throw new AudioContextNotRunningError(ctx.state);
    }
    return new ToneStimulusEngine(ctx, options);
  }

  get activeToneCount(): number {
    return this.active.size;
  }

  /** Present a test-trial tone with randomised duration and ISI. */
  presentTrialTone(request: TrialToneRequest): ScheduledTone {
    const { durationMs, isiMs } = drawTrialTiming(this.timing, this.random);
    return this.schedule(request, durationMs, isiMs);
  }

  /** Present a tone with explicit timing (setup screens only — not for threshold trials). */
  presentTone(request: FixedToneRequest): ScheduledTone {
    if (!(request.durationMs > 2 * this.rampMs)) {
      throw new RangeError(`duration must exceed rise + fall (${2 * this.rampMs} ms)`);
    }
    if (!(request.isiMs >= 0)) throw new RangeError('ISI must be ≥ 0');
    return this.schedule(request, request.durationMs, request.isiMs);
  }

  /** Fade out and stop every active or pending tone. */
  stopAll(): void {
    for (const id of [...this.active.keys()]) this.cancelTone(id);
  }

  /** Stop everything and detach from the context. The owner closes the context. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.requireRunning) {
      this.context.removeEventListener('statechange', this.handleStateChange);
    }
    for (const id of [...this.active.keys()]) this.release(id, 'cancelled');
    this.merger.disconnect();
  }

  // ------------------------------------------------------------------ internals

  private schedule(request: TrialToneRequest, durationMs: number, isiMs: number): ScheduledTone {
    if (this.disposed) throw new Error('engine has been disposed');
    if (this.requireRunning && this.context.state !== 'running') {
      throw new AudioContextNotRunningError(this.context.state);
    }
    const frequencyHz = this.validateFrequency(request.frequencyHz);
    const level: LevelResolution = resolveLevel(this.calibration, frequencyHz, request.levelDbHl);

    const ctx = this.context;
    const now = ctx.currentTime;
    const rampS = this.rampMs / 1000;
    const durationS = durationMs / 1000;
    const onsetTime = Math.max(now + this.leadS, Math.max(now, this.lastOffsetTime) + isiMs / 1000);
    const offsetTime = onsetTime + durationS;
    this.lastOffsetTime = offsetTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = frequencyHz;
    const envelope = ctx.createGain();
    envelope.gain.value = 0; // fresh node: holds 0 until the rise begins
    const levelGain = ctx.createGain();
    levelGain.gain.value = level.linearGain;

    osc.connect(envelope);
    envelope.connect(levelGain);
    levelGain.connect(this.merger, 0, EAR_CHANNEL[request.ear]);

    envelope.gain.setValueCurveAtTime(this.riseCurve, onsetTime, rampS);
    envelope.gain.setValueCurveAtTime(this.fallCurve, offsetTime - rampS, rampS);
    osc.start(onsetTime);
    osc.stop(offsetTime + STOP_TAIL_S);

    const id = this.nextId++;
    let resolve!: (o: ToneOutcome) => void;
    const ended = new Promise<ToneOutcome>((r) => (resolve = r));
    const tone: ActiveTone = {
      osc,
      nodes: [osc, envelope, levelGain],
      onsetTime,
      offsetTime,
      linearGain: level.linearGain,
      levelGain,
      cancelled: false,
      settled: false,
      resolve,
    };
    this.active.set(id, tone);
    osc.onended = () => this.release(id, tone.cancelled ? 'cancelled' : 'completed');

    return {
      id,
      ear: request.ear,
      frequencyHz,
      requestedLevelDbHl: level.requestedDbHl,
      presentedLevelDbHl: level.presentedDbHl,
      levelClamped: level.clamped,
      linearGain: level.linearGain,
      durationMs,
      isiMs,
      rampMs: this.rampMs,
      onsetTime,
      offsetTime,
      ended,
      cancel: () => this.cancelTone(id),
    };
  }

  private validateFrequency(f: number): FrequencyHz {
    if (!isSupportedFrequency(f)) {
      throw new RangeError(`unsupported test frequency ${f} Hz (250–8000 Hz audiometric set)`);
    }
    if (f >= this.context.sampleRate / 2) {
      throw new RangeError(`${f} Hz is above Nyquist for ${this.context.sampleRate} Hz`);
    }
    return f;
  }

  private cancelTone(id: number): void {
    const tone = this.active.get(id);
    if (!tone || tone.cancelled || tone.settled) return;
    tone.cancelled = true;
    const now = this.context.currentTime;
    if (now >= tone.offsetTime) return; // already silent; onended will settle it
    if (now < tone.onsetTime) {
      tone.osc.stop(now); // never started → nothing audible
      return;
    }
    // Sounding: Hann-fade the level gain from its constant value, then stop.
    tone.levelGain.gain.setValueCurveAtTime(
      scaleCurve(this.abortFallCurve, tone.linearGain),
      now,
      this.abortFadeS,
    );
    tone.osc.stop(now + this.abortFadeS + STOP_TAIL_S);
  }

  private release(id: number, outcome: ToneOutcome): void {
    const tone = this.active.get(id);
    if (!tone || tone.settled) return;
    tone.settled = true;
    tone.osc.onended = null;
    for (const n of tone.nodes) n.disconnect();
    this.active.delete(id);
    tone.resolve(outcome);
  }

  private readonly handleStateChange = (): void => {
    const state = this.context.state as string;
    if (state === 'running' || this.active.size === 0) return;
    // Rendering has stopped, so onended will not fire: release immediately. The session
    // must be aborted by the runner (spec §4.1: suspension → immediate test abort).
    for (const tone of this.active.values()) tone.cancelled = true;
    for (const id of [...this.active.keys()]) this.release(id, 'cancelled');
    const fault: EngineFault =
      state === 'closed'
        ? 'context_closed'
        : state === 'interrupted'
          ? 'context_interrupted'
          : 'context_suspended';
    this.onFault?.(fault);
  };
}
