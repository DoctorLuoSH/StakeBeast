// @vitest-environment jsdom
/**
 * CreateSessionPage tests: R6 field-level validation surfaces before any
 * transaction is sent, and the co-focus joint-liability consent gates the
 * stake. The contract client is mocked — these tests cover form behaviour,
 * not the chain.
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { WalletContext } from "../wallet/walletContext";
import type { WalletContextValue } from "../wallet/walletContext";
import { CreateSessionPage } from "./CreateSessionPage";

const CREATE_SESSION = vi.fn();
const READ_CREATED_ID = vi.fn(() => 7n);

vi.mock("../contract/useStakeBeast", () => ({
  useStakeBeast: () => ({
    api: {
      address: "0x00000000000000000000000000000000000000aa",
      createSession: CREATE_SESSION,
      readCreatedSessionId: READ_CREATED_ID,
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
    wait: async () => ({ logs: [] }),
  });
}

afterEach(() => {
  cleanup();
  CREATE_SESSION.mockReset();
  READ_CREATED_ID.mockClear();
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
    expect(CREATE_SESSION).toHaveBeenCalledTimes(1);
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
    expect(CREATE_SESSION).toHaveBeenCalledTimes(1);
    const input = CREATE_SESSION.mock.calls[0][0];
    expect(input.mode).toBe(0);
    expect(input.durationMinutes).toBe(30);
    expect(input.stakeWei).toBe(10_000_000_000_000_000n);
    expect(await screen.findByText("landed on session 7")).toBeTruthy();
  });
});
