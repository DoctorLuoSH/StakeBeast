/**
 * useTx — run a contract write through the shared TxLifecycle state machine
 * that TxStatusBanner renders: pending (with hash once broadcast) → success,
 * or error with the raw error for classifyTxError to map. `label` is the
 * banner verb ("Stake", "Start", …) the caller sets per action.
 */

import { useCallback, useState } from "react";
import type { ContractTransactionReceipt, ContractTransactionResponse } from "ethers";
import type { TxLifecycle } from "./TxStatusBanner";

export function useTx() {
  const [tx, setTx] = useState<TxLifecycle>({ phase: "idle" });
  const [label, setLabel] = useState("Transaction");

  const run = useCallback(
    async (
      action: () => Promise<ContractTransactionResponse>,
      onConfirmed?: (receipt: ContractTransactionReceipt) => void,
      actionLabel?: string,
    ): Promise<ContractTransactionReceipt | null> => {
      if (actionLabel) setLabel(actionLabel);
      setTx({ phase: "pending" });
      try {
        const response = await action();
        setTx({ phase: "pending", hash: response.hash });
        const receipt = await response.wait();
        if (!receipt) throw new Error("Transaction receipt unavailable.");
        setTx({ phase: "success", hash: response.hash });
        onConfirmed?.(receipt);
        return receipt;
      } catch (error) {
        setTx({ phase: "error", error });
        return null;
      }
    },
    [],
  );

  const reset = useCallback(() => setTx({ phase: "idle" }), []);

  return { tx, run, reset, label };
}

export type UseTx = ReturnType<typeof useTx>;
