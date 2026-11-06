/**
 * Chunked event-history queries (DAPP-71).
 *
 * Public RPC endpoints cap `eth_getLogs` at 10,000 blocks per call, so an
 * unbounded `queryFilter` (block 0 → latest) fails on Sepolia — this broke
 * the My Zoo shelf in production. Every historical event read goes through
 * `queryFilterChunked`, which splits the range into ≤9,999-block segments,
 * retries a failing segment, then merges / dedupes / sorts the result.
 *
 * The query start is anchored at the deployment block recorded for the
 * expected chain (see `config/chains.ts` `deployBlock`, sourced from
 * `deployments/sepolia.json`), overridable via `VITE_DEPLOY_BLOCK`; the
 * start never goes below the deployment block.
 */

import type { Contract, ContractEventName, EventLog, Log } from "ethers";
import { EXPECTED_CHAIN } from "../config/chains";
import { deployBlockOverride } from "../config/env";

/** Public-RPC `eth_getLogs` cap is 10,000 blocks; stay strictly under it. */
export const LOG_QUERY_CHUNK_SIZE = 9_999;

/** Attempts per segment before giving up with a readable error. */
const MAX_CHUNK_ATTEMPTS = 3;

/** Minimal block-tip source (BrowserProvider satisfies this). */
export interface BlockTipSource {
  getBlockNumber(): Promise<number>;
}

/** A historical log query failed after retrying every segment attempt. */
export class LogQueryError extends Error {
  constructor(fromBlock: number, toBlock: number, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Event history query failed for blocks ${fromBlock}–${toBlock} after ${MAX_CHUNK_ATTEMPTS} attempts: ${detail}. ` +
        "Check the RPC endpoint (VITE_SEPOLIA_RPC_URL) or try again.",
    );
    this.name = "LogQueryError";
  }
}

/**
 * Lowest block any event-history query may start from: the deployment block
 * of the expected chain, or the `VITE_DEPLOY_BLOCK` override clamped to it —
 * the start never goes below the deployment block. Local Hardhat chains
 * record 0, so local history is scanned from genesis.
 */
export function resolveLogStartBlock(): number {
  const floor = EXPECTED_CHAIN.deployBlock;
  if (!deployBlockOverride) return floor;
  const override = Number(deployBlockOverride);
  if (!Number.isInteger(override) || override < 0) return floor;
  return Math.max(override, floor);
}

export interface ChunkedQueryOptions {
  /** Defaults to `resolveLogStartBlock()`; clamped to it when lower. */
  fromBlock?: number;
  /** Defaults to the current chain tip. */
  toBlock?: number;
  /** Retry backoff base in milliseconds (tests pass 0). */
  retryDelayMs?: number;
}

/**
 * `contract.queryFilter` over the whole history in ≤9,999-block segments.
 * Returns the merged logs deduped by transaction/log index and ordered by
 * (blockNumber, index). Resolves to [] when the range is empty (e.g. the
 * deployment block is ahead of a fresh local node's tip).
 */
export async function queryFilterChunked(
  provider: BlockTipSource,
  contract: Contract,
  event: ContractEventName,
  options: ChunkedQueryOptions = {},
): Promise<Array<EventLog | Log>> {
  const anchor = resolveLogStartBlock();
  const fromBlock = Math.max(options.fromBlock ?? anchor, anchor);
  const toBlock = options.toBlock ?? (await provider.getBlockNumber());
  if (fromBlock > toBlock) return [];

  const merged = new Map<string, EventLog | Log>();
  for (let start = fromBlock; start <= toBlock; start += LOG_QUERY_CHUNK_SIZE) {
    const end = Math.min(start + LOG_QUERY_CHUNK_SIZE - 1, toBlock);
    const logs = await queryChunkWithRetry(contract, event, start, end, options.retryDelayMs);
    for (const log of logs) {
      merged.set(`${log.transactionHash}:${log.index}`, log);
    }
  }
  return [...merged.values()].sort(
    (a, b) => a.blockNumber - b.blockNumber || a.index - b.index,
  );
}

async function queryChunkWithRetry(
  contract: Contract,
  event: ContractEventName,
  fromBlock: number,
  toBlock: number,
  retryDelayMs = 250,
): Promise<Array<EventLog | Log>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt++) {
    try {
      return await contract.queryFilter(event, fromBlock, toBlock);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_CHUNK_ATTEMPTS) await sleep(retryDelayMs * attempt);
    }
  }
  throw new LogQueryError(fromBlock, toBlock, lastError);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
