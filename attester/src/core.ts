/**
 * Attester core — session lifecycle and protocol logic (attester-service §3).
 *
 * Owns: one-time bind challenges, token issuance/takeover, arming validation,
 * heartbeat/event intake with seq + eventId discipline, window learning from
 * the chain, live sweeping, final coverage judgment, EIP-712 attestation
 * issuance (signing gate + clock health), and restart recovery.
 *
 * Fail-closed throughout: any doubt (missing coverage, restart gap, clock
 * anomaly, stale chain data) means no signature. The service never moves
 * funds; refusal on-chain is silent — the session becomes forfeitable after
 * its settlement deadline, and platform faults route to the admin-void
 * procedure (§7).
 */

import { createHash, randomBytes } from 'node:crypto';
import { ethers } from 'ethers';
import {
  BIND_WINDOW_MS,
  CHALLENGE_TTL_MS,
  CLOCK_SKEW_TOLERANCE_MS,
  HEARTBEAT_GRACE_MS,
  sessionKey,
  type AnomalyReason,
  type AttesterStore,
  type ChallengeRec,
  type Judgment,
  type ParticipantRec,
  type RefusalReason,
  type SessionLifecycle,
  type SessionRec,
} from './store';
import { scoreCoverage } from './scoring';
import { Mode, Status, type ChainClient } from './chain';
import { buildTypedData, type AttestationSigner, type TypedData } from './signer';

/** Fresh chain data required at signing: latest block may lag at most this. */
export const BLOCK_MAX_AGE_MS = 120_000;
/** Arm notice expires when the named tx neither confirms nor is replaced. */
export const ARM_TX_TIMEOUT_MS = 180_000;

export type ErrCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'too_late'
  | 'refused'
  | 'pending'
  | 'challenge_expired'
  | 'nonce_used'
  | 'internal';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrCode,
    message: string,
  ) {
    super(message);
  }
}

export interface AuthContext {
  session: SessionRec;
  participant: ParticipantRec;
}

export interface CoreOpts {
  chainId: number;
  contractAddress: string;
  now?: () => number;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SESSION_ID_RE = /^[0-9]+$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;
const EVENT_TYPES = new Set(['visibility_hidden', 'visibility_visible', 'client_shutdown']);

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const rfc3339 = (ms: number): string => new Date(ms).toISOString();

export class AttesterCore {
  readonly chainId: number;
  readonly contractAddress: string; // lowercase
  private readonly nowFn: () => number;

  constructor(
    readonly store: AttesterStore,
    readonly chain: ChainClient,
    readonly signer: AttestationSigner,
    opts: CoreOpts,
  ) {
    this.chainId = opts.chainId;
    this.contractAddress = opts.contractAddress.toLowerCase();
    this.nowFn = opts.now ?? Date.now;
  }

  private now(): number {
    return this.nowFn();
  }

  // ---------------------------------------------------------------- auth --

  /** §3.1.1 — issue a single-use, 5-minute bind challenge. */
  createChallenge(body: Record<string, unknown>): { nonce: string; message: string; expiresAt: string } {
    const chainId = Number(body.chainId);
    const contract = typeof body.contract === 'string' ? body.contract : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : String(body.sessionId ?? '');
    const address = typeof body.address === 'string' ? body.address : '';
    if (!Number.isInteger(chainId) || chainId <= 0) throw new ApiError(400, 'bad_request', 'chainId must be a positive integer');
    if (!ADDRESS_RE.test(contract)) throw new ApiError(400, 'bad_request', 'contract must be a 0x address');
    if (!SESSION_ID_RE.test(sessionId)) throw new ApiError(400, 'bad_request', 'sessionId must be a decimal string');
    if (!ADDRESS_RE.test(address)) throw new ApiError(400, 'bad_request', 'address must be a 0x address');
    if (chainId !== this.chainId) throw new ApiError(400, 'bad_request', `chainId mismatch: this service attests chain ${this.chainId}`);
    if (contract.toLowerCase() !== this.contractAddress) {
      throw new ApiError(400, 'bad_request', 'contract mismatch: not the configured StakeBeast deployment');
    }

    const now = this.now();
    const nonce = randomBytes(5).toString('hex');
    const issued = rfc3339(now);
    const expiresAtMs = now + CHALLENGE_TTL_MS;
    const message =
      `StakeBeast bind\nChain: ${chainId}\nContract: ${ethers.getAddress(contract)}\n` +
      `Session: ${sessionId}\nAddress: ${ethers.getAddress(address)}\nNonce: ${nonce}\nIssued: ${issued}`;
    const c: ChallengeRec = {
      nonce,
      chainId,
      contract: contract.toLowerCase(),
      sessionId,
      address: address.toLowerCase(),
      message,
      issuedAtMs: now,
      expiresAtMs,
      consumed: false,
    };
    this.store.record({ t: 'challenge', c });
    return { nonce, message, expiresAt: rfc3339(expiresAtMs) };
  }

