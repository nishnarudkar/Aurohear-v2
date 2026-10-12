/**
 * Coarse progress for the runner (spec §7.3 ProgressIndicator): ear and the share of
 * threshold searches completed — never the frequency, level or running threshold.
 *
 * It changes only when a search has been committed (after a trial's response window),
 * never at tone onset, so it cannot act as a visual cue for the stimulus.
 */

import type { TrialRecord } from '../session/types';

/** Searches in the standard ASHA sequence: 9 (first ear, with 1 kHz retest) + 8. */
export const BASE_SEARCHES = 17;

export interface Progress {
  readonly earNumber: 1 | 2;
  readonly percent: number;
}

const key = (t: TrialRecord): string => `${t.ear}|${t.frequencyHz}|${t.testRole}`;

export function progressFromTrials(trials: readonly TrialRecord[], firstEar: 'left' | 'right'): Progress {
  const searches: string[] = [];
  let ear: 'left' | 'right' = firstEar;
  for (const t of trials) {
    if (t.isCatchTrial || t.discarded || t.phase === 'familiarisation') continue;
    const k = key(t);
    if (searches[searches.length - 1] !== k) searches.push(k);
    ear = t.ear;
  }
  const completed = Math.max(0, searches.length - 1);
  const total = Math.max(BASE_SEARCHES, searches.length + 1);
  return { earNumber: ear === firstEar ? 1 : 2, percent: Math.min(99, Math.floor((100 * completed) / total)) };
}
