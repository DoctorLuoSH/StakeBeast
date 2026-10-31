/**
 * sessionView derivation tests — which actions a viewer gets per mode /
 * status / phase, per the unified status table (baseline §11).
 */

import { describe, expect, it } from "vitest";
import { Mode, Payee, Status, Tier } from "./types";
import type { Session } from "./types";
import { deriveActions, forfeitDestinationLabel, isTerminal, tierForSession } from "./sessionView";

const ALICE = "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1";
const BOB = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
const EVE = "0x14dC79964da2c15BFB98fB931A3a2E01d1E1a69F";
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ZERO = "0x0000000000000000000000000000000000000000";

const NOW = 1_800_000_000;

function base(overrides: Partial<Session> = {}): Session {
  return {
    mode: Mode.SoloFocus,
    status: Status.Pending,
    staker: ALICE,
    partner: ZERO,
    verifier: ZERO,
    payee: Payee.Charity,
    customPayee: ZERO,
    stake: 50_000_000_000_000_000n,
    durationMinutes: 25,
    periodDays: 0,
    checkInsPerDay: 0,
    targetCount: 0,
    criterion: "",
    linkedSessionId: 0n,
    createdAt: NOW - 60,
    joinDeadline: 0,
    startDeadline: NOW + 3600,
    startTime: 0,
    endTime: 0,
    settlementDeadline: 0,
    joined: false,
    startConfirmedStaker: false,
    startConfirmedPartner: false,
    minted: false,
    ...overrides,
  };
}

function active(overrides: Partial<Session> = {}): Session {
  return base({
    status: Status.Active,
    startTime: NOW - 600,
    endTime: NOW + 900,
    settlementDeadline: NOW + 900 + 3600,
    ...overrides,
  });
}

describe("isTerminal / tierForSession", () => {
  it("terminal statuses are Completed / Forfeited / Voided / Cancelled", () => {
    expect(isTerminal(Status.Pending)).toBe(false);
    expect(isTerminal(Status.Active)).toBe(false);
    expect(isTerminal(Status.Completed)).toBe(true);
    expect(isTerminal(Status.Forfeited)).toBe(true);
    expect(isTerminal(Status.Voided)).toBe(true);
    expect(isTerminal(Status.Cancelled)).toBe(true);
  });

  it("mirrors the on-chain tier ladder (focus minutes)", () => {
    expect(tierForSession(base({ durationMinutes: 10 }))).toBe(Tier.Sprout);
    expect(tierForSession(base({ durationMinutes: 25 }))).toBe(Tier.Juvenile);
    expect(tierForSession(base({ durationMinutes: 50 }))).toBe(Tier.Adult);
    expect(tierForSession(base({ durationMinutes: 120 }))).toBe(Tier.Golden);
  });

  it("mirrors the on-chain tier ladder (habit days)", () => {
    expect(tierForSession(base({ durationMinutes: 0, periodDays: 1 }))).toBe(Tier.Sprout);
    expect(tierForSession(base({ durationMinutes: 0, periodDays: 3 }))).toBe(Tier.Juvenile);
    expect(tierForSession(base({ durationMinutes: 0, periodDays: 7 }))).toBe(Tier.Adult);
    expect(tierForSession(base({ durationMinutes: 0, periodDays: 21 }))).toBe(Tier.Golden);
  });
});

describe("deriveActions — pending solo focus", () => {
  it("creator can start inside the start window", () => {
    const a = deriveActions(base(), ALICE, false, NOW);
    expect(a.start).toBe(true);
    expect(a.cancel).toBe(false);
  });

  it("a stranger cannot start or cancel", () => {
    const a = deriveActions(base(), EVE, false, NOW);
    expect(a.start).toBe(false);
    expect(a.cancel).toBe(false);
  });

  it("after the start deadline only cancel remains", () => {
    const a = deriveActions(base(), ALICE, false, NOW + 3601);
    expect(a.start).toBe(false);
    expect(a.cancel).toBe(true);
  });
});

describe("deriveActions — pending duel", () => {
  const duel = () =>
    base({ mode: Mode.Duel, partner: BOB, verifier: BOB, joinDeadline: NOW + 3600, startDeadline: 0 });

  it("only the designated opponent can join, inside the join window", () => {
    expect(deriveActions(duel(), BOB, false, NOW).join).toBe(true);
    expect(deriveActions(duel(), EVE, false, NOW).join).toBe(false);
    expect(deriveActions(duel(), BOB, false, NOW + 3601).join).toBe(false);
  });

  it("creator can cancel after the join deadline", () => {
    expect(deriveActions(duel(), ALICE, false, NOW + 3601).cancel).toBe(true);
  });
});

