/**
 * In-memory ChainClient for tests: mirrors the frozen StakeBeast ABI surface
 * (contract-design v4 §1/§3) without a node. Tests drive session status,
 * blocks and transactions explicitly; time is fully controllable.
 */

import { ethers } from 'ethers';
import {
  STAKEBEAST_ABI,
  type ChainBlock,
  type ChainClient,
  type ChainSession,
  type ChainTx,
  Mode,
  Status,
} from '../src/chain';

export const CHAIN_ID = 31337;
export const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

const iface = new ethers.Interface(STAKEBEAST_ABI);

export function encodeStartSession(sessionId: string | number): string {
  return iface.encodeFunctionData('startSession', [sessionId]);
}

export interface FakeTx extends ChainTx {
  receipt: { status: number } | null;
}

export class FakeChain implements ChainClient {
  attester: string;
  block: ChainBlock = { number: 1, timestamp: 1_800_000_000 };
  readonly sessions = new Map<string, ChainSession>();
  readonly txs = new Map<string, FakeTx>();

  constructor(attester: string) {
    this.attester = attester;
  }

  addSession(sessionId: string, s: ChainSession): void {
    this.sessions.set(sessionId, s);
  }

  addTx(hash: string, tx: FakeTx): void {
    this.txs.set(hash.toLowerCase(), tx);
  }

  setBlock(timestampSeconds: number): void {
    this.block = { number: this.block.number + 1, timestamp: timestampSeconds };
  }

  async getChainId(): Promise<number> {
    return CHAIN_ID;
  }

  async getSession(sessionId: string): Promise<ChainSession | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async getAttester(): Promise<string> {
    return this.attester;
  }

  async getLatestBlock(): Promise<ChainBlock> {
    return this.block;
  }

  async getTransaction(txHash: string): Promise<ChainTx | null> {
    return this.txs.get(txHash.toLowerCase()) ?? null;
  }

  async getTransactionReceipt(txHash: string): Promise<{ status: number } | null> {
    return this.txs.get(txHash.toLowerCase())?.receipt ?? null;
  }

  decodeStartSession(data: string): string | null {
    try {
      const parsed = iface.parseTransaction({ data });
      if (!parsed || parsed.name !== 'startSession') return null;
      return parsed.args[0].toString();
    } catch {
      return null;
    }
  }
}

export function soloSession(
  staker: string,
  startTimeSec: number,
  durationSec = 180,
  status: Status = Status.Pending,
): ChainSession {
  return {
    mode: Mode.SoloFocus,
    status,
    staker,
    partner: ethers.ZeroAddress,
    startTime: status === Status.Active ? startTimeSec : 0,
    endTime: status === Status.Active ? startTimeSec + durationSec : 0,
    settlementDeadline: status === Status.Active ? startTimeSec + durationSec + 600 : 0,
  };
}

export function cofocusSession(
  staker: string,
  partner: string,
  startTimeSec: number,
  durationSec = 180,
  status: Status = Status.Pending,
): ChainSession {
  return {
    mode: Mode.CoFocus,
    status,
    staker,
    partner,
    startTime: status === Status.Active ? startTimeSec : 0,
    endTime: status === Status.Active ? startTimeSec + durationSec : 0,
    settlementDeadline: status === Status.Active ? startTimeSec + durationSec + 600 : 0,
  };
}
