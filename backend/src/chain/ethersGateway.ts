/** Production ChainGateway: ethers v6 JsonRpcProvider against the frozen ABI. */

import { Contract, EventLog, JsonRpcProvider } from 'ethers';
import { STAKEBEAST_ABI } from './abi';
import type {
  ChainGateway,
  ChainReceipt,
  ChainSession,
  SessionCreatedEvent,
  SessionJoinedEvent,
} from './gateway';

export class EthersChainGateway implements ChainGateway {
  private readonly provider: JsonRpcProvider;
  private readonly contract: Contract;

  constructor(rpcUrl: string, contractAddress: string) {
    this.provider = new JsonRpcProvider(rpcUrl);
    this.contract = new Contract(contractAddress, STAKEBEAST_ABI, this.provider);
  }

  async getSession(sessionId: string): Promise<ChainSession> {
    const s = await this.contract.getSession(sessionId);
    return {
      mode: Number(s.mode),
      status: Number(s.status),
      staker: s.staker,
      partner: s.partner,
      verifier: s.verifier,
      linkedSessionId: s.linkedSessionId.toString(),
      criterion: s.criterion,
      periodDays: Number(s.periodDays),
      targetCount: Number(s.targetCount),
      settlementDeadline: Number(s.settlementDeadline),
    };
  }

  async getTransactionReceipt(txHash: string): Promise<ChainReceipt | null> {
    const r = await this.provider.getTransactionReceipt(txHash);
    if (!r) return null;
    return {
      status: r.status ?? 0,
      blockNumber: r.blockNumber,
      logs: r.logs.map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })),
    };
  }

  getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  async getSessionCreatedEvents(fromBlock: number, toBlock: number): Promise<SessionCreatedEvent[]> {
    const logs = await this.contract.queryFilter('SessionCreated', fromBlock, toBlock);
    return logs.map((l) => ({
      sessionId: (l as EventLog).args[0].toString(),
      blockNumber: l.blockNumber,
    }));
  }

  async getSessionJoinedEvents(fromBlock: number, toBlock: number): Promise<SessionJoinedEvent[]> {
    const logs = await this.contract.queryFilter('SessionJoined', fromBlock, toBlock);
    return logs.map((l) => ({
      sessionId: (l as EventLog).args[0].toString(),
      linkedSessionId: (l as EventLog).args[3].toString(),
      blockNumber: l.blockNumber,
    }));
  }
}
