/**
 * AuroHearApiClient — thin, stateless, typed client for the v2 REST API.
 *
 * Return types mirror what the backend actually returns (see openapi.json):
 *   createSession  → SessionState   (session + first presentation)
 *   submitTrial    → TrialAccepted  (stored trial + next presentation)
 *   abortSession   → SessionState
 *   completeSession→ SessionResults (POST /finalize: thresholds, QC, classification)
 *   getResults     → SessionResults
 *   submitFeedback → Feedback
 *
 * Idempotency: `submitTrial` and `completeSession` are retried on transient failures
 * (the server dedupes trials by `trial_id`, and finalize is a pure recomputation);
 * `createSession`, `abortSession` and `submitFeedback` are not, as a retry could
 * duplicate them. Session-level orchestration lives in ApiSessionClient.
 */

import { HttpTransport, type TransportOptions } from './http';
import type {
  AbortReasonDto,
  FeedbackCreateDto,
  FeedbackDto,
  SessionCreateDto,
  SessionResultsDto,
  SessionStateDto,
  TrialAcceptedDto,
  TrialCreateDto,
} from './types';

export interface AuroHearApiClientOptions extends TransportOptions {
  readonly apiPrefix?: string;
}

export class AuroHearApiClient {
  private readonly http: HttpTransport;
  private readonly prefix: string;

  constructor(opts: AuroHearApiClientOptions) {
    this.http = new HttpTransport(opts);
    this.prefix = opts.apiPrefix ?? '/api/v1';
  }

  private path(...parts: string[]): string {
    return [this.prefix, 'sessions', ...parts.map(encodeURIComponent)].join('/');
  }

  createSession(data: SessionCreateDto): Promise<SessionStateDto> {
    return this.http.request('POST', this.path(), data, { idempotent: false });
  }

  getSession(sessionId: string): Promise<SessionStateDto> {
    return this.http.request('GET', this.path(sessionId), undefined, { idempotent: true });
  }

  /** Same `trial.trial_id` on every retry: the server stores a trial at most once. */
  submitTrial(sessionId: string, trial: TrialCreateDto): Promise<TrialAcceptedDto> {
    return this.http.request('POST', this.path(sessionId, 'trials'), trial, { idempotent: true });
  }

  abortSession(sessionId: string, reason: AbortReasonDto): Promise<SessionStateDto> {
    return this.http.request('POST', this.path(sessionId, 'abort'), { reason }, { idempotent: false });
  }

  /** Finalize: compute thresholds, QC and classification server-side. */
  completeSession(sessionId: string): Promise<SessionResultsDto> {
    return this.http.request('POST', this.path(sessionId, 'finalize'), undefined, { idempotent: true });
  }

  getResults(sessionId: string): Promise<SessionResultsDto> {
    return this.http.request('GET', this.path(sessionId, 'results'), undefined, { idempotent: true });
  }

  submitFeedback(sessionId: string, feedback: FeedbackCreateDto): Promise<FeedbackDto> {
    return this.http.request('POST', this.path(sessionId, 'feedback'), feedback, { idempotent: false });
  }
}
