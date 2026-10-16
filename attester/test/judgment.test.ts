/**
 * Unit tests for the heartbeat judgment core.
 * Covers baseline v1.4 D2 / section 4.1 and acceptance cases AC-12 and AC-16.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BIND_WINDOW_MS,
  HEARTBEAT_GRACE_MS,
  canIssueProof,
  createSession,
  endTime,
  evaluate,
  recordBind,
  recordHeartbeat,
  recordHidden,
  type SessionState,
} from '../src/judgment';

const ADDR = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const T0 = 1_760_000_000_000; // fixed reference instant (ms epoch)
const MIN = 60_000;

/** A bound, clean 25-minute session, ready for heartbeat scenarios. */
function boundSession(durationMs = 25 * MIN): SessionState {
  const s = createSession('session-1', ADDR, T0, durationMs);
  const r = recordBind(s, ADDR, T0 + 1_000);
  assert.ok(r.ok);
  return r.state;
}

/** Drive heartbeats every `stepMs` from `fromMs` to `toMs` inclusive-ish. */
function heartbeatSeries(s: SessionState, fromMs: number, toMs: number, stepMs = 5_000): SessionState {
  let state = s;
  for (let t = fromMs; t <= toMs; t += stepMs) {
    const r = recordHeartbeat(state, ADDR, t);
    assert.ok(r.ok);
    state = r.state;
  }
  return state;
}

// --- AC-12: refresh with a 10s interruption recovers without violation ---

test('AC-12: 10s interruption (refresh) does not mark a violation', () => {
  let s = boundSession();
  s = heartbeatSeries(s, T0 + 5_000, T0 + 20_000);
  const r = recordHeartbeat(s, ADDR, T0 + 30_000); // 10s gap from t=20s
  assert.ok(r.ok);
  assert.equal(r.state.violation, null);
  assert.equal(evaluate(r.state, T0 + 30_000).violation, null);
});

// --- AC-12: a page-hidden event marks a violation immediately ---

test('AC-12: page-hidden event marks violation immediately and permanently', () => {
  let s = boundSession();
  s = heartbeatSeries(s, T0 + 5_000, T0 + 10_000);
  const r = recordHidden(s, ADDR, T0 + 12_000);
  assert.ok(r.ok);
  assert.equal(r.state.violation, 'hidden');
  assert.equal(r.state.violatedAt, T0 + 12_000);
  // Staying visible afterwards and heartbeating on cadence never clears it.
  const after = heartbeatSeries(r.state, T0 + 17_000, T0 + 30_000);
  assert.equal(after.violation, 'hidden');
  assert.equal(canIssueProof(after, endTime(after) + 1), false);
});

// --- AC-12: a 20s interruption is a violation and recovery does not clear it ---

test('AC-12: 20s interruption marks violation; reconnect does not clear it', () => {
  let s = boundSession();
  s = heartbeatSeries(s, T0 + 5_000, T0 + 10_000); // last heartbeat at T0+10s
  const r = recordHeartbeat(s, ADDR, T0 + 30_000); // 20s gap
  assert.ok(r.ok);
  assert.equal(r.state.violation, 'heartbeat_timeout');
  assert.equal(r.state.violatedAt, T0 + 10_000 + HEARTBEAT_GRACE_MS); // deterministic timestamp
  const resumed = heartbeatSeries(r.state, T0 + 35_000, T0 + 60_000);
  assert.equal(resumed.violation, 'heartbeat_timeout');
  assert.equal(resumed.violatedAt, T0 + 10_000 + HEARTBEAT_GRACE_MS);
  assert.equal(canIssueProof(resumed, endTime(resumed) + 1), false);
});

// --- 15s window boundary ---

test('boundary: exactly 15s interruption is tolerated, 15s+1ms is a violation', () => {
  const base = heartbeatSeries(boundSession(), T0 + 5_000, T0 + 10_000);

  const atLimit = recordHeartbeat(base, ADDR, T0 + 10_000 + HEARTBEAT_GRACE_MS);
  assert.ok(atLimit.ok);
  assert.equal(atLimit.state.violation, null);

  const overLimit = recordHeartbeat(base, ADDR, T0 + 10_000 + HEARTBEAT_GRACE_MS + 1);
  assert.equal(overLimit.state.violation, 'heartbeat_timeout');
});

