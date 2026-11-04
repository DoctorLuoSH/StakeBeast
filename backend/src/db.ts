/**
 * SQLite persistence (better-sqlite3) under DATA_DIR: profiles, single-use
 * login challenges, check-in metadata with on-chain anchor status, and the
 * mirrored session index that feeds the verifier review list.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChainSession } from './chain/gateway';

export interface ProfileRow {
  address: string; // EIP-55
  nickname: string;
  created_at: string; // RFC 3339
}

export interface ChallengeRow {
  nonce: string;
  address: string; // EIP-55
  message: string; // exact string the wallet signed
  expires_at: string; // RFC 3339
  used: number; // 0 | 1 — consumed on ANY verify attempt
}

export type AnchorStatus = 'pending' | 'confirmed' | 'failed';

/**
 * Why an anchor attempt failed chain verification (DAPP-55 F1):
 * - tx_reverted: the reported transaction mined with status 0
 * - period_mismatch: a CheckedIn log matches contract/session/caller/hash but
 *   carries a different periodIndex — the period rolled over after upload, so
 *   re-anchoring the same record can never confirm (the row is a dead end)
 * - event_mismatch: no usable CheckedIn log at all (wrong contract / session /
 *   caller / evidence hash, or none emitted)
 */
export type AnchorFailReason = 'tx_reverted' | 'period_mismatch' | 'event_mismatch';

export interface CheckinRow {
  checkin_id: string;
  session_id: string; // decimal string
  staker: string; // EIP-55
  period_index: number;
  evidence_hash: string; // 0x-prefixed, lower-case
  sha256: string; // lower-case hex, content-address of the original bytes
  ext: string; // '.jpg' | '.png' | '.webp'
  content_type: string;
  created_at: string; // RFC 3339
  anchor_status: AnchorStatus;
  anchor_tx_hash: string | null;
  anchor_block_number: number | null;
  anchor_fail_reason: AnchorFailReason | null; // set only while status = 'failed'
}

