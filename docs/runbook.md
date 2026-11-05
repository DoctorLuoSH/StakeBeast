# Services Runbook — Proof Service (attester) + Social Backend

Operator guide for running the two StakeBeast services from a fresh clone:
the proof service (`attester/`, port 3001) and the social backend
(`backend/`, port 4000). Service behavior is frozen; this document only
describes how to start, configure, health-check, and troubleshoot them.

Frontend startup is covered by the frontend section of the root `README.md`
and `frontend/README.md`; contract deployment by `scripts/deploy.js` and the
deployment chapter of the root `README.md`.

## Prerequisites

- **Node.js 22 LTS** (npm included). Minimums: proof service ≥ 20, social
  backend ≥ 22 (its test runner and `better-sqlite3` need it), frontend
  toolchain ≥ 20.12 — installing 22 LTS satisfies everything.
  Check with `node --version`.
- **Git**.
- Windows: run the commands in **Git Bash** (recommended) or **PowerShell**;
  both forms are shown where they differ. macOS / Linux: any POSIX shell.

## Startup order

Always bring the stack up in this order — each layer depends on the previous:

```
1. chain      local: HARDHAT_MINING_INTERVAL=5000 npx hardhat node
              Sepolia: no local process — services point at a Sepolia RPC URL
2. deploy     npx hardhat run scripts/deploy.js --network localhost|sepolia
3. configure  attester/.env  +  backend/.env  (from the shipped .env.example)
4. attester   npm run dev          (in attester/)   → http://localhost:3001
5. backend    npm run dev          (in backend/)    → http://localhost:4000/api
6. frontend   npm run dev          (in frontend/)   → http://localhost:5173
```

Why this order: the proof service connects to the chain RPC at boot and
refuses to start without it (the chain is the authority for session windows);
the deploy step prints the `CONTRACT_ADDRESS` both services need; the social
backend tolerates a missing chain at boot but cannot verify anchors or serve
review data until the RPC is reachable.

## One-command startup

Each service has exactly one start command, run from its own directory
(after the one-time `npm install` in that directory):

```bash
cd attester && npm run dev     # build + boot the proof service on :3001
cd backend && npm run dev      # build + boot the social backend on :4000
```

From the repo root the equivalent is `npm --prefix attester run dev` /
`npm --prefix backend run dev`. `npm start` is identical to `npm run dev`
for both services. Leave each process in its own terminal; stop with
`Ctrl+C` (the proof service flushes and closes its store on SIGINT/SIGTERM).

Missing or invalid configuration fails fast with a readable error and a
non-zero exit — never a silent boot:

- attester without `ATTESTER_PRIVATE_KEY` (or with the shipped placeholder):
  `[attester] failed to start: Error: ATTESTER_PRIVATE_KEY is required
  (0x-prefixed 32-byte hex)`
- attester with a malformed key: `... must be a 0x-prefixed 32-byte hex string`
- attester without a valid `CONTRACT_ADDRESS`: `CONTRACT_ADDRESS is required
  (0x-prefixed 20-byte hex)`
- backend without `JWT_SECRET`: `JWT_SECRET is required — set it in the
  environment or in .env (see .env.example)`

This boot-time refusal **is** the fail-closed design: a service that cannot
attest correctly must not run at all. There is no "running but not ready"
state to detect — if the process is up, the signer is ready.

## Configuration

Secrets come from the environment only; nothing is hard-coded in the repo.
Copy the shipped templates and fill in real values:

```bash
# Git Bash
cp attester/.env.example attester/.env
cp backend/.env.example backend/.env
```

```powershell
# PowerShell
Copy-Item attester\.env.example attester\.env
Copy-Item backend\.env.example backend\.env
```

Both templates carry an English comment per variable; the authoritative
variable tables live in `attester/README.md` and `backend/README.md`.

### The attester signer address (contract linkage)

The attester's on-chain identity is the address **derived from
`ATTESTER_PRIVATE_KEY`**. That same address is passed to the `StakeBeast`
constructor at deploy time (the deploy script prints it as `Attester:` and
records it in `deployments/<network>.json`). If the two differ, every
attestation fails on-chain verification — after boot, compare the `signer`
field of `GET /health` against the deploy output (see below).

### Local (Hardhat) values

- `RPC_URL=http://127.0.0.1:8545`, `CHAIN_ID` 31337 (backend default).
- `CONTRACT_ADDRESS` = the `StakeBeast deployed:` address from the deploy
  output (also in `deployments/localhost.json`).
- `ATTESTER_PRIVATE_KEY` = the key of the deploy's `Attester:` account. On a
  throwaway local chain the well-known Hardhat account #1 key is acceptable
  (the deploy script defaults to it); it is public and must never be used on
  a live network.
- backend `JWT_SECRET`: the shipped dev placeholder is fine locally.

### Sepolia values

- `RPC_URL` = your Sepolia RPC endpoint; `CHAIN_ID=11155111`.
- `CONTRACT_ADDRESS` from `deployments/sepolia.json` after the deploy step.
- `ATTESTER_PRIVATE_KEY`: a **dedicated test key** used only for attestation
  signing. The service sends no transactions and has no transfer authority —
  never use a key that guards real funds, and never commit a real `.env`.
- backend `INDEXER_START_BLOCK` = the deployment block (from
  `deployments/sepolia.json`) so the review-list indexer does not scan
  irrelevant history; `FRONTEND_ORIGIN` = the deployed frontend origin.

## Health checks

Both services expose an unauthenticated liveness endpoint.

```bash
# Git Bash / macOS
curl http://localhost:3001/health
curl http://localhost:4000/api/health
```

```powershell
# PowerShell (in 5.1, `curl` is an alias that wraps the output — prefer this)
Invoke-RestMethod http://localhost:3001/health
Invoke-RestMethod http://localhost:4000/api/health
```