// --- First heartbeat after bind must also respect the window ---

test('first heartbeat more than 15s after bind marks a violation', () => {
  const s = boundSession(); // bound at T0+1s, lastHeartbeatAt = T0+1s
  const r = recordHeartbeat(s, ADDR, T0 + 1_000 + HEARTBEAT_GRACE_MS + 1);
  assert.equal(r.state.violation, 'heartbeat_timeout');
  assert.equal(r.state.violatedAt, T0 + 1_000 + HEARTBEAT_GRACE_MS);
});

// --- Sweeper path: evaluate() flags an ongoing silence without a new event ---

test('evaluate flags an ongoing >15s silence lazily, dated at last heartbeat + 15s', () => {
  let s = boundSession();
  s = heartbeatSeries(s, T0 + 5_000, T0 + 10_000);
  const judged = evaluate(s, T0 + 10_000 + HEARTBEAT_GRACE_MS + 1);
  assert.equal(judged.violation, 'heartbeat_timeout');
  assert.equal(judged.violatedAt, T0 + 10_000 + HEARTBEAT_GRACE_MS);
  // Idempotent: judging again later changes nothing.
  assert.deepEqual(evaluate(judged, T0 + 60 * MIN), judged);
});

// --- Clean full-duration session is issuable only after endTime ---

test('clean session covering the full declared duration: issuable at endTime, not before', () => {
  let s = boundSession(25 * MIN);
  s = heartbeatSeries(s, T0 + 6_000, endTime(s));
  assert.equal(canIssueProof(s, endTime(s) - 1), false); // duration not yet fully covered
  assert.equal(canIssueProof(s, endTime(s)), true);
  // An already-issued session is not issuable again.
  assert.equal(canIssueProof({ ...s, issued: true }, endTime(s) + 1), false);
});

// --- Silence that crosses into the last 15s before endTime still counts ---

test('silence longer than 15s inside the monitoring window counts even if it ends after endTime', () => {
  let s = boundSession(25 * MIN);
  s = heartbeatSeries(s, T0 + 5_000, endTime(s) - 20_000); // last heartbeat 20s before endTime
  const judged = evaluate(s, endTime(s) + 5_000);
  assert.equal(judged.violation, 'heartbeat_timeout');
  assert.equal(judged.violatedAt, endTime(s) - 20_000 + HEARTBEAT_GRACE_MS);
  assert.equal(canIssueProof(s, endTime(s) + 5_000), false);
});

// --- Heartbeats / silence after endTime are out of scope ---

test('gaps after endTime never mark a violation', () => {
  let s = boundSession(25 * MIN);
  s = heartbeatSeries(s, T0 + 5_000, endTime(s) - 10_000); // last in-window heartbeat 10s before end
  const late = recordHeartbeat(s, ADDR, endTime(s) + 30 * MIN); // client pings long after
  assert.ok(late.ok);
  assert.equal(late.state.violation, null);
  assert.equal(canIssueProof(late.state, endTime(s) + 30 * MIN), true);
});

// --- AC-16: binding window (startTime + 5min) ---

test('AC-16: binding exactly at startTime + 5min is allowed', () => {
  const s = createSession('session-1', ADDR, T0, 25 * MIN);
  const r = recordBind(s, ADDR, T0 + BIND_WINDOW_MS);
  assert.ok(r.ok);
  assert.equal(r.state.bindTime, T0 + BIND_WINDOW_MS);
});

test('AC-16: binding after startTime + 5min is refused permanently (fail-closed)', () => {
  const s = createSession('session-1', ADDR, T0, 25 * MIN);
  const r = recordBind(s, ADDR, T0 + BIND_WINDOW_MS + 1);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'bind_window_expired');
  assert.equal(r.state.violation, 'bind_timeout');
  // The refusal is durable: retrying later keeps the session non-issuable.
  const retry = recordBind(r.state, ADDR, T0 + BIND_WINDOW_MS + 2_000);
  assert.equal(retry.ok, false);
  assert.equal(retry.state.violation, 'bind_timeout');
  assert.equal(canIssueProof(retry.state, endTime(s) + 1), false);
});

