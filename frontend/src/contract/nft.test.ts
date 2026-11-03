/**
 * nft tests (DAPP-47) — beastToEntry maps on-chain BeastMeta to the shelf
 * entry: tier → stage/badge, the metric text per kind, the completion date,
 * and the sessionId that drives the colorway (DAPP-31).
 */

import { describe, expect, it } from "vitest";
import { beastToEntry } from "./nft";
import type { MintedBeast } from "./nft";
import { Kind, Tier } from "./types";

function beast(overrides: Partial<MintedBeast> = {}): MintedBeast {
  return {
    tokenId: 1n,
    sessionId: 7n,
    kind: Kind.Focus,
    metricValue: 50n,
    tier: Tier.Adult,
    completionDate: 1_793_664_000, // 2026-11-03T00:00:00Z
    ...overrides,
  };
}

describe("beastToEntry", () => {
  it("maps a focus beast", () => {
    expect(beastToEntry(beast())).toEqual({
      id: "1",
      stage: "adult",
      tier: "adult",
      metric: "50 min focus",
      date: "2026-11-03",
      sessionId: "7",
    });
  });

  it("maps a habit golden beast", () => {
    const entry = beastToEntry(
      beast({ kind: Kind.Habit, metricValue: 21n, tier: Tier.Golden }),
    );
    expect(entry.stage).toBe("golden");
    expect(entry.tier).toBe("golden");
    expect(entry.metric).toBe("21-day habit");
  });

  it("maps sprout to the seedling badge", () => {
    const entry = beastToEntry(beast({ tier: Tier.Sprout, metricValue: 10n }));
    expect(entry.stage).toBe("sprout");
    expect(entry.tier).toBe("seedling");
    expect(entry.metric).toBe("10 min focus");
  });

  it("maps juvenile to the young stage", () => {
    const entry = beastToEntry(beast({ tier: Tier.Juvenile, metricValue: 25n }));
    expect(entry.stage).toBe("young");
    expect(entry.tier).toBe("young");
  });
});