export interface MirrorRow {
  session_id: string;
  staker: string | null;
  verifier: string | null;
  partner: string | null;
  linked_session_id: string | null;
  mode: number | null;
  status: number | null;
  criterion: string | null;
  period_days: number | null;
  target_count: number | null;
  settlement_deadline: number | null;
  refreshed_at: number; // ms epoch of the last getSession refresh; 0 = never
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  address TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS challenges (
  nonce TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_challenges_address ON challenges(address);
CREATE TABLE IF NOT EXISTS checkins (
  checkin_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  staker TEXT NOT NULL,
  period_index INTEGER NOT NULL,
  evidence_hash TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  ext TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  anchor_status TEXT NOT NULL DEFAULT 'pending',
  anchor_tx_hash TEXT,
  anchor_block_number INTEGER,
  anchor_fail_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_checkins_session ON checkins(session_id);
CREATE TABLE IF NOT EXISTS sessions_mirror (
  session_id TEXT PRIMARY KEY,
  staker TEXT,
  verifier TEXT,
  partner TEXT,
  linked_session_id TEXT,
  mode INTEGER,
  status INTEGER,
  criterion TEXT,
  period_days INTEGER,
  target_count INTEGER,
  settlement_deadline INTEGER,
  refreshed_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS indexer_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_block INTEGER NOT NULL
);
`;

export class BackendDb {
  private readonly db: Database.Database;

  constructor(public readonly dataDir: string) {
    mkdirSync(join(dataDir, 'media', 'thumbs'), { recursive: true });
    mkdirSync(join(dataDir, 'avatars'), { recursive: true });
    this.db = new Database(join(dataDir, 'backend.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    // Existing databases predate anchor_fail_reason — add the column once.
    const checkinCols = this.db.prepare('PRAGMA table_info(checkins)').all() as { name: string }[];
    if (!checkinCols.some((c) => c.name === 'anchor_fail_reason')) {
      this.db.exec('ALTER TABLE checkins ADD COLUMN anchor_fail_reason TEXT');
    }
  }

  /** Escape hatch for tests (e.g. forcing a challenge to expire). */
  get handle(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------------
  // Profiles
  // ------------------------------------------------------------------

  getProfile(address: string): ProfileRow | undefined {
    return this.db.prepare('SELECT * FROM profiles WHERE address = ?').get(address) as
      | ProfileRow
      | undefined;
  }

  insertProfile(address: string, nickname: string, createdAt: string): void {
    this.db
      .prepare('INSERT INTO profiles (address, nickname, created_at) VALUES (?, ?, ?)')
      .run(address, nickname, createdAt);
  }

  updateNickname(address: string, nickname: string): void {
    this.db.prepare('UPDATE profiles SET nickname = ? WHERE address = ?').run(nickname, address);
  }

  // ------------------------------------------------------------------
  // Login challenges
  // ------------------------------------------------------------------

  insertChallenge(c: { nonce: string; address: string; message: string; expiresAt: string }): void {
    this.db
      .prepare('INSERT INTO challenges (nonce, address, message, expires_at) VALUES (?, ?, ?, ?)')
      .run(c.nonce, c.address, c.message, c.expiresAt);
  }

  /** The most recently issued challenge for an address, used or not. */
  latestChallenge(address: string): ChallengeRow | undefined {
    return this.db
      .prepare('SELECT * FROM challenges WHERE address = ? ORDER BY rowid DESC LIMIT 1')
      .get(address) as ChallengeRow | undefined;
  }

  markChallengeUsed(nonce: string): void {
    this.db.prepare('UPDATE challenges SET used = 1 WHERE nonce = ?').run(nonce);
  }

  // ------------------------------------------------------------------
  // Check-ins
  // ------------------------------------------------------------------

  insertCheckin(row: CheckinRow): void {
    this.db
      .prepare(
        `INSERT INTO checkins (checkin_id, session_id, staker, period_index, evidence_hash,
           sha256, ext, content_type, created_at, anchor_status, anchor_tx_hash, anchor_block_number,
           anchor_fail_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.checkin_id,
        row.session_id,
        row.staker,
        row.period_index,
        row.evidence_hash,
        row.sha256,
        row.ext,
        row.content_type,
        row.created_at,
        row.anchor_status,
        row.anchor_tx_hash,
        row.anchor_block_number,
        row.anchor_fail_reason,
      );
  }

  getCheckin(checkinId: string): CheckinRow | undefined {
    return this.db.prepare('SELECT * FROM checkins WHERE checkin_id = ?').get(checkinId) as
      | CheckinRow
      | undefined;
  }

  /** Chronological order (insertion order). */
  listCheckins(sessionId: string): CheckinRow[] {
    return this.db
      .prepare('SELECT * FROM checkins WHERE session_id = ? ORDER BY rowid')
      .all(sessionId) as CheckinRow[];
  }

  /**
   * Persist an anchor attempt outcome. `failReason` is stored only for
   * 'failed' and cleared on pending/confirmed, so the wire shape can expose
   * the stored value directly.
   */
  updateAnchor(
    checkinId: string,
    status: AnchorStatus,
    txHash: string | null,
    blockNumber: number | null,
    failReason: AnchorFailReason | null,
  ): void {
    this.db
      .prepare(
        'UPDATE checkins SET anchor_status = ?, anchor_tx_hash = ?, anchor_block_number = ?, anchor_fail_reason = ? WHERE checkin_id = ?',
      )
      .run(status, txHash, blockNumber, failReason, checkinId);
  }

  // ------------------------------------------------------------------
  // Session mirror (review-list discovery)
  // ------------------------------------------------------------------

  mirrorInsertDiscovered(sessionId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO sessions_mirror (session_id, refreshed_at) VALUES (?, 0)')
      .run(sessionId);
  }

  mirrorAll(): MirrorRow[] {
    return this.db.prepare('SELECT * FROM sessions_mirror ORDER BY CAST(session_id AS INTEGER)').all() as MirrorRow[];
  }

  mirrorUpdate(sessionId: string, s: ChainSession, refreshedAt: number): void {
    this.db
      .prepare(
        `UPDATE sessions_mirror SET staker = ?, verifier = ?, partner = ?, linked_session_id = ?,
           mode = ?, status = ?, criterion = ?, period_days = ?, target_count = ?,
           settlement_deadline = ?, refreshed_at = ?
         WHERE session_id = ?`,
      )
      .run(
        s.staker,
        s.verifier,
        s.partner,
        s.linkedSessionId,
        s.mode,
        s.status,
        s.criterion,
        s.periodDays,
        s.targetCount,
        s.settlementDeadline,
        refreshedAt,
        sessionId,
      );
  }

  /** Active sessions (on-chain Status.Active = 1) verified by `address`. */
  mirrorActiveByVerifier(address: string): MirrorRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sessions_mirror
         WHERE verifier IS NOT NULL AND lower(verifier) = lower(?) AND status = 1
         ORDER BY CAST(session_id AS INTEGER)`,
      )
      .all(address) as MirrorRow[];
  }

  // ------------------------------------------------------------------
  // Indexer progress
  // ------------------------------------------------------------------

  getLastScannedBlock(): number | null {
    const row = this.db.prepare('SELECT last_scanned_block FROM indexer_state WHERE id = 1').get() as
      | { last_scanned_block: number }
      | undefined;
    return row ? row.last_scanned_block : null;
  }

  setLastScannedBlock(block: number): void {
    this.db
      .prepare(
        `INSERT INTO indexer_state (id, last_scanned_block) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET last_scanned_block = excluded.last_scanned_block`,
      )
      .run(block);
  }
}
