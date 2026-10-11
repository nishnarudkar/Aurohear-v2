/**
 * Creates a running session actor plus an append-only transition log.
 *
 * Spec §7.2: "Every transition must be logged." The log records each change of state
 * value with its time on the session clock, so a clinician can reconstruct the run.
 */

import { type Actor, type ActorOptions, createActor } from 'xstate';

import { type SessionInput, testSessionMachine } from './testSessionMachine';
import type { TransitionRecord } from './types';

export interface TestSession {
  readonly actor: Actor<typeof testSessionMachine>;
  readonly transitions: readonly TransitionRecord[];
}

/** Flatten an XState state value ({ Evaluation: 'routing' }) to 'Evaluation.routing'. */
export function stateToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}.${stateToString(v)}`)
      .join(',');
  }
  return String(value);
}

export function createTestSession(
  input: SessionInput,
  options: { clock?: ActorOptions<typeof testSessionMachine>['clock'] } = {},
): TestSession {
  const transitions: TransitionRecord[] = [];
  let last: string | null = null;
  const record = (value: unknown): void => {
    const state = stateToString(value);
    if (state !== last) {
      transitions.push({ atMs: input.deps.now(), state });
      last = state;
    }
  };
  const actor = createActor(testSessionMachine, {
    input,
    ...(options.clock ? { clock: options.clock } : {}),
    // Microsteps include pass-through states (e.g. Evaluation.routing) that a plain
    // subscription never sees, so the log contains every transition actually taken.
    inspect: (ev) => {
      if (ev.type === '@xstate.microstep' && ev.actorRef === actor) {
        record((ev.snapshot as unknown as { value: unknown }).value);
      }
    },
  });
  actor.start();
  if (transitions.length === 0) record(actor.getSnapshot().value);
  return { actor, transitions };
}
