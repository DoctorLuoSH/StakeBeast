/**
 * CreateSessionPage — four session modes from the frozen baseline (§4.1–4.4),
 * wired to StakeBeast.createSession. Client-side validation mirrors the
 * contract's R6 combination rules with field-level human-readable messages;
 * co-focus requires the joint-liability informed consent before staking.
 */

import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { WalletGate } from "../components/wallet/WalletGate";
import { TxStatusBanner } from "../components/tx/TxStatusBanner";
import { useTx } from "../components/tx/useTx";
import { useStakeBeast } from "../contract/useStakeBeast";
import { useWallet } from "../wallet/useWallet";
import { validateSessionForm } from "../lib/sessionForm";
import type {
  DuelTask,
  FormMode,
  PayeeChoice,
  SessionFormErrors,
} from "../lib/sessionForm";
import "./CreateSessionPage.css";

interface ModeDef {
  id: FormMode;
  title: string;
  tier: "P0" | "P1" | "P2";
  summary: string;
}

const MODES: ModeDef[] = [
  {
    id: "solo",
    title: "Solo Focus",
    tier: "P0",
    summary:
      "Machine-attested single focus session. Explicit on-chain start; the proof service must cover the full declared duration.",
  },
  {
    id: "supervised",
    title: "Supervised Habit",
    tier: "P0",
    summary:
      "Habit over N days with check-ins. Your supervisor's final on-chain confirmation is the sole success criterion.",
  },
  {
    id: "duel",
    title: "Mutual Bet",
    tier: "P1",
    summary:
      "Two bound but independently settled positions; each side supervises the other. Your opponent must fund their seat before the join deadline.",
  },
  {
    id: "cofocus",
    title: "Co-Focus Duo",
    tier: "P2",
    summary:
      "Two stakers focus together with joint liability — if either fails, both stakes go to charity.",
  },
];

const DEFAULTS = {
  stakeEth: "0.05",
  durationMinutes: "25",
  periodDays: "7",
  checkInsPerDay: "1",
  targetCount: "7",
};

