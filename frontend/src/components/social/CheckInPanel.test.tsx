// @vitest-environment jsdom
/**
 * CheckInPanel tests (DAPP-55 F1) — a check-in row whose anchor failed with
 * `period_mismatch` (the day boundary passed after upload, so the on-chain
 * CheckedIn event can never match the record's immutable periodIndex) is a
 * dead end: the re-anchor button must be hidden and the row must steer the
 * user to re-upload instead. Other failure causes keep the re-anchor button.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ZeroAddress } from "ethers";
import { CheckInPanel } from "./CheckInPanel";
import { Mode, Payee, Status } from "../../contract/types";
import type { Session } from "../../contract/types";
import type { CheckinRecord } from "../../lib/socialApi";

const ACCOUNT = "0x0000000000000000000000000000000000000001";

const mocks = vi.hoisted(() => ({
  listCheckins: vi.fn(),
}));

vi.mock("../../lib/socialApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/socialApi")>()),
  listCheckins: mocks.listCheckins,
}));
vi.mock("../../social/useSocialAuth", () => ({
  useSocialAuth: () => ({
    configured: true,
    status: "signed-in",
    token: "tok",
    noteApiError: () => false,
  }),
}));
vi.mock("../../wallet/useWallet", () => ({
  useWallet: () => ({ account: ACCOUNT, provider: null }),
}));
vi.mock("../../contract/useStakeBeast", () => ({
  useStakeBeast: () => ({ api: { checkIn: vi.fn() }, configError: null }),
}));
vi.mock("../../lib/useAuthedImage", () => ({
  useAuthedImage: () => ({ src: null, loading: false, error: null }),
}));

function session(overrides: Partial<Session> = {}): Session {
  return {
    mode: Mode.Supervised,
    status: Status.Active,
    staker: ACCOUNT,
    partner: ZeroAddress,
    verifier: "0x0000000000000000000000000000000000000002",
    payee: Payee.Charity,
    customPayee: ZeroAddress,
    stake: 50_000_000_000_000_000n,
    durationMinutes: 0,
    periodDays: 7,
    checkInsPerDay: 1,
    targetCount: 5,
    criterion: "run 5 km every day",
    linkedSessionId: 0n,
    createdAt: 0,
    joinDeadline: 0,
    startDeadline: 0,
    startTime: 1_700_000_000,
    endTime: 0,
    settlementDeadline: 4_000_000_000,
    joined: false,
    startConfirmedStaker: false,
    startConfirmedPartner: false,
    minted: false,
    ...overrides,
  };
}

function row(overrides: Partial<CheckinRecord> = {}): CheckinRecord {
  return {
    checkinId: "c1",
    periodIndex: 2,
    evidenceHash: `0x${"ab".repeat(32)}`,
    createdAt: "2026-11-02T10:00:00.000Z",
    photoUrl: "/api/media/c1",
    thumbUrl: "/api/media/c1?variant=thumb",
    onchain: { status: "failed", txHash: `0x${"cd".repeat(32)}`, blockNumber: "1500", failReason: null },
    ...overrides,
  };
}

function renderPanel() {
  return render(<CheckInPanel session={session()} sessionId={1n} />);
}

afterEach(() => {
  cleanup();
  mocks.listCheckins.mockReset();
});

describe("CheckInPanel re-anchor affordance (F1)", () => {
  it("hides the re-anchor button on a period_mismatch failure and steers to re-upload", async () => {
    mocks.listCheckins.mockResolvedValue([
      row({ onchain: { status: "failed", txHash: `0x${"cd".repeat(32)}`, blockNumber: "1500", failReason: "period_mismatch" } }),
    ]);
    renderPanel();

    expect(await screen.findByText("anchor failed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Anchor on-chain" })).toBeNull();
    const hint = screen.getByRole("alert");
    expect(hint.textContent).toContain("re-upload the photo as a new check-in");
  });

  it("keeps the re-anchor button for other failure causes and for pending rows", async () => {
    mocks.listCheckins.mockResolvedValue([
      row({
        checkinId: "c1",
        onchain: { status: "failed", txHash: `0x${"cd".repeat(32)}`, blockNumber: "1500", failReason: "event_mismatch" },
      }),
      row({
        checkinId: "c2",
        onchain: { status: "failed", txHash: `0x${"ef".repeat(32)}`, blockNumber: "1501", failReason: "tx_reverted" },
      }),
      row({
        checkinId: "c3",
        onchain: { status: "pending", txHash: `0x${"ab".repeat(32)}`, blockNumber: null, failReason: null },
      }),
    ]);
    renderPanel();

    expect((await screen.findAllByRole("button", { name: "Anchor on-chain" })).length).toBe(3);
    expect(screen.queryByText(/re-upload the photo/)).toBeNull();
  });

  it("shows neither the button nor the hint on a confirmed row", async () => {
    mocks.listCheckins.mockResolvedValue([
      row({ onchain: { status: "confirmed", txHash: `0x${"cd".repeat(32)}`, blockNumber: "1500", failReason: null } }),
    ]);
    renderPanel();

    expect(await screen.findByText("anchored ✓")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Anchor on-chain" })).toBeNull();
    expect(screen.queryByText(/re-upload the photo/)).toBeNull();
  });
});
