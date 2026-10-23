/**
 * In-memory ChainGateway fake for tests. Encodes CheckedIn logs with the real
 * ABI coder so anchor verification runs against the exact wire format the
 * production gateway would return.
 */

import { AbiCoder, getAddress, toBeHex, zeroPadValue } from 'ethers';
import { CHECKED_IN_TOPIC } from '../src/chain/abi';
import type {
  ChainGateway,
  ChainReceipt,
  ChainSession,
  SessionCreatedEvent,
  SessionJoinedEvent,
} from '../src/chain/gateway';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** The contract address tests use as the expected CheckedIn emitter. */
export const TEST_CONTRACT = getAddress('0x5FbDB2315678afecb367f032d93F642f64180aa3');

export function makeSession(overrides: Partial<ChainSession> & { staker: string }): ChainSession {
  return {
    mode: 1, // Supervised
    status: 1, // Active
    partner: ZERO_ADDRESS,
    verifier: ZERO_ADDRESS,
    linkedSessionId: '0',
    criterion: 'run 5 km every day',
    periodDays: 7,
    targetCount: 5,
    settlementDeadline: 1_893_456_000, // 2030-01-01T00:00:00Z
    ...overrides,
  };
}

export class FakeChainGateway implements ChainGateway {
  readonly sessions = new Map<string, ChainSession>();
  readonly receipts = new Map<string, ChainReceipt>();
  readonly created: SessionCreatedEvent[] = [];
  readonly joined: SessionJoinedEvent[] = [];
  block = 1000;

  addSession(sessionId: string, session: ChainSession): void {
    this.sessions.set(sessionId, session);
  }

  emitCreated(sessionId: string, blockNumber?: number): void {
    this.created.push({ sessionId, blockNumber: blockNumber ?? this.block });
  }

  /** Mirrors the contract: a Duel join emits SessionJoined(id, participant, stake, linkedId). */
  emitJoined(sessionId: string, linkedSessionId: string, blockNumber?: number): void {
    this.joined.push({ sessionId, linkedSessionId, blockNumber: blockNumber ?? this.block });
  }

  setReceipt(txHash: string, receipt: ChainReceipt): void {
    this.receipts.set(txHash.toLowerCase(), receipt);
  }

  /** Build a receipt carrying one real-encoded CheckedIn log. */
  setCheckedInReceipt(
    txHash: string,
    opts: {
      contractAddress?: string;
      sessionId: string;
      staker: string;
      evidenceHash: string;
      periodIndex: number;
      status?: number;
      blockNumber?: number;
    },
  ): void {
    const topics = [
      CHECKED_IN_TOPIC,
      zeroPadValue(toBeHex(BigInt(opts.sessionId)), 32),
      zeroPadValue(opts.staker, 32),
    ];
    const data = AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint16'],
      [opts.evidenceHash, opts.periodIndex],
    );
    this.setReceipt(txHash, {
      status: opts.status ?? 1,
      blockNumber: opts.blockNumber ?? 1500,
      logs: [{ address: opts.contractAddress ?? TEST_CONTRACT, topics, data }],
    });
  }

  async getSession(sessionId: string): Promise<ChainSession> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    return { ...s };
  }

  async getTransactionReceipt(txHash: string): Promise<ChainReceipt | null> {
    return this.receipts.get(txHash.toLowerCase()) ?? null;
  }

  async getBlockNumber(): Promise<number> {
    return this.block;
  }

  async getSessionCreatedEvents(fromBlock: number, toBlock: number): Promise<SessionCreatedEvent[]> {
    return this.created.filter((e) => e.blockNumber >= fromBlock && e.blockNumber <= toBlock);
  }

  async getSessionJoinedEvents(fromBlock: number, toBlock: number): Promise<SessionJoinedEvent[]> {
    return this.joined.filter((e) => e.blockNumber >= fromBlock && e.blockNumber <= toBlock);
  }
}
