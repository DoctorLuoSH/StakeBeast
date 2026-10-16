/**
 * Classify transaction / wallet errors into user-facing categories.
 * Ethers v6 exposes stable `error.code` values; MetaMask also returns
 * numeric JSON-RPC codes (4001 = user rejected).
 */

export type TxErrorKind = "rejected" | "insufficient-funds" | "network" | "unknown";

export interface ClassifiedTxError {
  kind: TxErrorKind;
  title: string;
  detail: string;
}

interface CodedError {
  code?: string | number;
  message?: string;
  reason?: string;
  info?: { error?: { code?: number; message?: string } };
}

export function classifyTxError(error: unknown): ClassifiedTxError {
  const e = (error ?? {}) as CodedError;
  const code = e.code ?? e.info?.error?.code;
  const message = e.reason ?? e.message ?? e.info?.error?.message ?? String(error);

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
      detail: "Your wallet does not have enough Sepolia ETH to cover the stake and gas.",
    };
  }
  if (code === "NETWORK_ERROR" || code === "TIMEOUT") {
    return {
      kind: "network",
      title: "Network unreachable",
      detail: "Could not reach the Sepolia network. Check your connection and try again.",
    };
  }
  return { kind: "unknown", title: "Transaction failed", detail: message };
}
