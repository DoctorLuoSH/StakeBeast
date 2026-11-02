// @vitest-environment jsdom
/**
 * B1 regression — async read isolation. Each response is keyed by the exact
 * request identity (client instance per provider/chain + session id/account)
 * and only the latest request may publish: a late response from a previous
 * session, account, or network can never overwrite the current view, and
 * switching the subject re-enters loading instead of showing stale data.
 *
 * B6 (hook half) — the claimable balance refreshes as soon as a credit event
 * arrives (without waiting for the 12s poll) and unsubscribes on unmount.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { ZeroAddress } from "ethers";
import { useClaimable, useSession } from "./useStakeBeast";
import type { Session } from "./types";

const ACCOUNT_A = "0x0000000000000000000000000000000000000002";
const ACCOUNT_B = "0x0000000000000000000000000000000000000003";

type MockApi = {
  getSession: Mock<(sessionId: bigint) => Promise<Session>>;
  claimableOf: Mock<(account: string) => Promise<bigint>>;
  onSessionActivity: Mock<(sessionId: bigint, listener: () => void) => () => void>;
  onWithdrawal: Mock<(account: string, listener: () => void) => () => void>;
  onAnyCredit: Mock<(listener: () => void) => () => void>;
};

const mocks = vi.hoisted(() => {
  const wallet = {
    provider: {} as object,
    isExpectedChain: true,
    account: "0x0000000000000000000000000000000000000002",
  };
  const apis = new Map<object, MockApi>();
  return { wallet, apis };
});

function getApi(provider: object): MockApi {
  const api = mocks.apis.get(provider);
  if (!api) throw new Error("test did not register an api for this provider");
  return api;
}

function registerApi(provider: object): MockApi {
  const api: MockApi = {
    getSession: vi.fn(),
    claimableOf: vi.fn(),
    onSessionActivity: vi.fn(() => () => {}),
    onWithdrawal: vi.fn(() => () => {}),
    onAnyCredit: vi.fn(() => () => {}),
  };
  mocks.apis.set(provider, api);
  return api;
}

vi.mock("../wallet/useWallet", () => ({ useWallet: () => mocks.wallet }));
vi.mock("./client", async (original) => ({
  ...(await original<object>()),
  isContractConfigured: () => true,
  getStakeBeast: (provider: object) => getApi(provider),
}));

const session = (criterion: string): Session => ({
  mode: 3,
  status: 0,
  staker: "0x0000000000000000000000000000000000000001",
  partner: ZeroAddress,
  verifier: ZeroAddress,
  payee: 0,
  customPayee: ZeroAddress,
  stake: 1n,
  durationMinutes: 25,
  periodDays: 0,
  checkInsPerDay: 0,
  targetCount: 0,
  criterion,
  linkedSessionId: 0n,
  createdAt: 0,
  joinDeadline: 9999999999,
  startDeadline: 0,
  startTime: 0,
  endTime: 0,
  settlementDeadline: 0,
  joined: false,
  startConfirmedStaker: false,
  startConfirmedPartner: false,
  minted: false,
});

/** A promise whose resolution the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mocks.wallet.provider = {};
  mocks.wallet.account = ACCOUNT_A;
  mocks.wallet.isExpectedChain = true;
  mocks.apis.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useSession — async read isolation (B1)", () => {
  it("a delayed response for session A cannot overwrite current session B", async () => {
    const api = registerApi(mocks.wallet.provider);
    const reqA = deferred<Session>();
    api.getSession.mockImplementation((id: bigint) =>
      id === 1n ? reqA.promise : Promise.resolve(session("B")),
    );

    const { result, rerender } = renderHook(({ id }) => useSession(id), {
      initialProps: { id: 1n },
    });
    await act(async () => {
      rerender({ id: 2n });
    });
    expect(result.current.session?.criterion).toBe("B");

    await act(async () => {
      reqA.resolve(session("A"));
    });
    expect(result.current.session?.criterion).toBe("B");
  });

  it("switching sessions re-enters loading instead of showing the old session", async () => {
    const api = registerApi(mocks.wallet.provider);
    api.getSession.mockResolvedValue(session("A"));
    const { result, rerender } = renderHook(({ id }) => useSession(id), {
      initialProps: { id: 1n },
    });
    await act(async () => {});
    expect(result.current.session?.criterion).toBe("A");
    expect(result.current.loading).toBe(false);

    const reqB = deferred<Session>();
    api.getSession.mockImplementation((id: bigint) =>
      id === 2n ? reqB.promise : Promise.resolve(session("A")),
    );
    await act(async () => {
      rerender({ id: 2n });
    });
    // While B is in flight nothing from A may show through.
    expect(result.current.session).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => {
      reqB.resolve(session("B"));
    });
    expect(result.current.session?.criterion).toBe("B");
    expect(result.current.loading).toBe(false);
  });

  it("same-session out-of-order refresh: the latest request wins", async () => {
    const api = registerApi(mocks.wallet.provider);
    const first = deferred<Session>();
    api.getSession.mockImplementationOnce(() => first.promise);
    api.getSession.mockResolvedValue(session("fresh"));

    const { result } = renderHook(() => useSession(1n));
    await act(async () => {
      result.current.refresh(); // second request, resolves immediately
    });
    await act(async () => {});
    expect(result.current.session?.criterion).toBe("fresh");

    await act(async () => {
      first.resolve(session("stale"));
    });
    expect(result.current.session?.criterion).toBe("fresh");
  });

  it("network switch: the previous chain's late response is discarded", async () => {
    const providerA = {};
    const providerB = {};
    mocks.wallet.provider = providerA;
    const apiA = registerApi(providerA);
    const apiB = registerApi(providerB);

    const oldChain = deferred<Session>();
    apiA.getSession.mockImplementation(() => oldChain.promise);
    apiB.getSession.mockResolvedValue(session("new-chain"));

    const { result, rerender } = renderHook(() => useSession(1n));
    mocks.wallet.provider = providerB;
    await act(async () => {
      rerender();
    });
    expect(result.current.session?.criterion).toBe("new-chain");

    await act(async () => {
      oldChain.resolve(session("old-chain"));
    });
    expect(result.current.session?.criterion).toBe("new-chain");
  });

  it("a load error surfaces and clears on the next successful read", async () => {
    const api = registerApi(mocks.wallet.provider);
    api.getSession.mockRejectedValueOnce(new Error("node down"));
    const { result } = renderHook(() => useSession(1n));
    await act(async () => {});
    expect(result.current.error).toMatch(/Could not load the session/);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      api.getSession.mockResolvedValueOnce(session("recovered"));
      result.current.refresh();
    });
    await act(async () => {});
    expect(result.current.error).toBeNull();
    expect(result.current.session?.criterion).toBe("recovered");
  });
});

describe("useClaimable — account isolation and event refresh (B1/B6)", () => {
  it("a late balance for the previous account cannot overwrite the new one", async () => {
    const api = registerApi(mocks.wallet.provider);
    const reqA = deferred<bigint>();
    api.claimableOf.mockImplementation((account: string) =>
      account === ACCOUNT_A ? reqA.promise : Promise.resolve(5n),
    );

    const { result, rerender } = renderHook(() => useClaimable());
    mocks.wallet.account = ACCOUNT_B;
    await act(async () => {
      rerender();
    });
    expect(result.current.claimable).toBe(5n);

    await act(async () => {
      reqA.resolve(9n);
    });
    expect(result.current.claimable).toBe(5n);
  });

  it("refreshes immediately when a credit event fires, without the poll", async () => {
    const api = registerApi(mocks.wallet.provider);
    let creditListener: (() => void) | null = null;
    api.onAnyCredit.mockImplementation((listener: () => void) => {
      creditListener = listener;
      return () => {};
    });
    api.claimableOf.mockResolvedValueOnce(1n);

    const { result } = renderHook(() => useClaimable());
    await act(async () => {});
    expect(result.current.claimable).toBe(1n);
    expect(creditListener).not.toBeNull();

    api.claimableOf.mockResolvedValueOnce(7n);
    await act(async () => {
      creditListener!();
    });
    expect(api.claimableOf).toHaveBeenCalledTimes(2);
    expect(result.current.claimable).toBe(7n);
  });

  it("unsubscribes from both credit sources on unmount", () => {
    const api = registerApi(mocks.wallet.provider);
    const offWithdrawal = vi.fn();
    const offCredit = vi.fn();
    api.onWithdrawal.mockReturnValue(offWithdrawal);
    api.onAnyCredit.mockReturnValue(offCredit);
    api.claimableOf.mockResolvedValue(0n);

    const { unmount } = renderHook(() => useClaimable());
    unmount();
    expect(offWithdrawal).toHaveBeenCalledTimes(1);
    expect(offCredit).toHaveBeenCalledTimes(1);
  });

  it("useSession unsubscribes its activity feed on unmount", () => {
    const api = registerApi(mocks.wallet.provider);
    const offActivity = vi.fn();
    api.onSessionActivity.mockReturnValue(offActivity);
    api.getSession.mockResolvedValue(session("A"));

    const { unmount } = renderHook(() => useSession(1n));
    unmount();
    expect(offActivity).toHaveBeenCalledTimes(1);
  });
});
