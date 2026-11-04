/**
 * MySessions — every session the chain recorded for the connected account
 * (created or joined; StakeBeast.sessionsOf covers both), newest first, each
 * linking to its focus page. This is the recovery entry when a create
 * confirmation never reaches the focus page: anything the chain holds for
 * this wallet is listed here, and a read failure surfaces as a retryable
 * error instead of an empty list (DAPP-44). Reads flow through the shared
 * useAccountSessions hook (one snapshot identity rule as useSession).
 */

import { Link } from "react-router-dom";
import { useWallet } from "../../wallet/useWallet";
import { useStakeBeast } from "../../contract/useStakeBeast";
import { useAccountSessions } from "../../contract/useAccountSessions";
import { MODE_LABEL, STATUS_LABEL } from "../../contract/types";
import { taskLabel } from "../../contract/sessionView";
import { EmptyState } from "../states/EmptyState";

export function MySessions() {
  const { api } = useStakeBeast();
  const { account } = useWallet();
  const { rows, loading, error, refresh } = useAccountSessions();

  if (!api || !account) return null;

  if (loading) {
    return <p className="muted">Loading your sessions…</p>;
  }

  if (error !== null) {
    return (
      <div role="alert">
        <p className="field__error">{error}</p>
        <button type="button" className="button button--ghost" onClick={refresh}>
          Retry
        </button>
      </div>
    );
  }

  if (rows === null || rows.length === 0) {
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
      {rows.map(({ id, session }) => (
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
