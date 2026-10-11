import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ApiContractError,
  ApiError,
  ApiSessionClient,
  type ApiSessionClientOptions,
  NetworkError,
  settleSession,
} from '../../src/api';
import type { SessionCreateDto } from '../../src/api/types';
import type { TrialRecord } from '../../src/session';
import { sampleRecord } from './fixtures';
import { FakeServer, P, SESSION_ID } from './fakeServer';

const SESSION: SessionCreateDto = {
  participant_id: randomUUID(),
  consent_version: '2026-03-01',
  mode: 'threshold',
  supervision: 'unsupervised',
  device: { connection: 'wired' },
  calibration: { tier: 'B', method: 'model_profile', profile_version: 'test-0' },
};

function setup(script = [P(40, 'familiarisation'), P(30), P(20), P(25, 'ascent')], o: Partial<ApiSessionClientOptions> = {}) {
  const server = new FakeServer(script);
  const sleeps: number[] = [];
  const client = new ApiSessionClient({
    baseUrl: 'http://api.test/',
    fetch: server.fetch,
    session: SESSION,
    sleep: async (ms) => void sleeps.push(ms),
    ...o,
  });
  return { server, client, sleeps };
}

let seqCounter = 0;
function rec(o: Partial<TrialRecord> = {}): TrialRecord {
  return { ...sampleRecord, trialId: randomUUID(), seq: seqCounter++, ...o };
}
const tone = (seq: number, responded = true, o: Partial<TrialRecord> = {}): TrialRecord =>
  rec({
    seq,
    responded,
    responseTimestampMs: responded ? 12_420 : null,
    responseLatencyMs: responded ? 420 : null,
    responseInWindow: responded,
    ...o,
  });
const catchTrial = (seq: number, responded = false): TrialRecord =>
  tone(seq, responded, { isCatchTrial: true, phase: 'catch', requestedLevelDbHl: null, presentedLevelDbHl: null, audioContextOnsetS: null });

describe('session start', () => {
  it('POSTs the session body once and returns the mapped first presentation', async () => {
    const { server, client } = setup();
    const first = await client.procedure.start();
    expect(first).toEqual({ ear: 'right', frequencyHz: 1000, levelDbHl: 40, phase: 'familiarisation', testRole: 'initial' });
    expect(server.calls).toEqual([{ method: 'POST', path: '/api/v1/sessions', body: SESSION }]);
    expect(client.sessionId).toBe(SESSION_ID);
    await expect(client.procedure.start()).rejects.toThrow(/single-use/);
  });

  it('does not retry session creation (a retry could create a duplicate session)', async () => {
    const { server, client } = setup();
    server.faults.push({ match: '/sessions', fault: { kind: 'status', status: 503 } });
    await expect(client.procedure.start()).rejects.toBeInstanceOf(ApiError);
    expect(server.calls).toHaveLength(1);
    expect(client.status).toBe('broken');
  });
});

