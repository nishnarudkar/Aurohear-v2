/**
 * ApiSessionClient — local-first bridge between the test-session FSM and the API.
 *
 * Plugs into the machine's ports:
 *   procedure.start()    → POST /sessions; builds the browser engine from the session
 *   trialLog(record)     → advances the browser engine (tone trials), persists the trial
 *                          to the outbox, and queues it for upload
 *   procedure.respond()  → returns the browser engine's next presentation immediately —
 *                          the tone loop never waits for the network
 *
 * Offline: uploads drain strictly in seq order on a single worker. Transient failures
 * (network down, timeouts, 408/429/502/503/504) are retried indefinitely with capped
 * backoff — and immediately on the browser's `online` event — always with the same
 * trial_id, so the server stores each trial exactly once. The outbox (memory or
 * IndexedDB) keeps every trial until the server has acknowledged it.
 *
 * Integrity: the server still replays every trial through the Python reference engine.
 * Each acknowledgement carries the server's next presentation; if it differs from the
 * browser engine's, the client raises EngineDivergenceError and stops. Permanent
 * errors (409/422/500, contract violations) also stop it. Once stopped, the next
 * respond() rejects, so the machine aborts with `procedure_error`. Conformance between
 * the two engines is tested on golden traces (tests/engine/conformance.test.ts).
 */

import { AudiometryProtocol, LevelLattice } from '../engine';
import type { AbortReason, Presentation, ThresholdProcedure, TrialRecord } from '../session/types';
import { AuroHearApiClient } from './client';
import { ApiError, NetworkError, type TransportOptions } from './http';
import { advancesProtocol, ApiContractError, checkTrialAccepted, fromPresentation, toTrialCreate } from './mapping';
import { MemoryOutboxStore, type OutboxStore } from './outbox';
import type {
  AbortReasonDto,
  FeedbackCreateDto,
  FeedbackDto,
  SessionCreateDto,
  SessionResultsDto,
  SessionStateDto,
  TrialCreateDto,
} from './types';

export type ApiClientStatus = 'idle' | 'online' | 'offline' | 'broken' | 'closed';

export interface ApiClientStatusInfo {
  readonly status: ApiClientStatus;
  readonly pendingUploads: number;
  readonly error: unknown;
}

export interface ApiSessionClientOptions extends TransportOptions {
  /** Session metadata sent when the machine starts (device, calibration, consent…). */
  readonly session: SessionCreateDto;
  readonly apiPrefix?: string;
  /** Where unacknowledged trials live. Default: memory. Use IndexedDbOutboxStore in browsers. */
  readonly outbox?: OutboxStore;
  /** Backoff between drain attempts while offline. */
  readonly drainBackoff?: { readonly baseDelayMs: number; readonly maxDelayMs: number };
  readonly onStatusChange?: (info: ApiClientStatusInfo) => void;
}

/** The server's protocol and the browser engine disagree — never continue past this. */
export class EngineDivergenceError extends Error {
  constructor(
    readonly seq: number,
    readonly local: Presentation | null,
    readonly server: Presentation | null,
  ) {
    super(
      `browser engine diverged from the server after trial seq=${seq}: ` +
        `local ${JSON.stringify(local)} vs server ${JSON.stringify(server)}`,
    );
    this.name = 'EngineDivergenceError';
  }
}

interface Pending {
  readonly record: TrialRecord;
  readonly body: TrialCreateDto;
  readonly expectedNext: Presentation | null;
  readonly persisted: Promise<void>;
}

const TRANSIENT_STATUS = new Set([408, 429, 502, 503, 504]);
const isTransient = (e: unknown): boolean =>
  e instanceof NetworkError || (e instanceof ApiError && TRANSIENT_STATUS.has(e.status));

const samePresentation = (a: Presentation | null, b: Presentation | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.ear === b.ear &&
    a.frequencyHz === b.frequencyHz &&
    a.levelDbHl === b.levelDbHl &&
    a.phase === b.phase &&
    a.testRole === b.testRole);

export class ApiSessionClient {
  readonly procedure: ThresholdProcedure;
  /** Pass as `SessionDeps.trialLog`. */
  readonly trialLog: (trial: TrialRecord) => void;

  private readonly api: AuroHearApiClient;
  /** Single-attempt transport for the drain loop, which owns its own retry policy. */
  private readonly drainApi: AuroHearApiClient;
  private readonly outbox: OutboxStore;
  private readonly sessionBody: SessionCreateDto;
  private readonly backoff: { readonly baseDelayMs: number; readonly maxDelayMs: number };
  private readonly onStatusChange: ((info: ApiClientStatusInfo) => void) | undefined;

  private id: string | null = null;
  private engine: AudiometryProtocol | null = null;
  private state: ApiClientStatus = 'idle';
  private failure: unknown = null;
  private readonly queue: Pending[] = [];
  private readonly nextAfter = new Map<string, Presentation | null>();
  private readonly awaitingRespond: TrialRecord[] = [];
  private lastSeq = -1;
  private draining = false;
  private wake: (() => void) | null = null;
  private idleWaiters: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  private readonly onOnline = (): void => this.wake?.();

