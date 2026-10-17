/**
 * Minimal EIP-1193 provider typing for injected wallets (MetaMask).
 * Avoids depending on global type packages; extend as needed.
 */

export interface Eip1193Provider {
  isMetaMask?: boolean;
  providers?: Eip1193Provider[];
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on(event: string, listener: (...args: never[]) => void): void;
  removeListener(event: string, listener: (...args: never[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

/** Locate the MetaMask provider, handling multi-wallet injection. */
export function getMetaMaskProvider(): Eip1193Provider | null {
  const { ethereum } = window;
  if (!ethereum) return null;
  if (Array.isArray(ethereum.providers) && ethereum.providers.length > 0) {
    return ethereum.providers.find((p) => p.isMetaMask) ?? null;
  }
  return ethereum.isMetaMask ? ethereum : null;
}
