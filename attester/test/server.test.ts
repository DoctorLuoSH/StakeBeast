/**
 * HTTP smoke tests over the real server, with an injected controllable clock.
 * Verifies the endpoint wiring around the judgment core (fail-closed behavior
 * included); detailed rule coverage lives in judgment.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttesterServer } from '../src/server';
import { SessionStore } from '../src/store';
import { createSigner } from '../src/signer';
import type { Config } from '../src/config';

const ADDR = '0x1111111111111111111111111111111111111111';
const T0 = 1_760_000_000_000;
const MIN = 60_000;

interface Fixture {
  server: Server;
  port: number;
  clock: { now: number };
  cleanup: () => Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'attester-http-'));
  const clock = { now: T0 };
  const config: Config = { port: 0, dbPath: join(dir, 'db.json'), attesterPrivateKey: undefined, chainId: 11155111 };
  const server = createAttesterServer({
    config,
    store: new SessionStore(config.dbPath),
    signer: createSigner(config),
    now: () => clock.now,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    clock,
    cleanup: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : (rmSync(dir, { recursive: true, force: true }), resolve()))),
      ),
  };
}

function call(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test('HTTP: full clean lifecycle ends 501 (EIP-712 pending DAPP-2), violations end 403', async () => {
  const fx = await startFixture();
  try {
    const health = await call(fx.port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);

    // --- Clean session: register, bind, heartbeat on cadence until endTime. ---
    const created = await call(fx.port, 'POST', '/sessions', {
      sessionId: 'clean', participant: ADDR, startTime: T0, durationMs: 25 * MIN,
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.endTime, T0 + 25 * MIN);

    fx.clock.now = T0 + 1_000;
    const bound = await call(fx.port, 'POST', '/sessions/clean/bind', { participant: ADDR });
    assert.equal(bound.status, 200);
    assert.equal(bound.json.bindTime, T0 + 1_000);

    for (let t = T0 + 6_000; t <= T0 + 25 * MIN; t += 5_000) {
      fx.clock.now = t;
      const hb = await call(fx.port, 'POST', '/sessions/clean/heartbeat', { participant: ADDR });
      assert.equal(hb.status, 200);
      assert.equal(hb.json.violation, null);
    }

    fx.clock.now = T0 + 25 * MIN - 1;
    const early = await call(fx.port, 'POST', '/sessions/clean/proof', { participant: ADDR });
    assert.equal(early.status, 403); // declared duration not fully elapsed

    fx.clock.now = T0 + 25 * MIN;
    const proof = await call(fx.port, 'POST', '/sessions/clean/proof', { participant: ADDR });
    assert.equal(proof.status, 501); // eligible, but EIP-712 fields frozen in DAPP-2
    assert.equal(proof.json.error, 'eip712_not_finalized');

    // --- Violated session: 20s gap, reconnect keeps the violation, proof 403. ---
    await call(fx.port, 'POST', '/sessions', { sessionId: 'gap', participant: ADDR, startTime: T0, durationMs: 25 * MIN });
    fx.clock.now = T0 + 1_000;
    await call(fx.port, 'POST', '/sessions/gap/bind', { participant: ADDR });
    fx.clock.now = T0 + 6_000;
    await call(fx.port, 'POST', '/sessions/gap/heartbeat', { participant: ADDR });
    fx.clock.now = T0 + 26_000; // 20s after the last heartbeat
    const late = await call(fx.port, 'POST', '/sessions/gap/heartbeat', { participant: ADDR });
    assert.equal(late.status, 200);
    assert.equal(late.json.violation, 'heartbeat_timeout');
    assert.equal(late.json.violatedAt, T0 + 6_000 + 15_000);
    fx.clock.now = T0 + 25 * MIN;
    const denied = await call(fx.port, 'POST', '/sessions/gap/proof', { participant: ADDR });
    assert.equal(denied.status, 403);

    // --- Hidden event: immediate violation visible via GET. ---
    await call(fx.port, 'POST', '/sessions', { sessionId: 'hid', participant: ADDR, startTime: T0, durationMs: 25 * MIN });
    fx.clock.now = T0 + 1_000;
    await call(fx.port, 'POST', '/sessions/hid/bind', { participant: ADDR });
    fx.clock.now = T0 + 10_000;
    const hid = await call(fx.port, 'POST', '/sessions/hid/hidden', { participant: ADDR });
    assert.equal(hid.status, 200);
    assert.equal(hid.json.violation, 'hidden');
    const viewed = await call(fx.port, 'GET', '/sessions/hid');
    assert.equal(viewed.json.violation, 'hidden');

    // --- Late bind: refused 403 and the refusal sticks. ---
    await call(fx.port, 'POST', '/sessions', { sessionId: 'late', participant: ADDR, startTime: T0, durationMs: 25 * MIN });
    fx.clock.now = T0 + 5 * MIN + 1;
    const lateBind = await call(fx.port, 'POST', '/sessions/late/bind', { participant: ADDR });
    assert.equal(lateBind.status, 403);
    assert.equal(lateBind.json.error, 'bind_window_expired');

    // --- Misc: unknown session, bad body, wrong participant. ---
    assert.equal((await call(fx.port, 'GET', '/sessions/nope')).status, 404);
    assert.equal((await call(fx.port, 'POST', '/sessions', { sessionId: 'bad' })).status, 400);
    fx.clock.now = T0 + 2_000;
    const wrong = await call(fx.port, 'POST', '/sessions/clean/heartbeat', { participant: '0x2222222222222222222222222222222222222222' });
    assert.equal(wrong.status, 409);
  } finally {
    await fx.cleanup();
  }
});

test('HTTP: registered state survives a restart (second server over same db file)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attester-http-restart-'));
  const dbPath = join(dir, 'db.json');
  const clock = { now: T0 };
  const config: Config = { port: 0, dbPath, attesterPrivateKey: undefined, chainId: 11155111 };

  const first = createAttesterServer({ config, store: new SessionStore(dbPath), signer: createSigner(config), now: () => clock.now });
  await new Promise<void>((resolve) => first.listen(0, '127.0.0.1', resolve));
  const port1 = (first.address() as AddressInfo).port;
  await call(port1, 'POST', '/sessions', { sessionId: 's', participant: ADDR, startTime: T0, durationMs: 25 * MIN });
  clock.now = T0 + 1_000;
  await call(port1, 'POST', '/sessions/s/bind', { participant: ADDR });
  clock.now = T0 + 7_000;
  const hid = await call(port1, 'POST', '/sessions/s/hidden', { participant: ADDR });
  assert.equal(hid.json.violation, 'hidden');
  await new Promise<void>((resolve, reject) => first.close((e) => (e ? reject(e) : resolve())));

  // "Restart": new store + server over the same file.
  const second = createAttesterServer({ config, store: new SessionStore(dbPath), signer: createSigner(config), now: () => clock.now });
  await new Promise<void>((resolve) => second.listen(0, '127.0.0.1', resolve));
  const port2 = (second.address() as AddressInfo).port;
  const viewed = await call(port2, 'GET', '/sessions/s');
  assert.equal(viewed.status, 200);
  assert.equal(viewed.json.bindTime, T0 + 1_000);
  assert.equal(viewed.json.violation, 'hidden');
  assert.equal(viewed.json.violatedAt, T0 + 7_000);
  await new Promise<void>((resolve, reject) =>
    second.close((e) => (e ? reject(e) : (rmSync(dir, { recursive: true, force: true }), resolve()))),
  );
});
