/**
 * App-level flow (spec §7.1 / §7.2 setup states) as an explicit XState v5 machine:
 *
 *   welcome → intake ─(red flag)→ halted
 *                    └→ device → calibration → instructions → testing → settling → results
 *
 * The test itself (familiarisation, trials, catch trials, retest, reinstruction) is the
 * separate testSessionMachine, hosted by the TestRunnerScreen while in `testing`.
 * Non-serialisable runtime objects (AudioContext, engines, API client) live outside this
 * machine, in the App component.
 */

import { assign, setup } from 'xstate';

import type { SessionResultsDto } from '../api/types';
import type { CrossCheck, RunSummary } from '../calibration/biological';
import type { SessionResult } from '../session/testSessionMachine';
import { type IntakeAnswers, positiveRedFlags, type RedFlagId } from './intake';

export interface DeviceSetup {
  readonly transducerType: 'circumaural' | 'supra_aural' | 'insert' | 'other';
  readonly outputLabel: string | null;
  readonly wiredAttested: true;
  readonly channelCheckPassed: true;
}

export interface CalibrationOutcome {
  readonly tier: 'C';
  readonly run: RunSummary;
  readonly crossChecks: readonly CrossCheck[];
  readonly ref1kDbfs: number;
  readonly calibratedAt: string;
}

export interface AppContext {
  readonly intake: IntakeAnswers | null;
  readonly redFlags: readonly RedFlagId[];
  readonly device: DeviceSetup | null;
  readonly calibration: CalibrationOutcome | null;
  readonly testOutput: SessionResult | null;
  readonly results: SessionResultsDto | null;
  readonly error: string | null;
}

export type AppEvent =
  | { readonly type: 'CONSENT_ACCEPTED' }
  | { readonly type: 'INTAKE_SUBMITTED'; readonly answers: IntakeAnswers }
  | { readonly type: 'DEVICE_CONFIRMED'; readonly device: DeviceSetup }
  | { readonly type: 'CALIBRATED'; readonly calibration: CalibrationOutcome }
  | { readonly type: 'BEGIN_TEST' }
  | { readonly type: 'TEST_FINISHED'; readonly output: SessionResult }
  | { readonly type: 'RESULTS_READY'; readonly results: SessionResultsDto }
  | { readonly type: 'RESULTS_FAILED'; readonly error: string }
  | { readonly type: 'RETRY_RESULTS' }
  | { readonly type: 'RESTART' };

const initialContext: AppContext = {
  intake: null,
  redFlags: [],
  device: null,
  calibration: null,
  testOutput: null,
  results: null,
  error: null,
};

export const appFlowMachine = setup({
  types: { context: {} as AppContext, events: {} as AppEvent },
  guards: {
    hasRedFlag: ({ event }) => event.type === 'INTAKE_SUBMITTED' && positiveRedFlags(event.answers).length > 0,
  },
}).createMachine({
  id: 'app',
  initial: 'welcome',
  context: initialContext,
  on: { RESTART: { target: '.welcome', actions: assign(() => initialContext) } },
  states: {
    welcome: { on: { CONSENT_ACCEPTED: 'intake' } },
    intake: {
      on: {
        INTAKE_SUBMITTED: [
          {
            guard: 'hasRedFlag',
            target: 'halted',
            actions: assign(({ event }) => ({ intake: event.answers, redFlags: positiveRedFlags(event.answers) })),
          },
          { target: 'device', actions: assign(({ event }) => ({ intake: event.answers, redFlags: [] })) },
        ],
      },
    },
    /** Spec §7.2 HALT_REFER: the test is not run. */
    halted: { type: 'final' },
    device: { on: { DEVICE_CONFIRMED: { target: 'calibration', actions: assign(({ event }) => ({ device: event.device })) } } },
    calibration: { on: { CALIBRATED: { target: 'instructions', actions: assign(({ event }) => ({ calibration: event.calibration })) } } },
    instructions: { on: { BEGIN_TEST: 'testing' } },
    testing: { on: { TEST_FINISHED: { target: 'settling', actions: assign(({ event }) => ({ testOutput: event.output })) } } },
    settling: {
      on: {
        RESULTS_READY: { target: 'results', actions: assign(({ event }) => ({ results: event.results, error: null })) },
        RESULTS_FAILED: { actions: assign(({ event }) => ({ error: event.error })) },
        RETRY_RESULTS: { actions: assign({ error: null }) },
      },
    },
    results: {},
  },
});
