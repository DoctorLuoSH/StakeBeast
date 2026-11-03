import { createContext } from "react";
import type { SocialProfile } from "../lib/socialApi";

export type SocialAuthStatus = "signed-out" | "validating" | "signing-in" | "signed-in";

export interface SocialAuthValue {
  /** VITE_API_BASE_URL is set — the social backend integration is built in. */
  configured: boolean;
  /** Wallet connected on the expected chain — login is possible. */
  walletReady: boolean;
  status: SocialAuthStatus;
  /** Validated JWT for the current wallet identity (null when signed out). */
  token: string | null;
  profile: SocialProfile | null;
  /** Human-readable error of the last failed action (sign-in / restore). */
  error: string | null;
  /** Sign in with the connected wallet (challenge → signature → JWT). */
  signIn: () => Promise<boolean>;
  /** Drop the session for the current identity. */
  signOut: () => void;
  /** Re-run the restore/validation pass (e.g. after the backend was down). */
  retryRestore: () => void;
  /** Re-fetch the profile of the current session. */
  refreshProfile: () => Promise<void>;
  setNickname: (nickname: string) => Promise<boolean>;
  changeAvatar: (file: Blob) => Promise<boolean>;
  /**
   * Feed any API error from social calls here: a 401 drops the session
   * (expired/revoked token) and returns true so the caller can stop.
   */
  noteApiError: (err: unknown) => boolean;
}

export const SocialAuthContext = createContext<SocialAuthValue | null>(null);
