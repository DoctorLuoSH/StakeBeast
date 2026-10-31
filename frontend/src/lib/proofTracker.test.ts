/**
 * ProofTracker state-machine tests (DAPP-35): heartbeat cadence + seq
 * discipline, service-confirmed violation, single-client takeover (401),
 * seq resync after transport failure, window-end stop, attestation-ready
 * terminal, hidden-event reporting, and bind failure recovery. Real timers
 * at a short cadence; every async point is awaited via waitFor.
 */

import { describe, expect, it } from "vitest";
import { ProofServiceError } from "./proofClient";
import type { ProofBinding, ProofClient, ProofLifecycle, ProofStatus } from "./proofClient";
import { createProofTracker, INITIAL_TRACK_STATE } from "./proofTracker";
import type { ProofTrackState } from "./proofTracker";

const CADENCE = 15;

interface FakeCalls {
  heartbeats: number[];
  events: { eventId: string; type: string }[];
  arms: string[];
  statusCalls: number;
}

interface FakeKnobs {
  heartbeat?: (seq: number) => Promise<{ violation: boolean }>;
  status?: () => Promise<ProofStatus>;
  event?: () => Promise<{ violation: boolean }>;
  armState?: ProofLifecycle;
}

function makeStatus(partial: Partial<ProofStatus> = {}): ProofStatus {
  return {
    sessionId: "7",
    lifecycle: "monitoring",
    participants: [],
    attestationReady: false,
    nextHeartbeatSeq: 1,
    ...partial,
  };
}

function fakeClient(calls: FakeCalls, knobs: FakeKnobs = {}): ProofClient {
  return {
    arm: async (txHash) => {
      calls.arms.push(txHash);
      return knobs.armState ?? "arming";
    },
    heartbeat: async (seq) => {
      calls.heartbeats.push(seq);
      if (knobs.heartbeat) return knobs.heartbeat(seq);
      return { violation: false };
    },
    event: async (eventId, type) => {
      calls.events.push({ eventId, type });
      if (knobs.event) return knobs.event();
      return { violation: false };
    },
    status: async () => {
      calls.statusCalls += 1;
      if (knobs.status) return knobs.status();
      return makeStatus();
    },
  };
}

const BINDING: ProofBinding = { clientToken: "ctk_t", lifecycle: "ready", nextHeartbeatSeq: 1 };

interface Harness {
  tracker: ReturnType<typeof createProofTracker>;
  calls: FakeCalls;
  latest: () => ProofTrackState;
  setClient: (client: ProofClient) => void;
}

