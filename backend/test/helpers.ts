/**
 * Shared test fixture: the real Express app on an ephemeral port, a real
 * SQLite database in a temp dir, real wallet signatures, and the injected
 * fake ChainGateway. Helpers for HTTP calls, login, and image generation.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { createApp } from '../src/app';
import { BackendDb } from '../src/db';
import type { Config } from '../src/config';
import { FakeChainGateway, TEST_CONTRACT } from './fakeGateway';

export interface Fixture {
  base: string;
  server: Server;
  db: BackendDb;
  gateway: FakeChainGateway;
  config: Config;
  dataDir: string;
  cleanup: () => Promise<void>;
}

export interface FixtureOptions {
  sessionCacheTtlMs?: number;
  indexThrottleMs?: number;
  reviewPageSize?: number;
  authRateLimitMax?: number;
}

export async function startFixture(opts: FixtureOptions = {}): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), 'sb-backend-'));
  const config: Config = {
    port: 0,
    rpcUrl: 'http://127.0.0.1:8545',
    contractAddress: TEST_CONTRACT,
    chainId: 31337,
    jwtSecret: 'test-secret',
    dataDir,
    frontendOrigin: 'http://localhost:5173',
    indexerStartBlock: 0,
  };
  const db = new BackendDb(dataDir);
  const gateway = new FakeChainGateway();
  const app = createApp({
    config,
    db,
    gateway,
    sessionCacheTtlMs: opts.sessionCacheTtlMs ?? 0,
    indexThrottleMs: opts.indexThrottleMs ?? 0,
    reviewPageSize: opts.reviewPageSize ?? 20,
    authRateLimitMax: opts.authRateLimitMax ?? 100,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}/api`;
  return {
    base,
    server,
    db,
    gateway,
    config,
    dataDir,
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export interface ApiResult {
  status: number;
  json: any;
  headers: Headers;
  text: string;
}

export async function api(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; form?: FormData; headers?: Record<string, string> } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  let body: string | FormData | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // binary or empty body
  }
  return { status: res.status, json, headers: res.headers, text };
}

/** Structural wallet type — Wallet.createRandom() returns HDNodeWallet. */
export interface SignerLike {
  address: string;
  signMessage(message: string): Promise<string>;
}

/** Full login round-trip with a real personal_sign signature. */
export async function login(base: string, wallet: SignerLike): Promise<{ token: string; profile: any }> {
  const ch = await api(base, 'POST', '/auth/challenge', { body: { address: wallet.address } });
  assert.equal(ch.status, 200);
  const signature = await wallet.signMessage(ch.json.message);
  const v = await api(base, 'POST', '/auth/verify', { body: { address: wallet.address, signature } });
  assert.equal(v.status, 200);
  return { token: v.json.token, profile: v.json.profile };
}

export async function makeImage(
  width = 800,
  height = 600,
  format: 'png' | 'jpeg' | 'webp' = 'png',
): Promise<Buffer> {
  const img = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: (width * 7) % 255, g: (height * 3) % 255, b: 180 },
      noise: { type: 'gaussian', mean: 128, sigma: 5 },
    },
  });
  if (format === 'jpeg') return img.jpeg().toBuffer();
  if (format === 'webp') return img.webp().toBuffer();
  return img.png().toBuffer();
}

export function photoForm(
  photo: Buffer,
  fields: { sessionId: string; evidenceHash: string; periodIndex: string },
  mime = 'image/png',
  filename = 'photo.png',
): FormData {
  const fd = new FormData();
  fd.append('photo', new Blob([new Uint8Array(photo)], { type: mime }), filename);
  fd.append('sessionId', fields.sessionId);
  fd.append('evidenceHash', fields.evidenceHash);
  fd.append('periodIndex', fields.periodIndex);
  return fd;
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