export function CreateSessionPage() {
  const navigate = useNavigate();
  const { account } = useWallet();
  const { api, configError } = useStakeBeast();
  const { tx, run } = useTx();

  const [mode, setMode] = useState<FormMode>("solo");
  const [stakeEth, setStakeEth] = useState(DEFAULTS.stakeEth);
  const [durationMinutes, setDurationMinutes] = useState(DEFAULTS.durationMinutes);
  const [periodDays, setPeriodDays] = useState(DEFAULTS.periodDays);
  const [checkInsPerDay, setCheckInsPerDay] = useState(DEFAULTS.checkInsPerDay);
  const [targetCount, setTargetCount] = useState(DEFAULTS.targetCount);
  const [criterion, setCriterion] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [payee, setPayee] = useState<PayeeChoice>("charity");
  const [customPayee, setCustomPayee] = useState("");
  const [duelTask, setDuelTask] = useState<DuelTask>("focus");
  const [cofocusConsent, setCofocusConsent] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [errors, setErrors] = useState<SessionFormErrors>({});

  const active = MODES.find((m) => m.id === mode)!;
  const isFocusTrack = mode === "solo" || mode === "cofocus" || (mode === "duel" && duelTask === "focus");
  const payeeOptions: { id: PayeeChoice; label: string }[] =
    mode === "cofocus"
      ? [{ id: "charity", label: "Charity address (forced by joint liability)" }]
      : mode === "solo"
        ? [
            { id: "charity", label: "Charity address" },
            { id: "custom", label: "Friend's address" },
          ]
        : [
            { id: "charity", label: "Charity address" },
            { id: "verifier", label: mode === "duel" ? "Opponent" : "Supervisor" },
            { id: "custom", label: "Friend's address" },
          ];

  const onModeChange = (m: FormMode) => {
    setMode(m);
    setErrors({});
    // Co-focus forfeits always go to charity (R6); keep the select valid.
    if (m === "cofocus") setPayee("charity");
  };

  const collectValues = (consent: boolean) => ({
    mode,
    stakeEth,
    durationMinutes,
    periodDays,
    checkInsPerDay,
    targetCount,
    criterion,
    counterparty,
    payee,
    customPayee,
    duelTask,
    cofocusConsent: consent,
    self: account,
  });

  const submit = (consent: boolean) => {
    const { errors: next, params } = validateSessionForm(collectValues(consent));
    setErrors(next);
    if (!params || !api) return;
    void run(
      () => api.createSession(params),
      (receipt) => {
        const id = api.readCreatedSessionId(receipt);
        if (id !== null) navigate(`/focus/${id}`);
      },
    );
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === "cofocus" && !cofocusConsent) {
      // Joint-liability informed consent popup before any stake is locked.
      setConsentOpen(true);
      return;
    }
    submit(cofocusConsent);
  };

  const onConsentConfirm = () => {
    setCofocusConsent(true);
    setConsentOpen(false);
    submit(true);
  };

  const pending = tx.phase === "pending";

  return (
    <WalletGate>
      <div className="create">
        <h1>Create a session</h1>
        <p className="muted">
          Parameters are locked once staked — duration, goal, verifier and
          forfeit destination cannot be changed afterwards.
        </p>

        <div className="create__modes" role="tablist" aria-label="Session mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              className={`create__mode card${mode === m.id ? " create__mode--active" : ""}`}
              onClick={() => onModeChange(m.id)}
            >
              <span className={`badge badge--${m.tier.toLowerCase()}`}>{m.tier}</span>
              <strong>{m.title}</strong>
              <small className="muted">{m.summary}</small>
            </button>
          ))}
        </div>

        <form className="card create__form" onSubmit={onSubmit} noValidate>
          <h2>{active.title}</h2>

          <label className="field">
            <span>Stake amount (ETH)</span>
            <input
              required
              type="number"
              min="0"
              step="any"
              placeholder={DEFAULTS.stakeEth}
              value={stakeEth}
              onChange={(e) => setStakeEth(e.target.value)}
              aria-invalid={!!errors.stakeEth}
            />
            {errors.stakeEth ? <small className="field__error">{errors.stakeEth}</small> : null}
          </label>

          {mode === "duel" ? (
            <fieldset className="field">
              <span>Task style — a mutual bet needs exactly one</span>
              <label className="field__radio">
                <input
                  type="radio"
                  name="duel-task"
                  checked={duelTask === "focus"}
                  onChange={() => setDuelTask("focus")}
                />
                Focus (minutes, machine-paced)
              </label>
              <label className="field__radio">
                <input
                  type="radio"
                  name="duel-task"
                  checked={duelTask === "habit"}
                  onChange={() => setDuelTask("habit")}
                />
                Habit (days, check-ins)
              </label>
            </fieldset>
          ) : null}

          {isFocusTrack ? (
            <label className="field">
              <span>Focus duration (minutes)</span>
              <input
                required
                type="number"
                min="1"
                max="1440"
                step="1"
                placeholder={DEFAULTS.durationMinutes}
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(e.target.value)}
                aria-invalid={!!errors.durationMinutes}
              />
              {errors.durationMinutes ? (
                <small className="field__error">{errors.durationMinutes}</small>
              ) : (
                <small className="muted">
                  Tier ladder: ≥120 golden · ≥50 adult · ≥25 young · below 25 a practice seedling.
                </small>
              )}
            </label>
          ) : (
            <>
              <label className="field">
                <span>Period (days)</span>
                <input
                  required
                  type="number"
                  min="1"
                  max="365"
                  step="1"
                  placeholder={DEFAULTS.periodDays}
                  value={periodDays}
                  onChange={(e) => setPeriodDays(e.target.value)}
                  aria-invalid={!!errors.periodDays}
                />
                {errors.periodDays ? (
                  <small className="field__error">{errors.periodDays}</small>
                ) : null}
              </label>
              <label className="field">
                <span>Check-ins per day</span>
                <input
                  required
                  type="number"
                  min="1"
                  max="8"
                  step="1"
                  placeholder={DEFAULTS.checkInsPerDay}
                  value={checkInsPerDay}
                  onChange={(e) => setCheckInsPerDay(e.target.value)}
                  aria-invalid={!!errors.checkInsPerDay}
                />
                {errors.checkInsPerDay ? (
                  <small className="field__error">{errors.checkInsPerDay}</small>
                ) : null}
              </label>
              <label className="field">
                <span>Target check-ins total</span>
                <input
                  required
                  type="number"
                  min="1"
                  max="1000"
                  step="1"
                  placeholder={DEFAULTS.targetCount}
                  value={targetCount}
                  onChange={(e) => setTargetCount(e.target.value)}
                  aria-invalid={!!errors.targetCount}
                />
                {errors.targetCount ? (
                  <small className="field__error">{errors.targetCount}</small>
                ) : null}
              </label>
            </>
          )}

          {mode === "supervised" || mode === "duel" ? (
            <label className="field">
              <span>{mode === "supervised" ? "Supervisor address" : "Opponent address"}</span>
              <input
                required
                type="text"
                spellCheck={false}
                placeholder="0x…"
                value={counterparty}
                onChange={(e) => setCounterparty(e.target.value)}
                aria-invalid={!!errors.counterparty}
              />
              {errors.counterparty ? (
                <small className="field__error">{errors.counterparty}</small>
              ) : null}
            </label>
          ) : null}

          {mode === "supervised" || (mode === "duel" && duelTask === "habit") ? (
            <label className="field">
              <span>
                Completion standard ({mode === "supervised" ? "for the supervisor" : "advisory"})
              </span>
              <textarea
                rows={2}
                placeholder="e.g. 45 minutes of reading per check-in"
                value={criterion}
                onChange={(e) => setCriterion(e.target.value)}
              />
            </label>
          ) : null}

          <label className="field">
            <span>Forfeit destination on admitted defeat</span>
            <select
              value={payee}
              disabled={mode === "cofocus"}
              onChange={(e) => setPayee(e.target.value as PayeeChoice)}
              aria-invalid={!!errors.payee}
            >
              {payeeOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            {errors.payee ? <small className="field__error">{errors.payee}</small> : null}
          </label>

          {payee === "custom" && mode !== "cofocus" ? (
            <label className="field">
              <span>Custom forfeit address</span>
              <input
                required
                type="text"
                spellCheck={false}
                placeholder="0x…"
                value={customPayee}
                onChange={(e) => setCustomPayee(e.target.value)}
                aria-invalid={!!errors.customPayee}
              />
              {errors.customPayee ? (
                <small className="field__error">{errors.customPayee}</small>
              ) : null}
            </label>
          ) : null}

          {mode === "cofocus" ? (
            <p className="muted create__joint-note">
              Joint liability: if either of you fails, <strong>both</strong> stakes go to
              charity. You will be asked to confirm before the stake is locked.
            </p>
          ) : null}

          {configError ? (
            <p className="field__error" role="alert">
              {configError}
            </p>
          ) : null}

          <TxStatusBanner tx={tx} actionLabel="Stake" />

          <button type="submit" className="button" disabled={pending || !api}>
            {pending ? "Staking…" : "Stake & Create"}
          </button>
        </form>

        {consentOpen ? (
          <div className="modal-backdrop" role="presentation" onClick={() => setConsentOpen(false)}>
            <div
              className="modal card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="cofocus-consent-title"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 id="cofocus-consent-title">Joint liability — please confirm</h3>
              <p>
                A co-focus session binds two stakes. If either participant fails or the session
                is forfeited, <strong>both</strong> stakes go to the charity address — not just
                the failing side. This cannot be changed once created.
              </p>
              <div className="modal__actions">
                <button type="button" className="button button--ghost" onClick={() => setConsentOpen(false)}>
                  Back
                </button>
                <button type="button" className="button button--danger" onClick={onConsentConfirm}>
                  I understand — stake with joint liability
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </WalletGate>
  );
}
