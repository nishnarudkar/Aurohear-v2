/**
 * Client record ↔ wire DTO mapping, with runtime validation of everything the server
 * returns (a malformed presentation must never reach the audio engine).
 */

import type { Presentation, TrialRecord } from '../session/types';
import type { PresentationDto, TrialAcceptedDto, TrialCreateDto } from './types';

export class ApiContractError extends Error {
  constructor(message: string) {
    super(`API contract violation: ${message}`);
    this.name = 'ApiContractError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID_RE.test(s);

const EARS = new Set(['left', 'right']);
const PHASES = new Set(['familiarisation', 'descent', 'ascent']);
const ROLES = new Set(['initial', 'retest', 'verification']);

/** The trial log entry → POST /sessions/{id}/trials body. */
export function toTrialCreate(t: TrialRecord): TrialCreateDto {
  if (!isUuid(t.trialId)) {
    throw new ApiContractError(`trialId ${JSON.stringify(t.trialId)} is not a UUID; use crypto.randomUUID()`);
  }
  return {
    trial_id: t.trialId,
    seq: t.seq,
    ear: t.ear,
    frequency_hz: t.frequencyHz,
    level_db_hl: t.requestedLevelDbHl,
    presented_level_db_hl: t.presentedLevelDbHl,
    level_clamped: t.levelClamped,
    phase: t.phase,
    test_role: t.testRole,
    is_catch_trial: t.isCatchTrial,
    scheduled_at_ms: t.scheduledAtMs,
    presented_at_ms: t.onsetMs,
    offset_at_ms: t.offsetMs,
    audio_context_onset_s: t.audioContextOnsetS,
    duration_ms: t.durationMs,
    isi_ms: t.isiMs,
    responded: t.responded,
    response_at_ms: t.responseTimestampMs,
    response_latency_ms: t.responseLatencyMs,
    extra_responses: t.extraResponses,
    ambient_dba_at_trial: null, // ambient monitoring not implemented yet (spec §5)
    discarded: t.discarded,
    discard_reason: t.discardReason,
  };
}

/** Whether the server should advance the staircase for this record. */
export const advancesProtocol = (t: TrialRecord): boolean => !t.isCatchTrial && !t.discarded;

export function fromPresentation(dto: unknown): Presentation | null {
  if (dto === null) return null;
  if (typeof dto !== 'object' || dto === undefined) throw new ApiContractError('presentation is not an object');
  const p = dto as Record<string, unknown>;
  const { ear, frequency_hz, level_db_hl, phase, test_role } = p;
  if (typeof ear !== 'string' || !EARS.has(ear)) throw new ApiContractError(`bad ear ${String(ear)}`);
  if (!Number.isInteger(frequency_hz) || (frequency_hz as number) <= 0) {
    throw new ApiContractError(`bad frequency_hz ${String(frequency_hz)}`);
  }
  if (!Number.isInteger(level_db_hl) || (level_db_hl as number) % 5 !== 0 || (level_db_hl as number) < -10 || (level_db_hl as number) > 90) {
    throw new ApiContractError(`level_db_hl ${String(level_db_hl)} is off the −10…90 dB HL lattice`);
  }
  if (typeof phase !== 'string' || !PHASES.has(phase)) throw new ApiContractError(`bad phase ${String(phase)}`);
  if (typeof test_role !== 'string' || !ROLES.has(test_role)) throw new ApiContractError(`bad test_role ${String(test_role)}`);
  const out: PresentationDto = {
    ear: ear as PresentationDto['ear'],
    frequency_hz: frequency_hz as number,
    level_db_hl: level_db_hl as number,
    phase: phase as PresentationDto['phase'],
    test_role: test_role as PresentationDto['test_role'],
  };
  return {
    ear: out.ear,
    frequencyHz: out.frequency_hz,
    levelDbHl: out.level_db_hl,
    phase: out.phase,
    testRole: out.test_role,
  };
}

/** Check a TrialAccepted response is consistent with the record that was sent. */
export function checkTrialAccepted(record: TrialRecord, body: unknown): TrialAcceptedDto {
  if (typeof body !== 'object' || body === null) throw new ApiContractError('trial response is not an object');
  const r = body as TrialAcceptedDto;
  if (r.trial?.id !== record.trialId || r.trial?.seq !== record.seq) {
    throw new ApiContractError(`server acknowledged a different trial (seq ${String(r.trial?.seq)})`);
  }
  if (r.advanced_protocol !== advancesProtocol(record)) {
    throw new ApiContractError(
      `server advanced_protocol=${String(r.advanced_protocol)} for a ${record.isCatchTrial ? 'catch' : record.discarded ? 'discarded' : 'tone'} trial`,
    );
  }
  if (typeof r.protocol_complete !== 'boolean') throw new ApiContractError('missing protocol_complete');
  fromPresentation(r.next_presentation); // validates
  return r;
}
