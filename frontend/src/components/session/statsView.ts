/**
 * statsView — the personal record (baseline §4.7) derived purely from
 * on-chain sessions the account stakes: successes, failures, completed
 * focus/habit time, and the total forfeited stake. Kept ethers/React-free so
 * it is unit-testable in isolation.
 */

import { Status } from "../../contract/types";
import type { Session } from "../../contract/types";

export interface AccountStats {
  succeeded: number;
  failed: number;
  /** Completed focus minutes (durationMinutes sessions). */
  focusMinutes: number;
  /** Completed habit cycle days (periodDays sessions). */
  habitDays: number;
  /** Sum of the account's own stake on forfeited positions, wei. */
  forfeitedWei: bigint;
}

export const EMPTY_STATS: AccountStats = {
  succeeded: 0,
  failed: 0,
  focusMinutes: 0,
  habitDays: 0,
  forfeitedWei: 0n,
};

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Only positions the account STAKES count toward its record — supervising a
 * friend's session is not the viewer's win or loss.
 */
export function computeAccountStats(
  sessions: Session[],
  account: string,
): AccountStats {
  const stats = { ...EMPTY_STATS };
  for (const s of sessions) {
    if (!sameAddress(s.staker, account)) continue;
    if (s.status === Status.Completed) {
      stats.succeeded += 1;
      stats.focusMinutes += s.durationMinutes;
      stats.habitDays += s.periodDays;
    } else if (s.status === Status.Forfeited) {
      stats.failed += 1;
      stats.forfeitedWei += s.stake;
    }
  }
  return stats;
}

/** `130` → "2 h 10 min"; `5` → "5 min"; `0` → "0 min". */
export function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours <= 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} min`;
}
