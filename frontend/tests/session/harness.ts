/**
 * Deterministic harness for the session FSM: simulated clock, fake audio port,
 * scripted threshold procedure and a synthetic listener driver.
 */

import { SimulatedClock } from 'xstate';

import { DEFAULT_TIMING, drawTrialTiming, mulberry32 } from '../../src/audio/timing';
import {
  type ActiveTrial,
  createTestSession,
  type Presentation,
  type ScheduledStimulus,
  type SessionConfig,
  type SessionResult,
  type StimulusPort,
  type TestSession,
  type ThresholdProcedure,
} from '../../src/session';

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

export class FakeStimulus implements StimulusPort {
  readonly presented: Presentation[] = [];
  readonly cancelled: number[] = [];
  private readonly rng;
  constructor(
    private readonly now: () => number,
    seed = 1,
    private readonly failOn?: (p: Presentation) => boolean,
  ) {
    this.rng = mulberry32(seed);
  }
  drawTiming() {
    return drawTrialTiming(DEFAULT_TIMING, this.rng);
  }
  present(p: Presentation): ScheduledStimulus {
    if (this.failOn?.(p)) throw new Error('AudioContext is suspended');
    const index = this.presented.push(p) - 1;
    const { durationMs, isiMs } = this.drawTiming();
    const onsetMs = this.now() + isiMs;
    return {
      durationMs,
      isiMs,
      onsetMs,
      offsetMs: onsetMs + durationMs,
      audioContextOnsetS: onsetMs / 1000 + 0.5, // arbitrary distinct audio clock
      presentedLevelDbHl: p.levelDbHl,
      levelClamped: false,
      cancel: () => this.cancelled.push(index),
    };
  }
}

const P = (ear: 'left' | 'right', f: number, level: number, phase: Presentation['phase'], testRole: Presentation['testRole'] = 'initial'): Presentation => ({
  ear,
  frequencyHz: f,
  levelDbHl: level,
  phase,
  testRole,
});

/**
 * A short but structurally complete ASHA-shaped script: familiarisation, threshold
 * presentations at several frequencies, the 1 kHz retest, then the second ear.
 * (Staircase decisions themselves are tested in the Python engine.)
 */
export function standardScript(opts: { verification?: boolean } = {}): Presentation[] {
  const ear1: Presentation[] = [
    P('right', 1000, 40, 'familiarisation'),
    P('right', 1000, 40, 'familiarisation'),
    P('right', 1000, 40, 'descent'),
    P('right', 1000, 30, 'descent'),
    P('right', 1000, 35, 'ascent'),
    P('right', 2000, 65, 'descent'),
    P('right', 2000, 55, 'descent'),
    P('right', 1000, 65, 'descent', 'retest'),
    P('right', 1000, 55, 'descent', 'retest'),
  ];
  if (opts.verification) {
    ear1.push(P('right', 1000, 55, 'descent', 'verification'), P('right', 2000, 55, 'descent', 'verification'));
  }
  ear1.push(P('right', 500, 55, 'descent'), P('right', 250, 45, 'descent'));
  const ear2: Presentation[] = [
    P('left', 1000, 40, 'familiarisation'),
    P('left', 1000, 40, 'familiarisation'),
    P('left', 1000, 40, 'descent'),
    P('left', 2000, 60, 'descent'),
    P('left', 250, 50, 'ascent'),
  ];
  return [...ear1, ...ear2];
}

export class ScriptedProcedure implements ThresholdProcedure {
  readonly heard: boolean[] = [];
  private index = 0;
  constructor(
    private readonly script: readonly Presentation[],
    private readonly failAfter: number | null = null,
  ) {}
  async start(): Promise<Presentation | null> {
    return this.script[0] ?? null;
  }
  async respond(heard: boolean): Promise<Presentation | null> {
    if (this.failAfter !== null && this.heard.length >= this.failAfter) throw new Error('backend unavailable');
    this.heard.push(heard);
    this.index += 1;
    return this.script[this.index] ?? null;
  }
}

