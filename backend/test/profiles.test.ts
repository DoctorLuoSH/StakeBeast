/**
 * A.2 profiles: auto-provisioning (incl. generated placeholder avatar), GET /
 * PUT /profiles/me with nickname validation, avatar upload re-encoded to
 * 256x256 webp, and the public profile endpoint.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import sharp from 'sharp';
import { api, login, makeImage, startFixture } from './helpers';

test('first verify auto-provisions profile and a deterministic 256x256 webp placeholder avatar', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const wallet = Wallet.createRandom();
  const { profile } = await login(f.base, wallet);
  assert.equal(profile.nickname, `beast-${wallet.address.slice(-4).toLowerCase()}`);
  assert.ok(profile.createdAt);

  const avatar = await readFile(join(f.dataDir, 'avatars', `${wallet.address}.webp`));
  const meta = await sharp(avatar).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 256);
  assert.equal(meta.height, 256);

  // Deterministic: a fresh fixture for the same address yields identical bytes.
  const f2 = await startFixture();
  t.after(f2.cleanup);
  await login(f2.base, wallet);
  const avatar2 = await readFile(join(f2.dataDir, 'avatars', `${wallet.address}.webp`));
  assert.deepEqual(avatar2, avatar);
});

test('GET /profiles/me returns address, nickname, avatarUrl, createdAt', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const wallet = Wallet.createRandom();
  const { token } = await login(f.base, wallet);
  const me = await api(f.base, 'GET', '/profiles/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.json.address, wallet.address);
  assert.equal(me.json.nickname, `beast-${wallet.address.slice(-4).toLowerCase()}`);
  assert.equal(me.json.avatarUrl, `/api/avatars/${wallet.address}`);
  assert.match(me.json.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('PUT /profiles/me updates the nickname; public profile reflects it', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const wallet = Wallet.createRandom();
  const { token } = await login(f.base, wallet);
  const put = await api(f.base, 'PUT', '/profiles/me', { token, body: { nickname: 'Beast Tamer' } });
  assert.equal(put.status, 200);
  assert.equal(put.json.nickname, 'Beast Tamer');

  // Public profile needs no auth.
  const pub = await api(f.base, 'GET', `/profiles/${wallet.address}`);
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.json, {
    address: wallet.address,
    nickname: 'Beast Tamer',
    avatarUrl: `/api/avatars/${wallet.address}`,
  });
});

test('nickname validation: empty, >32 chars, and HTML are rejected', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const wallet = Wallet.createRandom();
  const { token } = await login(f.base, wallet);
  for (const nickname of ['', 'x'.repeat(33), '<script>alert(1)</script>', 'a<b', 'x>y']) {
    const r = await api(f.base, 'PUT', '/profiles/me', { token, body: { nickname } });
    assert.equal(r.status, 400, `nickname ${JSON.stringify(nickname)} should be rejected`);
    assert.equal(r.json.error.code, 'bad_request');
  }
  const ok = await api(f.base, 'PUT', '/profiles/me', { token, body: { nickname: 'x'.repeat(32) } });
  assert.equal(ok.status, 200);
});

test('avatar upload re-encodes to 256x256 webp and is served publicly', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const wallet = Wallet.createRandom();
  const { token } = await login(f.base, wallet);

  const png = await makeImage(512, 512, 'png');
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'me.png');
  const up = await api(f.base, 'POST', '/profiles/me/avatar', { token, form: fd });
  assert.equal(up.status, 200);
  assert.equal(up.json.avatarUrl, `/api/avatars/${wallet.address}`);

  const stored = await readFile(join(f.dataDir, 'avatars', `${wallet.address}.webp`));
  const meta = await sharp(stored).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 256);
  assert.equal(meta.height, 256);

  const served = await fetch(`${f.base}/avatars/${wallet.address}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/webp');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), stored);
});

test('avatar upload rejects wrong types, oversize files, and missing field', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const wallet = Wallet.createRandom();
  const { token } = await login(f.base, wallet);

  const wrongType = new FormData();
  wrongType.append('file', new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
  const r1 = await api(f.base, 'POST', '/profiles/me/avatar', { token, form: wrongType });
  assert.equal(r1.status, 400);

  const big = new FormData();
  big.append('file', new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/png' }), 'big.png');
  const r2 = await api(f.base, 'POST', '/profiles/me/avatar', { token, form: big });
  assert.equal(r2.status, 413);

  const r3 = await api(f.base, 'POST', '/profiles/me/avatar', { token, form: new FormData() });
  assert.equal(r3.status, 400);
});

test('public profile of an unknown address is 404; malformed address is 400', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const unknown = await api(f.base, 'GET', `/profiles/${Wallet.createRandom().address}`);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'not_found');
  const malformed = await api(f.base, 'GET', '/profiles/0x1234');
  assert.equal(malformed.status, 400);
});
