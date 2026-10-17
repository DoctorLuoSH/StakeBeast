/**
 * Persistence layer for session judgment state (baseline section 6: the attester
 * must durably record start/bind times, participant address, last heartbeat,
 * violation flag and issued flag, and recover them after a restart).
 *
 * Lightweight equivalent of SQLite chosen for this wave: a write-through JSON
 * document store with atomic replace (write temp file + rename). Every mutation
 * is flushed synchronously, so a crash loses nothing that was already acked.
 * The Store interface is intentionally tiny so it can be swapped for SQLite
 * later without touching judgment or HTTP code.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SessionState } from './judgment';

interface StoreFile {
  version: 1;
  sessions: Record<string, SessionState>;
}

export class SessionStore {
  private readonly filePath: string;
  private readonly sessions = new Map<string, SessionState>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoreFile;
    for (const [id, s] of Object.entries(parsed.sessions)) this.sessions.set(id, s);
  }

  /** Atomic flush: write to a temp file, then rename over the target. */
  private flush(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const doc: StoreFile = { version: 1, sessions: Object.fromEntries(this.sessions) };
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2));
    renameSync(tmp, this.filePath);
  }

  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /** Insert or replace a session record and flush to disk. */
  put(state: SessionState): SessionState {
    this.sessions.set(state.sessionId, state);
    this.flush();
    return state;
  }

  list(): SessionState[] {
    return [...this.sessions.values()];
  }
}
