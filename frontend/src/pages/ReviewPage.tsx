/**
 * ReviewPage — supervisor review view (baseline §4.5, api-contract A.3).
 * Lists every Active session the connected wallet verifies, each with the
 * staker's profile, the declared criterion, and the latest check-ins. Every
 * check-in is verified the R8 way: download the ORIGINAL bytes, recompute
 * SHA-256, and compare against both the record and the on-chain CheckedIn
 * event (expected contract, same hash AND periodIndex) — the verdict never
 * rests on stored hash fields alone. Confirmation is the on-chain `verify`
 * (D4: the verifier's final on-chain confirmation is the sole completion
 * basis); withholding confirmation needs no transaction — the stake goes to
 * charity after the settlement deadline.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { WalletGate } from "../components/wallet/WalletGate";
import { EmptyState } from "../components/states/EmptyState";
import { SocialSignInCard } from "../components/social/SocialSignInCard";
import { useSocialAuth } from "../social/useSocialAuth";
import { useWallet } from "../wallet/useWallet";
import { useStakeBeast } from "../contract/useStakeBeast";
import type { CheckedInRecord } from "../contract/client";
import { describeContractError } from "../contract/errors";
import { Status } from "../contract/types";
import {
  fetchMedia,
  listReviewPending,
  sha256Hex,
  socialUrl,
} from "../lib/socialApi";
import type { CheckinRecord, ReviewItem } from "../lib/socialApi";
import { useAuthedImage } from "../lib/useAuthedImage";
import { verdictFor, VERDICT_LABEL } from "../components/social/reviewEvidence";
import type { EvidenceCheck } from "../components/social/reviewEvidence";
import { useTx } from "../components/tx/useTx";
import { TxStatusBanner } from "../components/tx/TxStatusBanner";
import { shortAddress } from "../lib/format";
import { useNow } from "../lib/useNow";
import "./ReviewPage.css";

export function ReviewPage() {
  const social = useSocialAuth();
  const [snap, setSnap] = useState<{
    token: string;
    items: ReviewItem[] | null;
    error: string | null;
    exhausted: boolean;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [tick, setTick] = useState(0);
  const seqRef = useRef(0);

  const token = social.token;
  const noteApiError = social.noteApiError;

  const load = useCallback(
    (cursor: number, append: boolean) => {
      if (!token) return;
      const seq = ++seqRef.current;
      void (async () => {
        // Defer past the caller (effects stay free of synchronous setState).
        await Promise.resolve();
        if (seqRef.current !== seq) return;
        if (append) setLoadingMore(true);
        try {
          const page = await listReviewPending(token, cursor);
          if (seqRef.current !== seq) return;
          setSnap((prev) => {
            const base = append && prev && prev.token === token && prev.items ? prev.items : [];
            return { token, items: [...base, ...page], error: null, exhausted: page.length === 0 };
          });
        } catch (err) {
          if (seqRef.current !== seq) return;
          if (noteApiError(err)) return;
          setSnap({
            token,
            items: null,
            error: err instanceof Error ? err.message : "Could not load the review list.",
            exhausted: false,
          });
        } finally {
          if (seqRef.current === seq && append) setLoadingMore(false);
        }
      })();
    },
    [token, noteApiError],
  );

  useEffect(() => {
    if (token) load(0, false);
  }, [token, load, tick]);

  // The snapshot only applies to the token that fetched it — signing out or
  // switching accounts reads as a fresh load, never the previous list.
  const current = snap !== null && token !== null && snap.token === token ? snap : null;
  const items = current?.items ?? null;
  const error = current?.error ?? null;
  const exhausted = current?.exhausted ?? false;

  return (
    <WalletGate>
      <div className="review">
        <h1>Supervisor review</h1>
        <p className="muted">
          Sessions that name you as verifier queue up here. Each photo is
          served next to its on-chain hash anchor so tampering is detectable.
          Confirming calls <span className="mono">verify</span> on-chain —
          final and irreversible; withholding confirmation needs no
          transaction: after the settlement deadline the stake goes to
          charity.
        </p>

        {!social.configured ? (
          <div className="card">
            <EmptyState
              icon="🔌"
              title="Social backend not configured"
              hint="Set VITE_API_BASE_URL in .env (see .env.example). Without the backend the P0 fallback applies: verify from your own off-chain knowledge on the session page."
            />
          </div>
        ) : social.status !== "signed-in" || token === null ? (
          <SocialSignInCard />
        ) : (
          <>
            {error ? (
              <div className="card" role="alert">
                <p className="field__error">{error}</p>
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => setTick((t) => t + 1)}
                >
                  Retry
                </button>
              </div>
            ) : null}

            {items === null && !error ? (
              <div className="card">
                <p className="muted">Loading sessions awaiting your review…</p>
              </div>
            ) : null}

            {items !== null && items.length === 0 && !error ? (
              <div className="card">
                <EmptyState
                  icon="📋"
                  title="Nothing to review"
                  hint="When someone names you as supervisor, their check-ins will queue up here."
                />
              </div>
            ) : null}

            {items?.map((item) => (
              <ReviewItemCard
                key={item.sessionId}
                item={item}
                token={token}
                onVerified={() => setTick((t) => t + 1)}
              />
            ))}

            {items !== null && items.length > 0 && !exhausted ? (
              <button
                type="button"
                className="button button--ghost"
                disabled={loadingMore}
                onClick={() => load(items.length, true)}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            ) : null}
          </>
        )}
      </div>
    </WalletGate>
  );
}

/* -------------------------------------------------------------- item card -- */

