/**
 * ChainFocusSession — live on-chain session view for the focus route.
 *
 * Pending phase offers the mode-appropriate actions (join / explicit start /
 * co-focus start handshake / cancel after the phase deadline). Once Active,
 * the countdown and growth animation anchor to the chain's SessionStarted
 * window (startTime / endTime from the contract, refreshed on every session
 * event). The violation warning remains a local visual signal until the
 * proof-service wiring (DAPP-35); settlement happens on the settlement page.
 *
 * The transaction banner lives at page level so a "confirmed" state survives
 * the phase transition the confirmed action triggers (start → Active, admit
 * defeat → Forfeited, …).
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatEther, isAddress, ZeroAddress } from "ethers";
import { useWallet } from "../../wallet/useWallet";
import { useOwner, useSession, useStakeBeast } from "../../contract/useStakeBeast";
import { deriveActions, isMachineProof, isTerminal, taskLabel } from "../../contract/sessionView";
import { MODE_LABEL, Payee, STATUS_LABEL, Status, Mode } from "../../contract/types";
import type { Session } from "../../contract/types";
import { useTx } from "../../components/tx/useTx";
import type { UseTx } from "../../components/tx/useTx";
import { TxStatusBanner } from "../../components/tx/TxStatusBanner";
import { BeastSprite } from "../../components/beast/BeastSprite";
import type { BeastMood } from "../../components/beast/BeastSprite";
import { CountdownTimer } from "../../components/CountdownTimer";
import { EmptyState } from "../../components/states/EmptyState";
import { shortAddress } from "../../lib/format";
import { useNow } from "../../lib/useNow";
import "../FocusSessionPage.css";

interface Props {
  sessionId: bigint;
}

export function ChainFocusSession({ sessionId }: Props) {
  const { session, loading, error, refresh } = useSession(sessionId);
  const { account } = useWallet();
  const { configError } = useStakeBeast();
  const owner = useOwner();
  const nowSec = Math.floor(useNow(1000) / 1000);
  const txRunner = useTx();

  if (configError) {
    return (
      <EmptyState icon="⚙️" title="Contract not configured" hint={configError} />
    );
  }
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
    <div className="focus">
      <section className="card">
        <div className="focus__head">
          <h1>
            {MODE_LABEL[session.mode]} <span className="muted">#{sessionId.toString()}</span>
          </h1>
          <p className="muted">
            {taskLabel(session)} · stake {formatEther(session.stake)} ETH · status{" "}
            <strong>{STATUS_LABEL[session.status]}</strong>
          </p>
        </div>
        <TxStatusBanner tx={txRunner.tx} actionLabel={txRunner.label} />
      </section>

      {isTerminal(session.status) ? (
        <TerminalNotice session={session} sessionId={sessionId} />
      ) : session.status === Status.Pending ? (
        <PendingPhase
          session={session}
          sessionId={sessionId}
          actions={actions}
          nowSec={nowSec}
          refresh={refresh}
          txRunner={txRunner}
        />
      ) : (
        <ActiveSession
          session={session}
          sessionId={sessionId}
          actions={actions}
          nowSec={nowSec}
          refresh={refresh}
          txRunner={txRunner}
        />
      )}

      {actions.voidSession ? (
        <VoidPanel sessionId={sessionId} refresh={refresh} txRunner={txRunner} />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pending phase                                                       */
/* ------------------------------------------------------------------ */

interface PhaseProps {
  session: Session;
  sessionId: bigint;
  actions: ReturnType<typeof deriveActions>;
  nowSec: number;
  refresh: () => void;
  txRunner: UseTx;
}

