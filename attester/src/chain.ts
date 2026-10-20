/**
 * Chain access layer (design freeze: contract-design.md v4).
 *
 * The service reads — and only reads — the chain: session fields, the current
 * attester address, transactions (arm validation), and block headers (window
 * bounds, signing gate, clock health). It never sends a transaction.
 *
 * `ChainClient` is the seam the core logic depends on; the production
 * implementation talks JSON-RPC via ethers v6, and tests substitute an
 * in-memory fake. ABI fragments below mirror contract-design.md §1/§3 exactly
 * (StakeBeast.sol is implemented by Forge, DAPP-3 — any drift is resolved in
 * the task comments, never by editing this file to match an unfrozen ABI).
 */

import { ethers } from 'ethers';

/** contract-design §1 enums (numeric values as stored on-chain). */
export enum Mode {
  SoloFocus = 0,
  Supervised = 1,
  Duel = 2,
  CoFocus = 3,
}

export enum Status {
  Pending = 0,
  Active = 1,
  Completed = 2,
  Forfeited = 3,
  Voided = 4,
  Cancelled = 5,
}

/** Session fields the attester relies on (subset of the on-chain struct). */
export interface ChainSession {
  mode: Mode;
  status: Status;
  staker: string; // EIP-55 checksummed
  partner: string; // zero address when none
  /** seconds; 0 until the session is Active. */
  startTime: number;
  endTime: number;
  settlementDeadline: number;
}

export interface ChainTx {
  to: string;
  from: string;
  data: string;
  nonce: number;
}

export interface ChainBlock {
  number: number;
  /** seconds */
  timestamp: number;
}

export interface ChainClient {
  getChainId(): Promise<number>;
  /** null when the session id does not exist on-chain. */
  getSession(sessionId: string): Promise<ChainSession | null>;
  getAttester(): Promise<string>;
  getLatestBlock(): Promise<ChainBlock>;
  /** null when the transaction is unknown (never submitted or dropped). */
  getTransaction(txHash: string): Promise<ChainTx | null>;
  /** null while pending / unknown; status 1 = confirmed, 0 = reverted. */
  getTransactionReceipt(txHash: string): Promise<{ status: number } | null>;
  /**
   * Decode calldata as `startSession(uint256)`; returns the sessionId decimal
   * string, or null when the calldata is not a startSession call.
   */
  decodeStartSession(data: string): string | null;
}

/**
 * Minimal ABI: getSession tuple (component order = struct order, §1),
 * attester view, startSession (arm validation), SessionStarted (reference).
 */
export const STAKEBEAST_ABI = [
  `function getSession(uint256 sessionId) view returns (tuple(
      uint8 mode, uint8 status, address staker, address partner, address verifier,
      uint8 payee, address customPayee, uint256 stake, uint32 durationMinutes,
      uint16 periodDays, uint8 checkInsPerDay, uint16 targetCount, string criterion,
      uint256 linkedSessionId, uint64 createdAt, uint64 joinDeadline, uint64 startDeadline,
      uint64 startTime, uint64 endTime, uint64 settlementDeadline, bool joined,
      bool startConfirmedStaker, bool startConfirmedPartner, bool minted))`,
  'function attester() view returns (address)',
  'function startSession(uint256 sessionId)',
  'event SessionStarted(uint256 indexed id, uint64 startTime, uint64 endTime, uint64 settlementDeadline)',
];

export class EthersChainClient implements ChainClient {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly contract: ethers.Contract;
  private readonly iface: ethers.Interface;

  constructor(rpcUrl: string, contractAddress: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.contract = new ethers.Contract(contractAddress, STAKEBEAST_ABI, this.provider);
    this.iface = new ethers.Interface(STAKEBEAST_ABI);
  }

  async getChainId(): Promise<number> {
    const network = await this.provider.getNetwork();
    return Number(network.chainId);
  }

  async getSession(sessionId: string): Promise<ChainSession | null> {
    const s = await this.contract.getSession(sessionId);
    // nextSessionId starts at 1; a never-created id reads back as zeroed.
    if (s.staker === ethers.ZeroAddress) return null;
    return {
      mode: Number(s.mode) as Mode,
      status: Number(s.status) as Status,
      staker: s.staker,
      partner: s.partner,
      startTime: Number(s.startTime),
      endTime: Number(s.endTime),
      settlementDeadline: Number(s.settlementDeadline),
    };
  }

  async getAttester(): Promise<string> {
    return this.contract.attester();
  }

  async getLatestBlock(): Promise<ChainBlock> {
    const block = await this.provider.getBlock('latest');
    if (!block) throw new Error('RPC returned no latest block');
    return { number: block.number, timestamp: block.timestamp };
  }

  async getTransaction(txHash: string): Promise<ChainTx | null> {
    const tx = await this.provider.getTransaction(txHash);
    if (!tx || !tx.to) return null;
    return { to: tx.to, from: tx.from, data: tx.data, nonce: tx.nonce };
  }

  async getTransactionReceipt(txHash: string): Promise<{ status: number } | null> {
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status === null) return null;
    return { status: receipt.status };
  }

  decodeStartSession(data: string): string | null {
    try {
      const parsed = this.iface.parseTransaction({ data });
      if (!parsed || parsed.name !== 'startSession') return null;
      return parsed.args[0].toString();
    } catch {
      return null;
    }
  }
}
