/**
 * HTTP API for the attestation service. Paths and payloads are the pre-freeze
 * working shape; the definitive frontend<->attester contract is DAPP-2
 * (api-contract.md) and this module will be aligned to it.
 *
 *   GET  /health                      liveness
 *   POST /sessions                    register a started on-chain session
 *                                     { sessionId, participant, startTime, durationMs }
 *   GET  /sessions/:id                current judgment state
 *   POST /sessions/:id/bind           bind the client { participant }
 *   POST /sessions/:id/heartbeat      heartbeat { participant }
 *   POST /sessions/:id/hidden         page-hidden event { participant }
 *   POST /sessions/:id/proof          request completion proof { participant }
 *
 * TODO(DAPP-2): on-chain registration verification (read startTime from the
 * contract instead of trusting the caller) and client request authentication.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Config } from './config';
import type { SessionStore } from './store';
import type { Signer } from './signer';
import {
  canIssueProof,
  createSession,
  endTime,
  evaluate,
  recordBind,
  recordHeartbeat,
  recordHidden,
  type SessionState,
} from './judgment';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

interface Deps {
  config: Config;
  store: SessionStore;
  signer: Signer;
  /** Injectable for tests; production passes Date.now. */
  now: () => number;
}

function publicState(s: SessionState, now: number) {
  return {
    sessionId: s.sessionId,
    participant: s.participant,
    startTime: s.startTime,
    endTime: endTime(s),
    durationMs: s.durationMs,
    bindTime: s.bindTime,
    lastHeartbeatAt: s.lastHeartbeatAt,
    violation: s.violation,
    violatedAt: s.violatedAt,
    issued: s.issued,
    canIssueProof: canIssueProof(s, now),
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

export function createAttesterServer(deps: Deps): Server {
  const { config, store, signer, now } = deps;

  // Sweeper: apply timeout judgment continuously so a >15s silence is flagged
  // even if the client never comes back. evaluate() dates the violation at
  // lastHeartbeatAt + 15s, so the result is identical to lazy evaluation.
  const sweeper = setInterval(() => {
    for (const s of store.list()) {
      if (s.bindTime === null || s.violation !== null) continue;
      const judged = evaluate(s, now());
      if (judged !== s) store.put(judged);
    }
  }, 1_000);
  sweeper.unref();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean); // e.g. ['sessions', ':id', 'bind']
      const body = req.method === 'POST' ? await readJson(req) : {};

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, signerReady: signer.ready });
      }

      if (req.method === 'POST' && url.pathname === '/sessions') {
        const { sessionId, participant, startTime, durationMs } = body;
        if (
          typeof sessionId !== 'string' || !sessionId ||
          typeof participant !== 'string' || !ADDRESS_RE.test(participant) ||
          typeof startTime !== 'number' || !Number.isFinite(startTime) ||
          typeof durationMs !== 'number' || !(durationMs > 0)
        ) {
          return send(res, 400, { error: 'invalid_body', detail: 'expected { sessionId: string, participant: 0x address, startTime: ms number, durationMs: positive number }' });
        }
        const existing = store.get(sessionId);
        if (existing) {
          const identical =
            existing.participant === participant.toLowerCase() &&
            existing.startTime === startTime &&
            existing.durationMs === durationMs;
          if (!identical) return send(res, 409, { error: 'session_conflict' });
          return send(res, 200, publicState(existing, now()));
        }
        const created = store.put(createSession(sessionId, participant, startTime, durationMs));
        return send(res, 201, publicState(created, now()));
      }

      if (parts[0] === 'sessions' && parts.length >= 2) {
        const session = store.get(decodeURIComponent(parts[1]));
        if (!session) return send(res, 404, { error: 'session_not_found' });

        if (req.method === 'GET' && parts.length === 2) {
          return send(res, 200, publicState(evaluate(session, now()), now()));
        }

        if (req.method === 'POST' && parts.length === 3 && parts[2] === 'bind') {
          const participant = typeof body.participant === 'string' ? body.participant : '';
          const result = recordBind(session, participant, now());
          store.put(result.state);
          if (!result.ok) {
            const status = result.reason === 'bind_window_expired' ? 403 : 409;
            return send(res, status, { error: result.reason, state: publicState(result.state, now()) });
          }
          return send(res, 200, publicState(result.state, now()));
        }

        if (req.method === 'POST' && parts.length === 3 && (parts[2] === 'heartbeat' || parts[2] === 'hidden')) {
          const participant = typeof body.participant === 'string' ? body.participant : '';
          const result =
            parts[2] === 'heartbeat'
              ? recordHeartbeat(session, participant, now())
              : recordHidden(session, participant, now());
          store.put(result.state);
          if (!result.ok) return send(res, 409, { error: result.reason, state: publicState(result.state, now()) });
          return send(res, 200, publicState(result.state, now()));
        }

        if (req.method === 'POST' && parts.length === 3 && parts[2] === 'proof') {
          const participant = typeof body.participant === 'string' ? body.participant : '';
          if (participant.toLowerCase() !== session.participant) {
            return send(res, 409, { error: 'wrong_participant' });
          }
          if (!canIssueProof(session, now())) {
            const judged = evaluate(session, now());
            store.put(judged);
            return send(res, 403, {
              error: 'proof_not_issuable',
              detail: 'fail-closed: session is unbound, violated, or the declared duration has not fully elapsed',
              state: publicState(judged, now()),
            });
          }
          // Eligible — but the EIP-712 fields are frozen in DAPP-2, so issuance is
          // not wired yet. `issued` is only set once a real signature is produced.
          return send(res, 501, { error: 'eip712_not_finalized', detail: 'EIP-712 domain/message fields are frozen in DAPP-2 (api-contract.md); signing lands in the next wave' });
        }
      }

      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      return send(res, err instanceof SyntaxError ? 400 : 500, { error: err instanceof SyntaxError ? 'invalid_json' : 'internal_error' });
    }
  });

  return server;
}

export function startServer(deps: Deps): Promise<Server> {
  const server = createAttesterServer(deps);
  return new Promise((resolve) => {
    server.listen(deps.config.port, () => {
      console.log(`[attester] listening on http://localhost:${deps.config.port} (db: ${deps.config.dbPath})`);
      resolve(server);
    });
  });
}
