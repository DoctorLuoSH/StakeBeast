/**
 * A.3 check-in upload: byte-identical content-addressed storage, server-side
 * SHA-256 verification against evidenceHash, staker-only writes verified
 * against the chain at write time, and media-type/size validation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { api, login, makeImage, photoForm, sha256Hex, startFixture } from './helpers';
import { makeSession } from './fakeGateway';

async function fixtureWithSession(t: any) {
  const f = await startFixture();
  t.after(f.cleanup);
  const staker = Wallet.createRandom();
  const verifier = Wallet.createRandom();
  f.gateway.addSession('1', makeSession({ staker: staker.address, verifier: verifier.address }));
  return { f, staker, verifier };
}

test('upload stores the photo byte-identical and content-addressed; the hash matches the file', async (t) => {
  const { f, staker } = await fixtureWithSession(t);
  const { token } = await login(f.base, staker);
  const photo = await makeImage(800, 600, 'png');
  const evidenceHash = `0x${sha256Hex(photo)}`;

  const r = await api(f.base, 'POST', '/checkins', {
    token,
    form: photoForm(photo, { sessionId: '1', evidenceHash, periodIndex: '0' }),
  });
  assert.equal(r.status, 201);
  assert.ok(r.json.checkinId);
  assert.match(r.json.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  // Byte-identical storage under media/<sha256>.<ext> (R8).
  const stored = await readFile(join(f.dataDir, 'media', `${sha256Hex(photo)}.png`));
  assert.deepEqual(stored, photo);
  assert.equal(`0x${sha256Hex(stored)}`, evidenceHash);

  // The check-in list reflects the pending anchor state.
  const list = await api(f.base, 'GET', '/sessions/1/checkins', { token });
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 1);
  const item = list.json[0];
  assert.equal(item.checkinId, r.json.checkinId);
  assert.equal(item.periodIndex, 0);
  assert.equal(item.evidenceHash, evidenceHash);
  assert.equal(item.createdAt, r.json.createdAt);
  assert.equal(item.photoUrl, `/api/media/${item.checkinId}`);
  assert.equal(item.thumbUrl, `/api/media/${item.checkinId}?variant=thumb`);
  assert.deepEqual(item.onchain, { status: 'pending', txHash: null, blockNumber: null });
});

test('evidenceHash mismatch with the received bytes is 422 hash_mismatch', async (t) => {
  const { f, staker } = await fixtureWithSession(t);
  const { token } = await login(f.base, staker);
  const photo = await makeImage(400, 300);
  const wrongHash = `0x${sha256Hex(await makeImage(100, 100))}`;
  const r = await api(f.base, 'POST', '/checkins', {
    token,
    form: photoForm(photo, { sessionId: '1', evidenceHash: wrongHash, periodIndex: '0' }),
  });
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, 'hash_mismatch');
  // Nothing was persisted.
  const list = await api(f.base, 'GET', '/sessions/1/checkins', { token });
  assert.equal(list.json.length, 0);
});

test('non-staker (the verifier) cannot check in — 403, verified against chain state', async (t) => {
  const { f, verifier } = await fixtureWithSession(t);
  const { token } = await login(f.base, verifier);
  const photo = await makeImage(200, 200);
  const r = await api(f.base, 'POST', '/checkins', {
    token,
    form: photoForm(photo, { sessionId: '1', evidenceHash: `0x${sha256Hex(photo)}`, periodIndex: '0' }),
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'forbidden');
});

test('check-in on a session the chain does not know is 404', async (t) => {
  const { f, staker } = await fixtureWithSession(t);
  const { token } = await login(f.base, staker);
  const photo = await makeImage(200, 200);
  const r = await api(f.base, 'POST', '/checkins', {
    token,
    form: photoForm(photo, { sessionId: '999', evidenceHash: `0x${sha256Hex(photo)}`, periodIndex: '0' }),
  });
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'not_found');
});

test('photo validation: oversize is 413, wrong type is 400, missing fields are 400', async (t) => {
  const { f, staker } = await fixtureWithSession(t);
  const { token } = await login(f.base, staker);

  const big = Buffer.alloc(5 * 1024 * 1024 + 1, 7);
  const r1 = await api(f.base, 'POST', '/checkins', {
    token,
    form: photoForm(big, { sessionId: '1', evidenceHash: `0x${sha256Hex(big)}`, periodIndex: '0' }),
  });
  assert.equal(r1.status, 413);
  assert.equal(r1.json.error.code, 'bad_request');

  const fd = new FormData();
  fd.append('photo', new Blob(['plain text'], { type: 'text/plain' }), 'note.txt');
  fd.append('sessionId', '1');
  fd.append('evidenceHash', `0x${sha256Hex(Buffer.from('plain text'))}`);
  fd.append('periodIndex', '0');
  const r2 = await api(f.base, 'POST', '/checkins', { token, form: fd });
  assert.equal(r2.status, 400);

  const photo = await makeImage(100, 100);
  const noHash = new FormData();
  noHash.append('photo', new Blob([new Uint8Array(photo)], { type: 'image/png' }), 'p.png');
  noHash.append('sessionId', '1');
  noHash.append('periodIndex', '0');
  const r3 = await api(f.base, 'POST', '/checkins', { token, form: noHash });
  assert.equal(r3.status, 400);

  const r4 = await api(f.base, 'POST', '/checkins', {
    token,
    form: photoForm(photo, { sessionId: '1', evidenceHash: `0x${sha256Hex(photo)}`, periodIndex: '65536' }),
  });
  assert.equal(r4.status, 400);
});

test('jpeg and webp photos are accepted and keep their original format on disk', async (t) => {
  const { f, staker } = await fixtureWithSession(t);
  const { token } = await login(f.base, staker);
  for (const [format, ext, mime] of [
    ['jpeg', '.jpg', 'image/jpeg'],
    ['webp', '.webp', 'image/webp'],
  ] as const) {
    const photo = await makeImage(320, 240, format);
    const r = await api(f.base, 'POST', '/checkins', {
      token,
      form: photoForm(photo, { sessionId: '1', evidenceHash: `0x${sha256Hex(photo)}`, periodIndex: '1' }, mime, `photo${ext}`),
    });
    assert.equal(r.status, 201);
    const stored = await readFile(join(f.dataDir, 'media', `${sha256Hex(photo)}${ext}`));
    assert.deepEqual(stored, photo);
  }
});

test('check-in upload requires auth', async (t) => {
  const { f } = await fixtureWithSession(t);
  const photo = await makeImage(100, 100);
  const r = await api(f.base, 'POST', '/checkins', {
    form: photoForm(photo, { sessionId: '1', evidenceHash: `0x${sha256Hex(photo)}`, periodIndex: '0' }),
  });
  assert.equal(r.status, 401);
});
