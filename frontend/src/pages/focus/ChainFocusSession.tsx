/**
 * ChainFocusSession — live on-chain session view for the focus route.
 *
 * Pending phase offers the mode-appropriate actions (join / explicit start /
 * co-focus start handshake / cancel after the phase deadline). Once Active,
 * the countdown and growth animation anchor to the chain's SessionStarted
 * window (startTime / endTime from the contract, refreshed on every session
 * event). For machine-proof modes the proof tracker (DAPP-35) binds to the
 * attester, runs the heartbeat loop and reports visibility events; the
 * settlement prompt is driven by the service-confirmed proof state, never by
 * local inference. Settlement itself happens on the settlement page.
 *
 * The transaction banner lives at page level so a "confirmed" state survives
 * the phase transition the confirmed action triggers (start → Active, admit
 * defeat → Forfeited, …).
 */

import { useMemo, useState } from "react";
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
import { useProofTracking } from "../../lib/useProofTracking";
import type { UseProofTracking } from "../../lib/useProofTracking";
import type { ProofTrackState } from "../../lib/proofTracker";
import "../FocusSessionPage.css";

interface Props {
  sessionId: bigint;
}

export function ChainFocusSession({ sessionId }: Props) {
  const { session, loading, error, refresh } = useSession(sessionId);
  const { account, provider } = useWallet();
  const { configError } = useStakeBeast();
  const owner = useOwner();
  const nowSec = Math.floor(useNow(1000) / 1000);
  const txRunner = useTx();
  const signMessage = useMemo(
    () =>
      provider
        ? async (message: string) => (await provider.getSigner()).signMessage(message)
        : null,
    [provider],
  );
  const proof = useProofTracking({ session, sessionId, account, signMessage });

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
          proof={proof}
        />
      ) : (
        <ActiveSession
          session={session}
          sessionId={sessionId}
          actions={actions}
          nowSec={nowSec}
          refresh={refresh}
          txRunner={txRunner}
          proof={proof}
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
  proof: UseProofTracking;
}

/** Injected-wallet mobile browser — the start guidance targets these. */
function isMobileWalletBrowser(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  return (
    /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) &&
    (window as { ethereum?: unknown }).ethereum !== undefined
  );
}

