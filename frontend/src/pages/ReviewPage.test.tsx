// @vitest-environment jsdom
/**
 * ReviewPage tests (DAPP-55 F2) — after the supervisor's `verify` confirms
 * on-chain the session is Completed, but the backend mirror can keep serving
 * stale `Active` for its 60 s TTL. The card must mark the session non-active
 * locally the moment the transaction confirms, so a second Confirm click
 * (a guaranteed on-chain revert, wasted gas) is impossible — even after the
 * list reloads and the mirror still says Active.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ReviewPage } from "./ReviewPage";
import type { ReviewItem } from "../lib/socialApi";

const VERIFIER = "0x0000000000000000000000000000000000000002";
const STAKER = "0x0000000000000000000000000000000000000001";
const TX_HASH = `0x${"ab".repeat(32)}`;

const mocks = vi.hoisted(() => ({
  listReviewPending: vi.fn(),
  api: {
    verify: vi.fn(),
    listCheckedIn: vi.fn(),
  },
}));

vi.mock("../lib/socialApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/socialApi")>()),
  listReviewPending: mocks.listReviewPending,
}));
vi.mock("../social/useSocialAuth", () => ({
  useSocialAuth: () => ({
    configured: true,
    status: "signed-in",
    token: "tok",
    noteApiError: () => false,
  }),
}));
vi.mock("../wallet/useWallet", () => ({
  useWallet: () => ({ account: VERIFIER }),
}));
vi.mock("../contract/useStakeBeast", () => ({
  useStakeBeast: () => ({ api: mocks.api, configError: null }),
}));
vi.mock("../components/wallet/WalletGate", () => ({
  WalletGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

/** Active on-chain (status 1) with a far-future settlement deadline. */
function activeItem(): ReviewItem {
  return {
    sessionId: "7",
    staker: STAKER,
    nickname: null,
    avatarUrl: null,
    criterion: "run 5 km every day",
    periodDays: 7,
    targetCount: 5,
    latestCheckins: [],
    onchain: { status: 1, settlementDeadline: 4_000_000_000 },
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ReviewPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mocks.listReviewPending.mockReset();
  mocks.api.verify.mockReset();
  mocks.api.listCheckedIn.mockReset();
});

describe("ReviewPage confirm-once (F2)", () => {
  it("hides Confirm after a successful verify even while the stale mirror still says Active", async () => {
    // The mirror keeps returning Active within its TTL — the defect scenario.
    mocks.listReviewPending.mockResolvedValue([activeItem()]);
    mocks.api.verify.mockResolvedValue({
      hash: TX_HASH,
      wait: async () => ({ status: 1, blockNumber: 1500 }),
    });

    renderPage();
    const confirm = await screen.findByRole("button", { name: "Confirm completion on-chain" });
    fireEvent.click(confirm);

    // The tx confirms: success banner, the button disappears, the card reads non-active.
    expect(await screen.findByText(/Verify confirmed/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm completion on-chain" })).toBeNull();
    expect(screen.getByText("This session is no longer active on-chain.")).toBeTruthy();

    // The post-verify reload still serves the stale Active row (60 s mirror
    // TTL) — the local confirmed marker must keep the button hidden.
    await waitFor(() => expect(mocks.listReviewPending.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole("heading", { name: /Session #7/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm completion on-chain" })).toBeNull();
    expect(mocks.api.verify).toHaveBeenCalledTimes(1);
    expect(mocks.api.verify).toHaveBeenCalledWith(7n);
  });

  it("keeps Confirm available when the verify transaction fails", async () => {
    mocks.listReviewPending.mockResolvedValue([activeItem()]);
    mocks.api.verify.mockRejectedValue(new Error("execution reverted"));

    renderPage();
    const confirm = await screen.findByRole("button", { name: "Confirm completion on-chain" });
    fireEvent.click(confirm);

    // The failure banner shows and the button stays — the session is still Active.
    await waitFor(() => expect(mocks.api.verify).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Confirm completion on-chain" })).toBeTruthy();
    expect(screen.queryByText("This session is no longer active on-chain.")).toBeNull();
  });
});