  /** §3.1.2–4 — verify challenge signature + on-chain participant, issue token. */
  async bind(body: Record<string, unknown>): Promise<{ clientToken: string; status: SessionLifecycle; nextHeartbeatSeq: number }> {
    const chainId = Number(body.chainId);
    const contract = typeof body.contract === 'string' ? body.contract : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : String(body.sessionId ?? '');
    const address = typeof body.address === 'string' ? body.address : '';
    const nonce = typeof body.nonce === 'string' ? body.nonce : '';
    const bindSig = typeof body.bindSig === 'string' ? body.bindSig : '';
    if (!Number.isInteger(chainId) || !ADDRESS_RE.test(contract) || !SESSION_ID_RE.test(sessionId) || !ADDRESS_RE.test(address)) {
      throw new ApiError(400, 'bad_request', 'expected {chainId, contract, sessionId, address, nonce, bindSig}');
    }
    if (!nonce || !HEX_RE.test(bindSig)) throw new ApiError(400, 'bad_request', 'nonce and 0x bindSig are required');

    // Consume the challenge on the FIRST verify attempt, success or failure.
    const challenge = this.store.challenges.get(nonce);
    if (!challenge) throw new ApiError(401, 'challenge_expired', 'unknown or expired challenge');
    if (challenge.consumed) throw new ApiError(401, 'nonce_used', 'challenge nonce already consumed');
    this.store.record({ t: 'consume', nonce });
    const now = this.now();
    if (now > challenge.expiresAtMs) throw new ApiError(401, 'challenge_expired', 'challenge expired');
    if (
      challenge.chainId !== chainId ||
      challenge.contract !== contract.toLowerCase() ||
      challenge.sessionId !== sessionId ||
      challenge.address !== address.toLowerCase()
    ) {
      throw new ApiError(401, 'unauthorized', 'challenge does not match the bind request');
    }
    let recovered: string;
    try {
      recovered = ethers.verifyMessage(challenge.message, bindSig);
    } catch {
      throw new ApiError(401, 'unauthorized', 'invalid bind signature');
    }
    if (recovered.toLowerCase() !== address.toLowerCase()) {
      throw new ApiError(401, 'unauthorized', 'signature does not recover the claimed address');
    }

    // On-chain verification: session exists, machine-proof, non-terminal,
    // caller is a participant; chainId/contract match the deployment.
    const cs = await this.getChainSession(sessionId);
    if (!cs) throw new ApiError(404, 'not_found', 'session not found on-chain');
    if (cs.mode !== Mode.SoloFocus && cs.mode !== Mode.CoFocus) {
      throw new ApiError(400, 'bad_request', 'session is not a machine-proof mode');
    }
    if (cs.status !== Status.Pending && cs.status !== Status.Active) {
      throw new ApiError(409, 'refused', 'session is terminal on-chain');
    }
    const who = address.toLowerCase();
    const isStaker = who === cs.staker.toLowerCase();
    const isPartner = cs.mode === Mode.CoFocus && who === cs.partner.toLowerCase();
    if (!isStaker && !isPartner) throw new ApiError(401, 'unauthorized', 'address is not a session participant');

    const key = sessionKey(this.chainId, contract, sessionId);
    const existing = this.store.sessions.get(key);
    const participant = existing?.participants[who];
    const firstBind = !participant?.bound;

    if (firstBind && existing?.window) {
      // Late NEW bind once the window is known: permanent fail-closed (§2, AC-21).
      const startMs = existing.window.startTime * 1000;
      if (now > startMs + BIND_WINDOW_MS || now > existing.window.endTime * 1000) {
        if (!existing.violation) {
          this.store.record({ t: 'violation', key, participant: who, reason: 'bind_timeout', atMs: now });
        }
        throw new ApiError(403, 'too_late', 'bind window expired: never attestable (startTime + 5 min)');
      }
    }

    // Clock-health checkpoint at bind (§2): skew flags the session anomalous;
    // refusal then happens at signing. Staleness is judged at signing only.
    await this.clockCheckpoint(key);

    const token = `ctk_${randomBytes(8).toString('hex')}`;
    const tokenHash = sha256(token);
    this.store.record({
      t: 'bind',
      key,
      chainId: this.chainId,
      contract: this.contractAddress,
      sessionId,
      mode: cs.mode,
      staker: cs.staker.toLowerCase(),
      partner: cs.mode === Mode.CoFocus ? cs.partner.toLowerCase() : null,
      participant: who,
      boundAtMs: firstBind ? now : participant!.boundAtMs!,
      tokenHash,
      revokedTokenHash: participant?.tokenHash ?? null,
    });
    const session = this.store.sessions.get(key)!;
    const p = session.participants[who];
    return { clientToken: token, status: this.lifecycleOf(session, now), nextHeartbeatSeq: p.highestSeq + 1 };
  }

