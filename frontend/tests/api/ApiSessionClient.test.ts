/** Local-first ApiSessionClient: tone loop never waits, ordered durable drain, integrity checks. */

import { randomUUID } from 'node:crypto';

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import {
  ApiContractError,
  ApiError,
  type ApiClientStatusInfo,
  ApiSessionClient,
  type ApiSessionClientOptions,
  AuroHearApiClient,
  EngineDivergenceError,
  IndexedDbOutboxStore,
  MemoryOutboxStore,
  resumePersistedUploads,
  settleSession,
} from '../../src/api';
import type { SessionCreateDto } from '../../src/api/types';
import type { Presentation, TrialRecord } from '../../src/session';
import { FakeServer, SESSION_ID } from './fakeServer';
import { sampleRecord } from './fixtures';

const SESSION: SessionCreateDto = {
  participant_id: randomUUID(),
  consent_version: '2026-03-01',
  mode: 'threshold',
  supervision: 'unsupervised',
  device: { connection: 'wired' },
  calibration: { tier: 'B', method: 'model_profile', profile_version: 'test-0' },
};

function setup(o: Partial<ApiSessionClientOptions> = {}) {
  const server = new FakeServer();
  const statuses: ApiClientStatusInfo[] = [];
  const client = new ApiSessionClient({
    baseUrl: 'http://api.test/',
    fetch: server.fetch,
    session: SESSION,
    sleep: async () => undefined,
    drainBackoff: { baseDelayMs: 1, maxDelayMs: 2 },
    onStatusChange: (s) => statuses.push(s),
    ...o,
  });
  return { server, client, statuses };
}

/** A machine-shaped record for presentation `p` (tone unless overridden). */
function record(p: Presentation, seq: number, responded: boolean, o: Partial<TrialRecord> = {}): TrialRecord {
  return {
    ...sampleRecord,
    trialId: randomUUID(),
    seq,
    ear: p.ear,
    frequencyHz: p.frequencyHz,
    requestedLevelDbHl: p.levelDbHl,
    presentedLevelDbHl: p.levelDbHl,
    phase: p.phase,
    testRole: p.testRole,
    responded,
    responseTimestampMs: responded ? 12_420 : null,
    responseLatencyMs: responded ? 420 : null,
    responseInWindow: responded,
    ...o,
  };
}
const asCatch = (p: Presentation, seq: number, responded = false): TrialRecord =>
  record(p, seq, responded, { isCatchTrial: true, phase: 'catch', requestedLevelDbHl: null, presentedLevelDbHl: null, audioContextOnsetS: null });

/** Play `n` tone trials the way the machine does: log, then respond. */
async function play(client: ApiSessionClient, first: Presentation, n: number, heard = (_p: Presentation) => true) {
  let p: Presentation | null = first;
  const records: TrialRecord[] = [];
  for (let seq = 0; seq < n && p; seq++) {
    const r = record(p, seq, heard(p));
    records.push(r);
    client.trialLog(r);
    p = await client.procedure.respond(r.responded);
  }
  return { records, next: p };
}

describe('session start', () => {
  it('creates the session once and returns the browser engine’s first tone (== server’s)', async () => {
    const { server, client } = setup();
    const first = await client.procedure.start();
    expect(first).toEqual({ ear: 'right', frequencyHz: 1000, levelDbHl: 40, phase: 'familiarisation', testRole: 'initial' });
    expect(server.calls).toEqual([{ method: 'POST', path: '/api/v1/sessions', body: SESSION }]);
    expect(client.sessionId).toBe(SESSION_ID);
    await expect(client.procedure.start()).rejects.toThrow(/single-use/);
  });

  it('honours the session’s ear order and per-frequency caps', async () => {
    const { client } = setup({ session: { ...SESSION, better_ear: 'left', frequency_caps_db_hl: { '1000': 35 } } });
    expect(await client.procedure.start()).toMatchObject({ ear: 'left', levelDbHl: 35 });
  });

  it('does not retry session creation (a retry could duplicate the session)', async () => {
    const { server, client } = setup();
    server.faults.push({ match: '/sessions', fault: { kind: 'status', status: 503 } });
    await expect(client.procedure.start()).rejects.toBeInstanceOf(ApiError);
    expect(server.calls).toHaveLength(1);
    expect(client.status).toBe('broken');
  });
});

