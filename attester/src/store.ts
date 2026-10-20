/**
 * Persistence and restart recovery (attester-service.md §5).
 *
 * Store = append-only journal (`journal.ndjson`, fsync on every entry) + a
 * JSON snapshot (`state.json`, rewritten atomically tmp+rename on every
 * transition, for human inspection during the demo). The journal is
 * authoritative: on boot the full state is rebuilt by replaying it.
 *
 * Every receive record is a (run-instance id, monotonic instant, server UTC)
 * triple. Monotonic readings are meaningful only within one run instance —
 * after a restart the scoring layer never subtracts monotonic counters across
 * run ids (T1); cross-run silence is judged via UTC plus the current run's
 * boot instant, and unverifiable in-window downtime routes to `uncertifiable`,
 * never to a remap.
 *
 * Journal volume note: §5 once throttled the coverage watermark to 1 write /
 * 5 s. That throttle was removed (DAPP-20 D1): gap analysis replays exactly
 * the journaled heartbeat sequence, so every accepted heartbeat is journaled
 * — dropping records made the scorer miss valid coverage and false-flag
 * `heartbeat_timeout`. The judgment stream is never throttled; live state and
 * replayed state are identical by construction, and the tiny per-heartbeat
 * `seq` marker keeps the anti-replay watermark (AC-30) exact across restarts.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Mode } from './chain';

/** ms; frozen judgment numbers (attester-service §2, baseline v1.4 D2). */
export const HEARTBEAT_GRACE_MS = 15_000;
export const HEARTBEAT_CADENCE_MS = 5_000;
export const BIND_WINDOW_MS = 5 * 60_000;
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const CLOCK_SKEW_TOLERANCE_MS = 30_000;

/** A server-side receive record: run id + monotonic ms + server UTC ms. */
export interface ReceiveRec {
  runId: string;
  mono: number;
  utc: number;
}

export type ViolationReason = 'hidden' | 'heartbeat_timeout' | 'bind_timeout';
export type AnomalyReason = 'restart_gap' | 'clock_skew' | 'stale_chain';
export type Judgment = 'clean' | 'violation' | 'uncertifiable';
export type RefusalReason = 'violation' | 'late_bind' | 'uncertifiable' | 'unreliable_time';
export type SessionLifecycle =
  | 'ready'
  | 'arming'
  | 'monitoring'
  | 'clean'
  | 'violation'
  | 'uncertifiable'
  | 'attested'
  | 'refused';

export interface ParticipantRec {
  address: string; // lowercase
  bound: boolean;
  /** UTC ms of the FIRST successful bind; rebinds never move it. */
  boundAtMs: number | null;
  /** True once the first accepted heartbeat arrived (§3.1 readiness). */
  ready: boolean;
  /** Highest accepted heartbeat seq (strictly-increasing track, AC-30). */
  highestSeq: number;
  /** Journaled coverage records (every accepted heartbeat), arrival order. */
  heartbeats: ReceiveRec[];
  /** sha256 hex of the current client token; null when never bound. */
  tokenHash: string | null;
  /** UTC ms of the last journaled coverage record. */
  lastHbWatermarkMs: number;
}

export interface EventRec {
  eventId: string;
  type: string;
  rec: ReceiveRec;
}

export interface SessionWindow {
  /** seconds, chain-anchored. */
  startTime: number;
  endTime: number;
  settlementDeadline: number;
}

export interface StoredAttestation {
  typedData: unknown;
  signature: string;
  signer: string;
}

export interface SessionRec {
  key: string;
  chainId: number;
  contract: string; // lowercase
  sessionId: string; // decimal string
  mode: Mode;
  staker: string; // lowercase
  partner: string | null; // lowercase; CoFocus only
  participants: Record<string, ParticipantRec>;
  window: SessionWindow | null;
  arming: { txHash: string; from: string; noticedAtMs: number } | null;
  events: Record<string, EventRec[]>;
  seenEventIds: Record<string, string[]>;
  violation: { participant: string; reason: ViolationReason; atMs: number } | null;
  anomaly: { reason: AnomalyReason; detail: string; atMs: number } | null;
  judgment: Judgment | null;
  judgedAtMs: number | null;
  refusal: { reason: RefusalReason; atMs: number } | null;
  attestation: StoredAttestation | null;
}

export interface ChallengeRec {
  nonce: string;
  chainId: number;
  contract: string; // lowercase
  sessionId: string;
  address: string; // lowercase
  message: string;
  issuedAtMs: number;
  expiresAtMs: number;
  consumed: boolean;
}

