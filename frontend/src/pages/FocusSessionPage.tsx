/**
 * FocusSessionPage — in-session view (baseline §4.7, PRD §14.1).
 * Beast growth animation driven by real elapsed progress, remaining time,
 * violation warning (desaturate + red pulse ring + permanent-rule banner),
 * and the runaway animation on failure. The heartbeat / attester wiring
 * lands with the proof-service integration (DAPP-4); until then a clearly
 * labelled demo session and demo controls exercise the animation pipeline.
 */

import { useEffect, useState } from "react";
import { WalletGate } from "../components/wallet/WalletGate";
import { BeastSprite } from "../components/beast/BeastSprite";
import type { BeastMood } from "../components/beast/BeastSprite";
import { CountdownTimer } from "../components/CountdownTimer";
import "./FocusSessionPage.css";

/** Placeholder demo session length — baseline allows 2–3 min demo sessions. */
const DEMO_DURATION_MS = 2 * 60 * 1000;

/**
 * Demo stand-in for the contract's GRACE_DURATION — on-chain the settlement
 * window is `endTime + GRACE_DURATION` (StakeBeast.sol settlementDeadline).
 */
const DEMO_SETTLEMENT_GRACE_MS = 5 * 60 * 1000;

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function FocusSessionPage() {
  const [startMs, setStartMs] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(false);
  const [violated, setViolated] = useState(false);
  const [fled, setFled] = useState(false);
  const now = useNow(1000);

  const endMs = startMs + DEMO_DURATION_MS;
  const progress = Math.min(1, Math.max(0, (now - startMs) / DEMO_DURATION_MS));

  // Violation signal (visual half): hiding the tab flags a violation. The
  // attester-side marking arrives with the proof-service wiring.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) setViolated(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const resetDemo = () => {
    setStartMs(Date.now());
    setElapsed(false);
    setViolated(false);
    setFled(false);
  };

  const mood: BeastMood = fled
    ? "fled"
    : violated
      ? "warning"
      : elapsed
        ? "happy"
        : "growing";

  return (
    <WalletGate>
      <div className="focus">
        <section className="card focus__stage">
          <BeastSprite stage="young" mood={mood} progress={progress} size={220} />
          {!fled ? (
            <>
              <CountdownTimer
                targetMs={endMs}
                label={elapsed ? "Session window ended" : "Remaining"}
                onElapsed={() => setElapsed(true)}
              />
              <div
                className="focus__progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
                aria-label="Growth progress"
              >
                <span
                  className="focus__progress-fill"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
              <p className="muted focus__hint">
                Stay on this page. Hiding the tab or losing the heartbeat marks
                a violation — the proof service will refuse to sign.
              </p>
              {/* A violated session can never receive a completion proof, so
                  the submit-to-settle hint must not appear once a violation
                  is flagged — even after the window ends (DAPP-29).
                  TODO(M3): drive this settlement hint from the proof state
                  confirmed by the attestation service instead of the local
                  elapsed / violated inference. */}
              {elapsed && !violated ? (
                <p className="focus__done">
                  Session window complete — submit the attestation to settle
                  (contract call arrives with DAPP-4 wiring).
                </p>
              ) : null}
            </>
          ) : null}
        </section>

        {violated && !fled ? (
          <section className="card focus__warning" role="alert">
            <h3>Violation flagged</h3>
            <p>
              Violation recorded. This session can no longer receive a
              completion proof. Admitting defeat uses your chosen payout
              route; after the settlement deadline, anyone can trigger
              forfeiture to charity.
            </p>
          </section>
        ) : null}

        {fled ? (
          <section className="card focus__failed" role="alert">
            <h3>Session failed</h3>
            <p>
              Only a dried sprout remains — the beast ran away. Failed
              sessions mint no NFT.
            </p>
            <p className="focus__funds">
              <span className="focus__funds-dot" aria-hidden="true" />
              Funds pending settlement
            </p>
            <div className="focus__settlement">
              <CountdownTimer
                targetMs={endMs + DEMO_SETTLEMENT_GRACE_MS}
                label="On-chain settlement window"
              />
              <p className="muted">
                Admit defeat to pay your chosen route; after the deadline
                anyone can trigger forfeiture to charity.
              </p>
            </div>
          </section>
        ) : null}

        <section className="card focus__demo muted">
          <h3>Demo controls</h3>
          <p>
            Placeholder session (2 min) exercising the animation pipeline until
            contract / attester wiring lands (DAPP-4).
          </p>
          <div className="focus__demo-buttons">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => setViolated(true)}
              disabled={violated || fled}
            >
              Simulate violation
            </button>
            <button
              type="button"
              className="button button--danger"
              onClick={() => setFled(true)}
              disabled={fled}
            >
              Simulate flee
            </button>
            <button type="button" className="button button--ghost" onClick={resetDemo}>
              Reset demo
            </button>
          </div>
        </section>
      </div>
    </WalletGate>
  );
}
