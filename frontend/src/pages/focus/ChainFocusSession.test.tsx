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
 *
 * F1 (DAPP-52) — the settlement prompt and the "Session failed" card are
 * gated on the service-confirmed violation only; a transient localHidden
 * (hidden event unconfirmed or out of window) never produces a
 * false-positive failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ZeroAddress } from "ethers";
import { ChainFocusSession } from "./ChainFocusSession";
import { Mode, Payee, Status } from "../../contract/types";
import type { Session } from "../../contract/types";
import type { ProofTrackState } from "../../lib/proofTracker";

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
    proof: null as {
      enabled: boolean;
      state: ProofTrackState;
      bind: () => Promise<boolean>;
      notifyStarted: (txHash: string) => void;
    } | null,
  };
});

vi.mock("../../wallet/useWallet", () => ({ useWallet: () => mocks.wallet }));
vi.mock("../../contract/client", async (original) => ({
  ...(await original<object>()),
  isContractConfigured: () => true,
  getStakeBeast: () => mocks.api,
}));
vi.mock("../../lib/useProofTracking", () => ({
  useProofTracking: () => mocks.proof,
}));

/** Track-state fixture with the tracker defaults overridable per test. */
function trackState(overrides: Partial<ProofTrackState> = {}): ProofTrackState {
  return {
    phase: "tracking",
    lifecycle: "monitoring",
    violation: false,
    localHidden: false,
    attestationReady: false,
    uncertifiable: false,
    unreachable: false,
    error: null,
    lastAckSeq: 12,
    participants: [],
    ...overrides,
  };
}

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
  // Default: tracking disabled — only the F1 block enables it per test.
  mocks.proof = {
    enabled: false,
    state: trackState(),
    bind: async () => false,
    notifyStarted: () => {},
  };
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

describe("F1 — settlement gate uses only the service-confirmed violation", () => {
  const nowSec = () => Math.floor(Date.now() / 1000);

  /** Active solo session whose window has already ended. */
  const endedSession = () =>
    pendingSession({
      mode: Mode.SoloFocus,
      status: Status.Active,
      staker: VIEWER,
      startDeadline: nowSec() - 700,
      startTime: nowSec() - 660,
      endTime: nowSec() - 60,
      settlementDeadline: nowSec() + 3600,
      joined: true,
    });

  const enableProof = (state: Partial<ProofTrackState>) => {
    mocks.proof = {
      enabled: true,
      state: trackState(state),
      bind: async () => true,
      notifyStarted: () => {},
    };
  };

  it("unconfirmed hidden event + attestationReady: settlement prompt appears, no false 'Session failed'", async () => {
    mocks.api.getSession.mockResolvedValue(endedSession());
    enableProof({ attestationReady: true, localHidden: true, lifecycle: "clean" });
    renderSession();

    expect(await screen.findByText("Coverage verified — settle the session")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Go to settlement/ })).toBeTruthy();
    expect(screen.queryByText("Session failed")).toBeNull();
  });

  it("transient hidden signal while finalizing: no 'Session failed', no settlement entry yet", async () => {
    mocks.api.getSession.mockResolvedValue(endedSession());
    enableProof({ localHidden: true });
    renderSession();

    expect(await screen.findByText(/Finalizing coverage/)).toBeTruthy();
    expect(screen.queryByText("Session failed")).toBeNull();
    // The transient warning card still shows (its sanctioned role).
    expect(screen.getByText("Violation flagged")).toBeTruthy();
  });

  it("service-confirmed violation past the window: 'Session failed' and no settlement entry", async () => {
    mocks.api.getSession.mockResolvedValue(endedSession());
    enableProof({ violation: true, lifecycle: "violation" });
    renderSession();

    expect(await screen.findByText("Session failed")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Go to settlement/ })).toBeNull();
  });
});
