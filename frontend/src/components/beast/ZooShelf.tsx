/**
 * ZooShelf — the "My Zoo" beast gallery (baseline §4.7, PRD §14.5). Renders
 * exactly one of shelf / samples / empty per the resolveZooView decision
 * (./zooView.ts) — the sample shelf and the empty state can never appear
 * together (DAPP-22 review fix).
 *
 * The sample shelf demonstrates the four §4.8 tiers while contract reads are
 * unwired (DAPP-4); it is gated behind demo mode (Vite dev server or
 * VITE_DEMO_MODE=true) so production builds only ever show real data or the
 * empty state.
 */

import { BeastSprite } from "./BeastSprite";
import { BeastCard } from "./BeastCard";
import { resolveZooView } from "./zooView";
import type { BeastEntry } from "./zooView";
import { colorIndex } from "./colorway";
import { EmptyState } from "../states/EmptyState";

/**
 * Sample shelf demonstrating the four §4.8 tiers — demo mode only, never
 * rendered in production builds (see header).
 */
const SAMPLE_BEASTS: BeastEntry[] = [
  { id: "sample-seedling", stage: "sprout", tier: "seedling", metric: "24 min focus", date: "2026-10-11" },
  { id: "sample-young", stage: "young", tier: "young", metric: "25 min focus", date: "2026-10-13" },
  { id: "sample-adult", stage: "adult", tier: "adult", metric: "50 min focus", date: "2026-10-15" },
  { id: "sample-golden", stage: "golden", tier: "golden", metric: "120 min focus", date: "2026-10-18" },
];

interface ZooShelfProps {
  /** Real minted beasts; empty until contract reads land (DAPP-4). */
  beasts: BeastEntry[];
  /** Dev/demo mode: allow the sample shelf when there are no real beasts. */
  demoMode: boolean;
}

export function ZooShelf({ beasts, demoMode }: ZooShelfProps) {
  const view = resolveZooView(beasts.length, demoMode);

  if (view === "shelf") {
    return (
      <div className="profile__zoo">
        {beasts.map((b) => (
          <BeastCard
            key={b.id}
            stage={b.stage}
            tier={b.tier}
            metric={b.metric}
            date={b.date}
            colorway={b.sessionId !== undefined ? colorIndex(b.sessionId) : undefined}
          />
        ))}
      </div>
    );
  }

  if (view === "samples") {
    return (
      <>
        <p className="muted">
          Demo shelf: the four §4.8 tiers on sample data (dev/demo mode only —
          production shows real mints or the empty state).
        </p>
        <div className="profile__zoo">
          {SAMPLE_BEASTS.map((b) => (
            <BeastCard key={b.id} stage={b.stage} tier={b.tier} metric={b.metric} date={b.date} />
          ))}
        </div>
      </>
    );
  }

  return (
    <EmptyState
      icon={<BeastSprite stage="sprout" mood="growing" progress={0} size={72} />}
      title="No beasts yet"
      hint="Complete a session to mint your first beast into the zoo."
    />
  );
}
