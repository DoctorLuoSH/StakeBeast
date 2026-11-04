// @vitest-environment jsdom
/**
 * B2 regression — the co-focus JOINER must explicitly confirm joint
 * liability before any stake is sent (baseline §4.4): "Join & stake" opens
 * the consent dialog instead of calling the contract; Back/cancel never
 * calls; only the explicit confirmation sends joinSession. (The creator-side
 * consent is covered in CreateSessionPage.test.tsx.)
 *
 * B4 (join half) — a zero custom forfeit address on the duel join path is
 * blocked with a field message before any transaction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ZeroAddress } from "ethers";
import { ChainFocusSession } from "./ChainFocusSession";
import { Mode, Payee, Status } from "../../contract/types";
import type { Session } from "../../contract/types";

const VIEWER = "0x0000000000000000000000000000000000000002";
const STAKER = "0x0000000000000000000000000000000000000001";
const FRIEND = "0x0000000000000000000000000000000000000003";
const STAKE = 50_000_000_000_000_000n;

const mocks = vi.hoisted(() => {
  const api = {
    getSession: vi.fn(),
    owner: vi.fn(async () => "0x0000000000000000000000000000000000000009"),
    onSessionActivity: vi.fn(() => () => {}),
    joinSession: vi.fn(),
  };
  return {
    api,
    wallet: {
      provider: {},
      isExpectedChain: true,
      account: "0x0000000000000000000000000000000000000002",
    },
  };
});

vi.mock("../../wallet/useWallet", () => ({ useWallet: () => mocks.wallet }));
vi.mock("../../contract/client", async (original) => ({
  ...(await original<object>()),
  isContractConfigured: () => true,
  getStakeBeast: () => mocks.api,
}));

function pendingSession(overrides: Partial<Session> = {}): Session {
  return {
    mode: Mode.CoFocus,
    status: Status.Pending,
    staker: STAKER,
    partner: ZeroAddress,
    verifier: ZeroAddress,
    payee: Payee.Charity,
    customPayee: ZeroAddress,
    stake: STAKE,
    durationMinutes: 25,
    periodDays: 0,
    checkInsPerDay: 0,
    targetCount: 0,
    criterion: "",
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
    ...overrides,
  };
}

function renderSession(sessionId = 1n) {
  return render(
    <MemoryRouter>
      <ChainFocusSession sessionId={sessionId} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.api.joinSession.mockResolvedValue({
    hash: "0x1234",
    wait: async () => ({ logs: [] }),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("co-focus joiner joint-liability consent (B2)", () => {
  it("Join & stake opens the dialog; cancel never calls the contract", async () => {
    mocks.api.getSession.mockResolvedValue(pendingSession());
    renderSession();

    const button = await screen.findByRole("button", { name: /Join & stake/ });
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => {
      fireEvent.click(button);
    });
    // Consent dialog instead of a transaction.
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(mocks.api.joinSession).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.api.joinSession).not.toHaveBeenCalled();
  });

  it("joins only after the explicit confirmation, with the exact stake", async () => {
    mocks.api.getSession.mockResolvedValue(pendingSession());
    renderSession();

    const button = await screen.findByRole("button", { name: /Join & stake/ });
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /I understand — join with joint liability/ }),
      );
    });

    expect(mocks.api.joinSession).toHaveBeenCalledTimes(1);
    // Co-focus is forced to the charity route (R6): no payee choice, no custom address.
    expect(mocks.api.joinSession).toHaveBeenCalledWith(1n, Payee.Charity, ZeroAddress, STAKE);
  });
});

describe("duel join path — no joint dialog, zero-address guard (B4)", () => {
  const duelSession = () =>
    pendingSession({ mode: Mode.Duel, partner: VIEWER, verifier: VIEWER });

  it("joins directly (its forfeit route is the joiner's own choice)", async () => {
    mocks.api.getSession.mockResolvedValue(duelSession());
    renderSession();

    const button = await screen.findByRole("button", { name: /Join & stake/ });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.api.joinSession).toHaveBeenCalledTimes(1);
    expect(mocks.api.joinSession).toHaveBeenCalledWith(1n, Payee.Charity, ZeroAddress, STAKE);
  });

  it("blocks a zero custom forfeit address before any transaction", async () => {
    mocks.api.getSession.mockResolvedValue(duelSession());
    renderSession();

    fireEvent.change(await screen.findByLabelText(/Your forfeit route/), {
      target: { value: String(Payee.Custom) },
    });
    fireEvent.change(screen.getByLabelText(/Custom forfeit address/), {
      target: { value: ZeroAddress },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Join & stake/ }));
    });

    expect(screen.getByRole("alert").textContent).toMatch(/zero address/i);
    expect(mocks.api.joinSession).not.toHaveBeenCalled();
  });

  it("accepts a concrete custom forfeit address", async () => {
    mocks.api.getSession.mockResolvedValue(duelSession());
    renderSession();

    fireEvent.change(await screen.findByLabelText(/Your forfeit route/), {
      target: { value: String(Payee.Custom) },
    });
    fireEvent.change(screen.getByLabelText(/Custom forfeit address/), {
      target: { value: FRIEND },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Join & stake/ }));
    });

    expect(mocks.api.joinSession).toHaveBeenCalledTimes(1);
    expect(mocks.api.joinSession).toHaveBeenCalledWith(1n, Payee.Custom, FRIEND, STAKE);
  });
});