  /** Bearer-token authentication; null when unknown/revoked. */
  authenticate(authorization: string | undefined): AuthContext | null {
    if (!authorization?.startsWith('Bearer ')) return null;
    const hash = sha256(authorization.slice('Bearer '.length).trim());
    const binding = this.store.tokens.get(hash);
    if (!binding) return null;
    const session = this.store.sessions.get(binding.sessionKey);
    const participant = session?.participants[binding.participant];
    if (!session || !participant || participant.tokenHash !== hash) return null;
    return { session, participant };
  }

  // ------------------------------------------------------------ protocol --

  /** §3.3 — arm around the startSession transaction. */
  async arm(auth: AuthContext, body: Record<string, unknown>): Promise<{ ok: true; state: SessionLifecycle }> {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : String(body.sessionId ?? '');
    const txHash = typeof body.txHash === 'string' ? body.txHash : '';
    if (sessionId !== auth.session.sessionId) throw new ApiError(400, 'bad_request', 'sessionId does not match the token binding');
    if (!HEX_RE.test(txHash)) throw new ApiError(400, 'bad_request', 'txHash must be 0x hex');
    const now = this.now();

    // A duplicate arm after the start is ignored — it never pauses monitoring.
    if (auth.session.window) return { ok: true, state: this.lifecycleOf(auth.session, now) };

    const tx = await this.chain.getTransaction(txHash);
    if (!tx) throw new ApiError(400, 'bad_request', 'transaction not found on-chain');
    const decodedId = this.chain.decodeStartSession(tx.data);
    if (
      tx.to.toLowerCase() !== this.contractAddress ||
      decodedId !== auth.session.sessionId ||
      tx.from.toLowerCase() !== auth.participant.address
    ) {
      throw new ApiError(400, 'bad_request', 'transaction is not a verifiable startSession for this session and participant');
    }

    const receipt = await this.chain.getTransactionReceipt(txHash);
    if (receipt && receipt.status === 0) {
      // Reverted before start: stay ready, allow retry.
      this.store.record({ t: 'disarm', key: auth.session.key });
      return { ok: true, state: 'ready' };
    }

    this.store.record({ t: 'arm', key: auth.session.key, txHash, from: tx.from.toLowerCase(), noticedAtMs: now });

    // Already confirmed fast? Learn the window immediately.
    await this.maybeLearnWindow(auth.session);
    return { ok: true, state: this.lifecycleOf(auth.session, this.now()) };
  }

  /** §3.4 — heartbeat intake; only strictly-increasing seq refreshes liveness. */
  heartbeat(auth: AuthContext, body: Record<string, unknown>): { ok: true; violation: boolean } {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : String(body.sessionId ?? '');
    const seq = Number(body.seq);
    if (sessionId !== auth.session.sessionId) throw new ApiError(400, 'bad_request', 'sessionId does not match the token binding');
    if (!Number.isInteger(seq) || seq <= 0) throw new ApiError(400, 'bad_request', 'seq must be a positive integer');
    const now = this.now();
    const rec = this.store.newReceiveRec(now);
    const p = auth.participant;
    const key = auth.session.key;

    if (seq > p.highestSeq) {
      // Accepted: journal the anti-replay marker (AC-30 survives restarts
      // exactly) AND the coverage record. Every accepted heartbeat is
      // journaled — gap analysis replays exactly this sequence, so a
      // throttled journal would drop valid coverage and false-flag timeouts
      // (DAPP-20 D1: judgment always sees the complete receive sequence,
      // live and after replay).
      this.store.record({ t: 'seq', key, participant: p.address, seq });
      this.store.record({ t: 'hb', key, participant: p.address, seq, rec });
    } else {
      this.store.record({ t: 'hbd', key, participant: p.address, seq, rec });
    }
    this.sweepSession(auth.session, now);
    return { ok: true, violation: auth.session.violation !== null };
  }