describe('trial upload queue', () => {
  it('uploads catch and tone trials in seq order, one request at a time, and returns the next tone', async () => {
    const { server, client } = setup();
    server.latencyMs = 5;
    await client.procedure.start();
    client.trialLog(tone(0));
    const n1 = client.procedure.respond(true);
    client.trialLog(catchTrial(1, true));
    client.trialLog(tone(2, false, { discarded: true, discardReason: 'visibility_hidden' }));
    client.trialLog(tone(3, false));
    const n3 = client.procedure.respond(false);
    expect(await n1).toMatchObject({ levelDbHl: 30 });
    expect(await n3).toMatchObject({ levelDbHl: 20 });
    await client.flush();
    expect(server.trials.map((t) => t.seq)).toEqual([0, 1, 2, 3]);
    expect(server.trials.map((t) => [t.is_catch_trial, t.discarded])).toEqual([[false, false], [true, false], [false, true], [false, false]]);
    expect(server.maxInFlight).toBe(1);
  });

  it('retries transient failures with the same trial_id and exponential backoff', async () => {
    const { server, client, sleeps } = setup();
    await client.procedure.start();
    server.faults.push(
      { match: '/trials', fault: { kind: 'status', status: 503 } },
      { match: '/trials', fault: { kind: 'network' } },
      { match: '/trials', fault: { kind: 'status', status: 429 } },
    );
    const t = tone(0);
    client.trialLog(t);
    await expect(client.procedure.respond(true)).resolves.toMatchObject({ levelDbHl: 30 });
    const posts = server.calls.filter((c) => c.path.endsWith('/trials'));
    expect(posts).toHaveLength(4);
    expect(new Set(posts.map((c) => (c.body as { trial_id: string }).trial_id))).toEqual(new Set([t.trialId]));
    expect(sleeps).toEqual([250, 500, 1000]);
  });

  it('gives up after maxAttempts with a NetworkError, and the queue stays broken', async () => {
    const { server, client } = setup(undefined, { retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 } });
    await client.procedure.start();
    server.faults.push({ match: '/trials', fault: { kind: 'network' } }, { match: '/trials', fault: { kind: 'network' } });
    client.trialLog(tone(0));
    await expect(client.procedure.respond(true)).rejects.toBeInstanceOf(NetworkError);
    client.trialLog(tone(1));
    await expect(client.procedure.respond(true)).rejects.toBeInstanceOf(NetworkError);
    expect(client.status).toBe('broken');
    expect(server.trials).toHaveLength(0); // seq 1 was never sent past the gap
  });

  it('times out a hung request and retries it', async () => {
    const { server, client } = setup(undefined, { timeoutMs: 5 });
    await client.procedure.start();
    server.faults.push({ match: '/trials', fault: { kind: 'hang' } });
    client.trialLog(tone(0));
    await expect(client.procedure.respond(true)).resolves.toMatchObject({ levelDbHl: 30 });
    expect(server.calls.filter((c) => c.path.endsWith('/trials'))).toHaveLength(2);
  });

  it('a 409 is not retried; it surfaces with its details and breaks the queue', async () => {
    const { server, client } = setup();
    await client.procedure.start();
    server.faults.push({
      match: '/trials',
      fault: { kind: 'status', status: 409, body: { error: { code: 'conflict', message: 'mismatch', expected: { level_db_hl: 40 } } } },
    });
    client.trialLog(tone(0));
    const err = await client.procedure.respond(true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'conflict', details: { expected: { level_db_hl: 40 } } });
    expect(server.calls.filter((c) => c.path.endsWith('/trials'))).toHaveLength(1);
    await expect(client.flush()).rejects.toBe(err);
  });

  it('a failed log-only (catch) upload breaks the queue for the next tone', async () => {
    const { server, client } = setup();
    await client.procedure.start();
    server.faults.push({ match: '/trials', fault: { kind: 'status', status: 500 } });
    client.trialLog(catchTrial(0, true));
    client.trialLog(tone(1));
    await expect(client.procedure.respond(true)).rejects.toMatchObject({ status: 500 });
    expect(server.calls.filter((c) => c.path.endsWith('/trials'))).toHaveLength(1); // 500 not retried
  });

  it('parses FastAPI 422 validation errors', async () => {
    const { server, client } = setup();
    await client.procedure.start();
    server.faults.push({ match: '/trials', fault: { kind: 'status', status: 422, body: { detail: [{ loc: ['body', 'seq'], msg: 'bad' }] } } });
    client.trialLog(tone(0));
    await expect(client.procedure.respond(true)).rejects.toMatchObject({ status: 422, code: 'validation_error', details: { detail: [{ msg: 'bad' }] } });
  });
});

