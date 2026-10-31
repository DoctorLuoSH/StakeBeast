/**
 * SettlementPage — real on-chain settlement view (baseline §4.7).
 *
 * Always shows the claimable balance with the withdraw entry (pull pattern,
 * retryable — a failed transfer keeps the balance credited). With a
 * `:sessionId` param it renders that session's terminal state (success refund
 * + minted beast / forfeit route / void / cancel) or the pending settlement
 * actions (attestation settle for machine-proof modes, verifier confirm,
 * permissionless forfeit after the deadline). Without a param it lists the
 * connected account's sessions.
 */

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { formatEther } from "ethers";
import { WalletGate } from "../components/wallet/WalletGate";
import { BeastSprite } from "../components/beast/BeastSprite";
import type { BeastMood } from "../components/beast/BeastSprite";
import { TxStatusBanner } from "../components/tx/TxStatusBanner";
import { useTx } from "../components/tx/useTx";
import type { UseTx } from "../components/tx/useTx";
import { EmptyState } from "../components/states/EmptyState";
import { useClaimable, useOwner, useSession, useStakeBeast } from "../contract/useStakeBeast";
import {
  deriveActions,
  forfeitDestinationLabel,
  taskLabel,
  tierForSession,
  TIER_LABEL,
} from "../contract/sessionView";
import { MODE_LABEL, STATUS_LABEL, Status } from "../contract/types";
import type { Session } from "../contract/types";
import { useWallet } from "../wallet/useWallet";
import { obtainAttestation } from "../lib/proofClient";
import { proofServiceUrl } from "../config/env";
import { EXPECTED_CHAIN_ID } from "../config/chains";
import { useNow } from "../lib/useNow";
import "./SettlementPage.css";

export function SettlementPage() {
  const { sessionId } = useParams<{ sessionId: string }>();

  let id: bigint | null = null;
  if (sessionId && /^\d+$/.test(sessionId)) {
    try {
      id = BigInt(sessionId);
    } catch {
      id = null;
    }
  }

  return (
    <WalletGate>
      <div className="settlement">
        <h1>Settlement</h1>
        <ClaimSection />
        {sessionId && id === null ? (
          <EmptyState icon="🧭" title="Unknown session" hint={`"${sessionId}" is not a valid session id.`} />
        ) : id !== null ? (
          <SessionSettlement sessionId={id} />
        ) : (
          <SessionList />
        )}
      </div>
    </WalletGate>
  );
}

/* ------------------------------------------------------------------ */
/* Claimable balance + withdraw                                        */
/* ------------------------------------------------------------------ */

