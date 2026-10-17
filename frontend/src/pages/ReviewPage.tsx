/**
 * ReviewPage — supervisor review view skeleton (baseline §4.5, P1 surface).
 * Will list pending check-ins with photo vs. on-chain hash comparison and
 * confirm / refuse actions. P0 fallback (off-chain knowledge → direct verify)
 * shares this entry point.
 */

import { WalletGate } from "../components/wallet/WalletGate";
import { EmptyState } from "../components/states/EmptyState";

export function ReviewPage() {
  return (
    <WalletGate>
      <div>
        <h1>Supervisor review</h1>
        <p className="muted">
          Check-ins waiting for your confirmation appear here, with each photo
          shown next to its on-chain hash so tampering is detectable.
        </p>
        <div className="card">
          <EmptyState
            icon="📋"
            title="Nothing to review"
            hint="When someone names you as supervisor, their check-ins will queue up here."
          />
        </div>
      </div>
    </WalletGate>
  );
}
