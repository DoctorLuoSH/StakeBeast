/**
 * Create-session form validation — the client-side mirror of the contract's
 * createSession guards (frozen baseline R6 combination validation), so users
 * get field-level human-readable feedback before any transaction is sent.
 * Pure module: unit-tested without a chain.
 */

import { ZeroAddress, isAddress, parseEther } from "ethers";
import { Mode, Payee } from "../contract/types";
import type { CreateSessionInput } from "../contract/client";

export type FormMode = "solo" | "supervised" | "duel" | "cofocus";
export type PayeeChoice = "charity" | "verifier" | "custom";
export type DuelTask = "focus" | "habit";

export interface SessionFormValues {
  mode: FormMode;
  /** ETH string, e.g. "0.05". */
  stakeEth: string;
  durationMinutes: string;
  periodDays: string;
  checkInsPerDay: string;
  targetCount: string;
  criterion: string;
  /** Supervisor address (supervised) or opponent address (duel). */
  counterparty: string;
  payee: PayeeChoice;
  customPayee: string;
  /** Duel only: which metering track the bet uses. */
  duelTask: DuelTask;
  /** Co-focus only: joint-liability informed consent. */
  cofocusConsent: boolean;
  /** Connected account, for the self-counterparty check. */
  self: string | null;
}

export type SessionFormErrors = Partial<Record<string, string>>;

export interface ValidatedSessionForm {
  errors: SessionFormErrors;
  /** Null whenever any error is present. */
  params: CreateSessionInput | null;
}

const MAX_STAKE_ETH = 100;

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function sameAddress(a: string, b: string | null): boolean {
  return b !== null && a.toLowerCase() === b.toLowerCase();
}

export function validateSessionForm(v: SessionFormValues): ValidatedSessionForm {
  const errors: SessionFormErrors = {};

  // ------------------------------------------------------------- stake --
  let stakeWei: bigint | null = null;
  const stakeRaw = v.stakeEth.trim();
  if (!stakeRaw) {
    errors.stakeEth = "Enter a stake amount.";
  } else {
    try {
      stakeWei = parseEther(stakeRaw);
    } catch {
      errors.stakeEth = "Enter a valid ETH amount, e.g. 0.05.";
    }
    if (stakeWei !== null) {
      if (stakeWei <= 0n) errors.stakeEth = "The stake must be greater than zero.";
      else if (stakeWei > parseEther(String(MAX_STAKE_ETH)))
        errors.stakeEth = `The stake exceeds the ${MAX_STAKE_ETH} ETH cap.`;
    }
  }

  // ------------------------------------------------- task parameters --
  // Machine-proof focus takes a duration only; supervised habit a period
  // only; a duel takes exactly one of the two (R6, DuelTaskParamMismatch).
  let durationMinutes = 0;
  let periodDays = 0;
  let checkInsPerDay = 0;
  let targetCount = 0;

  const wantsDuration = v.mode === "solo" || v.mode === "cofocus" || (v.mode === "duel" && v.duelTask === "focus");
  const wantsPeriod = v.mode === "supervised" || (v.mode === "duel" && v.duelTask === "habit");

  if (wantsDuration) {
    const d = parsePositiveInt(v.durationMinutes);
    if (d === null) {
      errors.durationMinutes = "Enter a whole number of minutes.";
    } else if (d < 1 || d > 1440) {
      errors.durationMinutes = "Focus duration must be between 1 and 1440 minutes.";
    } else {
      durationMinutes = d;
    }
  }
  if (wantsPeriod) {
    const p = parsePositiveInt(v.periodDays);
    if (p === null) {
      errors.periodDays = "Enter a whole number of days.";
    } else if (p < 1 || p > 365) {
      errors.periodDays = "Habit period must be between 1 and 365 days.";
    } else {
      periodDays = p;
    }
    const c = parsePositiveInt(v.checkInsPerDay);
    if (c === null) {
      errors.checkInsPerDay = "Enter a whole number of check-ins.";
    } else if (c < 1 || c > 8) {
      errors.checkInsPerDay = "Check-ins per day must be between 1 and 8.";
    } else {
      checkInsPerDay = c;
    }
    const t = parsePositiveInt(v.targetCount);
    if (t === null) {
      errors.targetCount = "Enter a whole number target.";
    } else if (t < 1 || t > 1000) {
      errors.targetCount = "Target count must be between 1 and 1000.";
    } else {
      targetCount = t;
    }
  }

  // ------------------------------------------------------- counterparty --
  let counterparty = ZeroAddress;
  if (v.mode === "supervised" || v.mode === "duel") {
    const cp = v.counterparty.trim();
    if (!cp) {
      errors.counterparty =
        v.mode === "supervised" ? "A supervised session needs a supervisor address." : "A mutual bet needs an opponent address.";
    } else if (!isAddress(cp)) {
      errors.counterparty = "Enter a valid 0x address.";
    } else if (sameAddress(cp, v.self)) {
      errors.counterparty = "You cannot be your own counterparty — pick a different address.";
    } else {
      counterparty = cp;
    }
  }

  // -------------------------------------------------------------- payee --
  // R6: the verifier route is human-proof only; co-focus is forced to
  // charity (joint liability); a custom route needs a concrete address.
  let payee: Payee = Payee.Charity;
  let customPayee = ZeroAddress;
  if (v.mode === "cofocus") {
    payee = Payee.Charity;
  } else if (v.payee === "verifier") {
    if (v.mode === "supervised" || v.mode === "duel") {
      payee = Payee.Verifier;
    } else {
      errors.payee = "Only supervised or mutual-bet sessions can route a forfeit to the verifier.";
    }
  } else if (v.payee === "custom") {
    payee = Payee.Custom;
    const cp = v.customPayee.trim();
    if (!cp) {
      errors.customPayee = "A custom forfeit destination needs a concrete address.";
    } else if (!isAddress(cp)) {
      errors.customPayee = "Enter a valid 0x address.";
    } else {
      customPayee = cp;
    }
  }

  // ---------------------------------------------- co-focus consent (R6) --
  if (v.mode === "cofocus" && !v.cofocusConsent) {
    errors.cofocusConsent =
      "Co-focus is joint liability — confirm you understand both stakes go to charity if either side fails.";
  }

  if (Object.keys(errors).length > 0 || stakeWei === null) {
    return { errors, params: null };
  }

  return {
    errors,
    params: {
      mode:
        v.mode === "solo"
          ? Mode.SoloFocus
          : v.mode === "supervised"
            ? Mode.Supervised
            : v.mode === "duel"
              ? Mode.Duel
              : Mode.CoFocus,
      counterparty,
      payee,
      customPayee,
      durationMinutes,
      periodDays,
      checkInsPerDay,
      targetCount,
      criterion: v.criterion.trim(),
      stakeWei,
    },
  };
}
