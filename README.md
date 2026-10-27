# StakeBeast

Stake-to-commit DApp (HKU COMP7610 final project): stake ETH to open a focus or
habit session; succeed to get your stake back plus a soulbound beast NFT, fail
and the stake is forfeited (charity / supervisor / friend wallet).

The repository contains the full product stack: the Solidity contracts, the
machine-attestation (proof) service, the social backend, and the React client.

## Project layout

- `contracts/` — Solidity sources (`^0.8.24`, OpenZeppelin v5): `StakeBeast` main contract + `BeastNFT`
- `test/` — Hardhat + Chai contract unit tests
- `scripts/` — deployment / ops scripts, incl. the scripted end-to-end runs
- `attester/` — proof service: heartbeat monitoring + EIP-712 completion attestations
- `backend/` — social backend: wallet login, profiles, habit check-in evidence, review list
- `frontend/` — React + Vite + Ethers v6 client
- `docs/` — integration test report and design references
- `.env.example` — root environment template (only needed for Sepolia deployment)

## Getting started

This walkthrough brings up the **full local stack** — a local Hardhat chain,
contract deployment, the proof service, the social backend, and the frontend —
and ends with a complete focus-session loop: stake 0.05 ETH, focus for
2 minutes, receive the completion attestation, settle on-chain, withdraw the
stake, and see the minted beast.

One honest caveat up front: on current `main` the frontend is still the
pre-integration skeleton (wallet is Sepolia-only; pages do not send contract
transactions yet — UI wiring lands with the M3 issues DAPP-34/35/36). The
end-to-end loop below is therefore driven by the scripted client
`scripts/e2e-solo-success.js`, which speaks exactly the wire protocol the UI
will use (same contract calls, same bind/heartbeat/attestation API). Every
step is real and observable; only the browser click-path is substituted.

### Prerequisites

- **Node.js 22 LTS** (npm included). Minimum is 20.12 for the frontend
  toolchain, but the backend test suite requires Node ≥ 22 — install 22 and
  everything works. Check with `node --version`.
- **Git**.
- **MetaMask** (browser extension) — only needed to explore the frontend UI;
  the scripted loop uses Hardhat's built-in dev accounts and needs no wallet.
- **Windows**: run the commands below in **Git Bash** (recommended). They also
  work in PowerShell except where a note says otherwise.

### 1. Clone and install

```bash
git clone https://github.com/DoctorLuoSH/StakeBeast.git
cd StakeBeast

npm install                    # root: contracts, deploy + e2e scripts
npm --prefix attester install  # proof service
npm --prefix backend install   # social backend
npm --prefix frontend install  # React client
```

### 2. Configure environment variables

Each component has its own `.env.example`; copy it to `.env` in the same
directory. For a local run only two files need real edits, and both values
come from the deployment output in step 3 — you can fill them in there.

| File | Required for local run? | What to set |
| --- | --- | --- |
| Root `.env` | **No** | Only needed for Sepolia (`PRIVATE_KEY` / `RPC_URL` / `ETHERSCAN_API_KEY`). Local deployment uses the Hardhat node's built-in accounts. |
| `attester/.env` | **Yes** | `CONTRACT_ADDRESS` = `stakeBeast` address from the deploy step; `ATTESTER_PRIVATE_KEY` = the deployer's attester account key (below). Defaults cover the rest. |
| `backend/.env` | **Yes, one value** | `CONTRACT_ADDRESS` = `stakeBeast` address from the deploy step. The shipped dev `JWT_SECRET` placeholder is fine locally; the server refuses to boot without it. |
| `frontend/.env` | No (optional) | The skeleton UI boots with empty values. Filling `VITE_CONTRACT_ADDRESS` / `VITE_NFT_CONTRACT_ADDRESS` / `VITE_PROOF_SERVICE_URL=http://localhost:3001` / `VITE_API_BASE_URL=http://localhost:4000/api` now saves a restart once M3 wiring lands. |

**The local attester key.** Local development uses one of Hardhat's
well-known dev accounts as the attester. The deploy script wires account #1
(`0x70997970C51812dc3A010C7d01b50e0d17dc79C8`) as the on-chain attester, so
the proof service must sign with its key:

```
ATTESTER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
```

