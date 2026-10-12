/** Map the API's SessionResults into audiogram data. */

import type { SessionResultsDto } from '../api/types';
import type { AudiogramData, AudiogramPoint } from './renderAudiogram';

export function audiogramFromResults(results: SessionResultsDto): AudiogramData {
  const points: AudiogramPoint[] = results.thresholds.map((t) => ({
    ear: t.ear,
    frequencyHz: t.frequency_hz,
    status: t.status,
    thresholdDbHl: t.threshold_db_hl,
    possibleShadow: t.possible_shadow,
    testRole: t.test_role,
    accepted: t.is_accepted,
  }));
  const c = results.classification as { sigma_pta_db?: number; calibration_tier?: string } | undefined;
  return { points, sigmaDb: c?.sigma_pta_db ?? null, calibrationTier: c?.calibration_tier ?? null };
}
