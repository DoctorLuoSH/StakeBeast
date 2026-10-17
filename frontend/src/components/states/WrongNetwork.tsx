/**
 * Full-page state shown when the wallet is on a network other than Sepolia.
 * Offers a one-click switch (auto-adds Sepolia when unknown to the wallet).
 */

import { SEPOLIA_NAME } from "../../config/chains";
import { useWallet } from "../../wallet/useWallet";
import "./StateScreens.css";

export function WrongNetwork() {
  const { chainId, switchToSepolia, error } = useWallet();

  return (
    <div className="state-screen">
      <div className="state-screen__icon" aria-hidden>
        🧭
      </div>
      <h2>Wrong network</h2>
      <p className="muted">
        StakeBeast runs on the {SEPOLIA_NAME} testnet
        {chainId !== null ? `, but your wallet is on chain ${chainId}` : ""}.
        Switch networks to continue — test stakes use free Sepolia ETH.
      </p>
      <button type="button" className="button" onClick={() => void switchToSepolia()}>
        Switch to {SEPOLIA_NAME}
      </button>
      {error ? <p className="muted">{error}</p> : null}
    </div>
  );
}
