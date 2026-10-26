/**
 * A.1 wallet-signature login. Challenge: `StakeBeast login\nAddress: <addr>\n
 * Nonce: <nonce>\nIssued: <ts>`, valid 5 minutes, nonce single-use — consumed
 * on ANY verify attempt, success or failure. Verify: EIP-191 personal_sign
 * recovery must equal the address; issues a JWT HS256 with {sub, iat, exp}
 * valid 24 h, and auto-provisions the profile on first login.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { getAddress, verifyMessage } from 'ethers';
import jwt from 'jsonwebtoken';
import { ApiError, asyncHandler } from './errors';
import { newNonce, rfc3339 } from './util';
import { ensureProfile } from './profiles';
import type { Ctx } from './types';

const CHALLENGE_TTL_MS = 5 * 60_000;
export const TOKEN_TTL_SECONDS = 24 * 3600;

/** Validate and EIP-55-normalize an address from client input. */
export function parseAddress(input: unknown, field = 'address'): string {
  if (typeof input !== 'string') throw new ApiError(400, 'bad_request', `${field} is required`);
  try {
    return getAddress(input);
  } catch {
    throw new ApiError(400, 'bad_request', `${field} is not a valid Ethereum address`);
  }
}

/** Bearer-auth middleware; the verified EIP-55 address lands in res.locals.address. */
export function requireAuth(jwtSecret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new ApiError(401, 'unauthorized', 'missing bearer token');
    }
    try {
      const claims = jwt.verify(header.slice('Bearer '.length), jwtSecret, {
        algorithms: ['HS256'],
      }) as { sub?: string };
      if (!claims.sub) throw new Error('missing sub');
      res.locals.address = getAddress(claims.sub);
      next();
    } catch {
      throw new ApiError(401, 'unauthorized', 'invalid or expired token');
    }
  };
}

export function authRoutes(ctx: Ctx): Router {
  const router = Router();

  router.post(
    '/challenge',
    asyncHandler(async (req, res) => {
      const address = parseAddress(req.body?.address);
      const nonce = newNonce();
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
      const message = `StakeBeast login\nAddress: ${address}\nNonce: ${nonce}\nIssued: ${rfc3339(issuedAt)}`;
      ctx.db.insertChallenge({ nonce, address, message, expiresAt: rfc3339(expiresAt) });
      res.json({ nonce, message, expiresAt: rfc3339(expiresAt) });
    }),
  );

  router.post(
    '/verify',
    asyncHandler(async (req, res) => {
      const address = parseAddress(req.body?.address);
      const signature = req.body?.signature;
      if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
        throw new ApiError(400, 'bad_request', 'signature must be a 0x-prefixed hex string');
      }
      const challenge = ctx.db.latestChallenge(address);
      if (!challenge) {
        throw new ApiError(401, 'unauthorized', 'no login challenge for this address');
      }
      if (challenge.used) {
        throw new ApiError(401, 'nonce_used', 'challenge nonce already used');
      }
      // Single-use: consumed on any verify attempt, success or failure (AC-14).
      ctx.db.markChallengeUsed(challenge.nonce);
      if (Date.parse(challenge.expires_at) <= Date.now()) {
        throw new ApiError(401, 'challenge_expired', 'login challenge expired');
      }
      let recovered: string;
      try {
        recovered = verifyMessage(challenge.message, signature);
      } catch {
        throw new ApiError(401, 'unauthorized', 'malformed signature');
      }
      if (recovered.toLowerCase() !== address.toLowerCase()) {
        throw new ApiError(401, 'unauthorized', 'signature does not match address');
      }
      const profile = await ensureProfile(ctx, address);
      const token = jwt.sign({ sub: address }, ctx.config.jwtSecret, {
        algorithm: 'HS256',
        expiresIn: TOKEN_TTL_SECONDS,
      });
      res.json({ token, profile });
    }),
  );

  return router;
}
