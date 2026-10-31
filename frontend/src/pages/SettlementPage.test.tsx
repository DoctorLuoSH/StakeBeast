// @vitest-environment jsdom
/**
 * B3 regression — a forfeited session's payout destination is shown only
 * from the confirmed SessionForfeited log reason. While the log read is
 * pending the page shows a loading hint; when the log cannot be read (RPC
 * error or not-yet-indexed) it shows an unknown state with a retry — never
 * a guessed destination. In particular a timeout forfeit pays charity even
 * when the preset payee was the verifier or a custom address (D6 / AC-03).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ZeroAddress } from "ethers";
import { SettlementPage } from "./SettlementPage";
import { Mode, Payee, Status } from "../contract/types";
import type { Session } from "../contract/types";

const VIEWER = "0x0000000000000000000000000000000000000002";
const STAKER = "0x0000000000000000000000000000000000000001";
const VERIFIER = "0x0000000000000000000000000000000000000003";
const STAKE = 50_000_000_000_000_000n;

const mocks = vi.hoisted(() => {
  const api = {
    getSession: vi.fn(),
    getForfeitReason: vi.fn(),
    claimableOf: vi.fn(async () => 0n),
    owner: vi.fn(async () => "0x0000000000000000000000000000000000000009"),
    onSessionActivity: vi.fn(() => () => {}),
    onWithdrawal: vi.fn(() => () => {}),
    onAnyCredit: vi.fn(() => () => {}),
  };
  return {
    api,
    wallet: {
      status: "connected" as const,
      account: "0x0000000000000000000000000000000000000002",
      chainId: 11155111,
      isExpectedChain: true,
      provider: {},
      error: null,
      connect: async () => {},
      switchToExpectedChain: async () => {},
      disconnect: () => {},
    },
  };
});

vi.mock("../wallet/useWallet", () => ({ useWallet: () => mocks.wallet }));
vi.mock("../contract/client", async (original) => ({
  ...(await original<object>()),
  isContractConfigured: () => true,
  getStakeBeast: () => mocks.api,
}));

function forfeitedSession(overrides: Partial<Session> = {}): Session {
  return {
    mode: Mode.Supervised,
    status: Status.Forfeited,
    staker: STAKER,
    partner: ZeroAddress,
    verifier: VERIFIER,
    payee: Payee.Verifier,
    customPayee: ZeroAddress,
    stake: STAKE,
    durationMinutes: 0,
    periodDays: 7,
    checkInsPerDay: 1,
    targetCount: 7,
    criterion: "",
    linkedSessionId: 0n,
    createdAt: 0,
    joinDeadline: 0,
    startDeadline: 0,
    startTime: 100,
    endTime: 200,
    settlementDeadline: 300,
    joined: true,
    startConfirmedStaker: false,
    startConfirmedPartner: false,
    minted: false,
    ...overrides,
  };
}

function renderSettlement(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/settlement/:sessionId" element={<SettlementPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ForfeitedCard — confirmed reason drives the destination (B3)", () => {
  it("timeout forfeit shows charity even with a verifier payee", async () => {
    mocks.api.getSession.mockResolvedValue(forfeitedSession());
    mocks.api.getForfeitReason.mockResolvedValue(1); // timeout
    renderSettlement("/settlement/5");

    expect(await screen.findByText(/the stake went to charity \(settlement deadline passed\)/)).toBeTruthy();
    expect(screen.queryByText(/went to the verifier/)).toBeNull();
  });

  it("timeout forfeit shows charity even with a custom payee", async () => {
    mocks.api.getSession.mockResolvedValue(
      forfeitedSession({ mode: Mode.SoloFocus, payee: Payee.Custom, customPayee: VERIFIER, verifier: ZeroAddress }),
    );
    mocks.api.getForfeitReason.mockResolvedValue(1);
    renderSettlement("/settlement/5");

    expect(await screen.findByText(/the stake went to charity \(settlement deadline passed\)/)).toBeTruthy();
    expect(screen.queryByText(/custom payee/)).toBeNull();
  });

  it("confirmed admit-defeat shows the preset verifier route", async () => {
    mocks.api.getSession.mockResolvedValue(forfeitedSession());
    mocks.api.getForfeitReason.mockResolvedValue(0); // admitted defeat
    renderSettlement("/settlement/5");

    expect(await screen.findByText(/the stake went to the verifier \(admitted defeat\)/)).toBeTruthy();
  });

  it("confirmed joint forfeit shows the joint-liability charity line", async () => {
    mocks.api.getSession.mockResolvedValue(forfeitedSession({ mode: Mode.CoFocus, partner: VIEWER }));
    mocks.api.getForfeitReason.mockResolvedValue(2); // joint
    renderSettlement("/settlement/5");

    expect(await screen.findByText(/both stakes went to charity under joint liability/)).toBeTruthy();
  });
});

describe("ForfeitedCard — unconfirmed reason never guesses (B3)", () => {
  it("shows a loading hint while the log read is pending", async () => {
    mocks.api.getSession.mockResolvedValue(forfeitedSession());
    let resolveReason!: (r: number) => void;
    mocks.api.getForfeitReason.mockReturnValue(
      new Promise((r) => {
        resolveReason = r;
      }),
    );
    renderSettlement("/settlement/5");

    expect(await screen.findByText(/Confirming the forfeit destination/)).toBeTruthy();
    expect(screen.queryByText(/went to/)).toBeNull();

    await act(async () => {
      resolveReason(1);
    });
    expect(await screen.findByText(/the stake went to charity \(settlement deadline passed\)/)).toBeTruthy();
  });

  it("log read failure shows unknown + retry; a successful retry confirms the route", async () => {
    mocks.api.getSession.mockResolvedValue(forfeitedSession());
    mocks.api.getForfeitReason.mockRejectedValueOnce(new Error("rpc down"));
    renderSettlement("/settlement/5");

    expect(await screen.findByText(/Could not confirm where the stake went/)).toBeTruthy();
    // The verifier payee must NOT be presented while the reason is unconfirmed.
    expect(screen.queryByText(/went to the verifier/)).toBeNull();

    mocks.api.getForfeitReason.mockResolvedValueOnce(0);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Retry reading the log/ }));
    });
    expect(await screen.findByText(/the stake went to the verifier \(admitted defeat\)/)).toBeTruthy();
  });

  it("a missing log (null) is unknown with retry, not a guessed route", async () => {
    mocks.api.getSession.mockResolvedValue(forfeitedSession());
    mocks.api.getForfeitReason.mockResolvedValue(null);
    renderSettlement("/settlement/5");

    expect(await screen.findByText(/Could not confirm where the stake went/)).toBeTruthy();
    expect(screen.queryByText(/went to/)).toBeNull();
    expect(screen.getByRole("button", { name: /Retry reading the log/ })).toBeTruthy();
  });

  it("switching sessions never shows the previous session's destination", async () => {
    mocks.api.getSession.mockImplementation((id: bigint) =>
      id === 5n ? Promise.resolve(forfeitedSession()) : new Promise<Session>(() => {}),
    );
    mocks.api.getForfeitReason.mockResolvedValue(0);
    render(
      <MemoryRouter initialEntries={["/settlement/5"]}>
        <Routes>
          <Route path="/settlement/:sessionId" element={<SettlementPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/the stake went to the verifier \(admitted defeat\)/)).toBeTruthy();

    // In-place param switch: session 6 is still loading — no stale destination.
    cleanup();
    mocks.api.getSession.mockImplementation((id: bigint) =>
      id === 6n ? new Promise<Session>(() => {}) : Promise.resolve(forfeitedSession()),
    );
    renderSettlement("/settlement/6");
    expect(await screen.findByText(/Loading session #6 from the chain/)).toBeTruthy();
    expect(screen.queryByText(/went to the verifier/)).toBeNull();
  });
});
