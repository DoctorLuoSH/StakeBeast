/**
 * HTTP integration tests: the frozen wire shapes (api-contract §B) end-to-end
 * over a real listening server — auth, CORS, error envelope, and the complete
 * solo focus flow from bind to attestation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Status } from '../src/chain';
import { startServer, type RunningServer } from '../src/server';
import { CHAIN_ID, CONTRACT, soloSession } from './fake-chain';
import { authOf, bindWallet, heartbeatSeries, makeRig, T0_MS, walletA, type Rig } from './helpers';

const START_SEC = Math.floor(T0_MS / 1000) + 120;
const DURATION = 180;
const END_SEC = START_SEC + DURATION;

interface HttpRes {
  status: number;
  body: any;
  headers: http.IncomingHttpHeaders;
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<HttpRes> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        port,
        host: '127.0.0.1',
        method,
        path,
        agent: false, // one-off sockets so server.close() returns promptly
        headers: {
          ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function withServer(rig: Rig, fn: (port: number) => Promise<void>): Promise<void> {
  const running: RunningServer = await startServer(rig.core, {
    port: 0,
    corsOrigin: '*',
    sweepIntervalMs: 60_000,
    watchIntervalMs: 60_000,
  });
  const port = (running.server.address() as { port: number }).port;
  try {
    await fn(port);
  } finally {
    await running.stop();
  }
}

test('HTTP: full solo focus flow over the frozen wire shapes', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, START_SEC));
  await withServer(rig, async (port) => {
    // 1. challenge
    const ch = await request(port, 'POST', '/v1/bind/challenge', {
      chainId: CHAIN_ID,
      contract: CONTRACT,
      sessionId: '7',
      address: walletA.address,
    });
    assert.equal(ch.status, 200);
    assert.match(ch.body.message, /^StakeBeast bind\nChain: 31337\nContract: 0x/);
    assert.match(ch.body.message, /\nSession: 7\nAddress: /);
    assert.match(ch.body.expiresAt, /T.*Z$/);

    // 2. bind
    const bindSig = await walletA.signMessage(ch.body.message);
    const bind = await request(port, 'POST', '/v1/bind', {
      chainId: CHAIN_ID,
      contract: CONTRACT,
      sessionId: '7',
      address: walletA.address,
      nonce: ch.body.nonce,
      bindSig,
    });
    assert.equal(bind.status, 200);
    const token = bind.body.clientToken as string;
    assert.equal(bind.body.status, 'ready');
    assert.equal(bind.body.nextHeartbeatSeq, 1);

    // 3. heartbeats before the start (readiness)
    const hb1 = await request(port, 'POST', '/v1/heartbeat', { sessionId: '7', seq: 1, clientTs: rig.nowMs }, token);
    assert.deepEqual(hb1.body, { ok: true, violation: false });

    // 4. status: participants-only view
    const st = await request(port, 'GET', `/v1/sessions/7/status?chainId=${CHAIN_ID}&contract=${CONTRACT}`, undefined, token);
    assert.equal(st.status, 200);
    assert.equal(st.body.state, 'ready');
    assert.equal(st.body.participants[0].address, walletA.address);
    assert.equal(st.body.participants[0].ready, true);
    assert.equal(st.body.nextHeartbeatSeq, 2);
    assert.equal(st.body.attestationReady, false);

    // 5. start on-chain; watcher learns the window
    rig.chain.addSession('7', soloSession(walletA.address, START_SEC, DURATION, Status.Active));
    await rig.core.watchOnce();
    const st2 = await request(port, 'GET', `/v1/sessions/7/status?chainId=${CHAIN_ID}&contract=${CONTRACT}`, undefined, token);
    assert.equal(st2.body.state, 'monitoring');

    // 6. attestation too early → 425 {state: pending}
    const early = await request(port, 'GET', `/v1/sessions/7/attestation?chainId=${CHAIN_ID}&contract=${CONTRACT}`, undefined, token);
    assert.equal(early.status, 425);
    assert.deepEqual(early.body, { state: 'pending' });

    // 7. full coverage, then the chain confirms the end
    rig.advanceTo(START_SEC * 1000);
    heartbeatSeries(rig, token, '7', 2, DURATION / 5);
    rig.advanceTo(END_SEC * 1000 + 1_000);
    const ok = await request(port, 'GET', `/v1/sessions/7/attestation?chainId=${CHAIN_ID}&contract=${CONTRACT}`, undefined, token);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.typedData.primaryType, 'CompletionAttestation');
    assert.equal(ok.body.typedData.message.startTime, START_SEC);
    assert.match(ok.body.signature, /^0x[0-9a-f]{130}$/);

    // Idempotent over HTTP as well.
    const again = await request(port, 'GET', `/v1/sessions/7/attestation?chainId=${CHAIN_ID}&contract=${CONTRACT}`, undefined, token);
    assert.equal(again.body.signature, ok.body.signature);
  });
  rig.cleanup();
});

test('HTTP: auth, error envelope, CORS, 404', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, START_SEC));
  const { token } = await bindWallet(rig, walletA, '7');
  await withServer(rig, async (port) => {
    const noAuth = await request(port, 'POST', '/v1/heartbeat', { sessionId: '7', seq: 1 });
    assert.equal(noAuth.status, 401);
    assert.deepEqual(Object.keys(noAuth.body.error).sort(), ['code', 'message']);
    assert.equal(noAuth.body.error.code, 'unauthorized');
    assert.equal(noAuth.headers['access-control-allow-origin'], '*');

    const badJson = await new Promise<HttpRes>((resolve, reject) => {
      const req = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/v1/bind', agent: false, headers: { 'content-type': 'application/json' } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()), headers: res.headers }));
      });
      req.on('error', reject);
      req.write('{nope');
      req.end();
    });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, 'bad_request');

    const unknown = await request(port, 'GET', '/v1/whatever', undefined, token);
    assert.equal(unknown.status, 404);

    // Token bound to session 7 cannot read session 8.
    const foreign = await request(port, 'GET', `/v1/sessions/8/status?chainId=${CHAIN_ID}&contract=${CONTRACT}`, undefined, token);
    assert.equal(foreign.status, 404);
  });
  rig.cleanup();
});
