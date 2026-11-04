/**
 * Protocol client tests (DAPP-35): bind challenge flow, Bearer-token calls,
 * and the error-kind mapping (401 → revoked / transport → unavailable) that
 * the tracker state machine keys on. fetch is mocked throughout.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { bindProofSession, createProofClient, ProofServiceError } from "./proofClient";

const BASE = "http://attester.test";
const CONTRACT = `0x${"1".repeat(40)}`;
const ADDRESS = `0x${"2".repeat(40)}`;
const COMMON = { baseUrl: BASE, chainId: 31337, contractAddress: CONTRACT, sessionId: 7n };

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Install a fetch mock from a handler; returns captured calls. */
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bindProofSession", () => {
  it("runs challenge → sign → bind and maps the binding", async () => {
    const calls = mockFetch((url) => {
      if (url.endsWith("/v1/bind/challenge")) {
        return reply(200, { nonce: "abc", message: "StakeBeast bind\nNonce: abc", expiresAt: "x" });
      }
      if (url.endsWith("/v1/bind")) {
        return reply(200, { clientToken: "ctk_1", status: "ready", nextHeartbeatSeq: 3 });
      }
      return reply(404, { error: { code: "not_found", message: "nope" } });
    });
    const seen: string[] = [];
    const binding = await bindProofSession({
      ...COMMON,
      address: ADDRESS,
      signMessage: async (m) => {
        seen.push(m);
        return "0xsignature";
      },
    });

    expect(binding).toEqual({ clientToken: "ctk_1", lifecycle: "ready", nextHeartbeatSeq: 3 });
    expect(seen).toEqual(["StakeBeast bind\nNonce: abc"]);
    const challengeCall = calls[0];
    expect(challengeCall.url).toBe(`${BASE}/v1/bind/challenge`);
    expect(JSON.parse(String(challengeCall.init?.body))).toEqual({
      chainId: 31337,
      contract: CONTRACT,
      sessionId: "7",
      address: ADDRESS,
    });
    const bindCall = calls[1];
    expect(JSON.parse(String(bindCall.init?.body))).toMatchObject({
      nonce: "abc",
      bindSig: "0xsignature",
    });
  });

  it("surfaces the envelope message on protocol errors", async () => {
    mockFetch(() => reply(400, { error: { code: "bad_request", message: "chainId mismatch" } }));
    const err = await bindProofSession({
      ...COMMON,
      address: ADDRESS,
      signMessage: async () => "0xsig",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProofServiceError);
    expect((err as ProofServiceError).kind).toBe("bad-response");
    expect((err as ProofServiceError).message).toBe("chainId mismatch");
  });
});

describe("createProofClient", () => {
  const client = createProofClient({ ...COMMON, token: "ctk_x" });

  it("heartbeat posts the seq with the Bearer token and maps violation", async () => {
    const calls = mockFetch(() => reply(200, { ok: true, violation: true }));
    const res = await client.heartbeat(5);
    expect(res).toEqual({ violation: true });
    const call = calls[0];
    expect(call.url).toBe(`${BASE}/v1/heartbeat`);
    expect(call.init?.headers).toMatchObject({ authorization: "Bearer ctk_x" });
    expect(JSON.parse(String(call.init?.body))).toMatchObject({ sessionId: "7", seq: 5 });
  });

  it("heartbeat 401 maps to kind revoked (single-client takeover)", async () => {
    mockFetch(() => reply(401, { error: { code: "unauthorized", message: "invalid token" } }));
    const err = await client.heartbeat(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProofServiceError);
    expect((err as ProofServiceError).kind).toBe("revoked");
  });

  it("transport failure maps to kind unavailable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const err = await client.heartbeat(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProofServiceError);
    expect((err as ProofServiceError).kind).toBe("unavailable");
  });

  it("arm returns the ACTUAL service state", async () => {
    mockFetch(() => reply(200, { ok: true, state: "arming" }));
    await expect(client.arm("0xtx")).resolves.toBe("arming");
  });

  it("event posts the dedup id and type", async () => {
    const calls = mockFetch(() => reply(200, { ok: true, violation: false }));
    const res = await client.event("evt-1", "visibility_hidden");
    expect(res).toEqual({ violation: false });
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      sessionId: "7",
      eventId: "evt-1",
      type: "visibility_hidden",
    });
  });

  it("status maps state → lifecycle and carries nextHeartbeatSeq", async () => {
    const calls = mockFetch(() =>
      reply(200, {
        sessionId: "7",
        state: "monitoring",
        participants: [
          {
            address: ADDRESS,
            bound: true,
            boundAt: "2026-10-31T00:00:00Z",
            ready: true,
            lastHeartbeatAt: null,
            violation: null,
          },
        ],
        attestationReady: false,
        nextHeartbeatSeq: 12,
      }),
    );
    const status = await client.status();
    expect(status.lifecycle).toBe("monitoring");
    expect(status.nextHeartbeatSeq).toBe(12);
    expect(status.participants).toHaveLength(1);
    expect(status.participants[0].bound).toBe(true);
    expect(calls[0].url).toBe(
      `${BASE}/v1/sessions/7/status?chainId=31337&contract=${CONTRACT}`,
    );
  });
});
