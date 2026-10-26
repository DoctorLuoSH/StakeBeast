/**
 * A.1 login flow: real wallets, real personal_sign signatures, real JWTs.
 * Covers the exact challenge message, 24h token claims, auto-provisioning,
 * challenge expiry, nonce single-use (consumed on failed attempts too), bad
 * signatures, and the /auth/* rate limit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import jwt from 'jsonwebtoken';
import { api, login, startFixture } from './helpers';

test('challenge returns the exact signable message; verify issues a 24h JWT and auto-provisions a profile', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const wallet = Wallet.createRandom();

  const ch = await api(f.base, 'POST', '/auth/challenge', { body: { address: wallet.address } });
  assert.equal(ch.status, 200);
  const { nonce, message, expiresAt } = ch.json;
  assert.match(nonce, /^[0-9a-f]{32}$/);
  assert.match(
    message,
    new RegExp(
      `^StakeBeast login\\nAddress: ${wallet.address}\\nNonce: ${nonce}\\nIssued: \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$`,
    ),
  );
  assert.ok(Date.parse(expiresAt) > Date.now(), 'expiresAt is in the future');
  assert.ok(Date.parse(expiresAt) <= Date.now() + 5 * 60_000, 'challenge valid at most 5 minutes');

  const signature = await wallet.signMessage(message);
  const v = await api(f.base, 'POST', '/auth/verify', { body: { address: wallet.address, signature } });
  assert.equal(v.status, 200);

  const claims = jwt.decode(v.json.token) as { sub: string; iat: number; exp: number };
  assert.equal(claims.sub, wallet.address);
  assert.equal(claims.exp - claims.iat, 24 * 3600);
  // Token actually verifies against the configured secret.
  const verified = jwt.verify(v.json.token, f.config.jwtSecret) as { sub: string };
  assert.equal(verified.sub, wallet.address);

  assert.equal(v.json.profile.address, wallet.address);
  assert.equal(v.json.profile.nickname, `beast-${wallet.address.slice(-4).toLowerCase()}`);
  assert.equal(v.json.profile.avatarUrl, `/api/avatars/${wallet.address}`);
});

test('expired challenge is rejected with 401 challenge_expired', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const wallet = Wallet.createRandom();
  const ch = await api(f.base, 'POST', '/auth/challenge', { body: { address: wallet.address } });
  const signature = await wallet.signMessage(ch.json.message);
  f.db.handle
    .prepare('UPDATE challenges SET expires_at = ? WHERE nonce = ?')
    .run('2020-01-01T00:00:00Z', ch.json.nonce);
  const v = await api(f.base, 'POST', '/auth/verify', { body: { address: wallet.address, signature } });
  assert.equal(v.status, 401);
  assert.equal(v.json.error.code, 'challenge_expired');
});

test('nonce is single-use: a successful verify cannot be replayed', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const wallet = Wallet.createRandom();
  const ch = await api(f.base, 'POST', '/auth/challenge', { body: { address: wallet.address } });
  const signature = await wallet.signMessage(ch.json.message);
  const first = await api(f.base, 'POST', '/auth/verify', { body: { address: wallet.address, signature } });
  assert.equal(first.status, 200);
  const replay = await api(f.base, 'POST', '/auth/verify', { body: { address: wallet.address, signature } });
  assert.equal(replay.status, 401);
  assert.equal(replay.json.error.code, 'nonce_used');
});

test('a FAILED verify attempt consumes the nonce (AC-14)', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const wallet = Wallet.createRandom();
  const other = Wallet.createRandom();
  const ch = await api(f.base, 'POST', '/auth/challenge', { body: { address: wallet.address } });
  // Other wallet signs the challenge — recovery will not match the address.
  const badSig = await other.signMessage(ch.json.message);
  const failed = await api(f.base, 'POST', '/auth/verify', { body: { address: wallet.address, signature: badSig } });
  assert.equal(failed.status, 401);
  // Even the correct signature now fails: the nonce was consumed by the attempt.
  const goodSig = await wallet.signMessage(ch.json.message);
  const after = await api(f.base, 'POST', '/auth/verify', { body: { address: wallet.address, signature: goodSig } });
  assert.equal(after.status, 401);
  assert.equal(after.json.error.code, 'nonce_used');
});

test('bad signature (signer mismatch and wrong message) is 401', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const wallet = Wallet.createRandom();
  const other = Wallet.createRandom();
  const ch = await api(f.base, 'POST', '/auth/challenge', { body: { address: wallet.address } });

  const wrongSigner = await other.signMessage(ch.json.message);
  const r1 = await api(f.base, 'POST', '/auth/verify', { body: { address: wallet.address, signature: wrongSigner } });
  assert.equal(r1.status, 401);

  const wrongMessage = await wallet.signMessage('StakeBeast login\nWrong');
  const r2 = await api(f.base, 'POST', '/auth/verify', { body: { address: wallet.address, signature: wrongMessage } });
  assert.equal(r2.status, 401);

  const garbage = await api(f.base, 'POST', '/auth/verify', {
    body: { address: wallet.address, signature: '0xdeadbeef' },
  });
  assert.equal(garbage.status, 401);
});

test('verify without a prior challenge is 401', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const wallet = Wallet.createRandom();
  const sig = await wallet.signMessage('anything');
  const v = await api(f.base, 'POST', '/auth/verify', { body: { address: wallet.address, signature: sig } });
  assert.equal(v.status, 401);
});

test('a fresh challenge after a failed attempt verifies fine', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const wallet = Wallet.createRandom();
  const other = Wallet.createRandom();
  const ch1 = await api(f.base, 'POST', '/auth/challenge', { body: { address: wallet.address } });
  const badSig = await other.signMessage(ch1.json.message);
  await api(f.base, 'POST', '/auth/verify', { body: { address: wallet.address, signature: badSig } });
  const { token } = await login(f.base, wallet);
  const me = await api(f.base, 'GET', '/profiles/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.json.address, wallet.address);
});

test('rate limit: 100 req/min/IP on /auth/* (A.5)', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const wallet = Wallet.createRandom();
  for (let i = 0; i < 100; i++) {
    const r = await api(f.base, 'POST', '/auth/challenge', { body: { address: wallet.address } });
    assert.equal(r.status, 200, `request ${i + 1} should pass`);
  }
  const limited = await api(f.base, 'POST', '/auth/challenge', { body: { address: wallet.address } });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, 'too_many_requests');
});

test('protected routes reject missing / garbage tokens with the error envelope', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const noToken = await api(f.base, 'GET', '/profiles/me');
  assert.equal(noToken.status, 401);
  assert.equal(noToken.json.error.code, 'unauthorized');
  const badToken = await api(f.base, 'GET', '/profiles/me', { token: 'not-a-jwt' });
  assert.equal(badToken.status, 401);
});

test('malformed address input is a 400 bad_request', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const r = await api(f.base, 'POST', '/auth/challenge', { body: { address: 'not-an-address' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'bad_request');
});
