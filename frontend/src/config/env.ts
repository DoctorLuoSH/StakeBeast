/**
 * Typed access to build-time environment configuration.
 *
 * Zero-hardcode rule: all deployment-specific values (contract addresses,
 * service URLs) are injected via `.env` files using Vite's `VITE_` prefix —
 * never commit real addresses to the repository. See `.env.example`.
 */

function readEnv(key: string): string {
  const value = import.meta.env[key];
  return typeof value === "string" ? value.trim() : "";
}

export function readRequiredEnv(key: string): string {
  const value = readEnv(key);
  if (!value) {
    throw new Error(
      `Missing environment variable ${key}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

/** StakeBeast main session contract address (Sepolia). Empty until deployment. */
export const contractAddress = readEnv("VITE_CONTRACT_ADDRESS");

/** BeastNFT contract address (Sepolia). Empty until deployment. */
export const nftContractAddress = readEnv("VITE_NFT_CONTRACT_ADDRESS");

/** Proof service base URL (machine-attested focus sessions). */
export const proofServiceUrl = readEnv("VITE_PROOF_SERVICE_URL");

/** Social backend base URL (P1). */
export const apiBaseUrl = readEnv("VITE_API_BASE_URL");

/** Optional Sepolia RPC endpoint override (fallbacks to wallet provider). */
export const sepoliaRpcUrl = readEnv("VITE_SEPOLIA_RPC_URL");

/**
 * Optional chain id override for the expected network. Leave empty for
 * Sepolia (default); set to 31337 for a local Hardhat node (see README).
 */
export const chainIdOverride = readEnv("VITE_CHAIN_ID");