test('AC-16: binding after the task has ended is refused even inside the 5min window (short demo session)', () => {
  const s = createSession('session-1', ADDR, T0, 2 * MIN); // 2-minute demo session
  const r = recordBind(s, ADDR, T0 + 3 * MIN); // within 5min of startTime, but past endTime
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'bind_window_expired');
  assert.equal(r.state.violation, 'bind_timeout');
  assert.equal(canIssueProof(r.state, T0 + 4 * MIN), false);
});

test('AC-16: proof window is anchored at startTime — a late bind shifts nothing', () => {
  // Bound at the last allowed moment (startTime + 5min). The proof still covers
  // [startTime, endTime]: issuable exactly at startTime + durationMs, never
  // before — and the bind time does not extend or shorten that window.
  const s = createSession('session-1', ADDR, T0, 25 * MIN);
  const bound = recordBind(s, ADDR, T0 + BIND_WINDOW_MS);
  assert.ok(bound.ok);
  const monitored = heartbeatSeries(bound.state, T0 + BIND_WINDOW_MS + 5_000, endTime(s));
  assert.equal(canIssueProof(monitored, endTime(s) - 1), false); // declared duration not fully elapsed
  assert.equal(canIssueProof(monitored, endTime(s)), true); // anchored at startTime, not bindTime
});

// --- Participant matching (placeholder for real auth, DAPP-2) ---

test('events from a different address are rejected', () => {
  const s = createSession('session-1', ADDR, T0, 25 * MIN);
  const badBind = recordBind(s, OTHER, T0 + 1_000);
  assert.equal(badBind.ok, false);
  if (!badBind.ok) assert.equal(badBind.reason, 'wrong_participant');

  const bound = recordBind(s, ADDR, T0 + 1_000);
  assert.ok(bound.ok);
  const badHeartbeat = recordHeartbeat(bound.state, OTHER, T0 + 6_000);
  assert.equal(badHeartbeat.ok, false);
  if (!badHeartbeat.ok) assert.equal(badHeartbeat.reason, 'wrong_participant');
  const badHidden = recordHidden(bound.state, OTHER, T0 + 6_000);
  assert.equal(badHidden.ok, false);
});

test('events before binding are rejected; re-binding while bound is idempotent', () => {
  const s = createSession('session-1', ADDR, T0, 25 * MIN);
  const early = recordHeartbeat(s, ADDR, T0 + 5_000);
  assert.equal(early.ok, false);
  if (!early.ok) assert.equal(early.reason, 'not_bound');

  const bound = recordBind(s, ADDR, T0 + 1_000);
  assert.ok(bound.ok);
  const rebound = recordBind(bound.state, ADDR, T0 + 2_000);
  assert.ok(rebound.ok);
  assert.equal(rebound.state.bindTime, T0 + 1_000); // unchanged
});

test('hidden event after endTime is ignored (verdict already settled)', () => {
  let s = boundSession(25 * MIN);
  s = heartbeatSeries(s, T0 + 6_000, endTime(s));
  const r = recordHidden(s, ADDR, endTime(s) + 5_000);
  assert.ok(r.ok);
  assert.equal(r.state.violation, null);
  assert.equal(canIssueProof(r.state, endTime(s) + 5_000), true);
});

test('first violation wins when several conditions coincide', () => {
  let s = boundSession();
  s = heartbeatSeries(s, T0 + 5_000, T0 + 10_000);
  const hidden = recordHidden(s, ADDR, T0 + 12_000);
  // A later timeout evaluation must not overwrite the earlier hidden violation.
  const judged = evaluate(hidden.state, T0 + 60_000);
  assert.equal(judged.violation, 'hidden');
  assert.equal(judged.violatedAt, T0 + 12_000);
});
