/** AuroHearApiClient methods + the machine wired to the API through an outage. */

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { SimulatedClock } from 'xstate';

import { ApiError, ApiSessionClient, AuroHearApiClient, createApiBackedTestSession } from '../../src/api';
import type { SessionCreateDto, TrialCreateDto } from '../../src/api/types';
import { mulberry32 } from '../../src/audio/timing';
import type { Ear } from '../../src/session';
import { FakeStimulus, type Harness, type Listener, runSession, ScriptedProcedure } from '../session/harness';
import { FakeServer, SESSION_ID } from './fakeServer';

const SESSION: SessionCreateDto = {
  participant_id: randomUUID(),
  consent_version: '2026-03-01',
  mode: 'threshold',
  supervision: 'unsupervised',
  device: { connection: 'wired' },
  calibration: { tier: 'B', method: 'model_profile', profile_version: 'test-0' },
};

function api(server: FakeServer) {
  return new AuroHearApiClient({ baseUrl: 'http://api.test', fetch: server.fetch, sleep: async () => undefined });
}

describe('AuroHearApiClient', () => {
  it('createSession / getSession / submitTrial / abortSession / completeSession / getResults / submitFeedback', async () => {
    const server = new FakeServer();
    const c = api(server);
    const state = await c.createSession(SESSION);
    expect(state.session.id).toBe(SESSION_ID);
    expect(state.next_presentation).toMatchObject({ frequency_hz: 1000, level_db_hl: 40, phase: 'familiarisation' });
    expect((await c.getSession(SESSION_ID)).trial_count).toBe(0);
    await c.submitFeedback(SESSION_ID, { text: 'Clear tones.' });
    await c.getResults(SESSION_ID);
    await c.abortSession(SESSION_ID, 'user');
    await c.completeSession(SESSION_ID);
    expect(server.calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'POST /api/v1/sessions',
      `GET /api/v1/sessions/${SESSION_ID}`,
      `POST /api/v1/sessions/${SESSION_ID}/feedback`,
      `GET /api/v1/sessions/${SESSION_ID}/results`,
      `POST /api/v1/sessions/${SESSION_ID}/abort`,
      `POST /api/v1/sessions/${SESSION_ID}/finalize`,
    ]);
    expect(server.calls[4]!.body).toEqual({ reason: 'user' });
  });

  it('retries submitTrial with the identical body (same trial_id); the server stores it once', async () => {
    const server = new FakeServer();
    const c = api(server);
    const s = await c.createSession(SESSION);
    const p = s.next_presentation!;
    const trial: TrialCreateDto = {
      trial_id: randomUUID(), seq: 0, ear: p.ear, frequency_hz: p.frequency_hz, level_db_hl: p.level_db_hl,
      presented_level_db_hl: p.level_db_hl, level_clamped: false, phase: p.phase, test_role: p.test_role,
      is_catch_trial: false, scheduled_at_ms: 0, presented_at_ms: 2000, offset_at_ms: 3200, audio_context_onset_s: 2,
      duration_ms: 1200, isi_ms: 2000, responded: true, response_at_ms: 2400, response_latency_ms: 400,
      extra_responses: 0, ambient_dba_at_trial: null, discarded: false, discard_reason: null,
    };
    server.faults.push({ match: '/trials', fault: { kind: 'network' } }, { match: '/trials', fault: { kind: 'status', status: 503 } });
    const accepted = await c.submitTrial(SESSION_ID, trial);
    expect(accepted.trial.id).toBe(trial.trial_id);
    const bodies = server.calls.filter((x) => x.path.endsWith('/trials')).map((x) => x.body);
    expect(bodies).toEqual([trial, trial, trial]);
    expect(server.trials).toHaveLength(1);
    const again = await c.submitTrial(SESSION_ID, trial); // a late duplicate
    expect(again.idempotent_replay).toBe(true);
    expect(server.trials).toHaveLength(1);
  });

  it('does not retry non-idempotent calls; does retry completeSession', async () => {
    const server = new FakeServer();
    const c = api(server);
    server.faults.push({ match: '/sessions', fault: { kind: 'status', status: 503 } });
    await expect(c.createSession(SESSION)).rejects.toBeInstanceOf(ApiError);
    await c.createSession(SESSION);
    server.faults.push({ match: '/feedback', fault: { kind: 'status', status: 503 } });
    await expect(c.submitFeedback(SESSION_ID, { text: 'Clear tones.' })).rejects.toMatchObject({ status: 503 });
    server.faults.push({ match: '/abort', fault: { kind: 'status', status: 503 } });
    await expect(c.abortSession(SESSION_ID, 'user')).rejects.toMatchObject({ status: 503 });
    server.faults.push({ match: '/finalize', fault: { kind: 'status', status: 503 } });
    await expect(c.completeSession(SESSION_ID)).resolves.toBeDefined();
    expect(server.calls.filter((x) => x.path.endsWith('/finalize'))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- machine ↔ API through an outage

const TRUTH: Record<Ear, Record<number, number>> = {
  right: { 250: 10, 500: 15, 750: 15, 1000: 20, 1500: 30, 2000: 40, 3000: 45, 4000: 60, 6000: 75, 8000: 85 },
  left: { 250: 0, 500: 5, 750: 5, 1000: 5, 1500: 5, 2000: 10, 3000: 20, 4000: 35, 6000: 50, 8000: 70 },
};

describe('createApiBackedTestSession', () => {
  it('the test keeps running through an outage; everything drains in order afterwards', async () => {
    const server = new FakeServer();
    const client = new ApiSessionClient({
      baseUrl: 'http://api.test',
      fetch: server.fetch,
      session: SESSION,
      drainBackoff: { baseDelayMs: 1, maxDelayMs: 4 },
    });
    const clock = new SimulatedClock();
    clock.set(10_000);
    const now = (): number => clock.now();
    const stimulus = new FakeStimulus(now, 3);
    const session = createApiBackedTestSession({
      client,
      deps: { stimulus, now, random: mulberry32(5) },
      config: { catchTrialRate: 0.15 },
      clock,
    });
    const h: Harness = { clock, session, stimulus, procedure: new ScriptedProcedure([]) };

    let maxPending = 0;
    const listener: Listener = (t) => {
      if (t.seq === 40) server.offline = true; // the network drops mid-test…
      maxPending = Math.max(maxPending, client.pendingUploads);
      if (t.isCatchTrial) return t.seq % 4 === 0 ? t.onsetMs + 500 : null;
      return t.presentation.levelDbHl >= TRUTH[t.presentation.ear][t.presentation.frequencyHz]! ? t.onsetMs + 350 : null;
    };
    const out = await runSession(h, listener);

    // …and stays down until the very end: the whole second half ran without the server.
    expect(out.status).toBe('complete');
    expect(server.trials.length).toBeLessThan(out.trials.length);
    expect(maxPending).toBeGreaterThan(50);
    expect(client.status).toBe('offline');

    server.offline = false;
    client.retryNow();
    const results = await session.results;
    expect(results.protocol_complete).toBe(true);
    expect(server.trials.map((t) => t.trial_id)).toEqual(out.trials.map((t) => t.trialId));
    expect(server.trials.some((t) => t.is_catch_trial)).toBe(true);
    expect(server.trials.some((t) => t.phase === 'qc_probe')).toBe(true);
    expect(server.trials.some((t) => t.frequency_hz === 1500)).toBe(true); // inter-octave inserted locally
    expect(client.pendingUploads).toBe(0);
    expect(client.status).toBe('closed');
  }, 60_000);
});
