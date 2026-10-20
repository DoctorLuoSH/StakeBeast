/**
 * SettlementPage — session outcome view (baseline §4.7).
 * Success: stake credited to the withdrawable balance + beast minted.
 * Failure: runaway animation → withered remnant, no mint, forfeit route.
 * Both outcomes render as labelled previews until contract data is wired
 * (DAPP-4); the withdraw entry is a P0 requirement.
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

        <section className="card settlement__result settlement__result--success">
          <span className="badge badge--p0">Success preview</span>
          <div className="settlement__row">
            <BeastSprite stage="adult" mood="happy" progress={1} size={170} />
            <div>
              <h2>Beast minted, stake returned</h2>
              <p className="muted">
                The verified session mints an untransferable beast into your
                zoo, and the stake is credited to your withdrawable balance
                below.
              </p>
            </div>
          </div>
        </section>

        <section className="card settlement__result settlement__result--failure">
          <span className="badge badge--p1">Failure preview</span>
          <div className="settlement__row">
            <BeastSprite stage="young" mood="fled" progress={1} size={170} />
            <div>
              <h2>The beast ran away</h2>
              <p className="muted">
                Failed sessions mint no NFT. The stake is paid along the
                preset forfeit route — supervisor, friend, or charity —
                chosen when the session was created.
              </p>
            </div>
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
