# M2 Integration Test Report — Phase 1

**Task:** DAPP-17 (M2 integration, phase 1: environment + end-to-end single-user success path)
**Date:** 2026-10-20 · **Author:** Pulse (backend)
**Integration branch:** `agent/pulse/407f1f81a9f5` (merges Forge `agent/forge/32923c45dad2` @ `ed9e255` + Pulse `agent/pulse/76c0d17e691d` @ `538d022` over `main` `f51e8e7`)

## 1. Environment

| Item | Value |
| --- | --- |
| OS | Windows 11, Git Bash (MSYS2) shell |
| Node / npm | v22.20.0 / 10.9.3 |
| Hardhat | 2.29.1 (`viaIR`, evm cancun, Solidity 0.8.26) |
| ethers | 6.17.0 (root + attester) |
| Chain | local `npx hardhat node`, chainId 31337, **interval mining 5 s** (`HARDHAT_MINING_INTERVAL=5000`) |
| Attester service | `attester/` v0.2.0, port 3001, state in `attester/data` |
| StakeBeast | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |
| BeastNFT | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| Windows params | JOIN_WINDOW = START_WINDOW = GRACE_DURATION = 3600 s |
| Accounts (Hardhat dev) | owner #0 `0xf39F…2266`, attester #1 `0x7099…79C8`, charity #2 `0x3C44…93BC`, staker "alice" #3 `0x90F7…b906` |

Design references: frozen design v4.1 (`contract-design.md` §4, `attester-service.md`, `api-contract.md` §B) + freeze errata; requirements baseline v1.4 (D2, AC-21/27/30, §11).

## 2. Reproduction

```bash
npm install && (cd attester && npm install)
HARDHAT_MINING_INTERVAL=5000 npx hardhat node                 # terminal 1
npx hardhat run scripts/deploy.js --network localhost         # terminal 2
# attester/.env: RPC_URL=http://127.0.0.1:8545, CONTRACT_ADDRESS=<from deployments/localhost.json>,
#                ATTESTER_PRIVATE_KEY=<local dev key of the attester account>
(cd attester && npm run dev)                                  # terminal 3
npx hardhat run scripts/e2e-solo-success.js --network localhost
```

`deployments/localhost.json` is written by the deploy script (gitignored, machine-specific).

## 3. End-to-end single-user success path — test matrix

Scenario: SoloFocus session, stake 0.05 ETH, declared duration 2 minutes, payee route Charity (irrelevant on success). Chain-anchored window of the recorded run: `startTime 1792478690 → endTime 1792478810 → settlementDeadline 1792482410`; 25 accepted heartbeats at 5 s cadence; attestation `0x775c…5f1c`.

| ID | Step / precondition | Action | Expected | Actual | Result |
| --- | --- | --- | --- | --- | --- |
| E2E-00 | node + contracts + attester running | `GET /health` | 200, signer == on-chain `attester()` | 200, signer `0x7099…79C8` | PASS |
| E2E-01 | — | `createSession(SoloFocus, -, Charity, -, 2, 0,0,0, "")` +0.05 ETH | session Pending, staker=alice, stake 0.05, duration 2 | as expected | PASS |
| E2E-02 | E2E-01 | read session | `startDeadline = createdAt + 3600` | 3600 | PASS |
| E2E-03 | E2E-01 | balance diff | contract +0.05 ETH; alice −0.05 ETH − gas | exact (fee accounted) | PASS |
| E2E-04 | session on-chain | `POST /v1/bind/challenge` | 200 `{nonce, message, expiresAt}` | 200, all keys present | PASS |
| E2E-05 | E2E-04 | `personal_sign` + `POST /v1/bind` | 200 `{clientToken, status:"ready", nextHeartbeatSeq:1}` | as expected | PASS |
| E2E-06 | bound, **no start yet** | 17 s silence (> 15 s grace) then one heartbeat | accepted, **no violation** (arming-phase exemption, AC-27) | `{ok:true, violation:false}` | PASS |
| E2E-07 | bind done, within START_WINDOW | `startSession(id)` | Active; `startTime` = tx block time; `endTime = startTime+120`; `settlementDeadline = endTime+3600` | as expected | PASS |
| E2E-08 | E2E-07 | `POST /v1/arm {txHash}` | `{ok:true, state:"monitoring"}` | as expected | PASS |
| E2E-09 | monitoring | `GET /status` mid-window | state monitoring, bound=true, violation=null, nextHeartbeatSeq tracks | state monitoring, seq 16, violation null | PASS |
| E2E-10 | E2E-08 | heartbeat every 5 s for the full window | ≥20 beats accepted, none flagged | 25 beats, violationSeen=false | PASS |
| E2E-11 | chain passed endTime | `GET /attestation` | 200 `{typedData, signature}` (425 retries allowed) | 200 after 0 pending retries | PASS |
| E2E-12 | E2E-11 | inspect typedData | domain `{StakeBeast, 1, 31337, contract}`; message = on-chain `{id, staker, partner:0, startTime, endTime, expiry=settlementDeadline}` | field-for-field equal | PASS |
| E2E-13 | E2E-11 | `verifyTypedData` | recovers on-chain attester | `0x7099…79C8` | PASS |
| E2E-14 | E2E-11, within settlement window | `settle(id, sig)` | status Completed; `claimable[alice] = 0.05 ETH` | as expected | PASS |
| E2E-15 | E2E-14 | `SessionCompleted` event | beneficiaries=[alice], tokenIds=[1] | as expected | PASS |
| E2E-16 | E2E-14 | BeastNFT state | ownerOf(1)=alice; kind=Focus, metricValue=2, tier=Sprout, sessionId=1 | as expected | PASS |
| E2E-17 | post-settle | `GET /attestation` again | idempotent re-serve, same signature | same `0x775c…5f1c` | PASS |
| E2E-18 | E2E-14 | `withdraw()` | claimable→0; alice +0.05 ETH − gas; `Withdrawn` event | delta exactly 0.05 | PASS |
| E2E-19 | E2E-18 | contract balance | 0 ETH | 0 ETH | PASS |
| E2E-20 | whole path | alice net balance | −(create+start+settle+withdraw gas) = principal fully refunded | net −0.0005667565 ETH = gas total | PASS |

