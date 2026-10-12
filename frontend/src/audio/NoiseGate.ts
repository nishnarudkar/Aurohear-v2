/**
 * Ambient-noise gate (spec §5): pre-test check + continuous monitoring in the gaps.
 *
 * TWO MODES, chosen by what the deployment can honestly know (spec §5.3.3):
 *
 *  absolute — the microphone has a known sensitivity (calibrated against a sound level
 *             meter, or a per-device-model profile) AND an MPANL table is configured.
 *             Limit per ⅓-octave band = MPANL_band + test_floor + transducer credit_band
 *             (spec §5.3.1, BSA Appendix C floor rule), plus the 35 dB(A) broadband
 *             backstop (BSA §4.2).
 *  relative — fallback for an uncalibrated microphone: the pre-test capture is the room's
 *             own quiet baseline and the gate detects *changes* (band > baseline +
 *             RELATIVE_MARGIN_DB). The absolute level is NOT known, and the session
 *             record says so with its uncertainty.
 *
 * No MPANL values or microphone sensitivities ship with the app: both must come from
 * the procured ISO 8253-1 / BSA table and from measurement (spec §2, §3.3 [VERIFY]).
 *
 * Continuous monitoring samples only BETWEEN tones (spec §5.3.2: "never during a tone —
 * you would just record your own stimulus"), and also skips the moment of a key press
 * (the participant's own click).
 */

import {
  aWeightedLevelDb,
  type BandHz,
  type BandLevels,
  bandLevelsFromSpectrum,
  energyMean,
  isSilent,
  offsetBands,
  THIRD_OCTAVE_BANDS_HZ,
} from './noiseBands';

// ------------------------------------------------------------------ configuration

/** dB(A) broadband backstop: "if ambient noise exceeds ~35 dB(A), audiometry should not proceed" (BSA §4.2). */
export const BROADBAND_GATE_DBA = 35;
/** [DESIGN — tune] relative mode: a band this far above the quiet baseline is "too noisy". */
export const RELATIVE_MARGIN_DB = 10;
/** [DESIGN] spec §5.3.3 fallback uncertainty for a relative-only measurement. */
export const RELATIVE_MODE_UNCERTAINTY_DB = 8;
/** [DESIGN] pre-test: a band whose 1-s level swings more than this is "unsteady". */
export const MAX_PRETEST_FLUCTUATION_DB = 12;
export const PRETEST_DURATION_MS = 15_000; // spec §5.3.1

export interface MicCalibration {
  readonly source: 'sound_level_meter' | 'device_profile';
  /** Add to analyser dB to get dB SPL. */
  readonly offsetDb: number;
  readonly uncertaintyDb: number;
  readonly reference: string;
}

/** An MPANL table transcribed from the procured standard (ISO 8253-1 / BSA Appendix C). */
export interface MpanlTable {
  readonly id: string;
  readonly source: string;
  /** dB SPL per ⅓-octave band for measuring down to 0 dB HL. */
  readonly bandsDbSpl: Readonly<Partial<Record<BandHz, number>>>;
}

export interface AbsoluteConfig {
  readonly mic: MicCalibration;
  readonly mpanl: MpanlTable;
  /** Lowest level the test needs to measure (BSA: add it to every table value). */
  readonly testFloorDbHl: number;
  /** Extra attenuation credited for the transducer, per band (e.g. circumaural, [R7]). */
  readonly transducerCreditDb?: Readonly<Partial<Record<BandHz, number>>>;
}

export type BandLimits = Readonly<Partial<Record<BandHz, number>>>;

export function absoluteBandLimits(cfg: AbsoluteConfig): BandLimits {
  const out: Partial<Record<BandHz, number>> = {};
  for (const b of THIRD_OCTAVE_BANDS_HZ) {
    const mpanl = cfg.mpanl.bandsDbSpl[b];
    if (mpanl === undefined) continue; // band not in the table: not gated, reported as such
    out[b] = mpanl + cfg.testFloorDbHl + (cfg.transducerCreditDb?.[b] ?? 0);
  }
  return out;
}

export function relativeBandLimits(baseline: BandLevels, marginDb = RELATIVE_MARGIN_DB): BandLimits {
  return Object.fromEntries(THIRD_OCTAVE_BANDS_HZ.map((b) => [b, baseline[b] + marginDb]));
}

export interface Assessment {
  readonly exceededBands: readonly BandHz[];
  readonly broadbandDb: number;
  readonly broadbandExceeded: boolean;
  readonly ok: boolean;
}

