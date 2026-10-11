/**
 * Client-side test-session FSM (spec §7.2), XState v5.
 *
 *   Idle ─START→ Instruction ─ACKNOWLEDGE→ ┐
 *                                           ▼
 *            ┌──────────── Evaluation.routing ◄──────────────────────────┐
 *            │  false alarms ≥ 2 → Reinstruct ─CONTINUE→ routing          │
 *            │  procedure done   → Complete                               │
 *            │  new ear          → Familiarization ─CONTINUE→ ISI         │
 *            │  1 kHz retest     → Retest1000 → ISI (or Reinstruct if     │
 *            │                                 the retest was unstable)   │
 *            │  otherwise        → InterStimulusInterval                  │
 *            ▼                                                            │
 *   InterStimulusInterval ─onset→ TonePresenting ─offset→ ResponseWindow ─┤
 *                         └onset→ CatchTrial     ─offset→ ResponseWindow ─┘
 *                                                       (→ Evaluation.scoring)
 *   STOP / FAULT (any state) → Aborted
 *
 * - The Hughson–Westlake decisions are made by the injected ThresholdProcedure (the
 *   backend engine); this machine owns presentation, timing, scoring and logging.
 * - Familiarisation tones run through the same trial loop (phase 'familiarisation');
 *   the Familiarization state is the per-ear gate in front of them, and it enforces
 *   the 30 s inter-ear break (spec §6.6).
 * - Catch trials are silent trials with real randomised timing; they are scored for
 *   the false-positive rate and are never reported to the staircase.
 * - Responses are classified by timestamp (see trialLogic.classifyResponse).
 */

import { assertEvent, assign, fromPromise, setup } from 'xstate';

import {
  type ActiveTrial,
  type ClassifyInput,
  classifyResponse,
  isFalseAlarm,
  isFamiliarisationStart,
  isRetest1kStart,
  type SessionQc,
  searchKey,
  shouldInsertCatchTrial,
  summariseQc,
  toResponseRecord,
  toTrialRecord,
} from './trialLogic';
import {
  type AbortReason,
  DEFAULT_SESSION_CONFIG,
  type Presentation,
  type ReinstructionReason,
  type ResponseRecord,
  type ResponseSource,
  type SessionConfig,
  type SessionDeps,
  type ThresholdProcedure,
  type TrialRecord,
} from './types';

export interface SessionInput {
  readonly deps: SessionDeps;
  readonly config?: Partial<SessionConfig>;
}

export interface SessionContext {
  readonly deps: SessionDeps;
  readonly config: SessionConfig;
  readonly pending: Presentation | null;
  readonly trial: ActiveTrial | null;
  readonly trials: readonly TrialRecord[];
  /** How many of `trials` have been handed to `deps.trialLog`. */
  readonly loggedTrialCount: number;
  readonly responses: readonly ResponseRecord[];
  readonly seq: number;
  readonly previousWasCatch: boolean;
  readonly announcedSearchKey: string | null;
  readonly lastAcceptedPressMs: number | null;
  readonly lastScoredWindowEndMs: number | null;
  readonly falseAlarmsSinceReinstruction: number;
  readonly reinstructions: number;
  readonly reinstructionReason: ReinstructionReason | null;
  readonly earsStarted: number;
  readonly familiarizationEnteredAtMs: number | null;
  readonly startedAtMs: number | null;
  readonly endedAtMs: number | null;
  readonly abortReason: AbortReason | null;
  readonly errorMessage: string | null;
}

export type SessionEvent =
  | { readonly type: 'START' }
  | { readonly type: 'ACKNOWLEDGE' }
  | { readonly type: 'CONTINUE' }
  | { readonly type: 'RESPONSE'; readonly timestampMs: number; readonly source?: ResponseSource }
  | { readonly type: 'DISCARD_TRIAL'; readonly reason: string }
  | { readonly type: 'STOP' }
  | { readonly type: 'FAULT'; readonly reason: AbortReason }
  // Internal: the trial scheduled by the ISI entry action.
  | { readonly type: 'internal.trialScheduled'; readonly trial: ActiveTrial }
  | { readonly type: 'internal.trialScheduleFailed'; readonly message: string };

export interface SessionResult {
  readonly status: 'complete' | 'aborted';
  readonly abortReason: AbortReason | null;
  readonly errorMessage: string | null;
  readonly startedAtMs: number | null;
  readonly endedAtMs: number | null;
  readonly trials: readonly TrialRecord[];
  readonly responses: readonly ResponseRecord[];
  readonly qc: SessionQc;
}

