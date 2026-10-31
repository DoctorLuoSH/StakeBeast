/**
 * Proof-service client (api-contract §B wire shapes, attester src/core.ts).
 *
 * Two layers:
 *  - `obtainAttestation` — the DAPP-38 settle seam: self-contained
 *    challenge → bind → poll for the completion attestation.
 *  - the DAPP-35 full protocol client: `bindProofSession` + `createProofClient`
 *    (arm / heartbeat / event / status) for the focus page's tracking loop.
 *
 * Frozen shapes: refusal/pending are state payloads ({state:"pending"} 425 /
 * {state:"refused", reason} 409) on the attestation endpoint, everything else
 * uses the {error:{code,message}} envelope.
 */

export type ProofErrorKind = "unavailable" | "refused" | "timeout" | "bad-response" | "revoked";

export class ProofServiceError extends Error {
  readonly kind: ProofErrorKind;

  constructor(message: string, kind: ProofErrorKind) {
    super(message);
    this.name = "ProofServiceError";
    this.kind = kind;
  }
}

export interface Attestation {
  typedData: unknown;
  signature: string;
}

interface BindChallenge {
  nonce: string;
  message: string;
}

async function post<T>(baseUrl: string, path: string, body: unknown, token?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ProofServiceError("The proof service is unreachable.", "unavailable");
  }
  const json = (await res.json().catch(() => null)) as { message?: string } | null;
  if (!res.ok) {
    throw new ProofServiceError(
      json?.message ?? `Proof service answered ${res.status}.`,
      "bad-response",
    );
  }
  return json as T;
}

export interface ObtainAttestationOptions {
  baseUrl: string;
  chainId: number;
  contractAddress: string;
  sessionId: bigint;
  address: string;
  /** EIP-191 personal_sign over the bind challenge message. */
  signMessage: (message: string) => Promise<string>;
  /** Polling budget while the service finalizes coverage (425 pending). */
  maxPolls?: number;
  intervalMs?: number;
}

/**
 * Bind the connected wallet to the session and fetch the completion
 * attestation. Throws ProofServiceError("refused") when the service refuses
 * (violation / insufficient coverage) and ("timeout") when still pending
 * after the polling budget.
 */
