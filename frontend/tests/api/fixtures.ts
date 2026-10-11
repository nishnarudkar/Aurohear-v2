import type { TrialRecord } from '../../src/session';

/** A valid, fully-populated tone trial record. */
export const sampleRecord: TrialRecord = {
  trialId: '0b8e7f3a-2c4d-4e5f-9a6b-1c2d3e4f5a6b',
  seq: 0,
  ear: 'right',
  frequencyHz: 1000,
  requestedLevelDbHl: 40,
  presentedLevelDbHl: 40,
  levelClamped: false,
  phase: 'familiarisation',
  testRole: 'initial',
  isCatchTrial: false,
  scheduledAtMs: 10_000,
  onsetMs: 12_000,
  offsetMs: 13_200,
  windowEndMs: 15_200,
  audioContextOnsetS: 12.25,
  durationMs: 1200,
  isiMs: 2000,
  responded: true,
  responseTimestampMs: 12_420,
  responseLatencyMs: 420,
  responseInWindow: true,
  extraResponses: 0,
  discarded: false,
  discardReason: null,
};
