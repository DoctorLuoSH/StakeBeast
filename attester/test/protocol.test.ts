/**
 * Heartbeat / event / arming protocol tests (attester-service §3.2–3.4):
 * seq discipline (AC-30), eventId dedup (AC-29), late window learning
 * re-evaluation (AC-27), 15 s gap rule, permanence of violations.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Status } from '../src/chain';
import { ApiError } from '../src/core';
import { encodeStartSession, cofocusSession, CONTRACT, soloSession } from './fake-chain';
import { authOf, bindWallet, heartbeatSeries, makeRig, T0_MS, TX_HASH, walletA, walletB } from './helpers';

const START_SEC = Math.floor(T0_MS / 1000) + 120; // session starts 2 min after t0

function setupActive(rig: ReturnType<typeof makeRig>, sessionId = '7'): void {
  // Chain session becomes Active with a concrete window.
  rig.chain.addSession(sessionId, soloSession(walletA.address, START_SEC, 180, Status.Active));
}

test('arming: validates the start tx, then window learned from chain', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, START_SEC));
  const { token } = await bindWallet(rig, walletA, '7');
  const auth = authOf(rig, token);

  rig.chain.addTx(TX_HASH, {
    to: CONTRACT,
    from: walletA.address,
    data: encodeStartSession('7'),
    nonce: 0,
    receipt: null, // pending
  });
  const armed = await rig.core.arm(auth, { sessionId: '7', txHash: TX_HASH });
  assert.equal(armed.state, 'arming');

  // Tx confirms → session Active on-chain → watcher learns the window.
  setupActive(rig);
  rig.chain.txs.get(TX_HASH.toLowerCase())!.receipt = { status: 1 };
  await rig.core.watchOnce();
  const s = rig.store.sessions.get([31337, CONTRACT.toLowerCase(), '7'].join(':'))!;
  assert.deepEqual(s.window, { startTime: START_SEC, endTime: START_SEC + 180, settlementDeadline: START_SEC + 780 });
  assert.equal(rig.core.lifecycleOf(s, rig.nowMs), 'monitoring');

  // Duplicate arm after the start is ignored and never pauses monitoring.
  const dup = await rig.core.arm(auth, { sessionId: '7', txHash: TX_HASH });
  assert.equal(dup.state, 'monitoring');
  rig.cleanup();
});

test('arming rejects txs that are not this session start', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, START_SEC));
  const { token } = await bindWallet(rig, walletA, '7');
  const auth = authOf(rig, token);
  const other = walletB.address;

  rig.chain.addTx('0x' + '01'.repeat(32), { to: CONTRACT, from: other, data: encodeStartSession('7'), nonce: 0, receipt: null });
  rig.chain.addTx('0x' + '02'.repeat(32), { to: CONTRACT, from: walletA.address, data: encodeStartSession('8'), nonce: 0, receipt: null });
  rig.chain.addTx('0x' + '03'.repeat(32), { to: walletA.address, from: walletA.address, data: '0x', nonce: 0, receipt: null });

  await assert.rejects(rig.core.arm(auth, { sessionId: '7', txHash: '0x' + '01'.repeat(32) }), (e: ApiError) => e.code === 'bad_request');
  await assert.rejects(rig.core.arm(auth, { sessionId: '7', txHash: '0x' + '02'.repeat(32) }), (e: ApiError) => e.code === 'bad_request');
  await assert.rejects(rig.core.arm(auth, { sessionId: '7', txHash: '0x' + '03'.repeat(32) }), (e: ApiError) => e.code === 'bad_request');
  await assert.rejects(rig.core.arm(auth, { sessionId: '7', txHash: '0x' + 'ff'.repeat(32) }), (e: ApiError) => e.code === 'bad_request');
  rig.cleanup();
});

test('heartbeat seq: only strictly-increasing seq refreshes liveness (AC-30)', async () => {
  const rig = makeRig();
  setupActive(rig);
  const { token } = await bindWallet(rig, walletA, '7');
  const auth = authOf(rig, token);

  // Window learned; heartbeats begin at startTime.
  await rig.core.watchOnce();
  rig.advanceTo(START_SEC * 1000);
  rig.core.heartbeat(auth, { sessionId: '7', seq: 5, clientTs: rig.nowMs });
  assert.equal(auth.participant.highestSeq, 5);

  // Replays / reorders are acknowledged but never refresh liveness.
  rig.advanceBy(20_000); // > 15 s of silence
  rig.core.heartbeat(auth, { sessionId: '7', seq: 3, clientTs: rig.nowMs }); // replayed old seq
  const s = auth.session;
  assert.equal(s.violation?.reason, 'heartbeat_timeout', 'replayed seq cannot keep a dead client online');
  assert.equal(s.violation?.participant, walletA.address.toLowerCase());
  rig.cleanup();
});

test('15 s window boundary: 14 s silence tolerated, 16 s flagged; recovery never clears', async () => {
  const rig = makeRig();
  setupActive(rig);
  const { token } = await bindWallet(rig, walletA, '7');
  const auth = authOf(rig, token);
  await rig.core.watchOnce();

  rig.advanceTo(START_SEC * 1000);
  rig.core.heartbeat(auth, { sessionId: '7', seq: 1, clientTs: rig.nowMs });
  rig.advanceBy(14_000);
  rig.core.heartbeat(auth, { sessionId: '7', seq: 2, clientTs: rig.nowMs });
  assert.equal(auth.session.violation?.reason, undefined);

  rig.advanceBy(16_000); // silence of 16 s > tolerance
  rig.core.sweepAll();
  const v1 = auth.session.violation;
  assert.equal(v1?.reason, 'heartbeat_timeout');
  assert.equal(v1?.atMs, START_SEC * 1000 + 14_000 + 15_000);

  // Recovery never clears the flag.
  rig.core.heartbeat(auth, { sessionId: '7', seq: 3, clientTs: rig.nowMs });
  const v2 = auth.session.violation;
  assert.equal(v2?.reason, 'heartbeat_timeout');
  rig.cleanup();
});

test('hidden event during arming, received inside the window, scores after late learning (AC-27)', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, START_SEC));
  const { token } = await bindWallet(rig, walletA, '7');
  const auth = authOf(rig, token);
  rig.chain.addTx(TX_HASH, { to: CONTRACT, from: walletA.address, data: encodeStartSession('7'), nonce: 0, receipt: null });
  await rig.core.arm(auth, { sessionId: '7', txHash: TX_HASH });

  // Chain start already happened, service has not learned it yet (still arming):
  // a hidden event received (server UTC) inside the window must score.
  setupActive(rig);
  rig.advanceTo(START_SEC * 1000 + 5_000);
  rig.core.event(auth, { sessionId: '7', eventId: 'ev-1', type: 'visibility_hidden', clientTs: rig.nowMs });
  assert.equal(auth.session.violation?.reason, undefined, 'not yet scored while the window is unknown');

  await rig.core.watchOnce(); // learns the window, re-evaluates journaled records
  const v = auth.session.violation;
  assert.equal(v?.reason, 'hidden');
  rig.cleanup();
});

test('event dedup: repeated eventId ignored, first-sight processing regardless of heartbeat order (AC-29)', async () => {
  const rig = makeRig();
  setupActive(rig);
  const { token } = await bindWallet(rig, walletA, '7');
  const auth = authOf(rig, token);
  await rig.core.watchOnce();

  rig.advanceTo(START_SEC * 1000 + 10_000);
  // A newer heartbeat arrives BEFORE the hidden event: the event still scores.
  rig.core.heartbeat(auth, { sessionId: '7', seq: 9, clientTs: rig.nowMs });
  const r1 = rig.core.event(auth, { sessionId: '7', eventId: 'ev-x', type: 'visibility_hidden', clientTs: rig.nowMs });
  assert.equal(r1.violation, true);
  const r2 = rig.core.event(auth, { sessionId: '7', eventId: 'ev-x', type: 'visibility_hidden', clientTs: rig.nowMs });
  assert.equal(r2.violation, true, 'repeat is a no-op that reports the standing flag');
  assert.equal(auth.session.events[walletA.address.toLowerCase()].length, 1, 'deduped by eventId');
  rig.cleanup();
});

test('out-of-window events are never scored (arming bubble + post-end immunity)', async () => {
  const rig = makeRig();
  setupActive(rig);
  const { token } = await bindWallet(rig, walletA, '7');
  const auth = authOf(rig, token);
  await rig.core.watchOnce();

  // Hidden event BEFORE startTime: never scored (pre-start bubble).
  rig.core.event(auth, { sessionId: '7', eventId: 'ev-pre', type: 'visibility_hidden', clientTs: rig.nowMs });
  // Heartbeats through the whole window.
  rig.advanceTo(START_SEC * 1000);
  heartbeatSeries(rig, token, '7', 1, 37); // 180 s of coverage
  assert.ok(auth.session.violation === null);

  // After endTime: switching to the wallet (hidden event) cannot flip the result.
  rig.advanceTo((START_SEC + 181) * 1000);
  rig.core.event(auth, { sessionId: '7', eventId: 'ev-post', type: 'visibility_hidden', clientTs: rig.nowMs });
  assert.ok(auth.session.violation === null);
  rig.cleanup();
});

test('D1 regression: <5 s heartbeat intervals never false-flag a timeout (journal throttle)', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, START_SEC, 60, Status.Active));
  const { token } = await bindWallet(rig, walletA, '7');
  const auth = authOf(rig, token);
  await rig.core.watchOnce();

  // Review reproduction: accepted heartbeats at +0 s / +4 s / +18 s. The +4 s
  // record fell under the 5 s journal throttle, leaving a phantom 18 s gap.
  rig.advanceTo(START_SEC * 1000);
  rig.core.heartbeat(auth, { sessionId: '7', seq: 1, clientTs: rig.nowMs });
  rig.advanceBy(4_000);
  rig.core.heartbeat(auth, { sessionId: '7', seq: 2, clientTs: rig.nowMs });
  rig.advanceBy(14_000);
  rig.core.heartbeat(auth, { sessionId: '7', seq: 3, clientTs: rig.nowMs });
  assert.equal(auth.session.violation, null, 'gaps are 4 s and 14 s — both inside the grace');

  // The next arrival is where the phantom 0→18 s gap used to be scored.
  rig.advanceBy(5_000);
  rig.core.heartbeat(auth, { sessionId: '7', seq: 4, clientTs: rig.nowMs });
  assert.equal(auth.session.violation, null, 'no false heartbeat_timeout from throttled journaling');

  // A compliant user must get the proof: finish the window and collect it.
  heartbeatSeries(rig, token, '7', 5, 8); // +28 s … +63 s cadence
  rig.advanceTo((START_SEC + 61) * 1000);
  const res = await rig.core.attestation(auth, '7', {});
  assert.ok(res.signature);
  rig.cleanup();
});

test('D2 regression: a heartbeat arriving AFTER endTime does not cover the in-window tail gap', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, START_SEC, 60, Status.Active));
  const { token } = await bindWallet(rig, walletA, '7');
  const auth = authOf(rig, token);
  await rig.core.watchOnce();

  // Clean coverage until +40 s of a 60 s window, silence, next arrival +61 s.
  rig.advanceTo(START_SEC * 1000);
  heartbeatSeries(rig, token, '7', 1, 9); // +0 s … +40 s
  rig.advanceTo((START_SEC + 61) * 1000);
  rig.core.heartbeat(auth, { sessionId: '7', seq: 10, clientTs: rig.nowMs });

  // The out-of-window arrival must not mask the 40 s → 60 s gap: 20 s of
  // in-window silence is a violation (frozen rule — out-of-window events do
  // not change the judgment).
  const v = auth.session.violation;
  assert.equal(v?.reason, 'heartbeat_timeout');
  assert.equal(v?.atMs, START_SEC * 1000 + 55_000, 'gap runs past grace at +40 s + 15 s');

  await assert.rejects(rig.core.attestation(auth, '7', {}), (err: ApiError) => {
    assert.equal(err.status, 409);
    assert.equal(err.message, 'violation');
    return true;
  });
  rig.cleanup();
});

test('D2 boundary: a heartbeat arriving exactly AT endTime counts as in-window coverage', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, START_SEC, 60, Status.Active));
  const { token } = await bindWallet(rig, walletA, '7');
  const auth = authOf(rig, token);
  await rig.core.watchOnce();

  // Full 5 s cadence through the window, last beat exactly at endTime.
  rig.advanceTo(START_SEC * 1000);
  heartbeatSeries(rig, token, '7', 1, 12); // +0 s … +55 s
  rig.advanceTo((START_SEC + 60) * 1000);
  rig.core.heartbeat(auth, { sessionId: '7', seq: 13, clientTs: rig.nowMs });
  assert.equal(auth.session.violation, null, 'arrival at the end moment is inside the window');

  const res = await rig.core.attestation(auth, '7', {});
  assert.ok(res.signature, 'clean window with an end-exact last beat is attestable');
  rig.cleanup();
});

test('D2 regression: late-learned window re-evaluation ignores the after-end arrival for the tail', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, START_SEC));
  const { token } = await bindWallet(rig, walletA, '7');
  const auth = authOf(rig, token);
  rig.chain.addTx(TX_HASH, { to: CONTRACT, from: walletA.address, data: encodeStartSession('7'), nonce: 0, receipt: null });
  await rig.core.arm(auth, { sessionId: '7', txHash: TX_HASH });

  // The start confirms on-chain but the service has not learned the window
  // yet (still `arming`): coverage arrives 0…40 s, then one late beat +61 s.
  rig.chain.addSession('7', soloSession(walletA.address, START_SEC, 60, Status.Active));
  rig.advanceTo(START_SEC * 1000);
  heartbeatSeries(rig, token, '7', 1, 9); // +0 s … +40 s while the window is unknown locally
  rig.advanceTo((START_SEC + 61) * 1000);
  rig.core.heartbeat(auth, { sessionId: '7', seq: 10, clientTs: rig.nowMs });
  assert.equal(auth.session.violation, null, 'nothing scored before the window is learned');

  await rig.core.watchOnce(); // learns [start, start+60] and re-evaluates the journal
  const s = auth.session;
  assert.equal(s.violation?.reason, 'heartbeat_timeout');
  assert.equal(s.violation?.atMs, START_SEC * 1000 + 55_000);
  assert.equal(s.judgment, 'violation');
  await assert.rejects(rig.core.attestation(auth, '7', {}), (err: ApiError) => err.status === 409 && err.message === 'violation');
  rig.cleanup();
});

test('late new bind after startTime + 5 min -> too_late (co-focus partner, AC-21)', async () => {
  const rig = makeRig();
  rig.chain.addSession('9', cofocusSession(walletA.address, walletB.address, START_SEC, 180, Status.Active));
  // Staker binds on time; the watcher learns the window.
  await bindWallet(rig, walletA, '9');
  await rig.core.watchOnce();

  // Partner's FIRST bind lands after startTime + 5 min: permanently unattestable.
  rig.advanceTo((START_SEC + 301) * 1000);
  await assert.rejects(bindWallet(rig, walletB, '9'), (err: ApiError) => err.status === 403 && err.code === 'too_late');
  const s = rig.store.sessions.get([31337, CONTRACT.toLowerCase(), '9'].join(':'))!;
  assert.equal(s.violation?.reason, 'bind_timeout');
  rig.cleanup();
});

test('late bind with window not yet learned locally -> refused late_bind at judgment', async () => {
  const rig = makeRig();
  rig.chain.addSession('7', soloSession(walletA.address, START_SEC, 180, Status.Active));
  // Staker's first bind happens after startTime + 5 min while the service has
  // not learned the window yet: the bind succeeds, but judgment is fail-closed.
  rig.advanceTo((START_SEC + 301) * 1000);
  const { token } = await bindWallet(rig, walletA, '7');
  await rig.core.watchOnce(); // learns the window
  rig.advanceTo((START_SEC + 200) * 1000 > rig.nowMs ? (START_SEC + 301) * 1000 : rig.nowMs);
  rig.advanceTo((START_SEC + 181) * 1000); // past endTime
  const auth = authOf(rig, token);
  await assert.rejects(
    rig.core.attestation(auth, '7', {}),
    (err: ApiError) => err.status === 409 && err.code === 'refused' && err.message === 'late_bind',
  );
  rig.cleanup();
});