export async function obtainAttestation(
  opts: ObtainAttestationOptions,
): Promise<Attestation> {
  const { baseUrl, chainId, contractAddress, address, signMessage } = opts;
  const sessionId = opts.sessionId.toString();

  const challenge = await post<BindChallenge>(baseUrl, "/v1/bind/challenge", {
    chainId,
    contract: contractAddress,
    sessionId,
    address,
  });
  const bindSig = await signMessage(challenge.message);
  const bind = await post<{ clientToken: string }>(baseUrl, "/v1/bind", {
    chainId,
    contract: contractAddress,
    sessionId,
    address,
    nonce: challenge.nonce,
    bindSig,
  });

  const maxPolls = opts.maxPolls ?? 15;
  const intervalMs = opts.intervalMs ?? 2000;
  for (let i = 0; i < maxPolls; i++) {
    let res: Response;
    const query = `?chainId=${chainId}&contract=${contractAddress}`;
    try {
      res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/attestation${query}`, {
        headers: { authorization: `Bearer ${bind.clientToken}` },
      });
    } catch {
      throw new ProofServiceError("The proof service is unreachable.", "unavailable");
    }
    const body = (await res.json().catch(() => null)) as
      | (Partial<Attestation> & { state?: string; reason?: string })
      | null;
    if (res.status === 200 && body?.signature) {
      return { typedData: body.typedData, signature: body.signature };
    }
    if (res.status === 425) {
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    if (res.status === 409 && body?.state === "refused") {
      throw new ProofServiceError(
        `The proof service refused to attest: ${body.reason ?? "no reason given"}.`,
        "refused",
      );
    }
    throw new ProofServiceError(
      `Proof service answered ${res.status}.`,
      "bad-response",
    );
  }
  throw new ProofServiceError(
    "The proof service has not finalized the attestation yet — try again shortly.",
    "timeout",
  );
}

/* ------------------------------------------------------------------ */
/* Full protocol client (DAPP-35): bind / arm / heartbeat / event /   */
/* status — the focus page's tracking loop drives these.              */
/* ------------------------------------------------------------------ */

/** Service-side session lifecycle (attester core `lifecycleOf`). */
export type ProofLifecycle =
  | "ready"
  | "arming"
  | "monitoring"
  | "clean"
  | "violation"
  | "uncertifiable"
  | "refused"
  | "attested";

/** Page-event types accepted by POST /v1/event. */
export type ProofEventType = "visibility_hidden" | "visibility_visible" | "client_shutdown";

/** Result of a successful one-time challenge bind. */
export interface ProofBinding {
  clientToken: string;
  lifecycle: ProofLifecycle;
  /** First seq this client must use; resumes across reconnects/re-binds. */
  nextHeartbeatSeq: number;
}

export interface ProofParticipant {
  address: string;
  bound: boolean;
  boundAt: string | null;
  ready: boolean;
  lastHeartbeatAt: string | null;
  /** Violation reason when this participant broke coverage; null otherwise. */
  violation: string | null;
}

export interface ProofStatus {
  sessionId: string;
  lifecycle: ProofLifecycle;
  participants: ProofParticipant[];
  attestationReady: boolean;
  nextHeartbeatSeq: number;
}

/** Bearer-token client for one bound (session, participant). */
export interface ProofClient {
  /** Announce the startSession transaction; resolves to the ACTUAL state. */
  arm(txHash: string): Promise<ProofLifecycle>;
  /** One liveness beat; `violation` is the service-confirmed flag. */
  heartbeat(seq: number): Promise<{ violation: boolean }>;
  /** Page event with caller-generated dedup id (AC-29). */
  event(eventId: string, type: ProofEventType): Promise<{ violation: boolean }>;
  /** Full status payload for the bound participant. */
  status(): Promise<ProofStatus>;
}

interface RawReply {
  status: number;
  body: unknown;
}

/** fetch wrapper that never throws on HTTP status — only on transport failure. */
async function rawRequest(
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<RawReply> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ProofServiceError("The proof service is unreachable.", "unavailable");
  }
  const body = (await res.json().catch(() => null)) as unknown;
  return { status: res.status, body };
}

/** Map a non-2xx reply to a ProofServiceError (401 = token revoked / takeover). */
function fail(reply: RawReply): never {
  const envelope = (reply.body as { error?: { code?: string; message?: string } } | null)?.error;
  const message = envelope?.message ?? `Proof service answered ${reply.status}.`;
  if (reply.status === 401) {
    throw new ProofServiceError(
      "This client was revoked — the session is now tracked by another tab or device.",
      "revoked",
    );
  }
  throw new ProofServiceError(message, "bad-response");
}

/**
 * One-time challenge bind: challenge → wallet signature → bind. A successful
 * bind revokes any previous token for this (session, participant) — the
 * single-client takeover mechanism.
 */
export async function bindProofSession(opts: {
  baseUrl: string;
  chainId: number;
  contractAddress: string;
  sessionId: bigint;
  address: string;
  /** EIP-191 personal_sign over the bind challenge message. */
  signMessage: (message: string) => Promise<string>;
}): Promise<ProofBinding> {
  const { baseUrl, chainId, contractAddress, address, signMessage } = opts;
  const sessionId = opts.sessionId.toString();
  const base = { chainId, contract: contractAddress, sessionId, address };

  const challengeReply = await rawRequest(baseUrl, "/v1/bind/challenge", { body: base });
  if (challengeReply.status !== 200) fail(challengeReply);
  const challenge = challengeReply.body as { nonce: string; message: string };

  const bindSig = await signMessage(challenge.message);
  const bindReply = await rawRequest(baseUrl, "/v1/bind", {
    body: { ...base, nonce: challenge.nonce, bindSig },
  });
  if (bindReply.status !== 200) fail(bindReply);
  const bind = bindReply.body as {
    clientToken: string;
    status: ProofLifecycle;
    nextHeartbeatSeq: number;
  };
  return {
    clientToken: bind.clientToken,
    lifecycle: bind.status,
    nextHeartbeatSeq: bind.nextHeartbeatSeq,
  };
}

/** Build the Bearer-token protocol client for one binding. */
export function createProofClient(opts: {
  baseUrl: string;
  chainId: number;
  contractAddress: string;
  sessionId: bigint;
  token: string;
}): ProofClient {
  const { baseUrl, chainId, contractAddress, token } = opts;
  const sessionId = opts.sessionId.toString();
  const sessionQuery = `chainId=${chainId}&contract=${contractAddress}`;

  return {
    async arm(txHash) {
      const reply = await rawRequest(baseUrl, "/v1/arm", {
        token,
        body: { sessionId, txHash },
      });
      if (reply.status !== 200) fail(reply);
      return (reply.body as { state: ProofLifecycle }).state;
    },

    async heartbeat(seq) {
      const reply = await rawRequest(baseUrl, "/v1/heartbeat", {
        token,
        body: { sessionId, seq, clientTs: new Date().toISOString() },
      });
      if (reply.status !== 200) fail(reply);
      return { violation: (reply.body as { violation: boolean }).violation };
    },

    async event(eventId, type) {
      const reply = await rawRequest(baseUrl, "/v1/event", {
        token,
        body: { sessionId, eventId, type, clientTs: new Date().toISOString() },
      });
      if (reply.status !== 200) fail(reply);
      return { violation: (reply.body as { violation: boolean }).violation };
    },

    async status() {
      const reply = await rawRequest(
        baseUrl,
        `/v1/sessions/${sessionId}/status?${sessionQuery}`,
        { token },
      );
      if (reply.status !== 200) fail(reply);
      const body = reply.body as {
        sessionId: string;
        state: ProofLifecycle;
        participants: ProofParticipant[];
        attestationReady: boolean;
        nextHeartbeatSeq: number;
      };
      return {
        sessionId: body.sessionId,
        lifecycle: body.state,
        participants: body.participants,
        attestationReady: body.attestationReady,
        nextHeartbeatSeq: body.nextHeartbeatSeq,
      };
    },
  };
}
