/**
 * Intake and red-flag screener (spec §7.3 IntakeForm / RedFlagScreener, §9.4).
 * Any red flag halts the flow before testing and routes to clinical referral.
 */

export const RED_FLAGS = [
  { id: 'sudden_loss', question: 'Has your hearing got worse suddenly, or over the last few days?' },
  { id: 'unilateral_loss', question: 'Do you have hearing loss in one ear only?' },
  { id: 'ear_pain', question: 'Do you have pain in either ear?' },
  { id: 'discharge', question: 'Is there any fluid or discharge coming from either ear?' },
  { id: 'vertigo', question: 'Have you had dizziness or a spinning sensation (vertigo)?' },
  { id: 'pulsatile_tinnitus', question: 'Do you hear a rhythmic sound in time with your heartbeat?' },
] as const;

export type RedFlagId = (typeof RED_FLAGS)[number]['id'];

export interface IntakeAnswers {
  readonly redFlags: Readonly<Record<RedFlagId, boolean | null>>;
  /** BSA §5.1: loud noise in the last 24 h → possible temporary threshold shift. */
  readonly noiseExposure24h: boolean | null;
  /** BSA §5.1: tinnitus must be asked. */
  readonly tinnitus: boolean | null;
  readonly difficultyInNoise: boolean | null;
  /** Self-reported better ear; tested first (spec §6.4). */
  readonly betterEar: 'right' | 'left' | 'unsure' | null;
}

export const EMPTY_INTAKE: IntakeAnswers = {
  redFlags: Object.fromEntries(RED_FLAGS.map((f) => [f.id, null])) as Record<RedFlagId, null>,
  noiseExposure24h: null,
  tinnitus: null,
  difficultyInNoise: null,
  betterEar: null,
};

export function intakeComplete(a: IntakeAnswers): boolean {
  return (
    Object.values(a.redFlags).every((v) => v !== null) &&
    a.noiseExposure24h !== null &&
    a.tinnitus !== null &&
    a.difficultyInNoise !== null &&
    a.betterEar !== null
  );
}

export function positiveRedFlags(a: IntakeAnswers): RedFlagId[] {
  return RED_FLAGS.filter((f) => a.redFlags[f.id] === true).map((f) => f.id);
}
