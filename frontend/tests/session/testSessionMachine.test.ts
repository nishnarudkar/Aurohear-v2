import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../../src/audio/timing';
import type { ActiveTrial, TrialRecord } from '../../src/session';
import {
  advanceTo,
  flush,
  idealListener,
  type Listener,
  makeHarness,
  runSession,
  ScriptedProcedure,
  standardScript,
  stateOf,
} from './harness';

const REQUIRED_STATES = [
  'Idle',
  'Instruction',
  'Familiarization',
  'InterStimulusInterval',
  'TonePresenting',
  'ResponseWindow',
  'CatchTrial',
  'Evaluation',
  'Retest1000',
  'Complete',
] as const;

/** Every top-level edge the FSM is allowed to take (spec §7.2 + the requested states). */
const ALLOWED_EDGES = new Set([
  'Idle>Instruction',
  'Instruction>Evaluation',
  'Instruction>Complete',
  'Evaluation>Familiarization',
  'Evaluation>Retest1000',
  'Evaluation>InterStimulusInterval',
  'Evaluation>Reinstruct',
  'Evaluation>Complete',
  'Familiarization>InterStimulusInterval',
  'InterStimulusInterval>TonePresenting',
  'InterStimulusInterval>CatchTrial',
  'InterStimulusInterval>InterStimulusInterval',
  'TonePresenting>ResponseWindow',
  'CatchTrial>ResponseWindow',
  'ResponseWindow>Evaluation',
  'Retest1000>InterStimulusInterval',
  'Retest1000>Reinstruct',
  'Reinstruct>Evaluation',
]);
const top = (s: string): string => s.split('.')[0]!;
const ABORT_TARGETS = new Set(['Aborted']);

function topLevelEdges(transitions: readonly { state: string }[]): string[] {
  const tops = transitions.map((t) => top(t.state));
  const edges: string[] = [];
  for (let i = 1; i < tops.length; i++) if (tops[i] !== tops[i - 1]) edges.push(`${tops[i - 1]}>${tops[i]}`);
  return edges;
}

