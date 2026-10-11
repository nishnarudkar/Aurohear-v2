/**
 * Wire types for the AuroHear v2 API (snake_case, mirroring backend Pydantic schemas).
 * Checked against `openapi.json` (exported from the backend) by tests/api/contract.test.ts.
 */

import type { AbortReason as ClientAbortReason, Ear, StaircasePhase, TestRole, TrialPhase } from '../session/types';

/** Server AbortReason = spec §12.1 reasons ∪ client engine faults. */
export type AbortReasonDto = ClientAbortReason | 'timeouts' | 'noise';

export interface DeviceInfoDto {
  readonly user_agent?: string | null;
  readonly platform?: string | null;
  readonly audio_output_label?: string | null;
  readonly sample_rate?: number | null;
  readonly headphone_profile_id?: string | null;
  readonly transducer_type?: 'circumaural' | 'supra_aural' | 'insert' | 'other' | null;
  readonly connection: 'wired' | 'unknown'; // 'bluetooth' is rejected by the server (spec §3.3)
}

export interface CalibrationInfoDto {
  readonly tier: 'A' | 'B' | 'C';
  readonly method: 'coupler' | 'model_profile' | 'biological_1k';
  readonly profile_version: string;
  readonly spread_db?: number | null;
  readonly cross_check_250hz_delta_db?: number | null;
  /** ISO 8601 with timezone. */
  readonly calibrated_at?: string | null;
}

export interface EnvironmentInfoDto {
  readonly pretest_dba?: number | null;
  readonly pretest_third_octave?: Readonly<Record<string, number>> | null;
  readonly mpanl_table?: string | null;
  readonly test_floor_db?: number | null;
}

export interface SessionCreateDto {
  readonly participant_id: string;
  readonly consent_version: string;
  readonly mode: 'threshold';
  readonly supervision: 'unsupervised' | 'technician' | 'clinician';
  readonly better_ear?: Ear | null;
  readonly profile_cap_db_hl?: number;
  readonly client_time_origin_ms?: number | null;
  readonly device: DeviceInfoDto;
  readonly calibration: CalibrationInfoDto;
  readonly environment?: EnvironmentInfoDto | null;
}

export interface PresentationDto {
  readonly ear: Ear;
  readonly frequency_hz: number;
  readonly level_db_hl: number;
  readonly phase: StaircasePhase;
  readonly test_role: TestRole;
}

export type SessionStatusDto = 'in_progress' | 'complete' | 'incomplete' | 'aborted' | 'invalidated';

export interface SessionDto {
  readonly id: string;
  readonly participant_id: string;
  readonly protocol_version: string;
  readonly status: SessionStatusDto;
  readonly abort_reason: AbortReasonDto | null;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly [key: string]: unknown;
}

export interface SessionStateDto {
  readonly session: SessionDto;
  readonly trial_count: number;
  readonly next_presentation: PresentationDto | null;
  readonly protocol_complete: boolean;
}

export interface TrialCreateDto {
  readonly trial_id: string;
  readonly seq: number;
  readonly ear: Ear;
  readonly frequency_hz: number;
  readonly level_db_hl: number | null;
  readonly presented_level_db_hl: number | null;
  readonly level_clamped: boolean;
  readonly phase: TrialPhase;
  readonly test_role: TestRole;
  readonly is_catch_trial: boolean;
  readonly scheduled_at_ms: number;
  readonly presented_at_ms: number;
  readonly offset_at_ms: number;
  readonly audio_context_onset_s: number | null;
  readonly duration_ms: number;
  readonly isi_ms: number;
  readonly responded: boolean;
  readonly response_at_ms: number | null;
  readonly response_latency_ms: number | null;
  readonly extra_responses: number;
  readonly ambient_dba_at_trial: number | null;
  readonly discarded: boolean;
  readonly discard_reason: string | null;
}

export interface TrialAcceptedDto {
  readonly trial: TrialCreateDto & { readonly id: string; readonly session_id: string; readonly received_at: string };
  readonly advanced_protocol: boolean;
  readonly idempotent_replay: boolean;
  readonly next_presentation: PresentationDto | null;
  readonly protocol_complete: boolean;
}

export interface ThresholdResultDto {
  readonly ear: Ear;
  readonly frequency_hz: number;
  readonly test_role: TestRole;
  readonly search_index: number;
  readonly status: 'measured' | 'no_response' | 'unresolved';
  readonly threshold_db_hl: number | null;
  readonly provisional_db_hl: number | null;
  readonly floor_limited: boolean;
  readonly is_accepted: boolean;
  readonly possible_shadow: boolean;
  readonly [key: string]: unknown;
}

export interface QualityMetricsDto {
  readonly tone_trials: number;
  readonly catch_trials: number;
  readonly catch_false_alarms: number;
  readonly false_positive_rate: number | null;
  readonly discarded_trials: number;
  readonly mean_latency_ms: number | null;
  readonly unstable_1k: boolean;
  readonly protocol_complete: boolean;
  readonly [key: string]: unknown;
}

export interface SessionResultsDto {
  readonly session: SessionDto;
  readonly protocol_complete: boolean;
  readonly thresholds: readonly ThresholdResultDto[];
  readonly audiogram: readonly ThresholdResultDto[];
  readonly quality_metrics: QualityMetricsDto;
}

export interface FeedbackCreateDto {
  readonly text: string;
  readonly ratings?: Readonly<Record<string, number>> | null;
  readonly language?: string | null;
}

export interface FeedbackDto {
  readonly id: string;
  readonly session_id: string;
  readonly text: string;
  readonly ratings: Readonly<Record<string, number>> | null;
  readonly language: string | null;
  readonly submitted_at: string;
  readonly insights: readonly unknown[];
}
