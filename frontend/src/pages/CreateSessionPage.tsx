/**
 * CreateSessionPage — four session modes from the frozen baseline (§4.1–4.4).
 * P0 modes are selectable; P1/P2 modes are shown but disabled until their
 * priority tier is activated. Contract wiring lands after the DAPP-2 freeze;
 * this page is the layout + validation skeleton only.
 */

import { useState } from "react";
import type { FormEvent } from "react";
import { WalletGate } from "../components/wallet/WalletGate";
import { TxStatusBanner } from "../components/tx/TxStatusBanner";
import type { TxLifecycle } from "../components/tx/TxStatusBanner";
import "./CreateSessionPage.css";

type ModeId = "solo-focus" | "supervised-habit" | "mutual-bet" | "co-focus";

interface ModeDef {
  id: ModeId;
  title: string;
  tier: "P0" | "P1" | "P2";
  attestation: "machine" | "human";
  enabled: boolean;
  summary: string;
}

const MODES: ModeDef[] = [
  {
    id: "solo-focus",
    title: "Solo Focus",
    tier: "P0",
    attestation: "machine",
    enabled: true,
    summary:
      "Machine-attested single focus session. Explicit on-chain start; the proof service must cover the full declared duration.",
  },
  {
    id: "supervised-habit",
    title: "Supervised Habit",
    tier: "P0",
    attestation: "human",
    enabled: true,
    summary:
      "Habit over N days with check-ins. Your supervisor's final on-chain confirmation is the sole success criterion.",
  },
  {
    id: "mutual-bet",
    title: "Mutual Bet",
    tier: "P1",
    attestation: "human",
    enabled: false,
    summary:
      "Two bound but independently settled positions; each side supervises the other. Arrives with P1.",
  },
  {
    id: "co-focus",
    title: "Co-Focus Duo",
    tier: "P2",
    attestation: "machine",
    enabled: false,
    summary:
      "Two stakers focus together with joint liability — if either fails, both stakes go to charity. Arrives with P2.",
  },
];

const FORFEIT_DESTINATIONS = [
  { id: "charity", label: "Charity address" },
  { id: "supervisor", label: "Supervisor" },
  { id: "friend", label: "Friend's address" },
] as const;

export function CreateSessionPage() {
  const [mode, setMode] = useState<ModeId>("solo-focus");
  const [tx] = useState<TxLifecycle>({ phase: "idle" });
  const active = MODES.find((m) => m.id === mode)!;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    // Contract calls are intentionally out of scope for this wave
    // (ABI frozen later). The form is validated markup only.
  };

  return (
    <WalletGate>
      <div className="create">
        <h1>Create a session</h1>
        <p className="muted">
          Parameters are locked once staked — duration, goal, verifier and
          forfeit destination cannot be changed afterwards.
        </p>

        <div className="create__modes" role="tablist" aria-label="Session mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              disabled={!m.enabled}
              className={`create__mode card${mode === m.id ? " create__mode--active" : ""}`}
              onClick={() => setMode(m.id)}
            >
              <span className={`badge badge--${m.tier.toLowerCase()}`}>{m.tier}</span>
              <strong>{m.title}</strong>
              <small className="muted">{m.summary}</small>
            </button>
          ))}
        </div>

        <form className="card create__form" onSubmit={onSubmit}>
          <h2>{active.title}</h2>

          <label className="field">
            <span>Stake amount (Sepolia ETH)</span>
            <input required type="number" min="0" step="0.001" placeholder="0.01" />
          </label>

          {active.attestation === "machine" ? (
            <label className="field">
              <span>Focus duration (minutes)</span>
              <input required type="number" min="1" step="1" placeholder="25" />
              <small className="muted">
                Tier ladder: ≥120 golden · ≥50 adult · ≥25 young · below 25 a practice seedling.
              </small>
            </label>
          ) : (
            <>
              <label className="field">
                <span>Period (days)</span>
                <input required type="number" min="1" step="1" placeholder="7" />
              </label>
              <label className="field">
                <span>Supervisor address</span>
                <input required type="text" pattern="^0x[0-9a-fA-F]{40}$" placeholder="0x…" />
              </label>
              <label className="field">
                <span>Completion standard (for the supervisor)</span>
                <textarea rows={2} placeholder="e.g. 45 minutes of reading per check-in" />
              </label>
            </>
          )}

          <label className="field">
            <span>Forfeit destination on admitted defeat</span>
            <select defaultValue="charity">
              {FORFEIT_DESTINATIONS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          <TxStatusBanner tx={tx} actionLabel="Stake" />

          <button type="submit" className="button" disabled title="Contract wiring after DAPP-2 freeze">
            Stake &amp; Create (coming with contract integration)
          </button>
        </form>
      </div>
    </WalletGate>
  );
}
