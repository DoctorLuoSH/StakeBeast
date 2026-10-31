/**
 * sessionForm validation tests — the client-side mirror of the contract's
 * createSession guards (R6 combination validation). Each rule pairs with the
 * contract error it pre-empts, so the UI message matches the revert message.
 */

import { describe, expect, it } from "vitest";
import { ZeroAddress } from "ethers";
import { Mode, Payee } from "../contract/types";
import { validateSessionForm } from "./sessionForm";
import type { SessionFormValues } from "./sessionForm";

const ALICE = "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1";
const BOB = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
const FRED = "0x14dC79964da2c15BFB98fB931A3a2E01d1E1a69F";

function base(overrides: Partial<SessionFormValues> = {}): SessionFormValues {
  return {
    mode: "solo",
    stakeEth: "0.05",
    durationMinutes: "25",
    periodDays: "7",
    checkInsPerDay: "1",
    targetCount: "7",
    criterion: "",
    counterparty: "",
    payee: "charity",
    customPayee: "",
    duelTask: "focus",
    cofocusConsent: false,
    self: ALICE,
    ...overrides,
  };
}

describe("validateSessionForm — stake", () => {
  it("accepts a normal stake", () => {
    const { errors, params } = validateSessionForm(base());
    expect(errors).toEqual({});
    expect(params?.stakeWei).toBe(50_000_000_000_000_000n);
    expect(params?.mode).toBe(Mode.SoloFocus);
  });

  it("rejects zero / negative / non-numeric / above-cap stakes", () => {
    expect(validateSessionForm(base({ stakeEth: "0" })).errors.stakeEth).toMatch(/greater than zero/);
    expect(validateSessionForm(base({ stakeEth: "abc" })).errors.stakeEth).toMatch(/valid ETH amount/);
    expect(validateSessionForm(base({ stakeEth: "" })).errors.stakeEth).toMatch(/Enter a stake/);
    expect(validateSessionForm(base({ stakeEth: "101" })).errors.stakeEth).toMatch(/100 ETH cap/);
  });
});

describe("validateSessionForm — task parameter tracks (R6)", () => {
  it("solo focus takes a duration only, 1–1440 minutes", () => {
    expect(validateSessionForm(base({ durationMinutes: "0" })).errors.durationMinutes).toBeDefined();
    expect(validateSessionForm(base({ durationMinutes: "1441" })).errors.durationMinutes).toMatch(/1 and 1440/);
    expect(validateSessionForm(base({ durationMinutes: "abc" })).errors.durationMinutes).toBeDefined();
    const ok = validateSessionForm(base({ durationMinutes: "45" }));
    expect(ok.errors).toEqual({});
    expect(ok.params?.durationMinutes).toBe(45);
    expect(ok.params?.periodDays).toBe(0);
  });

  it("supervised habit takes a period only, with check-in params", () => {
    const ok = validateSessionForm(
      base({ mode: "supervised", counterparty: BOB, periodDays: "7", checkInsPerDay: "2", targetCount: "14" }),
    );
    expect(ok.errors).toEqual({});
    expect(ok.params?.mode).toBe(Mode.Supervised);
    expect(ok.params?.durationMinutes).toBe(0);
    expect(ok.params?.periodDays).toBe(7);
    expect(ok.params?.checkInsPerDay).toBe(2);
    expect(ok.params?.targetCount).toBe(14);

    const bad = validateSessionForm(base({ mode: "supervised", counterparty: BOB, periodDays: "366" }));
    expect(bad.errors.periodDays).toMatch(/1 and 365/);
    const badC = validateSessionForm(base({ mode: "supervised", counterparty: BOB, checkInsPerDay: "9" }));
    expect(badC.errors.checkInsPerDay).toMatch(/1 and 8/);
    const badT = validateSessionForm(base({ mode: "supervised", counterparty: BOB, targetCount: "0" }));
    expect(badT.errors.targetCount).toBeDefined();
  });

  it("supervised habit requires a non-self supervisor address", () => {
    const missing = validateSessionForm(base({ mode: "supervised" }));
    expect(missing.errors.counterparty).toMatch(/supervisor address/);
    const self = validateSessionForm(base({ mode: "supervised", counterparty: ALICE }));
    expect(self.errors.counterparty).toMatch(/your own counterparty/);
    const invalid = validateSessionForm(base({ mode: "supervised", counterparty: "0x123" }));
    expect(invalid.errors.counterparty).toMatch(/valid 0x address/);
  });

  it("duel takes exactly one task style (DuelTaskParamMismatch mirror)", () => {
    const focus = validateSessionForm(base({ mode: "duel", counterparty: BOB, duelTask: "focus", durationMinutes: "30" }));
    expect(focus.errors).toEqual({});
    expect(focus.params?.mode).toBe(Mode.Duel);
    expect(focus.params?.durationMinutes).toBe(30);
    expect(focus.params?.periodDays).toBe(0);

    const habit = validateSessionForm(base({ mode: "duel", counterparty: BOB, duelTask: "habit", periodDays: "3" }));
    expect(habit.errors).toEqual({});
    expect(habit.params?.durationMinutes).toBe(0);
    expect(habit.params?.periodDays).toBe(3);
  });
});

describe("validateSessionForm — payee routes (R6)", () => {
  it("verifier route is human-proof modes only (PayeeVerifierNotAllowed mirror)", () => {
    const soloVerifier = validateSessionForm(base({ mode: "solo", payee: "verifier" }));
    expect(soloVerifier.errors.payee).toMatch(/verifier/);
    const supVerifier = validateSessionForm(base({ mode: "supervised", counterparty: BOB, payee: "verifier" }));
    expect(supVerifier.errors).toEqual({});
    expect(supVerifier.params?.payee).toBe(Payee.Verifier);
  });

  it("custom route requires a concrete address (CustomPayeeZero mirror)", () => {
    const missing = validateSessionForm(base({ mode: "solo", payee: "custom" }));
    expect(missing.errors.customPayee).toMatch(/concrete address/);
    const ok = validateSessionForm(base({ mode: "solo", payee: "custom", customPayee: FRED }));
    expect(ok.errors).toEqual({});
    expect(ok.params?.payee).toBe(Payee.Custom);
    expect(ok.params?.customPayee).toBe(FRED);
  });

  it("co-focus is forced to charity (CoFocusPayeeNotCharity mirror)", () => {
    // Even if a stale payee selection lingers, co-focus params pin Charity.
    const ok = validateSessionForm(base({ mode: "cofocus", cofocusConsent: true, payee: "custom", customPayee: FRED }));
    expect(ok.errors).toEqual({});
    expect(ok.params?.payee).toBe(Payee.Charity);
    expect(ok.params?.customPayee).toBe(ZeroAddress);
  });
});

describe("validateSessionForm — co-focus joint-liability consent", () => {
  it("requires the informed consent before staking", () => {
    const no = validateSessionForm(base({ mode: "cofocus", cofocusConsent: false }));
    expect(no.errors.cofocusConsent).toMatch(/joint liability/);
    expect(no.params).toBeNull();
    const yes = validateSessionForm(base({ mode: "cofocus", cofocusConsent: true }));
    expect(yes.errors).toEqual({});
    expect(yes.params?.mode).toBe(Mode.CoFocus);
    expect(yes.params?.counterparty).toBe(ZeroAddress);
  });
});
