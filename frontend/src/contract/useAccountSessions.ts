/**
 * useAccountSessions — every session the chain recorded for the connected
 * account (created or joined; StakeBeast.sessionsOf covers both), newest
 * first. Shared by MySessions (the recovery list) and the profile record
 * stats so both read one consistent snapshot.
 *
 * Race safety: the snapshot is keyed to the exact request identity (api
 * instance + account); a late response from a previous account/network can
 * never overwrite the current view, and switching the account reads as
 * loading again (same rule as useSession in useStakeBeast).
 */

import { useEffect, useState } from "react";
import { useWallet } from "../wallet/useWallet";
import { useStakeBeast } from "./useStakeBeast";
import { describeContractError } from "./errors";
import type { StakeBeastApi } from "./client";
import type { Session } from "./types";

export interface SessionRow {
  id: bigint;
  session: Session;
}

interface Snapshot {
  api: StakeBeastApi;
  account: string;
  rows: SessionRow[] | null;
  error: string | null;
}

export interface UseAccountSessionsResult {
  /** null while the first load for the current identity is in flight. */
  rows: SessionRow[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useAccountSessions(): UseAccountSessionsResult {
  const { api } = useStakeBeast();
  const { account } = useWallet();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!api || !account) return undefined;
    let active = true;
    void (async () => {
      try {
        const ids = await api.sessionsOf(account);
        const rows = await Promise.all(
          ids.map(async (id) => ({ id, session: await api.getSession(id) })),
        );
        if (active) setSnapshot({ api, account, rows: rows.reverse(), error: null });
      } catch (err) {
        if (active) {
          setSnapshot({
            api,
            account,
            rows: null,
            error: describeContractError(err) ?? "Could not load your sessions from the chain.",
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [api, account, tick]);

  const current =
    snapshot !== null && snapshot.api === api && snapshot.account === account ? snapshot : null;

  return {
    rows: current?.rows ?? null,
    loading: current === null,
    error: current?.error ?? null,
    refresh: () => setTick((t) => t + 1),
  };
}
