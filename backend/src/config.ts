/**
 * Service configuration from environment variables. Secrets only ever come
 * from the environment (dotenv loads a local `.env` for one-command startup);
 * nothing secret is hard-coded. JWT_SECRET is the single mandatory value.
 */

import dotenv from 'dotenv';

export interface Config {
  port: number;
  rpcUrl: string;
  /** The expected emitter of CheckedIn events (EIP-55 or lower-case input). */
  contractAddress: string;
  chainId: number;
  jwtSecret: string;
  dataDir: string;
  /** CORS allowlist, comma-separated. */
  frontendOrigin: string;
  indexerStartBlock: number;
}

export function loadConfig(envPath = '.env'): Config {
  dotenv.config({ path: envPath });
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is required — set it in the environment or in .env (see .env.example)');
  }
  return {
    port: Number(process.env.PORT ?? 4000),
    rpcUrl: process.env.RPC_URL ?? 'http://127.0.0.1:8545',
    contractAddress:
      process.env.CONTRACT_ADDRESS ?? '0x0000000000000000000000000000000000000000',
    chainId: Number(process.env.CHAIN_ID ?? 31337),
    jwtSecret,
    dataDir: process.env.DATA_DIR ?? './data',
    frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
    indexerStartBlock: Number(process.env.INDEXER_START_BLOCK ?? 0),
  };
}
