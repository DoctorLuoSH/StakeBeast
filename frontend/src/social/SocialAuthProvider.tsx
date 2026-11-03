/**
 * SocialAuthProvider — wallet-signature login state for the social backend
 * (api-contract A.1): challenge → personal_sign → JWT (24 h). The session is
 * bound to the exact wallet identity (chain + account): switching the
 * account or network drops the in-memory token immediately; a stored token
 * for the new identity is re-validated via GET /profiles/me before use, and
 * any 401 (expired / revoked) drops it for good.
 *
 * Race safety: state is keyed by the identity that produced it and every
 * async publish re-checks a sequence counter, so a late restore/sign-in
 * response from a previous account can never authenticate the current one.
 * All state transitions happen in async continuations — effects stay free of
 * synchronous setState (the repo's zero-warning lint bar).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useWallet } from "../wallet/useWallet";
import {
  SocialApiError,
  SocialUnavailableError,
  getMe,
  isSocialConfigured,
  loginChallenge,
  loginVerify,
  updateNickname,
  uploadAvatar,
} from "../lib/socialApi";
import type { SocialProfile } from "../lib/socialApi";
import { dropToken, loadToken, saveToken } from "./tokenStore";
import { SocialAuthContext } from "./socialAuthContext";
import type { SocialAuthStatus, SocialAuthValue } from "./socialAuthContext";

interface Session {
  /** `${chainId}:${addressLower}` — the identity the token belongs to. */
  identity: string;
  token: string;
  profile: SocialProfile;
}

/** Restore pass state for one identity (validating + last restore error). */
interface Restore {
  identity: string;
  pending: boolean;
  error: string | null;
}

/** Sign-in pass state for one identity (in flight + last sign-in error). */
interface SignIn {
  identity: string;
  pending: boolean;
  error: string | null;
}

/** Error raised by a profile mutation (nickname / avatar), keyed likewise. */
interface Notice {
  identity: string;
  message: string;
}

