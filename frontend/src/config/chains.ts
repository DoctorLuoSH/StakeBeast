/**
 * Network metadata. Sepolia testnet is the production target and the default;
 * a local Hardhat node (chain 31337) is supported for development via the
 * VITE_CHAIN_ID override. Static network facts (id, name, explorer) live
 * here; secrets and deployment addresses live in `.env` (see `config/env.ts`).
 */

import { chainIdOverride, sepoliaRpcUrl } from "./env";

export interface ChainConfig {
  /** Decimal chain id. */
  chainId: number;
  /** Hex chain id as used by wallet_switchEthereumChain. */
  chainIdHex: string;
  /** Display name. */
  name: string;
  /** Block explorer base URL; empty when the chain has none (local dev). */
  explorer: string;
  /** Parameters for `wallet_addEthereumChain` when the wallet lacks the chain. */
  addChainParams: {
    chainId: string;
    chainName: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
    rpcUrls: readonly string[];
    blockExplorerUrls: readonly string[];
  };
}

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

export const SEPOLIA_CHAIN: ChainConfig = {
  chainId: SEPOLIA_CHAIN_ID,
  chainIdHex: SEPOLIA_CHAIN_ID_HEX,
  name: SEPOLIA_NAME,
  explorer: SEPOLIA_EXPLORER,
  addChainParams: SEPOLIA_ADD_CHAIN_PARAMS,
};

export const HARDHAT_CHAIN_ID = 31337;

export const HARDHAT_CHAIN: ChainConfig = {
  chainId: HARDHAT_CHAIN_ID,
  chainIdHex: "0x7a69",
  name: "Local Hardhat",
  explorer: "",
  addChainParams: {
    chainId: "0x7a69",
    chainName: "Local Hardhat",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["http://127.0.0.1:8545"],
    blockExplorerUrls: [],
  },
};

/**
 * The network the app expects the wallet to be on. Defaults to Sepolia;
 * VITE_CHAIN_ID=31337 selects a local Hardhat node for development.
 */
export const EXPECTED_CHAIN: ChainConfig =
  Number(chainIdOverride) === HARDHAT_CHAIN_ID ? HARDHAT_CHAIN : SEPOLIA_CHAIN;

export const EXPECTED_CHAIN_ID = EXPECTED_CHAIN.chainId;
