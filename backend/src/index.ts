import { loadConfig } from './config';
import { BackendDb } from './db';
import { EthersChainGateway } from './chain/ethersGateway';
import { createApp } from './app';

const config = loadConfig();
const db = new BackendDb(config.dataDir);
const gateway = new EthersChainGateway(config.rpcUrl, config.contractAddress);
const app = createApp({ config, db, gateway });

app.listen(config.port, () => {
  console.log(`[backend] StakeBeast social backend listening on http://localhost:${config.port}/api`);
});
