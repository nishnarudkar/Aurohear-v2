/**
 * Hosts the test-session FSM (spec §7.2) and maps its states to screens:
 *
 *   Instruction.*      → "Preparing…" (session being created on the server)
 *   Familiarization    → ear introduction (ear 1) / enforced 30 s break (ear 2, §6.6)
 *   Reinstruct         → re-instruction (2 false alarms, or unstable 1 kHz retest)
 *   trial states       → RunnerView — IDENTICAL across ISI / tone / catch / response
 *                        window / evaluation: no visual cue of the stimulus (§7.3, §7.4)
 *   Complete / Aborted → handed back to the app for settling
 *
 * Every selector returns a primitive that changes only at coarse events (ear switch,
 * search committed), so React re-renders cannot track tone onsets either.
 */

import { useSelector } from '@xstate/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiBackedTestSession } from '../../api/createApiBackedTestSession';
import type { ResponseSource } from '../../session/types';
import type { SessionResult } from '../../session/testSessionMachine';
import { ConfirmDialog, useCountdown } from '../components/common';
import { ResponseButton } from '../components/ResponseButton';
import { progressFromTrials } from '../progress';

type View = 'preparing' | 'ear-intro' | 'break' | 'reinstruct' | 'noisy' | 'backgrounded' | 'running' | 'finished';

const TRIAL_STATES = new Set(['InterStimulusInterval', 'TonePresenting', 'CatchTrial', 'ResponseWindow', 'Evaluation', 'Retest1000']);

export function viewFor(stateValue: unknown, earsStarted: number): View {
  const top = typeof stateValue === 'string' ? stateValue : Object.keys(stateValue as object)[0]!;
  if (top === 'Idle' || top === 'Instruction') return 'preparing';
  if (top === 'Familiarization') return earsStarted > 1 ? 'break' : 'ear-intro';
  if (top === 'Reinstruct') return 'reinstruct';
  if (top === 'NoisyWait') return 'noisy';
  if (top === 'Backgrounded') return 'backgrounded';
  if (top === 'Complete' || top === 'Aborted') return 'finished';
  if (TRIAL_STATES.has(top)) return 'running';
  return 'running';
}

