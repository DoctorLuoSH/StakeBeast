import { useContext } from "react";
import { WalletContext } from "./walletContext";
import type { WalletContextValue } from "./walletContext";

/** Access the shared wallet state. Must be used under <WalletProvider>. */
export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used within <WalletProvider>");
  }
  return ctx;
}
