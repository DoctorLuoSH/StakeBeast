/**
 * React bindings for the StakeBeast contract client: build the API over the
 * wallet provider, load one session with event-driven refresh, track the
 * claimable balance and the contract owner.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "../wallet/useWallet";
import { describeContractError } from "./errors";
import { getStakeBeast, isContractConfigured } from "./client";
import type { StakeBeastApi } from "./client";
import type { Session } from "./types";

/**
 * Contract client bound to the connected wallet. `api` is null while the
 * wallet is missing/unconnected/on the wrong chain; `configError` is set when
 * the deployment address was never injected (see .env.example).
 */
export function useStakeBeast(): { api: StakeBeastApi | null; configError: string | null } {
  const { provider, isExpectedChain } = useWallet();
  return useMemo(() => {
    if (!isContractConfigured()) {
      return {
        api: null,
        configError:
          "Contract address not configured. Copy .env.example to .env and set VITE_CONTRACT_ADDRESS.",
      };
    }
    if (!provider || !isExpectedChain) return { api: null, configError: null };
    try {
      return { api: getStakeBeast(provider), configError: null };
    } catch (err) {
      return { api: null, configError: (err as Error).message };
    }
  }, [provider, isExpectedChain]);
}

export interface UseSessionResult {
  session: Session | null;
  /** True until the first load settles (success or error). */
  loading: boolean;
  /** Human-readable load error (e.g. unknown session id); null when fine. */
  error: string | null;
  refresh: () => void;
}

const POLL_MS = 12_000;

/**
 * A fetched value tagged with the exact request identity (the client instance
 * — one per wallet provider/chain — plus the request subject). A snapshot is
 * only ever exposed while its identity still matches the current one, so a
 * late response from a previous session/account/network can never overwrite
 * the current view, and switching the subject reads as `loading` again.
 */
interface SessionSnapshot {
  api: StakeBeastApi;
  sessionId: bigint;
  session: Session | null;
  error: string | null;
}

/**
 * Load one session and keep it fresh: refetch on every session-lifecycle
 * event (SessionStarted anchors the countdown, per the unified status table)
 * with a slow poll as fallback for dropped filter subscriptions.
 *
 * Race safety: each response is keyed by (api, sessionId) and only the latest
 * request may publish, so out-of-order responses — across a session switch,
 * a network switch, or overlapping refreshes of one session — are discarded.
 */
export function useSession(sessionId: bigint | null): UseSessionResult {
  const { api } = useStakeBeast();
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [tick, setTick] = useState(0);
  const seqRef = useRef(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!api || sessionId === null) return undefined;
    let active = true;
    const load = () => {
      const seq = ++seqRef.current;
      api.getSession(sessionId).then(
        (session) => {
          if (active && seq === seqRef.current) {
            setSnapshot({ api, sessionId, session, error: null });
          }
        },
        (err: unknown) => {
          if (active && seq === seqRef.current) {
            setSnapshot({
              api,
              sessionId,
              session: null,
              error: describeContractError(err) ?? "Could not load the session from the chain.",
            });
          }
        },
      );
    };
    load();
    const unsubscribe = api.onSessionActivity(sessionId, load);
    const poll = window.setInterval(load, POLL_MS);
    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(poll);
    };
  }, [api, sessionId, tick]);

  const current =
    snapshot !== null && snapshot.api === api && snapshot.sessionId === sessionId
      ? snapshot
      : null;

  return {
    session: current?.session ?? null,
    loading: current === null,
    error: current?.error ?? null,
    refresh,
  };
}

interface ClaimableSnapshot {
  api: StakeBeastApi;
  account: string;
  claimable: bigint;
}

/** The connected account's pull-payment claimable balance (wei). */
export function useClaimable(): { claimable: bigint | null; refresh: () => void } {
  const { api } = useStakeBeast();
  const { account } = useWallet();
  const [snapshot, setSnapshot] = useState<ClaimableSnapshot | null>(null);
  const [tick, setTick] = useState(0);
  const seqRef = useRef(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!api || !account) return undefined;
    let active = true;
    const load = () => {
      const seq = ++seqRef.current;
      api.claimableOf(account).then(
        (claimable) => {
          if (active && seq === seqRef.current) setSnapshot({ api, account, claimable });
        },
        () => {
          // Read failure (e.g. node hiccup): keep the last value, retry on poll.
        },
      );
    };
    load();
    const offWithdrawal = api.onWithdrawal(account, load);
    const offCredit = api.onAnyCredit(load);
    const poll = window.setInterval(load, POLL_MS);
    return () => {
      active = false;
      offWithdrawal();
      offCredit();
      window.clearInterval(poll);
    };
  }, [api, account, tick]);

  const current =
    snapshot !== null && snapshot.api === api && snapshot.account === account ? snapshot : null;

  return { claimable: current?.claimable ?? null, refresh };
}

/** The contract owner (for the admin void entry). null until loaded. */
export function useOwner(): string | null {
  const { api } = useStakeBeast();
  const [owner, setOwner] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!api) return undefined;
    api
      .owner()
      .then((o) => {
        if (!cancelled) setOwner(o);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);
  return owner;
}
