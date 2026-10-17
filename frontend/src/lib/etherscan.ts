/**
 * Explorer link builders for Sepolia. Pure functions, no wallet state.
 */

import { SEPOLIA_EXPLORER } from "../config/chains";

export function txExplorerUrl(hash: string): string {
  return `${SEPOLIA_EXPLORER}/tx/${hash}`;
}

export function addressExplorerUrl(address: string): string {
  return `${SEPOLIA_EXPLORER}/address/${address}`;
}
