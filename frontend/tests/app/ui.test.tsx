// @vitest-environment jsdom
/**
 * UI behaviour that the spec makes non-negotiable:
 *   - NO visual cue during tone presentation (§7.3, §7.4): the runner DOM is identical
 *     across ISI / tone / response window / evaluation;
 *   - keyboard-first response (Space, Enter), counted once; Esc → confirm before stopping;
 *   - Bluetooth blocked (§3.3); red flags halt (§7.2); 30 s inter-ear break (§6.6);
 *   - results: band never without confidence + tier; suppressed probability never shown.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiSessionClient } from '../../src/api/ApiSessionClient';
import type { ApiBackedTestSession } from '../../src/api/createApiBackedTestSession';
import type { ClassificationDto, SessionResultsDto } from '../../src/api/types';
import { ResponseButton } from '../../src/app/components/ResponseButton';
import { DeviceScreen } from '../../src/app/screens/DeviceScreen';
import { HaltScreen, IntakeScreen } from '../../src/app/screens/IntakeScreen';
import { ResultsScreen } from '../../src/app/screens/ResultsScreen';
import { BreakScreen, TestRunnerScreen } from '../../src/app/screens/TestRunnerScreen';
import type { ToneStimulusEngine } from '../../src/audio/ToneStimulusEngine';
import { advanceTo, flush, makeHarness, stateOf } from '../session/harness';

afterEach(cleanup);

// ---------------------------------------------------------------- the runner

function mountRunner(onFinished = vi.fn()) {
  const h = makeHarness({ config: { catchTrialRate: 0 } });
  const client = { status: 'online', pendingUploads: 0 } as unknown as ApiSessionClient;
  const run: ApiBackedTestSession = { ...h.session, client, results: new Promise(() => undefined) };
  const view = render(<TestRunnerScreen run={run} onFinished={onFinished} />);
  return { h, view, onFinished };
}

async function step(fn: () => unknown): Promise<void> {
  await act(async () => {
    await fn();
    await flush();
  });
}

describe('TestRunnerScreen — no visual cue of the stimulus (spec §7.3/§7.4)', () => {
  it('renders byte-identical DOM across ISI, tone, response window and the next ISI', async () => {
    const { h, view } = mountRunner();
    await step(() => undefined); // START → Instruction.ready → auto ACKNOWLEDGE
    expect(stateOf(h)).toBe('Familiarization');
    await step(() => fireEvent.click(screen.getByRole('button', { name: 'Start' })));

    const snapshots = new Map<string, string>();
    const take = (): void => {
      snapshots.set(stateOf(h) + ':' + snapshots.size, view.container.innerHTML);
    };
    for (let i = 0; i < 3; i++) {
      const tr = h.session.actor.getSnapshot().context.trial!;
      expect(stateOf(h)).toBe('InterStimulusInterval.waiting');
      take();
      await step(() => advanceTo(h, tr.onsetMs));
      expect(stateOf(h)).toBe('TonePresenting');
      take();
      // A response during the tone must not change the screen either.
      await step(() => h.session.actor.send({ type: 'RESPONSE', timestampMs: tr.onsetMs + 300 }));
      take();
      await step(() => advanceTo(h, tr.offsetMs));
      await step(() => advanceTo(h, h.clock.now() + 1));
      take();
    }
    const distinct = new Set(snapshots.values());
    expect(distinct.size).toBe(1);
    expect(view.container.querySelector('[class*="playing"], [aria-busy="true"]')).toBeNull();
  });

  it('Esc asks for confirmation; confirming stops the test (partial data kept)', async () => {
    const { h, onFinished } = mountRunner();
    await step(() => undefined);
    await step(() => fireEvent.click(screen.getByRole('button', { name: 'Start' })));
    await step(() => fireEvent.keyDown(window, { key: 'Escape' }));
    expect(screen.getByRole('heading', { name: 'Stop the test?' })).toBeTruthy();
    expect(h.session.actor.getSnapshot().status).toBe('active'); // nothing stopped yet
    await step(() => fireEvent.click(screen.getByRole('button', { name: 'Stop the test' })));
    expect(h.session.actor.getSnapshot().value).toBe('Aborted');
    expect(onFinished).toHaveBeenCalledWith(expect.objectContaining({ status: 'aborted', abortReason: 'user' }));
  });
});

// ---------------------------------------------------------------- response control

describe('ResponseButton (spec §7.4)', () => {
  it('Space and Enter respond once each with the event timestamp; repeats and typing are ignored', () => {
    const onResponse = vi.fn();
    render(
      <>
        <ResponseButton onResponse={onResponse} />
        <textarea aria-label="notes" />
      </>,
    );
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: ' ', code: 'Space', repeat: true });
    fireEvent.keyDown(screen.getByLabelText('notes'), { key: 'Enter' });
    expect(onResponse).toHaveBeenCalledTimes(2);
    expect(onResponse.mock.calls.every(([t, src]) => typeof t === 'number' && src === 'keyboard')).toBe(true);
  });

  it('pointer down responds; the synthetic click does not count again', () => {
    const onResponse = vi.fn();
    render(<ResponseButton onResponse={onResponse} />);
    const b = screen.getByRole('button', { name: 'I heard it' });
    fireEvent.pointerDown(b, { button: 0, pointerType: 'mouse' });
    fireEvent.click(b);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]![1]).toBe('pointer');
  });

  it('keyboard binding can be disabled (dialog open)', () => {
    const onResponse = vi.fn();
    render(<ResponseButton onResponse={onResponse} keyboardEnabled={false} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onResponse).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- setup screens

describe('setup screens', () => {
  it('intake cannot be submitted until every question is answered; a red flag is reported', async () => {
    const onSubmit = vi.fn();
    render(<IntakeScreen onSubmit={onSubmit} />);
    const submit = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const user = userEvent.setup();
    for (const group of screen.getAllByRole('group')) {
      const radios = group.querySelectorAll('input[type="radio"]');
      await user.click(radios[group.textContent?.includes('dizziness') ? 0 : 1]!); // "Yes" for vertigo only
    }
    expect(submit.disabled).toBe(false);
    await user.click(submit);
    const answers = onSubmit.mock.calls[0]![0];
    expect(answers.redFlags.vertigo).toBe(true);
    render(<HaltScreen redFlags={['vertigo']} />);
    expect(screen.getByRole('alert').textContent).toMatch(/will not run/);
  });

  it('blocks Bluetooth output even when the user ticks "wired"', async () => {
    const engine = {} as ToneStimulusEngine;
    const inspect = async () => ({ labels: ['AirPods Pro'], bluetoothLabels: ['AirPods Pro'], labelsAvailable: true });
    render(<DeviceScreen engine={engine} onConfirmed={vi.fn()} inspect={inspect} />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/Over-ear/));
    for (const box of screen.getAllByRole('checkbox')) await user.click(box);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('wired output with both attestations proceeds to the channel check', async () => {
    const engine = {} as ToneStimulusEngine;
    const inspect = async () => ({ labels: ['Headphones (Realtek(R) Audio)'], bluetoothLabels: [], labelsAvailable: true });
    render(<DeviceScreen engine={engine} onConfirmed={vi.fn()} inspect={inspect} />);
    const user = userEvent.setup();
    const cont = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    await user.click(screen.getByLabelText(/Over-ear/));
    expect(cont.disabled).toBe(true);
    for (const box of screen.getAllByRole('checkbox')) await user.click(box);
    expect(cont.disabled).toBe(false);
    await user.click(cont);
    expect(screen.getByRole('heading', { name: 'Left or right?' })).toBeTruthy();
  });

  it('the inter-ear break keeps Continue disabled for 30 s (spec §6.6)', () => {
    vi.useFakeTimers();
    let now = 0;
    const onContinue = vi.fn();
    render(<BreakScreen untilMs={30_000} ear="left ear" onContinue={onContinue} now={() => now} />);
    const btn = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText('You can continue in 30 s.')).toBeTruthy();
    now = 29_500;
    act(() => void vi.advanceTimersByTime(500));
    expect(btn.disabled).toBe(true);
    now = 30_000;
    act(() => void vi.advanceTimersByTime(500));
    expect(btn.disabled).toBe(false);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------- results

function results(c: Partial<ClassificationDto>): SessionResultsDto {
  const classification: ClassificationDto = {
    model_version: 'aurohear-classification-0.1.0',
    calibration_tier: 'C',
    pta4_right: 30, pta4_left: 35, pta4_better: 30, better_ear: 'right',
    who_grade_better_ear: 'mild', who_grade_is_lower_bound: false,
    bsa_descriptor_right: 'mild', bsa_descriptor_left: 'mild',
    sigma_pta_db: 7.6, p_hearing_loss: 0.93, band: 'high', qc_composite: 'good', confidence: 'high',
    overrides_applied: [], annotations: [], referral: 'audiologist',
    statement: 'Higher likelihood of hearing loss. This is a screening result — it is not a diagnosis.',
    caveats: ['This is a screening result, not a diagnosis.', 'Bone conduction was not tested.'],
    ...c,
  };
  return {
    session: { id: 's', participant_id: 'p', protocol_version: 'v', status: 'complete', abort_reason: null, started_at: '', completed_at: null },
    protocol_complete: true,
    thresholds: [
      { ear: 'right', frequency_hz: 1000, test_role: 'initial', search_index: 0, status: 'measured', threshold_db_hl: 30, provisional_db_hl: null, floor_limited: false, is_accepted: true, possible_shadow: false },
    ],
    audiogram: [],
    quality_metrics: { tone_trials: 1, catch_trials: 0, catch_false_alarms: 0, false_positive_rate: null, discarded_trials: 0, mean_latency_ms: null, unstable_1k: false, protocol_complete: true },
    classification,
  };
}

describe('ResultsScreen', () => {
  it('shows the band with its confidence and tier, the statement, referral, caveats and audiogram', () => {
    render(<ResultsScreen results={results({})} theme="light" client={null} />);
    expect(screen.getByTestId('band').textContent).toContain('Higher likelihood of hearing loss');
    expect(screen.getByText(/confidence:/).textContent).toMatch(/high.*tier C/s);
    expect(screen.getByTestId('statement').textContent).toContain('not a diagnosis');
    expect(screen.getByTestId('referral').textContent).toMatch(/audiologist/);
    expect(screen.getByTestId('caveats').querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByText('93%')).toBeTruthy();
    expect(screen.getByRole('img', { name: /audiogram/i })).toBeTruthy();
  });

  it('never shows a suppressed probability, and labels indeterminate results', () => {
    render(
      <ResultsScreen
        results={results({ band: 'indeterminate', p_hearing_loss: null, referral: 'retest_required', overrides_applied: [{ code: 'qc_poor', reason: 'Indeterminate — retest required: test did not finish.' }] })}
        theme="dark"
        client={null}
      />,
    );
    expect(screen.getByTestId('band').textContent).toContain('Indeterminate — retest required');
    expect(screen.queryByText(/Probability above/)).toBeNull();
    expect(screen.getByText(/test did not finish/)).toBeTruthy();
  });

  it('under a red flag shows no band at all', () => {
    render(<ResultsScreen results={results({ band: null, p_hearing_loss: null, referral: 'urgent_ent' })} theme="light" client={null} />);
    expect(screen.queryByTestId('band')).toBeNull();
    expect(screen.getByTestId('referral').textContent).toMatch(/urgently/);
  });

  it('the clinician view adds uncertainty overlays to the audiogram', async () => {
    const { container } = render(<ResultsScreen results={results({})} theme="light" client={null} />);
    expect(container.querySelector('[data-error-bar]')).toBeNull();
    await userEvent.setup().click(screen.getByLabelText(/Clinician view/));
    expect(container.querySelector('[data-error-bar]')).not.toBeNull();
  });
});
