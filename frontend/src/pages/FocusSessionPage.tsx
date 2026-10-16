/**
 * FocusSessionPage — in-session view skeleton (baseline §4.7).
 * Layout slots: beast growth animation (BeastSprite), remaining time
 * (CountdownTimer), violation warning, flee animation. The heartbeat /
 * visibility-violation wiring lands with the proof-service integration.
 */

import { useState } from "react";
import { WalletGate } from "../components/wallet/WalletGate";
import { BeastSprite } from "../components/beast/BeastSprite";
import { CountdownTimer } from "../components/CountdownTimer";
import "./FocusSessionPage.css";

export function FocusSessionPage() {
  // Placeholder session end: 25 minutes from first render.
  const [endMs] = useState(() => Date.now() + 25 * 60 * 1000);
  const [elapsed, setElapsed] = useState(false);

  return (
    <WalletGate>
      <div className="focus">
        <section className="card focus__stage">
          <BeastSprite stage="sprout" mood="growing" progress={0.2} size={200} />
          <CountdownTimer
            targetMs={endMs}
            label={elapsed ? "Session window ended" : "Remaining"}
            onElapsed={() => setElapsed(true)}
          />
          <p className="muted focus__hint">
            Stay on this page. Hiding the tab or losing the heartbeat marks a
            violation — the proof service will refuse to sign.
          </p>
        </section>

        <section className="card focus__slot">
          <h3>Violation warning</h3>
          <p className="muted">
            Reserved slot — the warning banner appears here when a violation is
            flagged (tab hidden, heartbeat lost &gt; 15s).
          </p>
        </section>

        <section className="card focus__slot">
          <h3>Flee animation</h3>
          <p className="muted">
            Reserved slot — teammate B's original flee animation plays here if
            the session fails.
          </p>
        </section>
      </div>
    </WalletGate>
  );
}
