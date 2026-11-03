/**
 * tokenStore — per-identity persistence of social login JWTs. Login state is
 * per-address (api-contract A.1): the token is keyed by (chainId, address)
 * so switching the wallet account can never authenticate as the previous
 * one; a stored token is re-validated against the backend on restore and
 * dropped on any 401.
 */

const PREFIX = "stakebeast.social";

function key(chainId: number, address: string): string {
  return `${PREFIX}.${chainId}.${address.toLowerCase()}`;
}

function store(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadToken(chainId: number, address: string): string | null {
  return store()?.getItem(key(chainId, address)) ?? null;
}

export function saveToken(chainId: number, address: string, token: string): void {
  try {
    store()?.setItem(key(chainId, address), token);
  } catch {
    // Storage full / blocked — the session simply lives in memory only.
  }
}

export function dropToken(chainId: number, address: string): void {
  try {
    store()?.removeItem(key(chainId, address));
  } catch {
    // ignore
  }
}
