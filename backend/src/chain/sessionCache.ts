/**
 * Short-lived cache over ChainGateway.getSession. Party resolution for
 * check-in reads is resolved from chain state cached at most 60 seconds
 * (api-contract A.3); writes re-read through the same cache, so the staleness
 * bound is identical everywhere.
 */

import type { ChainGateway, ChainSession } from './gateway';

export class SessionCache {
  private readonly entries = new Map<string, { at: number; session: ChainSession }>();

  constructor(
    private readonly gateway: ChainGateway,
    private readonly ttlMs: number,
  ) {}

  async get(sessionId: string): Promise<ChainSession> {
    const hit = this.entries.get(sessionId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.session;
    const session = await this.gateway.getSession(sessionId);
    this.entries.set(sessionId, { at: Date.now(), session });
    return session;
  }
}
