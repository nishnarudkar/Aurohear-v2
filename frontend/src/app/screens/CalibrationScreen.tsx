/**
 * Calibration (spec §3.1–§3.2, §7.3 CalibrationWizard + VolumeLockPanel).
 *
 * Tier A/B need a measured profile from the registry; none ships (ETSPL tables must be
 * measured — spec §3.3 [VERIFY]), so the Tier C biological procedure is the path:
 *   volume lock → reference listener → ≥ 3 runs at 1 kHz (spread ≤ 5 dB)
 *   → 250 Hz and 4 kHz cross-checks against the A-weighting model → output headroom check.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ceilingDbHl } from '../../audio/calibration';
import type { ToneStimulusEngine } from '../../audio/ToneStimulusEngine';
import type { FrequencyHz } from '../../audio/types';
import {
  biologicalProfile,
  crossCheck,
  type CrossCheck,
  dbfsToRawLevel,
  MIN_RUNS,
  MIN_USABLE_MAX_DB_HL_AT_1K,
  runReferenceDbfs,
  summariseRuns,
  TONE_LEVEL_DIFFERENCE_DB,
} from '../../calibration/biological';
import type { CalibrationOutcome } from '../appFlowMachine';

/** Installed Tier A/B headphone profiles (spec §3.3). Empty until measured profiles exist. */
export const PROFILE_REGISTRY: readonly { id: string; label: string }[] = [];

const SLIDER_MIN = -110;
const SLIDER_MAX = -30; // never louder than this during calibration at max volume
const SLIDER_START = -100;

/** Loop the louder/quieter pair (1 s each, binaural) while `active`. */
function useAlternatingTones(engine: ToneStimulusEngine, frequencyHz: FrequencyHz, louderDbfs: number, active: boolean): void {
  const level = useRef(louderDbfs);
  level.current = louderDbfs;
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let current: { cancel(): void } | null = null;
    const loop = async (): Promise<void> => {
      let quieter = false;
      while (!stopped) {
        const dbfs = level.current - (quieter ? TONE_LEVEL_DIFFERENCE_DB : 0);
        const tone = engine.presentTone({ ear: 'both', frequencyHz, levelDbHl: dbfsToRawLevel(dbfs), durationMs: 1000, isiMs: 350 });
        current = tone;
        await tone.ended;
        quieter = !quieter;
      }
    };
    void loop();
    return () => {
      stopped = true;
      current?.cancel();
    };
  }, [engine, frequencyHz, active]);
}

function TwoToneRun({
  engine,
  frequencyHz,
  title,
  onDone,
}: {
  readonly engine: ToneStimulusEngine;
  readonly frequencyHz: FrequencyHz;
  readonly title: string;
  readonly onDone: (referenceDbfs: number) => void;
}) {
  const [louder, setLouder] = useState(SLIDER_START);
  const [playing, setPlaying] = useState(false);
  useAlternatingTones(engine, frequencyHz, louder, playing);
  const nudge = useCallback((d: number) => setLouder((v) => Math.max(SLIDER_MIN, Math.min(SLIDER_MAX, v + d))), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowUp') (e.preventDefault(), nudge(1));
      if (e.key === 'ArrowDown') (e.preventDefault(), nudge(-1));
      if (e.key === 'p' || e.key === 'P') setPlaying((p) => !p);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nudge]);

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <p>
        Two tones take turns. Start with both silent, then turn the level up <strong>slowly</strong> until you can hear
        only <strong>one of the two</strong> — the louder one — and the other has just disappeared.
      </p>
      <div className="actions">
        <button type="button" onClick={() => setPlaying((p) => !p)}>
          {playing ? 'Pause tones' : 'Play tones'} <span className="kbd">P</span>
        </button>
      </div>
      <label htmlFor={`slider-${frequencyHz}`} className="visually-hidden">
        Tone level
      </label>
      <input
        id={`slider-${frequencyHz}`}
        type="range"
        min={SLIDER_MIN}
        max={SLIDER_MAX}
        step={1}
        value={louder}
        onChange={(e) => setLouder(Number(e.target.value))}
        aria-valuetext={`step ${louder - SLIDER_MIN} of ${SLIDER_MAX - SLIDER_MIN}`}
      />
      <div className="actions">
        <button type="button" className="secondary" onClick={() => nudge(-1)}>
          Softer <span className="kbd">↓</span>
        </button>
        <button type="button" className="secondary" onClick={() => nudge(1)}>
          Louder <span className="kbd">↑</span>
        </button>
        <button
          type="button"
          disabled={louder === SLIDER_START}
          onClick={() => {
            setPlaying(false);
            onDone(runReferenceDbfs(louder));
          }}
        >
          I can hear only one tone
        </button>
      </div>
    </div>
  );
}

type Step =
  | { kind: 'intro' }
  | { kind: 'runs'; runs: number[] }
  | { kind: 'rejected'; reason: string }
  | { kind: 'cross'; ref1k: number; runs: number[]; checks: CrossCheck[] }
  | { kind: 'too_quiet'; maxDbHl: number };

