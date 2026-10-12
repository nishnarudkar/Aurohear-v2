/**
 * End-to-end: the real session FSM, driven by a synthetic listener, talks through the
 * ApiSessionClient to the real FastAPI backend (real Alembic-migrated SQLite database,
 * real Hughson–Westlake engine). Every trial record the FSM produces must pass the
 * server's clinical validators, or the session would abort.
 *
 * Skipped — with the reason printed — when Python or the backend dependencies are not
 * available. Set AUROHEAR_E2E=0 to skip explicitly, AUROHEAR_PYTHON to pick the binary.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiSessionClient, type SessionResultsDto, settleSession } from '../../src/api';
import type { SessionCreateDto } from '../../src/api/types';
import type { Ear } from '../../src/session';
import { advanceTo, flush, type Listener, makeHarness, runSession, stateOf } from '../session/harness';

const BACKEND = resolve(fileURLToPath(new URL('../../../backend', import.meta.url)));
const PYTHON = process.env.AUROHEAR_PYTHON ?? 'python';

function backendUnavailableReason(): string | null {
  if (process.env.AUROHEAR_E2E === '0') return 'AUROHEAR_E2E=0';
  const r = spawnSync(PYTHON, ['-c', 'import fastapi, sqlalchemy, alembic, uvicorn'], { cwd: BACKEND });
  if (r.error) return `${PYTHON} not found`;
  if (r.status !== 0) return 'backend Python dependencies are not installed';
  return null;
}

const skipReason = backendUnavailableReason();
if (skipReason) console.warn(`[e2e] skipping backend end-to-end tests: ${skipReason}`);

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? res(addr.port) : rej(new Error('no port'))));
    });
  });

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Right ear: |1000 − 2000| = 20 dB → the server inserts 1500 Hz (spec §6.4).
const AUDIOGRAM: Record<Ear, Record<number, number>> = {
  right: { 250: 10, 500: 15, 750: 15, 1000: 20, 1500: 30, 2000: 40, 3000: 45, 4000: 60, 6000: 75, 8000: 85 },
  left: { 250: 0, 500: 5, 750: 5, 1000: 5, 1500: 5, 2000: 10, 3000: 20, 4000: 35, 6000: 50, 8000: 70 },
};
const OCTAVES = [250, 500, 1000, 2000, 3000, 4000, 6000, 8000] as const;

const SESSION: SessionCreateDto = {
  participant_id: randomUUID(),
  consent_version: '2026-03-01',
  mode: 'threshold',
  supervision: 'unsupervised',
  client_time_origin_ms: Date.now(),
  device: { connection: 'wired', transducer_type: 'circumaural', headphone_profile_id: 'synthetic-test-profile' },
  calibration: { tier: 'B', method: 'model_profile', profile_version: 'test-0' },
};

describe.skipIf(skipReason !== null)('frontend FSM <-> API <-> engine (real backend)', () => {
  let proc: ChildProcess | null = null;
  let baseUrl = '';
  let dir = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aurohear-e2e-'));
    const dbPath = join(dir, 'e2e.sqlite3').replace(/\\/g, '/');
    const env = { ...process.env, AUROHEAR_DATABASE_URL: `sqlite:///${dbPath}` };
    const mig = spawnSync(PYTHON, ['-m', 'alembic', 'upgrade', 'head'], { cwd: BACKEND, env, encoding: 'utf-8' });
    if (mig.status !== 0) throw new Error(`alembic upgrade failed:\n${mig.stderr}`);
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    proc = spawn(
      PYTHON,
      [
        '-m', 'uvicorn', 'aurohear.api.app:create_app', '--factory', '--app-dir', 'src',
        '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning',
      ],
      { cwd: BACKEND, env, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr += String(d)));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        if ((await fetch(`${baseUrl}/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline || proc.exitCode !== null) throw new Error(`backend did not start:\n${stderr}`);
      await sleepReal(200);
    }
  }, 60_000);

  afterAll(async () => {
    proc?.kill();
    await sleepReal(300); // let the process release the SQLite file (Windows)
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const listener: Listener = (t) => {
    if (t.isCatchTrial) return t.seq % 3 === 0 ? t.onsetMs + 500 : null; // some false alarms
    const truth = AUDIOGRAM[t.presentation.ear][t.presentation.frequencyHz]!;
    return t.presentation.levelDbHl >= truth ? t.onsetMs + 350 : null;
  };

  function wire(catchTrialRate: number) {
    const client = new ApiSessionClient({ baseUrl, session: { ...SESSION, participant_id: randomUUID() } });
    const h = makeHarness({
      config: { catchTrialRate },
      procedureImpl: client.procedure,
      trialLog: client.trialLog,
      createId: randomUUID,
    });
    return { client, h };
  }

  async function serverTrials(sessionId: string | null): Promise<unknown[]> {
    return (await (await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/trials`)).json()) as unknown[];
  }

  it('full two-ear session: server-computed audiogram equals the true thresholds', async () => {
    const { client, h } = wire(0.15);
    const out = await runSession(h, listener);
    expect(out.status, out.errorMessage ?? '').toBe('complete');
    const res: SessionResultsDto = await settleSession(client, out);

    expect(res.session.status).toBe('complete');
    expect(res.protocol_complete).toBe(true);
    const got: Record<string, Record<number, number | null>> = { right: {}, left: {} };
    for (const t of res.audiogram) got[t.ear]![t.frequency_hz] = t.threshold_db_hl;
    for (const ear of ['right', 'left'] as const) {
      for (const f of OCTAVES) expect(got[ear]![f], `${ear} ${f} Hz`).toBe(AUDIOGRAM[ear][f]);
    }
    // Inter-octave inserted by the server, tested and flagged; not in the other ear.
    expect(got.right![1500]).toBe(30);
    expect(res.audiogram.find((t) => t.ear === 'right' && t.frequency_hz === 1500)?.['is_interoctave']).toBe(true);
    expect(got.left![1500]).toBeUndefined();
    // QC probes ran after every search and all passed (QUALIND #7).
    expect(out.trials.some((t) => t.phase === 'qc_probe')).toBe(true);
    expect(res.quality_metrics['qc_probe_fail_rate']).toBe(0);
    // Server QC agrees with the client's own trial log.
    const q = res.quality_metrics;
    expect(q.catch_trials).toBeGreaterThan(0);
    expect(q.catch_trials).toBe(out.qc.catchTrials);
    expect(q.catch_false_alarms).toBe(out.qc.catchFalseAlarms);
    expect(q.tone_trials).toBe(out.qc.toneTrials);
    expect(await serverTrials(client.sessionId)).toHaveLength(out.trials.length);
  }, 120_000);

  it('aborted session: partial data and the discarded tone are kept server-side', async () => {
    const { client, h } = wire(0);
    const actor = h.session.actor;
    actor.send({ type: 'START' });
    while (stateOf(h) === 'Instruction.loading') await sleepReal(2);
    actor.send({ type: 'ACKNOWLEDGE' });
    actor.send({ type: 'CONTINUE' });
    // Play some trials (all heard), then fault mid-tone.
    let played = 0;
    for (;;) {
      const ctx = actor.getSnapshot().context;
      const s = stateOf(h);
      if (s === 'TonePresenting' && ctx.trial) {
        if (played === 8) break;
        actor.send({ type: 'RESPONSE', timestampMs: ctx.trial.onsetMs + 300 });
        await advanceTo(h, ctx.trial.offsetMs);
        played++;
      } else if (s === 'InterStimulusInterval.waiting' && ctx.trial) {
        await advanceTo(h, ctx.trial.onsetMs);
      } else if (s === 'Familiarization') {
        actor.send({ type: 'CONTINUE' });
      } else if (s === 'Retest1000') {
        await advanceTo(h, h.clock.now());
      } else {
        await sleepReal(2);
        await flush();
      }
    }
    actor.send({ type: 'FAULT', reason: 'device_change' });
    const out = actor.getSnapshot().output!;
    expect(out.status).toBe('aborted');

    const res = await settleSession(client, out);
    expect(res.session.status).toBe('aborted');
    expect(res.session.abort_reason).toBe('device_change');
    expect(res.protocol_complete).toBe(false);
    expect(res.quality_metrics.discarded_trials).toBe(1); // the tone cut off by the fault
    expect(await serverTrials(client.sessionId)).toHaveLength(out.trials.length);
  }, 120_000);
});
