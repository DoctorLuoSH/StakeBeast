/**
 * Full-page state shown when the wallet is on a network other than the one
 * this build targets (Sepolia by default; local Hardhat in dev).
 * Offers a one-click switch (auto-adds the chain when unknown to the wallet).
 */

import { EXPECTED_CHAIN } from "../../config/chains";
import { useWallet } from "../../wallet/useWallet";
import "./StateScreens.css";

export function WrongNetwork() {
  const { chainId, switchToExpectedChain, error } = useWallet();

  return (
    <div className="state-screen">
      <div className="state-screen__icon" aria-hidden>
        🧭
      </div>
      <h2>Wrong network</h2>
      <p className="muted">
        StakeBeast runs on {EXPECTED_CHAIN.name}
        {chainId !== null ? `, but your wallet is on chain ${chainId}` : ""}.
        Switch networks to continue — test stakes use free test ETH.
      </p>
      <button type="button" className="button" onClick={() => void switchToExpectedChain()}>
        Switch to {EXPECTED_CHAIN.name}
      </button>
      {error ? <p className="muted">{error}</p> : null}
    </div>
  );
}
