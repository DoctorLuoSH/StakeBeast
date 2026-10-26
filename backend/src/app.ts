/**
 * Express application factory. The router is mounted at /api so the endpoint
 * paths match the frozen contract (base URL http://localhost:4000/api).
 * All chain reads flow through the injected ChainGateway; all errors leave
 * in the frozen envelope `{error: {code, message}}`.
 */

import express, { type Express, type NextFunction, type Request, type Response, Router } from 'express';
import cors from 'cors';
import { MulterError } from 'multer';
import { rateLimit } from 'express-rate-limit';
import type { Config } from './config';
import type { BackendDb } from './db';
import type { ChainGateway } from './chain/gateway';
import { SessionCache } from './chain/sessionCache';
import { SessionIndexer } from './indexer';
import { ApiError } from './errors';
import { authRoutes } from './auth';
import { avatarHandler, profileRoutes } from './profiles';
import { checkinRoutes } from './checkins';
import { reviewRoutes } from './review';
import type { Ctx } from './types';

export interface AppDeps {
  config: Config;
  db: BackendDb;
  gateway: ChainGateway;
  /** Party-resolution / review staleness bound; 60 s per api-contract A.3. */
  sessionCacheTtlMs?: number;
  /** Min interval between SessionCreated scans; production default 15 s. */
  indexThrottleMs?: number;
  reviewPageSize?: number;
  /** Requests per minute per IP on /api/auth/* (100 per api-contract A.5). */
  authRateLimitMax?: number;
}

const DEFAULT_PAGE_SIZE = 20;

export function createApp(deps: AppDeps): Express {
  const { config, db, gateway } = deps;
  const sessionCacheTtlMs = deps.sessionCacheTtlMs ?? 60_000;
  const ctx: Ctx = {
    config,
    db,
    gateway,
    cache: new SessionCache(gateway, sessionCacheTtlMs),
    indexer: new SessionIndexer(db, gateway, {
      startBlock: config.indexerStartBlock,
      throttleMs: deps.indexThrottleMs ?? 15_000,
    }),
    sessionCacheTtlMs,
    reviewPageSize: deps.reviewPageSize ?? DEFAULT_PAGE_SIZE,
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.frontendOrigin.split(',').map((s) => s.trim()) }));
  app.use(express.json({ limit: '1mb' }));

  const api = Router();
  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  const authLimiter = rateLimit({
    windowMs: 60_000,
    limit: deps.authRateLimitMax ?? 100,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: { code: 'too_many_requests', message: 'rate limit exceeded, try again later' },
      });
    },
  });

  api.use('/auth', authLimiter, authRoutes(ctx));
  api.use('/profiles', profileRoutes(ctx));
  api.get('/avatars/:address', avatarHandler(ctx));
  api.use('/', checkinRoutes(ctx));
  api.use('/review', reviewRoutes(ctx));

  api.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'route not found' } });
  });
  app.use('/api', api);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
    } else if (err instanceof MulterError) {
      const tooLarge = err.code === 'LIMIT_FILE_SIZE';
      res.status(tooLarge ? 413 : 400).json({
        error: { code: 'bad_request', message: tooLarge ? 'file exceeds the size limit' : err.message },
      });
    } else if (err instanceof SyntaxError && (err as { status?: number }).status === 400) {
      res.status(400).json({ error: { code: 'bad_request', message: 'invalid JSON body' } });
    } else {
      console.error('[backend] unhandled error:', err);
      res.status(500).json({ error: { code: 'internal', message: 'internal error' } });
    }
  });

  return app;
}
