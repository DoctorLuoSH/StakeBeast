/**
 * Minimal proof-service client — the reserved seam for DAPP-35.
 *
 * This wave needs only attestation retrieval for the settle call: challenge →
 * bind (one wallet signature) → poll the attestation endpoint. The full
 * startup protocol (one-time challenge binding at creation, arming, heartbeat
 * loop, proof-state-driven UI) is DAPP-35 scope and extends this module.
 *
 * Wire shapes follow the frozen api-contract §B: refusal/pending are state
 * payloads ({state:"pending"} 425 / {state:"refused", reason} 409), not the
 * error envelope.
 */

export class ProofServiceError extends Error {
  readonly kind: "unavailable" | "refused" | "timeout" | "bad-response";

  constructor(
    message: string,
    kind: "unavailable" | "refused" | "timeout" | "bad-response",
  ) {
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
