// @vitest-environment jsdom
/**
 * B6 regression — onAnyCredit subscribes to every event that credits a
 * claimable balance, including SessionForfeited (the contract credits
 * claimable before emitting it, StakeBeast.sol), and unsubscribes cleanly.
 *
 * Error-coverage evidence — the typed ABI declares exactly the 37 custom
 * errors the contract declares directly, and every one of them humanizes to
 * rule-level copy (the delivery wording is "37 directly-declared errors",
 * not "the entire ABI": out-of-scope interfaces like checkIn/setAttester
 * are intentionally not wrapped).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorFragment, ZeroAddress } from "ethers";
import type { BrowserProvider, ContractTransactionReceipt } from "ethers";

const mocks = vi.hoisted(() => ({
  contract: { on: vi.fn(), off: vi.fn() },
}));

vi.mock("ethers", async (original) => {
  const actual = await original<typeof import("ethers")>();
  return {
    ...actual,
    // A function (not an arrow) so `new Contract(...)` can construct it.
    Contract: vi.fn(function () {
      return mocks.contract;
    }),
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_CONTRACT_ADDRESS", "0x00000000000000000000000000000000000000aa");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function buildApi() {
  const { getStakeBeast } = await import("./client");
  return getStakeBeast({} as BrowserProvider);
}

describe("onAnyCredit (B6)", () => {
  it("subscribes to every balance-crediting event, SessionForfeited included", async () => {
    const api = await buildApi();
    const listener = vi.fn();
    const unsubscribe = api.onAnyCredit(listener);

    const subscribed = mocks.contract.on.mock.calls.map(([event]) => event);
    expect(subscribed).toEqual([
      "SessionCompleted",
      "SessionCancelled",
      "SessionVoided",
      "SessionForfeited",
    ]);

    const fire = mocks.contract.on.mock.calls[0][1] as () => void;
    fire();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    const removed = mocks.contract.off.mock.calls.map(([event]) => event);
    expect(removed).toEqual(subscribed);
  });
});

describe("declared error coverage", () => {
  it("wraps exactly the 37 directly-declared contract errors, all humanized", async () => {
    const { stakeBeastInterface } = await import("./client");
    const { describeContractError } = await import("./errors");
    const errorFragments = stakeBeastInterface.fragments.filter(
      (f): f is ErrorFragment => f.type === "error",
    );
    expect(errorFragments.length).toBe(37);

    for (const fragment of errorFragments) {
      const values = fragment.inputs.map((input) => (input.type === "address" ? ZeroAddress : 1n));
      const data = stakeBeastInterface.encodeErrorResult(fragment.name, values);
      const message = describeContractError({ data });
      expect(message, fragment.name).toBeTruthy();
      expect(message, fragment.name).not.toMatch(/^Contract reverted with/);
    }
  });
});

describe("readCreatedSessionId (DAPP-44)", () => {
  async function sessionCreatedLog(id: bigint) {
    const { stakeBeastInterface } = await import("./client");
    const fragment = stakeBeastInterface.getEvent("SessionCreated");
    if (!fragment) throw new Error("SessionCreated missing from the ABI");
    return stakeBeastInterface.encodeEventLog(fragment, [
      id,
      0, // Mode.SoloFocus
      "0x0000000000000000000000000000000000000001", // staker
      ZeroAddress, // counterparty
      50_000_000_000_000_000n, // stake
      100n, // joinDeadline
      200n, // startDeadline
    ]);
  }

  function receiptWith(logs: { topics: readonly string[]; data: string }[]) {
    return { logs } as unknown as ContractTransactionReceipt;
  }

  it("extracts the session id from the SessionCreated log", async () => {
    const api = await buildApi();
    const log = await sessionCreatedLog(7n);
    expect(api.readCreatedSessionId(receiptWith([log]))).toBe(7n);
  });

  it("skips foreign logs and still finds the id later in the receipt", async () => {
    const api = await buildApi();
    const foreign = { topics: ["0x".concat("ab".repeat(32))], data: "0x" };
    const log = await sessionCreatedLog(9n);
    expect(api.readCreatedSessionId(receiptWith([foreign, log]))).toBe(9n);
  });

  it("returns null when the receipt has no SessionCreated log", async () => {
    const api = await buildApi();
    // No logs at all — the no-code-at-address signature (DAPP-44 root cause).
    expect(api.readCreatedSessionId(receiptWith([]))).toBeNull();
    const foreign = { topics: ["0x".concat("ab".repeat(32))], data: "0x" };
    expect(api.readCreatedSessionId(receiptWith([foreign]))).toBeNull();
  });
});
