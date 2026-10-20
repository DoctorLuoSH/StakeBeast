/**
 * BeastCard — one minted beast on the "My Zoo" shelf (PRD §14.5):
 * beast SVG + tier badge + completion date + metric, with the tier
 * visually distinct (silhouette from BeastSprite, badge color per tier).
 */

import { BeastSprite } from "./BeastSprite";
import type { BeastStage, BeastTier } from "./BeastSprite";
import "./BeastCard.css";

/** Badge labels follow the PRD §14.2 silhouette names (§4.8 tiers). */
const TIER_LABEL: Record<BeastTier, string> = {
  seedling: "Sprout",
  young: "Juvenile",
  adult: "Adult",
  golden: "Golden",
};

interface BeastCardProps {
  stage: BeastStage;
  tier: BeastTier;
  /** Metric behind the mint, e.g. "50 min focus" or "7-day habit". */
  metric: string;
  /** Completion date, display-ready (e.g. ISO yyyy-mm-dd). */
  date: string;
}

export function BeastCard({ stage, tier, metric, date }: BeastCardProps) {
  return (
    <article className={`beast-card beast-card--${tier}`}>
      <div className="beast-card__stage">
        <BeastSprite stage={stage} tier={tier} mood="minted" progress={1} size={110} />
      </div>
      <span className={`tier-badge tier-badge--${tier}`}>{TIER_LABEL[tier]}</span>
      <span className="beast-card__metric">{metric}</span>
      <span className="beast-card__date muted">{date}</span>
    </article>
  );
}
