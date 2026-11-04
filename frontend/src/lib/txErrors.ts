/**
 * Classify transaction / wallet errors into user-facing categories.
 * Ethers v6 exposes stable `error.code` values; MetaMask also returns
 * numeric JSON-RPC codes (4001 = user rejected). Known StakeBeast contract
 * reverts decode to rule-level explanations (see contract/errors.ts).
 */

import { describeContractError } from "../contract/errors";

export type TxErrorKind = "rejected" | "insufficient-funds" | "reverted" | "network" | "unknown";

export interface ClassifiedTxError {
  kind: TxErrorKind;
  title: string;
  detail: string;
}

interface CodedError {
  code?: string | number;
  message?: string;
  reason?: string;
  shortMessage?: string;
  info?: { error?: { code?: number; message?: string } };
}

export function classifyTxError(error: unknown): ClassifiedTxError {
  const e = (error ?? {}) as CodedError;
  const code = e.code ?? e.info?.error?.code;
  const message =
    e.reason ?? e.shortMessage ?? e.message ?? e.info?.error?.message ?? String(error);

  if (code === "ACTION_REJECTED" || code === 4001) {
    return {
      kind: "rejected",
      title: "Transaction rejected",
      detail: "You rejected the request in MetaMask. No transaction was sent.",
    };
  }
  if (code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(message)) {
    return {
      kind: "insufficient-funds",
      title: "Insufficient balance",
      detail: "Your wallet does not have enough ETH to cover the stake and gas.",
    };
  }
  const revertDetail = describeContractError(error);
  if (revertDetail) {
    return {
      kind: "reverted",
      title: "Contract rejected the transaction",
      detail: revertDetail,
    };
  }
  if (code === "NETWORK_ERROR" || code === "TIMEOUT") {
    return {
      kind: "network",
      title: "Network unreachable",
      detail: "Could not reach the network. Check your connection and try again.",
    };
  }
  return { kind: "unknown", title: "Transaction failed", detail: message };
}