Expected responses:

| Service | Response | What to check |
| --- | --- | --- |
| attester `GET /health` | `{"ok":true,"runId":"<uuid>","signer":"0x…"}` | `signer` must equal the deploy-time `Attester:` address (the `ATTESTER_PRIVATE_KEY` account). `runId` changes on every boot — it identifies the service instance in the journal. |
| backend `GET /api/health` | `{"ok":true}` | Liveness only. |

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| attester exits at boot: `ATTESTER_PRIVATE_KEY is required` / `must be a 0x-prefixed 32-byte hex string` | Expected fail-closed behavior: no key, the shipped placeholder, masked text (`<key of 0x…>`, `[REDACTED CREDENTIAL]`), or an address pasted into the key field (addresses are 42 chars, keys 66). Locally, use the well-known Hardhat account #1 key; on Sepolia, a dedicated test key. |
| attester exits at boot: `CONTRACT_ADDRESS is required (0x-prefixed 20-byte hex)` | `.env` still holds the placeholder/zero address — fill it from the deploy output or `deployments/<network>.json`. |
| attester exits at boot with `failed to start` + a fetch/`ECONNREFUSED 127.0.0.1:8545` error | The chain is not running — the proof service needs the RPC at boot. Start the Hardhat node (step 1) first; on Sepolia, check `RPC_URL`. |
| attester exits at boot: `CHAIN_ID mismatch: configured …, RPC network …` | `CHAIN_ID` does not match the network `RPC_URL` points at (local = 31337, Sepolia = 11155111). Fix the value or leave `CHAIN_ID=0` to auto-detect. |
| backend exits at boot mentioning `JWT_SECRET` | `backend/.env` missing or the variable unset — copy `.env.example`; the shipped dev placeholder covers local runs. |
| `/health` `signer` ≠ the `Attester:` address from the deploy output | Wrong key injected. The service runs, but every attestation will fail on-chain verification — fix `ATTESTER_PRIVATE_KEY` and restart. |
| `Error: listen EADDRINUSE … :3001` / `:4000` / `:5173` / `:8545` | Another process holds the port — usually a previously started copy. Windows: `netstat -ano \| findstr :3001`, then `taskkill //PID <pid> //F` (Git Bash) or `Stop-Process -Id <pid>` (PowerShell). macOS/Linux: `lsof -i :3001`, then `kill <pid>`. For port 8545 also see the orphan-node row below. |
| Deploy or scripts fail with `ECONNREFUSED 127.0.0.1:8545` | The Hardhat node is not running. Start it (step 1) and leave it running. |
| Things silently break after a chain restart; `:8545` answers but state looks stale | An orphaned `hardhat node` survived and holds the port. Kill the listener (commands above), restart the node, **redeploy, and refill both `.env` files** — a node restart wipes all chain state. |
| backend test suite cannot find its tests / native module errors | Node < 22. Install Node 22 LTS (also satisfies the ≥ 20.12 frontend minimum), then reinstall dependencies. |
| Fresh chain, old services: sessions/attestations reference a chain that no longer exists | The attester journal (`attester/data/`) and backend database (`backend/data/`) persist across restarts by design. After resetting the **local** chain, stop both services and delete both `data/` directories to factory-reset them. **Never do this with live (real-user) sessions** — the journal is the authoritative judgment record. |
| Windows: boot fails with a missing-config error although you created `.env` | Notepad appended `.txt` (`attester/.env.txt`), hidden by Explorer. Check with `dir attester`; rename back (`Rename-Item attester\.env.txt .env` — pass the bare leaf name in PowerShell 5.1), or save via *All files*. |
| Windows: `HARDHAT_MINING_INTERVAL=5000 npx hardhat node` fails in PowerShell | PowerShell has no inline env prefix — use `$env:HARDHAT_MINING_INTERVAL=5000; npx hardhat node`, or use Git Bash. |
| `Cannot find module …\hardhat\internal\cli\bootstrap.js` | Interrupted install, or a path containing `&` / non-ASCII characters breaking the npm shim. Re-run `npm install` at the repo root; keep the clone in a plain-ASCII path (e.g. `C:\dev\StakeBeast`). |

## Windows vs macOS notes

- **Shells**: on Windows prefer Git Bash; PowerShell works with the alternate
  forms shown above. macOS ships `curl`, `lsof`, and a POSIX shell natively.
- **Env prefixes**: `VAR=value command` works in Git Bash and macOS shells;
  PowerShell needs `$env:VAR=value; command`.
- **`curl`**: real curl in Git Bash and macOS; in Windows PowerShell 5.1 use
  `Invoke-RestMethod` (or `curl.exe`) to see raw JSON.
- **Clone path**: on Windows keep the clone in a short, plain-ASCII path
  without `&` (e.g. `C:\dev\StakeBeast`); npm's Windows shims break otherwise.
- **Native modules**: `better-sqlite3` and `sharp` ship prebuilt binaries for
  Node 22 on Windows x64 and macOS (arm64/x64); a working compiler toolchain
  is only needed on exotic platforms.

## Persistence and resets

- attester: `DATA_DIR` (default `attester/data/`) holds `journal.ndjson`
  (append-only, fsync per entry — the authoritative record, replayed on boot)
  and `state.json` (inspection snapshot). Restarting the service recovers all
  session state. Deleting `DATA_DIR` factory-resets the service — never with
  live sessions.
- backend: `DATA_DIR` (default `backend/data/`) holds the SQLite database,
  media originals/thumbnails, and avatars. Session discovery resumes from a
  persisted block watermark; after an upgrade that discovers a new event
  type, run the one-time `npm run backfill -- --from <block>` (see
  `backend/README.md`).
