/**
 * A.3 check-ins, on-chain anchoring, and evidence media.
 *
 * Evidence integrity (R8): the uploaded photo's original bytes are stored
 * byte-identical under a content-addressed filename; the on-chain anchor is
 * the SHA-256 of exactly those bytes. Thumbnails are display-only and never
 * a verification input. Anchoring is verified against the chain: the
 * CheckedIn event must be emitted by the expected StakeBeast contract, for
 * the same session, by the caller, with the same evidenceHash AND periodIndex
 * — upload fields are never trusted on their own.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import { AbiCoder, getAddress } from 'ethers';
import multer from 'multer';
import sharp from 'sharp';
import { CHECKED_IN_TOPIC } from './chain/abi';
import type { ChainLog } from './chain/gateway';
import type { CheckinRow } from './db';
import { ApiError, asyncHandler } from './errors';
import { resolveParties } from './parties';
import { requireAuth } from './auth';
import { DECIMAL_RE, HASH_RE, IMAGE_MIME_EXT, newId, rfc3339, sha256hex } from './util';
import type { Ctx } from './types';

const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const THUMB_MAX_PX = 512;

function onchainOf(row: CheckinRow) {
  return {
    status: row.anchor_status,
    txHash: row.anchor_tx_hash,
    // On-chain numeric fields are decimal strings (api-contract line 28).
    blockNumber: row.anchor_block_number == null ? null : String(row.anchor_block_number),
  };
}

/** Wire shape shared by the check-in list and review latestCheckins. */
export function checkinJson(row: CheckinRow) {
  return {
    checkinId: row.checkin_id,
    periodIndex: row.period_index,
    evidenceHash: row.evidence_hash,
    createdAt: row.created_at,
    photoUrl: `/api/media/${row.checkin_id}`,
    thumbUrl: `/api/media/${row.checkin_id}?variant=thumb`,
    onchain: onchainOf(row),
  };
}

function parseCheckinFields(body: Record<string, unknown> | undefined) {
  const sessionId = body?.sessionId;
  if (typeof sessionId !== 'string' || !DECIMAL_RE.test(sessionId)) {
    throw new ApiError(400, 'bad_request', 'sessionId must be the on-chain uint256 as a decimal string');
  }
  const evidenceHash = body?.evidenceHash;
  if (typeof evidenceHash !== 'string' || !HASH_RE.test(evidenceHash)) {
    throw new ApiError(400, 'bad_request', 'evidenceHash must be a 0x-prefixed 32-byte hex string');
  }
  const raw = body?.periodIndex;
  const periodIndex = typeof raw === 'string' && DECIMAL_RE.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(periodIndex) || periodIndex < 0 || periodIndex > 65535) {
    throw new ApiError(400, 'bad_request', 'periodIndex must be an integer in [0, 65535]');
  }
  return { sessionId, evidenceHash, periodIndex };
}

/** Does this receipt log prove the anchor of `row` by `caller`? */
function matchesCheckedIn(
  log: ChainLog,
  contractAddress: string,
  row: CheckinRow,
  caller: string,
): boolean {
  try {
    // Must be emitted by the expected StakeBeast contract — not any contract.
    if (getAddress(log.address) !== getAddress(contractAddress)) return false;
    if (log.topics.length < 3) return false;
    if (log.topics[0].toLowerCase() !== CHECKED_IN_TOPIC.toLowerCase()) return false;
    if (BigInt(log.topics[1]).toString() !== row.session_id) return false;
    if (getAddress(`0x${log.topics[2].slice(26)}`).toLowerCase() !== caller.toLowerCase()) {
      return false;
    }
    const [hash, period] = AbiCoder.defaultAbiCoder().decode(['bytes32', 'uint16'], log.data);
    if (String(hash).toLowerCase() !== row.evidence_hash) return false;
    if (Number(period) !== row.period_index) return false;
    return true;
  } catch {
    return false;
  }
}

