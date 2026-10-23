/**
 * One-time historical discovery backfill (see SessionIndexer.backfill).
 *
 * Discovery scanning is forward-only from the persisted watermark, so an
 * existing database never re-reads history — e.g. Duel mirror positions whose
 * SessionJoined predates the SessionJoined scanner stay undiscovered. Run
 * once after upgrading such a deployment:
 *
 *   npm run backfill -- --from <block>
 *
 * The command rescans [from, watermark] for SessionCreated/SessionJoined,
 * inserts discoveries idempotently, and never moves the watermark, so all
 * business data (profiles, check-ins, media) is preserved. A fresh DATA_DIR
 * needs no backfill — the normal scan covers everything from
 * INDEXER_START_BLOCK.
 */

import { loadConfig } from './config';
import { BackendDb } from './db';
import { EthersChainGateway } from './chain/ethersGateway';
import { SessionIndexer } from './indexer';

function parseFrom(argv: string[]): number {
  const i = argv.indexOf('--from');
  const n = i >= 0 ? Number(argv[i + 1]) : NaN;
  if (!Number.isInteger(n) || n < 0) {
    console.error('usage: npm run backfill -- --from <block>   (non-negative integer)');
    process.exit(2);
  }
  return n;
}

async function main(): Promise<void> {
  const from = parseFrom(process.argv.slice(2));
  const config = loadConfig();
  const db = new BackendDb(config.dataDir);
  try {
    const watermark = db.getLastScannedBlock();
    if (watermark == null) {
      console.log('[backfill] no scan watermark — fresh database, nothing to backfill');
      return;
    }
    const gateway = new EthersChainGateway(config.rpcUrl, config.contractAddress);
    const indexer = new SessionIndexer(db, gateway, {
      startBlock: config.indexerStartBlock,
      throttleMs: 0,
    });
    const { created, joined } = await indexer.backfill(from);
    console.log(
      `[backfill] rescanned blocks ${from}..${watermark}: ` +
        `${created} SessionCreated, ${joined} SessionJoined event(s) applied; watermark unchanged`,
    );
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('[backfill] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
