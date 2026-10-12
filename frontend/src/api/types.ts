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
  /** 'relative' = uncalibrated microphone, change detection only (spec §5.3.3). */
  readonly level_reference?: 'db_spl' | 'relative' | null;
  /** Only with a calibrated microphone (the server rejects it in relative mode). */
  readonly pretest_dba?: number | null;
  readonly pretest_third_octave?: Readonly<Record<string, number>> | null;
  readonly uncertainty_db?: number | null;
  readonly pretest_fluctuation_db?: number | null;
  readonly microphone_processing_off?: boolean | null;
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
  /**
   * Maximum deliverable dB HL per frequency (spec §3.4), keyed by Hz. Build it with
   * `frequencyCapsDbHl(profile)` so the server engine and the audio engine agree.
   */
  readonly frequency_caps_db_hl?: Readonly<Record<string, number>> | null;
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

export type LikelihoodBandDto = 'low' | 'medium' | 'high' | 'indeterminate';
export type ReferralDto =
  | 'urgent_ent'
  | 'audiologist'
  | 'retest_required'
  | 'repeat_then_refer'
  | 'retest_after_noise_free_interval'
  | 'speech_in_noise_test'
  | 'routine_retest';

/** Spec §9 classification (backend services/classification.py). */
export interface ClassificationDto {
  readonly model_version: string;
  readonly calibration_tier: 'A' | 'B' | 'C';
  readonly pta4_right: number | null;
  readonly pta4_left: number | null;
  readonly pta4_better: number | null;
  readonly better_ear: Ear | null;
  readonly who_grade_better_ear:
    | 'normal' | 'mild' | 'moderate' | 'moderately_severe' | 'severe' | 'profound' | 'complete' | null;
  readonly who_grade_is_lower_bound: boolean;
  readonly bsa_descriptor_right: 'none' | 'mild' | 'moderate' | 'severe' | 'profound' | null;
  readonly bsa_descriptor_left: 'none' | 'mild' | 'moderate' | 'severe' | 'profound' | null;
  readonly sigma_pta_db: number;
  /** Null when suppressed (red flag or indeterminate) — never display a number then. */
  readonly p_hearing_loss: number | null;
  readonly band: LikelihoodBandDto | null;
  readonly qc_composite: 'good' | 'fair' | 'poor';
  readonly confidence: 'high' | 'moderate' | 'low';
  readonly overrides_applied: readonly { readonly code: string; readonly reason: string }[];
  readonly annotations: readonly string[];
  readonly referral: ReferralDto;
  /** Participant-facing, non-diagnostic wording (spec §9.2 Step 5). */
  readonly statement: string;
  readonly caveats: readonly string[];
  readonly [key: string]: unknown;
}

export interface SessionResultsDto {
  readonly session: SessionDto;
  readonly protocol_complete: boolean;
  readonly thresholds: readonly ThresholdResultDto[];
  readonly audiogram: readonly ThresholdResultDto[];
  readonly quality_metrics: QualityMetricsDto;
  readonly classification: ClassificationDto;
}

export interface FeedbackCreateDto {
  readonly text: string;
  readonly ratings?: Readonly<Record<string, number>> | null;
  readonly language?: string | null;
}

/**
 * What the participant gets back after submitting feedback. NLP analysis of the text is
 * admin-only and never returned here (docs/NLP_RELIABILITY_MODULE.md, Access Control).
 */
export interface FeedbackDto {
  readonly id: string;
  readonly session_id: string;
  readonly submitted_at: string;
}
