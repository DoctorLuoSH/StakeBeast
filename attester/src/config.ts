/**
 * Service configuration from environment variables (secrets only ever come from
 * the environment; nothing is hard-coded in the repo). A minimal `.env` file
 * loader is included so local one-command startup works without extra deps.
 */

import { existsSync, readFileSync } from 'node:fs';

export interface Config {
  port: number;
  dbPath: string;
  /** 0x-prefixed 32-byte key for EIP-712 proof signing, undefined if unset. */
  attesterPrivateKey: string | undefined;
  chainId: number;
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
  const usableKey = key && key !== PLACEHOLDER ? key : undefined;
  if (usableKey && !/^0x[0-9a-fA-F]{64}$/.test(usableKey)) {
    throw new Error('ATTESTER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string');
  }
  if (!usableKey) {
    // Signing is not active yet (EIP-712 fields pending DAPP-2), so this is a
    // warning, not a fatal error. It becomes fatal once proof issuance lands.
    console.warn('[config] ATTESTER_PRIVATE_KEY not set; proof signing is disabled');
  }
  return {
    port: Number(process.env.PORT ?? 8787),
    dbPath: process.env.ATTESTER_DB_PATH ?? './data/attester.json',
    attesterPrivateKey: usableKey,
    chainId: Number(process.env.CHAIN_ID ?? 11155111),
  };
}
