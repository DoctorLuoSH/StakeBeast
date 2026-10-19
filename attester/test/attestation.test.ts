/**
 * Attestation tests (attester-service §3.5, §5, §6; contract-design §4):
 * signing gate, final coverage check, EIP-712 shape, idempotent re-serve,
 * refusal permanence, restart recovery, and rotation re-signing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { Status } from '../src/chain';
import { ApiError, AttesterCore } from '../src/core';
import { AttesterStore } from '../src/store';
import { AttestationSigner, recoverSigner, type TypedData } from '../src/signer';
import { CHAIN_ID, CONTRACT, soloSession } from './fake-chain';
import { ATTESTER_KEY, authOf, bindWallet, heartbeatSeries, makeRig, T0_MS, walletA, type Rig } from './helpers';

const START_SEC = Math.floor(T0_MS / 1000) + 120;
const DURATION = 180; // 3-minute demo session
const END_SEC = START_SEC + DURATION;
const DEADLINE_SEC = END_SEC + 600;

/** Bind + heartbeat through the full window; leaves the rig past endTime. */
async function runCleanSession(rig: Rig, sessionId = '7') {
  rig.chain.addSession(sessionId, soloSession(walletA.address, START_SEC, DURATION, Status.Active));
  const { token } = await bindWallet(rig, walletA, sessionId);
  await rig.core.watchOnce(); // learn the window
  rig.advanceTo(START_SEC * 1000);
  heartbeatSeries(rig, token, sessionId, 1, DURATION / 5 + 1); // covers [start, end]
  rig.advanceTo(END_SEC * 1000 + 1_000);
  return { token };
}

test('clean session: attestation issued with frozen EIP-712 fields', async () => {
  const rig = makeRig();
  const { token } = await runCleanSession(rig);
  const auth = authOf(rig, token);
  const res = await rig.core.attestation(auth, '7', {});

  const td = res.typedData as TypedData;
  assert.equal(td.domain.name, 'StakeBeast');
  assert.equal(td.domain.version, '1');
  assert.equal(td.domain.chainId, CHAIN_ID);
  assert.equal(td.domain.verifyingContract, ethers.getAddress(CONTRACT));
  assert.deepEqual(
    td.types.CompletionAttestation.map((f) => `${f.name}:${f.type}`),
    ['sessionId:uint256', 'staker:address', 'partner:address', 'startTime:uint64', 'endTime:uint64', 'expiry:uint64'],
  );
  assert.equal(String(td.message.sessionId), '7');
  assert.equal(td.message.staker, walletA.address);
  assert.equal(td.message.partner, ethers.ZeroAddress);
  assert.equal(td.message.startTime, START_SEC);
  assert.equal(td.message.endTime, END_SEC);
  assert.equal(td.message.expiry, DEADLINE_SEC, 'expiry == settlementDeadline');
  assert.equal(recoverSigner(td, res.signature), new AttestationSigner(ATTESTER_KEY).address);
  assert.equal(auth.session.judgment, 'clean');
  rig.cleanup();
});

test('attestation is idempotent: byte-identical re-serve', async () => {
  const rig = makeRig();
  const { token } = await runCleanSession(rig);
  const auth = authOf(rig, token);
  const first = await rig.core.attestation(auth, '7', {});
  const second = await rig.core.attestation(auth, '7', {});
  assert.deepEqual(first, second);
  rig.cleanup();
});

test('signing gate: 425 pending before the chain confirms endTime', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, START_SEC, DURATION, Status.Active));
  const { token } = await bindWallet(rig, walletA, '7');
  await rig.core.watchOnce();
  rig.advanceTo(START_SEC * 1000);
  heartbeatSeries(rig, token, '7', 1, 10);
  rig.advanceTo(END_SEC * 1000 - 5_000); // chain time still inside the window
  await assert.rejects(rig.core.attestation(authOf(rig, token), '7', {}), (err: ApiError) => err.status === 425);
  rig.cleanup();
});

