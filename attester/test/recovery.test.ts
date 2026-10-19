/**
 * Restart recovery tests (attester-service §5, §3.6): journal replay restores
 * the full judgment state; attested sessions re-serve byte-identical proofs;
 * tokens and consumed challenges survive; an in-window downtime gap makes the
 * session uncertifiable (platform-caused) rather than a user violation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Status } from '../src/chain';
import { ApiError, AttesterCore } from '../src/core';
import { AttesterStore } from '../src/store';
import { AttestationSigner } from '../src/signer';
import { CHAIN_ID, CONTRACT, soloSession } from './fake-chain';
import { ATTESTER_KEY, authOf, bindWallet, heartbeatSeries, makeRig, T0_MS, walletA, type Rig } from './helpers';

const START_SEC = Math.floor(T0_MS / 1000) + 120;
const DURATION = 180;
const END_SEC = START_SEC + DURATION;

/** Re-open the store on the same dir, simulating a service restart. */
function restart(rig: Rig): void {
  rig.store.close();
  const now = () => rig.nowMs;
  const monoBase = rig.nowMs;
  // New run id and boot instant; monotonic clock injected for determinism.
  rig.store = new AttesterStore(rig.dir, now, () => rig.nowMs - monoBase);
  rig.core = new AttesterCore(rig.store, rig.chain, new AttestationSigner(ATTESTER_KEY), {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    now,
  });
}

test('restart: attested session re-serves the identical stored signature', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, START_SEC, DURATION, Status.Active));
  const { token } = await bindWallet(rig, walletA, '7');
  await rig.core.watchOnce();
  rig.advanceTo(START_SEC * 1000);
  heartbeatSeries(rig, token, '7', 1, DURATION / 5 + 1);
  rig.advanceTo(END_SEC * 1000 + 1_000);
  const before = await rig.core.attestation(authOf(rig, token), '7', {});

  restart(rig);
  const after = await rig.core.attestation(authOf(rig, token), '7', {});
  assert.deepEqual(after, before, 'byte-identical proof after restart');
  rig.cleanup();
});

test('restart: tokens and consumed challenges survive (R4)', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, START_SEC));
  const ch = rig.core.createChallenge({ chainId: CHAIN_ID, contract: CONTRACT, sessionId: '7', address: walletA.address });
  const bindSig = await walletA.signMessage(ch.message);
  const { clientToken } = await rig.core.bind({
    chainId: CHAIN_ID, contract: CONTRACT, sessionId: '7', address: walletA.address, nonce: ch.nonce, bindSig,
  });
  restart(rig);
  assert.ok(rig.core.authenticate(`Bearer ${clientToken}`), 'client token still valid after restart');
  await assert.rejects(
    rig.core.bind({ chainId: CHAIN_ID, contract: CONTRACT, sessionId: '7', address: walletA.address, nonce: ch.nonce, bindSig }),
    (err: ApiError) => err.code === 'nonce_used',
    'consumed challenge never replays across a restart',
  );
  rig.cleanup();
});

test('restart mid-session: in-window downtime gap -> uncertifiable, not user violation', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, START_SEC, DURATION, Status.Active));
  const { token } = await bindWallet(rig, walletA, '7');
  await rig.core.watchOnce();
  rig.advanceTo(START_SEC * 1000);
  heartbeatSeries(rig, token, '7', 1, 5); // 20 s of clean coverage

  // Service goes down for 60 s inside the window, then restarts.
  rig.advanceBy(60_000);
  restart(rig);
  await rig.core.recoverOnBoot();
  const s = authOf(rig, token).session;
  assert.equal(s.anomaly?.reason, 'restart_gap');
  assert.ok(s.violation === null, 'platform downtime is never blamed on the user');

  // The client reconnects and continues from the server-provided seq (AC-33).
  rig.core.heartbeat(authOf(rig, token), { sessionId: '7', seq: 6, clientTs: rig.nowMs });
  heartbeatSeries(rig, token, '7', 7, 30);
  rig.advanceTo(END_SEC * 1000 + 1_000);
  await assert.rejects(rig.core.attestation(authOf(rig, token), '7', {}), (err: ApiError) => {
    assert.equal(err.status, 409);
    assert.equal(err.message, 'uncertifiable');
    return true;
  });
  rig.cleanup();
});

test('fast restart (< 15 s) inside the window keeps the session attestable', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, START_SEC, DURATION, Status.Active));
  const { token } = await bindWallet(rig, walletA, '7');
  await rig.core.watchOnce();
  rig.advanceTo(START_SEC * 1000);
  heartbeatSeries(rig, token, '7', 1, 5);

  rig.advanceBy(10_000); // downtime shorter than the tolerance window
  restart(rig);
  // Client heartbeats resume immediately after boot; the 10 s gap overlaps the
  // downtime, so coverage stays provable from UTC records.
  heartbeatSeries(rig, token, '7', 6, 40);
  rig.advanceTo(END_SEC * 1000 + 1_000);
  const res = await rig.core.attestation(authOf(rig, token), '7', {});
  assert.ok(res.signature);
  rig.cleanup();
});

test('restart: user silence while the service is demonstrably up is still a violation', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, START_SEC, DURATION, Status.Active));
  const { token } = await bindWallet(rig, walletA, '7');
  await rig.core.watchOnce();
  rig.advanceTo(START_SEC * 1000);
  heartbeatSeries(rig, token, '7', 1, 3);

  rig.advanceBy(5_000);
  restart(rig); // service back up quickly...
  rig.advanceBy(20_000); // ...but the client stays silent for 20 s while up
  rig.core.sweepAll();
  const s = authOf(rig, token).session;
  assert.equal(s.violation?.reason, 'heartbeat_timeout');
  assert.equal(s.anomaly, null);
  rig.cleanup();
});