function harness(knobs: FakeKnobs = {}, opts: { windowEndMs?: () => number | null } = {}): Harness {
  const calls: FakeCalls = { heartbeats: [], events: [], arms: [], statusCalls: 0 };
  let client = fakeClient(calls, knobs);
  let state: ProofTrackState = INITIAL_TRACK_STATE;
  const tracker = createProofTracker({
    bindSession: async () => ({ binding: BINDING, client }),
    heartbeatMs: CADENCE,
    statusMs: CADENCE,
    windowEndMs: opts.windowEndMs ?? (() => null),
    onChange: (s) => {
      state = s;
    },
  });
  return {
    tracker,
    calls,
    latest: () => state,
    setClient: (c) => {
      client = c;
    },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 4));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ProofTracker", () => {
  it("bind starts the heartbeat loop; seq is strictly increasing from nextHeartbeatSeq", async () => {
    const h = harness();
    expect(h.latest().phase).toBe("unbound");
    await expect(h.tracker.bind()).resolves.toBe(true);
    expect(h.latest().phase).toBe("tracking");

    await waitFor(() => h.latest().lastAckSeq >= 4);
    h.tracker.stop();
    const seqs = h.calls.heartbeats;
    expect(seqs.length).toBeGreaterThanOrEqual(4);
    expect(seqs.slice(0, 4)).toEqual([1, 2, 3, 4]);
  });

  it("service-confirmed violation is permanent: heartbeats stop, status poll reaches the judgment", async () => {
    let judged = false;
    const h = harness({
      heartbeat: async (seq) => {
        // The live sweep flags the violation together with the response;
        // the final judgment only lands afterwards.
        if (seq >= 2) {
          judged = true;
          return { violation: true };
        }
        return { violation: false };
      },
      status: async () => makeStatus({ lifecycle: judged ? "violation" : "monitoring" }),
    });
    await h.tracker.bind();
    await waitFor(() => h.latest().violation);
    await waitFor(() => h.latest().phase === "ended");
    const count = h.calls.heartbeats.length;
    await sleep(CADENCE * 4);
    expect(h.calls.heartbeats.length).toBe(count);
    h.tracker.stop();
  });

  it("401 revokes the client → takeover, loops stop; re-bind takes tracking back", async () => {
    let failNext = true;
    const h = harness({
      heartbeat: async () => {
        if (failNext) {
          failNext = false;
          throw new ProofServiceError("revoked", "revoked");
        }
        return { violation: false };
      },
    });
    await h.tracker.bind();
    await waitFor(() => h.latest().phase === "takeover");
    const count = h.calls.heartbeats.length;
    await sleep(CADENCE * 3);
    expect(h.calls.heartbeats.length).toBe(count); // loops stopped

    // Take tracking back: a fresh bind revokes the other client server-side.
    await expect(h.tracker.bind()).resolves.toBe(true);
    expect(h.latest().phase).toBe("tracking");
    await waitFor(() => h.latest().lastAckSeq >= 1);
    h.tracker.stop();
  });

  it("transport failure keeps the seq; status nextHeartbeatSeq resyncs across the gap", async () => {
    let first = true;
    const resync = { offer: false };
    const h = harness({
      heartbeat: async () => {
        if (first) {
          first = false;
          return { violation: false };
        }
        throw new ProofServiceError("down", "unavailable");
      },
      status: async () => makeStatus({ nextHeartbeatSeq: resync.offer ? 9 : 1 }),
    });
    await h.tracker.bind();
    // The failing beat is retried with the same seq (never incremented).
    await waitFor(() => h.calls.heartbeats.length >= 4);
    resync.offer = true;
    await waitFor(() => h.calls.heartbeats.includes(9));
    h.tracker.stop();
    const idx9 = h.calls.heartbeats.indexOf(9);
    const before = h.calls.heartbeats.slice(0, idx9);
    expect(before[0]).toBe(1);
    expect(new Set(before.slice(1))).toEqual(new Set([2]));
    // Still failing after the resync: seq 9 is retried, never incremented.
    expect(new Set(h.calls.heartbeats.slice(idx9))).toEqual(new Set([9]));
  });

  it("heartbeats stop once the chain window has ended; status keeps polling", async () => {
    const endAt = Date.now() + CADENCE * 3;
    const h = harness({}, { windowEndMs: () => endAt });
    await h.tracker.bind();
    await waitFor(() => h.calls.heartbeats.length >= 1);
    await waitFor(() => h.calls.statusCalls >= 1);
    await sleep(CADENCE * 4); // window now past
    const count = h.calls.heartbeats.length;
    await sleep(CADENCE * 3);
    expect(h.calls.heartbeats.length).toBe(count);
    const statusBefore = h.calls.statusCalls;
    await sleep(CADENCE * 3);
    expect(h.calls.statusCalls).toBeGreaterThan(statusBefore);
    h.tracker.stop();
  });

  it("attestationReady from the status poll ends tracking", async () => {
    const h = harness({
      status: async () => makeStatus({ lifecycle: "clean", attestationReady: true }),
    });
    await h.tracker.bind();
    await waitFor(() => h.latest().attestationReady);
    await waitFor(() => h.latest().phase === "ended");
    const beats = h.calls.heartbeats.length;
    const polls = h.calls.statusCalls;
    await sleep(CADENCE * 4);
    expect(h.calls.heartbeats.length).toBe(beats);
    expect(h.calls.statusCalls).toBe(polls);
    h.tracker.stop();
  });

  it("reportHidden posts a deduped visibility_hidden event; violation reply marks the state", async () => {
    const h = harness({
      event: async () => ({ violation: true }),
    });
    await h.tracker.bind();
    h.tracker.reportHidden();
    await waitFor(() => h.latest().violation);
    expect(h.latest().localHidden).toBe(true);
    expect(h.calls.events).toHaveLength(1);
    expect(h.calls.events[0].type).toBe("visibility_hidden");
    expect(h.calls.events[0].eventId.length).toBeGreaterThan(0);
    h.tracker.stop();
  });

  it("reportHidden is a no-op before binding (no stray warning)", () => {
    const h = harness();
    h.tracker.reportHidden();
    expect(h.latest().localHidden).toBe(false);
    expect(h.calls.events).toHaveLength(0);
  });

  it("bind failure returns false, keeps phase unbound and carries the reason", async () => {
    let state: ProofTrackState = INITIAL_TRACK_STATE;
    const tracker = createProofTracker({
      bindSession: async () => {
        throw new Error("User rejected the signature");
      },
      onChange: (s) => {
        state = s;
      },
    });
    await expect(tracker.bind()).resolves.toBe(false);
    expect(state.phase).toBe("unbound");
    expect(state.error).toContain("User rejected the signature");
    tracker.stop();
  });

  it("notifyStarted posts the arming notice with the tx hash", async () => {
    const h = harness();
    await h.tracker.bind();
    h.tracker.notifyStarted("0xstarttx");
    await waitFor(() => h.calls.arms.includes("0xstarttx"));
    await waitFor(() => h.latest().lifecycle === "arming");
    h.tracker.stop();
  });
});
