import { createContext } from "react";
import type { BrowserProvider } from "ethers";

export type WalletStatus =
  | "no-provider" // MetaMask (or compatible wallet) not installed
  | "disconnected"
  | "connecting"
  | "connected";

export interface WalletContextValue {
  status: WalletStatus;
  /** Checksummed account address, or null when not connected. */
  account: string | null;
  /** Decimal chain id of the currently selected network. */
  chainId: number | null;
  /** True when connected to Sepolia — the only supported network. */
  isSepolia: boolean;
  /** Ethers v6 provider bound to the injected wallet (null without MetaMask). */
  provider: BrowserProvider | null;
  /** Last wallet-layer error message (connect / switch failures). */
  error: string | null;
  /** Request accounts, then auto-switch to Sepolia when on a wrong network. */
  connect: () => Promise<void>;
  /** Switch (or add then switch) the wallet network to Sepolia. */
  switchToSepolia: () => Promise<void>;
  /** Forget the local session. MetaMask keeps its own permission. */
  disconnect: () => void;
}

export const WalletContext = createContext<WalletContextValue | null>(null);
