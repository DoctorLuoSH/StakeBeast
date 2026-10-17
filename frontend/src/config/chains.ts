/**
 * Network metadata for the only supported chain: Sepolia testnet.
 * Static network facts (id, name, explorer) live here; secrets and
 * deployment addresses live in `.env` (see `config/env.ts`).
 */

import { sepoliaRpcUrl } from "./env";

export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_CHAIN_ID_HEX = "0xaa36a7";
export const SEPOLIA_NAME = "Sepolia";
export const SEPOLIA_EXPLORER = "https://sepolia.etherscan.io";

/** Parameters for `wallet_addEthereumChain` when the wallet lacks Sepolia. */
export const SEPOLIA_ADD_CHAIN_PARAMS = {
  chainId: SEPOLIA_CHAIN_ID_HEX,
  chainName: "Sepolia test network",
  nativeCurrency: { name: "SepoliaETH", symbol: "SEP", decimals: 18 },
  rpcUrls: [sepoliaRpcUrl || "https://rpc.sepolia.org"],
  blockExplorerUrls: [SEPOLIA_EXPLORER],
} as const;
