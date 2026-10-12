/**
 * Pseudonymous participant id (spec §12.3): a random UUID kept in this browser only.
 * It is never derived from a name or email; linking it to a person is outside this app.
 */

const KEY = 'aurohear.participant-id';

export function participantId(storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): string {
  try {
    const existing = storage?.getItem(KEY);
    if (existing) return existing;
    const id = globalThis.crypto.randomUUID();
    storage?.setItem(KEY, id);
    return id;
  } catch {
    return globalThis.crypto.randomUUID(); // private mode / blocked storage: per-session id
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
