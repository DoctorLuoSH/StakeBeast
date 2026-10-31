/**
 * React bindings for the StakeBeast contract client: build the API over the
 * wallet provider, load one session with event-driven refresh, track the
 * claimable balance and the contract owner.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
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
 * Load one session and keep it fresh: refetch on every session-lifecycle
 * event (SessionStarted anchors the countdown, per the unified status table)
 * with a slow poll as fallback for dropped filter subscriptions.
 */
export function useSession(sessionId: bigint | null): UseSessionResult {
  const { api } = useStakeBeast();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api || sessionId === null) return;
    try {
      const s = await api.getSession(sessionId);
      setSession(s);
      setError(null);
    } catch (err) {
      setError(describeContractError(err) ?? "Could not load the session from the chain.");
    }
  }, [api, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!api || sessionId === null) return undefined;
    const unsubscribe = api.onSessionActivity(sessionId, () => void refresh());
    const poll = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      unsubscribe();
      window.clearInterval(poll);
    };
  }, [api, sessionId, refresh]);

  return {
    session,
    loading: session === null && error === null,
    error,
    refresh: () => void refresh(),
  };
}

/** The connected account's pull-payment claimable balance (wei). */
export function useClaimable(): { claimable: bigint | null; refresh: () => void } {
  const { api } = useStakeBeast();
  const { account } = useWallet();
  const [claimable, setClaimable] = useState<bigint | null>(null);

  const refresh = useCallback(async () => {
    if (!api || !account) return;
    try {
      setClaimable(await api.claimableOf(account));
    } catch {
      // Read failure (e.g. node hiccup): keep the last value, retry on poll.
    }
  }, [api, account]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!api || !account) return undefined;
    const offWithdrawal = api.onWithdrawal(account, () => void refresh());
    const offCredit = api.onAnyCredit(() => void refresh());
    const poll = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      offWithdrawal();
      offCredit();
      window.clearInterval(poll);
    };
  }, [api, account, refresh]);

  return { claimable, refresh: () => void refresh() };
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
