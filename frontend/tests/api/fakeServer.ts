/**
 * In-memory stand-in for the API, exposed as a `fetch` implementation. It runs the real
 * (TypeScript) protocol engine and enforces the server's rules: gapless seq, idempotent
 * trial_id, every trial must match the pending presentation (409 otherwise), catch and
 * discarded trials never advance. Tests can inject faults, latency and outages.
 */

import type { FetchLike } from '../../src/api';
import type { PresentationDto, SessionCreateDto, TrialCreateDto } from '../../src/api/types';
import { AudiometryProtocol, LevelLattice } from '../../src/engine';
import type { Presentation } from '../../src/session';

export type Fault =
  | { readonly kind: 'status'; readonly status: number; readonly body?: unknown }
  | { readonly kind: 'network' }
  | { readonly kind: 'hang' };

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export const SESSION_ID = '5f0c1f6e-8d2a-4b7e-9c3d-2a1b0c9d8e7f';

const toDto = (p: Presentation | null): PresentationDto | null =>
  p && { ear: p.ear, frequency_hz: p.frequencyHz, level_db_hl: p.levelDbHl, phase: p.phase, test_role: p.testRole };

export class FakeServer {
  readonly calls: Call[] = [];
  readonly trials: TrialCreateDto[] = [];
  /** Faults consumed in order by matching requests (path substring). */
  readonly faults: { match: string; fault: Fault }[] = [];
  /** While true every request fails as if the network were down. */
  offline = false;
  latencyMs = 0;
  inFlight = 0;
  maxInFlight = 0;
  status = 'in_progress';
  overrideAccepted?: (body: TrialCreateDto, accepted: Record<string, unknown>) => Record<string, unknown>;
  private engine: AudiometryProtocol | null = null;
  private sessionBody: SessionCreateDto | null = null;

  readonly fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path, body });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
      if (this.offline) throw new TypeError('Failed to fetch');
      const i = this.faults.findIndex((f) => path.includes(f.match));
      if (i >= 0) {
        const { fault } = this.faults.splice(i, 1)[0]!;
        if (fault.kind === 'network') throw new TypeError('Failed to fetch');
        if (fault.kind === 'hang') {
          await new Promise<never>((_, reject) =>
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
          );
        }
        if (fault.kind === 'status') return json(fault.status, fault.body ?? { error: { code: 'x', message: 'injected' } });
      }
      return this.route(method, path, body);
    } finally {
      this.inFlight--;
    }
  };

  /** Presentation the server expects next (for building valid records in tests). */
  expected(): Presentation | null {
    return this.engine?.nextPresentation() ?? null;
  }

  private route(method: string, path: string, body: unknown): Response {
    if (method === 'POST' && path === '/api/v1/sessions') {
      this.sessionBody = body as SessionCreateDto;
      const caps = this.sessionBody.frequency_caps_db_hl ?? {};
      this.engine = new AudiometryProtocol({
        betterEar: this.sessionBody.better_ear ?? null,
        lattice: new LevelLattice(-10, this.sessionBody.profile_cap_db_hl ?? 90),
        frequencyCapsDbHl: Object.fromEntries(Object.entries(caps).map(([f, v]) => [Number(f), v])),
      });
      return json(201, this.state());
    }
    if (method === 'POST' && path === `/api/v1/sessions/${SESSION_ID}/trials`) return this.trial(body as TrialCreateDto);
    if (method === 'POST' && path.endsWith('/finalize')) {
      const complete = this.engine?.isComplete ?? false;
      if (this.status === 'in_progress') this.status = complete ? 'complete' : 'incomplete';
      return json(200, {
        session: this.session(), protocol_complete: complete, thresholds: [], audiogram: [], quality_metrics: {}, classification: {},
      });
    }
    if (method === 'POST' && path.endsWith('/abort')) {
      if (this.status !== 'in_progress') return json(409, { error: { code: 'conflict', message: 'not in progress' } });
      this.status = 'aborted';
      return json(200, this.state());
    }
    if (method === 'GET' && path === `/api/v1/sessions/${SESSION_ID}`) return json(200, this.state());
    if (method === 'GET' && path.endsWith('/results')) {
      return json(200, { session: this.session(), protocol_complete: true, thresholds: [], audiogram: [], quality_metrics: {}, classification: {} });
    }
    if (method === 'POST' && path.endsWith('/feedback')) {
      return json(201, { id: 'fb', session_id: SESSION_ID, submitted_at: '2026-10-12T00:00:00Z' });
    }
    return json(404, { error: { code: 'not_found', message: path } });
  }

  private trial(t: TrialCreateDto): Response {
    const engine = this.engine!;
    const dup = this.trials.find((x) => x.trial_id === t.trial_id);
    if (dup && JSON.stringify(dup) !== JSON.stringify(t)) {
      return json(409, { error: { code: 'conflict', message: 'trial_id already used for a different trial' } });
    }
    if (!dup) {
      if (this.status !== 'in_progress') return json(409, { error: { code: 'conflict', message: 'session closed' } });
      if (t.seq !== this.trials.length) {
        return json(409, { error: { code: 'conflict', message: 'trial seq out of order', expected_seq: this.trials.length } });
      }
      const expected = engine.nextPresentation();
      if (!expected) return json(409, { error: { code: 'conflict', message: 'the protocol is complete' } });
      const mismatches = [
        t.ear !== expected.ear && 'ear',
        t.frequency_hz !== expected.frequencyHz && 'frequency_hz',
        t.test_role !== expected.testRole && 'test_role',
        !t.is_catch_trial && t.level_db_hl !== expected.levelDbHl && 'level_db_hl',
        !t.is_catch_trial && t.phase !== expected.phase && 'phase',
      ].filter(Boolean);
      if (mismatches.length) {
        return json(409, { error: { code: 'conflict', message: 'trial does not match', mismatches, expected: toDto(expected) } });
      }
      this.trials.push(t);
      if (!t.is_catch_trial && !t.discarded) engine.recordResponse(t.responded);
    }
    const accepted = {
      trial: { ...t, id: t.trial_id, session_id: SESSION_ID, received_at: '2026-10-12T00:00:00Z' },
      advanced_protocol: !t.is_catch_trial && !t.discarded,
      idempotent_replay: Boolean(dup),
      next_presentation: toDto(engine.nextPresentation()),
      protocol_complete: engine.isComplete,
    };
    return json(200, this.overrideAccepted ? this.overrideAccepted(t, accepted) : accepted);
  }

  private session() {
    const b = this.sessionBody;
    return {
      id: SESSION_ID,
      participant_id: b?.participant_id ?? 'p',
      protocol_version: 'aurohear-asha2005-ac-0.1.0',
      status: this.status,
      abort_reason: null,
      better_ear: b?.better_ear ?? null,
      profile_cap_db_hl: b?.profile_cap_db_hl ?? 90,
      frequency_caps_db_hl: b?.frequency_caps_db_hl ?? null,
      started_at: '',
      completed_at: null,
    };
  }

  private state() {
    return {
      session: this.session(),
      trial_count: this.trials.length,
      next_presentation: this.status === 'in_progress' ? toDto(this.engine?.nextPresentation() ?? null) : null,
      protocol_complete: this.engine?.isComplete ?? false,
    };
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
