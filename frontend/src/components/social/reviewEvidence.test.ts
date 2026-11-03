/**
 * reviewEvidence tests (DAPP-47) — the R8 verdict matrix: "anchored &
 * matching" requires the recomputed hash to equal BOTH the record and an
 * on-chain CheckedIn event with a matching periodIndex, plus a confirmed
 * backend anchor status; every other combination is an explicit non-proof
 * state.
 */

import { describe, expect, it } from "vitest";
import { verdictFor } from "./reviewEvidence";
import type { CheckedInRecord } from "../../contract/client";
import type { CheckinRecord } from "../../lib/socialApi";

const HASH = "0x" + "ab".repeat(32);

function record(overrides: Partial<CheckinRecord> = {}): CheckinRecord {
  return {
    checkinId: "c1",
    periodIndex: 2,
    evidenceHash: HASH,
    createdAt: "2026-11-03T00:00:00Z",
    photoUrl: "/api/media/c1",
    thumbUrl: "/api/media/c1?variant=thumb",
    onchain: { status: "confirmed", txHash: "0xtx", blockNumber: "12", failReason: null },
    ...overrides,
  };
}

function log(overrides: Partial<CheckedInRecord> = {}): CheckedInRecord {
  return {
    evidenceHash: HASH,
    periodIndex: 2,
    staker: "0x0000000000000000000000000000000000000001",
    txHash: "0xtx",
    blockNumber: 12,
    ...overrides,
  };
}

describe("verdictFor", () => {
  it("anchored-matching when recompute == record == on-chain (same period), confirmed", () => {
    const check = verdictFor(HASH, record(), [log()]);
    expect(check.verdict).toBe("anchored-matching");
    expect(check.onchain?.txHash).toBe("0xtx");
  });

  it("photo-mismatch when the served bytes hash differently than the record", () => {
    const check = verdictFor("0x" + "cd".repeat(32), record(), [log()]);
    expect(check.verdict).toBe("photo-mismatch");
    expect(check.onchain).toBeNull();
  });

  it("no-onchain-anchor when no event matches the hash", () => {
    const check = verdictFor(HASH, record(), [log({ evidenceHash: "0x" + "ef".repeat(32) })]);
    expect(check.verdict).toBe("no-onchain-anchor");
  });

  it("no-onchain-anchor when the period index differs", () => {
    const check = verdictFor(HASH, record(), [log({ periodIndex: 3 })]);
    expect(check.verdict).toBe("no-onchain-anchor");
  });

  it("anchor-failed when the backend marked the anchor failed (even with an event)", () => {
    const check = verdictFor(
      HASH,
      record({ onchain: { status: "failed", txHash: "0xtx", blockNumber: "12", failReason: "event_mismatch" } }),
      [log()],
    );
    expect(check.verdict).toBe("anchor-failed");
  });

  it("anchor-pending while the reported tx is not yet confirmed", () => {
    const check = verdictFor(
      HASH,
      record({ onchain: { status: "pending", txHash: "0xtx", blockNumber: null, failReason: null } }),
      [log()],
    );
    expect(check.verdict).toBe("anchor-pending");
  });

  it("hash comparison is case-insensitive", () => {
    const check = verdictFor(HASH.toUpperCase().replace("0X", "0x"), record(), [log()]);
    expect(check.verdict).toBe("anchored-matching");
  });
});
