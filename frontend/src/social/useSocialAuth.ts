import { useContext } from "react";
import { SocialAuthContext } from "./socialAuthContext";
import type { SocialAuthValue } from "./socialAuthContext";

/** Access the shared social-auth state. Must be used under <SocialAuthProvider>. */
export function useSocialAuth(): SocialAuthValue {
  const ctx = useContext(SocialAuthContext);
  if (!ctx) {
    throw new Error("useSocialAuth must be used within <SocialAuthProvider>");
  }
  return ctx;
}