function ClaimSection() {
  const { claimable, refresh } = useClaimable();
  const { api, configError } = useStakeBeast();
  const { tx, run } = useTx();
  const pending = tx.phase === "pending";
  const hasBalance = claimable !== null && claimable > 0n;

  return (
    <section className="card settlement__claim">
      <h2>Withdrawable balance</h2>
      <p className="muted">
        Pull-pattern claim entry. Completed, voided and cancelled sessions
        credit your balance here; a failed withdrawal keeps the balance
        credited, so retrying is always safe.
      </p>
      <p className="settlement__balance">
        <strong className="mono">
          {claimable === null ? "…" : `${formatEther(claimable)} ETH`}
        </strong>
      </p>
      <TxStatusBanner tx={tx} actionLabel="Withdraw" />
      <button
        type="button"
        className="button button--accent"
        disabled={pending || !api || !hasBalance}
        title={hasBalance ? undefined : "Nothing to withdraw"}
        onClick={() => { if (api) void run(() => api.withdraw(), refresh); }}
      >
        {pending ? "Withdrawing…" : "Withdraw"}
      </button>
      {configError ? (
        <p className="muted" role="alert">
          {configError}
        </p>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* One session's settlement state                                      */
/* ------------------------------------------------------------------ */

function SessionSettlement({ sessionId }: { sessionId: bigint }) {
  const { session, loading, error, refresh } = useSession(sessionId);
  const { account } = useWallet();
  const owner = useOwner();
  const nowSec = Math.floor(useNow(1000) / 1000);
  // The banner lives at page level so a "confirmed" state survives the
  // transition to the terminal card the confirmed action triggers.
  const txRunner = useTx();

  if (loading && !session) {
    return (
      <section className="card">
        <p className="muted">Loading session #{sessionId.toString()} from the chain…</p>
      </section>
    );
  }
  if (error) {
    return (
      <section className="card" role="alert">
        <h2>Could not load the session</h2>
        <p className="muted">{error}</p>
        <button type="button" className="button button--ghost" onClick={refresh}>
          Retry
        </button>
      </section>
    );
  }
  if (!session) return null;

  const isOwner = !!account && !!owner && account.toLowerCase() === owner.toLowerCase();
  const actions = deriveActions(session, account, isOwner, nowSec);

  return (
    <>
      <section className="card">
        <h2>
          {MODE_LABEL[session.mode]} #{sessionId.toString()}{" "}
          <span className="muted">· {STATUS_LABEL[session.status]}</span>
        </h2>
        <p className="muted">
          {taskLabel(session)} · stake {formatEther(session.stake)} ETH
        </p>
        <TxStatusBanner tx={txRunner.tx} actionLabel={txRunner.label} />
      </section>

      {session.status === Status.Completed ? (
        <CompletedCard session={session} sessionId={sessionId} />
      ) : session.status === Status.Forfeited ? (
        <ForfeitedCard session={session} sessionId={sessionId} />
      ) : session.status === Status.Voided || session.status === Status.Cancelled ? (
        <RefundedCard session={session} />
      ) : (
        <OpenSettlement
          session={session}
          sessionId={sessionId}
          actions={actions}
          refresh={refresh}
          txRunner={txRunner}
        />
      )}
    </>
  );
}

function CompletedCard({ session, sessionId }: { session: Session; sessionId: bigint }) {
  const { api } = useStakeBeast();
  const [tokenIds, setTokenIds] = useState<bigint[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      ?.getCompletedTokenIds(sessionId)
      .then((ids) => {
        if (!cancelled) setTokenIds(ids);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, sessionId]);

  const tier = tierForSession(session);
  return (
    <section className="card settlement__result settlement__result--success">
      <div className="settlement__row">
        <BeastSprite stage={tierStage(tier)} mood="minted" progress={1} size={170} />
        <div>
          <h2>Beast minted, stake returned</h2>
          <p className="muted">
            The verified session minted an untransferable{" "}
            <strong>{TIER_LABEL[tier]}</strong> beast
            {tokenIds.length > 0 ? ` (#${tokenIds.map((t) => t.toString()).join(", #")})` : ""}{" "}
            into the zoo, and the stake was credited to the withdrawable balance above.
          </p>
          <Link className="button button--ghost" to="/profile">
            View in My Zoo
          </Link>
        </div>
      </div>
    </section>
  );
}

function tierStage(tier: number): "sprout" | "young" | "adult" | "golden" {
  // Tier 0..3 → BeastStage sprout/young/adult/golden
  return (["sprout", "young", "adult", "golden"] as const)[tier] ?? "sprout";
}


function ForfeitedCard({ session, sessionId }: { session: Session; sessionId: bigint }) {
  const { api } = useStakeBeast();
  const [reason, setReason] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      ?.getForfeitReason(sessionId)
      .then((r) => {
        if (!cancelled) setReason(r);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, sessionId]);

  const mood: BeastMood = "fled";
  return (
    <section className="card settlement__result settlement__result--failure">
      <div className="settlement__row">
        <BeastSprite stage="young" mood={mood} progress={1} size={170} />
        <div>
          <h2>The beast ran away</h2>
          <p className="muted">
            Failed sessions mint no NFT — {forfeitDestinationLabel(session, reason)}.
          </p>
        </div>
      </div>
    </section>
  );
}

function RefundedCard({ session }: { session: Session }) {
  const voided = session.status === Status.Voided;
  return (
    <section className="card settlement__result">
      <h2>{voided ? "Session voided" : "Session cancelled"}</h2>
      <p className="muted">
        {voided
          ? "The platform voided this session (platform fault) — the full principal was refunded to the withdrawable balance."
          : "The session was cancelled before it started — the stake was refunded to the withdrawable balance."}
      </p>
    </section>
  );
}

/** Open (Pending / Active) session: settlement actions when available. */
function OpenSettlement({
  session,
  sessionId,
  actions,
  refresh,
  txRunner,
}: {
  session: Session;
  sessionId: bigint;
  actions: ReturnType<typeof deriveActions>;
  refresh: () => void;
  txRunner: UseTx;
}) {
  const { api } = useStakeBeast();
  const { account, provider } = useWallet();
  const { tx, run } = txRunner;
  const [proofNote, setProofNote] = useState<string | null>(null);
  const pending = tx.phase === "pending";

  const doSettle = () => {
    if (!api || !account || !provider) return;
    setProofNote(null);
    if (!proofServiceUrl) {
      setProofNote(
        "Proof service URL is not configured (VITE_PROOF_SERVICE_URL) — the attestation cannot be fetched.",
      );
      return;
    }
    void run(async () => {
      setProofNote("Fetching the completion attestation from the proof service…");
      const signer = await provider.getSigner();
      const attestation = await obtainAttestation({
        baseUrl: proofServiceUrl,
        chainId: EXPECTED_CHAIN_ID,
        contractAddress: api.address,
        sessionId,
        address: account,
        signMessage: (message) => signer.signMessage(message),
      });
      setProofNote(null);
      return api.settle(sessionId, attestation.signature);
    }, refresh, "Settle");
  };

  return (
    <section className="card">
      <h2>Awaiting settlement</h2>
      {session.status === Status.Pending ? (
        <p className="muted">
          The session has not started yet — manage it from the session page.
        </p>
      ) : actions.settle ? (
        <p className="muted">
          The window is complete. Fetch the proof service's completion
          attestation and settle on-chain: refund + beast mint.
        </p>
      ) : actions.verify ? (
        <p className="muted">
          You are this position's verifier — confirm completion to release the
          stake and mint the beast.
        </p>
      ) : actions.forfeit ? (
        <p className="muted">
          The settlement deadline has passed without a settlement — anyone can
          now forfeit the stake to charity.
        </p>
      ) : (
        <p className="muted">
          The session is still active. Settlement opens when the window ends.
        </p>
      )}

      {proofNote ? (
        <p className="muted" role="status">
          {proofNote}
        </p>
      ) : null}

      <div className="settlement__actions">
        <Link className="button button--ghost" to={`/focus/${sessionId.toString()}`}>
          Open session page
        </Link>
        {actions.settle ? (
          <button type="button" className="button" disabled={pending} onClick={doSettle}>
            {pending ? "Settling…" : "Fetch attestation & settle"}
          </button>
        ) : null}
        {actions.verify ? (
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={() => { if (api) void run(() => api.verify(sessionId), refresh, "Verify"); }}
          >
            {pending ? "Confirming…" : "Verify completion"}
          </button>
        ) : null}
        {actions.forfeit ? (
          <button
            type="button"
            className="button button--danger"
            disabled={pending}
            onClick={() => { if (api) void run(() => api.forfeit(sessionId), refresh, "Forfeit"); }}
          >
            {pending ? "Forfeiting…" : "Forfeit to charity"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Session list (no :sessionId)                                        */
/* ------------------------------------------------------------------ */

function SessionList() {
  const { api } = useStakeBeast();
  const { account } = useWallet();
  const [sessions, setSessions] = useState<{ id: bigint; session: Session }[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!api || !account) return undefined;
    (async () => {
      try {
        const ids = await api.sessionsOf(account);
        const loaded = await Promise.all(ids.map(async (id) => ({ id, session: await api.getSession(id) })));
        if (!cancelled) setSessions(loaded.reverse());
      } catch {
        if (!cancelled) setSessions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, account]);

  return (
    <section className="card">
      <h2>Your sessions</h2>
      {sessions === null ? (
        <p className="muted">Loading your sessions…</p>
      ) : sessions.length === 0 ? (
        <EmptyState
          icon="🕸️"
          title="No sessions yet"
          hint="Create a focus or habit session — it shows up here."
        />
      ) : (
        <ul className="settlement__list">
          {sessions.map(({ id, session }) => (
            <li key={id.toString()} className="settlement__list-item">
              <Link to={`/settlement/${id.toString()}`}>
                #{id.toString()} · {MODE_LABEL[session.mode]} · {taskLabel(session)} ·{" "}
                {formatEther(session.stake)} ETH
              </Link>
              <span className="muted"> {STATUS_LABEL[session.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
