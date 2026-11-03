/**
 * statsView tests (DAPP-47) — the personal record counts only positions the
 * account stakes: successes/failures, completed focus minutes and habit
 * days, and the forfeited stake total (baseline §4.7).
 */

import { describe, expect, it } from "vitest";
import { ZeroAddress } from "ethers";
import { computeAccountStats, formatMinutes } from "./statsView";
import { Mode, Payee, Status } from "../../contract/types";
import type { Session } from "../../contract/types";

const ME = "0x0000000000000000000000000000000000000001";
const OTHER = "0x0000000000000000000000000000000000000002";

function session(overrides: Partial<Session> = {}): Session {
  return {
    mode: Mode.SoloFocus,
    status: Status.Active,
    staker: ME,
    partner: ZeroAddress,
    verifier: ZeroAddress,
    payee: Payee.Charity,
    customPayee: ZeroAddress,
    stake: 50_000_000_000_000_000n,
    durationMinutes: 25,
    periodDays: 0,
    checkInsPerDay: 0,
    targetCount: 0,
    criterion: "",
    linkedSessionId: 0n,
    createdAt: 0,
    joinDeadline: 0,
    startDeadline: 0,
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

describe("computeAccountStats", () => {
  it("counts successes, failures, time, and forfeits for own positions", () => {
    const stats = computeAccountStats(
      [
        session({ status: Status.Completed, durationMinutes: 50 }),
        session({ status: Status.Completed, mode: Mode.Supervised, durationMinutes: 0, periodDays: 7 }),
        session({ status: Status.Forfeited, stake: 20_000_000_000_000_000n }),
        session({ status: Status.Active }),
        session({ status: Status.Voided }),
        session({ status: Status.Cancelled }),
      ],
      ME,
    );
    expect(stats.succeeded).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.focusMinutes).toBe(50);
    expect(stats.habitDays).toBe(7);
    expect(stats.forfeitedWei).toBe(20_000_000_000_000_000n);
  });

  it("ignores positions the account only supervises or partners", () => {
    const stats = computeAccountStats(
      [
        session({ status: Status.Completed, staker: OTHER, verifier: ME }),
        session({ status: Status.Forfeited, staker: OTHER, partner: ME }),
      ],
      ME,
    );
    expect(stats.succeeded).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.forfeitedWei).toBe(0n);
  });

  it("address comparison is case-insensitive", () => {
    const stats = computeAccountStats(
      [session({ status: Status.Completed, staker: ME.toUpperCase().replace("0X", "0x") })],
      ME,
    );
    expect(stats.succeeded).toBe(1);
  });

  it("empty history is all zeros", () => {
    expect(computeAccountStats([], ME)).toEqual({
      succeeded: 0,
      failed: 0,
      focusMinutes: 0,
      habitDays: 0,
      forfeitedWei: 0n,
    });
  });
});

describe("formatMinutes", () => {
  it("formats minutes and hours", () => {
    expect(formatMinutes(0)).toBe("0 min");
    expect(formatMinutes(5)).toBe("5 min");
    expect(formatMinutes(60)).toBe("1 h");
    expect(formatMinutes(130)).toBe("2 h 10 min");
  });
});
