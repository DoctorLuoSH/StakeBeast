/**
 * logQuery tests (DAPP-71) — the chunked event-history reader must never
 * issue a single eth_getLogs span over 9,999 blocks (public-RPC cap), must
 * anchor at the chain's deployment block (never below), and must merge /
 * dedupe / order segment results. Local Hardhat still scans from block 0.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Contract, EventLog, Log } from "ethers";
import { SEPOLIA_DEPLOY_BLOCK } from "../config/chains";

type TestLog = Pick<EventLog | Log, "blockNumber" | "index" | "transactionHash">;

function log(blockNumber: number, index: number, tx = "0xtx"): TestLog {
  return { blockNumber, index, transactionHash: `${tx}-${blockNumber}-${index}` };
}

function fakeContract(results: Map<string, TestLog[]>, failures?: Map<string, number>) {
  const calls: Array<[number, number]> = [];
  const queryFilter = vi.fn(async (_event: unknown, from: number, to: number) => {
    calls.push([from, to]);
    const key = `${from}-${to}`;
    const remaining = failures?.get(key) ?? 0;
    if (failures && remaining > 0) {
      failures.set(key, remaining - 1);
      throw new Error("RPC rate limit");
    }
    return results.get(key) ?? [];
  });
  return { contract: { queryFilter } as unknown as Contract, calls, queryFilter };
}

const providerAt = (tip: number) => ({ getBlockNumber: async () => tip });

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_CONTRACT_ADDRESS", "0x00000000000000000000000000000000000000aa");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("resolveLogStartBlock", () => {
  it("anchors at the Sepolia deployment block by default", async () => {
    const { resolveLogStartBlock } = await import("./logQuery");
    expect(resolveLogStartBlock()).toBe(SEPOLIA_DEPLOY_BLOCK);
    expect(SEPOLIA_DEPLOY_BLOCK).toBe(12075338);
  });

  it("honors VITE_DEPLOY_BLOCK above the deployment block", async () => {
    vi.stubEnv("VITE_DEPLOY_BLOCK", String(SEPOLIA_DEPLOY_BLOCK + 5000));
    const { resolveLogStartBlock } = await import("./logQuery");
    expect(resolveLogStartBlock()).toBe(SEPOLIA_DEPLOY_BLOCK + 5000);
  });

  it("clamps an override below the deployment block up to it", async () => {
    vi.stubEnv("VITE_DEPLOY_BLOCK", "100");
    const { resolveLogStartBlock } = await import("./logQuery");
    expect(resolveLogStartBlock()).toBe(SEPOLIA_DEPLOY_BLOCK);
  });

  it("ignores a malformed override", async () => {
    vi.stubEnv("VITE_DEPLOY_BLOCK", "not-a-number");
    const { resolveLogStartBlock } = await import("./logQuery");
    expect(resolveLogStartBlock()).toBe(SEPOLIA_DEPLOY_BLOCK);
  });

  it("starts local Hardhat from block 0", async () => {
    vi.stubEnv("VITE_CHAIN_ID", "31337");
    const { resolveLogStartBlock } = await import("./logQuery");
    expect(resolveLogStartBlock()).toBe(0);
  });
});

describe("queryFilterChunked", () => {
  it("splits a >10,000-block span into ≤9,999-block segments", async () => {
    const { queryFilterChunked, LOG_QUERY_CHUNK_SIZE } = await import("./logQuery");
    const anchor = SEPOLIA_DEPLOY_BLOCK;
    const tip = anchor + 25_000;
    const { contract, calls } = fakeContract(new Map());

    await queryFilterChunked(providerAt(tip), contract, "BeastMinted");

    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls[0][0]).toBe(anchor);
    expect(calls[calls.length - 1][1]).toBe(tip);
    for (const [from, to] of calls) {
      expect(to - from + 1).toBeLessThanOrEqual(LOG_QUERY_CHUNK_SIZE);
    }
    // Segments tile the range without gaps or overlaps.
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i][0]).toBe(calls[i - 1][1] + 1);
    }
  });

  it("merges segments, dedupes by tx/log index, and orders by block/index", async () => {
    const { queryFilterChunked } = await import("./logQuery");
    const anchor = SEPOLIA_DEPLOY_BLOCK;
    const second = anchor + 9_999;
    const results = new Map<string, TestLog[]>([
      // Out of order within the segment, plus a duplicate of the next one.
      [`${anchor}-${second - 1}`, [log(anchor + 5, 2), log(anchor + 5, 1), log(anchor + 5, 1)]],
      [`${second}-${second}`, [log(second, 0)]],
    ]);
    const { contract, calls } = fakeContract(results);

    const logs = await queryFilterChunked(providerAt(second), contract, "BeastMinted");

    expect(calls).toEqual([
      [anchor, second - 1],
      [second, second],
    ]);
    expect(logs.map((l) => [l.blockNumber, l.index])).toEqual([
      [anchor + 5, 1],
      [anchor + 5, 2],
      [second, 0],
    ]);
  });

  it("never starts below the deployment block even when asked to", async () => {
    const { queryFilterChunked } = await import("./logQuery");
    const tip = SEPOLIA_DEPLOY_BLOCK + 100;
    const { contract, calls } = fakeContract(new Map());

    await queryFilterChunked(providerAt(tip), contract, "CheckedIn", { fromBlock: 0 });

    expect(calls[0][0]).toBe(SEPOLIA_DEPLOY_BLOCK);
  });

  it("returns [] without querying when the range is empty", async () => {
    const { queryFilterChunked } = await import("./logQuery");
    const { contract, queryFilter } = fakeContract(new Map());

    // Deployment block ahead of a fresh local node's tip.
    await expect(
      queryFilterChunked(providerAt(5), contract, "CheckedIn"),
    ).resolves.toEqual([]);
    expect(queryFilter).not.toHaveBeenCalled();
  });

  it("retries a failing segment and then succeeds", async () => {
    const { queryFilterChunked } = await import("./logQuery");
    const anchor = SEPOLIA_DEPLOY_BLOCK;
    const key = `${anchor}-${anchor + 100}`;
    const { contract } = fakeContract(new Map([[key, [log(anchor, 0)]]]), new Map([[key, 2]]));

    const logs = await queryFilterChunked(providerAt(anchor + 100), contract, "CheckedIn", {
      retryDelayMs: 0,
    });

    expect(logs).toHaveLength(1);
  });

  it("throws a readable LogQueryError after exhausting retries", async () => {
    const { queryFilterChunked, LogQueryError } = await import("./logQuery");
    const anchor = SEPOLIA_DEPLOY_BLOCK;
    const key = `${anchor}-${anchor + 100}`;
    const { contract } = fakeContract(new Map(), new Map([[key, 99]]));

    const promise = queryFilterChunked(providerAt(anchor + 100), contract, "CheckedIn", {
      retryDelayMs: 0,
    });
    await expect(promise).rejects.toBeInstanceOf(LogQueryError);
    await expect(promise).rejects.toThrow(/12075338–12075438.*RPC rate limit/);
  });
});