export function assess(bands: BandLevels, limits: BandLimits, broadbandLimitDb: number | null): Assessment {
  const exceededBands = THIRD_OCTAVE_BANDS_HZ.filter((b) => limits[b] !== undefined && bands[b] > limits[b]!);
  const broadbandDb = aWeightedLevelDb(bands);
  const broadbandExceeded = broadbandLimitDb !== null && broadbandDb > broadbandLimitDb;
  return { exceededBands, broadbandDb, broadbandExceeded, ok: exceededBands.length === 0 && !broadbandExceeded };
}

// ------------------------------------------------------------------ pre-test gate

export interface PretestResult {
  readonly mode: 'absolute' | 'relative';
  readonly pass: boolean;
  readonly reasons: readonly string[];
  /** Energy-mean band levels: dB SPL (absolute) or analyser dB (relative). */
  readonly meanBands: BandLevels;
  /** dB(A) in absolute mode; null when the level is not absolutely known. */
  readonly dba: number | null;
  readonly fluctuationDb: number;
  readonly limits: BandLimits;
  readonly uncertaintyDb: number;
}

/** 1-s blocks: max − min band level, the steadiness of the room. */
function fluctuation(frames: readonly BandLevels[], framesPerSecond: number): number {
  const blocks: BandLevels[] = [];
  for (let i = 0; i + framesPerSecond <= frames.length; i += framesPerSecond) blocks.push(energyMean(frames.slice(i, i + framesPerSecond)));
  if (blocks.length < 2) return 0;
  return Math.max(...THIRD_OCTAVE_BANDS_HZ.map((b) => Math.max(...blocks.map((x) => x[b])) - Math.min(...blocks.map((x) => x[b]))));
}

export function pretestDecision(
  frames: readonly BandLevels[],
  opts: { readonly absolute: AbsoluteConfig | null; readonly framesPerSecond: number },
): PretestResult {
  if (frames.length === 0 || frames.every(isSilent)) {
    return {
      mode: opts.absolute ? 'absolute' : 'relative',
      pass: false,
      reasons: ['No sound reached the microphone. Check that it is switched on and not muted.'],
      meanBands: energyMean(frames.length ? frames : [Object.fromEntries(THIRD_OCTAVE_BANDS_HZ.map((b) => [b, -200])) as unknown as BandLevels]),
      dba: null,
      fluctuationDb: 0,
      limits: {},
      uncertaintyDb: RELATIVE_MODE_UNCERTAINTY_DB,
    };
  }
  const fluct = fluctuation(frames, opts.framesPerSecond);
  const reasons: string[] = [];
  if (fluct > MAX_PRETEST_FLUCTUATION_DB) reasons.push('The noise in the room keeps changing. Wait for it to settle, then check again.');

  if (opts.absolute) {
    const meanBands = offsetBands(energyMean(frames), opts.absolute.mic.offsetDb);
    const limits = absoluteBandLimits(opts.absolute);
    const a = assess(meanBands, limits, BROADBAND_GATE_DBA);
    if (a.broadbandExceeded) reasons.push(`The room is too loud (about ${Math.round(a.broadbandDb)} dB(A); the limit is ${BROADBAND_GATE_DBA}).`);
    if (a.exceededBands.length) reasons.push(`Too much noise around ${a.exceededBands.map((b) => (b >= 1000 ? `${b / 1000} kHz` : `${b} Hz`)).join(', ')}.`);
    return { mode: 'absolute', pass: reasons.length === 0, reasons, meanBands, dba: a.broadbandDb, fluctuationDb: fluct, limits, uncertaintyDb: opts.absolute.mic.uncertaintyDb };
  }
  const meanBands = energyMean(frames);
  return {
    mode: 'relative',
    pass: reasons.length === 0,
    reasons,
    meanBands,
    dba: null,
    fluctuationDb: fluct,
    limits: relativeBandLimits(meanBands),
    uncertaintyDb: RELATIVE_MODE_UNCERTAINTY_DB,
  };
}

// ------------------------------------------------------------------ continuous gate

export interface GateOptions {
  readonly limits: BandLimits;
  readonly broadbandLimitDb: number | null;
  /** Offset to add to raw analyser dB (absolute mode); 0 in relative mode. */
  readonly offsetDb: number;
  /** Consecutive noisy frames before acting (ignores a single transient). */
  readonly exceedFrames?: number;
  /** Quiet time needed before resuming. */
  readonly clearMs?: number;
}

export type GateTransition = 'exceeded' | 'cleared' | null;

