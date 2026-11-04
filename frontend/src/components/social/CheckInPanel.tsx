/**
 * CheckInPanel — habit evidence for an Active human-proof session (baseline
 * §4.5, api-contract A.3): the staker uploads a photo whose ORIGINAL bytes
 * are SHA-256 hashed, stored byte-identical by the backend, and anchored
 * on-chain via `checkIn`; each record shows its anchor status (pending /
 * confirmed / failed). The verifier's on-chain `verify` stays the sole
 * completion basis (D4) — check-ins are evidence, never proof.
 *
 * Requires social sign-in (the backend authenticates the staker); without a
 * configured backend the P0 fallback applies (off-chain evidence → the
 * verifier confirms directly).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther } from "ethers";
import { useWallet } from "../../wallet/useWallet";
import { useStakeBeast } from "../../contract/useStakeBeast";
import { describeContractError } from "../../contract/errors";
import type { Session } from "../../contract/types";
import { useSocialAuth } from "../../social/useSocialAuth";
import { SocialSignInCard } from "./SocialSignInCard";
import {
  listCheckins,
  reportAnchor,
  uploadCheckin,
  SocialApiError,
} from "../../lib/socialApi";
import type { CheckinRecord } from "../../lib/socialApi";
import { useAuthedImage } from "../../lib/useAuthedImage";
import { shortAddress } from "../../lib/format";
import {
  CHECKIN_STAGE_LABEL,
  reanchorFlow,
  runCheckinFlow,
} from "./checkinFlow";
import type { CheckinStage } from "./checkinFlow";

const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

interface Props {
  session: Session;
  sessionId: bigint;
}

export function CheckInPanel({ session, sessionId }: Props) {
  const social = useSocialAuth();
  const { api } = useStakeBeast();
  const { provider } = useWallet();
  const [snap, setSnap] = useState<{
    token: string;
    rows: CheckinRecord[] | null;
    error: string | null;
  } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [stage, setStage] = useState<CheckinStage | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reanchoringId, setReanchoringId] = useState<string | null>(null);
  const seqRef = useRef(0);

  const sid = sessionId.toString();
  const busy = stage !== null || reanchoringId !== null;

  const token = social.token;
  const noteApiError = social.noteApiError;
  const reload = useCallback(() => {
    if (!token) return;
    const seq = ++seqRef.current;
    listCheckins(token, sid).then(
      (list) => {
        if (seqRef.current === seq) setSnap({ token, rows: list, error: null });
      },
      (err: unknown) => {
        if (seqRef.current !== seq) return;
        if (noteApiError(err)) return;
        setSnap({
          token,
          rows: null,
          error: err instanceof Error ? err.message : "Could not load the check-ins.",
        });
      },
    );
  }, [token, noteApiError, sid]);

  useEffect(() => {
    if (token) reload();
  }, [token, reload]);

  // The snapshot only applies to the token that fetched it — signing out or
  // switching accounts reads as a fresh load, never the previous list.
  const current = snap !== null && token !== null && snap.token === token ? snap : null;
  const rows = current?.rows ?? null;
  const listError = current?.error ?? null;

  if (!social.configured) {
    return (
      <section className="card">
        <h2>Check-ins</h2>
        <p className="muted">
          Social backend not configured — photo evidence is off-chain only
          (P0 fallback: the supervisor confirms directly from their own
          knowledge).
        </p>
      </section>
    );
  }

  if (social.status !== "signed-in" || !token || !api) {
    return <SocialSignInCard />;
  }

  const onPickFile = (picked: File | null) => {
    setFileError(null);
    if (!picked) {
      setFile(null);
      return;
    }
    if (!PHOTO_TYPES.includes(picked.type)) {
      setFile(null);
      setFileError("Photo must be a jpg, png, or webp image.");
      return;
    }
    if (picked.size > PHOTO_MAX_BYTES) {
      setFile(null);
      setFileError("Photo must be 5 MB or smaller.");
      return;
    }
    setFile(picked);
  };

  const anchorDeps = {
    anchorTx: async (evidenceHash: string) => {
      const resp = await api.checkIn(sessionId, evidenceHash);
      return resp.hash;
    },
    waitMined: async (txHash: string) => {
      if (!provider) throw new Error("Wallet unavailable — cannot confirm the transaction.");
      const receipt = await provider.waitForTransaction(txHash, 1, 120_000);
      if (!receipt || receipt.status === 0) {
        throw new Error("The anchoring transaction reverted on-chain.");
      }
    },
    report: async (checkinId: string, txHash: string) => {
      await reportAnchor(token, checkinId, txHash);
    },
  };

  const submit = async () => {
    if (!file || !api) return;
    setActionError(null);
    try {
      await runCheckinFlow(
        {
          ...anchorDeps,
          upload: async ({ evidenceHash, periodIndex, photo }) => {
            const res = await uploadCheckin(token, {
              sessionId: sid,
              evidenceHash,
              periodIndex,
              photo,
            });
            return res.checkinId;
          },
          nowSec: () => Math.floor(Date.now() / 1000),
        },
        file,
        session.startTime,
        setStage,
      );
      setFile(null);
      setStage(null);
      reload();
    } catch (err) {
      setStage(null);
      setActionError(describeFlowError(err));
    }
  };

  const reanchor = async (row: CheckinRecord) => {
    setActionError(null);
    setReanchoringId(row.checkinId);
    try {
      await reanchorFlow(anchorDeps, row.checkinId, row.evidenceHash, setStage);
      setStage(null);
      setReanchoringId(null);
      reload();
    } catch (err) {
      setStage(null);
      setReanchoringId(null);
      setActionError(describeFlowError(err));
    }
  };

  return (
    <section className="card checkins">
      <h2>Check-ins</h2>
      <p className="muted">
        Each photo's SHA-256 is anchored on-chain — the supervisor verifies
        the served bytes against that anchor. Photos are evidence for the
        verifier, not the completion basis. Stake at risk:{" "}
        {formatEther(session.stake)} ETH.
      </p>

      <div className="checkins__upload">
        <label className="button button--ghost">
          {file ? file.name : "Choose a photo (jpg / png / webp, ≤ 5 MB)"}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            disabled={busy}
            onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <button
          type="button"
          className="button"
          disabled={!file || busy}
          onClick={() => void submit()}
        >
          {stage ? CHECKIN_STAGE_LABEL[stage] : "Upload & anchor on-chain"}
        </button>
      </div>
      {fileError ? (
        <p className="field__error" role="alert">
          {fileError}
        </p>
      ) : null}
      {actionError ? (
        <p className="field__error" role="alert">
          {actionError}
        </p>
      ) : null}

      {listError ? (
        <p className="field__error" role="alert">
          {listError}{" "}
          <button type="button" className="button button--ghost" onClick={reload}>
            Retry
          </button>
        </p>
      ) : null}
      {rows === null && !listError ? <p className="muted">Loading check-ins…</p> : null}
      {rows !== null && rows.length === 0 ? (
        <p className="muted">No check-ins yet — upload the first one above.</p>
      ) : null}
      {rows?.map((row) => (
        <CheckinRow
          key={row.checkinId}
          row={row}
          token={token}
          busy={busy}
          reanchoring={reanchoringId === row.checkinId}
          stage={reanchoringId === row.checkinId ? stage : null}
          onReanchor={() => void reanchor(row)}
        />
      ))}
    </section>
  );
}

function describeFlowError(err: unknown): string {
  if (err instanceof SocialApiError) {
    return `Backend rejected the evidence: ${err.message}`;
  }
  return describeContractError(err) ?? (err instanceof Error ? err.message : "Check-in failed — retry.");
}

function CheckinRow({
  row,
  token,
  busy,
  reanchoring,
  stage,
  onReanchor,
}: {
  row: CheckinRecord;
  token: string;
  busy: boolean;
  reanchoring: boolean;
  stage: CheckinStage | null;
  onReanchor: () => void;
}) {
  const thumb = useAuthedImage(token, row.thumbUrl);
  const badge =
    row.onchain.status === "confirmed"
      ? { cls: "checkins__badge--ok", text: "anchored ✓" }
      : row.onchain.status === "failed"
        ? { cls: "checkins__badge--bad", text: "anchor failed" }
        : { cls: "checkins__badge--pending", text: "anchor pending" };
  // DAPP-55 F1: a period_mismatch failure is a dead end — the period rolled
  // over after upload, so no re-anchor tx can ever match the record's
  // immutable periodIndex. Hide the button and steer to a fresh upload.
  const periodMismatch =
    row.onchain.status === "failed" && row.onchain.failReason === "period_mismatch";

  return (
    <div className="checkins__row">
      {thumb.src ? (
        <img className="checkins__thumb" src={thumb.src} alt={`Check-in period ${row.periodIndex}`} />
      ) : (
        <span className="checkins__thumb checkins__thumb--loading" aria-hidden="true" />
      )}
      <div className="checkins__meta">
        <span className="mono">{shortAddress(row.evidenceHash, 10, 8)}</span>
        <span className="muted">
          period {row.periodIndex} · {row.createdAt.slice(0, 16).replace("T", " ")}Z
        </span>
        {row.onchain.txHash ? (
          <span className="muted mono">tx {shortAddress(row.onchain.txHash, 10, 8)}</span>
        ) : null}
        {periodMismatch ? (
          <span className="field__error" role="alert">
            The check-in window for period {row.periodIndex} has rolled over, so this record can
            never anchor. Please re-upload the photo as a new check-in.
          </span>
        ) : null}
      </div>
      <span className={`checkins__badge ${badge.cls}`}>{badge.text}</span>
      {row.onchain.status !== "confirmed" && !periodMismatch ? (
        <button
          type="button"
          className="button button--ghost"
          disabled={busy}
          onClick={onReanchor}
        >
          {reanchoring && stage ? CHECKIN_STAGE_LABEL[stage] : "Anchor on-chain"}
        </button>
      ) : null}
    </div>
  );
}
