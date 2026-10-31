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

Seven steps take you from an empty directory to a complete on-chain loop, in
order: install → chain → deploy → configure → services → scripted loop → UI.
Each step says which directory and terminal it runs in, and whether to leave
the process running.

### What you can experience today

*Snapshot of `main` as of 2026-10-31. This table must be updated when the M3
frontend integration (DAPP-34/35/36) lands.*

- The **frontend is a demo build**: every page renders and MetaMask connects,
  but the browser does not send contract transactions yet.
- **Mutual Bet and Co-Focus Duo already have contract implementations and unit
  tests** — but no web two-player experience yet; today you meet them through
  the test suite, not the UI.
- **Solo Focus needs neither MetaMask nor real ETH**: its loop runs as a script
  against a local chain with built-in dev accounts, using exactly the wire
  protocol the UI will use (same contract calls, same
  bind/heartbeat/attestation API). Every step is real and observable; only the
  browser click-path is substituted.

| | Web pages (demo UI) | Contract tests | Solo Focus e2e script |
| --- | --- | --- | --- |
| What you get | Full UI walk-through on sample data — Create / Focus / Settlement / My Zoo | 135 automated checks of every contract rule, including Mutual Bet and Co-Focus Duo | A real 2-minute stake-to-mint loop on your own local chain, ending `21/21 checks passed` |
| Real chain transactions? | Not yet — arrives with M3 (DAPP-34/35/36) | Yes, on an in-process test chain | Yes, on your local chain |
| MetaMask / real ETH needed? | MetaMask optional (wallet gate is Sepolia-only for now); never real ETH | Neither | Neither — Hardhat dev accounts |
| How | Step 7 | `npx hardhat test` | Step 6 |

### Prerequisites

- **Node.js 22 LTS** (npm included). Minimum is 20.12 for the frontend
  toolchain, but the backend test suite requires Node ≥ 22 — install 22 and
  everything works. Check with `node --version`.
- **Git**.
- **MetaMask** (browser extension) — optional, only for exploring the demo UI;
  the scripted loop uses Hardhat's built-in dev accounts and needs no wallet.
- **Windows**: commands below are given for **Git Bash** (recommended) and
  **PowerShell** side by side wherever they differ. Pick one shell per
  terminal and stick with it.

### Step 1 — Clone and install

> Where: any terminal · one-time setup · nothing left running.

Clone into a short, plain-ASCII path — e.g. `C:\dev\StakeBeast`. Avoid `&` and
non-ASCII characters in the path: npm's Windows shims break on them with
confusing errors.

```bash
# Git Bash
mkdir -p /c/dev && cd /c/dev
git clone https://github.com/DoctorLuoSH/StakeBeast.git
cd StakeBeast
```

```powershell
# PowerShell
mkdir C:\dev; cd C:\dev
git clone https://github.com/DoctorLuoSH/StakeBeast.git
cd StakeBeast
```

Two errors seen in the wild at this point, and their fixes:

| Error looks like | Meaning / fix |
| --- | --- |
| `'npm' 不是内部或外部命令` / `'npm' is not recognized as an internal or external command` | Windows cannot find Node.js. Install Node 22 LTS, then **close and reopen the terminal** — PATH only refreshes in a new window. |
| `Cannot find module …\hardhat\internal\cli\bootstrap.js` when running `npx hardhat …` | The command shim exists but Hardhat's own files are missing or unreachable — the install was interrupted/corrupted, or the path contains `&` / non-ASCII characters that break the shim. Re-run `npm install` at the repo root; keep the project in a plain-ASCII path like `C:\dev\StakeBeast`. |

Then install all four packages, from the repo root:

```bash
npm install                    # root: contracts, deploy + e2e scripts
npm --prefix attester install  # proof service
npm --prefix backend install   # social backend
npm --prefix frontend install  # React client
```

Reading npm's output — most of what looks scary is fine:

- `npm warn deprecated …` — notices about old packages deep in the dependency
  tree. Harmless; the pinned versions are what the test suites were verified
  with.
- `found N vulnerabilities` — an audit **notice**, not a failure. Do not act on
  it, and in particular never run `npm audit fix --force`: it force-upgrades
  across major versions and can silently break the pinned toolchain.
- Real failure is unmistakable: lines starting with `npm error`, a non-zero
  exit code, no `node_modules` created. When asking for help, paste the full
  output.

Success looks like: each command ends with `added N packages` and there are no
`npm error` lines.

### Step 2 — Start the local chain

> Where: repo root · **new terminal (Terminal 1)** · **leave running** — the
> chain only lives while this process does.

```bash
# Git Bash
HARDHAT_MINING_INTERVAL=5000 npx hardhat node
```

```powershell
# PowerShell
$env:HARDHAT_MINING_INTERVAL=5000; npx hardhat node
```

Interval mining (a new block every 5 s) is required: the proof service's
signing gate needs fresh blocks even when no transactions are happening.

