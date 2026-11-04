/**
 * SocialSignInCard — the single social-login entry/gate (api-contract A.1).
 * Covers every state: backend not configured, wallet not ready, restoring,
 * signed out (sign-in button), signing in, and the signed-in summary
 * (avatar + nickname + sign out). Pages that need the session gate their
 * content on `status === "signed-in"` and render this card otherwise.
 */

import { useSocialAuth } from "../../social/useSocialAuth";
import { socialUrl } from "../../lib/socialApi";
import { shortAddress } from "../../lib/format";

export function SocialSignInCard() {
  const social = useSocialAuth();

  if (!social.configured) {
    return (
      <section className="card">
        <h2>Social sign-in</h2>
        <p className="muted">
          Social backend not configured — set VITE_API_BASE_URL in .env (see
          .env.example) to enable login, profiles, and check-in evidence.
        </p>
      </section>
    );
  }

  if (!social.walletReady) {
    return (
      <section className="card">
        <h2>Social sign-in</h2>
        <p className="muted">
          Connect your wallet on the expected network to sign in with a wallet
          signature.
        </p>
      </section>
    );
  }

  if (social.status === "signed-in" && social.profile) {
    return (
      <section className="card social-signin">
        <img
          className="social-signin__avatar"
          src={socialUrl(social.profile.avatarUrl)}
          alt=""
          width={40}
          height={40}
        />
        <div className="social-signin__who">
          <strong>{social.profile.nickname}</strong>
          <span className="muted mono">{shortAddress(social.profile.address)}</span>
        </div>
        <button type="button" className="button button--ghost" onClick={social.signOut}>
          Sign out
        </button>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Social sign-in</h2>
      <p className="muted">
        One wallet signature opens check-in uploads, your profile, and the
        supervisor review list. No password — the signature only proves this
        wallet.
      </p>
      {social.status === "validating" ? (
        <p className="muted">Restoring the login session…</p>
      ) : (
        <button
          type="button"
          className="button"
          disabled={social.status === "signing-in"}
          onClick={() => void social.signIn()}
        >
          {social.status === "signing-in"
            ? "Confirm the signature in your wallet…"
            : "Sign in with wallet"}
        </button>
      )}
      {social.error ? (
        <p className="field__error" role="alert">
          {social.error}{" "}
          <button type="button" className="button button--ghost" onClick={social.retryRestore}>
            Retry
          </button>
        </p>
      ) : null}
    </section>
  );
}
