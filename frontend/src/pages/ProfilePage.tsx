/**
 * ProfilePage — personal record + "My Zoo" NFT gallery (baseline §4.7).
 * Record stats (success/fail counts, total focus time, total forfeited) and
 * the beast shelf are skeletons until contract reads are wired; statistic
 * charts are P1 and intentionally absent.
 */

import { WalletGate } from "../components/wallet/WalletGate";
import { BeastSprite } from "../components/beast/BeastSprite";
import { EmptyState } from "../components/states/EmptyState";
import "./ProfilePage.css";

const STAT_SLOTS = [
  { label: "Sessions succeeded", value: "—" },
  { label: "Sessions failed", value: "—" },
  { label: "Total focus time", value: "—" },
  { label: "Total forfeited", value: "—" },
];

export function ProfilePage() {
  return (
    <WalletGate>
      <div className="profile">
        <h1>My Zoo</h1>

        <section className="profile__stats">
          {STAT_SLOTS.map((s) => (
            <div key={s.label} className="card profile__stat">
              <span className="profile__stat-value mono">{s.value}</span>
              <span className="muted">{s.label}</span>
            </div>
          ))}
        </section>

        <section className="card">
          <h2>Beast shelf</h2>
          <p className="muted">
            Untransferable beasts minted from completed sessions — tiered by
            declared duration (focus) or period days (habit).
          </p>
          <div className="profile__zoo">
            {/* Placeholder pair demonstrating the shelf layout. */}
            <BeastSprite stage="sprout" mood="minted" progress={1} size={110} />
            <BeastSprite stage="young" mood="minted" progress={1} size={110} />
          </div>
          <EmptyState
            icon="🥚"
            title="No beasts yet"
            hint="Complete a session to mint your first beast into the zoo."
          />
        </section>
      </div>
    </WalletGate>
  );
}
