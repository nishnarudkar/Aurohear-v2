/**
 * Intake + red-flag screener (spec §7.3 IntakeForm / RedFlagScreener). Any red flag halts
 * before testing. Noise exposure and tinnitus are required questions (BSA §5.1).
 */

import { useState } from 'react';

import { YesNo } from '../components/common';
import { EMPTY_INTAKE, type IntakeAnswers, intakeComplete, RED_FLAGS } from '../intake';

export function IntakeScreen({ onSubmit }: { readonly onSubmit: (a: IntakeAnswers) => void }) {
  const [a, setA] = useState<IntakeAnswers>(EMPTY_INTAKE);
  const set = <K extends keyof IntakeAnswers>(k: K, v: IntakeAnswers[K]): void => setA((prev) => ({ ...prev, [k]: v }));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (intakeComplete(a)) onSubmit(a);
      }}
    >
      <h1>Before the test</h1>
      <p className="muted">Some ear problems need a doctor rather than a hearing test. Please answer every question.</p>

      <h2>Your ears now</h2>
      {RED_FLAGS.map((f) => (
        <YesNo
          key={f.id}
          name={f.id}
          legend={f.question}
          value={a.redFlags[f.id]}
          onChange={(v) => set('redFlags', { ...a.redFlags, [f.id]: v })}
        />
      ))}

      <h2>About you</h2>
      <YesNo
        name="noise"
        legend="Have you been around loud noise in the last 24 hours (concert, power tools, loud music)?"
        value={a.noiseExposure24h}
        onChange={(v) => set('noiseExposure24h', v)}
      />
      <YesNo
        name="tinnitus"
        legend="Do you have ringing, buzzing or other noises in your ears (tinnitus)?"
        value={a.tinnitus}
        onChange={(v) => set('tinnitus', v)}
      />
      <YesNo
        name="noise-difficulty"
        legend="Do you find it hard to follow conversations in noisy places?"
        value={a.difficultyInNoise}
        onChange={(v) => set('difficultyInNoise', v)}
      />
      <fieldset>
        <legend>Which ear do you think hears better?</legend>
        <div className="yesno">
          {(['right', 'left', 'unsure'] as const).map((v) => (
            <label key={v}>
              <input type="radio" name="better" checked={a.betterEar === v} onChange={() => set('betterEar', v)} />
              {v === 'unsure' ? 'Not sure' : v === 'right' ? 'Right' : 'Left'}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="actions">
        <button type="submit" disabled={!intakeComplete(a)}>
          Continue
        </button>
      </div>
    </form>
  );
}

export function HaltScreen({ redFlags }: { readonly redFlags: readonly string[] }) {
  const asked = RED_FLAGS.filter((f) => redFlags.includes(f.id));
  return (
    <>
      <h1>Please see a doctor before taking a hearing test</h1>
      <div className="notice danger" role="alert">
        Your answers suggest an ear problem that should be checked by a doctor or ear specialist promptly. This online
        test is not suitable for you right now, so it will not run.
      </div>
      <p>You told us:</p>
      <ul>
        {asked.map((f) => (
          <li key={f.id}>{f.question}</li>
        ))}
      </ul>
      <p className="muted">
        Sudden hearing loss in particular is treated as urgent — if your hearing changed in the last few days, seek
        medical help today.
      </p>
    </>
  );
}
