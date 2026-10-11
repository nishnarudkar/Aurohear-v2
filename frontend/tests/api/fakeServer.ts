/**
 * In-memory stand-in for the API, exposed as a `fetch` implementation. It enforces
 * the server's ordering rules (gapless seq, one session) and lets tests inject
 * failures and latency.
 */

import type { FetchLike } from '../../src/api';
import type { PresentationDto, TrialCreateDto } from '../../src/api/types';

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

export class FakeServer {
  readonly calls: Call[] = [];
  readonly trials: TrialCreateDto[] = [];
  /** Faults consumed in order by matching requests (path substring). */
  readonly faults: { match: string; fault: Fault }[] = [];
  latencyMs = 0;
  inFlight = 0;
  maxInFlight = 0;
  status = 'in_progress';
  overrideAccepted?: (body: TrialCreateDto, accepted: Record<string, unknown>) => Record<string, unknown>;
  private index = 0;

  constructor(readonly script: readonly PresentationDto[]) {}

  readonly fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path, body });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
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

  private route(method: string, path: string, body: unknown): Response {
    if (method === 'POST' && path === '/api/v1/sessions') {
      return json(201, this.state(this.script[0] ?? null));
    }
    if (method === 'POST' && path === `/api/v1/sessions/${SESSION_ID}/trials`) {
      const t = body as TrialCreateDto;
      const dup = this.trials.find((x) => x.trial_id === t.trial_id);
      if (!dup && t.seq !== this.trials.length) {
        return json(409, { error: { code: 'conflict', message: 'trial seq out of order', expected_seq: this.trials.length } });
      }
      if (!dup) {
        this.trials.push(t);
        if (!t.is_catch_trial && !t.discarded) this.index++;
      }
      const advanced = !t.is_catch_trial && !t.discarded;
      const accepted = {
        trial: { ...t, id: t.trial_id, session_id: SESSION_ID, received_at: '2026-10-12T00:00:00Z' },
        advanced_protocol: advanced,
        idempotent_replay: Boolean(dup),
        next_presentation: this.script[this.index] ?? null,
        protocol_complete: this.index >= this.script.length,
      };
      return json(200, this.overrideAccepted ? this.overrideAccepted(t, accepted) : accepted);
    }
    if (method === 'POST' && path.endsWith('/finalize')) {
      this.status = this.index >= this.script.length ? 'complete' : this.status === 'aborted' ? 'aborted' : 'incomplete';
      return json(200, { session: this.session(), protocol_complete: this.index >= this.script.length, thresholds: [], audiogram: [], quality_metrics: {} });
    }
    if (method === 'POST' && path.endsWith('/abort')) {
      if (this.status !== 'in_progress') return json(409, { error: { code: 'conflict', message: 'not in progress' } });
      this.status = 'aborted';
      return json(200, this.state(null));
    }
    if (method === 'GET' && path === `/api/v1/sessions/${SESSION_ID}`) return json(200, this.state(null));
    if (method === 'POST' && path.endsWith('/feedback')) return json(201, { id: 'fb', session_id: SESSION_ID, ...(body as object), insights: [] });
    return json(404, { error: { code: 'not_found', message: path } });
  }

  private session() {
    return { id: SESSION_ID, participant_id: 'p', protocol_version: 'v', status: this.status, abort_reason: null, started_at: '', completed_at: null };
  }

  private state(next: PresentationDto | null) {
    return { session: this.session(), trial_count: this.trials.length, next_presentation: next, protocol_complete: false };
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const P = (level: number, phase: PresentationDto['phase'] = 'descent', o: Partial<PresentationDto> = {}): PresentationDto => ({
  ear: 'right',
  frequency_hz: 1000,
  level_db_hl: level,
  phase,
  test_role: 'initial',
  ...o,
});
