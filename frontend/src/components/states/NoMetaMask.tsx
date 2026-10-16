/**
 * Full-page state shown when no compatible injected wallet is detected.
 */

import "./StateScreens.css";

export function NoMetaMask() {
  return (
    <div className="state-screen">
      <div className="state-screen__icon" aria-hidden>
        🦊
      </div>
      <h2>MetaMask not found</h2>
      <p className="muted">
        StakeBeast needs a Web3 wallet to hold your stake. Install MetaMask
        (or open this page inside the MetaMask mobile browser), then reload.
      </p>
      <a
        className="button"
        href="https://metamask.io/download/"
        target="_blank"
        rel="noreferrer"
      >
        Install MetaMask
      </a>
    </div>
  );
}
