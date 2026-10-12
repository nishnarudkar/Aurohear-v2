/** Mirror of audiometry/levels.py: the 5 dB presentation lattice (spec §6.3, §6.5, §3.4). */

export const FLOOR_DB_HL = -10;
export const MAX_CEILING_DB_HL = 90;
export const STEP_DB = 5;
export const STEP_DOWN_DB = 10;
export const STEP_UP_DB = 5;

export class LevelLattice {
  constructor(
    readonly floor: number = FLOOR_DB_HL,
    readonly ceiling: number = MAX_CEILING_DB_HL,
  ) {
    if (floor % STEP_DB !== 0 || ceiling % STEP_DB !== 0) throw new RangeError('floor and ceiling must lie on the 5 dB grid');
    if (floor < FLOOR_DB_HL) throw new RangeError(`floor must be >= ${FLOOR_DB_HL} dB HL`);
    if (ceiling > MAX_CEILING_DB_HL) throw new RangeError(`ceiling must be <= ${MAX_CEILING_DB_HL} dB HL`);
    if (ceiling <= floor) throw new RangeError('ceiling must be above floor');
  }

  contains(level: number): boolean {
    return Number.isInteger(level) && level >= this.floor && level <= this.ceiling && level % STEP_DB === 0;
  }

  /** Round up to the next grid point, then clamp (Python `snap`). */
  snap(level: number): number {
    const r = pyRound(level);
    return this.clamp(Math.ceil(r / STEP_DB) * STEP_DB)[0];
  }

  clamp(level: number): [number, boolean] {
    if (level < this.floor) return [this.floor, true];
    if (level > this.ceiling) return [this.ceiling, true];
    return [level, false];
  }
}

/** Python's round(): half to even. */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Largest 5 dB grid level ≤ level (a cap is never rounded up). */
export function floorToGrid(levelDbHl: number): number {
  return Math.floor(levelDbHl / STEP_DB) * STEP_DB;
}

/** Per-frequency output ceilings (spec §3.4); mirror of FrequencyLattices. */
export class FrequencyLattices {
  readonly caps: ReadonlyMap<number, number>;

  constructor(
    readonly fallback: LevelLattice = new LevelLattice(),
    caps: ReadonlyMap<number, number> | Readonly<Record<number, number>> = new Map(),
  ) {
    this.caps = caps instanceof Map ? new Map(caps) : new Map(Object.entries(caps).map(([f, v]) => [Number(f), v]));
    for (const [f, cap] of this.caps) {
      if (!Number.isFinite(cap) || floorToGrid(cap) <= fallback.floor) {
        throw new RangeError(`cap ${cap} dB HL at ${f} Hz leaves no testable range above the floor`);
      }
    }
  }

  forFrequency(frequencyHz: number): LevelLattice {
    const cap = this.caps.get(frequencyHz);
    if (cap === undefined) return this.fallback;
    const ceiling = Math.min(this.fallback.ceiling, floorToGrid(cap));
    return ceiling === this.fallback.ceiling ? this.fallback : new LevelLattice(this.fallback.floor, ceiling);
  }
}
