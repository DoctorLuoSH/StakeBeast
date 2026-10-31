/**
 * ProofTracker — framework-free client state machine for the attester
 * protocol (DAPP-35). Owns the binding, the 5 s heartbeat loop (strictly
 * increasing seq, `nextHeartbeatSeq` adopted from the service after any
 * resync so the anti-replay watermark survives reconnects), the status poll
 * that imports the service-confirmed proof state, and visibility-event
 * reporting. React wiring lives in `useProofTracking`.
 *
 * Semantics mirrored from the frozen rules (attester README §Judgment):
 *  - a service-confirmed violation is permanent — heartbeats stop, recovery
 *    never clears it;
 *  - a 401 means this token was revoked by a newer bind (single-client
 *    takeover) — all loops stop until the user takes tracking back;
 *  - transport failures never move the seq: the loop retries on cadence and
 *    resyncs `nextHeartbeatSeq` from the status payload;
 *  - out-of-window heartbeats change nothing, so the loop stops once the
 *    chain window end has passed; the status poll then carries the judgment.
 */

import { ProofServiceError } from "./proofClient";
import type { ProofBinding, ProofClient, ProofLifecycle, ProofParticipant } from "./proofClient";

export type ProofPhase = "unbound" | "binding" | "tracking" | "takeover" | "ended";

export interface ProofTrackState {
  phase: ProofPhase;
  /** Last lifecycle reported by the service (bind / arm / status). */
  lifecycle: ProofLifecycle | null;
  /** Service-confirmed violation (permanent). */
  violation: boolean;
  /** Local hidden signal, shown before the service confirms the event. */
  localHidden: boolean;
  /** Clean coverage confirmed — the attestation can be fetched. */
  attestationReady: boolean;
  /** Platform-side fault (e.g. restart gap) — no attestation, no user fault. */
  uncertifiable: boolean;
  /** Last request failed on transport — the loop keeps retrying. */
  unreachable: boolean;
  /** Human-readable last protocol/bind error (e.g. signature rejected). */
  error: string | null;
  /** Last heartbeat seq the service acknowledged (UI liveness indicator). */
  lastAckSeq: number;
  participants: ProofParticipant[];
}

export const INITIAL_TRACK_STATE: ProofTrackState = {
  phase: "unbound",
  lifecycle: null,
  violation: false,
  localHidden: false,
  attestationReady: false,
  uncertifiable: false,
  unreachable: false,
  error: null,
  lastAckSeq: 0,
  participants: [],
};

export interface ProofTrackerOptions {
  /**
   * One call performing challenge → sign → bind and returning the binding
   * plus a ready Bearer client (revokes any previous token server-side).
   */
  bindSession: () => Promise<{ binding: ProofBinding; client: ProofClient }>;
  heartbeatMs?: number;
  statusMs?: number;
  /** Chain window end in ms once known on-chain; null before the start. */
  windowEndMs?: () => number | null;
  onChange: (state: ProofTrackState) => void;
}

export interface ProofTracker {
  readonly state: ProofTrackState;
  /** Bind (or re-bind after takeover). Resolves false on failure. */
  bind(): Promise<boolean>;
  /** Announce a broadcast startSession tx hash (arming notice). */
  notifyStarted(txHash: string): void;
  /** visibilitychange handlers — safe no-ops while unbound. */
  reportHidden(): void;
  reportVisible(): void;
  /** Stop every loop; terminal. */
  stop(): void;
}