export function checkinRoutes(ctx: Ctx): Router {
  const router = Router();
  const auth = requireAuth(ctx.config.jwtSecret);

  const photoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: PHOTO_MAX_BYTES },
    fileFilter: (_req, file, cb) => {
      if (IMAGE_MIME_EXT[file.mimetype]) cb(null, true);
      else cb(new ApiError(400, 'bad_request', `unsupported image type: ${file.mimetype}`));
    },
  });

  router.post(
    '/checkins',
    auth,
    photoUpload.single('photo'),
    asyncHandler(async (req, res) => {
      const file = req.file;
      if (!file) {
        throw new ApiError(400, 'bad_request', 'multipart field "photo" (jpg/png/webp, <= 5 MB) is required');
      }
      const { sessionId, evidenceHash, periodIndex } = parseCheckinFields(req.body);
      const caller = res.locals.address as string;
      // The caller must be the session staker — verified against the chain at write time.
      let session;
      try {
        session = await ctx.cache.get(sessionId);
      } catch {
        throw new ApiError(404, 'not_found', 'session not found on chain');
      }
      if (session.staker.toLowerCase() !== caller.toLowerCase()) {
        throw new ApiError(403, 'forbidden', 'only the session staker can check in');
      }
      const sha = sha256hex(file.buffer);
      if (`0x${sha}` !== evidenceHash.toLowerCase()) {
        throw new ApiError(422, 'hash_mismatch', 'evidenceHash does not match the SHA-256 of the received photo bytes');
      }
      // Store the original bytes untouched, content-addressed; derive the thumb.
      const mediaDir = join(ctx.config.dataDir, 'media');
      await mkdir(join(mediaDir, 'thumbs'), { recursive: true });
      const ext = IMAGE_MIME_EXT[file.mimetype];
      await writeFile(join(mediaDir, `${sha}${ext}`), file.buffer);
      await sharp(file.buffer)
        .resize(THUMB_MAX_PX, THUMB_MAX_PX, { fit: 'inside', withoutEnlargement: true })
        .webp()
        .toFile(join(mediaDir, 'thumbs', `${sha}.webp`));
      const checkinId = newId();
      const createdAt = rfc3339();
      ctx.db.insertCheckin({
        checkin_id: checkinId,
        session_id: sessionId,
        staker: caller,
        period_index: periodIndex,
        evidence_hash: evidenceHash.toLowerCase(),
        sha256: sha,
        ext,
        content_type: file.mimetype,
        created_at: createdAt,
        anchor_status: 'pending',
        anchor_tx_hash: null,
        anchor_block_number: null,
      });
      res.status(201).json({ checkinId, createdAt });
    }),
  );

  router.post(
    '/checkins/:checkinId/anchor',
    auth,
    asyncHandler(async (req, res) => {
      const caller = res.locals.address as string;
      const row = ctx.db.getCheckin(req.params.checkinId);
      if (!row) throw new ApiError(404, 'not_found', 'check-in not found');
      if (row.staker.toLowerCase() !== caller.toLowerCase()) {
        throw new ApiError(403, 'forbidden', 'only the staker can anchor a check-in');
      }
      if (row.anchor_status === 'confirmed') {
        // Confirmed anchors are final; re-reporting is idempotent.
        res.json({ ok: true, onchain: onchainOf(row) });
        return;
      }
      const txHash = req.body?.txHash;
      if (typeof txHash !== 'string' || !HASH_RE.test(txHash)) {
        throw new ApiError(400, 'bad_request', 'txHash must be a 0x-prefixed 32-byte hex string');
      }
      const receipt = await ctx.gateway.getTransactionReceipt(txHash);
      if (!receipt) {
        // No receipt yet: persist the reported hash as the current pending
        // attempt, superseding any older one, so POST and GET agree. The
        // client re-POSTs the same hash once it mines to settle the anchor.
        ctx.db.updateAnchor(row.checkin_id, 'pending', txHash, null);
        res.json({ ok: false, onchain: { status: 'pending', txHash, blockNumber: null } });
        return;
      }
      const matched =
        receipt.status === 1 &&
        receipt.logs.some((log) => matchesCheckedIn(log, ctx.config.contractAddress, row, caller));
      const status = matched ? 'confirmed' : 'failed';
      ctx.db.updateAnchor(row.checkin_id, status, txHash, receipt.blockNumber);
      res.json({
        ok: matched,
        onchain: { status, txHash, blockNumber: String(receipt.blockNumber) },
      });
    }),
  );

  router.get(
    '/sessions/:sessionId/checkins',
    auth,
    asyncHandler(async (req, res) => {
      const sessionId = req.params.sessionId;
      if (!DECIMAL_RE.test(sessionId)) {
        throw new ApiError(400, 'bad_request', 'sessionId must be a decimal string');
      }
      const { parties } = await resolveParties(ctx.cache, sessionId);
      if (!parties.has((res.locals.address as string).toLowerCase())) {
        throw new ApiError(403, 'forbidden', 'only session parties can list check-ins');
      }
      res.json(ctx.db.listCheckins(sessionId).map(checkinJson));
    }),
  );

  router.get(
    '/media/:checkinId',
    auth,
    asyncHandler(async (req, res) => {
      const row = ctx.db.getCheckin(req.params.checkinId);
      if (!row) throw new ApiError(404, 'not_found', 'check-in not found');
      const { parties } = await resolveParties(ctx.cache, row.session_id);
      if (!parties.has((res.locals.address as string).toLowerCase())) {
        throw new ApiError(403, 'forbidden', 'only session parties can read evidence media');
      }
      const mediaDir = join(ctx.config.dataDir, 'media');
      res.setHeader('Cache-Control', 'private');
      if (req.query.variant === 'thumb') {
        // Display-only thumbnail; regenerated on demand, never a verification input.
        const thumbPath = join(mediaDir, 'thumbs', `${row.sha256}.webp`);
        if (!existsSync(thumbPath)) {
          await sharp(join(mediaDir, `${row.sha256}${row.ext}`))
            .resize(THUMB_MAX_PX, THUMB_MAX_PX, { fit: 'inside', withoutEnlargement: true })
            .webp()
            .toFile(thumbPath);
        }
        res.setHeader('Content-Type', 'image/webp');
        res.end(await readFile(thumbPath));
        return;
      }
      // The original bytes, byte-identical to the upload — the verification input.
      res.setHeader('Content-Type', row.content_type);
      res.end(await readFile(join(mediaDir, `${row.sha256}${row.ext}`)));
    }),
  );

  return router;
}
