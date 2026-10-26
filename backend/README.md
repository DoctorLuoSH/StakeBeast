# StakeBeast Social Backend

Node 22 + TypeScript + Express 4 service implementing section **A (Social Backend REST)** of the frozen API contract (`design-docs/api-contract.md` v4.1): wallet-signature login, profiles, habit check-in evidence storage with on-chain anchor verification, and the verifier review list. Section A.4 (friends/invites, P2) is intentionally not implemented.

The chain is the source of truth for session state — this service mirrors it through a narrow `ChainGateway` interface and never decides it locally. All chain reads (production: ethers v6 `JsonRpcProvider` against the frozen StakeBeast ABI; tests: an in-memory fake) go through that interface.

## Quick start

```bash
npm install
cp .env.example .env   # then edit values
npm run dev            # build + boot on http://localhost:4000/api
```

The server boots with sensible local-dev defaults; only `JWT_SECRET` is mandatory (the server refuses to start without it). Requires Node.js ≥ 22: the `npm test` glob is expanded by Node's own test runner, so the command works unchanged in any shell. Other scripts: `npm run build` (tsc), `npm test` (build + `node --test`), `npm start`, `npm run backfill` (see below).

## Upgrading an existing deployment: one-time backfill

Session discovery scans forward from a persisted block watermark, so an existing database never re-reads history. When a deploy adds discovery of a new event type (e.g. `SessionJoined` for duel mirror positions), joins that happened before the upgrade stay undiscovered. Run a one-time backfill over the missed window — inserts are idempotent and the watermark never moves, so all business data (profiles, check-ins, media) is preserved:

```bash
npm run backfill -- --from <first block of the missed window>
```

A fresh `DATA_DIR` needs no backfill — the normal scan covers everything from `INDEXER_START_BLOCK`.

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `4000` | HTTP listen port. |
| `RPC_URL` | `http://127.0.0.1:8545` | Chain RPC endpoint. |
| `CONTRACT_ADDRESS` | zero address | Deployed StakeBeast contract — the expected emitter of `CheckedIn` events for anchor verification and `SessionCreated`/`SessionJoined` scanning. |
| `CHAIN_ID` | `31337` | Local Hardhat; Sepolia is `11155111`. |
| `JWT_SECRET` | — (**required**) | HS256 secret for login tokens. Fail-fast when unset. `.env.example` carries a clearly-labeled dev placeholder. |
| `DATA_DIR` | `./data` | SQLite database, media originals/thumbnails, avatars. |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | CORS allowlist (comma-separated for several origins). |
| `INDEXER_START_BLOCK` | `0` | First block scanned for `SessionCreated`/`SessionJoined` events. |

## Layout

```
src/
  config.ts            env loading (JWT_SECRET fail-fast)
  app.ts               Express app factory; router mounted at /api
  index.ts             production entry point
  db.ts                better-sqlite3 schema + queries
  auth.ts              A.1 challenge/verify, JWT middleware
  profiles.ts          A.2 profiles + avatar serving
  checkins.ts          A.3 check-ins, anchor verification, media
  review.ts            A.3 verifier review list
  parties.ts           party resolution from chain state (<= 60 s cache)
  indexer.ts           lazy SessionCreated/SessionJoined scanner + mirror refresher + backfill
  backfill.ts          one-time historical discovery backfill entry point
  avatars.ts           placeholder generation + upload re-encode
  chain/gateway.ts     ChainGateway interface (all chain reads)
  chain/ethersGateway.ts  production gateway
  chain/abi.ts         minimal frozen ABI + CheckedIn topic
  chain/sessionCache.ts   getSession cache (60 s per A.3)
test/                  node --test suites with an in-memory fake gateway
```

