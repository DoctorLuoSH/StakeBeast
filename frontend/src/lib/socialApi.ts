/**
 * socialApi — the social backend REST client (api-contract §A, frozen v4.1).
 * Framework-free: React wiring lives in `social/SocialAuthProvider`, media
 * loading in `lib/useAuthedImage`. Every chain-truth check stays on the
 * contract client — this backend mirrors, never decides.
 *
 * Error model: the frozen envelope `{error: {code, message}}` maps to
 * SocialApiError (code preserved: unauthorized / nonce_used /
 * challenge_expired / hash_mismatch / …); a transport failure maps to
 * SocialUnavailableError so the UI can show "service unreachable" instead of
 * a bare TypeError.
 */

import { sha256 } from "ethers";
import { apiBaseUrl } from "../config/env";

/** Social backend is configured when VITE_API_BASE_URL is set. */
export function isSocialConfigured(): boolean {
  return apiBaseUrl.length > 0;
}

export class SocialApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SocialApiError";
    this.status = status;
    this.code = code;
  }
}

export class SocialUnavailableError extends Error {
  constructor() {
    super("Social backend unreachable — check that the service is running, then retry.");
    this.name = "SocialUnavailableError";
  }
}

interface RequestOptions {
  method?: string;
  /** JSON body (serialized) — mutually exclusive with `form`. */
  body?: unknown;
  /** multipart form body (no Content-Type header — the browser sets it). */
  form?: FormData;
  token?: string | null;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (!isSocialConfigured()) {
    throw new SocialUnavailableError();
  }
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body:
        opts.form !== undefined
          ? opts.form
          : opts.body !== undefined
            ? JSON.stringify(opts.body)
            : undefined,
    });
  } catch {
    throw new SocialUnavailableError();
  }

  if (!res.ok) {
    let code = "unknown";
    let message = `Request failed (${res.status})`;
    try {
      const parsed = (await res.json()) as { error?: { code?: string; message?: string } };
      if (parsed.error?.code) code = parsed.error.code;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new SocialApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ types -- */

export interface SocialProfile {
  address: string;
  nickname: string;
  avatarUrl: string;
  createdAt?: string;
}

export interface LoginChallenge {
  nonce: string;
  message: string;
  expiresAt: string;
}

export type AnchorStatus = "pending" | "confirmed" | "failed";

export interface CheckinOnchain {
  status: AnchorStatus;
  txHash: string | null;
  blockNumber: string | null;
}

export interface CheckinRecord {
  checkinId: string;
  periodIndex: number;
  evidenceHash: string;
  createdAt: string;
  photoUrl: string;
  thumbUrl: string;
  onchain: CheckinOnchain;
}

export interface ReviewItem {
  sessionId: string;
  staker: string;
  nickname: string | null;
  avatarUrl: string | null;
  criterion: string | null;
  periodDays: number | null;
  targetCount: number | null;
  latestCheckins: CheckinRecord[];
  /** Mirrored chain state: status = the on-chain enum (1 = Active). */
  onchain: { status: number | null; settlementDeadline: number | null };
}

/* ------------------------------------------------------------------- auth -- */

export function loginChallenge(address: string): Promise<LoginChallenge> {
  return request("/auth/challenge", { method: "POST", body: { address } });
}

export function loginVerify(
  address: string,
  signature: string,
): Promise<{ token: string; profile: SocialProfile }> {
  return request("/auth/verify", { method: "POST", body: { address, signature } });
}

/* --------------------------------------------------------------- profiles -- */

export function getMe(token: string): Promise<SocialProfile> {
  return request("/profiles/me", { token });
}

export function updateNickname(token: string, nickname: string): Promise<SocialProfile> {
  return request("/profiles/me", { method: "PUT", body: { nickname }, token });
}

export async function uploadAvatar(token: string, file: Blob): Promise<{ avatarUrl: string }> {
  const form = new FormData();
  form.append("file", file);
  return request("/profiles/me/avatar", { method: "POST", form, token });
}

export function getProfile(address: string, token?: string | null): Promise<SocialProfile> {
  return request(`/profiles/${address}`, { token });
}

/** Absolute URL of a backend-hosted path (avatar / media) for <img> use. */
export function socialUrl(path: string): string {
  if (!isSocialConfigured()) return path;
  // avatarUrl arrives root-relative to the API origin ("/api/avatars/0x…").
  const base = apiBaseUrl.endsWith("/api") ? apiBaseUrl.slice(0, -"/api".length) : apiBaseUrl;
  return path.startsWith("http") ? path : `${base}${path}`;
}

/* --------------------------------------------------------------- check-ins -- */

/**
 * SHA-256 of the exact bytes, 0x-prefixed — the evidence hash the client
 * anchors on-chain (R8: computed over the original file, never a re-encode).
 */
export function sha256Hex(bytes: Uint8Array): string {
  return sha256(bytes).toLowerCase();
}

export async function uploadCheckin(
  token: string,
  input: { sessionId: string; evidenceHash: string; periodIndex: number; photo: Blob },
): Promise<{ checkinId: string; createdAt: string }> {
  const form = new FormData();
  form.append("sessionId", input.sessionId);
  form.append("evidenceHash", input.evidenceHash);
  form.append("periodIndex", String(input.periodIndex));
  form.append("photo", input.photo);
  return request("/checkins", { method: "POST", form, token });
}

export function reportAnchor(
  token: string,
  checkinId: string,
  txHash: string,
): Promise<{ ok: boolean; onchain: CheckinOnchain }> {
  return request(`/checkins/${checkinId}/anchor`, { method: "POST", body: { txHash }, token });
}

export function listCheckins(token: string, sessionId: string): Promise<CheckinRecord[]> {
  return request(`/sessions/${sessionId}/checkins`, { token });
}

/**
 * Fetch authorized media (original bytes or thumb) with the Bearer token —
 * <img> cannot send Authorization, so media arrive as blobs (useAuthedImage).
 */
export async function fetchMedia(
  token: string,
  path: string,
): Promise<{ bytes: Uint8Array; blobUrl: string; contentType: string }> {
  if (!isSocialConfigured()) throw new SocialUnavailableError();
  let res: Response;
  try {
    res = await fetch(socialUrl(path), {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new SocialUnavailableError();
  }
  if (!res.ok) {
    let code = "unknown";
    let message = `Request failed (${res.status})`;
    try {
      const parsed = (await res.json()) as { error?: { code?: string; message?: string } };
      if (parsed.error?.code) code = parsed.error.code;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // keep generic
    }
    throw new SocialApiError(res.status, code, message);
  }
  const contentType = res.headers.get("Content-Type") ?? "application/octet-stream";
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, blobUrl: URL.createObjectURL(new Blob([bytes], { type: contentType })), contentType };
}

/* ----------------------------------------------------------------- review -- */

export function listReviewPending(token: string, cursor?: number): Promise<ReviewItem[]> {
  const query = cursor !== undefined ? `?cursor=${cursor}` : "";
  return request(`/review/pending${query}`, { token });
}