**Outcome: 21/21 PASS** (recorded run 2026-10-20 06:44–06:48 UTC; full transcript attached to the DAPP-17 result comment).

## 4. Regression on the merged branch

| Suite | Command | Result |
| --- | --- | --- |
| Contract unit tests (Forge, DAPP-3) | `npx hardhat test` | **133/133 passing**, no compiler warnings |
| Attester unit tests (Pulse, DAPP-12) | `cd attester && npm test` | **30/30 passing** |
| E2E single-user success path | `scripts/e2e-solo-success.js` | **21/21 passing** |

## 5. Issue log and fixes

All three issues found were harness/tooling bugs in the test scripts and the attester npm script — **no contract-side or protocol-logic defect was found**; nothing needed escalation to Forge.

| # | Severity | Symptom | Root cause | Fix | Status |
| --- | --- | --- | --- | --- | --- |
| I-1 | low | E2E run crashed at the NFT-metadata check with `TypeError: Do not know how to serialize a BigInt` | test script passed the `beastMeta` struct straight into `JSON.stringify` | read the struct fields individually (`scripts/e2e-solo-success.js` E2E-16) | fixed, verified |
| I-2 | low | E2E-20 net-balance check off by exactly one tx fee (69,469,595,840,898 wei) | script summed gas of create/settle/withdraw but omitted the `startSession` fee | include `startFee` in the total (`scripts/e2e-solo-success.js` E2E-20) | fixed, verified |
| I-3 | medium | `cd attester && npm test` failed on Windows/Node 22 with `Cannot find module …\dist\test` | Node 22 on Windows does not scan a directory argument passed as `node --test dist/test/`; a glob argument is expanded by Node itself | `attester/package.json` test script → `node --test "dist/test/*.test.js"` | fixed, verified (30/30) |

Environment note for the runbook: stopping `npx hardhat node` via the task wrapper leaves the child `node.exe` holding port 8545; a redeploy against the stale chain then lands on unexpected addresses. Kill the exact listener PID (or verify the port is free) before redeploying. This is operational only — no code change.

## 6. Observations carried to phase 2 (DAPP-18)

- Arming exemption exercised only in its time dimension here (pre-start silence + pre-start beats, E2E-06); the exact 15 s head/tail boundaries (14 s pass / 16 s fail) are covered by attester unit tests and move to on-chain AC boundary cases in phase 2.
- `POST /v1/arm` with automine learns the window synchronously (`state:"monitoring"` on first response); the late-learning re-evaluation path (§3.3.4) remains unit-test territory until a delayed-mining scenario is scripted.
- The signing gate needed zero 425 retries with 5 s interval mining; phase 2 should exercise the 425 → 200 transition explicitly (it is part of the mobile-wallet run).
- Restart-recovery, refusal paths (`violation` / `late_bind` / `uncertifiable` / `unreliable_time`), and the mobile-wallet pass are phase-2 scope per the task split.