## Endpoint summary (base URL `/api`)

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `POST /auth/challenge` | — | `{address}` → `{nonce, message, expiresAt}`; message is the exact `StakeBeast login\n…` string; challenge 5 min, nonce single-use (consumed on any verify attempt). |
| `POST /auth/verify` | — | `{address, signature}` → `{token, profile}`; EIP-191 recovery must equal the address; JWT HS256 24 h `{sub, iat, exp}`; auto-provisions the profile. Errors: `401 challenge_expired` / `nonce_used` / bad signature. |
| `GET /profiles/me` | ✓ | `{address, nickname, avatarUrl, createdAt}`. |
| `PUT /profiles/me` | ✓ | `{nickname}` 1–32 chars, `<`/`>` rejected. |
| `POST /profiles/me/avatar` | ✓ | multipart `file` (png/jpg/webp ≤ 2 MB) → 256×256 webp, `{avatarUrl}`. |
| `GET /profiles/:address` | optional | Public `{address, nickname, avatarUrl}`; 404 for unknown. |
| `GET /avatars/:address` | — | Public avatar bytes (webp). Not in the contract table; it backs the `avatarUrl` field (judgment call, avatars are public like profiles). |
| `POST /checkins` | ✓ staker | multipart `photo` (jpg/png/webp ≤ 5 MB) + `sessionId`, `evidenceHash`, `periodIndex` → `201 {checkinId, createdAt}`. Staker verified against the chain at write time; SHA-256 recomputed server-side (`422 hash_mismatch`); bytes stored untouched and content-addressed. |
| `POST /checkins/:checkinId/anchor` | ✓ staker | `{txHash}` → `{ok, onchain}`. Verifies the receipt: status 1 and a `CheckedIn` log **from `CONTRACT_ADDRESS`** with matching session id, staker, `evidenceHash`, and `periodIndex` → `confirmed`; reverted/dropped/mismatch → `failed`; no receipt yet → `pending`, persisted with the reported hash so POST and GET agree (a newly reported hash supersedes the previous attempt; re-POST the same hash once mined to settle). `ok` is true exactly when confirmed. |
| `GET /sessions/:sessionId/checkins` | ✓ party | `[{checkinId, periodIndex, evidenceHash, createdAt, photoUrl, thumbUrl, onchain:{status, txHash, blockNumber}}]`; 403 for non-parties. Party = staker, verifier, duel linked-position staker (chain state, cached ≤ 60 s). |
| `GET /review/pending` | ✓ verifier | `?cursor=` opaque offset; Active sessions the caller verifies with staker profile, criterion/period/targets, up to 10 `latestCheckins`, and `onchain:{status, settlementDeadline}`. Sessions are discovered by scanning `SessionCreated` and `SessionJoined` events (progress persisted) — the Duel mirror position emits no `SessionCreated`, it arrives via `SessionJoined.linkedId` — and refreshed via `getSession` when served. |
| `GET /media/:checkinId` | ✓ party | Original photo bytes, original content type, `Cache-Control: private`. `?variant=thumb` → webp ≤ 512 px (display-only). |
| `GET /health` | — | `{ok: true}` liveness. |

Conventions follow the contract: errors as `{error:{code,message}}`; RFC 3339 UTC strings for REST timestamps; on-chain numerics as decimal strings / integer seconds (`sessionId`, `blockNumber` as strings; `settlementDeadline`, `status` as numbers); EIP-55 addresses. Rate limit: 100 req/min/IP on `/api/auth/*`. CORS allowlist = `FRONTEND_ORIGIN`.

## Evidence integrity (R8)

The uploaded photo's original bytes are stored byte-identical at `DATA_DIR/media/<sha256>.<ext>`; the on-chain anchor is the SHA-256 of exactly those bytes. Reviewers recompute the hash from `GET /media/:checkinId` — comparing stored hash fields alone is never proof. Thumbnails (`media/thumbs/<sha256>.webp`) are regenerable display conveniences and never a verification input. A check-in whose anchor verification fails keeps `onchain.status = "failed"` and is never shown as anchored.

## Tests

`npm test` builds and runs `node --test` over six suites (48 tests) against the real Express app on ephemeral ports: real wallet signatures for login, a real SQLite database in temp dirs, and an injected in-memory `ChainGateway` fake that encodes `CheckedIn` logs with the real ABI coder. Covered: the full auth matrix (incl. nonce consumption on failed verifies and the 100 req/min rate limit), profile provisioning/validation/avatar re-encode, byte-identical evidence storage and hash verification, all anchor outcomes (confirmed / failed × reverted/wrong-contract/hash-mismatch/period-mismatch / pending / failed-then-unmined-retry supersession), party authorization incl. duel linked stakers, media round-trip and thumbnail bounds, review discovery incl. duel mirror positions via `SessionJoined.linkedId` and the one-time historical backfill for pre-upgrade databases, pagination, CORS, and the error envelope.
