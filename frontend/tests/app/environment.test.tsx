// @vitest-environment jsdom
/** Environment check (spec §5.2/§5.3) and the runner's hold screens. */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiSessionClient } from '../../src/api/ApiSessionClient';
import type { ApiBackedTestSession } from '../../src/api/createApiBackedTestSession';
import { type BandLevels, THIRD_OCTAVE_BANDS_HZ } from '../../src/audio/noiseBands';
import type { NoiseMonitor } from '../../src/audio/NoiseGate';
import { EnvironmentScreen } from '../../src/app/screens/EnvironmentScreen';
import { TestRunnerScreen } from '../../src/app/screens/TestRunnerScreen';
import { advanceTo, flush, makeHarness, stateOf } from '../session/harness';

afterEach(cleanup);

const flat = (db: number): BandLevels => Object.fromEntries(THIRD_OCTAVE_BANDS_HZ.map((b) => [b, db])) as unknown as BandLevels;

function fakeMonitor(opts: { processingOff?: boolean; frame?: (i: number) => BandLevels } = {}): NoiseMonitor {
  return {
    status: { processingOff: opts.processingOff ?? true, settings: {} },
    frameSpanMs: 170,
    start: (cb: (t: number, b: BandLevels) => void) => {
      const t0 = performance.now();
      for (let i = 0; i <= 160; i++) cb(t0 + i * 100, (opts.frame ?? (() => flat(-95)))(i));
    },
    stop: vi.fn(),
    close: vi.fn(),
  } as unknown as NoiseMonitor;
}

const noBluetooth = async () => ({ labels: ['Headphones'], bluetoothLabels: [], labelsAvailable: true });

async function runCheck(props: Partial<Parameters<typeof EnvironmentScreen>[0]>) {
  const onPassed = vi.fn();
  render(<EnvironmentScreen openMonitor={async () => fakeMonitor()} onPassed={onPassed} inspect={noBluetooth} {...props} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Allow microphone/ }));
  });
  return onPassed;
}

describe('EnvironmentScreen', () => {
  it('a quiet, steady room passes after 15 s and hands over the result and the open microphone', async () => {
    const onPassed = await runCheck({});
    expect(screen.getByRole('status').textContent).toMatch(/quiet enough/);
    expect(screen.getByText(/not calibrated/)).toBeTruthy(); // relative mode is disclosed
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const [result, monitor] = onPassed.mock.calls[0]!;
    expect(result).toMatchObject({ mode: 'relative', pass: true, dba: null });
    expect(monitor.status.processingOff).toBe(true);
  });

  it('an unsteady room fails with advice and offers a recheck', async () => {
    await runCheck({ openMonitor: async () => fakeMonitor({ frame: (i) => (Math.floor(i / 10) % 2 ? { ...flat(-95), 500: -70 } : flat(-95)) }) });
    expect(screen.getByRole('alert').textContent).toMatch(/keeps changing/);
    expect(screen.getByRole('button', { name: /Recheck noise/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  it('blocks without microphone permission (no test unless noise is measured)', async () => {
    const denied = async () => {
      throw new DOMException('denied', 'NotAllowedError');
    };
    await runCheck({ openMonitor: denied });
    expect(screen.getByRole('alert').textContent).toMatch(/Microphone access was refused/);
  });

  it('blocks when the browser keeps AGC / noise suppression on (spec §4.1)', async () => {
    await runCheck({ openMonitor: async () => fakeMonitor({ processingOff: false }) });
    expect(screen.getByRole('alert').textContent).toMatch(/noise suppression|auto gain/);
  });

  it('blocks a Bluetooth output revealed once device labels are readable (spec §3.3)', async () => {
    await runCheck({ inspect: async () => ({ labels: ['AirPods Pro'], bluetoothLabels: ['AirPods Pro'], labelsAvailable: true }) });
    expect(screen.getByRole('alert').textContent).toMatch(/wireless audio device/);
  });
});

describe('runner hold screens', () => {
  function mount() {
    const h = makeHarness({ config: { catchTrialRate: 0 } });
    const run: ApiBackedTestSession = {
      ...h.session,
      client: { status: 'online', pendingUploads: 0 } as unknown as ApiSessionClient,
      results: new Promise(() => undefined),
    };
    render(<TestRunnerScreen run={run} onFinished={vi.fn()} />);
    return h;
  }

  it('shows "Too noisy — waiting" in NoisyWait and "Test paused" when backgrounded — never the response button', async () => {
    const h = mount();
    await act(async () => void (await flush()));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Start' })));
    const tr = h.session.actor.getSnapshot().context.trial!;
    await act(async () => void (await advanceTo(h, tr.onsetMs)));
    await act(async () => void h.session.actor.send({ type: 'NOISE_EXCEEDED' }));
    expect(stateOf(h)).toBe('NoisyWait');
    expect(screen.getByRole('heading', { name: 'Too noisy — waiting' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'I heard it' })).toBeNull();
    await act(async () => {
      h.session.actor.send({ type: 'NOISE_CLEARED' });
      await flush();
    });
    expect(screen.getByRole('button', { name: 'I heard it' })).toBeTruthy();
    await act(async () => void h.session.actor.send({ type: 'PAGE_HIDDEN' }));
    expect(screen.getByRole('heading', { name: 'Test paused' })).toBeTruthy();
  });
});
