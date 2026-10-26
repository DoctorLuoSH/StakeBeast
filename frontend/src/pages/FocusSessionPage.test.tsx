// @vitest-environment jsdom
/**
 * FocusSessionPage settlement-hint tests (DAPP-29 review fix): the
 * "submit the attestation to settle" hint is gated on `elapsed && !violated`.
 * A session violated first and then run to the window end must show only the
 * violation / settlement-route notice — never the submit-to-settle entry.
 */

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WalletContext } from "../wallet/walletContext";
import type { WalletContextValue } from "../wallet/walletContext";
import { FocusSessionPage } from "./FocusSessionPage";

const DEMO_DURATION_MS = 2 * 60 * 1000;

const CONNECTED_WALLET: WalletContextValue = {
  status: "connected",
  account: "0x0000000000000000000000000000000000000001",
  chainId: 11155111,
  isSepolia: true,
  provider: null,
  error: null,
  connect: async () => {},
  switchToSepolia: async () => {},
  disconnect: () => {},
};

function renderPage() {
  return render(
    <WalletContext.Provider value={CONNECTED_WALLET}>
      <FocusSessionPage />
    </WalletContext.Provider>,
  );
}

/** Run the demo session past its 2-minute window. */
function runPastWindowEnd() {
  act(() => {
    vi.advanceTimersByTime(DEMO_DURATION_MS + 2000);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("FocusSessionPage settlement hint", () => {
  it("shows the submit-to-settle hint when the window ends clean", () => {
    renderPage();
    runPastWindowEnd();
    expect(screen.getByText(/submit the attestation to settle/)).toBeTruthy();
    expect(screen.queryByText("Violation flagged")).toBeNull();
  });

  it("violation first, then window end: no submit-to-settle entry", () => {
    renderPage();
    fireEvent.click(screen.getByText("Simulate violation"));
    expect(screen.getByText("Violation flagged")).toBeTruthy();

    runPastWindowEnd();

    // Only the violation / settlement-route notice remains — the
    // submit-to-settle hint must not render for a violated session.
    expect(screen.getByText("Violation flagged")).toBeTruthy();
    expect(
      screen.getByText(/after the settlement deadline, anyone can trigger/),
    ).toBeTruthy();
    expect(screen.queryByText(/submit the attestation to settle/)).toBeNull();
  });
});
