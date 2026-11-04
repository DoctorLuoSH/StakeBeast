/**
 * zooView — the My Zoo shelf decision logic (DAPP-22 review fix), kept in a
 * non-component module so ZooShelf stays a component-only export file.
 *
 * Exactly ONE of three views renders for any state — the sample shelf and
 * the empty state can never appear together:
 *
 *   beastCount > 0        → "shelf"   real minted beasts, nothing else
 *   0 beasts + demoMode   → "samples" dev/demo sample shelf, nothing else
 *   0 beasts + !demoMode  → "empty"   the "No beasts yet" empty state only
 */

import type { BeastStage, BeastTier } from "./BeastSprite";

/** One minted beast as the zoo shelf displays it. */
export interface BeastEntry {
  id: string;
  stage: BeastStage;
  tier: BeastTier;
  /** Metric behind the mint, e.g. "50 min focus" or "7-day habit". */
  metric: string;
  /** Completion date, display-ready (e.g. ISO yyyy-mm-dd). */
  date: string;
  /**
   * On-chain session id (uint256, decimal or 0x-hex) behind the mint —
   * derives the beast's colorway via `colorIndex(sessionId)` (DAPP-31).
   */
  sessionId?: string;
}

/** The three mutually exclusive shelf views. */
export type ZooView = "shelf" | "samples" | "empty";

export function resolveZooView(beastCount: number, demoMode: boolean): ZooView {
  if (beastCount > 0) return "shelf";
  return demoMode ? "samples" : "empty";
}
