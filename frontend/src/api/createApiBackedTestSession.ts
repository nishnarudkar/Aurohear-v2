/**
 * One-call wiring of a test session to the API: the machine's procedure and trial log
 * go through an ApiSessionClient, and when the machine finishes the session is settled
 * server-side (finalize, or abort + finalize for partial data).
 */

import { type ActorOptions, toPromise } from 'xstate';

import { createTestSession, type TestSession } from '../session/createTestSession';
import type { SessionInput, testSessionMachine } from '../session/testSessionMachine';
import type { SessionDeps } from '../session/types';
import type { ApiSessionClient } from './ApiSessionClient';
import { settleSession } from './ApiSessionClient';
import type { SessionResultsDto } from './types';

export interface ApiBackedTestSessionOptions {
  readonly client: ApiSessionClient;
  /** Everything except the API-provided ports. `createId` defaults to crypto.randomUUID. */
  readonly deps: Omit<SessionDeps, 'procedure' | 'trialLog' | 'createId'> & { readonly createId?: () => string };
  readonly config?: SessionInput['config'];
  readonly clock?: ActorOptions<typeof testSessionMachine>['clock'];
}

export interface ApiBackedTestSession extends TestSession {
  readonly client: ApiSessionClient;
  /** Server results once the machine has finished and the session is settled. */
  readonly results: Promise<SessionResultsDto>;
}

export function createApiBackedTestSession(opts: ApiBackedTestSessionOptions): ApiBackedTestSession {
  const { client } = opts;
  const deps: SessionDeps = {
    ...opts.deps,
    procedure: client.procedure,
    trialLog: client.trialLog,
    createId: opts.deps.createId ?? (() => globalThis.crypto.randomUUID()),
  };
  const session = createTestSession(
    { deps, ...(opts.config ? { config: opts.config } : {}) },
    opts.clock ? { clock: opts.clock } : {},
  );
  const results = toPromise(session.actor).then((out) => settleSession(client, out));
  results.catch(() => undefined); // observed by callers who await it; never an unhandled rejection
  return { ...session, client, results };
}