describe("deriveActions — co-focus handshake", () => {
  const cofocusUnjoined = () =>
    base({ mode: Mode.CoFocus, joinDeadline: NOW + 3600, startDeadline: 0 });
  const cofocusJoined = () =>
    base({
      mode: Mode.CoFocus,
      partner: BOB,
      joined: true,
      joinDeadline: NOW - 100,
      startDeadline: NOW + 3600,
    });

  it("anyone but the creator can join an open co-focus", () => {
    expect(deriveActions(cofocusUnjoined(), BOB, false, NOW).join).toBe(true);
    expect(deriveActions(cofocusUnjoined(), ALICE, false, NOW).join).toBe(false);
    expect(deriveActions(cofocusUnjoined(), null, false, NOW).join).toBe(false);
  });

  it("joined co-focus: each participant confirms once", () => {
    const s = cofocusJoined();
    expect(deriveActions(s, ALICE, false, NOW).confirmStart).toBe(true);
    expect(deriveActions(s, BOB, false, NOW).confirmStart).toBe(true);
    expect(deriveActions({ ...s, startConfirmedStaker: true }, ALICE, false, NOW).confirmStart).toBe(false);
    expect(deriveActions({ ...s, startConfirmedStaker: true }, BOB, false, NOW).confirmStart).toBe(true);
    expect(deriveActions(s, EVE, false, NOW).confirmStart).toBe(false);
  });

  it("joined co-focus past the start deadline: either participant can cancel", () => {
    const s = cofocusJoined();
    expect(deriveActions(s, ALICE, false, NOW + 3601).cancel).toBe(true);
    expect(deriveActions(s, BOB, false, NOW + 3601).cancel).toBe(true);
    expect(deriveActions(s, EVE, false, NOW + 3601).cancel).toBe(false);
  });
});

describe("deriveActions — active session", () => {
  it("machine settle only for participants, inside the settlement window", () => {
    const s = active();
    expect(deriveActions(s, ALICE, false, NOW + 901).settle).toBe(true);
    expect(deriveActions(s, EVE, false, NOW + 901).settle).toBe(false);
    expect(deriveActions(s, ALICE, false, NOW).settle).toBe(false); // window still running
    expect(deriveActions(s, ALICE, false, NOW + 900 + 3601).settle).toBe(false); // past deadline
  });

  it("human verify only for the verifier, before the deadline", () => {
    const s = active({ mode: Mode.Supervised, durationMinutes: 0, periodDays: 7, verifier: BOB });
    expect(deriveActions(s, BOB, false, NOW).verify).toBe(true);
    expect(deriveActions(s, ALICE, false, NOW).verify).toBe(false);
    expect(deriveActions(s, BOB, false, NOW + 900 + 3601).verify).toBe(false);
    // Supervised is human-proof: never a settle action.
    expect(deriveActions(s, ALICE, false, NOW + 901).settle).toBe(false);
  });

  it("admit defeat: staker only, except co-focus where both can", () => {
    const s = active();
    expect(deriveActions(s, ALICE, false, NOW).admitDefeat).toBe(true);
    expect(deriveActions(s, EVE, false, NOW).admitDefeat).toBe(false);
    const co = active({ mode: Mode.CoFocus, partner: BOB, joined: true });
    expect(deriveActions(co, BOB, false, NOW).admitDefeat).toBe(true);
    expect(deriveActions(co, EVE, false, NOW).admitDefeat).toBe(false);
  });

  it("forfeit is permissionless but only after the settlement deadline", () => {
    const s = active();
    expect(deriveActions(s, EVE, false, NOW).forfeit).toBe(false);
    expect(deriveActions(s, EVE, false, NOW + 900 + 3600).forfeit).toBe(true);
  });

  it("owner can void any non-terminal session, others never", () => {
    const s = active();
    expect(deriveActions(s, OWNER, true, NOW).voidSession).toBe(true);
    expect(deriveActions(s, ALICE, false, NOW).voidSession).toBe(false);
    expect(deriveActions(base({ status: Status.Completed }), OWNER, true, NOW).voidSession).toBe(false);
  });
});

describe("forfeitDestinationLabel", () => {
  it("describes the admit-defeat route", () => {
    expect(forfeitDestinationLabel(base({ payee: Payee.Charity }), 0)).toMatch(/charity \(admitted defeat\)/);
    expect(forfeitDestinationLabel(base({ payee: Payee.Verifier, mode: Mode.Supervised, verifier: BOB }), 0)).toMatch(/verifier/);
    expect(forfeitDestinationLabel(base({ payee: Payee.Custom, customPayee: EVE }), 0)).toMatch(/custom payee/);
  });

  it("describes timeout and joint forfeits", () => {
    expect(forfeitDestinationLabel(base(), 1)).toMatch(/deadline passed/);
    expect(forfeitDestinationLabel(base({ mode: Mode.CoFocus }), 2)).toMatch(/joint liability/);
  });

  it("timeout forfeits always describe charity, regardless of the preset payee (B3)", () => {
    const verifierRoute = base({ payee: Payee.Verifier, mode: Mode.Supervised, verifier: BOB });
    expect(forfeitDestinationLabel(verifierRoute, 1)).toMatch(/charity \(settlement deadline passed\)/);
    const customRoute = base({ payee: Payee.Custom, customPayee: EVE });
    expect(forfeitDestinationLabel(customRoute, 1)).toMatch(/charity \(settlement deadline passed\)/);
  });
});