  /** §3.2/§3.4 — page events; eventId dedup, first-sight processing. */
  event(auth: AuthContext, body: Record<string, unknown>): { ok: true; violation: boolean } {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : String(body.sessionId ?? '');
    const eventId = typeof body.eventId === 'string' ? body.eventId : '';
    const type = typeof body.type === 'string' ? body.type : '';
    if (sessionId !== auth.session.sessionId) throw new ApiError(400, 'bad_request', 'sessionId does not match the token binding');
    if (!eventId || eventId.length > 128) throw new ApiError(400, 'bad_request', 'eventId is required');
    if (!EVENT_TYPES.has(type)) throw new ApiError(400, 'bad_request', `type must be one of ${[...EVENT_TYPES].join(', ')}`);
    const now = this.now();
    const rec = this.store.newReceiveRec(now);
    const seen = auth.session.seenEventIds[auth.participant.address] ?? [];
    if (!seen.includes(eventId)) {
      this.store.record({ t: 'ev', key: auth.session.key, participant: auth.participant.address, eventId, type, rec });
    }
    this.sweepSession(auth.session, now);
    return { ok: true, violation: auth.session.violation !== null };
  }

  /** §4 — status payload for the calling participant (participants only). */
  status(auth: AuthContext, sessionId: string, query: Record<string, unknown>): Record<string, unknown> {
    this.assertQueryBinding(auth, sessionId, query);
    const now = this.now();
    this.sweepSession(auth.session, now);
    const s = auth.session;
    return {
      sessionId: s.sessionId,
      state: this.lifecycleOf(s, now),
      participants: Object.values(s.participants)
        .filter((p) => p.bound)
        .map((p) => ({
          address: ethers.getAddress(p.address),
          bound: p.bound,
          boundAt: p.boundAtMs === null ? null : rfc3339(p.boundAtMs),
          ready: p.ready,
          lastHeartbeatAt: p.heartbeats.length ? rfc3339(p.heartbeats[p.heartbeats.length - 1].utc) : null,
          violation: s.violation?.participant === p.address ? s.violation.reason : null,
        })),
      attestationReady: s.attestation !== null || s.judgment === 'clean',
      nextHeartbeatSeq: auth.participant.highestSeq + 1,
    };
  }

  // --------------------------------------------------------- attestation --

  /**
   * §3.5 — signing gate + final coverage check + EIP-712 issuance.
   * Returns the exact typedData that was (re-)signed.
   */
  async attestation(auth: AuthContext, sessionId: string, query: Record<string, unknown>): Promise<{ typedData: unknown; signature: string }> {
    this.assertQueryBinding(auth, sessionId, query);
    const s = auth.session;
    const now = this.now();

    if (!s.window) throw new ApiError(425, 'pending', 'session has not started on-chain');
    const endMs = s.window.endTime * 1000;

    if (s.attestation) {
      // Idempotent re-serve; controlled re-sign after an on-chain rotation (§6).
      const onchainAttester = await this.getChainAttester();
      if (onchainAttester.toLowerCase() === this.signer.address.toLowerCase()) {
        if (s.attestation.signer.toLowerCase() === this.signer.address.toLowerCase()) {
          return this.serveAttestation(s);
        }
        // Our key is now the on-chain attester but the stored version was made
        // under a different key — re-sign only when §6 allows it.
        if (s.judgment === 'clean' && (await this.isResignable(s, now))) {
          return this.signAndStore(s, now);
        }
      }
      return this.serveAttestation(s);
    }

    if (s.refusal) throw new ApiError(409, 'refused', s.refusal.reason);

    // Signing gate: fresh chain data, clock health, chain-confirmed end (§3.5.1).
    const block = await this.getFreshBlockOrFlag(s, now);
    if (block.timestamp * 1000 < endMs) throw new ApiError(425, 'pending', 'endTime not reached on-chain');

    // The session must be non-terminal on-chain for a signature to be usable.
    const cs = await this.getChainSession(s.sessionId);
    if (cs && cs.status !== Status.Active && cs.status !== Status.Pending) {
      const reason: RefusalReason = cs.status === Status.Forfeited ? 'violation' : 'uncertifiable';
      this.recordRefusal(s, reason, now);
      throw new ApiError(409, 'refused', reason);
    }

    // Judgment (final coverage check over the whole window).
    this.sweepSession(s, now);
    if (!s.judgment) this.judge(s, now);
    if (s.judgment !== 'clean') {
      const reason = this.refusalReasonFor(s);
      this.recordRefusal(s, reason, now);
      throw new ApiError(409, 'refused', reason);
    }
    return this.signAndStore(s, now);
  }