describe('state flow', () => {
  it('visits every required state and only takes allowed transitions', async () => {
    // Catch rate 1: every eligible trial becomes a catch (never in familiarisation, never twice in a row).
    const h = makeHarness({ config: { catchTrialRate: 1 } });
    const out = await runSession(h, idealListener);
    expect(out.status).toBe('complete');
    const visited = new Set(h.session.transitions.map((t) => top(t.state)));
    for (const s of REQUIRED_STATES) expect(visited, s).toContain(s);
    for (const e of topLevelEdges(h.session.transitions)) expect(ALLOWED_EDGES, e).toContain(e);
    // Transition log timestamps are non-decreasing.
    const times = h.session.transitions.map((t) => t.atMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('familiarisation tones are gated per ear and never replaced by catch trials', async () => {
    const h = makeHarness({ config: { catchTrialRate: 1 } });
    const out = await runSession(h, idealListener);
    const famEntries = h.session.transitions.filter((t) => t.state === 'Familiarization');
    expect(famEntries).toHaveLength(2); // once per ear
    const fam = out.trials.filter((t) => t.phase === 'familiarisation');
    expect(fam).toHaveLength(4);
    for (let i = 1; i < out.trials.length; i++) {
      if (out.trials[i]!.isCatchTrial) {
        expect(out.trials[i - 1]!.isCatchTrial).toBe(false);
        expect(out.trials[i]!.phase).toBe('catch');
      }
    }
  });

  it('enters Retest1000 exactly once for the ASHA 1 kHz retest', async () => {
    const h = makeHarness();
    await runSession(h, idealListener);
    expect(h.session.transitions.filter((t) => t.state === 'Retest1000')).toHaveLength(1);
  });

  it('an unstable retest (verification search) re-instructs before continuing', async () => {
    const h = makeHarness({ script: standardScript({ verification: true }) });
    const out = await runSession(h, idealListener);
    expect(out.status).toBe('complete');
    const seq = topLevelEdges(h.session.transitions);
    expect(seq).toContain('Retest1000>Reinstruct');
    expect(out.qc.reinstructions).toBe(1);
  });

  it('enforces the 30 s inter-ear break before the second ear', async () => {
    const h = makeHarness({ config: { catchTrialRate: 0 } });
    const actor = h.session.actor;
    actor.send({ type: 'START' });
    await flush();
    actor.send({ type: 'ACKNOWLEDGE' });
    await flush();
    // Drive until we reach the second ear's familiarisation.
    for (let i = 0; i < 200 && !(stateOf(h) === 'Familiarization' && actor.getSnapshot().context.earsStarted === 2); i++) {
      const s = stateOf(h);
      const ctx = actor.getSnapshot().context;
      if (s === 'Familiarization') actor.send({ type: 'CONTINUE' });
      else if (s === 'Retest1000') await advanceTo(h, h.clock.now());
      else if (ctx.trial) {
        const tr = ctx.trial;
        await advanceTo(h, s === 'InterStimulusInterval.waiting' ? tr.onsetMs : s === 'ResponseWindow' ? tr.windowEndMs + 100 : tr.offsetMs);
      }
      else await flush();
    }
    expect(stateOf(h)).toBe('Familiarization');
    const entered = actor.getSnapshot().context.familiarizationEnteredAtMs!;
    actor.send({ type: 'CONTINUE' });
    expect(stateOf(h)).toBe('Familiarization'); // too early
    await advanceTo(h, entered + 29_999);
    actor.send({ type: 'CONTINUE' });
    expect(stateOf(h)).toBe('Familiarization');
    await advanceTo(h, entered + 30_000);
    actor.send({ type: 'CONTINUE' });
    expect(stateOf(h)).toMatch(/^InterStimulusInterval/);
  });
});

describe('trial timestamps (session QC)', () => {
  it('logs onset, offset, response timestamp and exact latency for every trial', async () => {
    const latency = 437;
    const h = makeHarness({ config: { catchTrialRate: 0 } });
    const out = await runSession(h, (t) => t.onsetMs + latency);
    expect(out.trials.length).toBe(standardScript().length);
    for (const t of out.trials) {
      expect(t.onsetMs - t.scheduledAtMs).toBe(t.isiMs);
      expect(t.offsetMs - t.onsetMs).toBe(t.durationMs);
      expect(t.windowEndMs - t.offsetMs).toBe(2000);
      expect(t.responded).toBe(true);
      expect(t.responseTimestampMs).toBe(t.onsetMs + latency);
      expect(t.responseLatencyMs).toBe(latency);
      expect(t.audioContextOnsetS).not.toBeNull();
      expect(t.durationMs).toBeGreaterThanOrEqual(1000);
      expect(t.durationMs).toBeLessThanOrEqual(1500);
      expect(t.isiMs).toBeGreaterThanOrEqual(1500);
      expect(t.isiMs).toBeLessThanOrEqual(3000);
    }
    expect(out.qc.meanLatencyMs).toBe(latency);
    expect(out.qc.sdLatencyMs).toBe(0);
    expect(out.responses.every((r) => r.classification === 'hit' && r.latencyMs === latency)).toBe(true);
  });

  it('a press during the tone never truncates it; the window then closes at offset', async () => {
    const h = makeHarness({ config: { catchTrialRate: 0 } });
    const actor = h.session.actor;
    actor.send({ type: 'START' });
    await flush();
    actor.send({ type: 'ACKNOWLEDGE' });
    actor.send({ type: 'CONTINUE' }); // Familiarization (first ear: no break)
    await flush();
    const tr = actor.getSnapshot().context.trial!;
    await advanceTo(h, tr.onsetMs + 200);
    expect(stateOf(h)).toBe('TonePresenting');
    actor.send({ type: 'RESPONSE', timestampMs: tr.onsetMs + 200 });
    expect(stateOf(h)).toBe('TonePresenting');
    expect(h.stimulus.cancelled).toHaveLength(0);
    await advanceTo(h, tr.offsetMs - 1);
    expect(stateOf(h)).toBe('TonePresenting');
    await advanceTo(h, tr.offsetMs);
    expect(stateOf(h)).not.toBe('ResponseWindow'); // responded → straight to Evaluation
    expect(actor.getSnapshot().context.trials.at(-1)?.responded).toBe(true);
  });

  it('window is inclusive of offset + 2000 ms and exclusive after it', async () => {
    const run = async (afterOffset: number) => {
      const h = makeHarness({ config: { catchTrialRate: 0 } });
      return runSession(h, (t) => t.offsetMs + afterOffset);
    };
    const inside = await run(2000);
    expect(inside.trials.every((t) => t.responded)).toBe(true);
    const outside = await run(2001);
    expect(outside.trials.every((t) => !t.responded)).toBe(true);
    // Presses after the window land before the next onset → out-of-window false alarms.
    expect(outside.qc.outOfWindowResponses).toBeGreaterThan(0);
  });

  it('presses are debounced at 150 ms', async () => {
    const h = makeHarness({ config: { catchTrialRate: 0 } });
    const actor = h.session.actor;
    actor.send({ type: 'START' });
    await flush();
    actor.send({ type: 'ACKNOWLEDGE' });
    actor.send({ type: 'CONTINUE' });
    await flush();
    const tr = actor.getSnapshot().context.trial!;
    await advanceTo(h, tr.onsetMs + 300);
    actor.send({ type: 'RESPONSE', timestampMs: tr.onsetMs + 300 });
    actor.send({ type: 'RESPONSE', timestampMs: tr.onsetMs + 400 });
    actor.send({ type: 'RESPONSE', timestampMs: tr.onsetMs + 500 });
    const cls = actor.getSnapshot().context.responses.map((r) => r.classification);
    expect(cls).toEqual(['hit', 'debounced', 'repeat']);
  });

  it('a late-dispatched event stamped inside the scored window is not a false alarm', async () => {
    const h = makeHarness({ config: { catchTrialRate: 0 } });
    const actor = h.session.actor;
    actor.send({ type: 'START' });
    await flush();
    actor.send({ type: 'ACKNOWLEDGE' });
    actor.send({ type: 'CONTINUE' });
    await flush();
    const tr = actor.getSnapshot().context.trial!;
    await advanceTo(h, tr.onsetMs);
    await advanceTo(h, tr.offsetMs);
    await advanceTo(h, tr.windowEndMs + 100); // grace elapsed → scored as a miss
    await flush();
    actor.send({ type: 'RESPONSE', timestampMs: tr.windowEndMs - 50 }); // dispatched > grace late
    const last = actor.getSnapshot().context.responses.at(-1)!;
    expect(last.classification).toBe('late_after_scoring');
    expect(actor.getSnapshot().context.falseAlarmsSinceReinstruction).toBe(0);
  });
});

describe('catch trials and false-positive rate', () => {
  it('catch trials are silent, never reach the staircase, and drive the false-positive rate', async () => {
    const h = makeHarness({ config: { catchTrialRate: 1, falseAlarmsBeforeReinstruction: 1000 } });
    const respondToCatch: Listener = (t) => t.onsetMs + 500; // presses on every trial
    const out = await runSession(h, respondToCatch);
    const catches = out.trials.filter((t) => t.isCatchTrial);
    const tones = out.trials.filter((t) => !t.isCatchTrial);
    expect(catches.length).toBeGreaterThan(0);
    expect(h.stimulus.presented).toHaveLength(tones.length); // no audio for catches
    expect(h.procedure.heard).toHaveLength(tones.length); // catches never reported
    expect(catches.every((t) => t.presentedLevelDbHl === null && t.audioContextOnsetS === null)).toBe(true);
    expect(out.qc.catchTrials).toBe(catches.length);
    expect(out.qc.catchFalseAlarms).toBe(catches.length);
    expect(out.qc.falsePositiveRate).toBe(1);
  });

  it('second false alarm triggers re-instruction, then the counter resets', async () => {
    const h = makeHarness({ config: { catchTrialRate: 1 } });
    const out = await runSession(h, (t) => t.onsetMs + 500);
    expect(topLevelEdges(h.session.transitions)).toContain('Evaluation>Reinstruct');
    const catches = out.trials.filter((t) => t.isCatchTrial).length;
    expect(out.qc.reinstructions).toBe(Math.floor(catches / 2));
  });

  it('a press before onset is an out-of-window false alarm, not a hit', async () => {
    const h = makeHarness({ config: { catchTrialRate: 0, falseAlarmsBeforeReinstruction: 1000 } });
    const out = await runSession(h, (t) => t.onsetMs - 400);
    expect(out.trials.every((t) => !t.responded)).toBe(true);
    expect(h.procedure.heard.every((x) => !x)).toBe(true);
    expect(out.qc.outOfWindowResponses).toBe(out.trials.length);
  });

  it('property: QC rates equal the counts in the trial log, for any listener', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 0.5, noNaN: true }),
        fc.double({ min: 0, max: 0.6, noNaN: true }),
        async (seed, pHit, pFa, pEarly, catchRate) => {
          const rng = mulberry32(seed);
          const listener: Listener = (t: ActiveTrial) => {
            if (rng() < pEarly) return t.onsetMs - 100 - rng() * 1000;
            const p = t.isCatchTrial ? pFa : pHit;
            return rng() < p ? t.onsetMs + 150 + rng() * (t.windowEndMs - t.onsetMs - 150) : null;
          };
          const h = makeHarness({ seed, config: { catchTrialRate: catchRate } });
          const out = await runSession(h, listener);
          expect(out.status).toBe('complete');

          const catches = out.trials.filter((t) => t.isCatchTrial);
          const tones = out.trials.filter((t) => !t.isCatchTrial);
          expect(out.qc.catchTrials).toBe(catches.length);
          expect(out.qc.catchFalseAlarms).toBe(catches.filter((t) => t.responded).length);
          expect(out.qc.falsePositiveRate).toBe(catches.length ? catches.filter((t) => t.responded).length / catches.length : null);
          // The staircase saw exactly the tone trials' outcomes, in order.
          expect(h.procedure.heard).toEqual(tones.map((t) => t.responded));
          expect(tones).toHaveLength(standardScript().length);

          for (const [i, t] of out.trials.entries()) {
            expect(t.seq).toBe(i);
            expect(t.onsetMs).toBeLessThan(t.offsetMs);
            if (t.responded) {
              expect(t.responseTimestampMs!).toBeGreaterThanOrEqual(t.onsetMs);
              expect(t.responseTimestampMs!).toBeLessThanOrEqual(t.windowEndMs);
              expect(t.responseLatencyMs).toBe(t.responseTimestampMs! - t.onsetMs);
            }
            if (t.isCatchTrial) expect(out.trials[i - 1]?.isCatchTrial).not.toBe(true);
          }
          for (const e of topLevelEdges(h.session.transitions)) expect(ALLOWED_EDGES, e).toContain(e);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('trial log sink', () => {
  it('receives every committed record exactly once, in seq order, including catch and discards', async () => {
    const logged: TrialRecord[] = [];
    const h = makeHarness({ config: { catchTrialRate: 0.3 }, trialLog: (t) => logged.push(t) });
    const actor = h.session.actor;
    actor.send({ type: 'START' });
    await flush();
    actor.send({ type: 'ACKNOWLEDGE' });
    actor.send({ type: 'CONTINUE' });
    await flush();
    const tr = actor.getSnapshot().context.trial!;
    await advanceTo(h, tr.onsetMs + 100);
    actor.send({ type: 'DISCARD_TRIAL', reason: 'visibility_hidden' });
    await flush();
    await runSession(h, (t) => (t.isCatchTrial ? t.onsetMs + 300 : t.onsetMs + 350));
    const snap = actor.getSnapshot();
    expect(snap.status).toBe('done');
    const all = snap.context.trials;
    expect(logged).toEqual(all); // same records, same order, no duplicates
    expect(logged.map((t) => t.seq)).toEqual(logged.map((_, i) => i));
    expect(logged.some((t) => t.isCatchTrial)).toBe(true);
    expect(logged.filter((t) => t.discarded).length).toBeGreaterThanOrEqual(1);
    expect(new Set(logged.map((t) => t.trialId)).size).toBe(logged.length);
  });

  it('the trial cut short by STOP is logged as discarded; STOP with no trial logs nothing extra', async () => {
    const logged: TrialRecord[] = [];
    const h = makeHarness({ trialLog: (t) => logged.push(t) });
    const actor = h.session.actor;
    actor.send({ type: 'START' });
    await flush();
    actor.send({ type: 'ACKNOWLEDGE' });
    actor.send({ type: 'CONTINUE' });
    await flush();
    const tr = actor.getSnapshot().context.trial!;
    await advanceTo(h, tr.onsetMs + 100);
    actor.send({ type: 'STOP' });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ trialId: tr.trialId, discarded: true, discardReason: 'aborted' });

    const idle: TrialRecord[] = [];
    const h2 = makeHarness({ trialLog: (t) => idle.push(t) });
    h2.session.actor.send({ type: 'START' });
    h2.session.actor.send({ type: 'STOP' });
    expect(idle).toHaveLength(0);
  });
});

describe('abort, discard and failures', () => {
  async function toFirstTone(h: ReturnType<typeof makeHarness>) {
    const actor = h.session.actor;
    actor.send({ type: 'START' });
    await flush();
    actor.send({ type: 'ACKNOWLEDGE' });
    actor.send({ type: 'CONTINUE' });
    await flush();
    const tr = actor.getSnapshot().context.trial!;
    await advanceTo(h, tr.onsetMs + 100);
    expect(stateOf(h)).toBe('TonePresenting');
    return tr;
  }

  it('STOP mid-tone cancels the tone, keeps the partial log and ends Aborted', async () => {
    const h = makeHarness();
    await toFirstTone(h);
    h.session.actor.send({ type: 'STOP' });
    const snap = h.session.actor.getSnapshot();
    expect(snap.status).toBe('done');
    expect(snap.value).toBe('Aborted');
    expect(h.stimulus.cancelled).toEqual([0]);
    expect(snap.output!.status).toBe('aborted');
    expect(snap.output!.abortReason).toBe('user');
    expect(snap.output!.trials.at(-1)!.discarded).toBe(true);
  });

  it('FAULT (context suspended / device change) aborts with the reason', async () => {
    const h = makeHarness();
    await toFirstTone(h);
    h.session.actor.send({ type: 'FAULT', reason: 'device_change' });
    expect(h.session.actor.getSnapshot().output!.abortReason).toBe('device_change');
  });

  it('DISCARD_TRIAL (tab hidden) cancels, logs the discard and re-presents the same tone', async () => {
    const h = makeHarness();
    await toFirstTone(h);
    h.session.actor.send({ type: 'DISCARD_TRIAL', reason: 'visibility_hidden' });
    await flush();
    expect(h.stimulus.cancelled).toEqual([0]);
    expect(h.stimulus.presented).toHaveLength(2);
    expect(h.stimulus.presented[1]).toEqual(h.stimulus.presented[0]);
    expect(h.procedure.heard).toHaveLength(0);
    const out = await runSession(h, idealListener);
    expect(out.trials[0]!.discarded).toBe(true);
    expect(out.trials[0]!.discardReason).toBe('visibility_hidden');
    expect(out.qc.discardedTrials).toBe(1);
  });

  it('a procedure (backend) failure aborts with procedure_error', async () => {
    const h = makeHarness({ procedure: new ScriptedProcedure(standardScript(), 3) });
    const out = await runSession(h, idealListener);
    expect(out.status).toBe('aborted');
    expect(out.abortReason).toBe('procedure_error');
    expect(out.errorMessage).toBe('backend unavailable');
  });

  it('an audio failure aborts with stimulus_error and schedules nothing further', async () => {
    const h = makeHarness({ stimulusFailOn: (p) => p.frequencyHz === 2000 });
    const out = await runSession(h, idealListener);
    expect(out.abortReason).toBe('stimulus_error');
    expect(h.stimulus.presented.every((p) => p.frequencyHz !== 2000)).toBe(true);
  });

  it('an empty protocol completes straight after instructions', async () => {
    const h = makeHarness({ script: [] });
    const out = await runSession(h, idealListener);
    expect(out.status).toBe('complete');
    expect(out.trials).toHaveLength(0);
    expect(out.qc.falsePositiveRate).toBeNull();
  });
});
