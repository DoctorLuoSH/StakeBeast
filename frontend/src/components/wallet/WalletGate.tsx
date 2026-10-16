/**
 * WalletGate — wraps pages that require a usable wallet session.
 * Renders the correct empty/error state instead of children when the wallet
 * is missing, disconnected, or on the wrong network.
 */

import type { ReactNode } from "react";
import { useWallet } from "../../wallet/useWallet";
import { NoMetaMask } from "../states/NoMetaMask";
import { WrongNetwork } from "../states/WrongNetwork";
import "../states/StateScreens.css";

interface WalletGateProps {
  children: ReactNode;
  /** Allow read-only browsing without a connected wallet. */
  requireConnection?: boolean;
}

export function WalletGate({ children, requireConnection = true }: WalletGateProps) {
  const { status, isSepolia, connect, error } = useWallet();

  if (status === "no-provider") return <NoMetaMask />;

  if (requireConnection && status !== "connected") {
    return (
      <div className="state-screen">
        <div className="state-screen__icon" aria-hidden>
          🔗
        </div>
        <h2>Connect your wallet</h2>
        <p className="muted">Your wallet is your identity — no accounts, no passwords.</p>
        <button
          type="button"
          className="button"
          disabled={status === "connecting"}
          onClick={() => void connect()}
        >
          {status === "connecting" ? "Connecting…" : "Connect Wallet"}
        </button>
        {error ? <p className="muted">{error}</p> : null}
      </div>
    );
  }

  if (status === "connected" && !isSepolia) return <WrongNetwork />;

  return <>{children}</>;
}