> ⚠️ This is Hardhat's **public, well-known** account #1 key — fine on a
> throwaway local chain, and unacceptable anywhere else. Never point a
> service holding this key at Sepolia/mainnet, never commit a real `.env`,
> and never reuse a key that guards real funds as an attester key. The
> attester has no transfer authority; on a live network its balance exists
> only as a compromise tripwire.

### 3. Boot the stack (order matters)

Use one terminal per process so the logs stay visible.

**Terminal 1 — local chain.** Interval mining (a new block every 5 s) is
required: the proof service's signing gate needs fresh blocks even when no
transactions are happening.

```bash
HARDHAT_MINING_INTERVAL=5000 npx hardhat node
```

PowerShell: `$env:HARDHAT_MINING_INTERVAL=5000; npx hardhat node`

Expected output: `Started HTTP and WebSocket JSON-RPC server at
http://127.0.0.1:8545/` followed by the list of 20 dev accounts. Leave it
running.

**Terminal 2 — deploy the contracts.**

```bash
npx hardhat run scripts/deploy.js --network localhost
```

Expected output: `BeastNFT deployed: 0x…`, `StakeBeast deployed: 0x…`,
`BeastNFT minter -> StakeBeast`, `Wrote …/deployments/localhost.json`, then
the attester `.env` lines. The `stakeBeast` address goes into both service
`.env` files.

**Terminal 3 — proof service.** Copy `attester/.env.example` to
`attester/.env`, set `CONTRACT_ADDRESS` and `ATTESTER_PRIVATE_KEY` as in
step 2, then:

```bash
npm --prefix attester run dev
```

Expected output: `[attester] listening on http://localhost:3001 (data: …)`.
Verify in another shell: `curl http://localhost:3001/health` returns
`{"ok":true,"runId":…,"signer":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8"}`
— the signer must equal the attester address printed by the deploy script.

**Terminal 4 — social backend.** Copy `backend/.env.example` to
`backend/.env`, set `CONTRACT_ADDRESS`, then:

```bash
npm --prefix backend run dev
```

Expected output: `[backend] StakeBeast social backend listening on
http://localhost:4000/api`. Verify: `curl http://localhost:4000/api/health`
returns `{"ok":true}`.

**Terminal 5 — frontend (optional UI preview).**

```bash
npm --prefix frontend run dev
```

Expected output: Vite's `Local: http://localhost:5173/`. Current skeleton
behaviour: the UI renders and MetaMask connects, but the wallet gate requires
**Sepolia** — a wallet pointed at the local chain gets the wrong-network
screen, and session pages run as labelled demos until M3 wiring lands.

### 4. Your first full loop

With terminals 1–3 running (backend not required for this path), from the
repo root:

```bash
npx hardhat run scripts/e2e-solo-success.js --network localhost
```

The script is a scripted client doing exactly what the browser will do after
M3 — a 2-minute solo focus session, start to finish. Expected: every line
prints `PASS` and the run ends `==== 21/21 checks passed ====` (about
3 minutes, most of it the real 2-minute monitored window):

| Step | What happens (and the UI page it maps to) |
| --- | --- |
| `E2E-01–03` | `createSession(SoloFocus, 2 min)` stakes 0.05 ETH into escrow — the Create Session page form. |
| `E2E-04–06` | Bind: one-time challenge → `personal_sign` → `ready`. This is the wallet signature the Focus Session page requests before arming. |
| `E2E-07–08` | `startSession` opens the on-chain window `[startTime, endTime]`; the client arms and the service enters `monitoring` — the Focus Session page countdown. |
| `E2E-09–10` | Heartbeats every 5 s for the whole window; any gap > 15 s or a hidden-tab event would be a permanent violation. |
| `E2E-11–13` | After `endTime` the service signs the EIP-712 `CompletionAttestation` — the Settlement page polls for exactly this (HTTP 425 → 200). |
| `E2E-14–17` | `settle(id, signature)` marks the session Completed, makes the 0.05 ETH claimable, and **mints the beast NFT** to the staker — the moment the My Zoo page shows a real beast. |
| `E2E-18–20` | `withdraw()` pays the stake back; the staker's net cost is only gas. |