describe('the tone loop never waits for the network', () => {
  it('respond() returns before the upload has even completed', async () => {
    const { server, client } = setup();
    const first = (await client.procedure.start())!;
    server.latencyMs = 50;
    const r = record(first, 0, true);
    client.trialLog(r);
    const next = await client.procedure.respond(true);
    expect(next).toEqual({ ...first, levelDbHl: 40 }); // second familiarisation tone, locally computed
    expect(server.trials).toHaveLength(0); // upload still in flight
    await client.flush();
    expect(server.trials).toHaveLength(1);
  });

  it('keeps testing through an outage, then drains everything in order with the same trial_ids', async () => {
    const { server, client, statuses } = setup();
    const first = (await client.procedure.start())!;
    server.offline = true;
    const { records } = await play(client, first, 12, (p) => p.levelDbHl >= 20);
    expect(records).toHaveLength(12); // 12 tones presented with the network down
    expect(server.trials).toHaveLength(0);
    expect(client.pendingUploads).toBe(12);
    expect(client.status).toBe('offline');

    server.offline = false;
    client.retryNow();
    await client.flush();
    expect(server.trials.map((t) => t.seq)).toEqual(records.map((r) => r.seq));
    expect(server.trials.map((t) => t.trial_id)).toEqual(records.map((r) => r.trialId));
    const posted = server.calls.filter((c) => c.path.endsWith('/trials')).map((c) => (c.body as { trial_id: string }).trial_id);
    expect(posted.length).toBeGreaterThan(12); // retried during the outage…
    expect(new Set(posted)).toEqual(new Set(records.map((r) => r.trialId))); // …never with a new id
    expect(client.pendingUploads).toBe(0);
    expect(client.status).toBe('online');
    expect(statuses.map((s) => s.status)).toEqual(expect.arrayContaining(['offline', 'online']));
  });

  it('uploads one request at a time, in seq order, including catch and discarded trials', async () => {
    const { server, client } = setup();
    const p0 = (await client.procedure.start())!;
    server.latencyMs = 3;
    client.trialLog(asCatch(p0, 0, true));
    client.trialLog(record(p0, 1, false, { discarded: true, discardReason: 'visibility_hidden' }));
    client.trialLog(record(p0, 2, true));
    await client.procedure.respond(true);
    await client.flush();
    expect(server.trials.map((t) => [t.seq, t.is_catch_trial, t.discarded])).toEqual([[0, true, false], [1, false, true], [2, false, false]]);
    expect(server.maxInFlight).toBe(1);
  });
});