function PendingPhase({ session, sessionId, actions, nowSec, refresh, txRunner }: PhaseProps) {
  const { api } = useStakeBeast();
  const [joinPayee, setJoinPayee] = useState<Payee>(Payee.Charity);
  const [joinCustomPayee, setJoinCustomPayee] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinConsentOpen, setJoinConsentOpen] = useState(false);
  const { tx, run } = txRunner;
  const pending = tx.phase === "pending";

  const shareHint = `Share this page's URL with your ${session.mode === Mode.Duel ? "opponent" : "partner"} — it contains the session id.`;

  const doStart = () => {
    if (api) void run(() => api.startSession(sessionId), refresh, "Start");
  };
  const doCancel = () => {
    if (api) void run(() => api.cancelPending(sessionId), refresh, "Cancel");
  };
  const doJoin = () => {
    if (!api) return;
    setJoinError(null);
    if (joinPayee === Payee.Custom) {
      const trimmed = joinCustomPayee.trim();
      if (!isAddress(trimmed)) {
        setJoinError("A custom forfeit destination needs a valid 0x address.");
        return;
      }
      if (trimmed.toLowerCase() === ZeroAddress) {
        // The contract rejects a zero custom payee with CustomPayeeZero.
        setJoinError("The zero address cannot receive a forfeited stake — enter a concrete address.");
        return;
      }
    }
    void run(
      () =>
        api.joinSession(
          sessionId,
          joinPayee,
          joinPayee === Payee.Custom ? joinCustomPayee.trim() : ZeroAddress,
          session.stake,
        ),
      refresh,
      "Join",
    );
  };

  // Co-focus is joint liability: the joiner funds only after explicitly
  // confirming that either side's failure sends BOTH stakes to charity
  // (baseline §4.4 — the creator's consent cannot speak for the joiner).
  const onJoinClick = () => {
    if (session.mode === Mode.CoFocus) {
      setJoinConsentOpen(true);
      return;
    }
    doJoin();
  };
  const onJoinConsentConfirm = () => {
    setJoinConsentOpen(false);
    doJoin();
  };

  return (
    <section className="card">
      <h2>Waiting to begin</h2>

      {session.mode === Mode.SoloFocus ? (
        <>
          <p className="muted">
            Your stake is locked. Start the session on-chain before the start
            deadline, or the session can be cancelled for a full refund.
          </p>
          <CountdownTimer
            targetMs={session.startDeadline * 1000}
            label={actions.cancel ? "Start window closed" : "Start window closes in"}
            onElapsed={refresh}
          />
        </>
      ) : null}

      {session.mode === Mode.Duel && !session.joined ? (
        <>
          <p className="muted">
            {actions.join
              ? "You are the designated opponent — fund the counter-position with the same stake to start the bet."
              : `Waiting for the opponent (${shortAddress(session.partner)}) to fund the counter-position with the same stake. ${shareHint}`}
          </p>
          <CountdownTimer
            targetMs={session.joinDeadline * 1000}
            label={nowSec >= session.joinDeadline ? "Join window closed" : "Join window closes in"}
            onElapsed={refresh}
          />
        </>
      ) : null}

      {session.mode === Mode.CoFocus && !session.joined ? (
        <>
          <p className="muted">
            {actions.join
              ? "You can take the open partner seat — fund it with the same stake to enable the start handshake."
              : `Waiting for a partner to fund this session with the same stake. ${shareHint}`}
          </p>
          <CountdownTimer
            targetMs={session.joinDeadline * 1000}
            label={nowSec >= session.joinDeadline ? "Join window closed" : "Join window closes in"}
            onElapsed={refresh}
          />
        </>
      ) : null}

      {session.mode === Mode.CoFocus && session.joined ? (
        <>
          <p className="muted">
            Both seats are funded. Each participant confirms the start once —
            the second confirmation anchors the session window on-chain.
          </p>
          <CountdownTimer
            targetMs={session.startDeadline * 1000}
            label={nowSec >= session.startDeadline ? "Start window closed" : "Start window closes in"}
            onElapsed={refresh}
          />
          <p className="muted">
            Confirmed: {session.startConfirmedStaker ? "creator ✓" : "creator …"}{" "}
            {session.startConfirmedPartner ? "· partner ✓" : "· partner …"}
          </p>
        </>
      ) : null}

      {actions.join ? (
        <div className="focus__join">
          {session.mode === Mode.Duel ? (
            <>
              <label className="field">
                <span>Your forfeit route on admitted defeat</span>
                <select
                  value={joinPayee}
                  onChange={(e) => setJoinPayee(Number(e.target.value) as Payee)}
                >
                  <option value={Payee.Charity}>Charity address</option>
                  <option value={Payee.Verifier}>Opponent (verifier of your position)</option>
                  <option value={Payee.Custom}>Friend's address</option>
                </select>
              </label>
              {joinPayee === Payee.Custom ? (
                <label className="field">
                  <span>Custom forfeit address</span>
                  <input
                    type="text"
                    spellCheck={false}
                    placeholder="0x…"
                    value={joinCustomPayee}
                    onChange={(e) => setJoinCustomPayee(e.target.value)}
                  />
                </label>
              ) : null}
            </>
          ) : (
            <p className="muted">
              Joint liability: if either of you fails, <strong>both</strong> stakes go to
              charity.
            </p>
          )}
          <p className="muted">
            Joining locks the same stake: <strong>{formatEther(session.stake)} ETH</strong>.
          </p>
          {joinError ? (
            <p className="field__error" role="alert">
              {joinError}
            </p>
          ) : null}
          <button type="button" className="button" disabled={pending} onClick={onJoinClick}>
            {pending ? "Joining…" : `Join & stake ${formatEther(session.stake)} ETH`}
          </button>
        </div>
      ) : null}

      {actions.start ? (
        <button type="button" className="button" disabled={pending} onClick={doStart}>
          {pending ? "Starting…" : "Start session"}
        </button>
      ) : null}

      {actions.confirmStart ? (
        <button type="button" className="button" disabled={pending} onClick={doStart}>
          {pending ? "Confirming…" : "Confirm start"}
        </button>
      ) : null}

      {actions.cancel ? (
        <button type="button" className="button button--ghost" disabled={pending} onClick={doCancel}>
          {pending ? "Cancelling…" : "Cancel session & refund stake"}
        </button>
      ) : null}

      {joinConsentOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setJoinConsentOpen(false)}
        >
          <div
            className="modal card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cofocus-join-consent-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="cofocus-join-consent-title">Joint liability — please confirm</h3>
            <p>
              You are joining a co-focus session. If either participant fails
              or the session is forfeited, <strong>both</strong> stakes —
              yours and your partner's — go to the charity address, not just
              the failing side. This cannot be undone once you fund.
            </p>
            <div className="modal__actions">
              <button
                type="button"
                className="button button--ghost"
                onClick={() => setJoinConsentOpen(false)}
              >
                Back
              </button>
              <button
                type="button"
                className="button button--danger"
                disabled={pending}
                onClick={onJoinConsentConfirm}
              >
                I understand — join with joint liability
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Active phase                                                        */
/* ------------------------------------------------------------------ */

function ActiveSession({ session, sessionId, actions, nowSec, refresh, txRunner }: PhaseProps) {
  const { api } = useStakeBeast();
  const { tx, run } = txRunner;
  const [violated, setViolated] = useState(false);
  const [confirmAdmit, setConfirmAdmit] = useState(false);
  const pending = tx.phase === "pending";

  const startMs = session.startTime * 1000;
  const endMs = session.endTime * 1000;
  const windowMs = Math.max(1, endMs - startMs);
  const nowMs = nowSec * 1000;
  const progress = Math.min(1, Math.max(0, (nowMs - startMs) / windowMs));
  const windowOver = nowSec >= session.endTime;

  // Local visual violation signal only: hiding the tab flags the warning
  // visuals. The authoritative violation lives in the proof service
  // (DAPP-35) and gates the attestation, not this page.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) setViolated(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const mood: BeastMood = violated ? "warning" : windowOver ? "happy" : "growing";

  const doAdmitDefeat = () => {
    setConfirmAdmit(false);
    if (api) void run(() => api.admitDefeat(sessionId), refresh, "Admit defeat");
  };
  const doVerify = () => {
    if (api) void run(() => api.verify(sessionId), refresh, "Verify");
  };

  return (
    <>
      <section className="card focus__stage">
        <BeastSprite
          stage="young"
          mood={mood}
          progress={progress}
          size={220}
        />
        {!windowOver ? (
          <CountdownTimer targetMs={endMs} label="Remaining" onElapsed={refresh} />
        ) : (
          <p className="focus__done">Session window complete.</p>
        )}
        <div
          className="focus__progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          aria-label="Growth progress"
        >
          <span className="focus__progress-fill" style={{ width: `${progress * 100}%` }} />
        </div>
        {isMachineProof(session.mode) ? (
          <p className="muted focus__hint">
            Stay focused — the proof service tracks coverage and issues the
            completion attestation.
            {/* TODO(DAPP-35): replace this static hint with the proof-state
                driven settlement prompt (bind/arm/heartbeat/status). */}
          </p>
        ) : (
          <p className="muted focus__hint">
            Human proof: the verifier confirms completion on-chain. Check-ins
            are evidence for the verifier, not the completion basis.
          </p>
        )}
      </section>

      {violated ? (
        <section className="card focus__warning" role="alert">
          <h3>Violation flagged (local signal)</h3>
          <p>
            This tab was hidden, which the proof service treats as a violation
            for machine-proof sessions — it will refuse to attest. The
            authoritative proof state arrives with DAPP-35; if coverage fails,
            admit defeat below or the stake forfeits after the deadline.
          </p>
        </section>
      ) : null}

      {windowOver ? (
        <section className="card">
          <h2>Window complete — settle the session</h2>
          <p className="muted">
            {isMachineProof(session.mode)
              ? "Fetch the completion attestation and settle on the settlement page."
              : "The verifier can confirm completion on the settlement page."}
          </p>
          <Link className="button" to={`/settlement/${sessionId.toString()}`}>
            Go to settlement
          </Link>
        </section>
      ) : null}

      <section className="card">
        <h2>Actions</h2>
        <div className="focus__actions">
          {actions.verify ? (
            <button type="button" className="button" disabled={pending} onClick={doVerify}>
              {pending ? "Confirming…" : "Verify completion"}
            </button>
          ) : null}
          {actions.admitDefeat && !confirmAdmit ? (
            <button
              type="button"
              className="button button--danger"
              disabled={pending}
              onClick={() => setConfirmAdmit(true)}
            >
              Admit defeat
            </button>
          ) : null}
          {actions.admitDefeat && confirmAdmit ? (
            <span className="focus__confirm">
              <span>
                Forfeit your stake now along the preset route?
              </span>
              <button
                type="button"
                className="button button--danger"
                disabled={pending}
                onClick={doAdmitDefeat}
              >
                {pending ? "Forfeiting…" : "Yes, admit defeat"}
              </button>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => setConfirmAdmit(false)}
              >
                Keep going
              </button>
            </span>
          ) : null}
        </div>
      </section>

      {session.mode === Mode.Duel && session.linkedSessionId > 0n ? (
        <LinkedDuelPosition linkedId={session.linkedSessionId} />
      ) : null}
    </>
  );
}

