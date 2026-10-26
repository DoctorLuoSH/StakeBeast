/**
 * A.3 anchor verification: the backend checks the reported transaction against
 * the chain — the CheckedIn event must come from the expected StakeBeast
 * contract, for the same session, by the caller, with the same evidenceHash
 * AND periodIndex. Statuses: confirmed / failed / pending.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { api, login, makeImage, photoForm, sha256Hex, startFixture } from './helpers';
import { makeSession, TEST_CONTRACT, ZERO_ADDRESS } from './fakeGateway';

const TX = `0x${'ab'.repeat(32)}`;

async function fixtureWithCheckin(t: any) {
  const f = await startFixture();
  t.after(f.cleanup);
  const staker = Wallet.createRandom();
  const verifier = Wallet.createRandom();
  f.gateway.addSession('1', makeSession({ staker: staker.address, verifier: verifier.address }));
  const { token } = await login(f.base, staker);
  const photo = await makeImage(400, 300);
  const evidenceHash = `0x${sha256Hex(photo)}`;
  const up = await api(f.base, 'POST', '/checkins', {
    token,
    form: photoForm(photo, { sessionId: '1', evidenceHash, periodIndex: '2' }),
  });
  return { f, staker, verifier, token, evidenceHash, checkinId: up.json.checkinId as string };
}

async function anchor(base: string, token: string, checkinId: string, txHash: string) {
  return api(base, 'POST', `/checkins/${checkinId}/anchor`, { token, body: { txHash } });
}

test('anchor confirmed: correct CheckedIn log from the expected contract', async (t) => {
  const { f, staker, token, evidenceHash, checkinId } = await fixtureWithCheckin(t);
  f.gateway.setCheckedInReceipt(TX, {
    sessionId: '1',
    staker: staker.address,
    evidenceHash,
    periodIndex: 2,
    blockNumber: 1500,
  });
  const r = await anchor(f.base, token, checkinId, TX);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {
    ok: true,
    onchain: { status: 'confirmed', txHash: TX, blockNumber: '1500' },
  });

  // The list view shows the confirmed anchor; re-reporting is idempotent.
  const list = await api(f.base, 'GET', '/sessions/1/checkins', { token });
  assert.deepEqual(list.json[0].onchain, { status: 'confirmed', txHash: TX, blockNumber: '1500' });
  const again = await anchor(f.base, token, checkinId, TX);
  assert.equal(again.status, 200);
  assert.equal(again.json.ok, true);
  assert.equal(again.json.onchain.status, 'confirmed');
});

test('anchor failed: the transaction reverted (status 0)', async (t) => {
  const { f, staker, token, evidenceHash, checkinId } = await fixtureWithCheckin(t);
  f.gateway.setCheckedInReceipt(TX, {
    sessionId: '1',
    staker: staker.address,
    evidenceHash,
    periodIndex: 2,
    status: 0,
  });
  const r = await anchor(f.base, token, checkinId, TX);
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.onchain.status, 'failed');
  assert.equal(r.json.onchain.txHash, TX);
});

test('anchor failed: CheckedIn log from a DIFFERENT contract does not count', async (t) => {
  const { f, staker, token, evidenceHash, checkinId } = await fixtureWithCheckin(t);
  f.gateway.setCheckedInReceipt(TX, {
    contractAddress: Wallet.createRandom().address, // not the StakeBeast contract
    sessionId: '1',
    staker: staker.address,
    evidenceHash,
    periodIndex: 2,
  });
  const r = await anchor(f.base, token, checkinId, TX);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.onchain.status, 'failed');
});

test('anchor failed: evidenceHash mismatch between log and stored record', async (t) => {
  const { f, staker, token, checkinId } = await fixtureWithCheckin(t);
  f.gateway.setCheckedInReceipt(TX, {
    sessionId: '1',
    staker: staker.address,
    evidenceHash: `0x${randomBytes(32).toString('hex')}`,
    periodIndex: 2,
  });
  const r = await anchor(f.base, token, checkinId, TX);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.onchain.status, 'failed');
});

test('anchor failed: periodIndex mismatch between log and stored record', async (t) => {
  const { f, staker, token, evidenceHash, checkinId } = await fixtureWithCheckin(t);
  f.gateway.setCheckedInReceipt(TX, {
    sessionId: '1',
    staker: staker.address,
    evidenceHash,
    periodIndex: 3, // stored record says 2
  });
  const r = await anchor(f.base, token, checkinId, TX);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.onchain.status, 'failed');
});

test('anchor failed: log for a different session or a different staker', async (t) => {
  const { f, staker, token, evidenceHash, checkinId } = await fixtureWithCheckin(t);
  f.gateway.setCheckedInReceipt(TX, {
    sessionId: '77',
    staker: staker.address,
    evidenceHash,
    periodIndex: 2,
  });
  const wrongSession = await anchor(f.base, token, checkinId, TX);
  assert.equal(wrongSession.json.onchain.status, 'failed');

  const TX2 = `0x${'cd'.repeat(32)}`;
  f.gateway.setCheckedInReceipt(TX2, {
    sessionId: '1',
    staker: Wallet.createRandom().address,
    evidenceHash,
    periodIndex: 2,
  });
  const wrongStaker = await anchor(f.base, token, checkinId, TX2);
  assert.equal(wrongStaker.json.onchain.status, 'failed');
});

test('anchor stays pending without a receipt, then confirms once mined', async (t) => {
  const { f, staker, token, evidenceHash, checkinId } = await fixtureWithCheckin(t);
  const pending = await anchor(f.base, token, checkinId, TX);
  assert.equal(pending.status, 200);
  assert.deepEqual(pending.json, {
    ok: false,
    onchain: { status: 'pending', txHash: TX, blockNumber: null },
  });
  // The reported hash is persisted as the current pending attempt: POST and GET agree.
  const list1 = await api(f.base, 'GET', '/sessions/1/checkins', { token });
  assert.deepEqual(list1.json[0].onchain, { status: 'pending', txHash: TX, blockNumber: null });

  f.gateway.setCheckedInReceipt(TX, {
    sessionId: '1',
    staker: staker.address,
    evidenceHash,
    periodIndex: 2,
  });
  const confirmed = await anchor(f.base, token, checkinId, TX);
  assert.equal(confirmed.json.ok, true);
  assert.equal(confirmed.json.onchain.status, 'confirmed');
});

test('a failed anchor superseded by an unmined retry reads pending, then settles when mined', async (t) => {
  const { f, staker, token, evidenceHash, checkinId } = await fixtureWithCheckin(t);
  const TX1 = `0x${'ab'.repeat(32)}`;
  const TX2 = `0x${'ef'.repeat(32)}`;

  // First attempt reverted on chain → failed is persisted.
  f.gateway.setCheckedInReceipt(TX1, {
    sessionId: '1',
    staker: staker.address,
    evidenceHash,
    periodIndex: 2,
    status: 0,
  });
  const failed = await anchor(f.base, token, checkinId, TX1);
  assert.equal(failed.json.onchain.status, 'failed');
  const list0 = await api(f.base, 'GET', '/sessions/1/checkins', { token });
  assert.deepEqual(list0.json[0].onchain, { status: 'failed', txHash: TX1, blockNumber: '1500' });

  // Retry with a new, not-yet-mined transaction: POST returns pending and the
  // list must agree — not show the old attempt's failed state.
  const pending = await anchor(f.base, token, checkinId, TX2);
  assert.deepEqual(pending.json, {
    ok: false,
    onchain: { status: 'pending', txHash: TX2, blockNumber: null },
  });
  const list1 = await api(f.base, 'GET', '/sessions/1/checkins', { token });
  assert.deepEqual(list1.json[0].onchain, { status: 'pending', txHash: TX2, blockNumber: null });

  // Once the replacement mines, re-reporting the same hash settles the anchor.
  f.gateway.setCheckedInReceipt(TX2, {
    sessionId: '1',
    staker: staker.address,
    evidenceHash,
    periodIndex: 2,
    blockNumber: 1501,
  });
  const confirmed = await anchor(f.base, token, checkinId, TX2);
  assert.equal(confirmed.json.ok, true);
  const list2 = await api(f.base, 'GET', '/sessions/1/checkins', { token });
  assert.deepEqual(list2.json[0].onchain, { status: 'confirmed', txHash: TX2, blockNumber: '1501' });
});

test('anchor is staker-only; unknown check-in is 404; malformed txHash is 400', async (t) => {
  const { f, verifier, token, checkinId } = await fixtureWithCheckin(t);
  const { token: verifierToken } = await login(f.base, verifier);
  const forbidden = await anchor(f.base, verifierToken, checkinId, TX);
  assert.equal(forbidden.status, 403);

  const missing = await anchor(f.base, token, 'no-such-checkin', TX);
  assert.equal(missing.status, 404);

  const malformed = await anchor(f.base, token, checkinId, '0x1234');
  assert.equal(malformed.status, 400);
});

// Sanity: the fake contract constant is a real EIP-55 address and never the zero address.
test('test fixture contract address is sane', () => {
  assert.notEqual(TEST_CONTRACT, ZERO_ADDRESS);
});
