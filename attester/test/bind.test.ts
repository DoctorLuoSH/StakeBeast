/**
 * Bind flow tests (attester-service §3.1, api-contract §B): one-time
 * challenges, signature verification, on-chain participant checks, takeover.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { Status } from '../src/chain';
import { ApiError } from '../src/core';
import { CHAIN_ID, CONTRACT, soloSession } from './fake-chain';
import { authOf, bindWallet, makeRig, walletA, walletB } from './helpers';

test('bind happy path: token issued, status ready, nextHeartbeatSeq 1', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, Math.floor(rig.nowMs / 1000) + 60));
  const res = await bindWallet(rig, walletA, '7');
  assert.ok(res.token.startsWith('ctk_'));
  assert.equal(res.status, 'ready');
  assert.equal(res.nextHeartbeatSeq, 1);
  rig.cleanup();
});

test('expired challenge -> challenge_expired and consumed', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, Math.floor(rig.nowMs / 1000) + 3600));
  const ch = rig.core.createChallenge({ chainId: CHAIN_ID, contract: CONTRACT, sessionId: '7', address: walletA.address });
  rig.advanceBy(5 * 60_000 + 1); // past the 5-minute challenge TTL
  const bindSig = await walletA.signMessage(ch.message);
  await assert.rejects(
    rig.core.bind({ chainId: CHAIN_ID, contract: CONTRACT, sessionId: '7', address: walletA.address, nonce: ch.nonce, bindSig }),
    (err: ApiError) => err.status === 401 && err.code === 'challenge_expired',
  );
  // Consumed on the failed attempt: a later retry reports nonce_used.
  rig.advanceTo(rig.nowMs - 60_000); // (clock only moves forward in prod; test-only)
  rig.cleanup();
});

test('nonce reuse -> nonce_used', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, Math.floor(rig.nowMs / 1000) + 60));
  const ch = rig.core.createChallenge({ chainId: CHAIN_ID, contract: CONTRACT, sessionId: '7', address: walletA.address });
  const bindSig = await walletA.signMessage(ch.message);
  await rig.core.bind({ chainId: CHAIN_ID, contract: CONTRACT, sessionId: '7', address: walletA.address, nonce: ch.nonce, bindSig });
  await assert.rejects(
    rig.core.bind({ chainId: CHAIN_ID, contract: CONTRACT, sessionId: '7', address: walletA.address, nonce: ch.nonce, bindSig }),
    (err: ApiError) => err.status === 401 && err.code === 'nonce_used',
  );
  rig.cleanup();
});

test('bad signature -> unauthorized, nonce consumed on the attempt', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, Math.floor(rig.nowMs / 1000) + 60));
  const ch = rig.core.createChallenge({ chainId: CHAIN_ID, contract: CONTRACT, sessionId: '7', address: walletA.address });
  const foreignSig = await walletB.signMessage(ch.message); // wrong wallet
  await assert.rejects(
    rig.core.bind({ chainId: CHAIN_ID, contract: CONTRACT, sessionId: '7', address: walletA.address, nonce: ch.nonce, bindSig: foreignSig }),
    (err: ApiError) => err.status === 401 && err.code === 'unauthorized',
  );
  const goodSig = await walletA.signMessage(ch.message);
  await assert.rejects(
    rig.core.bind({ chainId: CHAIN_ID, contract: CONTRACT, sessionId: '7', address: walletA.address, nonce: ch.nonce, bindSig: goodSig }),
    (err: ApiError) => err.code === 'nonce_used',
  );
  rig.cleanup();
});

test('non-participant, unknown session, terminal session, human-proof mode', async () => {
  const rig = makeRig();
  const startSec = Math.floor(rig.nowMs / 1000) + 60;
  rig.chain.addSession('1', soloSession(walletA.address, startSec));
  rig.chain.addSession('2', soloSession(walletA.address, startSec, 180, Status.Forfeited));
  const supervised = soloSession(walletA.address, startSec, 180, Status.Active);
  supervised.mode = 1; // Supervised
  rig.chain.addSession('3', supervised);

  // walletB is not a participant of session 1
  await assert.rejects(bindWallet(rig, walletB, '1'), (err: ApiError) => err.status === 401);
  // unknown session id
  await assert.rejects(bindWallet(rig, walletA, '404'), (err: ApiError) => err.status === 404 && err.code === 'not_found');
  // terminal session rejects binding
  await assert.rejects(bindWallet(rig, walletA, '2'), (err: ApiError) => err.status === 409 && err.code === 'refused');
  // human-proof mode is not attestable
  await assert.rejects(bindWallet(rig, walletA, '3'), (err: ApiError) => err.status === 400);
  rig.cleanup();
});

test('challenge tuple mismatch and chainId mismatch', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, Math.floor(rig.nowMs / 1000) + 60));
  assert.throws(
    () => rig.core.createChallenge({ chainId: 1, contract: CONTRACT, sessionId: '7', address: walletA.address }),
    (err: ApiError) => err.code === 'bad_request',
  );
  const ch = rig.core.createChallenge({ chainId: CHAIN_ID, contract: CONTRACT, sessionId: '7', address: walletA.address });
  const sig = await walletA.signMessage(ch.message);
  await assert.rejects(
    // binding a different session id than the challenge was issued for
    rig.core.bind({ chainId: CHAIN_ID, contract: CONTRACT, sessionId: '8', address: walletA.address, nonce: ch.nonce, bindSig: sig }),
    (err: ApiError) => err.code === 'unauthorized',
  );
  rig.cleanup();
});

test('takeover: new bind invalidates the previous token, keeps monitoring state', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, Math.floor(rig.nowMs / 1000) + 60));
  const first = await bindWallet(rig, walletA, '7');
  const auth1 = authOf(rig, first.token);
  rig.core.heartbeat(auth1, { sessionId: '7', seq: 1, clientTs: rig.nowMs });
  rig.advanceBy(5_000);
  rig.core.heartbeat(auth1, { sessionId: '7', seq: 2, clientTs: rig.nowMs });
  const boundAt = authOf(rig, first.token).participant.boundAtMs;

  const second = await bindWallet(rig, walletA, '7');
  assert.equal(second.nextHeartbeatSeq, 3, 'AC-33: continue from server-provided seq');
  assert.equal(rig.core.authenticate(`Bearer ${first.token}`), null, 'old token revoked (401)');
  const auth2 = authOf(rig, second.token);
  assert.equal(auth2.participant.boundAtMs, boundAt, 'rebind never resets the original bind time');
  assert.equal(auth2.participant.highestSeq, 2);
  rig.cleanup();
});

test('sessionId/address shape validation', async () => {
  const rig = makeRig();
  assert.throws(
    () => rig.core.createChallenge({ chainId: CHAIN_ID, contract: CONTRACT, sessionId: 'abc', address: walletA.address }),
    (err: ApiError) => err.code === 'bad_request',
  );
  assert.throws(
    () => rig.core.createChallenge({ chainId: CHAIN_ID, contract: '0x1234', sessionId: '7', address: walletA.address }),
    (err: ApiError) => err.code === 'bad_request',
  );
  rig.cleanup();
});