describe('integrity checks on both sides of the wire', () => {
  it('rejects a non-UUID trial id before sending anything', async () => {
    const { server, client } = setup();
    await client.procedure.start();
    client.trialLog(tone(0, true, { trialId: 't1' }));
    await expect(client.procedure.respond(true)).rejects.toBeInstanceOf(ApiContractError);
    expect(server.calls.filter((c) => c.path.endsWith('/trials'))).toHaveLength(0);
  });

  it('detects a gap in the client trial log', async () => {
    const { client } = setup();
    await client.procedure.start();
    client.trialLog(tone(0));
    client.trialLog(tone(2));
    await expect(client.flush()).rejects.toThrow(/trial log gap/);
  });

  it('respond() must match the logged tone trial', async () => {
    const { client } = setup();
    await client.procedure.start();
    await expect(client.procedure.respond(true)).rejects.toThrow(/no logged tone trial/);
    client.trialLog(catchTrial(0, true));
    await expect(client.procedure.respond(true)).rejects.toThrow(/no logged tone trial/); // catches don't count
    client.trialLog(tone(1, false));
    await expect(client.procedure.respond(true)).rejects.toThrow(/disagrees/);
  });

  it('rejects a malformed next presentation from the server', async () => {
    const { client } = setup([P(40), P(42)]);
    await client.procedure.start();
    client.trialLog(tone(0));
    await expect(client.procedure.respond(true)).rejects.toThrow(/off the −10…90 dB HL lattice/);
  });

  it('rejects a server that advances the staircase on a catch trial', async () => {
    const { server, client } = setup();
    server.overrideAccepted = (_b, a) => ({ ...a, advanced_protocol: true });
    await client.procedure.start();
    client.trialLog(catchTrial(0));
    await expect(client.flush()).rejects.toThrow(/advanced_protocol=true for a catch trial/);
  });
});

describe('session end', () => {
  it('finalize waits for queued uploads, then posts finalize', async () => {
    const { server, client } = setup([P(40), P(30)]);
    server.latencyMs = 3;
    await client.procedure.start();
    client.trialLog(tone(0));
    client.trialLog(catchTrial(1));
    client.trialLog(tone(2, false));
    const res = await client.finalize();
    expect(server.calls.map((c) => c.path.split('/').pop())).toEqual(['sessions', 'trials', 'trials', 'trials', 'finalize']);
    expect(res.session.status).toBe('complete');
    expect(client.status).toBe('closed');
  });

  it('settleSession: aborted runs record the abort, then finalize partial results', async () => {
    const { server, client } = setup();
    await client.procedure.start();
    client.trialLog(tone(0));
    const res = await settleSession(client, { status: 'aborted', abortReason: 'device_change' });
    const tail = server.calls.slice(-2);
    expect(tail.map((c) => c.path.split('/').pop())).toEqual(['abort', 'finalize']);
    expect(tail[0]!.body).toEqual({ reason: 'device_change' });
    expect(res.session.status).toBe('aborted');
  });

  it('abort tolerates a lost response (409 on retry, session already aborted)', async () => {
    const { server, client } = setup();
    await client.procedure.start();
    server.status = 'aborted'; // as if the first abort landed but its response was lost
    await expect(client.abort('user')).resolves.toMatchObject({ session: { status: 'aborted' } });
  });

  it('abort is still recorded when the upload queue is broken', async () => {
    const { server, client } = setup();
    await client.procedure.start();
    server.faults.push({ match: '/trials', fault: { kind: 'status', status: 409 } });
    client.trialLog(tone(0));
    await client.procedure.respond(true).catch(() => undefined);
    await expect(client.abort('procedure_error')).resolves.toMatchObject({ session: { status: 'aborted' } });
  });

  it('submits feedback for the session', async () => {
    const { server, client } = setup();
    await client.procedure.start();
    await client.submitFeedback({ text: 'Tones were clear.', ratings: { clarity: 5 } });
    expect(server.calls.at(-1)).toMatchObject({ method: 'POST', path: `/api/v1/sessions/${SESSION_ID}/feedback` });
  });
});