Expected output: `Started HTTP and WebSocket JSON-RPC server at
http://127.0.0.1:8545/` followed by the list of 20 dev accounts **with their
private keys**. Keep this window visible — step 4 takes the attester key from
`Account #1` here.

### Step 3 — Deploy the contracts

> Where: repo root · a **second terminal (Terminal 2)** · one-off command.

```bash
npx hardhat run scripts/deploy.js --network localhost
```

(Same command in Git Bash and PowerShell.) Expected output:

```
BeastNFT deployed:   0x…
StakeBeast deployed: 0x…        ← your CONTRACT_ADDRESS for step 4
BeastNFT minter -> StakeBeast
Wrote …/deployments/localhost.json

Attester .env (fill in the signing key for the attester account):
RPC_URL=http://127.0.0.1:8545
CONTRACT_ADDRESS=0x…
ATTESTER_PRIVATE_KEY=<key of 0x70997970C51812dc3A010C7d01b50e0d17dc79C8>
```

⚠️ `<key of 0x7099…79C8>` is **placeholder text, not a value** — the script
marks where a key belongs; it never prints keys. Pasting the angle-bracket
text into `.env` fails at boot with a key-format error. The same applies to
masked values seen elsewhere: `[REDACTED CREDENTIAL]` in a chat or issue
comment is a censor mask, never something you can paste. The real key for a
local run comes from Terminal 1 — see step 4.

### Step 4 — Fill in the two service `.env` files

> Where: repo root · editing only, no new process.

Only two files need real values for a local run, and every value comes from
steps 2–3. (Root `.env` is Sepolia-only — skip it. `frontend/.env` is
optional — see step 7.)

Create the files from the shipped templates:

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

⚠️ **Notepad pitfall (Windows):** if you create or save these files via
Notepad's *Save as…*, it may quietly append `.txt`, leaving
`attester/.env.txt` — which the service cannot find, so boot fails with a
missing-config error. Windows Explorer also hides extensions by default, so a
file displayed as `.env` may really be `.env.txt`. Check with `dir attester`
or `dir backend`; if you spot the extra suffix, rename the file
(`Rename-Item attester\.env.txt attester\.env`), or in Notepad's save dialog
choose *Save as type: All files*.

Edit with any plain-text editor (Notepad is fine: `notepad attester\.env`).
How to read an `.env` line:

```
ATTESTER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
└── variable name: fixed ──┘ └── value: the ONLY part you replace ──┘
```

One `NAME=value` per line; no quotes, no spaces around `=`, `#` starts a
comment.

**Address ≠ private key — never mix them up:**

| | Looks like | Length incl. `0x` | Used for |
| --- | --- | --- | --- |
| Account / contract **address** | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | 42 chars | `CONTRACT_ADDRESS` — public, safe to share |
| **Private key** | `0x59c6995e99…78690d` | 66 chars | `ATTESTER_PRIVATE_KEY` — secret, controls the account |

An address names an account; the key controls it. Putting an address into a
key field (or the reverse) fails at boot.

**`attester/.env` — set 2 values, leave the rest at defaults:**

- `CONTRACT_ADDRESS` — the `StakeBeast deployed:` address from step 3 (also
  saved in `deployments/localhost.json` under `stakeBeast`).
- `ATTESTER_PRIVATE_KEY` — the key of the `Attester:` account the deploy
  script printed. On the local chain that is Hardhat's account #1: scroll
  Terminal 1 to `Account #1` and copy its `Private Key:` value, or paste the
  well-known key directly:

  ```
  ATTESTER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
  ```

> ⚠️ This is Hardhat's **public, well-known** account #1 key — fine on a
> throwaway local chain, and unacceptable anywhere else. Never point a
> service holding this key at Sepolia/mainnet, never commit a real `.env`,
> and never reuse a key that guards real funds as an attester key. The
> attester has no transfer authority; on a live network its balance exists
> only as a compromise tripwire.

**`backend/.env` — set 1 value:**

- `CONTRACT_ADDRESS` — the same address as above. The shipped dev `JWT_SECRET`
  placeholder is fine locally; the server refuses to boot without it.

### Step 5 — Start the services and health-check them

> Where: two more terminals, repo root · **both stay running.**

Terminal 3 — proof service:

```bash
npm --prefix attester run dev
```

Expected output: `[attester] listening on http://localhost:3001 (data: …)`

Terminal 4 — social backend:

```bash
npm --prefix backend run dev
```

Expected output: `[backend] StakeBeast social backend listening on
http://localhost:4000/api`

Health checks (Terminal 2, or any spare shell):

```bash
# Git Bash
curl http://localhost:3001/health
curl http://localhost:4000/api/health
```

```powershell
# PowerShell
Invoke-RestMethod http://localhost:3001/health
Invoke-RestMethod http://localhost:4000/api/health
```

