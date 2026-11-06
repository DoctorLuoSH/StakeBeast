/**
 * BeastNFT read client (baseline §4.8 / D8): the My Zoo shelf's real data
 * source. Beasts are discovered from the BeastMinted events addressed to the
 * account (the soulbound token has no transfer path, so the mint recipient
 * set IS the owned set), then each token's on-chain `beastMeta` supplies the
 * kind / metric / tier / completion date / session id the shelf renders.
 * The address is injected via VITE_NFT_CONTRACT_ADDRESS — never defaulted.
 */

import { Contract, Interface } from "ethers";
import type { BrowserProvider } from "ethers";
import { nftContractAddress } from "../config/env";
import { queryFilterChunked } from "./logQuery";
import { Kind, Tier } from "./types";
import type { BeastStage, BeastTier } from "../components/beast/BeastSprite";
import type { BeastEntry } from "../components/beast/zooView";

/** Frozen BeastNFT surface used by the frontend (contracts/BeastNFT.sol). */
export const BEAST_NFT_ABI = [
  "function beastMeta(uint256 tokenId) view returns (tuple(uint8 kind, uint256 metricValue, uint8 tier, uint64 completionDate, uint256 sessionId))",
  "event BeastMinted(uint256 indexed tokenId, address indexed to, uint256 indexed sessionId, uint8 kind, uint256 metricValue, uint8 tier)",
] as const;

/** One minted beast with its on-chain metadata. */
export interface MintedBeast {
  tokenId: bigint;
  sessionId: bigint;
  kind: Kind;
  /** Declared minutes (focus) or cycle days (habit). */
  metricValue: bigint;
  tier: Tier;
  /** Unix seconds. */
  completionDate: number;
}

export function isNftConfigured(): boolean {
  return nftContractAddress.length > 0;
}

export interface BeastNftApi {
  address: string;
  /** Every beast minted to `account`, in mint order. */
  listMintedTo(account: string): Promise<MintedBeast[]>;
}

export function getBeastNft(provider: BrowserProvider): BeastNftApi {
  if (!isNftConfigured()) {
    throw new Error(
      "BeastNFT address is not configured. Set VITE_NFT_CONTRACT_ADDRESS in .env (see .env.example).",
    );
  }
  const contract = new Contract(nftContractAddress, BEAST_NFT_ABI, provider);
  const iface = new Interface(BEAST_NFT_ABI);

  return {
    address: nftContractAddress,

    async listMintedTo(account) {
      const logs = await queryFilterChunked(
        provider,
        contract,
        contract.filters.BeastMinted(null, account, null),
      );
      const beasts: MintedBeast[] = [];
      for (const log of logs) {
        const decoded = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (!decoded) continue;
        const tokenId = decoded.args.tokenId as bigint;
        const meta = await contract.beastMeta(tokenId);
        beasts.push({
          tokenId,
          sessionId: meta.sessionId as bigint,
          kind: Number(meta.kind) as Kind,
          metricValue: meta.metricValue as bigint,
          tier: Number(meta.tier) as Tier,
          completionDate: Number(meta.completionDate),
        });
      }
      return beasts;
    },
  };
}

/* ---------------------------------------------------------- view mapping -- */

const TIER_TO_STAGE: Record<Tier, BeastStage> = {
  [Tier.Sprout]: "sprout",
  [Tier.Juvenile]: "young",
  [Tier.Adult]: "adult",
  [Tier.Golden]: "golden",
};

const TIER_TO_BADGE: Record<Tier, BeastTier> = {
  [Tier.Sprout]: "seedling",
  [Tier.Juvenile]: "young",
  [Tier.Adult]: "adult",
  [Tier.Golden]: "golden",
};

/** Map one on-chain mint to the shelf entry ZooShelf/BeastCard renders. */
export function beastToEntry(beast: MintedBeast): BeastEntry {
  return {
    id: beast.tokenId.toString(),
    stage: TIER_TO_STAGE[beast.tier],
    tier: TIER_TO_BADGE[beast.tier],
    metric:
      beast.kind === Kind.Focus
        ? `${beast.metricValue.toString()} min focus`
        : `${beast.metricValue.toString()}-day habit`,
    date: new Date(beast.completionDate * 1000).toISOString().slice(0, 10),
    sessionId: beast.sessionId.toString(),
  };
}