/** Duel cross-position: the viewer supervises the opponent's mirror position. */
function LinkedDuelPosition({ linkedId }: { linkedId: bigint }) {
  const { session: linked, refresh } = useSession(linkedId);
  const { account } = useWallet();
  const { api } = useStakeBeast();
  const { tx, run } = useTx();
  const nowSec = Math.floor(useNow(1000) / 1000);

  if (!linked) {
    return (
      <section className="card">
        <p className="muted">Loading the linked position…</p>
      </section>
    );
  }

  const canVerify =
    linked.status === Status.Active &&
    !!account &&
    account.toLowerCase() === linked.verifier.toLowerCase() &&
    nowSec < linked.settlementDeadline;
  const isOwnPosition = !!account && account.toLowerCase() === linked.staker.toLowerCase();

  return (
    <section className="card">
      <h2>
        {isOwnPosition
          ? `Your mirror position #${linkedId.toString()}`
          : `Opponent position #${linkedId.toString()}`}
      </h2>
      <p className="muted">
        {isOwnPosition
          ? "The counter-position created when you joined — your own stake lives here."
          : "You supervise this position."}{" "}
        Status: <strong>{STATUS_LABEL[linked.status]}</strong>.
        {canVerify
          ? " Confirm only what you can stand behind — your confirmation is final."
          : ""}
      </p>
      <div className="focus__actions">
        <Link className="button button--ghost" to={`/focus/${linkedId.toString()}`}>
          {isOwnPosition ? "Open your position" : "Open opponent position"}
        </Link>
        {canVerify ? (
          <button
            type="button"
            className="button"
            disabled={tx.phase === "pending"}
            onClick={() => { if (api) void run(() => api.verify(linkedId), refresh); }}
          >
            {tx.phase === "pending" ? "Confirming…" : "Verify opponent's completion"}
          </button>
        ) : null}
      </div>
      <TxStatusBanner tx={tx} actionLabel="Verify" />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Terminal + admin                                                    */
/* ------------------------------------------------------------------ */

function TerminalNotice({ session, sessionId }: { session: Session; sessionId: bigint }) {
  const copy: Record<number, { icon: string; text: string }> = {
    [Status.Completed]: {
      icon: "🎉",
      text: "Session completed — the stake was credited and the beast minted.",
    },
    [Status.Forfeited]: { icon: "🥀", text: "Session forfeited — the stake followed the forfeit route." },
    [Status.Voided]: { icon: "🌀", text: "Session voided by the platform — full principal refund." },
    [Status.Cancelled]: { icon: "🕸️", text: "Session cancelled — the stake was refunded to the claimable balance." },
  };
  const c = copy[session.status] ?? { icon: "ℹ️", text: "This session is settled." };
  return (
    <section className="card">
      <h2>
        {c.icon} {STATUS_LABEL[session.status]}
      </h2>
      <p className="muted">{c.text}</p>
      <Link className="button" to={`/settlement/${sessionId.toString()}`}>
        Open settlement
      </Link>
    </section>
  );
}

function VoidPanel({
  sessionId,
  refresh,
  txRunner,
}: {
  sessionId: bigint;
  refresh: () => void;
  txRunner: UseTx;
}) {
  const { api } = useStakeBeast();
  const { tx, run } = txRunner;
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="card">
      <h2>Admin</h2>
      <p className="muted">
        Voiding refunds the full principal to all funded participants — no
        mint, no forfeit routing. Platform-fault use only.
      </p>
      {!confirming ? (
        <button type="button" className="button button--ghost" onClick={() => setConfirming(true)}>
          Void session
        </button>
      ) : (
        <span className="focus__confirm">
          <span>Void this session and refund everyone?</span>
          <button
            type="button"
            className="button button--danger"
            disabled={tx.phase === "pending"}
            onClick={() => {
              setConfirming(false);
              if (api) void run(() => api.voidSession(sessionId), refresh, "Void");
            }}
          >
            {tx.phase === "pending" ? "Voiding…" : "Confirm void"}
          </button>
          <button type="button" className="button button--ghost" onClick={() => setConfirming(false)}>
            Back
          </button>
        </span>
      )}
    </section>
  );
}