export function TestRunnerScreen({
  run,
  onFinished,
}: {
  readonly run: ApiBackedTestSession;
  readonly onFinished: (output: SessionResult) => void;
}) {
  const { actor, client } = run;
  const view = useSelector(actor, (s) => viewFor(s.value, s.context.earsStarted));
  const ready = useSelector(actor, (s) => s.matches({ Instruction: 'ready' }));
  const ear = useSelector(actor, (s) => s.context.pending?.ear ?? null);
  const firstEar = useSelector(actor, (s) => s.context.trials[0]?.ear ?? s.context.pending?.ear ?? 'right');
  const progressKey = useSelector(actor, (s) => {
    const p = progressFromTrials(s.context.trials, firstEar);
    return `${p.earNumber}|${p.percent}`;
  });
  const reason = useSelector(actor, (s) => s.context.reinstructionReason);
  const breakUntil = useSelector(actor, (s) =>
    s.context.familiarizationEnteredAtMs === null ? null : s.context.familiarizationEnteredAtMs + s.context.config.interEarBreakMs,
  );
  const [confirmStop, setConfirmStop] = useState(false);
  const finished = useRef(false);

  // Start the machine; acknowledge instructions once the server session exists.
  useEffect(() => {
    if (actor.getSnapshot().matches('Idle')) actor.send({ type: 'START' });
  }, [actor]);
  useEffect(() => {
    if (ready) actor.send({ type: 'ACKNOWLEDGE' });
  }, [ready, actor]);
  useEffect(() => {
    if (view === 'finished' && !finished.current) {
      finished.current = true;
      onFinished(actor.getSnapshot().output!);
    }
  }, [view, actor, onFinished]);

  const respond = useCallback(
    (timestampMs: number, source: ResponseSource) => actor.send({ type: 'RESPONSE', timestampMs, source }),
    [actor],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setConfirmStop(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Network status: polled on a slow timer unrelated to tones.
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setOffline(client.status === 'offline'), 2000);
    return () => clearInterval(id);
  }, [client]);

  const [earNumber, percent] = progressKey.split('|').map(Number) as [number, number];
  const earName = ear === 'left' ? 'left ear' : 'right ear';

  let body: React.ReactNode;
  if (view === 'preparing') body = <p aria-live="polite">Preparing your test…</p>;
  else if (view === 'ear-intro') body = <EarIntro ear={earName} onContinue={() => actor.send({ type: 'CONTINUE' })} />;
  else if (view === 'break') body = <BreakScreen untilMs={breakUntil} ear={earName} onContinue={() => actor.send({ type: 'CONTINUE' })} />;
  else if (view === 'reinstruct') body = <ReinstructScreen reason={reason} onContinue={() => actor.send({ type: 'CONTINUE' })} />;
  else if (view === 'noisy')
    body = (
      <div className="notice" role="status">
        <h1 style={{ marginTop: 0 }}>Too noisy — waiting</h1>
        <p>We picked up noise in the room, so the last tone did not count. The test will carry on by itself once it has been quiet for a moment.</p>
      </div>
    );
  else if (view === 'backgrounded')
    body = (
      <div className="notice" role="status">
        <h1 style={{ marginTop: 0 }}>Test paused</h1>
        <p>This window was in the background, so the last tone did not count. The test continues when this window is in front again.</p>
      </div>
    );
  else if (view === 'finished') body = <p aria-live="polite">Saving your results…</p>;
  else
    body = (
      <div className="runner">
        <p>
          Testing your <strong>{earName}</strong>. Press when you hear a tone.
        </p>
        <ResponseButton onResponse={respond} keyboardEnabled={!confirmStop} />
        <p id="response-help" className="muted small">
          or press <span className="kbd">Space</span> / <span className="kbd">Enter</span>
        </p>
        <div className="progress" aria-label={`Ear ${earNumber} of 2, about ${percent}% done`}>
          <p className="small muted" style={{ marginBottom: 6 }}>
            Ear {earNumber} of 2 · about {percent}% done
          </p>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
        </div>
      </div>
    );

  return (
    <>
      {offline && (
        <div className="notice" role="status">
          Connection lost. Keep going — your answers are saved on this device and will upload automatically.
        </div>
      )}
      {body}
      {view !== 'finished' && (
        <div className="actions" style={{ justifyContent: 'center' }}>
          <button type="button" className="danger" onClick={() => setConfirmStop(true)}>
            Stop test <span className="kbd">Esc</span>
          </button>
        </div>
      )}
      <ConfirmDialog
        open={confirmStop}
        title="Stop the test?"
        confirmLabel="Stop the test"
        onConfirm={() => {
          setConfirmStop(false);
          actor.send({ type: 'STOP' });
        }}
        onCancel={() => setConfirmStop(false)}
      >
        <p>Your answers so far are kept, but you will not get a full result.</p>
      </ConfirmDialog>
    </>
  );
}

function EarIntro({ ear, onContinue }: { readonly ear: string; readonly onContinue: () => void }) {
  return (
    <>
      <h1>First: your {ear}</h1>
      <p>We start with a few easy tones so you can get used to them.</p>
      <div className="actions">
        <button type="button" onClick={onContinue} autoFocus>
          Start
        </button>
      </div>
    </>
  );
}

export function BreakScreen({
  untilMs,
  ear,
  onContinue,
  now,
}: {
  readonly untilMs: number | null;
  readonly ear: string;
  readonly onContinue: () => void;
  readonly now?: () => number;
}) {
  const left = useCountdown(untilMs, now);
  return (
    <>
      <h1>Short break</h1>
      <p>First ear done. Rest for a moment — next is your {ear}.</p>
      <p aria-live="polite">{left > 0 ? `You can continue in ${left} s.` : 'Ready when you are.'}</p>
      <div className="actions">
        <button type="button" onClick={onContinue} disabled={left > 0}>
          Continue
        </button>
      </div>
    </>
  );
}

export function ReinstructScreen({ reason, onContinue }: { readonly reason: string | null; readonly onContinue: () => void }) {
  return (
    <>
      <h1>A quick reminder</h1>
      {reason === 'unstable_retest' ? (
        <p>We are going to repeat a couple of tones. Listen carefully and press as soon as you hear each one, even if it is very faint.</p>
      ) : (
        <p>
          <strong>Respond only when you are sure you heard the tone.</strong> Some of the gaps are silent on purpose; please do
          not press if you heard nothing.
        </p>
      )}
      <div className="actions">
        <button type="button" onClick={onContinue} autoFocus>
          Continue
        </button>
      </div>
    </>
  );
}
