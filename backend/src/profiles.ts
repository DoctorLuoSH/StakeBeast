/**
 * A.2 profiles. First successful verify auto-provisions a profile with the
 * default nickname `beast-<last 4 hex chars>` and a deterministic generated
 * placeholder avatar. Nicknames are 1-32 chars with no HTML (`<` / `>`).
 * Avatars are re-encoded to 256x256 webp and served publicly.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { ApiError, asyncHandler } from './errors';
import { rfc3339 } from './util';
import { avatarPath, avatarUrl, generatePlaceholderAvatar, saveAvatarUpload } from './avatars';
import { parseAddress, requireAuth } from './auth';
import type { BackendDb, ProfileRow } from './db';
import type { Ctx } from './types';

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

interface MeProfile {
  address: string;
  nickname: string;
  avatarUrl: string;
  createdAt: string;
}

function publicProfile(row: ProfileRow) {
  return { address: row.address, nickname: row.nickname, avatarUrl: avatarUrl(row.address) };
}

function meProfile(row: ProfileRow): MeProfile {
  return { ...publicProfile(row), createdAt: row.created_at };
}

/** Fetch or auto-provision the profile for an address (first login). */
export async function ensureProfile(ctx: Ctx, address: string): Promise<MeProfile> {
  let row = ctx.db.getProfile(address);
  if (!row) {
    const nickname = `beast-${address.slice(-4).toLowerCase()}`;
    ctx.db.insertProfile(address, nickname, rfc3339());
    await generatePlaceholderAvatar(address, ctx.config.dataDir);
    row = ctx.db.getProfile(address) as ProfileRow;
  }
  return meProfile(row);
}

export function profileRoutes(ctx: Ctx): Router {
  const router = Router();
  const auth = requireAuth(ctx.config.jwtSecret);

  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: AVATAR_MAX_BYTES },
    fileFilter: (_req, file, cb) => {
      if (['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) cb(null, true);
      else cb(new ApiError(400, 'bad_request', `unsupported image type: ${file.mimetype}`));
    },
  });

  router.get(
    '/me',
    auth,
    asyncHandler(async (_req, res) => {
      res.json(await ensureProfile(ctx, res.locals.address as string));
    }),
  );

  router.put(
    '/me',
    auth,
    asyncHandler(async (req, res) => {
      const address = res.locals.address as string;
      const nickname = req.body?.nickname;
      if (
        typeof nickname !== 'string' ||
        nickname.length < 1 ||
        nickname.length > 32 ||
        /[<>]/.test(nickname)
      ) {
        throw new ApiError(400, 'bad_request', 'nickname must be 1-32 characters with no HTML');
      }
      await ensureProfile(ctx, address);
      ctx.db.updateNickname(address, nickname);
      res.json(meProfile(ctx.db.getProfile(address) as ProfileRow));
    }),
  );

  router.post(
    '/me/avatar',
    auth,
    avatarUpload.single('file'),
    asyncHandler(async (req, res) => {
      const address = res.locals.address as string;
      if (!req.file) {
        throw new ApiError(400, 'bad_request', 'multipart field "file" (png/jpg/webp, <= 2 MB) is required');
      }
      await ensureProfile(ctx, address);
      await saveAvatarUpload(req.file.buffer, address, ctx.config.dataDir);
      res.json({ avatarUrl: avatarUrl(address) });
    }),
  );

  router.get(
    '/:address',
    asyncHandler(async (req, res) => {
      const address = parseAddress(req.params.address);
      const row = ctx.db.getProfile(address);
      if (!row) throw new ApiError(404, 'not_found', 'profile not found');
      res.json(publicProfile(row));
    }),
  );

  return router;
}

/** Public avatar bytes (256x256 webp). Avatars are public like profiles. */
export function avatarHandler(ctx: Ctx): RequestHandler {
  return asyncHandler(async (req, res) => {
    const address = parseAddress(req.params.address);
    const path = avatarPath(ctx.config.dataDir, address);
    if (!existsSync(path)) throw new ApiError(404, 'not_found', 'avatar not found');
    const buf = await readFile(path);
    res.setHeader('Content-Type', 'image/webp');
    res.end(buf);
  });
}
