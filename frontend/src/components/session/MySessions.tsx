/**
 * MySessions — every session the chain recorded for the connected account
 * (created or joined; StakeBeast.sessionsOf covers both), newest first, each
 * linking to its focus page. This is the recovery entry when a create
 * confirmation never reaches the focus page: anything the chain holds for
 * this wallet is listed here, and a read failure surfaces as a retryable
 * error instead of an empty list (DAPP-44).
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useWallet } from "../../wallet/useWallet";
import { useStakeBeast } from "../../contract/useStakeBeast";
import { describeContractError } from "../../contract/errors";
import type { StakeBeastApi } from "../../contract/client";
import { MODE_LABEL, STATUS_LABEL } from "../../contract/types";
import type { Session } from "../../contract/types";
import { taskLabel } from "../../contract/sessionView";
import { EmptyState } from "../states/EmptyState";

interface SessionRow {
  id: bigint;
  session: Session;
}

/**
 * Snapshot keyed to the exact request identity (api instance + account), so
 * a late response from a previous account/network can never overwrite the
 * current view (same race rule as useSession in useStakeBeast).
 */
interface Snapshot {
  api: StakeBeastApi;
  account: string;
  rows: SessionRow[] | null;
  error: string | null;
}

export function MySessions() {
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
            error:
              describeContractError(err) ?? "Could not load your sessions from the chain.",
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [api, account, tick]);

  const current =
    snapshot !== null && snapshot.api === api && snapshot.account === account
      ? snapshot
      : null;

  if (!api || !account) return null;

  if (current === null) {
    return <p className="muted">Loading your sessions…</p>;
  }

  if (current.error !== null) {
    return (
      <div role="alert">
        <p className="field__error">{current.error}</p>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => setTick((t) => t + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  if (current.rows === null || current.rows.length === 0) {
    return (
      <EmptyState
        icon="🧭"
        title="No sessions yet"
        hint="Sessions you create or join are listed here — this list is the way back into an in-flight session."
        action={
          <Link className="button button--ghost" to="/create">
            Create a session
          </Link>
        }
      />
    );
  }

  return (
    <ul className="profile__sessions">
      {current.rows.map(({ id, session }) => (
        <li key={id.toString()}>
          <Link to={`/focus/${id.toString()}`}>
            #{id.toString()} · {MODE_LABEL[session.mode]} ·{" "}
            {STATUS_LABEL[session.status]} · {taskLabel(session)}
          </Link>
        </li>
      ))}
    </ul>
  );
}
