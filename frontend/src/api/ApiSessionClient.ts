/**
 * ApiSessionClient — connects the test-session FSM to the AuroHear v2 API.
 *
 * It plugs into the machine's two ports:
 *   procedure.start()      → POST /sessions                (first presentation)
 *   trialLog(record)       → POST /sessions/{id}/trials     (every trial, in seq order)
 *   procedure.respond()    → awaits the upload of the tone trial just logged and
 *                            returns the server's next presentation
 *
 * The server replays the trial log through the Hughson–Westlake engine, so it — not
 * the browser — decides every next tone and computes every threshold.
 *
 * Ordering & integrity: uploads run strictly one at a time, in the order the machine
 * logs them, because the server requires a gapless seq. If an upload fails for good,
 * the log is "broken": every later operation rejects with that same error rather than
 * skipping a seq. The machine then aborts with `procedure_error`, and `abort()` still
 * records the abort server-side so the partial session is kept.
 */

import type { AbortReason, Presentation, ThresholdProcedure, TrialRecord } from '../session/types';
import { HttpTransport, type TransportOptions } from './http';
import { advancesProtocol, ApiContractError, checkTrialAccepted, fromPresentation, toTrialCreate } from './mapping';
import type {
  AbortReasonDto,
  FeedbackCreateDto,
  FeedbackDto,
  SessionCreateDto,
  SessionResultsDto,
  SessionStateDto,
  TrialAcceptedDto,
} from './types';

export type ApiClientStatus = 'idle' | 'active' | 'broken' | 'closed';

export interface ApiSessionClientOptions extends TransportOptions {
  /** Session metadata sent when the machine starts (device, calibration, consent…). */
  readonly session: SessionCreateDto;
  readonly apiPrefix?: string;
}

const noop = (): void => {};

export class ApiSessionClient {
  readonly procedure: ThresholdProcedure;
  /** Pass as `SessionDeps.trialLog`. */
  readonly trialLog: (trial: TrialRecord) => void;

  private readonly http: HttpTransport;
  private readonly prefix: string;
  private readonly sessionBody: SessionCreateDto;
  private id: string | null = null;
  private state: ApiClientStatus = 'idle';
  private failure: unknown = null;
  private tail: Promise<void> = Promise.resolve();
  private readonly uploads = new Map<string, Promise<TrialAcceptedDto>>();
  private readonly awaitingRespond: TrialRecord[] = [];
  private lastSeq = -1;

  constructor(opts: ApiSessionClientOptions) {
    this.http = new HttpTransport(opts);
    this.prefix = opts.apiPrefix ?? '/api/v1';
    this.sessionBody = opts.session;
    this.procedure = {
      start: () => this.start(),
      respond: (heard) => this.respond(heard),
    };
    this.trialLog = (t) => this.enqueue(t);
  }

  get sessionId(): string | null {
    return this.id;
  }

  get status(): ApiClientStatus {
    return this.state;
  }

  /** The error that broke the upload queue, if any. */
  get error(): unknown {
    return this.failure;
  }

  // ------------------------------------------------------------------ procedure port

  private async start(): Promise<Presentation | null> {
    if (this.state !== 'idle') throw new Error('ApiSessionClient is single-use: start() was already called');
    this.state = 'active';
    try {
      // Not idempotent: a retry could create a second session, so no automatic retry.
      const res = await this.http.request<SessionStateDto>('POST', `${this.prefix}/sessions`, this.sessionBody, {
        idempotent: false,
      });
      if (typeof res?.session?.id !== 'string') throw new ApiContractError('session response has no id');
      this.id = res.session.id;
      return fromPresentation(res.next_presentation);
    } catch (e) {
      this.breakWith(e);
      throw e;
    }
  }

