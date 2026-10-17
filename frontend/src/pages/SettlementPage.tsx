/**
 * SettlementPage — session outcome view skeleton.
 * Success: stake credited to withdrawable balance + beast minted.
 * Failure: beast fled + forfeit destination summary.
 * Withdraw entry (claimable balance) is a P0 requirement; the actual
 * contract call lands with ABI integration.
 */

import { WalletGate } from "../components/wallet/WalletGate";
import { BeastSprite } from "../components/beast/BeastSprite";
import { TxStatusBanner } from "../components/tx/TxStatusBanner";
import { EmptyState } from "../components/states/EmptyState";
import "./SettlementPage.css";

export function SettlementPage() {
  return (
    <WalletGate>
      <div className="settlement">
        <h1>Settlement</h1>

        <section className="card settlement__result">
          <BeastSprite stage="adult" mood="minted" progress={1} size={180} />
          <div>
            <h2>Outcome goes here</h2>
            <p className="muted">
              Success shows the minted beast and the stake moving to your
              withdrawable balance; failure shows the fled beast and where the
              stake went (supervisor / friend / charity).
            </p>
          </div>
        </section>

        <section className="card settlement__claim">
          <h2>Withdrawable balance</h2>
          <p className="muted">
            Pull-pattern claim entry. Your credited balance from completed
            sessions is withdrawn here.
          </p>
          <TxStatusBanner tx={{ phase: "idle" }} actionLabel="Withdraw" />
          <button type="button" className="button button--accent" disabled title="Contract wiring after DAPP-2 freeze">
            Withdraw (coming with contract integration)
          </button>
        </section>

        <section className="card">
          <h2>Past sessions</h2>
          <EmptyState
            icon="🕸️"
            title="Nothing to settle yet"
            hint="Finished sessions awaiting settlement will be listed here."
          />
        </section>
      </div>
    </WalletGate>
  );
}
