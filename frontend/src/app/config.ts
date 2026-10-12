/** App configuration. Override the API with VITE_API_BASE_URL (see .env.example). */

export const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:8000';

/** Pinned into every session (spec §12.1); bump when the consent text changes. */
export const CONSENT_VERSION = '2026-10-01';

/** Mandatory pause before the second ear (spec §6.6); enforced by the session FSM too. */
export const INTER_EAR_BREAK_MS = 30_000;

/**
 * Absolute noise gating needs a calibrated microphone AND an MPANL table transcribed from
 * the procured ISO 8253-1 / BSA Appendix C (spec §2, §5.3). Neither can be invented, so
 * none ships: deployments that have them set this; otherwise the gate runs in relative
 * (change-detection) mode and the session record says so.
 */
export const NOISE_ABSOLUTE_CONFIG: import('../audio/NoiseGate').AbsoluteConfig | null = null;

export const PRACTICE_TONES = 3;
/** Practice tones are clearly audible (spec §7.3 PracticeTrialRunner). */
export const PRACTICE_LEVEL_DB_HL = 40;
