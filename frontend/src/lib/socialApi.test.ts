/**
 * socialApi tests (DAPP-47) — the frozen error envelope maps to
 * SocialApiError with its code preserved, transport failure maps to
 * SocialUnavailableError, sha256Hex hashes the exact bytes, and socialUrl
 * resolves root-relative backend paths against the API origin.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// Must land before the module under test is imported (env.ts reads at load).
vi.hoisted(() => {
  import.meta.env.VITE_API_BASE_URL = "http://api.test/api";
});

import {
  SocialApiError,
  SocialUnavailableError,
  getMe,
  isSocialConfigured,
  loginChallenge,
  sha256Hex,
  socialUrl,
  uploadCheckin,
} from "./socialApi";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("configuration", () => {
  it("is configured via VITE_API_BASE_URL", () => {
    expect(isSocialConfigured()).toBe(true);
  });

  it("socialUrl resolves root-relative paths against the API origin", () => {
    expect(socialUrl("/api/avatars/0xABC")).toBe("http://api.test/api/avatars/0xABC");
    expect(socialUrl("http://elsewhere/x")).toBe("http://elsewhere/x");
  });
});

describe("request mapping", () => {
  it("parses a success payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, { nonce: "n1", message: "m", expiresAt: "2026-11-03T00:00:00Z" }),
      ),
    );
    const challenge = await loginChallenge("0x0000000000000000000000000000000000000001");
    expect(challenge.nonce).toBe("n1");
  });

  it("maps the frozen error envelope to SocialApiError with the code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: { code: "nonce_used", message: "used" } })),
    );
    const err = await getMe("tok").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialApiError);
    expect((err as SocialApiError).status).toBe(401);
    expect((err as SocialApiError).code).toBe("nonce_used");
    expect((err as SocialApiError).message).toBe("used");
  });

  it("maps a transport failure to SocialUnavailableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(getMe("tok")).rejects.toBeInstanceOf(SocialUnavailableError);
  });

  it("sends the Bearer token and multipart fields untouched", async () => {
    const spy = vi.fn(async () => jsonResponse(201, { checkinId: "c1", createdAt: "t" }));
    vi.stubGlobal("fetch", spy);
    const photo = new Blob(["photo-bytes"], { type: "image/png" });
    await uploadCheckin("tok-1", {
      sessionId: "7",
      evidenceHash: "0xabc",
      periodIndex: 2,
      photo,
    });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/api/checkins");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
    const form = init.body as FormData;
    expect(form.get("sessionId")).toBe("7");
    expect(form.get("evidenceHash")).toBe("0xabc");
    expect(form.get("periodIndex")).toBe("2");
    // The photo bytes pass through unmodified (R8: byte-identical upload).
    expect(await (form.get("photo") as Blob).text()).toBe("photo-bytes");
    // No JSON content-type on multipart — the browser sets the boundary.
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });
});

describe("sha256Hex", () => {
  it("hashes the exact bytes (SHA-256 known vectors)", () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