export type JournalEntry =
  | { t: 'challenge'; c: ChallengeRec }
  | { t: 'consume'; nonce: string }
  | {
      t: 'bind';
      key: string;
      chainId: number;
      contract: string;
      sessionId: string;
      mode: Mode;
      staker: string;
      partner: string | null;
      participant: string;
      boundAtMs: number;
      tokenHash: string;
      revokedTokenHash: string | null;
    }
  | { t: 'hb'; key: string; participant: string; seq: number; rec: ReceiveRec }
  | { t: 'seq'; key: string; participant: string; seq: number }
  | { t: 'hbd'; key: string; participant: string; seq: number; rec: ReceiveRec }
  | { t: 'ev'; key: string; participant: string; eventId: string; type: string; rec: ReceiveRec }
  | { t: 'arm'; key: string; txHash: string; from: string; noticedAtMs: number }
  | { t: 'disarm'; key: string }
  | { t: 'window'; key: string; startTime: number; endTime: number; settlementDeadline: number }
  | { t: 'violation'; key: string; participant: string; reason: ViolationReason; atMs: number }
  | { t: 'anomaly'; key: string; reason: AnomalyReason; detail: string; atMs: number }
  | { t: 'judgment'; key: string; result: Judgment; atMs: number }
  | { t: 'refused'; key: string; reason: RefusalReason; atMs: number }
  | { t: 'attestation'; key: string; attestation: StoredAttestation };

export const sessionKey = (chainId: number, contract: string, sessionId: string): string =>
  `${chainId}:${contract.toLowerCase()}:${sessionId}`;

export function newParticipant(address: string): ParticipantRec {
  return {
    address,
    bound: false,
    boundAtMs: null,
    ready: false,
    highestSeq: 0,
    heartbeats: [],
    tokenHash: null,
    lastHbWatermarkMs: 0,
  };
}

interface Snapshot {
  version: 1;
  sessions: Record<string, SessionRec>;
  challenges: Record<string, ChallengeRec>;
}

/**
 * Durable attester state. All mutations go through `record(entry)` which
 * appends to the journal (fsync), applies the entry to memory, and rewrites
 * the snapshot — so a crash loses nothing that was already acknowledged.
 */
export class AttesterStore {
  readonly runId: string;
  readonly bootUtcMs: number;
  readonly sessions = new Map<string, SessionRec>();
  readonly challenges = new Map<string, ChallengeRec>();
  /** tokenHash -> owning session/participant (rebuilt by replay). */
  readonly tokens = new Map<string, { sessionKey: string; participant: string }>();

  readonly dataDir: string;
  private readonly journalPath: string;
  private readonly snapshotPath: string;
  private journalFd: number | null = null;
  private readonly mono0: bigint;
  private readonly monoNowFn: () => number;

  constructor(dataDir: string, now: () => number = Date.now, monoNow?: () => number) {
    this.dataDir = dataDir;
    this.journalPath = join(dataDir, 'journal.ndjson');
    this.snapshotPath = join(dataDir, 'state.json');
    this.bootUtcMs = now();
    this.mono0 = process.hrtime.bigint();
    this.monoNowFn = monoNow ?? (() => Number((process.hrtime.bigint() - this.mono0) / 1_000_000n));
    this.runId = `${this.bootUtcMs.toString(36)}-${randomBytes(4).toString('hex')}`;
    mkdirSync(dataDir, { recursive: true });
    this.replay();
    this.journalFd = openSync(this.journalPath, 'a');
  }

  /** Monotonic ms within THIS run instance; never comparable across runs. */
  monoNow(): number {
    return this.monoNowFn();
  }

  newReceiveRec(utcMs: number): ReceiveRec {
    return { runId: this.runId, mono: this.monoNow(), utc: utcMs };
  }

  private replay(): void {
    if (!existsSync(this.journalPath)) return;
    const raw = readFileSync(this.journalPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.apply(JSON.parse(trimmed) as JournalEntry);
    }
  }

  /** Append (fsync) + apply + snapshot. Synchronous by design (§5). */
  record(entry: JournalEntry): void {
    if (this.journalFd === null) throw new Error('store is closed');
    const line = JSON.stringify(entry) + '\n';
    const buf = Buffer.from(line, 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(this.journalFd, buf, off);
    fsyncSync(this.journalFd);
    this.apply(entry);
    this.writeSnapshot();
  }