test('violation -> 409 refused (permanent), tail gap -> refused violation', async () => {
  // (a) hidden event mid-window
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, START_SEC, DURATION, Status.Active));
  const { token } = await bindWallet(rig, walletA, '7');
  await rig.core.watchOnce();
  rig.advanceTo(START_SEC * 1000);
  heartbeatSeries(rig, token, '7', 1, 3);
  rig.core.event(authOf(rig, token), { sessionId: '7', eventId: 'h1', type: 'visibility_hidden', clientTs: rig.nowMs });
  heartbeatSeries(rig, token, '7', 4, DURATION / 5);
  rig.advanceTo(END_SEC * 1000 + 1_000);
  await assert.rejects(rig.core.attestation(authOf(rig, token), '7', {}), (err: ApiError) => {
    assert.equal(err.status, 409);
    assert.equal(err.message, 'violation');
    return true;
  });
  // Refusal is permanent.
  await assert.rejects(rig.core.attestation(authOf(rig, token), '7', {}), (err: ApiError) => err.status === 409);
  rig.cleanup();

  // (b) coverage stops 20 s before endTime: the final coverage check catches
  // the tail gap even though the sweeper never ran after endTime.
  const rig2 = makeRig();
  rig2.chain.addSession('7', soloSession(walletA.address, START_SEC, DURATION, Status.Active));
  const { token: token2 } = await bindWallet(rig2, walletA, '7');
  await rig2.core.watchOnce();
  rig2.advanceTo(START_SEC * 1000);
  // heartbeats from start to end-20s
  const beats = (DURATION - 20) / 5 + 1;
  heartbeatSeries(rig2, token2, '7', 1, beats);
  rig2.advanceTo(END_SEC * 1000 + 1_000);
  await assert.rejects(rig2.core.attestation(authOf(rig2, token2), '7', {}), (err: ApiError) => {
    assert.equal(err.status, 409);
    assert.equal(err.message, 'violation');
    return true;
  });
  rig2.cleanup();
});

test('unreliable time base: clock skew and stale chain data both refuse (§3.6)', async () => {
  // Skew > 30 s between server UTC and a fresh block at signing.
  const rig = makeRig();
  const { token } = await runCleanSession(rig);
  rig.chain.setBlock(Math.floor(rig.nowMs / 1000) - 45); // fresh block, 45 s behind server
  await assert.rejects(rig.core.attestation(authOf(rig, token), '7', {}), (err: ApiError) => {
    assert.equal(err.status, 409);
    assert.equal(err.message, 'unreliable_time');
    return true;
  });
  assert.equal(authOf(rig, token).session.anomaly?.reason, 'clock_skew');
  rig.cleanup();

  // Stale chain data: latest block too old.
  const rig2 = makeRig();
  const { token: token2 } = await runCleanSession(rig2);
  rig2.chain.setBlock(Math.floor(rig2.nowMs / 1000) - 600); // 10 min old
  await assert.rejects(rig2.core.attestation(authOf(rig2, token2), '7', {}), (err: ApiError) => {
    assert.equal(err.message, 'unreliable_time');
    return true;
  });
  assert.equal(authOf(rig2, token2).session.anomaly?.reason, 'stale_chain');
  rig2.cleanup();
});

test('rotation: clean attested session re-signs under the new key after setAttester (R2/§6)', async () => {
  const rig = makeRig();
  const { token } = await runCleanSession(rig);
  const first = await rig.core.attestation(authOf(rig, token), '7', {});
  const firstTd = first.typedData as TypedData;
  assert.equal(recoverSigner(firstTd, first.signature), new AttestationSigner(ATTESTER_KEY).address);

  // Rotate: new service key; the on-chain attester pointer follows (admin tx).
  const newKey = '0x' + '22'.repeat(32);
  const newSigner = new AttestationSigner(newKey);
  rig.chain.attester = newSigner.address;
  const core2 = new AttesterCore(rig.store, rig.chain, newSigner, {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    now: () => rig.nowMs,
  });
  const second = await core2.attestation(authOf(rig, token), '7', {});
  const secondTd = second.typedData as TypedData;
  assert.equal(recoverSigner(secondTd, second.signature), newSigner.address, 're-signed under the new key');
  assert.notEqual(second.signature, first.signature);
  assert.deepEqual(secondTd.message, firstTd.message, 'same session fields');
  // Idempotent after rotation: third fetch returns the new version.
  const third = await core2.attestation(authOf(rig, token), '7', {});
  assert.equal(third.signature, second.signature);
  rig.cleanup();
});
