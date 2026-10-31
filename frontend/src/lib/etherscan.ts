/**
 * Explorer link builders for the expected chain. Pure functions, no wallet
 * state. Local dev chains have no explorer — builders return "" and callers
 * hide the link.
 */

import { EXPECTED_CHAIN } from "../config/chains";

export function txExplorerUrl(hash: string): string {
  return EXPECTED_CHAIN.explorer ? `${EXPECTED_CHAIN.explorer}/tx/${hash}` : "";
}

export function addressExplorerUrl(address: string): string {
  return EXPECTED_CHAIN.explorer ? `${EXPECTED_CHAIN.explorer}/address/${address}` : "";
}
