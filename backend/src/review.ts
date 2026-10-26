/**
 * A.3 verifier review list: every Active session the caller verifies, with
 * the staker's profile, the session parameters, and the latest check-ins —
 * everything a supervisor needs to decide `verify`. Session discovery comes
 * from the mirrored SessionCreated index, refreshed against the chain when
 * served. Pagination is a simple opaque offset cursor.
 */

import { Router } from 'express';
import { ApiError, asyncHandler } from './errors';
import { avatarUrl } from './avatars';
import { requireAuth } from './auth';
import { checkinJson } from './checkins';
import { DECIMAL_RE } from './util';
import type { Ctx } from './types';

/** How many most-recent check-ins each review item embeds. */
const LATEST_CHECKINS = 10;

function parseCursor(input: unknown): number {
  if (typeof input === 'string' && DECIMAL_RE.test(input)) return Number(input);
  if (input == null) return 0;
  throw new ApiError(400, 'bad_request', 'cursor must be an opaque offset returned by a previous page');
}

export function reviewRoutes(ctx: Ctx): Router {
  const router = Router();
  const auth = requireAuth(ctx.config.jwtSecret);

  router.get(
    '/pending',
    auth,
    asyncHandler(async (req, res) => {
      const caller = res.locals.address as string;
      const offset = parseCursor(req.query.cursor);
      // Mirror, never decide: discover new sessions, then refresh stale rows.
      await ctx.indexer.syncThrottled();
      await ctx.indexer.refreshStale(ctx.sessionCacheTtlMs);
      const rows = ctx.db.mirrorActiveByVerifier(caller);
      const page = rows.slice(offset, offset + ctx.reviewPageSize);
      const items = page.map((m) => {
        const profile = ctx.db.getProfile(m.staker as string);
        const checkins = ctx.db.listCheckins(m.session_id);
        return {
          sessionId: m.session_id,
          staker: m.staker,
          nickname: profile ? profile.nickname : null,
          avatarUrl: profile ? avatarUrl(profile.address) : null,
          criterion: m.criterion,
          periodDays: m.period_days,
          targetCount: m.target_count,
          latestCheckins: checkins.slice(-LATEST_CHECKINS).map(checkinJson),
          onchain: { status: m.status, settlementDeadline: m.settlement_deadline },
        };
      });
      res.json(items);
    }),
  );

  return router;
}
