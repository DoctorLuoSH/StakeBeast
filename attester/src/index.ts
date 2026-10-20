/**
 * Entrypoint: load config from the environment, open the durable store,
 * connect the chain, and start the HTTP service (attester-service §8).
 */

import { loadConfig } from './config';
import { EthersChainClient } from './chain';
import { AttesterStore } from './store';
import { AttestationSigner } from './signer';
import { AttesterCore } from './core';
import { startServer } from './server';

async function main(): Promise<void> {
  const config = loadConfig();
  const chain = new EthersChainClient(config.rpcUrl, config.contractAddress);
  const chainId = await chain.getChainId();
  if (config.chainId !== 0 && config.chainId !== chainId) {
    throw new Error(`CHAIN_ID mismatch: configured ${config.chainId}, RPC network ${chainId}`);
  }
  console.log(`[attester] chain ${chainId}, contract ${config.contractAddress}`);

  const store = new AttesterStore(config.dataDir);
  const signer = new AttestationSigner(config.attesterPrivateKey);
  console.log(`[attester] signer ${signer.address} (no transfer authority)`);

  const core = new AttesterCore(store, chain, signer, {
    chainId,
    contractAddress: config.contractAddress,
  });

  const running = await startServer(core, { port: config.port, corsOrigin: config.corsOrigin });
  const shutdown = () => {
    running.stop().then(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[attester] failed to start:', err);
  process.exit(1);
});