  // ------------------------------------------------------- chain watcher --

  /** One poll iteration over all tracked sessions (driver lives in server). */
  async watchOnce(): Promise<void> {
    const now = this.now();
    for (const s of this.store.sessions.values()) {
      try {
        if (!s.window) {
          await this.maybeLearnWindow(s);
          if (s.arming) await this.checkArmingTx(s, now);
        }
        if (s.window && !s.judgment) {
          this.sweepSession(s, now);
          const endMs = s.window.endTime * 1000;
          if (now >= endMs) {
            let block;
            try {
              block = await this.chain.getLatestBlock();
            } catch {
              continue; // RPC hiccup: retry next poll; judgment stays pending.
            }
            if (block.timestamp * 1000 >= endMs) {
              this.sweepSession(s, endMs);
              this.judge(s, now);
            }
          }
        }
      } catch (err) {
        console.warn(`[watch] session ${s.sessionId}: ${(err as Error).message}`);
      }
    }
  }

  /** Learn startTime/endTime from the chain and re-evaluate journaled records. */
  private async maybeLearnWindow(s: SessionRec): Promise<void> {
    const cs = await this.getChainSession(s.sessionId);
    if (!cs || cs.status !== Status.Active || cs.startTime <= 0) return;
    this.store.record({
      t: 'window',
      key: s.key,
      startTime: cs.startTime,
      endTime: cs.endTime,
      settlementDeadline: cs.settlementDeadline,
    });
    // Clock-health checkpoint at start confirmation (§2).
    await this.clockCheckpoint(s.key);
    // Late learning ⇒ re-evaluate journaled arrivals against the chain window
    // (§3.3.4): an in-window hidden event or gap is scored even if it arrived
    // while the service still showed `arming`.
    this.sweepSession(s, this.now());
  }

  private async checkArmingTx(s: SessionRec, now: number): Promise<void> {
    if (!s.arming) return;
    const receipt = await this.chain.getTransactionReceipt(s.arming.txHash).catch(() => null);
    if (receipt && receipt.status === 0) {
      this.store.record({ t: 'disarm', key: s.key });
      return;
    }
    if (!receipt && now - s.arming.noticedAtMs > ARM_TX_TIMEOUT_MS) {
      // Dropped without replacement (a replacement would have started the
      // session and been picked up by maybeLearnWindow): back to ready.
      const cs = await this.getChainSession(s.sessionId).catch(() => null);
      if (!cs || cs.status === Status.Pending) this.store.record({ t: 'disarm', key: s.key });
    }
  }

  // ------------------------------------------------------------ judgment --

  /**
   * Live sweep: apply bind backstop + coverage scoring as of `now` for every
   * required participant. Idempotent; never clears recorded flags.
   */
  sweepSession(s: SessionRec, now: number): void {
    if (!s.window || s.judgment) return; // post-judgment immunity (§3.5.3)
    const startMs = s.window.startTime * 1000;
    const endMs = s.window.endTime * 1000;
    for (const who of this.requiredParticipants(s)) {
      const p = s.participants[who];
      if (!p?.bound) {
        // Fail-closed backstop (§2, AC-21): unbound at startTime + 5 min.
        if (now > startMs + BIND_WINDOW_MS && !s.violation) {
          this.store.record({ t: 'violation', key: s.key, participant: who, reason: 'bind_timeout', atMs: startMs + BIND_WINDOW_MS });
        }
        continue;
      }
      if (p.boundAtMs! > startMs + BIND_WINDOW_MS) {
        // Bound, but late: never attestable; coverage scoring is moot.
        if (!s.violation) {
          this.store.record({ t: 'violation', key: s.key, participant: who, reason: 'bind_timeout', atMs: startMs + BIND_WINDOW_MS });
        }
        continue;
      }
      const score = scoreCoverage(
        p.heartbeats,
        s.events[who] ?? [],
        { startMs, endMs },
        this.store.bootUtcMs,
        this.store.runId,
        now,
      );
      this.applyScore(s, who, score);
    }
  }