/** Pure, time-driven gate. Feed it analysis frames; it reports state changes. */
export class NoiseGate {
  private noisy = false;
  private run = 0;
  private quietSince: number | null = null;
  private excluded: (t: number) => boolean = () => false;
  private readonly exceedFrames: number;
  private readonly clearMs: number;
  exceedances = 0;

  constructor(private readonly opts: GateOptions) {
    this.exceedFrames = opts.exceedFrames ?? 2;
    this.clearMs = opts.clearMs ?? 2000;
  }

  get isNoisy(): boolean {
    return this.noisy;
  }

  /** Frames for which this returns true are ignored (tones, key presses). */
  setExclusion(fn: (tMs: number) => boolean): void {
    this.excluded = fn;
  }

  ingest(tMs: number, rawBands: BandLevels): GateTransition {
    if (this.excluded(tMs)) return null;
    const a = assess(offsetBands(rawBands, this.opts.offsetDb), this.opts.limits, this.opts.broadbandLimitDb);
    if (!a.ok) {
      this.quietSince = null;
      this.run += 1;
      if (!this.noisy && this.run >= this.exceedFrames) {
        this.noisy = true;
        this.exceedances += 1;
        return 'exceeded';
      }
      return null;
    }
    this.run = 0;
    if (this.noisy) {
      this.quietSince ??= tMs;
      if (tMs - this.quietSince >= this.clearMs) {
        this.noisy = false;
        this.quietSince = null;
        return 'cleared';
      }
    }
    return null;
  }
}

// ------------------------------------------------------------------ browser microphone

export interface MicrophoneStatus {
  /** All three processing stages confirmed off by the browser (spec §4.1). */
  readonly processingOff: boolean;
  readonly settings: Readonly<Record<string, unknown>>;
}

/** Microphone → AnalyserNode (never audible: routed through a zero gain). */
export class NoiseMonitor {
  private readonly analyser: AnalyserNode;
  private readonly sink: GainNode;
  private readonly buffer: Float32Array<ArrayBuffer>;
  private timer: ReturnType<typeof setInterval> | null = null;

  private constructor(
    readonly context: BaseAudioContext,
    readonly stream: MediaStream | null,
    readonly status: MicrophoneStatus,
    source: AudioNode,
  ) {
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 8192; // 5.9 Hz bins at 48 kHz: ≥ 9 bins in the 250 Hz band
    this.analyser.smoothingTimeConstant = 0;
    this.buffer = new Float32Array(this.analyser.frequencyBinCount);
    this.sink = context.createGain();
    this.sink.gain.value = 0; // keeps the analyser pulled without making any sound
    source.connect(this.analyser);
    this.analyser.connect(this.sink);
    this.sink.connect(context.destination);
  }

  /** Spec §4.1: request the microphone with all processing disabled, and verify it. */
  static async open(context: AudioContext, mediaDevices: MediaDevices = navigator.mediaDevices): Promise<NoiseMonitor> {
    const stream = await mediaDevices.getUserMedia({
      audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
      video: false,
    });
    const settings = (stream.getAudioTracks()[0]?.getSettings?.() ?? {}) as Record<string, unknown>;
    const processingOff = settings['echoCancellation'] === false && settings['autoGainControl'] === false && settings['noiseSuppression'] === false;
    return new NoiseMonitor(context, stream, { processingOff, settings }, context.createMediaStreamSource(stream));
  }

  /** For tests / offline analysis with an arbitrary source node. */
  static fromNode(context: BaseAudioContext, source: AudioNode): NoiseMonitor {
    return new NoiseMonitor(context, null, { processingOff: true, settings: {} }, source);
  }

  /** Duration of audio summarised by one frame (the FFT window), in ms. */
  get frameSpanMs(): number {
    return (this.analyser.fftSize / this.context.sampleRate) * 1000;
  }

  readFrame(): BandLevels {
    this.analyser.getFloatFrequencyData(this.buffer);
    return bandLevelsFromSpectrum(this.buffer, this.context.sampleRate, this.analyser.fftSize);
  }

  /** Call `onFrame(timeMs, bands)` every `intervalMs` (performance.now() clock). */
  start(onFrame: (tMs: number, bands: BandLevels) => void, intervalMs = 100): void {
    this.stop();
    this.timer = setInterval(() => onFrame(performance.now(), this.readFrame()), intervalMs);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  close(): void {
    this.stop();
    this.analyser.disconnect();
    this.sink.disconnect();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
  }
}
