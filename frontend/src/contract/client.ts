/**
 * StakeBeast contract client: a thin typed wrapper over the ethers Contract
 * exposing the session lifecycle surface used by the UI. The address is
 * injected via VITE_CONTRACT_ADDRESS (zero-hardcode rule) — never default it.
 */

import { Contract, Interface } from "ethers";
import type {
  BrowserProvider,
  ContractTransactionReceipt,
  ContractTransactionResponse,
} from "ethers";
import { contractAddress } from "../config/env";
import { STAKEBEAST_ABI } from "./abi";
import { parseSession } from "./types";
import type { Payee, Session } from "./types";

export const stakeBeastInterface = new Interface(STAKEBEAST_ABI);

export class ContractNotConfiguredError extends Error {
  constructor() {
    super(
      "Contract address is not configured. Copy .env.example to .env and set VITE_CONTRACT_ADDRESS.",
    );
    this.name = "ContractNotConfiguredError";
  }
}

export function isContractConfigured(): boolean {
  return contractAddress.length > 0;
}

/** Parameters for createSession; mirrors the contract signature. */
export interface CreateSessionInput {
  mode: number;
  counterparty: string;
  payee: number;
  customPayee: string;
  durationMinutes: number;
  periodDays: number;
  checkInsPerDay: number;
  targetCount: number;
  criterion: string;
  stakeWei: bigint;
}

export interface StakeBeastApi {
  address: string;
  createSession(input: CreateSessionInput): Promise<ContractTransactionResponse>;
  joinSession(
    sessionId: bigint,
    payee: Payee,
    customPayee: string,
    stakeWei: bigint,
  ): Promise<ContractTransactionResponse>;
  startSession(sessionId: bigint): Promise<ContractTransactionResponse>;
  cancelPending(sessionId: bigint): Promise<ContractTransactionResponse>;
  settle(sessionId: bigint, signature: string): Promise<ContractTransactionResponse>;
  verify(sessionId: bigint): Promise<ContractTransactionResponse>;
  admitDefeat(sessionId: bigint): Promise<ContractTransactionResponse>;
  forfeit(sessionId: bigint): Promise<ContractTransactionResponse>;
  voidSession(sessionId: bigint): Promise<ContractTransactionResponse>;
  withdraw(): Promise<ContractTransactionResponse>;
  getSession(sessionId: bigint): Promise<Session>;
  sessionsOf(account: string): Promise<bigint[]>;
  claimableOf(account: string): Promise<bigint>;
  owner(): Promise<string>;
  /** Forfeit reason from the SessionForfeited log (0 admit / 1 timeout / 2 joint); null when none. */
  getForfeitReason(sessionId: bigint): Promise<number | null>;
  /** Token ids minted by the SessionCompleted log; empty when none. */
  getCompletedTokenIds(sessionId: bigint): Promise<bigint[]>;
  /** Extract the created session id from a createSession receipt. */
  readCreatedSessionId(receipt: ContractTransactionReceipt): bigint | null;
  /** Subscribe to every session-lifecycle event for one id. Returns unsubscribe. */
  onSessionActivity(sessionId: bigint, listener: () => void): () => void;
  /** Subscribe to Withdrawn events for one account. Returns unsubscribe. */
  onWithdrawal(account: string, listener: () => void): () => void;
  /**
   * Subscribe to every event that can credit a claimable balance
   * (completion / cancellation / void / forfeiture — the contract credits
   * claimable before each of these, StakeBeast.sol). Unfiltered — traffic is tiny.
   */
  onAnyCredit(listener: () => void): () => void;
}

