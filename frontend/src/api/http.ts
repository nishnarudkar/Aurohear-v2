/**
 * Minimal JSON-over-HTTP transport with per-request timeout and bounded retries.
 *
 * Retries happen ONLY for requests marked idempotent (trial POSTs are, via their
 * client-generated trial_id; finalize is; session creation and feedback are not — a
 * retry there could create a duplicate) and only on transient failures: network
 * errors, timeouts, 408, 429, 502, 503, 504. A 500 is not retried: the backend uses it
 * for trial-log integrity failures, which a retry cannot fix.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 250, maxDelayMs: 4000 };

export interface TransportOptions {
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly retry?: RetryPolicy;
  /** Injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A non-2xx response from the API. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>>,
  ) {
    super(`${status} ${code}: ${message}`);
    this.name = 'ApiError';
  }
}

/** The request never produced a response (offline, DNS, CORS, timeout). */
export class NetworkError extends Error {
  constructor(message: string, readonly attempts: number) {
    super(message);
    this.name = 'NetworkError';
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);

async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  const b = body as { error?: Record<string, unknown>; detail?: unknown } | null;
  if (b?.error && typeof b.error === 'object') {
    const { code, message, ...details } = b.error;
    return new ApiError(res.status, String(code ?? 'error'), String(message ?? res.statusText), details);
  }
  if (b && 'detail' in b) {
    // FastAPI request validation (422)
    return new ApiError(res.status, 'validation_error', 'request failed validation', { detail: b.detail });
  }
  return new ApiError(res.status, 'http_error', res.statusText || 'request failed', {});
}

export class HttpTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly headers: Readonly<Record<string, string>>;

  constructor(opts: TransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.headers = opts.headers ?? {};
  }

  async request<T>(method: 'GET' | 'POST', path: string, body: unknown, opts: { idempotent: boolean }): Promise<T> {
    const attempts = opts.idempotent ? this.retry.maxAttempts : 1;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        await this.sleep(Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 2)));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...this.headers },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
      } catch (e) {
        lastError = e;
        continue; // network failure or timeout
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) return (await res.json()) as T;
      const err = await toApiError(res);
      if (!RETRYABLE_STATUS.has(res.status)) throw err;
      lastError = err;
    }
    if (lastError instanceof ApiError) throw lastError;
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new NetworkError(`${method} ${path} failed after ${attempts} attempt(s): ${reason}`, attempts);
  }
}