function ReviewItemCard({
  item,
  token,
  onVerified,
}: {
  item: ReviewItem;
  token: string;
  onVerified: () => void;
}) {
  const { api } = useStakeBeast();
  const { account } = useWallet();
  const nowSec = Math.floor(useNow(1000) / 1000);
  const [expanded, setExpanded] = useState(false);
  const [logs, setLogs] = useState<CheckedInRecord[] | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  // DAPP-55 F2: once OUR verify confirms on-chain the session is Completed,
  // but the backend mirror can keep serving stale Active for its TTL — a
  // second click would be a guaranteed revert (wasted gas). Mark it locally.
  const [confirmedLocal, setConfirmedLocal] = useState(false);
  const { tx, run } = useTx();

  const active = !confirmedLocal && item.onchain.status === Status.Active;
  const deadline = item.onchain.settlementDeadline;
  const canVerify =
    active && deadline !== null && nowSec < deadline && api !== null && account !== null;

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && logs === null && api && !logsError) {
      api.listCheckedIn(BigInt(item.sessionId)).then(
        (records) => setLogs(records),
        (err: unknown) =>
          setLogsError(describeContractError(err) ?? "Could not read on-chain anchors."),
      );
    }
  };

  const doVerify = () => {
    if (!api || confirmedLocal) return;
    void run(
      () => api.verify(BigInt(item.sessionId)),
      () => {
        setConfirmedLocal(true);
        onVerified();
      },
      "Verify",
    );
  };

  return (
    <section className="card review__item">
      <div className="review__head">
        {item.avatarUrl ? (
          <img
            className="review__avatar"
            src={socialUrl(item.avatarUrl)}
            alt=""
            width={40}
            height={40}
          />
        ) : null}
        <div>
          <h2>
            Session #{item.sessionId} — {item.nickname ?? shortAddress(item.staker)}
          </h2>
          <p className="muted">
            {item.criterion ? `Criterion: ${item.criterion} · ` : ""}
            {item.periodDays ? `${item.periodDays} day period · ` : ""}
            {item.targetCount ? `target ${item.targetCount} check-ins · ` : ""}
            {deadline !== null
              ? nowSec < deadline
                ? `settlement deadline in ${Math.max(0, Math.floor((deadline - nowSec) / 60))} min`
                : "settlement deadline passed"
              : ""}
          </p>
        </div>
      </div>

      <div className="review__actions">
        <Link className="button button--ghost" to={`/focus/${item.sessionId}`}>
          Open session
        </Link>
        <button type="button" className="button button--ghost" onClick={toggle}>
          {expanded
            ? "Hide evidence"
            : `Evidence (${item.latestCheckins.length} check-ins)`}
        </button>
        {canVerify ? (
          <button
            type="button"
            className="button"
            disabled={tx.phase === "pending"}
            onClick={doVerify}
          >
            {tx.phase === "pending" ? "Confirming…" : "Confirm completion on-chain"}
          </button>
        ) : null}
      </div>
      <TxStatusBanner tx={tx} actionLabel="Verify" />
      {!active ? (
        <p className="muted">This session is no longer active on-chain.</p>
      ) : null}

      {expanded ? (
        <div className="review__evidence">
          {logsError ? (
            <p className="field__error" role="alert">
              {logsError}
            </p>
          ) : null}
          {item.latestCheckins.length === 0 ? (
            <p className="muted">
              No check-ins uploaded yet. You may still confirm from your own
              off-chain knowledge — the on-chain confirmation is the sole
              completion basis.
            </p>
          ) : null}
          {item.latestCheckins.map((checkin) => (
            <EvidenceRow
              key={checkin.checkinId}
              checkin={checkin}
              token={token}
              logs={logs}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/* ----------------------------------------------------------- evidence row -- */

function EvidenceRow({
  checkin,
  token,
  logs,
}: {
  checkin: CheckinRecord;
  token: string;
  logs: CheckedInRecord[] | null;
}) {
  const [check, setCheck] = useState<EvidenceCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const thumb = useAuthedImage(token, checkin.thumbUrl);

  // R8: recompute the SHA-256 over the ORIGINAL downloaded bytes, then
  // compare against the record and the on-chain CheckedIn events.
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    fetchMedia(token, checkin.photoUrl).then(
      ({ bytes, blobUrl }) => {
        if (!active) {
          URL.revokeObjectURL(blobUrl);
          return;
        }
        objectUrl = blobUrl;
        setOriginalUrl(blobUrl);
        setCheck(verdictFor(sha256Hex(bytes), checkin, logs ?? []));
        setError(null);
      },
      (err: unknown) => {
        if (active) {
          setError(err instanceof Error ? err.message : "Could not download the original photo.");
        }
      },
    );
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [token, checkin, logs]);

  return (
    <div className={`review__checkin review__checkin--${check?.verdict ?? "pending"}`}>
      {thumb.src ? (
        <img className="checkins__thumb" src={thumb.src} alt={`Check-in period ${checkin.periodIndex}`} />
      ) : (
        <span className="checkins__thumb checkins__thumb--loading" aria-hidden="true" />
      )}
      <div className="checkins__meta">
        <span className="mono">{shortAddress(checkin.evidenceHash, 10, 8)}</span>
        <span className="muted">
          period {checkin.periodIndex} · {checkin.createdAt.slice(0, 16).replace("T", " ")}Z
        </span>
        {check?.onchain ? (
          <span className="muted mono">
            anchored in tx {shortAddress(check.onchain.txHash, 10, 8)} · block{" "}
            {check.onchain.blockNumber}
          </span>
        ) : null}
        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : check ? (
          <span
            className={
              check.verdict === "anchored-matching" ? "review__verdict--ok" : "review__verdict--bad"
            }
            data-testid={`verdict-${check.verdict}`}
          >
            {VERDICT_LABEL[check.verdict]}
          </span>
        ) : (
          <span className="muted">Recomputing the hash over the original bytes…</span>
        )}
        {originalUrl ? (
          <a href={originalUrl} target="_blank" rel="noreferrer" className="muted">
            Open original photo
          </a>
        ) : null}
      </div>
    </div>
  );
}
