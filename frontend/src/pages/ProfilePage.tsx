/**
 * ProfilePage — personal record + "My Zoo" NFT gallery (baseline §4.7,
 * PRD §14.5). Record stats stay skeletons until contract reads land; the
 * zoo shelf (ZooShelf) renders exactly one view per state: real minted
 * beasts, the demo-mode sample shelf, or the egg empty state.
 */

import { WalletGate } from "../components/wallet/WalletGate";
import { ZooShelf } from "../components/beast/ZooShelf";
import type { BeastEntry } from "../components/beast/zooView";
import "./ProfilePage.css";

const STAT_SLOTS = [
  { label: "Sessions succeeded", value: "—" },
  { label: "Sessions failed", value: "—" },
  { label: "Total focus time", value: "—" },
  { label: "Total forfeited", value: "—" },
];

/**
 * Real minted beasts load with contract reads (DAPP-4); empty until then.
 * The shelf view (real cards / demo samples / empty state) is decided inside
 * ZooShelf so samples and the empty state can never render together.
 */
const MINTED_BEASTS: BeastEntry[] = [];

/** Sample shelf is a dev/demo aid only (dev server or VITE_DEMO_MODE=true). */
const DEMO_MODE = import.meta.env.DEV || import.meta.env.VITE_DEMO_MODE === "true";

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
          <ZooShelf beasts={MINTED_BEASTS} demoMode={DEMO_MODE} />
        </section>
      </div>
    </WalletGate>
  );
}
