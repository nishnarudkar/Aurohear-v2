/**
 * Runtime wiring: one AudioContext (created in the Welcome click — autoplay policy,
 * spec §4.1), a setup engine for raw-digital tones (channel check, calibration), and the
 * calibrated test engine + API client + test-session actor.
 */

import { ApiSessionClient } from '../api/ApiSessionClient';
import { createApiBackedTestSession, type ApiBackedTestSession } from '../api/createApiBackedTestSession';
import { IndexedDbOutboxStore, MemoryOutboxStore, type OutboxStore } from '../api/outbox';
import type { SessionCreateDto } from '../api/types';
import { frequencyCapsDbHl, type CalibrationProfile } from '../audio/calibration';
import { type EngineFault, ToneStimulusEngine } from '../audio/ToneStimulusEngine';
import { SUPPORTED_FREQUENCIES_HZ } from '../audio/types';
import { biologicalProfile, RAW_DIGITAL_PROFILE, TIER_C_PROFILE_VERSION } from '../calibration/biological';
import { createWebAudioStimulusPort } from '../session/webAudioStimulusPort';
import { DeviceWatchdog } from '../audio/DeviceWatchdog';
import { BROADBAND_GATE_DBA, NoiseGate, type NoiseMonitor, type PretestResult } from '../audio/NoiseGate';
import { attachNoiseGate, watchdogHandler } from '../session/environmentGuards';
import type { CalibrationOutcome, DeviceSetup } from './appFlowMachine';
import { API_BASE_URL, CONSENT_VERSION, INTER_EAR_BREAK_MS, NOISE_ABSOLUTE_CONFIG } from './config';
import type { IntakeAnswers } from './intake';
import { participantId } from './participant';

export interface SetupAudio {
  readonly context: AudioContext;
  readonly engine: ToneStimulusEngine;
}

/** Must be called from a user gesture. */
export async function createSetupAudio(): Promise<SetupAudio> {
  const engine = await ToneStimulusEngine.fromUserGesture({ calibration: RAW_DIGITAL_PROFILE });
  return { context: engine.context as AudioContext, engine };
}

export function testProfile(calibration: CalibrationOutcome): CalibrationProfile {
  return biologicalProfile(calibration.ref1kDbfs);
}

export function createTestEngine(audio: SetupAudio, profile: CalibrationProfile, onFault: (f: EngineFault) => void): ToneStimulusEngine {
  audio.engine.dispose(); // one engine on the destination at a time
  return new ToneStimulusEngine(audio.context, { calibration: profile, onFault });
}

export function sessionCreateBody(
  intake: IntakeAnswers,
  device: DeviceSetup,
  calibration: CalibrationOutcome,
  profile: CalibrationProfile,
  sampleRate: number,
  environment: PretestResult,
  microphoneProcessingOff: boolean,
): SessionCreateDto {
  const cross250 = calibration.crossChecks.find((c) => c.frequencyHz === 250);
  return {
    participant_id: participantId(),
    consent_version: CONSENT_VERSION,
    mode: 'threshold',
    supervision: 'unsupervised',
    better_ear: intake.betterEar === 'unsure' ? null : intake.betterEar,
    profile_cap_db_hl: 90,
    frequency_caps_db_hl: frequencyCapsDbHl(profile, SUPPORTED_FREQUENCIES_HZ),
    client_time_origin_ms: performance.timeOrigin,
    device: {
      user_agent: navigator.userAgent.slice(0, 512),
      platform: (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? null,
      audio_output_label: device.outputLabel,
      sample_rate: sampleRate,
      headphone_profile_id: null,
      transducer_type: device.transducerType,
      connection: 'wired',
    },
    calibration: {
      tier: 'C',
      method: 'biological_1k',
      profile_version: TIER_C_PROFILE_VERSION,
      spread_db: calibration.run.spreadDb,
      cross_check_250hz_delta_db: cross250 ? cross250.deltaDb : null,
      calibrated_at: calibration.calibratedAt,
    },
    environment: {
      level_reference: environment.mode === 'absolute' ? 'db_spl' : 'relative',
      pretest_dba: environment.dba,
      pretest_third_octave: Object.fromEntries(Object.entries(environment.meanBands).map(([b, v]) => [b, Math.round(v * 10) / 10])),
      uncertainty_db: environment.uncertaintyDb,
      pretest_fluctuation_db: Math.round(environment.fluctuationDb * 10) / 10,
      microphone_processing_off: microphoneProcessingOff,
      mpanl_table: NOISE_ABSOLUTE_CONFIG?.mpanl.id ?? null,
      test_floor_db: NOISE_ABSOLUTE_CONFIG?.testFloorDbHl ?? null,
    },
  };
}

function outbox(): OutboxStore {
  try {
    if (globalThis.indexedDB) return new IndexedDbOutboxStore();
  } catch {
    /* fall through */
  }
  return new MemoryOutboxStore();
}

export function createTestRun(engine: ToneStimulusEngine, body: SessionCreateDto): ApiBackedTestSession {
  const client = new ApiSessionClient({ baseUrl: API_BASE_URL, session: body, outbox: outbox() });
  return createApiBackedTestSession({
    client,
    deps: { stimulus: createWebAudioStimulusPort(engine), now: () => performance.now(), random: Math.random },
    config: { interEarBreakMs: INTER_EAR_BREAK_MS },
  });
}

/**
 * Start continuous noise monitoring (spec §5.3.2) and the device watchdog (spec §4.1) for
 * a running test. Returns a function that stops both.
 */
export function startEnvironmentGuards(run: ApiBackedTestSession, monitor: NoiseMonitor, environment: PretestResult): () => void {
  const absolute = environment.mode === 'absolute' && NOISE_ABSOLUTE_CONFIG !== null;
  const gate = new NoiseGate({
    limits: environment.limits,
    broadbandLimitDb: absolute ? BROADBAND_GATE_DBA : null,
    offsetDb: absolute ? NOISE_ABSOLUTE_CONFIG!.mic.offsetDb : 0,
  });
  const detachNoise = attachNoiseGate(run.actor, monitor, gate);
  const watchdog = new DeviceWatchdog(watchdogHandler(run.actor));
  void watchdog.start();
  return () => {
    detachNoise();
    watchdog.stop();
  };
}