  private async respond(heard: boolean): Promise<Presentation | null> {
    const record = this.awaitingRespond.shift();
    if (!record) {
      throw new Error('respond() called with no logged tone trial — wire SessionDeps.trialLog to this client');
    }
    if (record.responded !== heard) {
      throw new Error(`respond(${heard}) disagrees with logged trial seq=${record.seq} (responded=${record.responded})`);
    }
    const accepted = await this.uploads.get(record.trialId)!;
    return fromPresentation(accepted.next_presentation);
  }

  // ------------------------------------------------------------------ trial log

  private enqueue(record: TrialRecord): void {
    if (record.seq !== this.lastSeq + 1) {
      this.breakWith(new ApiContractError(`trial log gap: got seq ${record.seq} after ${this.lastSeq}`));
    }
    this.lastSeq = record.seq;
    const upload = this.tail.then(() => this.upload(record));
    this.tail = upload.then(noop, (e: unknown) => this.breakWith(e));
    upload.catch(noop); // log-only uploads have no awaiter; errors surface via the queue
    this.uploads.set(record.trialId, upload);
    if (advancesProtocol(record)) this.awaitingRespond.push(record);
  }

  private async upload(record: TrialRecord): Promise<TrialAcceptedDto> {
    if (this.failure) throw this.failure;
    if (!this.id) throw new Error('trial logged before the session was created');
    const body = toTrialCreate(record);
    const res = await this.http.request<unknown>('POST', `${this.prefix}/sessions/${this.id}/trials`, body, {
      idempotent: true, // the server dedupes on trial_id
    });
    return checkTrialAccepted(record, res);
  }

  private breakWith(e: unknown): void {
    if (this.failure === null) {
      this.failure = e;
      this.state = 'broken';
    }
  }

  /** Resolves when every logged trial is stored; rejects if the log is broken. */
  async flush(): Promise<void> {
    await this.tail;
    if (this.failure) throw this.failure;
  }

  // ------------------------------------------------------------------ session end

  /** Compute server-side thresholds and QC. Waits for all uploads first. */
  async finalize(): Promise<SessionResultsDto> {
    await this.tail;
    const id = this.requireId();
    const res = await this.http.request<SessionResultsDto>('POST', `${this.prefix}/sessions/${id}/finalize`, undefined, {
      idempotent: true,
    });
    this.state = this.failure ? 'broken' : 'closed';
    return res;
  }

  /**
   * Record an abort. Uploads everything that can still be uploaded first (best effort:
   * a broken queue does not prevent the abort itself from being recorded).
   */
  async abort(reason: AbortReasonDto): Promise<SessionStateDto> {
    await this.tail;
    const id = this.requireId();
    try {
      return await this.http.request<SessionStateDto>('POST', `${this.prefix}/sessions/${id}/abort`, { reason }, {
        idempotent: false,
      });
    } catch (e) {
      // A lost response to an abort that did land shows up as 409 on any retry; check.
      const state = await this.http
        .request<SessionStateDto>('GET', `${this.prefix}/sessions/${id}`, undefined, { idempotent: true })
        .catch(() => null);
      if (state?.session.status === 'aborted') return state;
      throw e;
    }
  }

  /** Store the participant's free-text self-report (NLP runs server-side later). */
  async submitFeedback(body: FeedbackCreateDto): Promise<FeedbackDto> {
    const id = this.requireId();
    return this.http.request<FeedbackDto>('POST', `${this.prefix}/sessions/${id}/feedback`, body, { idempotent: false });
  }

  private requireId(): string {
    if (!this.id) throw new Error('no session: the machine never reached procedure.start()');
    return this.id;
  }
}

/** Map a finished machine run onto the API: finalize, or abort then finalize partial data. */
export async function settleSession(
  client: ApiSessionClient,
  outcome: { readonly status: 'complete' | 'aborted'; readonly abortReason: AbortReason | null },
): Promise<SessionResultsDto> {
  if (outcome.status === 'aborted') {
    await client.abort(outcome.abortReason ?? 'user');
  }
  return client.finalize();
}
