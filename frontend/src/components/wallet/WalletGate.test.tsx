// @vitest-environment jsdom
/**
 * WalletGate tests: the deployment-facing wallet states — no injected wallet,
 * disconnected, wrong network (with the one-click switch guidance), and the
 * expected chain — each render the correct screen. The wallet context is
 * mocked; these tests cover the gate, not MetaMask itself.
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WalletContext } from "../../wallet/walletContext";
import type { WalletContextValue } from "../../wallet/walletContext";
import { WalletGate } from "./WalletGate";

const BASE_WALLET: WalletContextValue = {
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

function renderGate(wallet: Partial<WalletContextValue>) {
  return render(
    <WalletContext.Provider value={{ ...BASE_WALLET, ...wallet }}>
      <WalletGate>
        <p>protected content</p>
      </WalletGate>
    </WalletContext.Provider>,
  );
}

afterEach(cleanup);

describe("WalletGate", () => {
  it("guides to install MetaMask when no wallet is injected", () => {
    renderGate({ status: "no-provider", account: null, chainId: null, isExpectedChain: false });
    expect(screen.getByText("MetaMask not found")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Install MetaMask/ })).toBeTruthy();
    expect(screen.queryByText("protected content")).toBeNull();
  });

  it("prompts to connect when the wallet is disconnected", () => {
    renderGate({ status: "disconnected", account: null, chainId: null, isExpectedChain: false });
    expect(screen.getByRole("button", { name: "Connect Wallet" })).toBeTruthy();
    expect(screen.queryByText("protected content")).toBeNull();
  });

  it("blocks on the wrong network and offers a one-click switch", () => {
    const switchToExpectedChain = vi.fn(async () => {});
    renderGate({
      status: "connected",
      chainId: 1,
      isExpectedChain: false,
      switchToExpectedChain,
    });
    expect(screen.getByText("Wrong network")).toBeTruthy();
    expect(screen.queryByText("protected content")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Switch to / }));
    expect(switchToExpectedChain).toHaveBeenCalledTimes(1);
  });

  it("surfaces a rejected switch as an inline error", () => {
    renderGate({
      status: "connected",
      chainId: 1,
      isExpectedChain: false,
      error: "Network switch was rejected in MetaMask.",
    });
    expect(screen.getByText("Wrong network")).toBeTruthy();
    expect(screen.getByText("Network switch was rejected in MetaMask.")).toBeTruthy();
  });

  it("renders children on the expected chain", () => {
    renderGate({});
    expect(screen.getByText("protected content")).toBeTruthy();
  });
});
