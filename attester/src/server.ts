/**
 * HTTP wiring (attester-service §4, api-contract §B — frozen shapes).
 *
 *   POST /v1/bind/challenge   issue single-use 5-min bind challenge (no Bearer)
 *   POST /v1/bind             verify challenge signature, issue clientToken (no Bearer)
 *   POST /v1/arm              Bearer; startSession submitted → arming
 *   POST /v1/heartbeat        Bearer; 5 s cadence liveness
 *   POST /v1/event            Bearer; visibility / shutdown events
 *   GET  /v1/sessions/:id/status       Bearer, participants only
 *   GET  /v1/sessions/:id/attestation  Bearer; EIP-712 proof / 409 refused / 425 pending
 *   GET  /health              liveness + signer/chain readiness (operator use)
 *
 * Error envelope: {error: {code, message}} with the frozen code set.
 */

import express, { type Express, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { ApiError, type AttesterCore } from './core';

export interface ServerOptions {
  port: number;
  corsOrigin: string;
  sweepIntervalMs?: number;
  watchIntervalMs?: number;
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export function createApp(core: AttesterCore, opts: ServerOptions): Express {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // Local-dev CORS (browser frontend on another port); allowlist via env.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', opts.corsOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const auth = (req: Request, res: Response) => {
    const ctx = core.authenticate(req.header('authorization'));
    if (!ctx) {
      res.status(401).json(errorBody('unauthorized', 'missing or invalid client token'));
      return null;
    }
    return ctx;
  };

  const handle = (fn: (req: Request, res: Response) => Promise<void> | void) => {
    return async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (err) {
        if (err instanceof ApiError) {
          res.status(err.status).json(errorBody(err.code, err.message));
        } else if (err instanceof SyntaxError) {
          res.status(400).json(errorBody('bad_request', 'invalid JSON body'));
        } else {
          console.error('[http]', err);
          res.status(500).json(errorBody('internal', 'internal error'));
        }
      }
    };
  };

  app.get('/health', (_req, res) => {
    res.json({ ok: true, runId: core.store.runId, signer: core.signer.address });
  });

  app.post(
    '/v1/bind/challenge',
    handle((req, res) => {
      res.json(core.createChallenge(req.body ?? {}));
    }),
  );

  app.post(
    '/v1/bind',
    handle(async (req, res) => {
      res.json(await core.bind(req.body ?? {}));
    }),
  );

  app.post(
    '/v1/arm',
    handle(async (req, res) => {
      const ctx = auth(req, res);
      if (!ctx) return;
      res.json(await core.arm(ctx, req.body ?? {}));
    }),
  );

  app.post(
    '/v1/heartbeat',
    handle((req, res) => {
      const ctx = auth(req, res);
      if (!ctx) return;
      res.json(core.heartbeat(ctx, req.body ?? {}));
    }),
  );

  app.post(
    '/v1/event',
    handle((req, res) => {
      const ctx = auth(req, res);
      if (!ctx) return;
      res.json(core.event(ctx, req.body ?? {}));
    }),
  );

  app.get(
    '/v1/sessions/:id/status',
    handle((req, res) => {
      const ctx = auth(req, res);
      if (!ctx) return;
      res.json(core.status(ctx, req.params.id, req.query));
    }),
  );

  app.get('/v1/sessions/:id/attestation', async (req, res) => {
    try {
      const ctx = auth(req, res);
      if (!ctx) return;
      res.json(await core.attestation(ctx, req.params.id, req.query));
    } catch (err) {
      // Frozen wire shape (api-contract §B): refusal/pending are state
      // payloads, not the error envelope.
      if (err instanceof ApiError && err.status === 409 && err.code === 'refused') {
        res.status(409).json({ state: 'refused', reason: err.message });
      } else if (err instanceof ApiError && err.status === 425) {
        res.status(425).json({ state: 'pending' });
      } else if (err instanceof ApiError) {
        res.status(err.status).json(errorBody(err.code, err.message));
      } else {
        console.error('[http]', err);
        res.status(500).json(errorBody('internal', 'internal error'));
      }
    }
  });

  app.use((_req, res) => {
    res.status(404).json(errorBody('not_found', 'unknown route'));
  });

  // Body-parse failures land here (Express default handler would send HTML).
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      res.status(400).json(errorBody('bad_request', 'invalid JSON body'));
      return;
    }
    console.error('[http]', err);
    res.status(500).json(errorBody('internal', 'internal error'));
  });

  return app;
}

export interface RunningServer {
  server: Server;
  stop: () => Promise<void>;
}

export function startServer(core: AttesterCore, opts: ServerOptions): Promise<RunningServer> {
  const app = createApp(core, opts);
  const sweepMs = opts.sweepIntervalMs ?? 1_000;
  const watchMs = opts.watchIntervalMs ?? 2_000;

  core.recoverOnBoot();

  const sweeper = setInterval(() => {
    try {
      core.sweepAll();
    } catch (err) {
      console.error('[sweeper]', err);
    }
  }, sweepMs);
  sweeper.unref();

  let watching = false;
  const watcher = setInterval(() => {
    if (watching) return; // never overlap poll iterations
    watching = true;
    core
      .watchOnce()
      .catch((err) => console.error('[watcher]', err))
      .finally(() => {
        watching = false;
      });
  }, watchMs);
  watcher.unref();

  return new Promise((resolve) => {
    const server = app.listen(opts.port, () => {
      console.log(`[attester] listening on http://localhost:${opts.port} (data: ${core.store.dataDir})`);
      resolve({
        server,
        stop: () =>
          new Promise((done) => {
            clearInterval(sweeper);
            clearInterval(watcher);
            server.close(() => done());
          }),
      });
    });
  });
}