Fresh-chain rule: every scripted run asserts exact token ids and clean
windows (`solo-success` expects the freshly minted token #1, the failure-path
and mobile scripts fast-forward time or expect a zeroed contract), so **any
e2e re-run needs a fresh chain** — stop the Hardhat node, start it again, and
redeploy (see Troubleshooting).

The mint is visible right in the loop output: `E2E-15`/`E2E-16` print the
`SessionCompleted` event and the NFT's on-chain metadata (owner = the staker,
kind = Focus, metricValue = 2 minutes, tier = Sprout, sessionId = 1), and
`E2E-18` shows the stake returning to the wallet. On current `main` the My
Zoo page still renders the demo sample shelf; showing real mints arrives with
the M3 contract reads.

### 5. Run the tests

| Suite | Command | Expected |
| --- | --- | --- |
| Contracts | `npx hardhat test` | 135 passing |
| Proof service | `npm --prefix attester test` | 35 passing |
| Social backend | `npm --prefix backend test` | 48 passing |
| Frontend | `npm --prefix frontend test` | 9 passing |

Frontend extras: `npm --prefix frontend run build` (type-check + production
bundle) and `npm --prefix frontend run lint` (0 problems) should both pass.

### Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Deploy or scripts fail with `ECONNREFUSED 127.0.0.1:8545` | The Hardhat node (terminal 1) is not running. Start it first. |
| Things silently break after a restart; `curl :8545` answers but accounts/sessions look stale | A previous `hardhat node` survived as an orphan holding port 8545. Find the listener (`netstat -ano \| findstr :8545` on Windows, `lsof -i :8545` on macOS/Linux), kill that exact PID, then restart the node **and redeploy** — contract addresses change on a fresh chain. |
| Attester exits at boot with `ATTESTER_PRIVATE_KEY is required` / `must be a 0x-prefixed 32-byte hex string` | `.env` still has the placeholder (or no) key. Locally use the well-known account #1 key from step 2. Same for a placeholder/zero `CONTRACT_ADDRESS`. |
| `/health` signer ≠ the attester address from the deploy output | You signed with the wrong key. The service still runs, but every attestation will fail on-chain verification. |
| Backend exits at boot mentioning `JWT_SECRET` | `backend/.env` missing or the variable unset — the shipped dev placeholder covers local runs. |
| `npm --prefix backend test` fails to find tests on older Node | The suite relies on Node ≥ 22 expanding the `--test` glob; upgrade Node (this also fixes the same class of issue in the attester suite). |
| MetaMask shows the wrong-network screen on `localhost:5173` | Expected on current `main`: the UI skeleton accepts **Sepolia only**. Local-chain support arrives with the M3 integration. |
| Any e2e script misbehaves or fails on a re-run (e.g. wrong token id, `OutsideSettlementWindow`) | Every scripted run expects a fresh chain — `solo-success` asserts the freshly minted token #1, `e2e-failure-paths.js` fast-forwards time, `e2e-mobile-wallet.js` expects a zeroed contract. Restart the node, redeploy, rerun. |
| Windows: `HARDHAT_MINING_INTERVAL=5000 npx hardhat node` fails in PowerShell | PowerShell has no inline env prefix — use `$env:HARDHAT_MINING_INTERVAL=5000; npx hardhat node`, or use Git Bash. |

## Contracts

### BeastNFT

Soulbound ERC721 minted on session success (requirements baseline v1.4 section
4.8 / D8 / AC-17):

- Only the parameterized `minter` address can mint; the StakeBeast main
  contract is plugged in via `setMinter` after deployment.
- All transfers and approvals revert (`Soulbound`).
- Dual-track tiers, floored: focus by declared minutes
  (>=120 golden / >=50 adult / >=25 juvenile / else sprout), habit by cycle
  days (>=21 golden / >=7 adult / >=3 juvenile / else sprout).
- At most one beast per stake position per session (`mintedBySession` gate).
- Fully on-chain base64 JSON metadata (type, measured value, completion date,
  tier, session id).

## Deployment (Sepolia)

Set `PRIVATE_KEY` / `RPC_URL` / `ETHERSCAN_API_KEY` in `.env`, then:

```bash
npx hardhat run scripts/deploy.js --network sepolia
npx hardhat verify --network sepolia <BEAST_NFT_ADDRESS> <OWNER> 0x0000000000000000000000000000000000000000
```

(Etherscan verification runbook lands with WP7.)
