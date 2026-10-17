/**
 * Transaction status banner: pending → success / failure feedback with a
 * Sepolia Etherscan link. Pages pass the current tx lifecycle state;
 * failures are classified (rejected / insufficient funds / network / unknown).
 */

import { txExplorerUrl } from "../../lib/etherscan";
import { classifyTxError } from "../../lib/txErrors";
import "./TxStatusBanner.css";

export type TxLifecycle =
  | { phase: "idle" }
  | { phase: "pending"; hash?: string }
  | { phase: "success"; hash: string }
  | { phase: "error"; error: unknown };

interface TxStatusBannerProps {
  tx: TxLifecycle;
  /** Short verb for the action, e.g. "Stake" or "Withdraw". */
  actionLabel?: string;
}

export function TxStatusBanner({ tx, actionLabel = "Transaction" }: TxStatusBannerProps) {
  if (tx.phase === "idle") return null;

  if (tx.phase === "pending") {
    return (
      <div className="tx-banner tx-banner--pending" role="status">
        <span className="tx-banner__spinner" aria-hidden />
        <span>
          {actionLabel} submitted — waiting for confirmation…{" "}
          {tx.hash ? (
            <a href={txExplorerUrl(tx.hash)} target="_blank" rel="noreferrer">
              View on Etherscan
            </a>
          ) : null}
        </span>
      </div>
    );
  }

  if (tx.phase === "success") {
    return (
      <div className="tx-banner tx-banner--success" role="status">
        <span>
          {actionLabel} confirmed.{" "}
          <a href={txExplorerUrl(tx.hash)} target="_blank" rel="noreferrer">
            View on Etherscan
          </a>
        </span>
      </div>
    );
  }

  const classified = classifyTxError(tx.error);
  return (
    <div className={`tx-banner tx-banner--${classified.kind === "rejected" ? "warning" : "error"}`} role="alert">
      <span>
        <strong>{classified.title}.</strong> {classified.detail}
      </span>
    </div>
  );
}
