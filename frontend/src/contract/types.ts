/**
 * Domain types mirroring the StakeBeast contract enums and Session struct
 * (contract-design v4.1). Numeric enums keep the on-chain values so they can
 * be passed to / read from the contract without translation.
 */

/** Session modes (baseline §4.1–4.4). */
export const Mode = {
  SoloFocus: 0,
  Supervised: 1,
  Duel: 2,
  CoFocus: 3,
} as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

/** Unified session status (baseline §11). */
export const Status = {
  Pending: 0,
  Active: 1,
  Completed: 2,
  Forfeited: 3,
  Voided: 4,
  Cancelled: 5,
} as const;
export type Status = (typeof Status)[keyof typeof Status];

/** Preset admitDefeat payout route. */
export const Payee = {
  Charity: 0,
  Verifier: 1,
  Custom: 2,
} as const;
export type Payee = (typeof Payee)[keyof typeof Payee];

/** NFT metadata kind (focus minutes / habit days). */
export const Kind = { Focus: 0, Habit: 1 } as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

/** Tier ladder per baseline §4.8. */
export const Tier = { Sprout: 0, Juvenile: 1, Adult: 2, Golden: 3 } as const;
export type Tier = (typeof Tier)[keyof typeof Tier];

export const MODE_LABEL: Record<Mode, string> = {
  [Mode.SoloFocus]: "Solo Focus",
  [Mode.Supervised]: "Supervised Habit",
  [Mode.Duel]: "Mutual Bet",
  [Mode.CoFocus]: "Co-Focus Duo",
};

export const STATUS_LABEL: Record<Status, string> = {
  [Status.Pending]: "Pending",
  [Status.Active]: "Active",
  [Status.Completed]: "Completed",
  [Status.Forfeited]: "Forfeited",
  [Status.Voided]: "Voided",
  [Status.Cancelled]: "Cancelled",
};

/** Typed view of the on-chain Session struct (seconds for time fields). */
export interface Session {
  mode: Mode;
  status: Status;
  staker: string;
  partner: string;
  verifier: string;
  payee: Payee;
  customPayee: string;
  stake: bigint;
  durationMinutes: number;
  periodDays: number;
  checkInsPerDay: number;
  targetCount: number;
  criterion: string;
  linkedSessionId: bigint;
  createdAt: number;
  joinDeadline: number;
  startDeadline: number;
  startTime: number;
  endTime: number;
  settlementDeadline: number;
  joined: boolean;
  startConfirmedStaker: boolean;
  startConfirmedPartner: boolean;
  minted: boolean;
}

/** Raw tuple as decoded by ethers (positional + named access). */
type RawSession = {
  mode: bigint;
  status: bigint;
  staker: string;
  partner: string;
  verifier: string;
  payee: bigint;
  customPayee: string;
  stake: bigint;
  durationMinutes: bigint;
  periodDays: bigint;
  checkInsPerDay: bigint;
  targetCount: bigint;
  criterion: string;
  linkedSessionId: bigint;
  createdAt: bigint;
  joinDeadline: bigint;
  startDeadline: bigint;
  startTime: bigint;
  endTime: bigint;
  settlementDeadline: bigint;
  joined: boolean;
  startConfirmedStaker: boolean;
  startConfirmedPartner: boolean;
  minted: boolean;
};

export function parseSession(raw: RawSession): Session {
  return {
    mode: Number(raw.mode) as Mode,
    status: Number(raw.status) as Status,
    staker: raw.staker,
    partner: raw.partner,
    verifier: raw.verifier,
    payee: Number(raw.payee) as Payee,
    customPayee: raw.customPayee,
    stake: raw.stake,
    durationMinutes: Number(raw.durationMinutes),
    periodDays: Number(raw.periodDays),
    checkInsPerDay: Number(raw.checkInsPerDay),
    targetCount: Number(raw.targetCount),
    criterion: raw.criterion,
    linkedSessionId: raw.linkedSessionId,
    createdAt: Number(raw.createdAt),
    joinDeadline: Number(raw.joinDeadline),
    startDeadline: Number(raw.startDeadline),
    startTime: Number(raw.startTime),
    endTime: Number(raw.endTime),
    settlementDeadline: Number(raw.settlementDeadline),
    joined: raw.joined,
    startConfirmedStaker: raw.startConfirmedStaker,
    startConfirmedPartner: raw.startConfirmedPartner,
    minted: raw.minted,
  };
}
