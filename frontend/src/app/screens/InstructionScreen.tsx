/**
 * Instructions + practice (spec §7.3 InstructionsPanel / PracticeTrialRunner): a few clearly
 * audible tones, unscored, to confirm the task is understood. Feedback is given only
 * after each tone's response window has closed — never at tone onset.
 */

import { useCallback, useRef, useState } from 'react';

import type { ToneStimulusEngine } from '../../audio/ToneStimulusEngine';
import { PRACTICE_LEVEL_DB_HL, PRACTICE_TONES } from '../config';
import { ResponseButton } from '../components/ResponseButton';

const WINDOW_AFTER_OFFSET_MS = 2000;

export function InstructionScreen({ engine, onBegin }: { readonly engine: ToneStimulusEngine; readonly onBegin: () => void }) {
  const [phase, setPhase] = useState<'read' | 'practice' | 'done'>('read');
  const [done, setDone] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const windowRef = useRef<{ onset: number; end: number; heard: boolean } | null>(null);

  const onResponse = useCallback((t: number) => {
    const w = windowRef.current;
    if (w && t >= w.onset && t <= w.end) w.heard = true;
  }, []);

  const practise = async (): Promise<void> => {
    setPhase('practice');
    for (let i = 0; i < PRACTICE_TONES; i++) {
      const tone = engine.presentTrialTone({ ear: i % 2 === 0 ? 'right' : 'left', frequencyHz: 1000, levelDbHl: PRACTICE_LEVEL_DB_HL });
      // Map context time to performance.now() so key/pointer timestamps can be compared.
      const lagMs = (tone.onsetTime - engine.context.currentTime) * 1000;
      const onset = performance.now() + lagMs;
      windowRef.current = { onset, end: onset + tone.durationMs + WINDOW_AFTER_OFFSET_MS, heard: false };
      await tone.ended;
      await new Promise((r) => setTimeout(r, WINDOW_AFTER_OFFSET_MS));
      const heard = windowRef.current?.heard ?? false;
      setFeedback(heard ? 'Your press was recorded.' : 'No press was recorded for that tone — that is fine, the next one is just as loud.');
      setDone(i + 1);
    }
    windowRef.current = null;
    setPhase('done');
  };

  return (
    <>
      <h1>How the test works</h1>
      <ol>
        <li>You will hear short tones, one ear at a time. Some will be very quiet.</li>
        <li>
          Press the big button, <span className="kbd">Space</span> or <span className="kbd">Enter</span> as soon as you hear a tone
          — even if it is very faint.
        </li>
        <li>Sometimes there is silence. Only press when you are sure you heard something.</li>
        <li>The screen stays the same while tones play. That is on purpose: listen, do not watch.</li>
        <li>
          You can stop at any time with the Stop button or <span className="kbd">Esc</span>.
        </li>
      </ol>
      {phase === 'read' && (
        <div className="actions">
          <button type="button" onClick={() => void practise()}>
            Try {PRACTICE_TONES} practice tones
          </button>
        </div>
      )}
      {phase !== 'read' && (
        <div className="runner">
          <p aria-live="polite">
            Practice tone {Math.min(done + 1, PRACTICE_TONES)} of {PRACTICE_TONES}
            {feedback ? ` — ${feedback}` : ''}
          </p>
          {phase === 'practice' && <ResponseButton onResponse={onResponse} />}
        </div>
      )}
      {phase === 'done' && (
        <div className="actions">
          <button type="button" onClick={onBegin}>
            Begin the test
          </button>
          <button type="button" className="secondary" onClick={() => void practise()}>
            Practise again
          </button>
        </div>
      )}
    </>
  );
}
