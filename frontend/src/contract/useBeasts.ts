/**
 * useMyBeasts — the connected account's minted beasts (My Zoo real data).
 * Reads BeastMinted events + beastMeta through the injected NFT address;
 * the snapshot is keyed to (provider identity, account) so a late response
 * from a previous account/network can never overwrite the current view.
 */

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "../wallet/useWallet";
import { getBeastNft, isNftConfigured } from "./nft";
import type { BeastNftApi, MintedBeast } from "./nft";

interface Snapshot {
  api: BeastNftApi;
  account: string;
  beasts: MintedBeast[] | null;
  error: string | null;
}

export interface UseMyBeastsResult {
  /** null while loading or when the NFT address is not configured. */
  beasts: MintedBeast[] | null;
  loading: boolean;
  error: string | null;
  /** Set when VITE_NFT_CONTRACT_ADDRESS is missing. */
  configError: string | null;
  refresh: () => void;
}

export function useMyBeasts(): UseMyBeastsResult {
  const { provider, isExpectedChain, account } = useWallet();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [tick, setTick] = useState(0);

  const { api, configError } = useMemo(() => {
    if (!isNftConfigured()) {
      return {
        api: null,
        configError:
          "BeastNFT address not configured. Set VITE_NFT_CONTRACT_ADDRESS in .env (see .env.example).",
      };
    }
    if (!provider || !isExpectedChain) return { api: null, configError: null };
    try {
      return { api: getBeastNft(provider), configError: null };
    } catch (err) {
      return { api: null, configError: (err as Error).message };
    }
  }, [provider, isExpectedChain]);

  useEffect(() => {
    if (!api || !account) return undefined;
    let active = true;
    void (async () => {
      try {
        const beasts = await api.listMintedTo(account);
        if (active) setSnapshot({ api, account, beasts, error: null });
      } catch (err) {
        if (active) {
          setSnapshot({
            api,
            account,
            beasts: null,
            error:
              err instanceof Error
                ? err.message
                : "Could not load your beasts from the chain.",
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [api, account, tick]);

  const current =
    snapshot !== null && snapshot.api === api && snapshot.account === account ? snapshot : null;

  return {
    beasts: current?.beasts ?? null,
    loading: api !== null && current === null,
    error: current?.error ?? null,
    configError,
    refresh: () => setTick((t) => t + 1),
  };
}