  constructor(opts: ApiSessionClientOptions) {
    this.api = new AuroHearApiClient(opts);
    this.drainApi = new AuroHearApiClient({ ...opts, retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } });
    this.outbox = opts.outbox ?? new MemoryOutboxStore();
    this.sessionBody = opts.session;
    this.backoff = opts.drainBackoff ?? { baseDelayMs: 250, maxDelayMs: 5000 };
    this.onStatusChange = opts.onStatusChange;
    this.procedure = { start: () => this.start(), respond: (heard) => this.respond(heard) };
    this.trialLog = (t) => this.enqueue(t);
  }

  get sessionId(): string | null {
    return this.id;
  }

  get status(): ApiClientStatus {
    return this.state;
  }

  get error(): unknown {
    return this.failure;
  }

  /** Trials logged but not yet acknowledged by the server. */
  get pendingUploads(): number {
    return this.queue.length;
  }

  // ------------------------------------------------------------------ procedure port

  private async start(): Promise<Presentation | null> {
    if (this.state !== 'idle') throw new Error('ApiSessionClient is single-use: start() was already called');
    this.setStatus('online');
    try {
      const res = await this.api.createSession(this.sessionBody);
      if (typeof res?.session?.id !== 'string') throw new ApiContractError('session response has no id');
      this.id = res.session.id;
      this.engine = engineFor(res);
      const local = this.engine.nextPresentation();
      const server = fromPresentation(res.next_presentation);
      if (!samePresentation(local, server)) throw new EngineDivergenceError(-1, local, server);
      globalThis.addEventListener?.('online', this.onOnline);
      return local;
    } catch (e) {
      this.breakWith(e);
      throw e;
    }
  }

  private async respond(heard: boolean): Promise<Presentation | null> {
    if (this.failure) throw this.failure; // a stopped client never hands out another tone
    const record = this.awaitingRespond.shift();
    if (!record) throw new Error('respond() called with no logged tone trial — wire SessionDeps.trialLog to this client');
    if (record.responded !== heard) {
      throw new Error(`respond(${heard}) disagrees with logged trial seq=${record.seq} (responded=${record.responded})`);
    }
    return this.nextAfter.get(record.trialId) ?? null;
  }

  // ------------------------------------------------------------------ trial log

  private enqueue(record: TrialRecord): void {
    try {
      if (record.seq !== this.lastSeq + 1) {
        throw new ApiContractError(`trial log gap: got seq ${record.seq} after ${this.lastSeq}`);
      }
      this.lastSeq = record.seq;
      if (!this.engine || !this.id) throw new Error('trial logged before the session was created');
      const body = toTrialCreate(record);
      if (advancesProtocol(record)) {
        const expected = this.engine.nextPresentation();
        const presented: Presentation = {
          ear: record.ear,
          frequencyHz: record.frequencyHz,
          levelDbHl: record.requestedLevelDbHl!,
          phase: record.phase as Presentation['phase'],
          testRole: record.testRole,
        };
        if (!samePresentation(expected, presented)) throw new EngineDivergenceError(record.seq - 1, expected, presented);
        this.engine.recordResponse(record.responded);
        this.awaitingRespond.push(record);
      }
      const expectedNext = this.engine.nextPresentation();
      this.nextAfter.set(record.trialId, expectedNext);
      // Persist first; the outbox entry is removed only after the server acknowledges.
      const persisted = this.outbox.put({ sessionId: this.id, trial: body }).catch(() => undefined);
      this.queue.push({ record, body, expectedNext, persisted });
      void this.drain();
    } catch (e) {
      this.breakWith(e);
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    let attempt = 0;
    try {
      while (this.queue.length > 0 && !this.failure) {
        const head = this.queue[0]!;
        let res: unknown;
        try {
          res = await this.drainApi.submitTrial(this.id!, head.body);
        } catch (e) {
          if (!isTransient(e)) {
            this.breakWith(e);
            break;
          }
          this.setStatus('offline');
          await this.waitBeforeRetry(attempt++);
          continue;
        }
        attempt = 0;
        try {
          const accepted = checkTrialAccepted(head.record, res);
          const server = fromPresentation(accepted.next_presentation);
          if (!samePresentation(server, head.expectedNext)) {
            throw new EngineDivergenceError(head.record.seq, head.expectedNext, server);
          }
        } catch (e) {
          this.breakWith(e);
          break;
        }
        await head.persisted;
        await this.outbox.delete(head.body.trial_id).catch(() => undefined);
        this.queue.shift();
        if (this.state === 'offline') this.setStatus('online');
        else this.notify();
      }
    } finally {
      this.draining = false;
      this.settleWaiters();
    }
  }

  /**
   * Always a real timer (never the injectable transport sleep): every retry must yield to
   * the event loop, or a fetch that fails without a macrotask would spin this loop forever.
   */
  private async waitBeforeRetry(attempt: number): Promise<void> {
    const delay = Math.min(this.backoff.maxDelayMs, this.backoff.baseDelayMs * 2 ** Math.min(attempt, 16));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((r) => (timer = setTimeout(r, Math.max(1, delay)))),
      new Promise<void>((r) => (this.wake = r)),
    ]);
    clearTimeout(timer);
    this.wake = null;
  }

  /** Retry a stalled upload now (e.g. a "retry" button). The `online` event does this too. */
  retryNow(): void {
    this.wake?.();
  }

  private breakWith(e: unknown): void {
    if (this.failure === null) {
      this.failure = e;
      this.setStatus('broken');
    }
    this.settleWaiters();
  }

  private setStatus(s: ApiClientStatus): void {
    this.state = s;
    this.notify();
  }

  private notify(): void {
    this.onStatusChange?.({ status: this.state, pendingUploads: this.queue.length, error: this.failure });
  }

  private settleWaiters(): void {
    if (this.draining) return;
    if (this.failure) {
      for (const w of this.idleWaiters) w.reject(this.failure);
      this.idleWaiters = [];
    } else if (this.queue.length === 0) {
      for (const w of this.idleWaiters) w.resolve();
      this.idleWaiters = [];
    }
  }

  /** Resolves once every logged trial is acknowledged (waiting out any outage); rejects if stopped. */
  flush(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.queue.length === 0 && !this.draining) return Promise.resolve();
    return new Promise((resolve, reject) => this.idleWaiters.push({ resolve, reject }));
  }

  // ------------------------------------------------------------------ session end

  /** Compute server-side thresholds, QC and classification once all trials are stored. */
  async finalize(): Promise<SessionResultsDto> {
    await this.flush().catch(() => undefined); // a stopped log still finalizes what was stored
    const res = await this.api.completeSession(this.requireId());
    this.close(this.failure ? 'broken' : 'closed');
    return res;
  }

  /** Record an abort after uploading what can be uploaded (partial data is kept). */
  async abort(reason: AbortReasonDto): Promise<SessionStateDto> {
    await this.flush().catch(() => undefined);
    const id = this.requireId();
    try {
      return await this.api.abortSession(id, reason);
    } catch (e) {
      // A lost response to an abort that did land shows up as 409 on any retry; check.
      const state = await this.api.getSession(id).catch(() => null);
      if (state?.session.status === 'aborted') return state;
      throw e;
    }
  }

  async submitFeedback(body: FeedbackCreateDto): Promise<FeedbackDto> {
    return this.api.submitFeedback(this.requireId(), body);
  }

  private close(s: ApiClientStatus): void {
    globalThis.removeEventListener?.('online', this.onOnline);
    this.setStatus(s);
  }

  private requireId(): string {
    if (!this.id) throw new Error('no session: the machine never reached procedure.start()');
    return this.id;
  }
}

