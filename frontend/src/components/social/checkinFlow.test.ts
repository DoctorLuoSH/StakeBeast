/**
 * checkinFlow tests (DAPP-47) — the evidence upload + anchor sequence:
 * period index derivation (D10 rolling 24 h windows), stage ordering, and
 * failure propagation, with all I/O mocked.
 */

import { describe, expect, it, vi } from "vitest";
import {
  hashFileBytes,
  periodIndexAt,
  reanchorFlow,
  runCheckinFlow,
} from "./checkinFlow";
import type { CheckinFlowDeps, CheckinStage } from "./checkinFlow";
import { sha256Hex } from "../../lib/socialApi";

describe("periodIndexAt", () => {
  it("derives rolling 24 h period indexes from the session start (D10)", () => {
    expect(periodIndexAt(1_000_000, 1_000_000)).toBe(0);
    expect(periodIndexAt(1_000_000, 1_000_000 + 86_399)).toBe(0);
    expect(periodIndexAt(1_000_000, 1_000_000 + 86_400)).toBe(1);
    expect(periodIndexAt(1_000_000, 1_000_000 + 2 * 86_400 + 5)).toBe(2);
  });

  it("floors at 0 before the start", () => {
    expect(periodIndexAt(1_000_000, 999_999)).toBe(0);
  });
});

describe("hashFileBytes", () => {
  it("hashes the blob's exact bytes", async () => {
    const blob = new Blob(["abc"]);
    expect(await hashFileBytes(blob)).toBe(sha256Hex(new TextEncoder().encode("abc")));
  });
});

function deps(overrides: Partial<CheckinFlowDeps> = {}): CheckinFlowDeps {
  return {
    upload: vi.fn(async () => "checkin-1"),
    anchorTx: vi.fn(async () => "0xtxhash"),
    waitMined: vi.fn(async () => {}),
    report: vi.fn(async () => {}),
    nowSec: () => 1_000_000 + 90_000, // period 1
    ...overrides,
  };
}

describe("runCheckinFlow", () => {
  it("runs hash → upload → anchor → report in order", async () => {
    const d = deps();
    const stages: CheckinStage[] = [];
    const photo = new Blob(["evidence-bytes"]);
    const result = await runCheckinFlow(d, photo, 1_000_000, (s) => stages.push(s));

    expect(stages).toEqual(["hashing", "uploading", "anchoring", "reporting"]);
    expect(result).toEqual({ checkinId: "checkin-1", txHash: "0xtxhash" });

    const expectedHash = sha256Hex(new TextEncoder().encode("evidence-bytes"));
    expect(d.upload).toHaveBeenCalledWith({
      evidenceHash: expectedHash,
      periodIndex: 1,
      photo,
    });
    expect(d.anchorTx).toHaveBeenCalledWith(expectedHash);
    expect(d.waitMined).toHaveBeenCalledWith("0xtxhash");
    expect(d.report).toHaveBeenCalledWith("checkin-1", "0xtxhash");
  });

  it("propagates an upload failure without anchoring", async () => {
    const d = deps({
      upload: vi.fn(async () => {
        throw new Error("hash_mismatch");
      }),
    });
    await expect(runCheckinFlow(d, new Blob(["x"]), 0, () => {})).rejects.toThrow(
      "hash_mismatch",
    );
    expect(d.anchorTx).not.toHaveBeenCalled();
    expect(d.report).not.toHaveBeenCalled();
  });

  it("propagates a reverted anchor without reporting", async () => {
    const d = deps({
      waitMined: vi.fn(async () => {
        throw new Error("reverted");
      }),
    });
    await expect(runCheckinFlow(d, new Blob(["x"]), 0, () => {})).rejects.toThrow("reverted");
    expect(d.report).not.toHaveBeenCalled();
  });
});

describe("reanchorFlow", () => {
  it("re-anchors the same evidence hash and reports the new tx", async () => {
    const d = deps();
    const stages: CheckinStage[] = [];
    const txHash = await reanchorFlow(d, "checkin-9", "0xdeadbeef", (s) => stages.push(s));
    expect(txHash).toBe("0xtxhash");
    expect(stages).toEqual(["anchoring", "reporting"]);
    expect(d.anchorTx).toHaveBeenCalledWith("0xdeadbeef");
    expect(d.report).toHaveBeenCalledWith("checkin-9", "0xtxhash");
  });
});
