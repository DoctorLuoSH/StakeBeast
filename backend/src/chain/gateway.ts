/**
 * Narrow gateway over every chain read the backend performs. Production wires
 * EthersChainGateway (ethers v6 against the frozen StakeBeast ABI); tests
 * inject an in-memory fake. The chain is the source of truth for session
 * state — the backend mirrors, never decides (api-contract line 28).
 */

/** Subset of the on-chain Session struct the backend needs. */
export interface ChainSession {
  mode: number;
  status: number;
  staker: string;
  partner: string;
  verifier: string;
  /** Decimal string; '0' when the session has no linked counter-position. */
  linkedSessionId: string;
  criterion: string;
  periodDays: number;
  targetCount: number;
  /** On-chain uint64 as integer seconds. */
  settlementDeadline: number;
}

export interface ChainLog {
  address: string;
  topics: string[];
  data: string;
}

export interface ChainReceipt {
  /** 1 = success, 0 = reverted. */
  status: number;
  blockNumber: number;
  logs: ChainLog[];
}

export interface SessionCreatedEvent {
  /** Decimal string session id. */
  sessionId: string;
  blockNumber: number;
}

export interface ChainGateway {
  getSession(sessionId: string): Promise<ChainSession>;
  /** null while the transaction is not (yet) mined. */
  getTransactionReceipt(txHash: string): Promise<ChainReceipt | null>;
  getBlockNumber(): Promise<number>;
  /** SessionCreated events with blockNumber in [fromBlock, toBlock]. */
  getSessionCreatedEvents(fromBlock: number, toBlock: number): Promise<SessionCreatedEvent[]>;
}
