/** Dependency bundle handed to every route module. */

import type { Config } from './config';
import type { BackendDb } from './db';
import type { ChainGateway } from './chain/gateway';
import type { SessionCache } from './chain/sessionCache';
import type { SessionIndexer } from './indexer';

export interface Ctx {
  config: Config;
  db: BackendDb;
  gateway: ChainGateway;
  cache: SessionCache;
  indexer: SessionIndexer;
  /** TTL applied both to the session cache and to review-list refreshes. */
  sessionCacheTtlMs: number;
  reviewPageSize: number;
}
