/**
 * A.3 media + party authorization: check-in lists and evidence media are
 * readable by the staker, the verifier, and the duel linked-position staker —
 * nobody else. Originals round-trip byte-exact with `Cache-Control: private`;
 * thumbs are webp <= 512px. Plus the CORS allowlist (A.5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import sharp from 'sharp';
import { api, login, makeImage, photoForm, sha256Hex, startFixture } from './helpers';
import { makeSession } from './fakeGateway';

async function duelFixture(t: any) {
  const f = await startFixture();
  t.after(f.cleanup);
  const stakerX = Wallet.createRandom();
  const stakerY = Wallet.createRandom();
  const verifier = Wallet.createRandom();
  const stranger = Wallet.createRandom();
  // Duel positions 10 and 11 link to each other.
  f.gateway.addSession('10', makeSession({ mode: 2, staker: stakerX.address, verifier: verifier.address, linkedSessionId: '11' }));
  f.gateway.addSession('11', makeSession({ mode: 2, staker: stakerY.address, linkedSessionId: '10' }));
  const { token: tokenX } = await login(f.base, stakerX);
  const photo = await makeImage(1200, 900, 'png'); // larger than the thumb bound
  const evidenceHash = `0x${sha256Hex(photo)}`;
  const up = await api(f.base, 'POST', '/checkins', {
    token: tokenX,
    form: photoForm(photo, { sessionId: '10', evidenceHash, periodIndex: '0' }),
  });
  assert.equal(up.status, 201);
  return { f, stakerX, stakerY, verifier, stranger, photo, checkinId: up.json.checkinId as string };
}

test('party members read the check-in list; strangers get 403', async (t) => {
  const { f, stakerY, verifier, stranger } = await duelFixture(t);
  for (const [who, wallet, expected] of [
    ['linked duel staker', stakerY, 200],
    ['verifier', verifier, 200],
    ['stranger', stranger, 403],
  ] as const) {
    const { token } = await login(f.base, wallet);
    const r = await api(f.base, 'GET', '/sessions/10/checkins', { token });
    assert.equal(r.status, expected, who);
    if (expected === 200) assert.equal(r.json.length, 1);
  }
});

test('media original round-trips byte-exact with original content type and Cache-Control: private', async (t) => {
  const { f, stakerY, photo, checkinId } = await duelFixture(t);
  const { token } = await login(f.base, stakerY);
  const res = await fetch(`${f.base}/media/${checkinId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'private');
  const body = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(body, photo, 'the original bytes are the verification input (R8)');
});

test('media thumb variant is webp and bounded to 512px', async (t) => {
  const { f, verifier, checkinId } = await duelFixture(t);
  const { token } = await login(f.base, verifier);
  const res = await fetch(`${f.base}/media/${checkinId}?variant=thumb`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp');
  assert.equal(res.headers.get('cache-control'), 'private');
  const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
  assert.equal(meta.format, 'webp');
  assert.ok((meta.width ?? 0) <= 512 && (meta.height ?? 0) <= 512);
});

test('media enforces the same party authorization (AC-14)', async (t) => {
  const { f, stranger, checkinId } = await duelFixture(t);
  const { token } = await login(f.base, stranger);
  const res = await fetch(`${f.base}/media/${checkinId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 403);
  const body: any = await res.json();
  assert.equal(body.error.code, 'forbidden');

  const noAuth = await fetch(`${f.base}/media/${checkinId}`);
  assert.equal(noAuth.status, 401);
});

test('check-in list on an unknown session is 404', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const { token } = await login(f.base, Wallet.createRandom());
  const r = await api(f.base, 'GET', '/sessions/4242/checkins', { token });
  assert.equal(r.status, 404);
});

test('CORS allows only the configured frontend origin', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);

  const allowed = await fetch(`${f.base}/health`, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');

  const denied = await fetch(`${f.base}/health`, { headers: { Origin: 'http://evil.example.com' } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);

  const preflight = await fetch(`${f.base}/auth/challenge`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});

test('unknown routes return the error envelope as JSON', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const r = await api(f.base, 'GET', '/nope');
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'not_found');
});
