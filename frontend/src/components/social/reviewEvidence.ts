/**
 * reviewEvidence — the R8 verification verdict for one check-in, kept pure
 * (api-contract A.3 "Frontend verification flow"): the reviewer recomputes
 * SHA-256 over the ORIGINAL downloaded bytes and only sees "anchored &
 * matching" when that recomputation equals BOTH the record's evidenceHash
 * AND an on-chain CheckedIn event from the expected contract with a matching
 * periodIndex — and the backend's anchor status is confirmed. Comparing two
 * stored hash fields alone is never presented as proof.
 */

import type { CheckedInRecord } from "../../contract/client";
import type { CheckinRecord } from "../../lib/socialApi";

export type EvidenceVerdict =
  | "anchored-matching" // recomputed == record == on-chain event, status confirmed
  | "photo-mismatch" // recomputed != record hash — the served bytes were replaced
  | "anchor-failed" // backend marked the anchor tx failed (reverted / mismatch)
  | "anchor-pending" // tx reported, not yet verifiable on-chain
  | "no-onchain-anchor"; // no matching CheckedIn event exists on-chain

export interface EvidenceCheck {
  verdict: EvidenceVerdict;
  /** The recomputed hash of the downloaded original bytes. */
  recomputedHash: string;
  /** The matching on-chain anchor, when one exists. */
  onchain: CheckedInRecord | null;
}

export function verdictFor(
  recomputedHash: string,
  record: CheckinRecord,
  onchainLogs: CheckedInRecord[],
): EvidenceCheck {
  const recomputed = recomputedHash.toLowerCase();
  const recorded = record.evidenceHash.toLowerCase();
  if (recomputed !== recorded) {
    return { verdict: "photo-mismatch", recomputedHash: recomputed, onchain: null };
  }
  const onchain =
    onchainLogs.find(
      (log) => log.evidenceHash.toLowerCase() === recorded && log.periodIndex === record.periodIndex,
    ) ?? null;
  if (!onchain) {
    return {
      verdict: record.onchain.status === "failed" ? "anchor-failed" : "no-onchain-anchor",
      recomputedHash: recomputed,
      onchain: null,
    };
  }
  if (record.onchain.status === "confirmed") {
    return { verdict: "anchored-matching", recomputedHash: recomputed, onchain };
  }
  if (record.onchain.status === "failed") {
    return { verdict: "anchor-failed", recomputedHash: recomputed, onchain };
  }
  return { verdict: "anchor-pending", recomputedHash: recomputed, onchain };
}

export const VERDICT_LABEL: Record<EvidenceVerdict, string> = {
  "anchored-matching": "Anchored & matching — the photo bytes hash to the on-chain anchor.",
  "photo-mismatch": "WARNING: the served photo bytes do not hash to the recorded evidence hash — the file may have been replaced.",
  "anchor-failed": "The anchoring transaction failed verification (reverted or mismatched event).",
  "anchor-pending": "Anchor transaction reported, waiting for on-chain confirmation.",
  "no-onchain-anchor": "No matching on-chain CheckedIn event found for this hash and period.",
};