/** Build the browser engine with exactly the parameters the server pinned for the session. */
function engineFor(res: SessionStateDto): AudiometryProtocol {
  const s = res.session as unknown as {
    better_ear: 'left' | 'right' | null;
    profile_cap_db_hl: number;
    frequency_caps_db_hl: Record<string, number> | null;
    protocol_version: string;
  };
  const caps = new Map(Object.entries(s.frequency_caps_db_hl ?? {}).map(([f, v]) => [Number(f), v]));
  return new AudiometryProtocol({
    betterEar: s.better_ear,
    lattice: new LevelLattice(-10, s.profile_cap_db_hl),
    frequencyCapsDbHl: caps,
  });
}

/** Map a finished machine run onto the API: finalize, or abort then finalize partial data. */
export async function settleSession(
  client: ApiSessionClient,
  outcome: { readonly status: 'complete' | 'aborted'; readonly abortReason: AbortReason | null },
): Promise<SessionResultsDto> {
  if (outcome.status === 'aborted') await client.abort(outcome.abortReason ?? 'user');
  return client.finalize();
}

/**
 * Upload trials a previous page load left in a durable outbox (e.g. the tab closed while
 * offline). Safe to call on every app start: the server dedupes on trial_id.
 */
export async function resumePersistedUploads(
  outbox: OutboxStore,
  api: AuroHearApiClient,
): Promise<{ readonly uploaded: number; readonly failed: { readonly sessionId: string; readonly error: unknown }[] }> {
  let uploaded = 0;
  const failed: { sessionId: string; error: unknown }[] = [];
  const bySession = new Map<string, TrialCreateDto[]>();
  for (const e of await outbox.list()) bySession.set(e.sessionId, [...(bySession.get(e.sessionId) ?? []), e.trial]);
  for (const [sessionId, trials] of bySession) {
    try {
      for (const t of trials) {
        await api.submitTrial(sessionId, t);
        await outbox.delete(t.trial_id);
        uploaded++;
      }
    } catch (error) {
      failed.push({ sessionId, error });
    }
  }
  return { uploaded, failed };
}
