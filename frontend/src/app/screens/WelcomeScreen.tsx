/** Landing + consent (spec §7.1 "/" and /consent): plain-language scope, not-a-diagnosis. */

import { useState } from 'react';

import { CONSENT_VERSION } from '../config';

export function WelcomeScreen({ onStart }: { readonly onStart: () => Promise<void> }) {
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <>
      <h1>Hearing screening</h1>
      <p>
        This test plays quiet tones through your headphones and records the softest ones you can hear. It takes
        about 15–20 minutes, in a quiet room, using <strong>wired</strong> headphones.
      </p>
      <div className="notice" role="note">
        <strong>This is a screening test, not a diagnostic test.</strong> It cannot diagnose hearing loss or its cause.
        It does not test bone conduction, and no one examines your ears. If you are worried about your hearing,
        please see a doctor or audiologist.
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Your data</h2>
        <p className="small">
          Your results are stored under a random code, not your name. They are used to give you your result and,
          if you agree, for research on improving this test.
        </p>
        <label>
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />I have read this
          and agree to take part (consent version {CONSENT_VERSION}).
        </label>
      </div>
      {error && (
        <div className="notice danger" role="alert">
          {error}
        </div>
      )}
      <div className="actions">
        <button
          type="button"
          disabled={!agreed || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onStart(); // creates the AudioContext inside this click (autoplay policy)
            } catch (e) {
              setError(`Audio could not be started on this device: ${e instanceof Error ? e.message : String(e)}`);
              setBusy(false);
            }
          }}
        >
          Start
        </button>
      </div>
    </>
  );
}