  private apply(entry: JournalEntry): void {
    switch (entry.t) {
      case 'challenge':
        this.challenges.set(entry.c.nonce, { ...entry.c });
        break;
      case 'consume': {
        const c = this.challenges.get(entry.nonce);
        if (c) c.consumed = true;
        break;
      }
      case 'bind': {
        let s = this.sessions.get(entry.key);
        if (!s) {
          s = {
            key: entry.key,
            chainId: entry.chainId,
            contract: entry.contract.toLowerCase(),
            sessionId: entry.sessionId,
            mode: entry.mode,
            staker: entry.staker,
            partner: entry.partner,
            participants: {},
            window: null,
            arming: null,
            events: {},
            seenEventIds: {},
            violation: null,
            anomaly: null,
            judgment: null,
            judgedAtMs: null,
            refusal: null,
            attestation: null,
          };
          this.sessions.set(entry.key, s);
        }
        const p = (s.participants[entry.participant] ??= newParticipant(entry.participant));
        if (entry.revokedTokenHash) this.tokens.delete(entry.revokedTokenHash);
        if (!p.bound) {
          p.bound = true;
          p.boundAtMs = entry.boundAtMs;
        }
        p.tokenHash = entry.tokenHash;
        this.tokens.set(entry.tokenHash, { sessionKey: entry.key, participant: entry.participant });
        break;
      }
      case 'hb': {
        // Coverage record (journaled for every accepted heartbeat): gap
        // analysis replays exactly these records, so live and post-restart
        // scoring agree.
        const p = this.participantOf(entry.key, entry.participant);
        if (p) {
          p.heartbeats.push(entry.rec);
          p.lastHbWatermarkMs = entry.rec.utc;
        }
        break;
      }
      case 'seq': {
        // Anti-replay watermark (every accepted heartbeat, AC-30).
        const p = this.participantOf(entry.key, entry.participant);
        if (p && entry.seq > p.highestSeq) {
          p.highestSeq = entry.seq;
          p.ready = true;
        }
        break;
      }
      case 'hbd':
        // Discarded arrival (replay/reorder): journaled for diagnostics only.
        break;
      case 'ev': {
        const s = this.sessions.get(entry.key);
        if (!s) break;
        const seen = (s.seenEventIds[entry.participant] ??= []);
        if (!seen.includes(entry.eventId)) {
          seen.push(entry.eventId);
          (s.events[entry.participant] ??= []).push({
            eventId: entry.eventId,
            type: entry.type,
            rec: entry.rec,
          });
        }
        break;
      }
      case 'arm': {
        const s = this.sessions.get(entry.key);
        if (s && !s.window) s.arming = { txHash: entry.txHash, from: entry.from, noticedAtMs: entry.noticedAtMs };
        break;
      }
      case 'disarm': {
        const s = this.sessions.get(entry.key);
        if (s) s.arming = null;
        break;
      }
      case 'window': {
        const s = this.sessions.get(entry.key);
        if (s && !s.window) {
          s.window = { startTime: entry.startTime, endTime: entry.endTime, settlementDeadline: entry.settlementDeadline };
          s.arming = null;
        }
        break;
      }
      case 'violation': {
        const s = this.sessions.get(entry.key);
        if (s && !s.violation) {
          s.violation = { participant: entry.participant, reason: entry.reason, atMs: entry.atMs };
        }
        break;
      }
      case 'anomaly': {
        const s = this.sessions.get(entry.key);
        if (s && !s.anomaly) {
          s.anomaly = { reason: entry.reason, detail: entry.detail, atMs: entry.atMs };
        }
        break;
      }
      case 'judgment': {
        const s = this.sessions.get(entry.key);
        if (s && !s.judgment) {
          s.judgment = entry.result;
          s.judgedAtMs = entry.atMs;
        }
        break;
      }
      case 'refused': {
        const s = this.sessions.get(entry.key);
        if (s) s.refusal = { reason: entry.reason, atMs: entry.atMs };
        break;
      }
      case 'attestation': {
        const s = this.sessions.get(entry.key);
        if (s) s.attestation = entry.attestation;
        break;
      }
    }
  }

  participantOf(key: string, address: string): ParticipantRec | undefined {
    return this.sessions.get(key)?.participants[address];
  }

  private writeSnapshot(): void {
    const doc: Snapshot = {
      version: 1,
      sessions: Object.fromEntries(this.sessions),
      challenges: Object.fromEntries(this.challenges),
    };
    const tmp = `${this.snapshotPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2));
    renameSync(tmp, this.snapshotPath);
  }

  close(): void {
    if (this.journalFd !== null) {
      fsyncSync(this.journalFd);
      closeSync(this.journalFd);
      this.journalFd = null;
    }
  }
}