describe('durable outbox', () => {
  it('holds each trial until the server acknowledges it', async () => {
    const outbox = new MemoryOutboxStore();
    const { server, client } = setup({ outbox });
    const first = (await client.procedure.start())!;
    server.offline = true;
    await play(client, first, 3);
    await new Promise((r) => setTimeout(r, 5));
    expect((await outbox.list(SESSION_ID)).map((e) => e.trial.seq)).toEqual([0, 1, 2]);
    server.offline = false;
    client.retryNow();
    await client.flush();
    expect(await outbox.list()).toEqual([]);
  });

  it('IndexedDB outbox survives the page: a later load uploads what was left behind', async () => {
    const idb = new IDBFactory();
    const outbox = new IndexedDbOutboxStore(idb, 'aurohear-test');
    const { server, client } = setup({ outbox });
    const first = (await client.procedure.start())!;
    server.offline = true;
    await play(client, first, 5);
    await new Promise((r) => setTimeout(r, 100));
    outbox.close(); // "tab closed" while offline — the client is gone

    server.offline = false;
    const reopened = new IndexedDbOutboxStore(idb, 'aurohear-test');
    expect((await reopened.list()).map((e) => e.trial.seq)).toEqual([0, 1, 2, 3, 4]);
    const api = new AuroHearApiClient({ baseUrl: 'http://api.test', fetch: server.fetch, sleep: async () => undefined });
    const res = await resumePersistedUploads(reopened, api);
    expect(res).toEqual({ uploaded: 5, failed: [] });
    expect(server.trials.map((t) => t.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(await reopened.list()).toEqual([]);
  });
});

describe('integrity: stop rather than continue on a wrong path', () => {
  it('a server that disagrees with the browser engine raises EngineDivergenceError', async () => {
    const { server, client } = setup();
    const first = (await client.procedure.start())!;
    server.overrideAccepted = (_b, a) => ({ ...a, next_presentation: { ...(a['next_presentation'] as object), level_db_hl: 60 } });
    client.trialLog(record(first, 0, true));
    await client.procedure.respond(true); // returns immediately (local)
    await expect(client.flush()).rejects.toBeInstanceOf(EngineDivergenceError);
    client.trialLog(record(first, 1, true));
    await expect(client.procedure.respond(true)).rejects.toBeInstanceOf(EngineDivergenceError);
    expect(client.status).toBe('broken');
  });

  it('a logged trial that is not the tone the engine asked for is rejected locally', async () => {
    const { server, client } = setup();
    const first = (await client.procedure.start())!;
    client.trialLog(record({ ...first, levelDbHl: 70 }, 0, true));
    await expect(client.procedure.respond(true)).rejects.toBeInstanceOf(EngineDivergenceError);
    expect(server.trials).toHaveLength(0);
  });

  it('a permanent API error (409) stops the client; the trial stays in the outbox', async () => {
    const outbox = new MemoryOutboxStore();
    const { server, client } = setup({ outbox });
    const first = (await client.procedure.start())!;
    server.faults.push({ match: '/trials', fault: { kind: 'status', status: 409, body: { error: { code: 'conflict', message: 'no' } } } });
    const r = record(first, 0, true);
    client.trialLog(r);
    await client.procedure.respond(true);
    await expect(client.flush()).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect((await outbox.list()).map((e) => e.trial.trial_id)).toEqual([r.trialId]);
    client.trialLog(record(first, 1, true));
    await expect(client.procedure.respond(true)).rejects.toBeInstanceOf(ApiError);
  });

  it('transient statuses (503, 429) are retried, not fatal', async () => {
    const { server, client } = setup();
    const first = (await client.procedure.start())!;
    server.faults.push(
      { match: '/trials', fault: { kind: 'status', status: 503 } },
      { match: '/trials', fault: { kind: 'status', status: 429 } },
      { match: '/trials', fault: { kind: 'network' } },
    );
    client.trialLog(record(first, 0, true));
    await client.procedure.respond(true);
    await client.flush();
    expect(server.trials).toHaveLength(1);
  });

  it('rejects non-UUID ids and gaps in the trial log', async () => {
    const a = setup();
    const p = (await a.client.procedure.start())!;
    a.client.trialLog(record(p, 0, true, { trialId: 't1' }));
    await expect(a.client.flush()).rejects.toBeInstanceOf(ApiContractError);
    const b = setup();
    const q = (await b.client.procedure.start())!;
    b.client.trialLog(record(q, 1, true));
    await expect(b.client.flush()).rejects.toThrow(/trial log gap/);
  });

  it('respond() must match the logged tone trial', async () => {
    const { client } = setup();
    const p = (await client.procedure.start())!;
    await expect(client.procedure.respond(true)).rejects.toThrow(/no logged tone trial/);
    client.trialLog(record(p, 0, false));
    await expect(client.procedure.respond(true)).rejects.toThrow(/disagrees/);
  });
});

describe('session end', () => {
  it('finalize waits out an outage until every trial is stored', async () => {
    const { server, client } = setup();
    const first = (await client.procedure.start())!;
    server.offline = true;
    await play(client, first, 4);
    const finalizing = client.finalize();
    await new Promise((r) => setTimeout(r, 10));
    expect(server.calls.some((c) => c.path.endsWith('/finalize'))).toBe(false);
    server.offline = false;
    client.retryNow();
    const res = await finalizing;
    const order = server.calls.filter((c) => !c.path.endsWith('/sessions')).map((c) => c.path.split('/').pop());
    expect(order.lastIndexOf('trials')).toBeLessThan(order.indexOf('finalize'));
    expect(server.trials).toHaveLength(4);
    expect(res.session.status).toBe('incomplete');
    expect(client.status).toBe('closed');
  });

  it('settleSession on an aborted run records the abort, then finalizes partial data', async () => {
    const { server, client } = setup();
    const first = (await client.procedure.start())!;
    await play(client, first, 3);
    const res = await settleSession(client, { status: 'aborted', abortReason: 'device_change' });
    const tail = server.calls.slice(-2);
    expect(tail.map((c) => c.path.split('/').pop())).toEqual(['abort', 'finalize']);
    expect(tail[0]!.body).toEqual({ reason: 'device_change' });
    expect(res.session.status).toBe('aborted');
  });

  it('abort tolerates a lost response, and is still recorded when the client is stopped', async () => {
    const a = setup();
    await a.client.procedure.start();
    a.server.status = 'aborted';
    await expect(a.client.abort('user')).resolves.toMatchObject({ session: { status: 'aborted' } });

    const b = setup();
    const p = (await b.client.procedure.start())!;
    b.server.faults.push({ match: '/trials', fault: { kind: 'status', status: 409 } });
    b.client.trialLog(record(p, 0, true));
    await b.client.flush().catch(() => undefined);
    await expect(b.client.abort('procedure_error')).resolves.toMatchObject({ session: { status: 'aborted' } });
  });
});
