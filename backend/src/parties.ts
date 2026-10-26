/**
 * Party resolution for check-in read authorization (api-contract A.3): the
 * session's staker, its verifier, and — for duel positions — the staker of
 * the linked counter-position. Everything is resolved from chain state via
 * the SessionCache (<= 60 s staleness), never from client input.
 */

import type { ChainSession } from './chain/gateway';
import type { SessionCache } from './chain/sessionCache';
import { ApiError } from './errors';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface Parties {
  session: ChainSession;
  /** Lower-cased addresses allowed to read check-ins and media. */
  parties: Set<string>;
}

export async function resolveParties(cache: SessionCache, sessionId: string): Promise<Parties> {
  let session: ChainSession;
  try {
    session = await cache.get(sessionId);
  } catch {
    throw new ApiError(404, 'not_found', 'session not found on chain');
  }
  const parties = new Set<string>([session.staker.toLowerCase()]);
  if (session.verifier && session.verifier.toLowerCase() !== ZERO_ADDRESS) {
    parties.add(session.verifier.toLowerCase());
  }
  if (session.linkedSessionId !== '0') {
    try {
      const linked = await cache.get(session.linkedSessionId);
      parties.add(linked.staker.toLowerCase());
    } catch {
      // A linked id that no longer resolves must not lock out the other parties.
    }
  }
  return { session, parties };
}
