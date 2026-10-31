/**
 * useProofTracking — React wiring for the ProofTracker (DAPP-35).
 *
 * Enabled only for machine-proof sessions (solo / co-focus) viewed by a
 * participant with the proof service configured. The tracker is created once
 * per (session, account) identity so a re-render or session refetch never
 * drops the binding; it is torn down when the session turns terminal.
 *
 * Resume semantics: an already-Active session auto-binds once on mount (one
 * wallet signature) — the service answers with `nextHeartbeatSeq`, so the
 * loop resumes exactly where the previous client left off. A Pending session
 * binds explicitly through the start flow / the tracking CTA instead.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { EXPECTED_CHAIN_ID } from "../config/chains";
import { contractAddress, proofServiceUrl } from "../config/env";
import { isMachineProof, isTerminal } from "../contract/sessionView";
import { Status } from "../contract/types";
import type { Session } from "../contract/types";
import { bindProofSession, createProofClient } from "./proofClient";
import { createProofTracker, INITIAL_TRACK_STATE } from "./proofTracker";
import type { ProofTracker, ProofTrackState } from "./proofTracker";

export interface UseProofTrackingArgs {
  session: Session | null;
  sessionId: bigint;
  account: string | null;
  /** personal_sign over the bind challenge; null without a wallet provider. */
  signMessage: ((message: string) => Promise<string>) | null;
}

export interface UseProofTracking {
  enabled: boolean;
  state: ProofTrackState;
  bind: () => Promise<boolean>;
  notifyStarted: (txHash: string) => void;
}

export function useProofTracking({
  session,
  sessionId,
  account,
  signMessage,
}: UseProofTrackingArgs): UseProofTracking {
  const [trackedState, setTrackedState] = useState<ProofTrackState>(INITIAL_TRACK_STATE);
  const trackerRef = useRef<ProofTracker | null>(null);
  const sessionRef = useRef<Session | null>(null);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const enabled =
    !!session &&
    !!account &&
    !!signMessage &&
    !!proofServiceUrl &&
    isMachineProof(session.mode) &&
    !isTerminal(session.status) &&
    (session.staker.toLowerCase() === account.toLowerCase() ||
      session.partner.toLowerCase() === account.toLowerCase());

  useEffect(() => {
    if (!enabled || !account || !signMessage) {
      trackerRef.current = null;
      return undefined;
    }
    const tracker = createProofTracker({
      bindSession: async () => {
        const binding = await bindProofSession({
          baseUrl: proofServiceUrl,
          chainId: EXPECTED_CHAIN_ID,
          contractAddress,
          sessionId,
          address: account,
          signMessage,
        });
        const client = createProofClient({
          baseUrl: proofServiceUrl,
          chainId: EXPECTED_CHAIN_ID,
          contractAddress,
          sessionId,
          token: binding.clientToken,
        });
        return { binding, client };
      },
      windowEndMs: () => {
        const s = sessionRef.current;
        return s && s.startTime > 0 ? s.endTime * 1000 : null;
      },
      onChange: setTrackedState,
    });
    trackerRef.current = tracker;
    return () => {
      tracker.stop();
      trackerRef.current = null;
    };
  }, [enabled, sessionId, account, signMessage]);

  // Resume tracking for an already-running session: bind once, automatically.
  // A bind failure sets state.error, which blocks the retry loop — the
  // tracking CTA stays available for a manual retry.
  useEffect(() => {
    if (
      enabled &&
      session?.status === Status.Active &&
      trackedState.phase === "unbound" &&
      trackedState.error === null
    ) {
      void trackerRef.current?.bind();
    }
  }, [enabled, session?.status, trackedState.phase, trackedState.error]);

  // Visibility events → the proof service (in-window hidden = violation).
  useEffect(() => {
    if (!enabled) return undefined;
    const onVisibility = () => {
      const tracker = trackerRef.current;
      if (!tracker) return;
      if (document.hidden) tracker.reportHidden();
      else tracker.reportVisible();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [enabled]);

  const bind = useCallback(() => trackerRef.current?.bind() ?? Promise.resolve(false), []);
  const notifyStarted = useCallback(
    (txHash: string) => trackerRef.current?.notifyStarted(txHash),
    [],
  );

  // Stale tracker output is masked while tracking is disabled.
  return { enabled, state: enabled ? trackedState : INITIAL_TRACK_STATE, bind, notifyStarted };
}
