// @vitest-environment jsdom
/**
 * ProfilePage tests (DAPP-47) — the personal homepage renders the real
 * on-chain record (successes / failures / completed time / forfeited stake)
 * and the My Zoo shelf fed by real BeastNFT mints, per connected account.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ZeroAddress } from "ethers";
import { ProfilePage } from "./ProfilePage";
import { Kind, Mode, Payee, Status, Tier } from "../contract/types";
import type { Session } from "../contract/types";
import type { MintedBeast } from "../contract/nft";
import type { SessionRow } from "../contract/useAccountSessions";

const ME = "0x0000000000000000000000000000000000000001";

const mocks = vi.hoisted(() => ({
  sessions: { rows: null as SessionRow[] | null, loading: false, error: null, refresh: () => {} },
  beasts: {
    beasts: null as MintedBeast[] | null,
    loading: false,
    error: null as string | null,
    configError: null as string | null,
    refresh: () => {},
  },
  social: {
    configured: true,
    walletReady: true,
    status: "signed-out" as const,
    token: null,
    profile: null,
    error: null,
    signIn: async () => false,
    signOut: () => {},
    retryRestore: () => {},
    refreshProfile: async () => {},
    setNickname: async () => false,
    changeAvatar: async () => false,
    noteApiError: () => false,
  },
}));

vi.mock("../wallet/useWallet", () => ({
  useWallet: () => ({ account: ME }),
}));
vi.mock("../contract/useAccountSessions", () => ({
  useAccountSessions: () => mocks.sessions,
}));
vi.mock("../contract/useBeasts", () => ({
  useMyBeasts: () => mocks.beasts,
}));
vi.mock("../social/useSocialAuth", () => ({
  useSocialAuth: () => mocks.social,
}));
vi.mock("../components/wallet/WalletGate", () => ({
  WalletGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function session(overrides: Partial<Session> = {}): Session {
  return {
    mode: Mode.SoloFocus,
    status: Status.Active,
    staker: ME,
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

function renderPage() {
  return render(
    <MemoryRouter>
      <ProfilePage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mocks.sessions.rows = null;
  mocks.beasts.beasts = null;
});

describe("ProfilePage", () => {
  it("renders the record stats from on-chain sessions", () => {
    mocks.sessions.rows = [
      { id: 1n, session: session({ status: Status.Completed, durationMinutes: 130 }) },
      {
        id: 2n,
        session: session({
          status: Status.Forfeited,
          mode: Mode.Supervised,
          durationMinutes: 0,
          periodDays: 7,
          stake: 20_000_000_000_000_000n,
        }),
      },
      { id: 3n, session: session({ status: Status.Active }) },
    ];
    renderPage();
    expect(screen.getByText("Sessions succeeded").parentElement?.textContent).toContain("1");
    expect(screen.getByText("Sessions failed").parentElement?.textContent).toContain("1");
    expect(screen.getByText("Focus time banked").parentElement?.textContent).toContain("2 h 10 min");
    expect(screen.getByText("Total forfeited").parentElement?.textContent).toContain("0.02 ETH");
  });

  it("renders real minted beasts on the shelf", () => {
    mocks.sessions.rows = [];
    mocks.beasts.beasts = [
      {
        tokenId: 1n,
        sessionId: 7n,
        kind: Kind.Focus,
        metricValue: 50n,
        tier: Tier.Adult,
        completionDate: 1_793_568_000,
      },
    ];
    renderPage();
    expect(screen.getByText("50 min focus")).toBeTruthy();
    expect(screen.getByText("Adult")).toBeTruthy();
  });

  it("shows a retryable error when the chain read fails", () => {
    mocks.beasts.beasts = [];
    mocks.beasts.error = "rpc down";
    renderPage();
    expect(screen.getByRole("alert").textContent).toContain("rpc down");
    mocks.beasts.error = null;
  });
});
