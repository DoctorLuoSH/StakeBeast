# StakeBeast Attestation Service

Attestation (proof) service for StakeBeast machine-verified focus sessions. It
tracks client heartbeats, applies the frozen violation rules, and will issue
EIP-712 completion proofs for clean sessions that cover the full declared
duration. The service holds no transfer authority; it only signs.

Rule references below point at the frozen requirements baseline v1.4
(`stakebeast-requirements-plan.md`, DAPP-1). The API contract freeze lives in
DAPP-2 (`api-contract.md`) — endpoint shapes here are the pre-freeze working
version and will be aligned to it.

## Judgment rules implemented (baseline v1.4: section 4.1, decision D2)

Server time is authoritative; the same event sequence always yields one result.

- Clients heartbeat every 5s (informational cadence; judgment is gap-based).
- A page-hidden event (`visibilitychange` → hidden) marks a violation **immediately**.
- Without a hidden event, a heartbeat interruption of at most **15s** is
  tolerated; beyond that the session is marked in violation, dated exactly at
  `lastHeartbeatAt + 15s`.
- Reconnecting **never** clears a marked violation.
- Interruption reasons (refresh / close / network drop) are not distinguished.
- Binding: the client must bind within **5 minutes after `startTime`** and never
  after `endTime`; a late bind is refused permanently (fail-closed, AC-16).
- A completion proof requires: bound + violation-free + `now >= endTime` +
  not already issued — late binding can never shorten the declared duration.

## Quick start

```bash
npm install
cp .env.example .env   # fill in ATTESTER_PRIVATE_KEY when signing is enabled
npm test               # build + run the unit/integration tests
npm start              # build + start the service (default http://localhost:8787)
```

Requires Node.js >= 16. No runtime dependencies (built-in `node:http`; judgment
state persists to a write-through JSON file with atomic replace, recovered on
restart — see `src/store.ts`).

## Configuration (environment only, never hard-coded)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP listen port |
| `ATTESTER_DB_PATH` | `./data/attester.json` | judgment-state persistence file |
| `ATTESTER_PRIVATE_KEY` | — | 0x-prefixed key for EIP-712 signing (placeholder until DAPP-2) |
| `CHAIN_ID` | `11155111` | chain the proofs are valid on (Sepolia) |

## API (pre-freeze working shape; DAPP-2 is authoritative)

| Method & path | Body | Description |
| --- | --- | --- |
| `GET /health` | — | liveness + signer readiness |
| `POST /sessions` | `{ sessionId, participant, startTime, durationMs }` | register a started on-chain session |
| `GET /sessions/:id` | — | current judgment state |
| `POST /sessions/:id/bind` | `{ participant }` | bind the client (≤ startTime+5min, ≤ endTime) |
| `POST /sessions/:id/heartbeat` | `{ participant }` | heartbeat |
| `POST /sessions/:id/hidden` | `{ participant }` | page-hidden event → immediate violation |
| `POST /sessions/:id/proof` | `{ participant }` | request completion proof (fail-closed; 501 until DAPP-2 fields land) |

## Layout

- `src/judgment.ts` — pure, clock-injected judgment core (all D2 rules)
- `src/store.ts` — durable session-state store (restart-safe)
- `src/server.ts` — HTTP wiring + violation sweeper
- `src/signer.ts` — EIP-712 signer seam (interface + config placeholder)
- `src/config.ts` — environment configuration (`.env` supported)
- `test/` — AC-12/AC-16 rule tests, boundary tests, persistence and HTTP tests

## Out of scope in this wave (per DAPP-7)

- EIP-712 domain/message finalization and actual signing — frozen in DAPP-2,
  aligned with Forge (contracts). Tracked as `TODO(DAPP-2)` in `src/signer.ts`.
- Social backend REST API (WP4 — owned by member A unless the circuit breaker
  triggers).
- On-chain registration verification and request authentication (DAPP-2).
- Dual-client co-focus tracking (P2, WP10).