  /**
   * Final judgment over the COMPLETE window (§3.5.2): bind-on-time, every
   * inter-heartbeat gap including the tail to endTime, hidden events, restart
   * gaps. Persisted once; afterwards out-of-window arrivals change nothing.
   */
  judge(s: SessionRec, now: number): Judgment {
    if (s.judgment) return s.judgment;
    const startMs = s.window!.startTime * 1000;
    const endMs = s.window!.endTime * 1000;
    for (const who of this.requiredParticipants(s)) {
      const p = s.participants[who];
      if (!p?.bound || p.boundAtMs! > startMs + BIND_WINDOW_MS) {
        if (!s.violation) {
          this.store.record({ t: 'violation', key: s.key, participant: who, reason: 'bind_timeout', atMs: startMs + BIND_WINDOW_MS });
        }
        continue;
      }
      const score = scoreCoverage(
        p.heartbeats,
        s.events[who] ?? [],
        { startMs, endMs },
        this.store.bootUtcMs,
        this.store.runId,
        endMs,
      );
      this.applyScore(s, who, score);
    }
    const result: Judgment = s.violation ? 'violation' : s.anomaly ? 'uncertifiable' : 'clean';
    this.store.record({ t: 'judgment', key: s.key, result, atMs: now });
    return result;
  }

  private applyScore(s: SessionRec, who: string, score: ReturnType<typeof scoreCoverage>): void {
    if (s.judgment) return;
    if (score.kind === 'violation' && !s.violation) {
      this.store.record({ t: 'violation', key: s.key, participant: who, reason: score.reason, atMs: score.atMs });
    } else if (score.kind === 'uncertifiable' && !s.anomaly) {
      this.store.record({ t: 'anomaly', key: s.key, reason: 'restart_gap', detail: 'heartbeat gap spans service downtime', atMs: score.atMs });
    }
  }

  private requiredParticipants(s: SessionRec): string[] {
    const out = [s.staker];
    if (s.mode === Mode.CoFocus && s.partner) out.push(s.partner);
    return out;
  }

  private refusalReasonFor(s: SessionRec): RefusalReason {
    if (s.violation) return s.violation.reason === 'bind_timeout' ? 'late_bind' : 'violation';
    if (s.anomaly) return s.anomaly.reason === 'restart_gap' ? 'uncertifiable' : 'unreliable_time';
    return 'uncertifiable';
  }

  private recordRefusal(s: SessionRec, reason: RefusalReason, now: number): void {
    if (!s.refusal) this.store.record({ t: 'refused', key: s.key, reason, atMs: now });
  }

  private serveAttestation(s: SessionRec): { typedData: unknown; signature: string } {
    return { typedData: s.attestation!.typedData, signature: s.attestation!.signature };
  }

  private async signAndStore(s: SessionRec, now: number): Promise<{ typedData: unknown; signature: string }> {
    const typedData: TypedData = buildTypedData(this.chainId, this.contractAddress, {
      sessionId: s.sessionId,
      staker: ethers.getAddress(s.staker),
      partner: s.partner ? ethers.getAddress(s.partner) : ethers.ZeroAddress,
      startTime: s.window!.startTime,
      endTime: s.window!.endTime,
      expiry: s.window!.settlementDeadline,
    });
    const signature = await this.signer.sign(typedData);
    this.store.record({ t: 'attestation', key: s.key, attestation: { typedData, signature, signer: this.signer.address } });
    if (!s.judgment) this.store.record({ t: 'judgment', key: s.key, result: 'clean', atMs: now });
    return { typedData, signature };
  }

  /** §6 re-sign gate: non-terminal on-chain, inside the settlement window. */
  private async isResignable(s: SessionRec, now: number): Promise<boolean> {
    if (!s.window || now >= s.window.settlementDeadline * 1000) return false;
    const cs = await this.getChainSession(s.sessionId).catch(() => null);
    return !!cs && (cs.status === Status.Active || cs.status === Status.Pending);
  }

