/**
 * BeastSprite — reserved interface for teammate B's original beast artwork.
 *
 * This placeholder renders an egg/bud silhouette so layouts can be built now;
 * the real growth / flee animations drop in behind the same props.
 * All artwork must be original (no Forest-style copies) per the frozen baseline.
 */

import "./BeastSprite.css";

/** Growth stage per baseline §4.8 tier ladder (focus minutes / habit days). */
export type BeastStage = "sprout" | "young" | "adult" | "golden";

/** NFT tier naming from §4.8: 练习苗 / 幼兽 / 成兽 / 黄金兽. */
export type BeastTier = "seedling" | "young" | "adult" | "golden";

/** Lifecycle visual state. */
export type BeastMood = "growing" | "happy" | "warning" | "fled" | "minted";

interface BeastSpriteProps {
  stage: BeastStage;
  tier?: BeastTier;
  mood?: BeastMood;
  /** 0–1 growth progress within the current session, drives placeholder fill. */
  progress?: number;
  size?: number;
}

const STAGE_EMOJI: Record<BeastStage, string> = {
  sprout: "🌱",
  young: "🐣",
  adult: "🐲",
  golden: "✨",
};

export function BeastSprite({
  stage,
  mood = "growing",
  progress = 0,
  size = 160,
}: BeastSpriteProps) {
  const pct = Math.min(100, Math.max(0, Math.round(progress * 100)));
  return (
    <div
      className={`beast-sprite beast-sprite--${mood}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Beast placeholder, stage ${stage}, mood ${mood}`}
    >
      <span className="beast-sprite__glyph" aria-hidden>
        {STAGE_EMOJI[stage]}
      </span>
      <span className="beast-sprite__fill" style={{ height: `${pct}%` }} aria-hidden />
    </div>
  );
}