/** Build the client over a wallet provider. Throws when the address is unset. */
export function getStakeBeast(provider: BrowserProvider): StakeBeastApi {
  if (!isContractConfigured()) throw new ContractNotConfiguredError();

  // Reads go through the wallet's provider; writes connect the live signer.
  const contract = new Contract(contractAddress, STAKEBEAST_ABI, provider);
  const writable = async () => contract.connect(await provider.getSigner()) as typeof contract;

  return {
    address: contractAddress,

    async createSession(input) {
      const c = await writable();
      return c.createSession(
        input.mode,
        input.counterparty,
        input.payee,
        input.customPayee,
        input.durationMinutes,
        input.periodDays,
        input.checkInsPerDay,
        input.targetCount,
        input.criterion,
        { value: input.stakeWei },
      ) as Promise<ContractTransactionResponse>;
    },

    async joinSession(sessionId, payee, customPayee, stakeWei) {
      const c = await writable();
      return c.joinSession(sessionId, payee, customPayee, {
        value: stakeWei,
      }) as Promise<ContractTransactionResponse>;
    },

    async startSession(sessionId) {
      return (await writable()).startSession(sessionId) as Promise<ContractTransactionResponse>;
    },

    async cancelPending(sessionId) {
      return (await writable()).cancelPending(sessionId) as Promise<ContractTransactionResponse>;
    },

    async settle(sessionId, signature) {
      return (await writable()).settle(sessionId, signature) as Promise<ContractTransactionResponse>;
    },

    async verify(sessionId) {
      return (await writable()).verify(sessionId) as Promise<ContractTransactionResponse>;
    },

    async admitDefeat(sessionId) {
      return (await writable()).admitDefeat(sessionId) as Promise<ContractTransactionResponse>;
    },

    async forfeit(sessionId) {
      return (await writable()).forfeit(sessionId) as Promise<ContractTransactionResponse>;
    },

    async voidSession(sessionId) {
      return (await writable()).voidSession(sessionId) as Promise<ContractTransactionResponse>;
    },

    async withdraw() {
      return (await writable()).withdraw() as Promise<ContractTransactionResponse>;
    },

    async getSession(sessionId) {
      return parseSession(await contract.getSession(sessionId));
    },

    async sessionsOf(account) {
      return [...(await contract.sessionsOf(account))] as bigint[];
    },

    async claimableOf(account) {
      return (await contract.claimableOf(account)) as bigint;
    },

    async owner() {
      return (await contract.owner()) as string;
    },

    async getForfeitReason(sessionId) {
      const logs = await contract.queryFilter(contract.filters.SessionForfeited(sessionId));
      if (logs.length === 0) return null;
      const last = logs[logs.length - 1];
      const decoded = stakeBeastInterface.parseLog({ topics: [...last.topics], data: last.data });
      return decoded ? Number(decoded.args.reason) : null;
    },

    async getCompletedTokenIds(sessionId) {
      const logs = await contract.queryFilter(contract.filters.SessionCompleted(sessionId));
      if (logs.length === 0) return [];
      const decoded = stakeBeastInterface.parseLog({
        topics: [...logs[0].topics],
        data: logs[0].data,
      });
      return decoded ? ([...decoded.args.tokenIds] as bigint[]) : [];
    },

    readCreatedSessionId(receipt) {
      for (const log of receipt.logs) {
        try {
          const decoded = stakeBeastInterface.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
          if (decoded?.name === "SessionCreated") return decoded.args.id as bigint;
        } catch {
          // Not a StakeBeast log — skip.
        }
      }
      return null;
    },

    onSessionActivity(sessionId, listener) {
      const fire = () => listener();
      const filters = [
        contract.filters.SessionCreated(sessionId),
        contract.filters.SessionJoined(sessionId),
        contract.filters.StartConfirmed(sessionId),
        contract.filters.SessionStarted(sessionId),
        contract.filters.SessionCancelled(sessionId),
        contract.filters.SessionCompleted(sessionId),
        contract.filters.SessionForfeited(sessionId),
        contract.filters.SessionVoided(sessionId),
      ];
      for (const f of filters) void contract.on(f, fire);
      return () => {
        for (const f of filters) void contract.off(f, fire);
      };
    },

    onWithdrawal(account, listener) {
      const filter = contract.filters.Withdrawn(account);
      const fire = () => listener();
      void contract.on(filter, fire);
      return () => void contract.off(filter, fire);
    },

    onAnyCredit(listener) {
      const fire = () => listener();
      // Every event emitted after the contract credits a claimable balance:
      // completion, cancellation, void, and forfeiture (admit-defeat route,
      // timeout to charity, joint co-focus to charity).
      const events = ["SessionCompleted", "SessionCancelled", "SessionVoided", "SessionForfeited"];
      for (const e of events) void contract.on(e, fire);
      return () => {
        for (const e of events) void contract.off(e, fire);
      };
    },
  };
}