const CROSS_FREQUENCIES: readonly FrequencyHz[] = [250, 4000];

export function CalibrationScreen({
  engine,
  onCalibrated,
}: {
  readonly engine: ToneStimulusEngine;
  readonly onCalibrated: (c: CalibrationOutcome) => void;
}) {
  const [step, setStep] = useState<Step>({ kind: 'intro' });
  const [attested, setAttested] = useState({ volume: false, listener: false });

  if (step.kind === 'intro') {
    return (
      <>
        <h1>Set up the sound level</h1>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Headphone profile</h2>
          {PROFILE_REGISTRY.length === 0 ? (
            <p className="muted">
              No measured headphone profiles are installed yet, so this device is calibrated by a listener (about 3
              minutes).
            </p>
          ) : null}
        </div>
        <div className="notice" role="note">
          <strong>Ask someone else to do this step</strong> if you can: a person <strong>under about 35</strong> with{' '}
          <strong>no hearing problems</strong>. Their hearing sets the reference level for your test.
        </div>
        <div className="card">
          <label>
            <input type="checkbox" checked={attested.volume} onChange={(e) => setAttested({ ...attested, volume: e.target.checked })} />
            I have set the computer’s volume to <strong>maximum</strong>, and I will <strong>not change it</strong> until the test
            is finished.
          </label>
          <br />
          <label>
            <input type="checkbox" checked={attested.listener} onChange={(e) => setAttested({ ...attested, listener: e.target.checked })} />
            The person wearing the headphones for this step is under about 35 and has no known hearing problems.
          </label>
        </div>
        <div className="actions">
          <button type="button" disabled={!attested.volume || !attested.listener} onClick={() => setStep({ kind: 'runs', runs: [] })}>
            Begin
          </button>
        </div>
      </>
    );
  }

  if (step.kind === 'runs') {
    const n = step.runs.length;
    return (
      <>
        <h1>Reference level — {n + 1} of {MIN_RUNS}</h1>
        <TwoToneRun
          key={n}
          engine={engine}
          frequencyHz={1000}
          title={`Setting ${n + 1} of ${MIN_RUNS}`}
          onDone={(ref) => {
            const runs = [...step.runs, ref];
            if (runs.length < MIN_RUNS) return setStep({ kind: 'runs', runs });
            const summary = summariseRuns(runs);
            if (!summary.accepted) return setStep({ kind: 'rejected', reason: summary.reason ?? 'inconsistent' });
            setStep({ kind: 'cross', ref1k: summary.referenceDbfs, runs, checks: [] });
          }}
        />
      </>
    );
  }

  if (step.kind === 'rejected') {
    return (
      <>
        <h1>The settings did not agree</h1>
        <div className="notice danger" role="alert">
          The three settings were too far apart ({step.reason}). Find the quietest point where just one tone is heard, and
          try to stop at the same point each time.
        </div>
        <div className="actions">
          <button type="button" onClick={() => setStep({ kind: 'runs', runs: [] })}>
            Start the settings again
          </button>
        </div>
      </>
    );
  }

  if (step.kind === 'too_quiet') {
    return (
      <>
        <h1>The headphones are too quiet for this test</h1>
        <div className="notice danger" role="alert">
          At the current volume this device can only produce about {Math.round(step.maxDbHl)} dB HL, which is not loud enough
          to test hearing properly. Check that the volume is at maximum, or try other wired headphones.
        </div>
        <div className="actions">
          <button type="button" onClick={() => setStep({ kind: 'runs', runs: [] })}>
            Calibrate again
          </button>
        </div>
      </>
    );
  }

  // Cross-checks at 250 Hz and 4 kHz (spec §3.2 [DESIGN]).
  const f = CROSS_FREQUENCIES[step.checks.length]!;
  return (
    <>
      <h1>Check at another pitch — {step.checks.length + 1} of {CROSS_FREQUENCIES.length}</h1>
      <TwoToneRun
        key={f}
        engine={engine}
        frequencyHz={f}
        title={f < 1000 ? 'Low pitch' : 'High pitch'}
        onDone={(measured) => {
          const checks = [...step.checks, crossCheck(step.ref1k, f, measured)];
          if (checks.length < CROSS_FREQUENCIES.length) return setStep({ ...step, checks });
          const maxAt1k = ceilingDbHl(biologicalProfile(step.ref1k), 1000);
          if (maxAt1k < MIN_USABLE_MAX_DB_HL_AT_1K) return setStep({ kind: 'too_quiet', maxDbHl: maxAt1k });
          onCalibrated({
            tier: 'C',
            run: summariseRuns(step.runs),
            crossChecks: checks,
            ref1kDbfs: step.ref1k,
            calibratedAt: new Date().toISOString(),
          });
        }}
      />
    </>
  );
}
