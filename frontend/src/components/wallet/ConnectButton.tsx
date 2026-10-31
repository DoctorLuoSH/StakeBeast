/**
 * ConnectButton — nav-bar wallet control.
 * Shows connect CTA when disconnected; address + network chip when connected.
 */

import { useWallet } from "../../wallet/useWallet";
import { shortAddress } from "../../lib/format";
import { EXPECTED_CHAIN } from "../../config/chains";
import "./ConnectButton.css";

export function ConnectButton() {
  const { status, account, chainId, isExpectedChain, connect, disconnect } = useWallet();

  if (status === "no-provider") {
    return (
      <a
        className="button button--ghost connect-button"
        href="https://metamask.io/download/"
        target="_blank"
        rel="noreferrer"
      >
        Install MetaMask
      </a>
    );
  }

  if (status !== "connected" || !account) {
    return (
      <button
        type="button"
        className="button connect-button"
        disabled={status === "connecting"}
        onClick={() => void connect()}
      >
        {status === "connecting" ? "Connecting…" : "Connect Wallet"}
      </button>
    );
  }

  return (
    <div className="connect-button__cluster">
      <span
        className={`connect-button__network${isExpectedChain ? "" : " connect-button__network--wrong"}`}
        title={isExpectedChain ? EXPECTED_CHAIN.name : `Wrong network (chain ${chainId ?? "?"})`}
      >
        {isExpectedChain ? EXPECTED_CHAIN.name : "Wrong network"}
      </span>
      <button
        type="button"
        className="button button--ghost connect-button"
        title="Disconnect (local session only)"
        onClick={disconnect}
      >
        <span className="mono">{shortAddress(account)}</span>
      </button>
    </div>
  );
}
