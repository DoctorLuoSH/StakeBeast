/** Small shared helpers: time serialization, hashing, and input patterns. */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** RFC 3339 UTC string without milliseconds, matching the contract samples. */
export function rfc3339(d = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

export function newId(): string {
  return randomUUID();
}

/** On-chain uint256 session ids travel as decimal strings (api-contract line 28). */
export const DECIMAL_RE = /^\d+$/;

/** 0x-prefixed 32-byte hex (evidence hashes, transaction hashes). */
export const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** Accepted evidence/avatar image MIME types and their stored file extension. */
export const IMAGE_MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
