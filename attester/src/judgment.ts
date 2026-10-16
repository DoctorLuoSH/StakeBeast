/**
 * Heartbeat judgment core (baseline v1.4, decision D2 / section 4.1).
 *
 * Frozen rules implemented here:
 *  - Server time is authoritative; the same event sequence yields one unique result.
 *  - Client heartbeats every 5s (cadence is informational; judgment is gap-based).
 *  - A page-hidden event (visibilitychange hidden) marks a violation immediately.
 *  - Without a hidden event, a heartbeat interruption of AT MOST 15s is tolerated;
 *    beyond that the session is marked in violation.
 *  - Recovery NEVER clears a marked violation.
 *  - Interruption reason (refresh / close / network drop) is irrelevant: only the
 *    interruption duration matters.
 *  - Binding: the client must bind within 5 minutes after startTime; a session not
 *    bound in time (or bound after the task has ended) can never receive a proof
 *    (fail-closed; AC-16).
 *  - A proof may only be issued for a clean session once the full declared duration
 *    [startTime, endTime] has elapsed (AC-16).
 *
 * All functions are pure and take `now` (ms epoch) explicitly so tests are
 * deterministic and behavior does not depend on the wall clock.
 */

/** D2: tolerated heartbeat interruption window. */
export const HEARTBEAT_GRACE_MS = 15_000;

/** Baseline section 3/4: client must bind within 5 minutes after startTime. */
export const BIND_WINDOW_MS = 5 * 60_000;

/** Informational client cadence (baseline 4.1). Not enforced as an exact interval. */
export const HEARTBEAT_CADENCE_MS = 5_000;

export type ViolationReason = 'hidden' | 'heartbeat_timeout' | 'bind_timeout';

/** Persisted judgment state for one monitored session (baseline section 6). */
export interface SessionState {
  sessionId: string;
  /** Participant (session creator) address, lowercase. */
  participant: string;
  /** ms epoch; on-chain `startSession` confirmation time. */
  startTime: number;
  /** Declared duration in ms; endTime = startTime + durationMs. */
  durationMs: number;
  /** ms epoch when the client bound, null until bound. */
  bindTime: number | null;
  /** ms epoch of the last accepted heartbeat; initialized to bindTime on bind. */
  lastHeartbeatAt: number | null;
  /** Violation marker; once set it is permanent (recovery never clears it). */
  violation: ViolationReason | null;
  /** ms epoch at which the violation occurred (deterministic, see below). */
  violatedAt: number | null;
  /** Whether a completion proof has already been issued. */
  issued: boolean;
}

export const endTime = (s: Pick<SessionState, 'startTime' | 'durationMs'>): number =>
  s.startTime + s.durationMs;

export const createSession = (
  sessionId: string,
  participant: string,
  startTime: number,
  durationMs: number,
): SessionState => ({
  sessionId,
  participant: participant.toLowerCase(),
  startTime,
  durationMs,
  bindTime: null,
  lastHeartbeatAt: null,
  violation: null,
  violatedAt: null,
  issued: false,
});

/** Monitoring covers [startTime, endTime]; silence past endTime is out of scope. */
const monitoredNow = (s: SessionState, now: number): number => Math.min(now, endTime(s));

const withViolation = (s: SessionState, reason: ViolationReason, at: number): SessionState =>
  s.violation ? s : { ...s, violation: reason, violatedAt: at };

/**
 * Apply timeout judgment as of `now`: if the session is bound, clean, and the gap
 * since the last heartbeat exceeds 15s inside the monitoring window, mark a
 * heartbeat_timeout violation dated exactly at lastHeartbeatAt + 15s — so the same
 * event sequence produces the same result regardless of when this is evaluated.
 * Idempotent; never clears an existing violation.
 */
export function evaluate(s: SessionState, now: number): SessionState {
  if (s.violation || s.bindTime === null || s.lastHeartbeatAt === null) return s;
  const gap = monitoredNow(s, now) - s.lastHeartbeatAt;
  if (gap > HEARTBEAT_GRACE_MS) {
    return withViolation(s, 'heartbeat_timeout', s.lastHeartbeatAt + HEARTBEAT_GRACE_MS);
  }
  return s;
}

export type BindResult =
  | { ok: true; state: SessionState }
  | { ok: false; reason: 'wrong_participant' | 'bind_window_expired' | 'already_violated'; state: SessionState };

/**
 * Bind a client to the session. Allowed only while now <= startTime + 5min AND
 * now <= endTime: a session bound late (or after the task ended) can never receive
 * a proof, so a late attempt is recorded as a permanent bind_timeout violation
 * (fail-closed, restart-safe). Re-binding while already bound is idempotent.
 */
export function recordBind(s: SessionState, participant: string, now: number): BindResult {
  const p = participant.toLowerCase();
  if (p !== s.participant) return { ok: false, reason: 'wrong_participant', state: s };
  if (s.bindTime !== null) return { ok: true, state: s };
  if (s.violation) return { ok: false, reason: 'already_violated', state: s };
  if (now > s.startTime + BIND_WINDOW_MS || now > endTime(s)) {
    return { ok: false, reason: 'bind_window_expired', state: withViolation(s, 'bind_timeout', now) };
  }
  return { ok: true, state: { ...s, bindTime: now, lastHeartbeatAt: now } };
}

export type EventResult =
  | { ok: true; state: SessionState }
  | { ok: false; reason: 'not_bound' | 'wrong_participant'; state: SessionState };

const checkEvent = (s: SessionState, participant: string): 'not_bound' | 'wrong_participant' | null => {
  if (s.bindTime === null) return 'not_bound';
  if (participant.toLowerCase() !== s.participant) return 'wrong_participant';
  return null;
};

/**
 * Record a heartbeat. The timeout check runs against the state BEFORE this
 * heartbeat, so a heartbeat arriving after a >15s silence marks the violation
 * (dated at lastHeartbeatAt + 15s) instead of washing it away; afterwards the
 * heartbeat is accepted and lastHeartbeatAt advances — but a marked violation
 * stays marked (recovery never clears, D2).
 */
export function recordHeartbeat(s: SessionState, participant: string, now: number): EventResult {
  const err = checkEvent(s, participant);
  if (err) return { ok: false, reason: err, state: s };
  const judged = evaluate(s, now);
  return { ok: true, state: { ...judged, lastHeartbeatAt: now } };
}

/**
 * Record a page-hidden event: immediate violation (D2). The first violation wins,
 * keeping the result deterministic. Hidden events after endTime are ignored —
 * monitoring is over and the verdict is already settled.
 */
export function recordHidden(s: SessionState, participant: string, now: number): EventResult {
  const err = checkEvent(s, participant);
  if (err) return { ok: false, reason: err, state: s };
  const judged = evaluate(s, now);
  if (now > endTime(judged)) return { ok: true, state: judged };
  return { ok: true, state: withViolation(judged, 'hidden', now) };
}

/**
 * Whether the service may issue a completion proof as of `now`: the session must
 * be bound, violation-free after final judgment, the full declared duration must
 * have elapsed, and no proof has been issued yet. This is the fail-closed gate;
 * the EIP-712 message fields themselves are frozen in DAPP-2 (see signer.ts).
 */
export function canIssueProof(s: SessionState, now: number): boolean {
  const judged = evaluate(s, now);
  return judged.bindTime !== null && judged.violation === null && !judged.issued && now >= endTime(judged);
}