export function createProofTracker(opts: ProofTrackerOptions): ProofTracker {
  const heartbeatMs = opts.heartbeatMs ?? 5000;
  const statusMs = opts.statusMs ?? 10_000;

  let state: ProofTrackState = { ...INITIAL_TRACK_STATE };
  let client: ProofClient | null = null;
  let nextSeq = 1;
  let binding = false;
  let stopped = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  const emit = () => {
    state = { ...state };
    opts.onChange(state);
  };

  /** Final proof state reached (judgment / refusal) — every loop stops. */
  const isFinal = (lifecycle: ProofLifecycle | null): boolean =>
    lifecycle === "clean" ||
    lifecycle === "violation" ||
    lifecycle === "uncertifiable" ||
    lifecycle === "refused" ||
    lifecycle === "attested";

  const applyFailure = (err: unknown) => {
    if (err instanceof ProofServiceError && err.kind === "revoked") {
      client = null;
      state = { ...state, phase: "takeover", unreachable: false, error: err.message };
      return "takeover" as const;
    }
    if (err instanceof ProofServiceError && err.kind === "unavailable") {
      state = { ...state, unreachable: true };
    } else {
      state = { ...state, error: err instanceof Error ? err.message : String(err) };
    }
    return "retry" as const;
  };

  const markViolation = () => {
    // Permanent: heartbeats stop at once; the status poll carries the
    // eventual judgment so the UI can settle on the final wording.
    stopHeartbeatLoop();
    state = { ...state, violation: true };
  };

  const applyStatus = async () => {
    if (!client) return;
    try {
      const s = await client.status();
      const ownViolation = s.participants.some((p) => p.violation !== null);
      state = {
        ...state,
        lifecycle: s.lifecycle,
        attestationReady: state.attestationReady || s.attestationReady,
        uncertifiable: state.uncertifiable || s.lifecycle === "uncertifiable",
        unreachable: false,
        error: null,
        participants: s.participants,
      };
      // Cross-reconnect resume: never beat with a seq the service would drop
      // as a replay (AC-30).
      if (s.nextHeartbeatSeq > nextSeq) nextSeq = s.nextHeartbeatSeq;
      // The judgment is authoritative too: a judged violation marks the
      // state even when no heartbeat/event response carried the flag first.
      // A refusal without a participant violation is a platform-side fault
      // (unreliable_time / uncertifiable), never a user violation.
      if ((ownViolation || s.lifecycle === "violation") && !state.violation) {
        markViolation();
      } else if (s.lifecycle === "refused" && !ownViolation) {
        state = { ...state, uncertifiable: true };
      }
      if (state.attestationReady || isFinal(s.lifecycle)) {
        stopAllLoops();
        state = { ...state, phase: "ended" };
      }
    } catch (err) {
      if (applyFailure(err) === "takeover") {
        stopAllLoops();
        emit();
        return;
      }
    }
    emit();
    scheduleStatus();
  };

  const beat = async () => {
    if (!client || stopped) return;
    const endMs = opts.windowEndMs?.() ?? null;
    if (state.violation || state.attestationReady || (endMs !== null && Date.now() > endMs)) {
      // Out-of-window beats change nothing (frozen rule); the status poll
      // carries the judgment from here.
      stopHeartbeatLoop();
      return;
    }
    try {
      const { violation } = await client.heartbeat(nextSeq);
      state = { ...state, lastAckSeq: nextSeq, unreachable: false, error: null };
      nextSeq += 1;
      if (violation) markViolation();
    } catch (err) {
      if (applyFailure(err) === "takeover") {
        stopAllLoops();
        emit();
        return;
      }
      // Transport failure: seq NOT incremented — retry with the same seq on
      // cadence (only strictly-increasing seq refreshes liveness server-side).
    }
    emit();
    if (!state.violation) scheduleHeartbeat();
  };

  const scheduleHeartbeat = () => {
    if (stopped || heartbeatTimer !== null) return;
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      void beat();
    }, heartbeatMs);
  };

  const scheduleStatus = () => {
    if (stopped || statusTimer !== null || state.phase === "ended" || state.phase === "takeover") {
      return;
    }
    statusTimer = setTimeout(() => {
      statusTimer = null;
      void applyStatus();
    }, statusMs);
  };

  const stopHeartbeatLoop = () => {
    if (heartbeatTimer !== null) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const stopAllLoops = () => {
    stopHeartbeatLoop();
    if (statusTimer !== null) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
  };

  // Publish the initial state so a fresh tracker replaces any stale output
  // from a previous identity on the subscriber.
  emit();

  return {
    get state() {
      return state;
    },

    async bind() {
      if (binding) return false;
      if (client && state.phase === "tracking") return true; // already bound
      binding = true;
      state = { ...state, phase: "binding", error: null };
      emit();
      try {
        const { binding: b, client: c } = await opts.bindSession();
        client = c;
        nextSeq = b.nextHeartbeatSeq;
        state = {
          ...state,
          phase: "tracking",
          lifecycle: b.lifecycle,
          error: null,
          unreachable: false,
        };
        emit();
        scheduleHeartbeat();
        scheduleStatus();
        return true;
      } catch (err) {
        client = null;
        const message =
          err instanceof ProofServiceError
            ? err.message
            : `Binding failed: ${err instanceof Error ? err.message : String(err)}`;
        state = { ...state, phase: "unbound", error: message };
        emit();
        return false;
      } finally {
        binding = false;
      }
    },

    notifyStarted(txHash) {
      if (!client || stopped) return;
      const attempt = async (retries: number) => {
        if (!client || stopped) return;
        try {
          const lifecycle = await client.arm(txHash);
          state = { ...state, lifecycle, unreachable: false };
        } catch (err) {
          if (applyFailure(err) === "takeover") {
            stopAllLoops();
            emit();
            return;
          }
          // The chain watcher learns the window anyway — one retry is enough.
          if (retries > 0) {
            setTimeout(() => void attempt(retries - 1), 3000);
            return;
          }
        }
        emit();
      };
      void attempt(1);
    },

    reportHidden() {
      if (!client || stopped) return; // unbound: nothing to report, no warning
      state = { ...state, localHidden: true };
      emit();
      void client
        .event(crypto.randomUUID(), "visibility_hidden")
        .then(({ violation }) => {
          if (violation) markViolation();
          emit();
        })
        .catch((err) => {
          if (applyFailure(err) === "takeover") stopAllLoops();
          emit();
        });
    },

    reportVisible() {
      if (!client || stopped) return;
      void client
        .event(crypto.randomUUID(), "visibility_visible")
        .then(() => emit())
        .catch((err) => {
          if (applyFailure(err) === "takeover") stopAllLoops();
          emit();
        });
    },

    stop() {
      stopped = true;
      client = null;
      stopAllLoops();
    },
  };
}
