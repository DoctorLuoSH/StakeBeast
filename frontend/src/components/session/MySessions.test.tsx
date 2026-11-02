// @vitest-environment jsdom
/**
 * MySessions tests (DAPP-44) — the recovery entry after a missed create
 * navigation: sessions the chain recorded for the connected account render
 * newest first with focus-page links; the empty state points at /create; a
 * read failure shows a retryable error instead of a silent empty list.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ZeroAddress } from "ethers";
import { MySessions } from "./MySessions";
import { Mode, Payee, Status } from "../../contract/types";
import type { Session } from "../../contract/types";

const ACCOUNT = "0x0000000000000000000000000000000000000001";

const mocks = vi.hoisted(() => ({
  api: {
    sessionsOf: vi.fn(),
    getSession: vi.fn(),
  },
}));

vi.mock("../../contract/useStakeBeast", () => ({
  useStakeBeast: () => ({ api: mocks.api, configError: null }),
}));
vi.mock("../../wallet/useWallet", () => ({
  useWallet: () => ({ account: "0x0000000000000000000000000000000000000001" }),
}));

function session(overrides: Partial<Session> = {}): Session {
  return {
    mode: Mode.SoloFocus,
    status: Status.Pending,
    staker: ACCOUNT,
    partner: ZeroAddress,
    verifier: ZeroAddress,
    payee: Payee.Charity,
    customPayee: ZeroAddress,
    stake: 50_000_000_000_000_000n,
    durationMinutes: 25,
    periodDays: 0,
    checkInsPerDay: 0,
    targetCount: 0,
    criterion: "",
    linkedSessionId: 0n,
    createdAt: 0,
    joinDeadline: 0,
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

function renderList() {
  return render(
    <MemoryRouter>
      <MySessions />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mocks.api.sessionsOf.mockReset();
  mocks.api.getSession.mockReset();
});

describe("MySessions", () => {
  it("lists recorded sessions newest first with focus-page links", async () => {
    mocks.api.sessionsOf.mockResolvedValue([1n, 2n]);
    mocks.api.getSession.mockImplementation(async (id: bigint) =>
      id === 1n
        ? session()
        : session({ mode: Mode.Supervised, status: Status.Active, durationMinutes: 0, periodDays: 7 }),
    );
    renderList();

    const links = await screen.findAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/focus/2", "/focus/1"]);
    expect(links[0].textContent).toContain("#2");
    expect(links[0].textContent).toContain("Supervised Habit");
    expect(links[0].textContent).toContain("Active");
    expect(links[1].textContent).toContain("#1");
    expect(links[1].textContent).toContain("Solo Focus");
    expect(links[1].textContent).toContain("Pending");
    expect(mocks.api.sessionsOf).toHaveBeenCalledWith(ACCOUNT);
  });

  it("shows the empty state pointing at /create when nothing is recorded", async () => {
    mocks.api.sessionsOf.mockResolvedValue([]);
    renderList();
    expect(await screen.findByText("No sessions yet")).toBeTruthy();
    const create = screen.getByRole("link", { name: /Create a session/ });
    expect(create.getAttribute("href")).toBe("/create");
  });

  it("surfaces a retryable error when the chain read fails", async () => {
    mocks.api.sessionsOf.mockRejectedValueOnce(new Error("could not decode result data"));
    renderList();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Could not load your sessions/)).toBeTruthy();
    // No fake empty list next to the error.
    expect(screen.queryByText("No sessions yet")).toBeNull();

    mocks.api.sessionsOf.mockResolvedValue([1n]);
    mocks.api.getSession.mockResolvedValue(session());
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    const link = await screen.findByRole("link", { name: /#1/ });
    expect(link.getAttribute("href")).toBe("/focus/1");
  });
});