/** Returns the absolute time (session ms) to press for this trial, or null for no press. */
export type Listener = (trial: ActiveTrial) => number | null;

export const idealListener: Listener = (t) => (t.isCatchTrial ? null : t.onsetMs + 350);

export interface Harness {
  readonly clock: SimulatedClock;
  readonly session: TestSession;
  readonly stimulus: FakeStimulus;
  readonly procedure: ScriptedProcedure;
}

export function makeHarness(
  opts: {
    script?: readonly Presentation[];
    config?: Partial<SessionConfig>;
    seed?: number;
    procedure?: ScriptedProcedure;
    stimulusFailOn?: (p: Presentation) => boolean;
  } = {},
): Harness {
  const clock = new SimulatedClock();
  clock.set(10_000); // arbitrary non-zero epoch
  const now = (): number => clock.now();
  const stimulus = new FakeStimulus(now, opts.seed ?? 1, opts.stimulusFailOn);
  const procedure = opts.procedure ?? new ScriptedProcedure(opts.script ?? standardScript());
  let id = 0;
  const session = createTestSession(
    {
      deps: {
        procedure,
        stimulus,
        now,
        random: mulberry32((opts.seed ?? 1) + 1000),
        createId: () => `t${++id}`,
      },
      ...(opts.config ? { config: opts.config } : {}),
    },
    { clock },
  );
  return { clock, session, stimulus, procedure };
}

export async function advanceTo(h: Harness, t: number): Promise<void> {
  if (t > h.clock.now()) h.clock.set(t);
  else h.clock.increment(0); // flush 0 ms timers
  await flush();
}

export const stateOf = (h: Harness): string => {
  const v = h.session.actor.getSnapshot().value;
  return typeof v === 'string' ? v : Object.entries(v).map(([k, s]) => `${k}.${String(s)}`)[0]!;
};

/**
 * Drive a session to its end against a synthetic listener. Time is advanced to each
 * exact boundary (onset, offset, window end, planned press) in order.
 */
export async function runSession(h: Harness, listener: Listener, maxSteps = 20_000): Promise<SessionResult> {
  const actor = h.session.actor;
  const plans = new Map<string, number | null>();
  const pressed = new Set<string>();
  await flush();
  for (let step = 0; step < maxSteps; step++) {
    const snap = actor.getSnapshot();
    if (snap.status === 'done') return snap.output!;
    const ctx = snap.context;
    const state = stateOf(h);
    if (state === 'Idle') actor.send({ type: 'START' });
    else if (state === 'Instruction.loading' || state === 'Evaluation.updatingStaircase') await flush();
    else if (state === 'Instruction.ready') actor.send({ type: 'ACKNOWLEDGE' });
    else if (state === 'Reinstruct') actor.send({ type: 'CONTINUE' });
    else if (state === 'Familiarization') {
      if (ctx.earsStarted > 1) await advanceTo(h, (ctx.familiarizationEnteredAtMs ?? 0) + ctx.config.interEarBreakMs);
      actor.send({ type: 'CONTINUE' });
    } else if (state === 'Retest1000') await advanceTo(h, h.clock.now());
    else if (ctx.trial) {
      const tr = ctx.trial;
      if (!plans.has(tr.trialId)) plans.set(tr.trialId, listener(tr));
      const press = plans.get(tr.trialId) ?? null;
      const boundary =
        state === 'InterStimulusInterval.waiting'
          ? tr.onsetMs
          : state === 'ResponseWindow'
            ? tr.windowEndMs + ctx.config.scoringGraceMs
            : tr.offsetMs;
      if (press !== null && !pressed.has(tr.trialId) && press <= boundary && press >= h.clock.now()) {
        await advanceTo(h, press);
        pressed.add(tr.trialId);
        actor.send({ type: 'RESPONSE', timestampMs: press, source: 'keyboard' });
        await flush();
      } else {
        await advanceTo(h, boundary);
      }
    } else {
      await flush();
    }
  }
  throw new Error(`session did not finish within ${maxSteps} steps (stuck in ${stateOf(h)})`);
}
