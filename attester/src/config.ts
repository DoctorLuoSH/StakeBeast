/**
 * Service configuration from environment variables (secrets only ever come from
 * the environment; nothing is hard-coded in the repo). A minimal `.env` file
 * loader is included so local one-command startup works without extra deps.
 *
 * Environment (attester-service.md §8):
 *   RPC_URL               JSON-RPC endpoint (default http://127.0.0.1:8545)
 *   CONTRACT_ADDRESS      deployed StakeBeast contract (required)
 *   ATTESTER_PRIVATE_KEY  0x-prefixed signing key (required; no transfer authority)
 *   PORT                  HTTP listen port (default 3001)
 *   DATA_DIR              durable state directory (default ./data)
 *   CHAIN_ID              optional safety check against the RPC network
 *   CORS_ORIGIN           browser origin allowlist (default * — local dev)
 */

import { existsSync, readFileSync } from 'node:fs';

export interface Config {
  rpcUrl: string;
  contractAddress: string;
  attesterPrivateKey: string;
  port: number;
  dataDir: string;
  /** 0 = auto-detect from the RPC network at boot. */
  chainId: number;
  corsOrigin: string;
}

/** Minimal .env loader: KEY=VALUE lines, `#` comments, no expansion. */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

const PLACEHOLDER = '0xREPLACE_WITH_ATTESTER_PRIVATE_KEY';

export function loadConfig(envPath = '.env'): Config {
  loadDotEnv(envPath);
  const key = process.env.ATTESTER_PRIVATE_KEY;
  if (!key || key === PLACEHOLDER) {
    throw new Error('ATTESTER_PRIVATE_KEY is required (0x-prefixed 32-byte hex)');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('ATTESTER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string');
  }
  const contract = process.env.CONTRACT_ADDRESS ?? '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) {
    throw new Error('CONTRACT_ADDRESS is required (0x-prefixed 20-byte hex)');
  }
  return {
    rpcUrl: process.env.RPC_URL ?? 'http://127.0.0.1:8545',
    contractAddress: contract,
    attesterPrivateKey: key,
    port: Number(process.env.PORT ?? 3001),
    dataDir: process.env.DATA_DIR ?? './data',
    chainId: Number(process.env.CHAIN_ID ?? 0),
    corsOrigin: process.env.CORS_ORIGIN ?? '*',
  };
}
