// @vitest-environment jsdom
/**
 * CreateSessionPage tests: R6 field-level validation surfaces before any
 * transaction is sent, and the co-focus joint-liability consent gates the
 * stake. The contract client is mocked — these tests cover form behaviour,
 * not the chain.
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { WalletContext } from "../wallet/walletContext";
import type { WalletContextValue } from "../wallet/walletContext";
import { CreateSessionPage } from "./CreateSessionPage";

const CREATE_SESSION = vi.fn();
const READ_CREATED_ID = vi.fn((): bigint | null => 7n);
const SESSIONS_OF = vi.fn();
const ASSERT_DEPLOYED = vi.fn();

const OPPONENT = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

vi.mock("../contract/useStakeBeast", () => ({
  useStakeBeast: () => ({
    api: {
      address: "0x00000000000000000000000000000000000000aa",
      createSession: CREATE_SESSION,
      readCreatedSessionId: READ_CREATED_ID,
      sessionsOf: SESSIONS_OF,
      assertDeployed: ASSERT_DEPLOYED,
    },
    configError: null,
  }),
}));

const CONNECTED_WALLET: WalletContextValue = {
  status: "connected",
  account: "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1",
  chainId: 11155111,
  isExpectedChain: true,
  provider: null,
  error: null,
  connect: async () => {},
  switchToExpectedChain: async () => {},
  disconnect: () => {},
};

function Landed() {
  const { sessionId } = useParams();
  return <p>landed on session {sessionId}</p>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/create"]}>
      <WalletContext.Provider value={CONNECTED_WALLET}>
        <Routes>
          <Route path="/create" element={<CreateSessionPage />} />
          <Route path="/focus/:sessionId" element={<Landed />} />
        </Routes>
      </WalletContext.Provider>
    </MemoryRouter>,
  );
}

function selectMode(title: string) {
  fireEvent.click(screen.getByRole("tab", { name: new RegExp(title) }));
}

function mockResolvedTx() {
  CREATE_SESSION.mockResolvedValue({
    hash: "0xdeadbeef",
    wait: async () => ({ hash: "0xdeadbeef", logs: [] }),
  });
}

afterEach(() => {
  cleanup();
  CREATE_SESSION.mockReset();
  READ_CREATED_ID.mockClear();
  SESSIONS_OF.mockReset();
  ASSERT_DEPLOYED.mockReset();
});

describe("CreateSessionPage validation", () => {
  it("blocks an out-of-range duration before any transaction", () => {
    renderPage();
    const duration = screen.getByLabelText(/Focus duration/);
    fireEvent.change(duration, { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: /Stake & Create/ }));
    expect(screen.getByText(/between 1 and 1440 minutes/)).toBeTruthy();
    expect(CREATE_SESSION).not.toHaveBeenCalled();
  });

  it("requires a supervisor address for supervised habits", () => {
    renderPage();
    selectMode("Supervised Habit");
    fireEvent.click(screen.getByRole("button", { name: /Stake & Create/ }));
    expect(screen.getByText(/needs a supervisor address/)).toBeTruthy();
    expect(CREATE_SESSION).not.toHaveBeenCalled();
  });

  it("requires a concrete address for the custom forfeit route", () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/Forfeit destination/), { target: { value: "custom" } });
    fireEvent.click(screen.getByRole("button", { name: /Stake & Create/ }));
    expect(screen.getByText(/concrete address/)).toBeTruthy();
    expect(CREATE_SESSION).not.toHaveBeenCalled();
  });

  it("forces the charity route display for co-focus", () => {
    renderPage();
    selectMode("Co-Focus Duo");
    const select = screen.getByLabelText(/Forfeit destination/) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("charity");
  });
});

describe("CreateSessionPage duel opponent (member ruling 2026-11-03, DAPP-51/DAPP-60)", () => {
  it("keeps Stake & Create disabled until an opponent address is entered", () => {
    renderPage();
    selectMode("Mutual Bet");
    const submitButton = screen.getByRole("button", { name: /Stake & Create/ }) as HTMLButtonElement;
    // Required field starts empty → submission is disabled before any click.
    expect(submitButton.disabled).toBe(true);
    // The field-level error appears as soon as the field is touched.
    fireEvent.blur(screen.getByLabelText(/Opponent address/));
    expect(screen.getByText(/needs an opponent address/)).toBeTruthy();
    fireEvent.click(submitButton);
    expect(CREATE_SESSION).not.toHaveBeenCalled();
  });

  it("blocks an invalid opponent address at the field and never sends a transaction", () => {
    renderPage();
    selectMode("Mutual Bet");
    fireEvent.change(screen.getByLabelText(/Opponent address/), { target: { value: "0x123" } });
    // Live field-level feedback without a submit attempt.
    expect(screen.getByText(/valid 0x address/)).toBeTruthy();
    const submitButton = screen.getByRole("button", { name: /Stake & Create/ }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
    fireEvent.click(submitButton);
    expect(CREATE_SESSION).not.toHaveBeenCalled();
  });

  it("blocks the zero-address opponent at the field and never sends a transaction", () => {
    // No open-challenge entry this term: the zero opponent keeps the submit
    // disabled, so no wallet transaction request is triggered either.
    renderPage();
    selectMode("Mutual Bet");
    fireEvent.change(screen.getByLabelText(/Opponent address/), { target: { value: ZERO_ADDRESS } });
    expect(screen.getByText(/zero address/)).toBeTruthy();
    const submitButton = screen.getByRole("button", { name: /Stake & Create/ }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
    fireEvent.click(submitButton);
    expect(CREATE_SESSION).not.toHaveBeenCalled();
  });

  it("creates a duel once a valid non-zero opponent is entered", async () => {
    mockResolvedTx();
    renderPage();
    selectMode("Mutual Bet");
    fireEvent.change(screen.getByLabelText(/Opponent address/), { target: { value: OPPONENT } });
    const submitButton = screen.getByRole("button", { name: /Stake & Create/ }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(false);
    fireEvent.click(submitButton);
    // submit is async (pre-flight check) — the call lands on the next tick.
    await waitFor(() => expect(CREATE_SESSION).toHaveBeenCalledTimes(1));
    expect(CREATE_SESSION.mock.calls[0][0].counterparty).toBe(OPPONENT);
    expect(await screen.findByText("landed on session 7")).toBeTruthy();
  });

  it("clears the opponent error and re-enables submit once the address is fixed", () => {
    renderPage();
    selectMode("Mutual Bet");
    const input = screen.getByLabelText(/Opponent address/);
    fireEvent.change(input, { target: { value: "0x123" } });
    expect(screen.getByText(/valid 0x address/)).toBeTruthy();
    fireEvent.change(input, { target: { value: OPPONENT } });
    expect(screen.queryByText(/valid 0x address/)).toBeNull();
    const submitButton = screen.getByRole("button", { name: /Stake & Create/ }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(false);
  });
});

describe("CreateSessionPage co-focus consent", () => {
  it("gates staking behind the joint-liability confirmation", async () => {
    mockResolvedTx();
    renderPage();
    selectMode("Co-Focus Duo");
    fireEvent.click(screen.getByRole("button", { name: /Stake & Create/ }));

    // Consent dialog instead of a transaction.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(CREATE_SESSION).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /I understand/ }));
    // submit is async (pre-flight check) — the call lands on the next tick.
    await waitFor(() => expect(CREATE_SESSION).toHaveBeenCalledTimes(1));
    // Co-focus is forced to the charity route on-chain (R6).
    expect(CREATE_SESSION.mock.calls[0][0].payee).toBe(0);
    // Success navigates to the new session's focus page.
    expect(await screen.findByText("landed on session 7")).toBeTruthy();
  });
});

describe("CreateSessionPage happy path", () => {
  it("submits a valid solo focus session and navigates to it", async () => {
    mockResolvedTx();
    renderPage();
    fireEvent.change(screen.getByLabelText(/Stake amount/), { target: { value: "0.01" } });
    fireEvent.change(screen.getByLabelText(/Focus duration/), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: /Stake & Create/ }));
    await waitFor(() => expect(CREATE_SESSION).toHaveBeenCalledTimes(1));
    const input = CREATE_SESSION.mock.calls[0][0];
    expect(input.mode).toBe(0);
    expect(input.durationMinutes).toBe(30);
    expect(input.stakeWei).toBe(10_000_000_000_000_000n);
    expect(await screen.findByText("landed on session 7")).toBeTruthy();
    // The receipt parsed — the on-chain fallback must stay untouched.
    expect(SESSIONS_OF).not.toHaveBeenCalled();
  });
});

describe("CreateSessionPage confirmation recovery (DAPP-44)", () => {
  it("blocks the stake before sending when no code lives at the configured address", async () => {
    ASSERT_DEPLOYED.mockRejectedValueOnce(
      new Error("No contract code at the configured address 0x…aa on the current network."),
    );
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /Stake & Create/ }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/No contract code at the configured address/)).toBeTruthy();
    // The value-bearing transaction must never be sent.
    expect(CREATE_SESSION).not.toHaveBeenCalled();
    expect(screen.queryByText(/landed on session/)).toBeNull();
  });

  it("falls back to sessionsOf when the receipt yields no session id", async () => {
    mockResolvedTx();
    READ_CREATED_ID.mockReturnValueOnce(null);
    SESSIONS_OF.mockResolvedValue([3n, 7n]);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /Stake & Create/ }));
    await waitFor(() => expect(CREATE_SESSION).toHaveBeenCalledTimes(1));
    // The newest recorded session is the one just created.
    expect(await screen.findByText("landed on session 7")).toBeTruthy();
    expect(SESSIONS_OF).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the recovery panel with the tx hash when the chain has no new session", async () => {
    mockResolvedTx();
    READ_CREATED_ID.mockReturnValueOnce(null);
    SESSIONS_OF.mockResolvedValue([]);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /Stake & Create/ }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/no session was found/)).toBeTruthy();
    expect(screen.getByText(/0xdeadbeef/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open My sessions/ })).toBeTruthy();
    // Still on the create page — no navigation happened.
    expect(screen.queryByText(/landed on session/)).toBeNull();
  });

  it("shows the same panel when the fallback read fails (no code at the address)", async () => {
    mockResolvedTx();
    READ_CREATED_ID.mockReturnValueOnce(null);
    SESSIONS_OF.mockRejectedValue(new Error("could not decode result data (value=\"0x\")"));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /Stake & Create/ }));
    expect(await screen.findByText(/no session was found/)).toBeTruthy();
    expect(screen.queryByText(/landed on session/)).toBeNull();
  });
});