(In Windows PowerShell 5.1, `curl` is an alias for `Invoke-WebRequest`, which
prints a wrapper object instead of the raw JSON — use `Invoke-RestMethod`, or
call `curl.exe` with the extension.)

Expected: the proof service returns
`{"ok":true,"runId":…,"signer":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8"}`
— the signer **must equal** the `Attester:` address from the deploy output —
and the backend returns `{"ok":true}`.

### Step 6 — Your first Solo Focus loop

> Where: repo root, Terminal 2 · one-off, about 3 minutes · needs Terminals 1
> and 3 running (the backend is not required for this path).

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
| `E2E-14–17` | `settle(id, signature)` marks the session Completed, makes the 0.05 ETH claimable, and **mints the beast NFT** to the staker. |
| `E2E-18–20` | `withdraw()` pays the stake back; the staker's net cost is only gas. |

The mint is confirmed **in the script logs**: `E2E-15`/`E2E-16` print the
`SessionCompleted` event and the NFT's on-chain metadata (owner = the staker,
kind = Focus, metricValue = 2 minutes, tier = Sprout, sessionId = 1), and
`E2E-18` shows the stake returning to the wallet. The **My Zoo page does not
show this beast** — on current `main` the UI renders a demo sample shelf;
showing real mints arrives with the M3 contract reads.

Fresh-chain rule: every scripted run asserts exact token ids and clean
windows (`solo-success` expects the freshly minted token #1, the failure-path
and mobile scripts fast-forward time or expect a zeroed contract), so **any
e2e re-run needs a fresh chain** — stop the Hardhat node, start it again, and
redeploy. Restarting **wipes the local chain's state** (sessions, mints,
balances); the redeployed addresses usually come back identical on Hardhat's
deterministic chain, but everything recorded on the old chain is gone — fill
`.env` from the new deploy output (step 4) rather than assuming the old values
still match.

### Step 7 — Look at the demo UI

> Where: Terminal 5, repo root · stays running while you explore.

```bash
npm --prefix frontend run dev
```

Expected output: Vite's `Local: http://localhost:5173/`. Today's behaviour:
the UI renders and MetaMask connects, but the wallet gate requires
**Sepolia** — a wallet pointed at the local chain gets the wrong-network
screen, and session pages run as labelled demos until M3 wiring lands.

Optional, saves a restart once M3 wiring lands: copy `frontend/.env.example`
to `frontend/.env` and fill `VITE_CONTRACT_ADDRESS` /
`VITE_NFT_CONTRACT_ADDRESS` / `VITE_PROOF_SERVICE_URL=http://localhost:3001` /
`VITE_API_BASE_URL=http://localhost:4000/api`. The skeleton UI boots with
empty values, so this can wait.

### Run the tests

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
| `'npm' 不是内部或外部命令` / `'npm' is not recognized as an internal or external command` | Node.js is not installed, or the terminal was opened before the installation finished. Install Node 22 LTS, close and reopen the terminal. |
| `Cannot find module …\hardhat\internal\cli\bootstrap.js` on `npx hardhat …` | Partial/corrupted install, or a `&` / non-ASCII character in the path breaking the command shim. Re-run `npm install` at the repo root; move the project to a plain path like `C:\dev\StakeBeast`. If even `node --version` fails, reinstall Node.js 22 LTS. |
| A service crashes at boot with `Error: listen EADDRINUSE … :3001` / `:4000` / `:5173` | Another copy of that service is already running — usually one started earlier and forgotten. Find the listener (`netstat -ano \| findstr :3001` on Windows, `lsof -i :3001` on macOS/Linux), kill that exact PID, then start again. For the chain port 8545, see the orphan-node row below. |
| Deploy or scripts fail with `ECONNREFUSED 127.0.0.1:8545` | The Hardhat node (Terminal 1) is not running. Start it first. |
| Service boots with a missing-config error although you created the file | The Notepad `.txt` trap: `dir attester` shows `attester/.env.txt` instead of `.env`. Rename it back (see step 4). |
| Attester exits at boot with `ATTESTER_PRIVATE_KEY is required` / `must be a 0x-prefixed 32-byte hex string` | `.env` still has the placeholder key — or masked text was pasted (`<key of 0x…>`, `[REDACTED CREDENTIAL]`). Locally use the well-known account #1 key from step 4. Same check for a placeholder/zero `CONTRACT_ADDRESS`. |
| `/health` signer ≠ the attester address from the deploy output | You signed with the wrong key. The service still runs, but every attestation will fail on-chain verification. |
| Things silently break after a restart; `curl :8545` answers but accounts/sessions look stale | A previous `hardhat node` survived as an orphan holding port 8545. Find the listener (`netstat -ano \| findstr :8545` on Windows, `lsof -i :8545` on macOS/Linux), kill that exact PID, then restart the node **and redeploy** — a restart wipes the chain's state, so re-check every address against the new deploy output (addresses usually come back identical, but the old state is gone). |
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
