/**
 * ProfilePage — personal homepage (baseline §4.7): the social profile
 * (sign-in, nickname, avatar), the on-chain record (successes / failures /
 * completed time / forfeited stake — derived from the account's own stake
 * positions), the sessions list, and the My Zoo shelf fed by real BeastNFT
 * mints (BeastMinted events + beastMeta), colored per sessionId (DAPP-31).
 */

import { formatEther } from "ethers";
import { WalletGate } from "../components/wallet/WalletGate";
import { ZooShelf } from "../components/beast/ZooShelf";
import { MySessions } from "../components/session/MySessions";
import { SocialSignInCard } from "../components/social/SocialSignInCard";
import { ProfileEditor } from "../components/social/ProfileEditor";
import { useSocialAuth } from "../social/useSocialAuth";
import { useWallet } from "../wallet/useWallet";
import { useAccountSessions } from "../contract/useAccountSessions";
import { useMyBeasts } from "../contract/useBeasts";
import { beastToEntry } from "../contract/nft";
import { computeAccountStats, formatMinutes } from "../components/session/statsView";
import "./ProfilePage.css";

/** Sample shelf is a dev/demo aid only (dev server or VITE_DEMO_MODE=true). */
const DEMO_MODE = import.meta.env.DEV || import.meta.env.VITE_DEMO_MODE === "true";

export function ProfilePage() {
  const social = useSocialAuth();
  const { account } = useWallet();
  const sessions = useAccountSessions();
  const beasts = useMyBeasts();

  const stats =
    sessions.rows !== null && account !== null
      ? computeAccountStats(
          sessions.rows.map((r) => r.session),
          account,
        )
      : null;

  const statCards = [
    { label: "Sessions succeeded", value: stats ? String(stats.succeeded) : "…" },
    { label: "Sessions failed", value: stats ? String(stats.failed) : "…" },
    {
      label: "Focus time banked",
      value: stats ? formatMinutes(stats.focusMinutes) : "…",
      sub: stats && stats.habitDays > 0 ? `+ ${stats.habitDays} habit days` : null,
    },
    {
      label: "Total forfeited",
      value: stats ? `${formatEther(stats.forfeitedWei)} ETH` : "…",
    },
  ];

  const beastEntries = beasts.beasts?.map(beastToEntry) ?? [];

  return (
    <WalletGate>
      <div className="profile">
        <h1>My Zoo</h1>

        {social.status === "signed-in" ? <ProfileEditor /> : <SocialSignInCard />}

        <section className="profile__stats">
          {statCards.map((s) => (
            <div key={s.label} className="card profile__stat">
              <span className="profile__stat-value mono">{s.value}</span>
              <span className="muted">{s.label}</span>
              {s.sub ? <span className="muted profile__stat-sub">{s.sub}</span> : null}
            </div>
          ))}
        </section>
        {sessions.error ? (
          <p className="field__error" role="alert">
            {sessions.error}{" "}
            <button type="button" className="button button--ghost" onClick={sessions.refresh}>
              Retry
            </button>
          </p>
        ) : null}

        <section className="card">
          <h2>My sessions</h2>
          <p className="muted">
            Every session this wallet created or joined, newest first — your
            way back into an in-flight session.
          </p>
          <MySessions />
        </section>

        <section className="card">
          <h2>Beast shelf</h2>
          <p className="muted">
            Untransferable beasts minted from completed sessions — tiered by
            declared duration (focus) or period days (habit).
          </p>
          {beasts.configError ? (
            <p className="muted">{beasts.configError}</p>
          ) : beasts.error ? (
            <div role="alert">
              <p className="field__error">{beasts.error}</p>
              <button type="button" className="button button--ghost" onClick={beasts.refresh}>
                Retry
              </button>
            </div>
          ) : beasts.beasts === null ? (
            <p className="muted">Loading your beasts from the chain…</p>
          ) : (
            <ZooShelf beasts={beastEntries} demoMode={DEMO_MODE} />
          )}
        </section>
      </div>
    </WalletGate>
  );
}
