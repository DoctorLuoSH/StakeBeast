/**
 * EIP-712 completion attestation (design freeze: contract-design.md §4).
 *
 * Domain: EIP712Domain(name="StakeBeast", version="1", chainId, verifyingContract).
 * Message (single type, covers SoloFocus and CoFocus):
 *   CompletionAttestation(uint256 sessionId, address staker, address partner,
 *                         uint64 startTime, uint64 endTime, uint64 expiry)
 * with expiry == session.settlementDeadline.
 *
 * The contract rebuilds the digest from stored session fields and requires the
 * recovered signer to equal the CURRENT on-chain attester — field mismatches
 * revert by construction, and rotation invalidates old signatures (R2).
 */

import { ethers, type TypedDataField } from 'ethers';

export const EIP712_DOMAIN_NAME = 'StakeBeast';
export const EIP712_DOMAIN_VERSION = '1';

export const COMPLETION_ATTESTATION_TYPES: Record<string, TypedDataField[]> = {
  CompletionAttestation: [
    { name: 'sessionId', type: 'uint256' },
    { name: 'staker', type: 'address' },
    { name: 'partner', type: 'address' },
    { name: 'startTime', type: 'uint64' },
    { name: 'endTime', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
  ],
};

export interface AttestationMessage {
  sessionId: string; // decimal string
  staker: string; // EIP-55
  partner: string; // EIP-55 or zero address
  startTime: number; // seconds
  endTime: number; // seconds
  expiry: number; // seconds == settlementDeadline
}

export interface TypedData {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: typeof COMPLETION_ATTESTATION_TYPES;
  primaryType: 'CompletionAttestation';
  message: AttestationMessage;
}

export function buildTypedData(
  chainId: number,
  verifyingContract: string,
  message: AttestationMessage,
): TypedData {
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId,
      verifyingContract: ethers.getAddress(verifyingContract),
    },
    types: COMPLETION_ATTESTATION_TYPES,
    primaryType: 'CompletionAttestation',
    message,
  };
}

export class AttestationSigner {
  readonly wallet: ethers.Wallet;

  constructor(privateKey: string) {
    this.wallet = new ethers.Wallet(privateKey);
  }

  get address(): string {
    return this.wallet.address;
  }

  /** Sign the attestation; returns the exact typed data plus the signature. */
  async sign(typedData: TypedData): Promise<string> {
    return this.wallet.signTypedData(typedData.domain, typedData.types, typedData.message);
  }
}

/** Recover the signer of an attestation (used by tests and diagnostics). */
export function recoverSigner(typedData: TypedData, signature: string): string {
  return ethers.verifyTypedData(typedData.domain, typedData.types, typedData.message, signature);
}
