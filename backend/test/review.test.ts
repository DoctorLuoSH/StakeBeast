/**
 * A.3 verifier review list: SessionCreated event discovery into the mirror,
 * chain-refresh of session fields, verifier-only filtering on Active
 * sessions, embedded latest check-ins, and offset-cursor pagination.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { api, login, makeImage, photoForm, sha256Hex, startFixture } from './helpers';
import { makeSession } from './fakeGateway';

test('review/pending lists only Active sessions the caller verifies, with profile, params, and latest check-ins', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const staker = Wallet.createRandom();
  const verifier = Wallet.createRandom();
  const other = Wallet.createRandom();

  // Session 1: Active, verified by `verifier`. Session 2: still Pending.
  // Session 3: Active but verified by someone else. All three are discovered
  // via SessionCreated events.
  f.gateway.addSession('1', makeSession({ staker: staker.address, verifier: verifier.address, status: 1 }));
  f.gateway.addSession('2', makeSession({ staker: staker.address, verifier: verifier.address, status: 0 }));
  f.gateway.addSession('3', makeSession({ staker: staker.address, verifier: other.address, status: 1 }));
  f.gateway.emitCreated('1');
  f.gateway.emitCreated('2');
  f.gateway.emitCreated('3');

  const { token: stakerToken } = await login(f.base, staker); // provisions staker profile
  for (let i = 0; i < 2; i++) {
    const photo = await makeImage(200 + i, 200);
    await api(f.base, 'POST', '/checkins', {
      token: stakerToken,
      form: photoForm(photo, { sessionId: '1', evidenceHash: `0x${sha256Hex(photo)}`, periodIndex: String(i) }),
    });
  }

  const { token: verifierToken } = await login(f.base, verifier);
  const r = await api(f.base, 'GET', '/review/pending', { token: verifierToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 1, 'only the Active session verified by the caller');

  const item = r.json[0];
  assert.equal(item.sessionId, '1');
  assert.equal(item.staker, staker.address);
  assert.equal(item.nickname, `beast-${staker.address.slice(-4).toLowerCase()}`);
  assert.equal(item.avatarUrl, `/api/avatars/${staker.address}`);
  assert.equal(item.criterion, 'run 5 km every day');
  assert.equal(item.periodDays, 7);
  assert.equal(item.targetCount, 5);
  assert.equal(item.latestCheckins.length, 2);
  assert.equal(item.latestCheckins[0].periodIndex, 0);
  assert.equal(item.latestCheckins[1].periodIndex, 1);
  assert.equal(item.latestCheckins[0].photoUrl, `/api/media/${item.latestCheckins[0].checkinId}`);
  assert.deepEqual(item.onchain, { status: 1, settlementDeadline: 1_893_456_000 });
});

test('sessions without a SessionCreated event are not discovered', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const verifier = Wallet.createRandom();
  // Session exists on chain but no SessionCreated event was scanned.
  f.gateway.addSession('9', makeSession({ staker: Wallet.createRandom().address, verifier: verifier.address, status: 1 }));
  const { token } = await login(f.base, verifier);
  const r = await api(f.base, 'GET', '/review/pending', { token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, []);

  // Once the event lands in a later block, the next scan picks it up.
  f.gateway.block = 1001;
  f.gateway.emitCreated('9');
  const r2 = await api(f.base, 'GET', '/review/pending', { token });
  assert.equal(r2.json.length, 1);
  assert.equal(r2.json[0].sessionId, '9');
});

test('review list mirrors chain state: a session that settles drops out on refresh', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const verifier = Wallet.createRandom();
  const session = makeSession({ staker: Wallet.createRandom().address, verifier: verifier.address, status: 1 });
  f.gateway.addSession('1', session);
  f.gateway.emitCreated('1');
  const { token } = await login(f.base, verifier);
  assert.equal((await api(f.base, 'GET', '/review/pending', { token })).json.length, 1);

  // Completed (2) on chain — the mirror refresh picks it up.
  f.gateway.addSession('1', { ...session, status: 2 });
  assert.equal((await api(f.base, 'GET', '/review/pending', { token })).json.length, 0);
});

test('offset cursor paginates the review list', async (t) => {
  const f = await startFixture({ reviewPageSize: 1 });
  t.after(f.cleanup);
  const verifier = Wallet.createRandom();
  for (const id of ['1', '2']) {
    f.gateway.addSession(id, makeSession({ staker: Wallet.createRandom().address, verifier: verifier.address, status: 1 }));
    f.gateway.emitCreated(id);
  }
  const { token } = await login(f.base, verifier);

  const page1 = await api(f.base, 'GET', '/review/pending', { token });
  assert.equal(page1.json.length, 1);
  assert.equal(page1.json[0].sessionId, '1');

  const page2 = await api(f.base, 'GET', '/review/pending?cursor=1', { token });
  assert.equal(page2.json.length, 1);
  assert.equal(page2.json[0].sessionId, '2');

  const page3 = await api(f.base, 'GET', '/review/pending?cursor=2', { token });
  assert.equal(page3.json.length, 0);

  const badCursor = await api(f.base, 'GET', '/review/pending?cursor=abc', { token });
  assert.equal(badCursor.status, 400);
});

test('review/pending requires auth', async (t) => {
  const f = await startFixture();
  t.after(f.cleanup);
  const r = await api(f.base, 'GET', '/review/pending');
  assert.equal(r.status, 401);
});
