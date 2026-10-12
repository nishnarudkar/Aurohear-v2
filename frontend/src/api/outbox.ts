/**
 * Durable outbox for trial uploads.
 *
 * Every trial is written here *before* it is sent and deleted only after the server has
 * acknowledged it, so a dropped connection — or a closed tab — never loses a trial.
 * The server dedupes on trial_id, so re-sending a persisted entry is always safe.
 */

import type { TrialCreateDto } from './types';

export interface OutboxEntry {
  readonly sessionId: string;
  readonly trial: TrialCreateDto;
}

export interface OutboxStore {
  put(entry: OutboxEntry): Promise<void>;
  delete(trialId: string): Promise<void>;
  /** Pending entries, oldest first (by session, then seq). */
  list(sessionId?: string): Promise<OutboxEntry[]>;
}

const order = (a: OutboxEntry, b: OutboxEntry): number =>
  a.sessionId === b.sessionId ? a.trial.seq - b.trial.seq : a.sessionId < b.sessionId ? -1 : 1;

export class MemoryOutboxStore implements OutboxStore {
  private readonly entries = new Map<string, OutboxEntry>();

  async put(entry: OutboxEntry): Promise<void> {
    this.entries.set(entry.trial.trial_id, entry);
  }

  async delete(trialId: string): Promise<void> {
    this.entries.delete(trialId);
  }

  async list(sessionId?: string): Promise<OutboxEntry[]> {
    return [...this.entries.values()].filter((e) => sessionId === undefined || e.sessionId === sessionId).sort(order);
  }
}

const DB_NAME = 'aurohear';
const STORE = 'trial-outbox';

/** IndexedDB-backed outbox (survives reloads and crashes). */
export class IndexedDbOutboxStore implements OutboxStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory: IDBFactory = globalThis.indexedDB,
    private readonly dbName = DB_NAME,
  ) {
    if (!factory) throw new Error('IndexedDB is not available in this environment');
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = this.factory.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'trial.trial_id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  private async tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  async put(entry: OutboxEntry): Promise<void> {
    await this.tx('readwrite', (s) => s.put(entry));
  }

  async delete(trialId: string): Promise<void> {
    await this.tx('readwrite', (s) => s.delete(trialId));
  }

  async list(sessionId?: string): Promise<OutboxEntry[]> {
    const all = (await this.tx('readonly', (s) => s.getAll())) as OutboxEntry[];
    return all.filter((e) => sessionId === undefined || e.sessionId === sessionId).sort(order);
  }

  close(): void {
    void this.db?.then((d) => d.close());
    this.db = null;
  }
}
