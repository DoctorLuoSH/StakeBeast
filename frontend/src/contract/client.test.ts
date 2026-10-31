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
import type { BrowserProvider } from "ethers";

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