export function SocialAuthProvider({ children }: { children: ReactNode }) {
  const { account, chainId, isExpectedChain, provider } = useWallet();
  const configured = isSocialConfigured();
  const identity =
    configured && account && chainId !== null && isExpectedChain
      ? `${chainId}:${account.toLowerCase()}`
      : null;
  const address = identity !== null ? account : null;

  const [session, setSession] = useState<Session | null>(null);
  const [restore, setRestore] = useState<Restore | null>(null);
  const [signInState, setSignInState] = useState<SignIn | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const seqRef = useRef(0);
  const [restoreTick, setRestoreTick] = useState(0);

  const current = session !== null && session.identity === identity ? session : null;
  const restoreNow = restore !== null && restore.identity === identity ? restore : null;
  const signInNow = signInState !== null && signInState.identity === identity ? signInState : null;
  const noticeNow = notice !== null && notice.identity === identity ? notice : null;

  // Restore + validate the stored token whenever the wallet identity changes.
  useEffect(() => {
    if (identity === null || address === null || chainId === null) return;
    const stored = loadToken(chainId, address);
    if (stored === null) return;
    const seq = ++seqRef.current;
    void (async () => {
      // Defer past the effect body: state transitions stay async.
      await Promise.resolve();
      if (seqRef.current !== seq) return;
      setRestore({ identity, pending: true, error: null });
      try {
        const profile = await getMe(stored);
        if (seqRef.current !== seq) return;
        setSession({ identity, token: stored, profile });
        setRestore({ identity, pending: false, error: null });
      } catch (err) {
        if (seqRef.current !== seq) return;
        if (err instanceof SocialApiError && err.status === 401) {
          // Expired/revoked token — dropped, a fresh signature is required.
          dropToken(chainId, address);
          setRestore({ identity, pending: false, error: null });
          return;
        }
        setRestore({
          identity,
          pending: false,
          error: err instanceof Error ? err.message : "Could not restore the login session.",
        });
      }
    })();
  }, [identity, address, chainId, restoreTick]);

  const expire = useCallback(() => {
    if (address && chainId !== null) dropToken(chainId, address);
    if (identity !== null) {
      setSession(null);
      setNotice({ identity, message: "Login session expired — sign in again." });
    }
  }, [address, chainId, identity]);

  const noteApiError = useCallback(
    (err: unknown): boolean => {
      if (err instanceof SocialApiError && err.status === 401) {
        expire();
        return true;
      }
      return false;
    },
    [expire],
  );

  const signIn = useCallback(async (): Promise<boolean> => {
    if (identity === null || address === null || chainId === null || !provider) return false;
    const seq = ++seqRef.current;
    setSignInState({ identity, pending: true, error: null });
    try {
      const challenge = await loginChallenge(address);
      const signature = await (await provider.getSigner()).signMessage(challenge.message);
      const { token, profile } = await loginVerify(address, signature);
      if (seqRef.current !== seq) return false; // identity changed mid-flight
      saveToken(chainId, address, token);
      setSession({ identity, token, profile });
      setSignInState(null);
      return true;
    } catch (err) {
      if (seqRef.current !== seq) return false;
      const code = (err as { code?: string })?.code;
      const message =
        code === "ACTION_REJECTED"
          ? "Signature request was rejected in the wallet."
          : err instanceof SocialUnavailableError
            ? err.message
            : err instanceof SocialApiError
              ? `Sign-in failed: ${err.message}`
              : "Sign-in failed — retry.";
      setSignInState({ identity, pending: false, error: message });
      return false;
    }
  }, [identity, address, chainId, provider]);

  const signOut = useCallback(() => {
    if (address && chainId !== null) dropToken(chainId, address);
    setSession(null);
    setNotice(null);
  }, [address, chainId]);

  const refreshProfile = useCallback(async () => {
    if (!current || identity === null) return;
    try {
      const profile = await getMe(current.token);
      setSession((s) => (s && s.identity === identity ? { ...s, profile } : s));
    } catch (err) {
      noteApiError(err);
    }
  }, [current, identity, noteApiError]);

  const setNickname = useCallback(
    async (nickname: string): Promise<boolean> => {
      if (!current || identity === null) return false;
      try {
        const profile = await updateNickname(current.token, nickname);
        setSession((s) => (s && s.identity === identity ? { ...s, profile } : s));
        return true;
      } catch (err) {
        if (!noteApiError(err)) {
          setNotice({
            identity,
            message: err instanceof Error ? err.message : "Could not update the nickname.",
          });
        }
        return false;
      }
    },
    [current, identity, noteApiError],
  );

  const changeAvatar = useCallback(
    async (file: Blob): Promise<boolean> => {
      if (!current || identity === null) return false;
      try {
        await uploadAvatar(current.token, file);
        const profile = await getMe(current.token);
        setSession((s) => (s && s.identity === identity ? { ...s, profile } : s));
        return true;
      } catch (err) {
        if (!noteApiError(err)) {
          setNotice({
            identity,
            message: err instanceof Error ? err.message : "Could not upload the avatar.",
          });
        }
        return false;
      }
    },
    [current, identity, noteApiError],
  );

  const status: SocialAuthStatus = current
    ? "signed-in"
    : signInNow?.pending
      ? "signing-in"
      : restoreNow?.pending
        ? "validating"
        : "signed-out";

  const error = signInNow?.error ?? restoreNow?.error ?? noticeNow?.message ?? null;

  const value: SocialAuthValue = useMemo(
    () => ({
      configured,
      walletReady: identity !== null,
      status,
      token: current?.token ?? null,
      profile: current?.profile ?? null,
      error,
      signIn,
      signOut,
      retryRestore: () => setRestoreTick((t) => t + 1),
      refreshProfile,
      setNickname,
      changeAvatar,
      noteApiError,
    }),
    [
      configured,
      identity,
      status,
      current,
      error,
      signIn,
      signOut,
      refreshProfile,
      setNickname,
      changeAvatar,
      noteApiError,
    ],
  );

  return <SocialAuthContext.Provider value={value}>{children}</SocialAuthContext.Provider>;
}