function buildTrial(ctx: SessionContext): ActiveTrial {
  const { deps, config, pending } = ctx;
  if (!pending) throw new Error('no pending presentation to schedule');
  const scheduledAtMs = deps.now();
  const isCatchTrial = shouldInsertCatchTrial(pending, ctx.previousWasCatch, config.catchTrialRate, deps.random);
  const base = {
    trialId: deps.createId(),
    seq: ctx.seq,
    presentation: pending,
    isCatchTrial,
    scheduledAtMs,
    responseTimestampMs: null,
    extraResponses: 0,
  };
  if (isCatchTrial) {
    const { durationMs, isiMs } = deps.stimulus.drawTiming();
    const onsetMs = scheduledAtMs + isiMs;
    const offsetMs = onsetMs + durationMs;
    return {
      ...base,
      durationMs,
      isiMs,
      onsetMs,
      offsetMs,
      windowEndMs: offsetMs + config.responseWindowAfterOffsetMs,
      audioContextOnsetS: null,
      presentedLevelDbHl: null,
      levelClamped: false,
      cancel: () => {},
    };
  }
  const s = deps.stimulus.present(pending);
  return {
    ...base,
    durationMs: s.durationMs,
    isiMs: s.isiMs,
    onsetMs: s.onsetMs,
    offsetMs: s.offsetMs,
    windowEndMs: s.offsetMs + config.responseWindowAfterOffsetMs,
    audioContextOnsetS: s.audioContextOnsetS,
    presentedLevelDbHl: s.presentedLevelDbHl,
    levelClamped: s.levelClamped,
    cancel: () => s.cancel(),
  };
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const testSessionMachine = setup({
  types: {
    context: {} as SessionContext,
    events: {} as SessionEvent,
    input: {} as SessionInput,
    output: {} as SessionResult,
  },
  actors: {
    startProcedure: fromPromise<Presentation | null, { procedure: ThresholdProcedure }>(({ input }) =>
      input.procedure.start(),
    ),
    respondProcedure: fromPromise<Presentation | null, { procedure: ThresholdProcedure; heard: boolean }>(
      ({ input }) => input.procedure.respond(input.heard),
    ),
  },
  delays: {
    untilOnset: ({ context }) => Math.max(0, context.trial!.onsetMs - context.deps.now()),
    untilOffset: ({ context }) => Math.max(0, context.trial!.offsetMs - context.deps.now()),
    untilScoring: ({ context }) =>
      Math.max(0, context.trial!.windowEndMs + context.config.scoringGraceMs - context.deps.now()),
  },
  guards: {
    isCatchTrial: ({ context }) => context.trial?.isCatchTrial === true,
    trialResponded: ({ context }) => context.trial?.responseTimestampMs != null,
    lastTrialWasCatch: ({ context }) => context.trials.at(-1)?.isCatchTrial === true,
    hasPending: ({ context }) => context.pending !== null,
    needsFalseAlarmReinstruction: ({ context }) =>
      context.falseAlarmsSinceReinstruction >= context.config.falseAlarmsBeforeReinstruction,
    isFamiliarisationStart: ({ context }) =>
      context.pending !== null && isFamiliarisationStart(context.pending, context.announcedSearchKey),
    isRetest1kStart: ({ context }) =>
      context.pending !== null && isRetest1kStart(context.pending, context.announcedSearchKey),
    isVerificationRetest: ({ context }) => context.pending?.testRole === 'verification',
    interEarBreakSatisfied: ({ context }) =>
      context.earsStarted <= 1 ||
      context.deps.now() - (context.familiarizationEnteredAtMs ?? 0) >= context.config.interEarBreakMs,
  },
  actions: {
    /**
     * Synchronous on purpose: the tone is handed to the audio engine and the resulting
     * trial is queued to this machine in the same step, so no STOP/DISCARD can slip in
     * between and leave an orphaned tone playing (which an async actor would allow).
     */
    scheduleTrial: ({ context, self }) => {
      try {
        self.send({ type: 'internal.trialScheduled', trial: buildTrial(context) });
      } catch (e) {
        self.send({ type: 'internal.trialScheduleFailed', message: errorMessage(e) });
      }
    },
    recordResponse: assign(({ context, event }, params: { inTrialLoop: boolean }) => {
      assertEvent(event, 'RESPONSE');
      const input: ClassifyInput = {
        timestampMs: event.timestampMs,
        lastAcceptedPressMs: context.lastAcceptedPressMs,
        inTrialLoop: params.inTrialLoop,
        trial: context.trial,
        lastScoredWindowEndMs: context.lastScoredWindowEndMs,
        debounceMs: context.config.debounceMs,
      };
      const c = classifyResponse(input);
      let trial = context.trial;
      if (trial && (c === 'hit' || c === 'catch_false_alarm')) {
        trial = { ...trial, responseTimestampMs: event.timestampMs };
      } else if (trial && c === 'repeat') {
        trial = { ...trial, extraResponses: trial.extraResponses + 1 };
      }
      return {
        trial,
        responses: [...context.responses, toResponseRecord(input, c, event.source ?? 'unknown')],
        lastAcceptedPressMs: c === 'debounced' ? context.lastAcceptedPressMs : event.timestampMs,
        falseAlarmsSinceReinstruction: context.falseAlarmsSinceReinstruction + (isFalseAlarm(c) ? 1 : 0),
      };
    }),
    commitTrial: assign(({ context }) => {
      const tr = context.trial;
      if (!tr) return {};
      return {
        trials: [...context.trials, toTrialRecord(tr)],
        lastScoredWindowEndMs: tr.windowEndMs,
        trial: null,
      };
    }),
    discardTrial: assign(({ context, event }) => {
      const tr = context.trial;
      tr?.cancel();
      const reason = event.type === 'DISCARD_TRIAL' ? event.reason : 'aborted';
      return {
        trials: tr ? [...context.trials, toTrialRecord(tr, { reason })] : context.trials,
        trial: null,
      };
    }),
    /** Hand newly committed trial records to the log sink, in order, exactly once. */
    emitTrialLog: ({ context }) => {
      const sink = context.deps.trialLog;
      if (!sink) return;
      for (const t of context.trials.slice(context.loggedTrialCount)) sink(t);
    },
    markTrialsLogged: assign(({ context }) => ({ loggedTrialCount: context.trials.length })),
    markAborted: assign(({ context, event }) => ({
      abortReason: event.type === 'FAULT' ? event.reason : 'user',
      endedAtMs: context.deps.now(),
    })),
    markEnded: assign(({ context }) => ({ endedAtMs: context.deps.now() })),
  },
}).createMachine({
  id: 'session',
  context: ({ input }) => ({
    deps: input.deps,
    config: { ...DEFAULT_SESSION_CONFIG, ...input.config },
    pending: null,
    trial: null,
    trials: [],
    loggedTrialCount: 0,
    responses: [],
    seq: 0,
    previousWasCatch: false,
    announcedSearchKey: null,
    lastAcceptedPressMs: null,
    lastScoredWindowEndMs: null,
    falseAlarmsSinceReinstruction: 0,
    reinstructions: 0,
    reinstructionReason: null,
    earsStarted: 0,
    familiarizationEnteredAtMs: null,
    startedAtMs: null,
    endedAtMs: null,
    abortReason: null,
    errorMessage: null,
  }),
  initial: 'Idle',
  on: {
    STOP: { target: '.Aborted', actions: ['discardTrial', 'emitTrialLog', 'markTrialsLogged', 'markAborted'] },
    FAULT: { target: '.Aborted', actions: ['discardTrial', 'emitTrialLog', 'markTrialsLogged', 'markAborted'] },
  },
  output: ({ context }) => ({
    status: context.abortReason ? 'aborted' : 'complete',
    abortReason: context.abortReason,
    errorMessage: context.errorMessage,
    startedAtMs: context.startedAtMs,
    endedAtMs: context.endedAtMs,
    trials: context.trials,
    responses: context.responses,
    qc: summariseQc(context.trials, context.responses, context.reinstructions),
  }),
  states: {
    Idle: {
      on: {
        START: {
          target: 'Instruction',
          actions: assign(({ context }) => ({ startedAtMs: context.deps.now() })),
        },
      },
    },

    Instruction: {
      initial: 'loading',
      on: { RESPONSE: { actions: { type: 'recordResponse', params: { inTrialLoop: false } } } },
      states: {
        loading: {
          invoke: {
            src: 'startProcedure',
            input: ({ context }) => ({ procedure: context.deps.procedure }),
            onDone: { target: 'ready', actions: assign({ pending: ({ event }) => event.output }) },
            onError: {
              target: '#session.Aborted',
              actions: assign(({ context, event }) => ({
                abortReason: 'procedure_error' as const,
                errorMessage: errorMessage(event.error),
                endedAtMs: context.deps.now(),
              })),
            },
          },
        },
        ready: {
          on: {
            ACKNOWLEDGE: [
              { guard: 'hasPending', target: '#session.Evaluation.routing' },
              { target: '#session.Complete' },
            ],
          },
        },
      },
    },

    Familiarization: {
      entry: assign(({ context }) => ({
        earsStarted: context.earsStarted + 1,
        familiarizationEnteredAtMs: context.deps.now(),
        announcedSearchKey: context.pending ? searchKey(context.pending) : context.announcedSearchKey,
      })),
      on: {
        RESPONSE: { actions: { type: 'recordResponse', params: { inTrialLoop: false } } },
        CONTINUE: { guard: 'interEarBreakSatisfied', target: 'InterStimulusInterval' },
      },
    },

    InterStimulusInterval: {
      initial: 'scheduling',
      on: {
        RESPONSE: { actions: { type: 'recordResponse', params: { inTrialLoop: true } } },
      },
      states: {
        scheduling: {
          entry: 'scheduleTrial',
          on: {
            'internal.trialScheduled': {
              target: 'waiting',
              actions: assign(({ context, event }) => ({
                trial: event.trial,
                seq: context.seq + 1,
                previousWasCatch: event.trial.isCatchTrial,
              })),
            },
            'internal.trialScheduleFailed': {
              target: '#session.Aborted',
              actions: assign(({ context, event }) => ({
                abortReason: 'stimulus_error' as const,
                errorMessage: event.message,
                endedAtMs: context.deps.now(),
              })),
            },
          },
        },
        waiting: {
          on: {
            DISCARD_TRIAL: { target: '#session.InterStimulusInterval', reenter: true, actions: ['discardTrial', 'emitTrialLog', 'markTrialsLogged'] },
          },
          after: {
            untilOnset: [
              { guard: 'isCatchTrial', target: '#session.CatchTrial' },
              { target: '#session.TonePresenting' },
            ],
          },
        },
      },
    },

    TonePresenting: {
      after: { untilOffset: 'ResponseWindow' },
      on: {
        RESPONSE: { actions: { type: 'recordResponse', params: { inTrialLoop: true } } },
        DISCARD_TRIAL: { target: 'InterStimulusInterval', actions: ['discardTrial', 'emitTrialLog', 'markTrialsLogged'] },
      },
    },

    CatchTrial: {
      after: { untilOffset: 'ResponseWindow' },
      on: {
        RESPONSE: { actions: { type: 'recordResponse', params: { inTrialLoop: true } } },
        DISCARD_TRIAL: { target: 'InterStimulusInterval', actions: ['discardTrial', 'emitTrialLog', 'markTrialsLogged'] },
      },
    },

    ResponseWindow: {
      // A response ends the window early: the window bounds validity, it is not a wait.
      always: { guard: 'trialResponded', target: 'Evaluation' },
      after: { untilScoring: 'Evaluation' },
      on: {
        RESPONSE: { actions: { type: 'recordResponse', params: { inTrialLoop: true } } },
        DISCARD_TRIAL: { target: 'InterStimulusInterval', actions: ['discardTrial', 'emitTrialLog', 'markTrialsLogged'] },
      },
    },

    Evaluation: {
      initial: 'scoring',
      on: { RESPONSE: { actions: { type: 'recordResponse', params: { inTrialLoop: true } } } },
      states: {
        scoring: {
          entry: ['commitTrial', 'emitTrialLog', 'markTrialsLogged'],
          always: [{ guard: 'lastTrialWasCatch', target: 'routing' }, { target: 'updatingStaircase' }],
        },
        updatingStaircase: {
          invoke: {
            src: 'respondProcedure',
            input: ({ context }) => ({
              procedure: context.deps.procedure,
              heard: context.trials.at(-1)?.responded === true,
            }),
            onDone: { target: 'routing', actions: assign({ pending: ({ event }) => event.output }) },
            onError: {
              target: '#session.Aborted',
              actions: assign(({ context, event }) => ({
                abortReason: 'procedure_error' as const,
                errorMessage: errorMessage(event.error),
                endedAtMs: context.deps.now(),
              })),
            },
          },
        },
        routing: {
          always: [
            {
              guard: 'needsFalseAlarmReinstruction',
              target: '#session.Reinstruct',
              actions: assign({ reinstructionReason: 'false_alarms' as const }),
            },
            { guard: 'hasPending', target: 'dispatch' },
            { target: '#session.Complete' },
          ],
        },
        dispatch: {
          always: [
            { guard: 'isFamiliarisationStart', target: '#session.Familiarization' },
            { guard: 'isRetest1kStart', target: '#session.Retest1000' },
            { target: '#session.InterStimulusInterval' },
          ],
        },
      },
    },

    Retest1000: {
      entry: assign(({ context }) => ({
        announcedSearchKey: context.pending ? searchKey(context.pending) : context.announcedSearchKey,
      })),
      on: { RESPONSE: { actions: { type: 'recordResponse', params: { inTrialLoop: true } } } },
      // A macrostep (0 ms) so the state is observable in the transition log.
      after: {
        0: [
          {
            guard: 'isVerificationRetest',
            target: 'Reinstruct',
            actions: assign({ reinstructionReason: 'unstable_retest' as const }),
          },
          { target: 'InterStimulusInterval' },
        ],
      },
    },

    Reinstruct: {
      on: {
        RESPONSE: { actions: { type: 'recordResponse', params: { inTrialLoop: false } } },
        CONTINUE: {
          target: '#session.Evaluation.routing',
          actions: assign(({ context }) => ({
            falseAlarmsSinceReinstruction: 0,
            reinstructions: context.reinstructions + 1,
          })),
        },
      },
    },

    Complete: { type: 'final', entry: 'markEnded' },
    Aborted: { type: 'final' },
  },
});
