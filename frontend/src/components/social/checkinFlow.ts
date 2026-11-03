/**
 * checkinFlow — the evidence upload + on-chain anchor sequence (api-contract
 * A.3, R8), framework-free so it is unit-testable with mocked deps:
 *
 *   1. SHA-256 over the photo's ORIGINAL bytes (never a re-encode)
 *   2. POST /checkins (server stores the bytes byte-identical and re-checks
 *      the hash — a mismatch is rejected with 422 hash_mismatch)
 *   3. checkIn(sessionId, evidenceHash) on-chain, waited to confirmation
 *   4. POST /checkins/:id/anchor {txHash} — the backend verifies the
 *      CheckedIn event (contract, session, hash AND periodIndex) itself
 *
 * The period index is the contract's rolling 24 h window (D10): derived from
 * chain-time fields, computed as late as possible so the anchored event and
 * the uploaded record agree.
 */

import { sha256Hex } from "../../lib/socialApi";

/** Rolling period index (D10): `floor((at - startTime) / 1 day)`, floored at 0. */
export function periodIndexAt(startTimeSec: number, atSec: number): number {
  if (atSec <= startTimeSec) return 0;
  return Math.floor((atSec - startTimeSec) / 86_400);
}

/** SHA-256 (0x-prefixed) of a Blob's exact bytes. */
export async function hashFileBytes(photo: Blob): Promise<string> {
  return sha256Hex(new Uint8Array(await photo.arrayBuffer()));
}

export type CheckinStage = "hashing" | "uploading" | "anchoring" | "reporting";

export const CHECKIN_STAGE_LABEL: Record<CheckinStage, string> = {
  hashing: "Hashing the original photo…",
  uploading: "Uploading the evidence…",
  anchoring: "Anchoring the hash on-chain — confirm the transaction…",
  reporting: "Confirming the on-chain anchor…",
};

export interface CheckinFlowDeps {
  /** Upload the original bytes; resolves with the server check-in id. */
  upload: (input: { evidenceHash: string; periodIndex: number; photo: Blob }) => Promise<string>;
  /** Send the on-chain checkIn transaction; resolves with the tx hash. */
  anchorTx: (evidenceHash: string) => Promise<string>;
  /** Wait for the anchor tx to confirm (reject on revert). */
  waitMined: (txHash: string) => Promise<void>;
  /** Report the mined tx hash to the backend for verification. */
  report: (checkinId: string, txHash: string) => Promise<void>;
  /** Current chain-time estimate in unix seconds (period index derivation). */
  nowSec: () => number;
}

export interface CheckinFlowResult {
  checkinId: string;
  txHash: string;
}

export async function runCheckinFlow(
  deps: CheckinFlowDeps,
  photo: Blob,
  startTimeSec: number,
  onStage: (stage: CheckinStage) => void,
): Promise<CheckinFlowResult> {
  onStage("hashing");
  const evidenceHash = await hashFileBytes(photo);
  const periodIndex = periodIndexAt(startTimeSec, deps.nowSec());

  onStage("uploading");
  const checkinId = await deps.upload({ evidenceHash, periodIndex, photo });

  onStage("anchoring");
  const txHash = await deps.anchorTx(evidenceHash);
  await deps.waitMined(txHash);

  onStage("reporting");
  await deps.report(checkinId, txHash);

  return { checkinId, txHash };
}

/**
 * Re-anchor an already-uploaded check-in whose anchor is still pending or
 * failed (e.g. the first tx was rejected): sends a fresh checkIn tx for the
 * SAME evidence hash and reports it. The backend re-verifies; a confirmed
 * anchor is idempotent server-side.
 */
export async function reanchorFlow(
  deps: Pick<CheckinFlowDeps, "anchorTx" | "waitMined" | "report">,
  checkinId: string,
  evidenceHash: string,
  onStage: (stage: CheckinStage) => void,
): Promise<string> {
  onStage("anchoring");
  const txHash = await deps.anchorTx(evidenceHash);
  await deps.waitMined(txHash);
  onStage("reporting");
  await deps.report(checkinId, txHash);
  return txHash;
}