function PendingPhase({ session, sessionId, actions, nowSec, refresh, txRunner, proof }: PhaseProps) {
  const { api } = useStakeBeast();
  const [joinPayee, setJoinPayee] = useState<Payee>(Payee.Charity);
  const [joinCustomPayee, setJoinCustomPayee] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const { tx, run } = txRunner;
  const pending = tx.phase === "pending";
  const mobileWallet = isMobileWalletBrowser();

  const shareHint = `Share this page's URL with your ${session.mode === Mode.Duel ? "opponent" : "partner"} — it contains the session id.`;

  // Start protocol (machine-proof): ready (bind) → startSession tx → arming
  // notice. The bind folds into the click when it has not happened yet.
  const doStart = () => {
    if (!api) return;
    void (async () => {
      if (proof.enabled && proof.state.phase === "unbound") {
        const bound = await proof.bind();
        if (!bound) return; // bind error surfaces in the tracking panel
      }
      void run(
        () =>
          api.startSession(sessionId).then((resp) => {
            // Arm the moment the tx is broadcast — the service watches it.
            if (proof.enabled) proof.notifyStarted(resp.hash);
            return resp;
          }),
        refresh,
        "Start",
      );
    })();
  };
  const doCancel = () => {
    if (api) void run(() => api.cancelPending(sessionId), refresh, "Cancel");
  };
  const doJoin = () => {
    if (!api) return;
    setJoinError(null);
    if (joinPayee === Payee.Custom && !isAddress(joinCustomPayee.trim())) {
      setJoinError("A custom forfeit destination needs a valid 0x address.");
      return;
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

      {isMachineProof(session.mode) && proof.enabled ? (
        <ProofTrackingPanel proof={proof} mobile={mobileWallet} />
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
          <button type="button" className="button" disabled={pending} onClick={doJoin}>
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
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Active phase                                                        */
/* ------------------------------------------------------------------ */

function ActiveSession({ session, sessionId, actions, nowSec, refresh, txRunner, proof }: PhaseProps) {
  const { api } = useStakeBeast();
  const { tx, run } = txRunner;
  const [confirmAdmit, setConfirmAdmit] = useState(false);
  const pending = tx.phase === "pending";

  const startMs = session.startTime * 1000;
  const endMs = session.endTime * 1000;
  const windowMs = Math.max(1, endMs - startMs);
  const nowMs = nowSec * 1000;
  const progress = Math.min(1, Math.max(0, (nowMs - startMs) / windowMs));
  const windowOver = nowSec >= session.endTime;

  // Proof state (service-confirmed where available): the violation flag and
  // the settlement prompt come from the attester, not from local inference.
  const machine = isMachineProof(session.mode);
  const violated = proof.enabled && (proof.state.violation || proof.state.localHidden);
  const failed = windowOver && violated;
  const attestationReady = proof.enabled && proof.state.attestationReady;

  const mood: BeastMood = failed
    ? "fled"
    : violated
      ? "warning"
      : windowOver
        ? "happy"
        : "growing";

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
        {machine ? (
          proof.enabled ? (
            <>
              <p className="muted focus__hint" data-testid="proof-hint">
                {proofHintText(proof.state, windowOver)}
              </p>
              {proof.state.phase === "unbound" || proof.state.phase === "binding" ? (
                <>
                  {proof.state.error ? (
                    <p className="field__error" role="alert">
                      {proof.state.error}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={proof.state.phase === "binding"}
                    onClick={() => void proof.bind()}
                  >
                    {proof.state.phase === "binding"
                      ? "Confirm the signature…"
                      : "Resume focus tracking"}
                  </button>
                </>
              ) : null}
            </>
          ) : (
            <p className="muted focus__hint">
              Stay focused — the proof service tracks coverage and issues the
              completion attestation.
            </p>
          )
        ) : (
          <p className="muted focus__hint">
            Human proof: the verifier confirms completion on-chain. Check-ins
            are evidence for the verifier, not the completion basis.
          </p>
        )}
      </section>

      {proof.enabled && proof.state.phase === "takeover" ? (
        <section className="card focus__warning" role="alert">
          <h3>Tracking moved elsewhere</h3>
          <p>
            This session was bound from another tab or device — only one client
            may track a session, so this tab stopped its heartbeats. If the
            other client is gone, take tracking back (one signature).
          </p>
          <div className="focus__actions">
            <button type="button" className="button" onClick={() => void proof.bind()}>
              Take back tracking
            </button>
          </div>
        </section>
      ) : null}

      {violated && !failed ? (
        <section className="card focus__warning" role="alert">
          <h3>Violation flagged</h3>
          <p>
            {proof.state.violation
              ? "The proof service recorded a violation — this session can no longer receive a completion proof."
              : "This tab was hidden — the event was reported to the proof service, which treats it as a violation for machine-proof sessions."}{" "}
            Admit defeat uses your chosen route; after the settlement deadline,
            anyone can trigger forfeiture to charity.
          </p>
        </section>
      ) : null}

      {failed ? (
        <section className="card focus__failed" role="alert">
          <h3>Session failed</h3>
          <p>
            Only a dried sprout remains — the beast ran away. Failed sessions
            mint no NFT.
          </p>
          <p className="focus__funds">
            <span className="focus__funds-dot" aria-hidden="true" />
            Funds pending settlement
          </p>
          <p className="muted">
            Admit defeat to pay your chosen route; after the deadline anyone
            can trigger forfeiture to charity.
          </p>
        </section>
      ) : null}

      {windowOver && !violated ? (
        <section className="card">
          {!machine ? (
            <>
              <h2>Window complete — settle the session</h2>
              <p className="muted">
                The verifier can confirm completion on the settlement page.
              </p>
              <Link className="button" to={`/settlement/${sessionId.toString()}`}>
                Go to settlement
              </Link>
            </>
          ) : attestationReady ? (
            <>
              <h2>Coverage verified — settle the session</h2>
              <p className="muted">
                The proof service confirmed a clean window — the completion
                attestation is ready to fetch.
              </p>
              <Link className="button" to={`/settlement/${sessionId.toString()}`}>
                Go to settlement
              </Link>
            </>
          ) : proof.state.uncertifiable ? (
            <>
              <h2>Not certifiable — platform fault</h2>
              <p className="muted">
                The proof service could not certify this window (platform
                fault, no one is at fault) — the session can be voided for a
                full refund.
              </p>
              <Link className="button button--ghost" to={`/settlement/${sessionId.toString()}`}>
                Open settlement
              </Link>
            </>
          ) : (
            <>
              <h2>Finalizing coverage…</h2>
              <p className="muted">
                The proof service is replaying the window before issuing the
                attestation — this usually takes a few seconds.
              </p>
            </>
          )}
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

/* ------------------------------------------------------------------ */
/* Proof tracking (machine-proof modes)                                */
/* ------------------------------------------------------------------ */

/** Status line for the active phase, driven by the service proof state. */
function proofHintText(state: ProofTrackState, windowOver: boolean): string {
  if (state.phase === "binding") {
    return "Resuming focus tracking — confirm the wallet signature…";
  }
  if (state.phase === "takeover") {
    return "Tracking moved to another tab or device — this tab stopped heartbeats.";
  }
  if (state.violation) {
    return "Violation confirmed by the proof service — this session can no longer receive a completion proof.";
  }
  if (state.localHidden) {
    return "Hidden-tab event reported — the proof service is confirming the violation…";
  }
  if (state.attestationReady) {
    return "Coverage verified — the completion attestation is ready.";
  }
  if (state.uncertifiable) {
    return "The proof service could not certify this window (platform fault) — the session can be voided for a full refund.";
  }
  if (windowOver) {
    return "Window ended — the proof service is finalizing coverage…";
  }
  if (state.unreachable) {
    return "Proof service unreachable — retrying every few seconds. Keep this page open.";
  }
  if (state.phase === "unbound") {
    return "Focus tracking needs a bind — one wallet signature resumes the heartbeats.";
  }
  if (state.lifecycle === "arming") {
    return "Arming the proof service — confirming the start transaction…";
  }
  if (state.lastAckSeq > 0) {
    return `Monitoring — heartbeat #${state.lastAckSeq} acknowledged.`;
  }
  return "Monitoring starts with the on-chain start window.";
}

/**
 * Pending-phase tracking panel: the ready step of the start protocol.
 * Binding is one wallet signature (no gas); once bound, the proof service
 * monitors coverage from the first second of the on-chain window.
 */
function ProofTrackingPanel({ proof, mobile }: { proof: UseProofTracking; mobile: boolean }) {
  const { state } = proof;
  const mobileHint = mobile
    ? " On mobile: finish every wallet step before starting — then keep this page in the foreground until the window ends."
    : "";

  if (state.phase === "unbound" || state.phase === "binding") {
    return (
      <div className="focus__tracking">
        <p className="muted">
          Focus tracking is off. Bind once (one wallet signature, no gas) so the
          proof service can monitor coverage from the first second — a window
          without coverage cannot be attested.{mobileHint}
        </p>
        {state.error ? (
          <p className="field__error" role="alert">
            {state.error}
          </p>
        ) : null}
        <div>
          <button
            type="button"
            className="button button--ghost"
            disabled={state.phase === "binding"}
            onClick={() => void proof.bind()}
          >
            {state.phase === "binding"
              ? "Confirm the signature in your wallet…"
              : "Enable focus tracking"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="focus__tracking">
      <p className="muted">
        Focus tracking ready ✓ — the proof service starts monitoring with the
        on-chain start and needs this page open until the window ends.
        {mobileHint}
      </p>
      {state.participants.length > 0 ? (
        <p className="muted">
          Bound: {state.participants.map((p) => `${shortAddress(p.address)} ✓`).join(" · ")}
        </p>
      ) : null}
    </div>
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
