/**
 * EIP-712 completion-proof signer — INTERFACE AND CONFIG PLACEHOLDER ONLY.
 *
 * The typed-data domain and message fields are frozen in DAPP-2 (api-contract.md)
 * together with Forge (contracts). Until then this module defines the seam the
 * HTTP layer calls, and refuses to produce signatures. Alignment notes captured
 * so far (from baseline v1.4, NOT final):
 *  - the proof attests a clean session over the full declared [startTime, endTime];
 *  - settlement (AC-02) must reject proofs for another address/session/chain and
 *    replayed or expired proofs, so the message will likely carry at least the
 *    session id, participant, startTime, endTime and a deadline;
 *  - the service key has no transfer authority; it only signs.
 *
 * TODO(DAPP-2): freeze domain { name, version, chainId, verifyingContract } and
 * the CompletionProof message type; implement with ethers v6 TypedDataEncoder.
 */

import type { SessionState } from './judgment';
import type { Config } from './config';

export interface CompletionProof {
  sessionId: string;
  participant: string;
  startTime: number;
  endTime: number;
  /** EIP-712 signature over the frozen typed-data structure. */
  signature: string;
}

export interface Signer {
  /** True once ATTESTER_PRIVATE_KEY is configured and DAPP-2 fields are frozen. */
  readonly ready: boolean;
  signCompletionProof(session: SessionState): Promise<CompletionProof>;
}

export function createSigner(config: Config): Signer {
  return {
    ready: config.attesterPrivateKey !== undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async signCompletionProof(_session: SessionState): Promise<CompletionProof> {
      // TODO(DAPP-2): build typed data from the frozen domain/message fields and
      // sign with config.attesterPrivateKey via ethers v6.
      throw new Error('EIP-712 proof signing is not implemented yet: domain and message fields are frozen in DAPP-2');
    },
  };
}
