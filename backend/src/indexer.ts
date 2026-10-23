/**
 * Session discovery indexer: lazily scans the chain for new session ids into
 * the local mirror and refreshes mirrored rows through getSession. Scanning
 * is throttled and driven by /review/pending requests — no background timer,
 * so tests stay deterministic. Progress (last scanned block) is persisted.
 *
 * Two event shapes feed discovery: SessionCreated for freshly created
 * sessions, and SessionJoined for the Duel mirror position — the contract
 * creates the mirror inside joinSession and emits SessionJoined(linkedId)
 * plus two SessionStarted, but no SessionCreated for it.
 */

import type { ChainGateway } from './chain/gateway';
import type { BackendDb } from './db';

export class SessionIndexer {
  private lastSyncAt = 0;

  constructor(
    private readonly db: BackendDb,
    private readonly gateway: ChainGateway,
    private readonly opts: { startBlock: number; throttleMs: number },
  ) {}

  /** Scan for SessionCreated/SessionJoined events at most once per throttle window. */
  async syncThrottled(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSyncAt < this.opts.throttleMs) return;
    this.lastSyncAt = now;
    await this.sync();
  }

  private async sync(): Promise<void> {
    const last = this.db.getLastScannedBlock();
    const from = last == null ? this.opts.startBlock : last + 1;
    const latest = await this.gateway.getBlockNumber();
    if (latest < from) return;
    const [created, joined] = await Promise.all([
      this.gateway.getSessionCreatedEvents(from, latest),
      this.gateway.getSessionJoinedEvents(from, latest),
    ]);
    for (const e of created) this.db.mirrorInsertDiscovered(e.sessionId);
    for (const e of joined) {
      this.db.mirrorInsertDiscovered(e.sessionId);
      // Duel joins create the linked mirror position without SessionCreated.
      if (e.linkedSessionId !== '0') this.db.mirrorInsertDiscovered(e.linkedSessionId);
    }
    this.db.setLastScannedBlock(latest);
  }

  /** Refresh mirrored rows whose getSession snapshot is older than ttlMs. */
  async refreshStale(ttlMs: number): Promise<void> {
    const now = Date.now();
    for (const row of this.db.mirrorAll()) {
      if (now - row.refreshed_at < ttlMs) continue;
      try {
        const session = await this.gateway.getSession(row.session_id);
        this.db.mirrorUpdate(row.session_id, session, now);
      } catch {
        // Keep the stale row if the chain read fails; it retries next request.
      }
    }
  }
}
