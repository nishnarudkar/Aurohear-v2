/** DeviceWatchdog event emission + environment guards wired into a live session machine. */

import { describe, expect, it } from 'vitest';

import { DeviceWatchdog, type WatchdogEvent } from '../../src/audio/DeviceWatchdog';
import { type BandLevels, THIRD_OCTAVE_BANDS_HZ } from '../../src/audio/noiseBands';
import { NoiseGate, relativeBandLimits } from '../../src/audio/NoiseGate';
import { attachNoiseGate, type FrameSource, watchdogHandler } from '../../src/session/environmentGuards';
import { advanceTo, flush, makeHarness, stateOf } from '../session/harness';

class FakeTarget extends EventTarget {}

function fakeDevices(list: { kind: MediaDeviceKind; deviceId: string; label: string }[]) {
  const md = new FakeTarget() as FakeTarget & { enumerateDevices(): Promise<MediaDeviceInfo[]>; list: typeof list };
  md.list = list;
  md.enumerateDevices = async () => md.list.map((d) => ({ ...d, groupId: '', toJSON: () => d }) as unknown as MediaDeviceInfo);
  return md;
}

function fakeDoc() {
  const doc = new FakeTarget() as FakeTarget & { visibilityState: DocumentVisibilityState; focused: boolean; hasFocus(): boolean };
  doc.visibilityState = 'visible';
  doc.focused = true;
  doc.hasFocus = () => doc.focused;
  return doc;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('DeviceWatchdog (spec §4.1)', () => {
  it('reports a change of output devices (headphones unplugged), not a no-op devicechange', async () => {
    const md = fakeDevices([{ kind: 'audiooutput', deviceId: 'hp', label: 'Headphones' }, { kind: 'audioinput', deviceId: 'mic', label: 'Mic' }]);
    const events: WatchdogEvent[] = [];
    const w = new DeviceWatchdog((e) => events.push(e), { mediaDevices: md, doc: fakeDoc(), win: new FakeTarget() });
    await w.start();
    md.dispatchEvent(new Event('devicechange')); // nothing actually changed
    await tick();
    expect(events).toEqual([]);
    md.list = [{ kind: 'audiooutput', deviceId: 'spk', label: 'Speakers' }, { kind: 'audioinput', deviceId: 'mic', label: 'Mic' }];
    md.dispatchEvent(new Event('devicechange'));
    await tick();
    expect(events).toEqual(['device_change']);
    w.stop();
  });

  it('falls back to input devices when outputs are not exposed (Firefox/Safari)', async () => {
    const md = fakeDevices([{ kind: 'audioinput', deviceId: 'headset-mic', label: 'Headset' }]);
    const events: WatchdogEvent[] = [];
    const w = new DeviceWatchdog((e) => events.push(e), { mediaDevices: md, doc: fakeDoc(), win: new FakeTarget() });
    await w.start();
    md.list = [{ kind: 'audioinput', deviceId: 'internal', label: 'Internal Mic' }];
    md.dispatchEvent(new Event('devicechange'));
    await tick();
    expect(events).toEqual(['device_change']);
  });

  it('tab hidden or window blurred → hidden; visible and focused again → visible (once each)', async () => {
    const doc = fakeDoc();
    const win = new FakeTarget();
    const events: WatchdogEvent[] = [];
    const w = new DeviceWatchdog((e) => events.push(e), { mediaDevices: undefined, doc, win });
    await w.start();
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    doc.dispatchEvent(new Event('visibilitychange'));
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    doc.focused = false;
    win.dispatchEvent(new Event('blur'));
    doc.focused = true;
    win.dispatchEvent(new Event('focus'));
    expect(events).toEqual(['hidden', 'visible', 'hidden', 'visible']);
    w.stop();
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(events).toHaveLength(4); // stopped
  });
});

// ---------------------------------------------------------------- guards ↔ machine

const flatBands = (db: number): BandLevels => Object.fromEntries(THIRD_OCTAVE_BANDS_HZ.map((b) => [b, db])) as unknown as BandLevels;

class ManualFrames implements FrameSource {
  readonly frameSpanMs = 170;
  private cb: ((t: number, b: BandLevels) => void) | null = null;
  start(onFrame: (t: number, b: BandLevels) => void): void {
    this.cb = onFrame;
  }
  stop(): void {
    this.cb = null;
  }
  push(t: number, b: BandLevels): void {
    this.cb?.(t, b);
  }
}

async function toFirstWait() {
  const h = makeHarness({ config: { catchTrialRate: 0 } });
  const a = h.session.actor;
  a.send({ type: 'START' });
  await flush();
  a.send({ type: 'ACKNOWLEDGE' });
  a.send({ type: 'CONTINUE' });
  await flush();
  return h;
}

describe('environment guards on a running session', () => {
  const quiet = flatBands(-95);
  const loud = { ...flatBands(-95), 500: -60 } as BandLevels;

  it('noise between tones discards the trial, holds in NoisyWait, then re-presents the same tone', async () => {
    const h = await toFirstWait();
    const frames = new ManualFrames();
    const gate = new NoiseGate({ limits: relativeBandLimits(quiet), broadbandLimitDb: null, offsetDb: 0 });
    attachNoiseGate(h.session.actor, frames, gate);
    const tr = h.session.actor.getSnapshot().context.trial!;
    const t = tr.onsetMs - 600; // in the ISI, clear of the tone guard
    await advanceTo(h, t);
    frames.push(t, loud);
    frames.push(t + 100, loud);
    expect(stateOf(h)).toBe('NoisyWait');
    const rec = h.session.actor.getSnapshot().context.trials.at(-1)!;
    expect(rec).toMatchObject({ discarded: true, discardReason: 'ambient_noise' });
    expect(h.stimulus.cancelled).toEqual([0]); // the scheduled tone is cancelled
    for (let k = 0; k <= 21; k++) frames.push(t + 200 + k * 100, quiet);
    await flush();
    expect(stateOf(h)).toMatch(/^InterStimulusInterval/);
    expect(h.stimulus.presented.at(-1)).toEqual(h.stimulus.presented[0]); // same tone again
    expect(h.session.actor.getSnapshot().context.noiseInterruptions).toBe(1);
  });

  it('frames overlapping a tone are ignored — the gate never hears its own stimulus', async () => {
    const h = await toFirstWait();
    const frames = new ManualFrames();
    const gate = new NoiseGate({ limits: relativeBandLimits(quiet), broadbandLimitDb: null, offsetDb: 0 });
    attachNoiseGate(h.session.actor, frames, gate);
    const tr = h.session.actor.getSnapshot().context.trial!;
    await advanceTo(h, tr.onsetMs);
    for (let t = tr.onsetMs; t <= tr.offsetMs + 300; t += 100) frames.push(t, loud); // tone leaking into the mic
    expect(gate.isNoisy).toBe(false);
    expect(stateOf(h)).toBe('TonePresenting');
  });

  it('a key press is not mistaken for room noise', async () => {
    const h = await toFirstWait();
    const frames = new ManualFrames();
    const gate = new NoiseGate({ limits: relativeBandLimits(quiet), broadbandLimitDb: null, offsetDb: 0 });
    attachNoiseGate(h.session.actor, frames, gate);
    const tr = h.session.actor.getSnapshot().context.trial!;
    const t = tr.onsetMs - 800;
    await advanceTo(h, t);
    h.session.actor.send({ type: 'RESPONSE', timestampMs: t });
    frames.push(t + 100, loud);
    frames.push(t + 200, loud);
    expect(gate.isNoisy).toBe(false);
  });

  it('watchdog: hidden mid-tone → Backgrounded (trial discarded) → visible → re-present; device change aborts', async () => {
    const h = await toFirstWait();
    const send = watchdogHandler(h.session.actor);
    const tr = h.session.actor.getSnapshot().context.trial!;
    await advanceTo(h, tr.onsetMs + 100);
    send('hidden');
    expect(stateOf(h)).toBe('Backgrounded');
    expect(h.session.actor.getSnapshot().context.trials.at(-1)).toMatchObject({ discarded: true, discardReason: 'visibility_hidden' });
    send('visible');
    await flush();
    expect(stateOf(h)).toMatch(/^InterStimulusInterval/);
    send('device_change');
    expect(h.session.actor.getSnapshot().output).toMatchObject({ status: 'aborted', abortReason: 'device_change' });
  });

  it('noise while no trial is in flight (e.g. a reminder screen) does not discard anything', async () => {
    const h = makeHarness({ config: { catchTrialRate: 0 } });
    h.session.actor.send({ type: 'START' });
    await flush();
    h.session.actor.send({ type: 'ACKNOWLEDGE' }); // → Familiarization, no trial yet
    h.session.actor.send({ type: 'NOISE_EXCEEDED' });
    expect(stateOf(h)).toBe('Familiarization');
    expect(h.session.actor.getSnapshot().context.trials).toHaveLength(0);
  });
});
