/**
 * ProfilePage — personal record + "My Zoo" NFT gallery (baseline §4.7,
 * PRD §14.5). Record stats stay skeletons until contract reads land; the
 * zoo shelf renders as a responsive card grid with tier-distinct beast
 * cards (Sprout / Juvenile / Adult / Golden) and an egg empty state.
 */

import { WalletGate } from "../components/wallet/WalletGate";
import { BeastSprite } from "../components/beast/BeastSprite";
import { BeastCard } from "../components/beast/BeastCard";
import type { BeastStage, BeastTier } from "../components/beast/BeastSprite";
import { EmptyState } from "../components/states/EmptyState";
import "./ProfilePage.css";

const STAT_SLOTS = [
  { label: "Sessions succeeded", value: "—" },
  { label: "Sessions failed", value: "—" },
  { label: "Total focus time", value: "—" },
  { label: "Total forfeited", value: "—" },
];

/**
 * Sample shelf demonstrating the four §4.8 tiers until contract reads are
 * wired — one card per tier, metrics mirroring the focus-minute ladder.
 */
const SAMPLE_BEASTS: Array<{ stage: BeastStage; tier: BeastTier; metric: string; date: string }> = [
  { stage: "sprout", tier: "seedling", metric: "24 min focus", date: "2026-10-11" },
  { stage: "young", tier: "young", metric: "25 min focus", date: "2026-10-13" },
  { stage: "adult", tier: "adult", metric: "50 min focus", date: "2026-10-15" },
  { stage: "golden", tier: "golden", metric: "120 min focus", date: "2026-10-18" },
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
            declared duration (focus) or period days (habit). Sample shelf
            below shows the four tiers; real mints load with contract reads.
          </p>
          <div className="profile__zoo">
            {SAMPLE_BEASTS.map((b) => (
              <BeastCard
                key={b.tier}
                stage={b.stage}
                tier={b.tier}
                metric={b.metric}
                date={b.date}
              />
            ))}
          </div>
          <EmptyState
            icon={<BeastSprite stage="sprout" mood="growing" progress={0} size={72} />}
            title="No beasts yet"
            hint="Complete a session to mint your first beast into the zoo."
          />
        </section>
      </div>
    </WalletGate>
  );
}
