/**
 * Wires the ambient-noise gate and the device watchdog to a running test session.
 *
 *   noise (spec §5.3.2) — frames whose analysis window overlaps a tone (± margins) or a
 *     key press are ignored; while the gate is noisy, NOISE_EXCEEDED is sent (the machine
 *     acts on it only while a trial is in flight); once quiet again in NoisyWait,
 *     NOISE_CLEARED resumes the test.
 *   watchdog (spec §4.1) — device change → FAULT('device_change'); hidden/blurred →
 *     PAGE_HIDDEN; visible again → PAGE_VISIBLE.
 */

import type { Actor } from 'xstate';

import type { BandLevels } from '../audio/noiseBands';
import type { NoiseGate } from '../audio/NoiseGate';
import type { WatchdogEvent } from '../audio/DeviceWatchdog';
import type { testSessionMachine } from './testSessionMachine';

export interface FrameSource {
  /** Duration of audio each frame summarises (ms). */
  readonly frameSpanMs: number;
  start(onFrame: (tMs: number, bands: BandLevels) => void, intervalMs?: number): void;
  stop(): void;
}

export interface Watchdog {
  start(): Promise<void>;
  stop(): void;
}

/** [DESIGN] margins around a tone and after a key press. */
export const TONE_GUARD_BEFORE_MS = 50;
export const TONE_GUARD_AFTER_MS = 150;
export const PRESS_GUARD_MS = 400;

type SessionActor = Actor<typeof testSessionMachine>;

const topState = (actor: SessionActor): string => {
  const v = actor.getSnapshot().value;
  return typeof v === 'string' ? v : Object.keys(v)[0]!;
};

/** True if the audio summarised by a frame ending at `tMs` must not be used. */
export function frameExcluded(actor: SessionActor, tMs: number, frameSpanMs: number): boolean {
  const ctx = actor.getSnapshot().context;
  const from = tMs - frameSpanMs;
  const tr = ctx.trial;
  if (tr && !tr.isCatchTrial && from <= tr.offsetMs + TONE_GUARD_AFTER_MS && tMs >= tr.onsetMs - TONE_GUARD_BEFORE_MS) return true;
  const press = ctx.lastAcceptedPressMs;
  if (press !== null && from <= press + PRESS_GUARD_MS && tMs >= press) return true;
  return false;
}

export function attachNoiseGate(actor: SessionActor, frames: FrameSource, gate: NoiseGate): () => void {
  gate.setExclusion((t) => frameExcluded(actor, t, frames.frameSpanMs));
  frames.start((tMs, bands) => {
    gate.ingest(tMs, bands);
    if (actor.getSnapshot().status !== 'active') return;
    if (gate.isNoisy) actor.send({ type: 'NOISE_EXCEEDED' });
    else if (topState(actor) === 'NoisyWait') actor.send({ type: 'NOISE_CLEARED' });
  });
  return () => frames.stop();
}

export function watchdogHandler(actor: SessionActor): (e: WatchdogEvent) => void {
  return (e) => {
    if (actor.getSnapshot().status !== 'active') return;
    if (e === 'device_change') actor.send({ type: 'FAULT', reason: 'device_change' });
    else if (e === 'hidden') actor.send({ type: 'PAGE_HIDDEN' });
    else actor.send({ type: 'PAGE_VISIBLE' });
  };
}
