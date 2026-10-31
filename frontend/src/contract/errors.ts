/**
 * Contract revert decoding → human-readable messages.
 *
 * Every StakeBeast custom error maps to a short explanation matching the
 * frozen rules (R6 combination validation, unified status table §11), so a
 * failed transaction tells the user which rule stopped it instead of showing
 * raw revert data.
 */

import { formatEther } from "ethers";
import { stakeBeastInterface } from "./client";

export interface DecodedRevert {
  /** Custom error name, e.g. "DurationOutOfRange". */
  name: string;
  /** Decoded positional arguments. */
  args: readonly unknown[];
}

/**
 * Pull revert data out of the various shapes ethers v6 / MetaMask produce:
 * `error.data`, `error.info.error.data` (string or {data}), nested payloads.
 */
export function extractRevertData(error: unknown): string | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === null || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    const rec = cur as Record<string, unknown>;
    for (const key of ["data", "result"]) {
      const v = rec[key];
      if (typeof v === "string" && v.startsWith("0x") && v.length >= 10) return v;
    }
    for (const key of ["info", "error", "cause", "payload"]) {
      if (rec[key] && typeof rec[key] === "object") queue.push(rec[key]);
    }
  }
  return null;
}

/** Decode a thrown error into a known contract custom error, if any. */
export function decodeContractError(error: unknown): DecodedRevert | null {
  const data = extractRevertData(error);
  if (!data) return null;
  try {
    const parsed = stakeBeastInterface.parseError(data);
    if (!parsed) return null;
    return { name: parsed.name, args: parsed.args };
  } catch {
    return null;
  }
}

/** Human-readable explanation for a decoded contract error; null if unknown. */
export function humanizeContractError(name: string, args: readonly unknown[]): string | null {
  switch (name) {
    case "ZeroStake":
      return "A stake is required — send ETH with the transaction.";
    case "StakeAboveCap":
      return `The stake exceeds the ${formatEther(args[0] as bigint)} ETH cap.`;
    case "DurationOutOfRange":
      return "Focus duration must be between 1 and 1440 minutes.";
    case "PeriodOutOfRange":
      return "Habit period must be between 1 and 365 days.";
    case "CheckInsPerDayOutOfRange":
      return "Check-ins per day must be between 1 and 8.";
    case "TargetCountOutOfRange":
      return "Target count must be between 1 and 1000.";
    case "DuelTaskParamMismatch":
      return "A mutual bet needs exactly one task style: a focus duration or a habit period, not both.";
    case "IncompatibleTaskParams":
      return "A parameter from the wrong task style was set — focus modes take a duration only, supervised habits a period only.";
    case "SelfCounterparty":
      return "You cannot be your own counterparty — pick a different address.";
    case "VerifierRequired":
      return "A supervised session needs a supervisor address.";
    case "PayeeVerifierNotAllowed":
      return "Only supervised or mutual-bet sessions can route a forfeit to the verifier.";
    case "CustomPayeeZero":
      return "A custom forfeit destination needs a concrete address.";
    case "CoFocusPayeeNotCharity":
      return "Co-focus is joint liability: forfeits always go to charity.";
    case "ZeroCharity":
    case "ZeroAttester":
      return "The contract deployment is misconfigured (zero address role).";
    case "UnknownSession":
      return "This session does not exist on-chain.";
    case "WrongStatus":
      return "The session is no longer in the state this action needs — refresh and try again.";
    case "WrongMode":
      return "This action does not apply to the session's mode.";
    case "NotStaker":
      return "Only the session creator can do this.";
    case "NotParticipant":
      return "Only the session participants can do this.";
    case "NotVerifier":
      return "Only the session's verifier can confirm completion.";
    case "NotOpponent":
      return "Only the designated opponent can join this mutual bet.";
    case "SelfJoinNotAllowed":
      return "You cannot join your own co-focus session — share the link with a partner.";
    case "AlreadyJoined":
      return "The counterparty has already joined this session.";
    case "NotJoinedYet":
      return "The partner has not joined yet — the start handshake opens once they fund.";
    case "AlreadyConfirmed":
      return "You have already confirmed the start.";
    case "StakeMismatch":
      return `The stake must match exactly ${formatEther(args[0] as bigint)} ETH.`;
    case "JoinDeadlinePassed":
      return "The join window has passed — this session can only be cancelled for a refund.";
    case "StartDeadlinePassed":
      return "The start window has passed — this session can only be cancelled for a refund.";
    case "JoinWindowOpen":
      return "The join window is still open — cancellation unlocks when it closes.";
    case "StartWindowOpen":
      return "The start window is still open — cancellation unlocks when it closes.";
    case "OutsideSettlementWindow":
      return "This action is outside the session's settlement window.";
    case "NotYetForfeitable":
      return "The settlement deadline has not passed yet — forfeiture unlocks after it.";
    case "OutsideTaskWindow":
      return "Check-ins are only accepted during the task window.";
    case "InvalidAttestation":
      return "The attestation signature is not valid for this session.";
    case "NothingToWithdraw":
      return "Nothing to withdraw — you have no claimable balance.";
    case "WithdrawTransferFailed":
      return "The transfer failed — your balance stays credited, so you can safely retry.";
    default:
      return null;
  }
}

/** One-call helper: thrown error → human message, or null when not a known revert. */
export function describeContractError(error: unknown): string | null {
  const decoded = decodeContractError(error);
  if (!decoded) return null;
  return humanizeContractError(decoded.name, decoded.args) ?? `Contract reverted with ${decoded.name}.`;
}
