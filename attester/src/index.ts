import { loadConfig } from './config';
import { SessionStore } from './store';
import { createSigner } from './signer';
import { startServer } from './server';

const config = loadConfig();
const store = new SessionStore(config.dbPath);
const signer = createSigner(config);

startServer({ config, store, signer, now: Date.now }).catch((err) => {
  console.error('[attester] failed to start:', err);
  process.exit(1);
});
