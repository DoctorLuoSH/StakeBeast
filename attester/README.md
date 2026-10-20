# StakeBeast Attestation Service

The automated completion verifier for StakeBeast machine-proof sessions (solo
focus and co-focus), per the frozen design (`docs/attester-service.md` v4 +
freeze errata, `docs/contract-design.md` §4, `docs/api-contract.md` §B).
It tracks client readiness and heartbeats around and during the chain-anchored
window `[startTime, endTime]`, and issues an EIP-712 `CompletionAttestation`
only for fully-clean sessions. It holds a signing key and **no transfer
authority**; refusal is fail-closed throughout.

Stack: Node.js 20+ (developed on 16+), TypeScript, Express 4, Ethers v6.

## Judgment rules (frozen)

- Assessed window = `[on-chain startTime, endTime]`; chain time is the authority
  for the window bounds and for the "task has ended" signing gate.
- Receive records are stored as (run-instance id, monotonic instant, server
  UTC). Scoring compares server-UTC receive times directly against the chain
  window — no recalibration from block data (trusted-server-clock assumption,
  disclosed in PRD §9).
- `visibility_hidden` with server UTC receive time inside the window ⇒
  immediate, permanent violation. In-window heartbeat silence > 15 s ⇒
  violation (including head gap from `startTime` and tail gap to `endTime`).
  Recovery never clears a violation.
- Bind backstop: a participant not bound by `startTime + 5 min` ⇒ never
  attestable (fail-closed).
- In-window silence spanning a service restart is platform-caused ⇒
  `uncertifiable` (never a user violation, never remapped); compensation is
  the admin `voidSession` path (spec §7).
- Signing gate: sign only after a fresh on-chain block has
  `timestamp ≥ endTime`; server UTC vs fresh chain time must be within ±30 s,
  and stale chain data at signing ⇒ refuse as `unreliable_time`.
- Final coverage check replays the entire window record before signing; once
  judged, out-of-window heartbeats/events change nothing.
- Idempotent re-serve of the stored signature; controlled re-signing under a
  new key only after on-chain `setAttester` rotation, for non-terminal
  in-window sessions whose judgment was clean (§6).

## Protocol (frontend ↔ attester, api-contract §B)

```
POST /v1/bind/challenge {chainId, contract, sessionId, address}
  → {nonce, message, expiresAt}            # single-use, 5-minute challenge
POST /v1/bind {chainId, contract, sessionId, address, nonce, bindSig}
  → {clientToken, status, nextHeartbeatSeq}   # personal_sign over `message`;
                                              # new bind revokes the old token
POST /v1/arm {sessionId, txHash}           # Bearer; returns the ACTUAL state
POST /v1/heartbeat {sessionId, seq, clientTs}   # Bearer; only strictly-increasing
                                                # seq refreshes liveness (AC-30)
POST /v1/event {sessionId, eventId, type, clientTs}  # Bearer; eventId dedup (AC-29)
GET  /v1/sessions/:id/status?chainId=&contract=      # Bearer, participants only
GET  /v1/sessions/:id/attestation?chainId=&contract= # 200 {typedData, signature}
                                                     # 409 {state:"refused", reason}
                                                     # 425 {state:"pending"}
```

Errors use `{error: {code, message}}` with codes `bad_request, unauthorized,
not_found, too_late, refused, pending, challenge_expired, nonce_used, internal`.

## Persistence (spec §5)

`DATA_DIR` holds `journal.ndjson` (append-only, fsync per entry — the
authoritative record, replayed on boot) and `state.json` (atomic snapshot for
inspection). The journal records challenges, binds, token rotation, heartbeat
watermarks (throttled 1/5 s per participant, plus a per-heartbeat seq marker so
the anti-replay watermark survives restarts exactly), events, arming, the chain
window, violations, anomalies, judgments, refusals and issued attestations.
Deleting `DATA_DIR` factory-resets the service — never do this with live
sessions.

## Quick start

```bash
cd attester
cp .env.example .env      # set ATTESTER_PRIVATE_KEY and CONTRACT_ADDRESS
npm install
npm test                  # unit + integration suite
npm run dev               # http://localhost:3001, state in ./data
```

Local demo: run Hardhat with interval mining (e.g. `mining: { auto: true,
interval: 5000 }`) so the signing gate always sees fresh blocks without needing
a transaction. A well-known Hardhat account key is acceptable locally; Sepolia
uses a dedicated key (the service sends no transactions — its balance is only
a compromise tripwire).

## Configuration (environment only, never hard-coded)

| Variable | Default | Purpose |
| --- | --- | --- |
| `RPC_URL` | `http://127.0.0.1:8545` | JSON-RPC endpoint |
| `CONTRACT_ADDRESS` | — (required) | deployed StakeBeast contract |
| `ATTESTER_PRIVATE_KEY` | — (required) | 0x-prefixed EIP-712 signing key |
| `PORT` | `3001` | HTTP listen port |
| `DATA_DIR` | `./data` | durable state directory |
| `CHAIN_ID` | auto-detect | optional safety check vs the RPC network |
| `CORS_ORIGIN` | `*` | browser origin allowlist (local dev) |

## Layout

- `src/chain.ts` — read-only chain access (ethers v6) + ABI fragment (frozen)
- `src/store.ts` — journal + snapshot persistence, restart-safe state
- `src/scoring.ts` — pure coverage scoring (15 s rule, hidden events, restarts)
- `src/core.ts` — session lifecycle, bind/arm/heartbeat/event, judgment, gates
- `src/signer.ts` — EIP-712 typed data (contract-design §4) + signing
- `src/server.ts` — Express wiring, sweeper + chain watcher drivers
- `test/` — bind, protocol, attestation, restart-recovery and HTTP suites
  against an in-memory chain implementing the same `ChainClient` seam

## Out of scope (per DAPP-12)

Contract implementation (`StakeBeast.sol`) is Forge's (DAPP-3); the ABI here
mirrors contract-design v4 exactly and any drift is resolved in the task
comments. Social backend (WP4) belongs to member A. Co-focus dual tracking is
implemented in the data model (two participant slots, joint cleanliness) but
its end-to-end exercise is WP10 (P2).
