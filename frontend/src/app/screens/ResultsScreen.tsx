/**
 * Results (spec §7.3 Results components, §8 audiogram, §9 classification).
 *   - The likelihood band is never shown without its confidence and calibration tier.
 *   - Caveats are not dismissible. Wording comes from the server (§9.2 Step 5).
 *   - A suppressed probability (red flag / indeterminate) is never shown as a number.
 */

import { useState } from 'react';

import type { ApiSessionClient } from '../../api/ApiSessionClient';
import type { ClassificationDto, ReferralDto, SessionResultsDto } from '../../api/types';
import { audiogramFromResults, downloadAudiogramPng, downloadAudiogramSvg } from '../../audiogram';
import { AudiogramView } from '../components/common';

const BAND_TEXT: Record<string, string> = {
  low: 'Lower likelihood of hearing loss',
  medium: 'Possible hearing loss',
  high: 'Higher likelihood of hearing loss',
  indeterminate: 'Indeterminate — retest required',
};
const BAND_ICON: Record<string, string> = { low: '●', medium: '◆', high: '▲', indeterminate: '?' };

const WHO_TEXT: Record<string, string> = {
  normal: 'Normal hearing',
  mild: 'Mild',
  moderate: 'Moderate',
  moderately_severe: 'Moderately severe',
  severe: 'Severe',
  profound: 'Profound',
  complete: 'Complete or total',
};

export const REFERRAL_TEXT: Record<ReferralDto, string> = {
  urgent_ent: 'See a doctor or ear specialist urgently.',
  audiologist: 'Arrange a full hearing test with an audiologist.',
  retest_required: 'Repeat this test in a quiet room, following the instructions closely.',
  repeat_then_refer: 'Repeat the test in better conditions; if the result is similar, see an audiologist.',
  retest_after_noise_free_interval: 'Repeat the test after a day without loud noise.',
  speech_in_noise_test: 'Consider a speech-in-noise test; tones in quiet do not measure listening in noise.',
  routine_retest: 'No action needed now; repeat as part of routine hearing checks.',
};

const descriptor = (d: string | null | undefined): string => (d === null || d === undefined ? '—' : d === 'none' ? 'Not described as a loss' : d[0]!.toUpperCase() + d.slice(1));

export function ResultsScreen({
  results,
  theme,
  client,
}: {
  readonly results: SessionResultsDto;
  readonly theme: 'light' | 'dark';
  readonly client: ApiSessionClient | null;
}) {
  const c = results.classification as ClassificationDto;
  const [clinician, setClinician] = useState(false);
  const data = audiogramFromResults(results);
  const options = { mode: clinician ? ('clinician' as const) : ('normal' as const), theme, idPrefix: 'results-audiogram' };
  const band = c.band ?? 'indeterminate';

  return (
    <>
      <h1>Your screening result</h1>
      {c.band !== null && (
        <p>
          <span className={`badge ${band}`} data-testid="band">
            <span aria-hidden="true">{BAND_ICON[band]}</span> {BAND_TEXT[band]}
          </span>{' '}
          <span className="muted small">
            confidence: <strong>{c.confidence}</strong> · calibration tier {c.calibration_tier}
          </span>
        </p>
      )}
      <p data-testid="statement">{c.statement}</p>

      <div className="card">
        <dl className="kv">
          <dt>What to do next</dt>
          <dd data-testid="referral">{REFERRAL_TEXT[c.referral]}</dd>
          <dt>WHO grade (better ear)</dt>
          <dd>
            {c.who_grade_better_ear ? WHO_TEXT[c.who_grade_better_ear] : '—'}
            {c.who_grade_is_lower_bound ? ' (at least)' : ''}
            {c.pta4_better !== null ? ` · average ${Math.round(c.pta4_better)} dB HL` : ''}
          </dd>
          <dt>Right ear (BSA)</dt>
          <dd>{descriptor(c.bsa_descriptor_right)}</dd>
          <dt>Left ear (BSA)</dt>
          <dd>{descriptor(c.bsa_descriptor_left)}</dd>
          {c.p_hearing_loss !== null && (
            <>
              <dt>Probability above 20 dB HL</dt>
              <dd>{Math.round(c.p_hearing_loss * 100)}%</dd>
            </>
          )}
        </dl>
      </div>

      {c.overrides_applied.length > 0 && (
        <div className="notice" role="note">
          <strong>Why:</strong>
          <ul style={{ margin: '6px 0 0' }}>
            {c.overrides_applied.map((o) => (
              <li key={o.code}>{o.reason}</li>
            ))}
          </ul>
        </div>
      )}

      <h2>Audiogram</h2>
      <AudiogramView data={data} options={options} />
      <div className="actions">
        <label>
          <input type="checkbox" checked={clinician} onChange={(e) => setClinician(e.target.checked)} />
          Clinician view (uncertainty bars, all searches)
        </label>
      </div>
      <div className="actions">
        <button type="button" className="secondary" onClick={() => downloadAudiogramSvg(data, options)}>
          Download SVG
        </button>
        <button type="button" className="secondary" onClick={() => void downloadAudiogramPng(data, options)}>
          Download PNG
        </button>
      </div>

      <h2>Please read</h2>
      <ul data-testid="caveats">
        {c.caveats.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      {c.annotations.length > 0 && (
        <details>
          <summary>Notes about this test</summary>
          <ul>
            {c.annotations.map((t) => (
              <li key={t} className="small">
                {t}
              </li>
            ))}
          </ul>
        </details>
      )}

      {client && <FeedbackForm client={client} />}
    </>
  );
}

function FeedbackForm({ client }: { readonly client: ApiSessionClient }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>How was the test?</h2>
      {state === 'sent' ? (
        <p role="status">Thank you — your feedback was saved.</p>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setState('sending');
            try {
              await client.submitFeedback({ text: text.trim(), language: navigator.language });
              setState('sent');
            } catch {
              setState('error');
            }
          }}
        >
          <label htmlFor="feedback">Anything unclear, uncomfortable or not working? (optional)</label>
          <textarea id="feedback" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
          {state === 'error' && <p role="alert">Sorry, that could not be sent.</p>}
          <div className="actions">
            <button type="submit" disabled={text.trim().length < 5 || state === 'sending'}>
              Send feedback
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
