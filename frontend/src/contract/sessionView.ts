/**
 * Pure view-model derivation from an on-chain Session: which actions are
 * available to a given viewer at a given time, terminal-state helpers, and
 * the client copy of the §4.8 tier ladder (mirrors StakeBeast.tierFor).
 * Kept free of ethers/React so it is unit-testable in isolation.
 */

import { Mode, Payee, Status, Tier } from "./types";
import type { Session } from "./types";

export function isTerminal(status: Status): boolean {
  return (
    status === Status.Completed ||
    status === Status.Forfeited ||
    status === Status.Voided ||
    status === Status.Cancelled
  );
}

/** Machine-proof modes settle via attester signature; the rest via verifier. */
export function isMachineProof(mode: Mode): boolean {
  return mode === Mode.SoloFocus || mode === Mode.CoFocus;
}

/** Client copy of the on-chain dual-track tier ladder (contract-design §7). */
export function tierForSession(s: Pick<Session, "durationMinutes" | "periodDays">): Tier {
  if (s.durationMinutes > 0) {
    if (s.durationMinutes >= 120) return Tier.Golden;
    if (s.durationMinutes >= 50) return Tier.Adult;
    if (s.durationMinutes >= 25) return Tier.Juvenile;
    return Tier.Sprout;
  }
  if (s.periodDays >= 21) return Tier.Golden;
  if (s.periodDays >= 7) return Tier.Adult;
  if (s.periodDays >= 3) return Tier.Juvenile;
  return Tier.Sprout;
}

export const TIER_LABEL: Record<Tier, string> = {
  [Tier.Sprout]: "Sprout",
  [Tier.Juvenile]: "Juvenile",
  [Tier.Adult]: "Adult",
  [Tier.Golden]: "Golden",
};

/** Actions the connected viewer can take right now. */
export interface ActionSet {
  start: boolean;
  join: boolean;
  confirmStart: boolean;
  cancel: boolean;
  settle: boolean;
  verify: boolean;
  admitDefeat: boolean;
  forfeit: boolean;
  voidSession: boolean;
}

const NONE: ActionSet = {
  start: false,
  join: false,
  confirmStart: false,
  cancel: false,
  settle: false,
  verify: false,
  admitDefeat: false,
  forfeit: false,
  voidSession: false,
};

function sameAddress(a: string, b: string | null): boolean {
  return b !== null && a.toLowerCase() === b.toLowerCase();
}

export function deriveActions(
  s: Session,
  viewer: string | null,
  isOwner: boolean,
  nowSec: number,
): ActionSet {
  if (isTerminal(s.status)) return NONE;

  const isStaker = sameAddress(s.staker, viewer);
  const isPartner = sameAddress(s.partner, viewer);
  const isParticipant = isStaker || isPartner;
  const a: ActionSet = { ...NONE };

  if (s.status === Status.Pending) {
    if (s.mode === Mode.SoloFocus) {
      a.start = isStaker && nowSec < s.startDeadline;
      a.cancel = isStaker && nowSec >= s.startDeadline;
    } else if (s.mode === Mode.Duel) {
      a.join = sameAddress(s.partner, viewer) && nowSec < s.joinDeadline;
      a.cancel = isStaker && nowSec >= s.joinDeadline;
    } else if (s.mode === Mode.CoFocus) {
      if (!s.joined) {
        // Anyone but the creator may fund the partner seat (R6).
        a.join = viewer !== null && !isStaker && nowSec < s.joinDeadline;
        a.cancel = isStaker && nowSec >= s.joinDeadline;
      } else {
        const unconfirmed =
          (isStaker && !s.startConfirmedStaker) || (isPartner && !s.startConfirmedPartner);
        a.confirmStart = unconfirmed && nowSec < s.startDeadline;
        a.cancel = isParticipant && nowSec >= s.startDeadline;
      }
    }
  } else if (s.status === Status.Active) {
    const inSettlement = nowSec >= s.endTime && nowSec < s.settlementDeadline;
    const beforeDeadline = nowSec < s.settlementDeadline;
    a.settle = isMachineProof(s.mode) && isParticipant && inSettlement;
    a.verify =
      !isMachineProof(s.mode) && sameAddress(s.verifier, viewer) && beforeDeadline;
    a.admitDefeat = (s.mode === Mode.CoFocus ? isParticipant : isStaker) && beforeDeadline;
    a.forfeit = nowSec >= s.settlementDeadline; // permissionless
  }

  a.voidSession = isOwner;
  return a;
}

/** Human-readable description of where a forfeited stake went. */
export function forfeitDestinationLabel(s: Session, reason: number | null): string {
  if (s.mode === Mode.CoFocus || reason === 2) {
    return "both stakes went to charity under joint liability";
  }
  if (reason === 1) {
    return "the stake went to charity (settlement deadline passed)";
  }
  switch (s.payee) {
    case Payee.Charity:
      return "the stake went to charity (admitted defeat)";
    case Payee.Verifier:
      return "the stake went to the verifier (admitted defeat)";
    default:
      return "the stake went to the custom payee (admitted defeat)";
  }
}

/** Short label of the session's task for list/detail headers. */
export function taskLabel(s: Session): string {
  if (s.durationMinutes > 0) return `${s.durationMinutes} min focus`;
  if (s.periodDays > 0) return `${s.periodDays} day habit`;
  return "session";
}