  // ---------------------------------------------------------------- misc --

  lifecycleOf(s: SessionRec, now: number): SessionLifecycle {
    if (s.attestation) return 'attested';
    if (s.refusal) return 'refused';
    if (s.judgment) return s.judgment;
    if (s.window) {
      const endMs = s.window.endTime * 1000;
      if (now < endMs) return 'monitoring';
      // Past endTime but not yet judged (watcher pending) — still monitoring.
      return 'monitoring';
    }
    if (s.arming) return 'arming';
    return 'ready';
  }

  private assertQueryBinding(auth: AuthContext, sessionId: string, query: Record<string, unknown>): void {
    if (sessionId !== auth.session.sessionId) throw new ApiError(404, 'not_found', 'unknown session for this token');
    const qChain = Number(query.chainId);
    const qContract = typeof query.contract === 'string' ? query.contract.toLowerCase() : '';
    if (Number.isInteger(qChain) && qChain !== auth.session.chainId) throw new ApiError(404, 'not_found', 'unknown session for this token');
    if (qContract && qContract !== auth.session.contract) throw new ApiError(404, 'not_found', 'unknown session for this token');
  }

  private async getChainSession(sessionId: string) {
    try {
      return await this.chain.getSession(sessionId);
    } catch (err) {
      throw new ApiError(500, 'internal', `chain read failed: ${(err as Error).message}`);
    }
  }

  private async getChainAttester(): Promise<string> {
    try {
      return await this.chain.getAttester();
    } catch (err) {
      throw new ApiError(500, 'internal', `chain read failed: ${(err as Error).message}`);
    }
  }

  /** Clock-health checkpoint (bind / start confirmation): skew flags anomaly. */
  private async clockCheckpoint(key: string): Promise<void> {
    const s = this.store.sessions.get(key);
    if (s?.anomaly) return;
    let block;
    try {
      block = await this.chain.getLatestBlock();
    } catch {
      return; // RPC down: the bind chain-check or the signing gate will surface it.
    }
    const skew = Math.abs(this.now() - block.timestamp * 1000);
    if (skew > CLOCK_SKEW_TOLERANCE_MS && s) {
      this.store.record({
        t: 'anomaly',
        key,
        reason: 'clock_skew',
        detail: `server UTC vs chain time skew ${Math.round(skew / 1000)}s exceeds 30s`,
        atMs: this.now(),
      });
    }
  }

  /**
   * Fresh chain data at signing (§3.5.1): a stale/old block or >30s clock skew
   * is a data-reliability fault — flag the session and refuse (never remap).
   */
  private async getFreshBlockOrFlag(s: SessionRec, now: number) {
    let block;
    try {
      block = await this.chain.getLatestBlock();
    } catch (err) {
      throw new ApiError(500, 'internal', `chain read failed: ${(err as Error).message}`);
    }
    const age = now - block.timestamp * 1000;
    if (age > BLOCK_MAX_AGE_MS) {
      this.flagAnomaly(s, 'stale_chain', `latest block #${block.number} is ${Math.round(age / 1000)}s old`, now);
      this.recordRefusal(s, 'unreliable_time', now);
      throw new ApiError(409, 'refused', 'unreliable_time');
    }
    if (Math.abs(age) > CLOCK_SKEW_TOLERANCE_MS) {
      this.flagAnomaly(s, 'clock_skew', `server UTC vs chain time skew ${Math.round(Math.abs(age) / 1000)}s exceeds 30s`, now);
      this.recordRefusal(s, 'unreliable_time', now);
      throw new ApiError(409, 'refused', 'unreliable_time');
    }
    return block;
  }

  private flagAnomaly(s: SessionRec, reason: AnomalyReason, detail: string, now: number): void {
    if (!s.anomaly) this.store.record({ t: 'anomaly', key: s.key, reason, detail, atMs: now });
  }

  /** Boot recovery: replay already restored state; one synchronous sweep closes the downtime window (§5). */
  recoverOnBoot(): void {
    this.sweepAll();
  }

  /** One sweeper tick over every monitored session (driver lives in server). */
  sweepAll(): void {
    const now = this.now();
    for (const s of this.store.sessions.values()) {
      if (s.window && !s.judgment) this.sweepSession(s, now);
    }
  }
}
