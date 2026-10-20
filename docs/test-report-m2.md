# M2 Integration Test Report

**Tasks:** DAPP-17 (phase 1: environment + end-to-end single-user success path) · DAPP-18 (phase 2: failure/boundary spot-checks + mobile-wallet run + report finalization)
**Dates:** phase 1 — 2026-10-20 · phase 2 — 2026-10-20 · **Author:** Pulse (backend)
**Integration branch:** phase 1 `agent/pulse/407f1f81a9f5` @ `7d5a9cc` (merges Forge `agent/forge/32923c45dad2` @ `ed9e255` + Pulse `agent/pulse/76c0d17e691d` @ `538d022` over `main` `f51e8e7`); phase 2 continues on `agent/pulse/e8526a0dc1e6` (phase-1 branch + phase-2 scripts and this report)

## 1. Environment

| Item | Value |
| --- | --- |
| OS | Windows 11, Git Bash (MSYS2) shell |
| Node / npm | v22.20.0 / 10.9.3 |
| Hardhat | 2.29.1 (`viaIR`, evm cancun, Solidity 0.8.26) |
| ethers | 6.17.0 (root + attester) |
| Chain | local `npx hardhat node`, chainId 31337, **interval mining 5 s** (`HARDHAT_MINING_INTERVAL=5000`) |
| Attester service | `attester/` v0.2.0; phase 1: operator-started on port 3001; phase 2: **script-spawned child process** on port 3101 with a temp `DATA_DIR` (deterministic restart case) |
| StakeBeast | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |
| BeastNFT | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| Window params | JOIN_WINDOW = START_WINDOW = GRACE_DURATION = 3600 s |
| Accounts (Hardhat dev) | owner #0 `0xf39F…2266`, attester #1 `0x7099…79C8`, charity #2 `0x3C44…93BC`, alice #3 `0x90F7…b906`, mobile-user #4 `0x15d3…6A65`, bob #5 `0x9965…A4dc`, vera (verifier) #6 `0x976E…0aa9`, fred (custom payee) #7 `0x14dC…9955` |
| Mobile environment | No physical handset in the agent runtime — **equivalent environment**: scripted wallet driving the exact MetaMask-mobile wire surface (`personal_sign` bind, plain txs, heartbeat protocol); see §6 for the substitution argument |

Design references: frozen design v4.1 (`contract-design.md` §4, `attester-service.md`, `api-contract.md` §B) + freeze errata; requirements baseline v1.4 (D2, AC-02/03/06/07/08/12/13/21/22/25/27/29/31, §11).

## 2. Reproduction

```bash
npm install && (cd attester && npm install && npm run build)
HARDHAT_MINING_INTERVAL=5000 npx hardhat node                 # terminal 1
npx hardhat run scripts/deploy.js --network localhost         # terminal 2

# Phase 1 (operator-started attester on :3001, attester/.env filled per deploy output):
(cd attester && npm run dev)                                  # terminal 3
npx hardhat run scripts/e2e-solo-success.js --network localhost

# Phase 2 (scripts spawn and kill their own attester child on :3101):
ATTESTER_PRIVATE_KEY=<key of the attester account> \
  npx hardhat run scripts/e2e-failure-paths.js --network localhost
ATTESTER_PRIVATE_KEY=<key of the attester account> \
  npx hardhat run scripts/e2e-mobile-wallet.js --network localhost   # fresh chain (see §7 note)
```

`deployments/localhost.json` is written by the deploy script (gitignored, machine-specific). The attester signing key comes from the environment only; nothing is committed.

**Fresh-chain rule:** each scripted run above starts from a fresh `hardhat node` + deploy. `e2e-failure-paths.js` fast-forwards chain time ~1 h in its settlement phase, and `e2e-mobile-wallet.js` expects a zeroed contract — never run them back-to-back on the same chain without redeploying.

## 3. Phase 1 — end-to-end single-user success path (DAPP-17)

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

## 4. Regression on the integration branch

| Suite | Command | Result |
| --- | --- | --- |
| Contract unit tests (Forge, DAPP-3) | `npx hardhat test` | **133/133 passing**, no compiler warnings |
| Attester unit tests (Pulse, DAPP-12) | `cd attester && npm test` | **30/30 passing** |
| E2E single-user success path (phase 1) | `scripts/e2e-solo-success.js` | **21/21 passing** (identical runtime code re-verified in phase 2) |
| E2E failure & boundary paths (phase 2) | `scripts/e2e-failure-paths.js` | **46/46 passing** |
| E2E mobile-wallet run (phase 2) | `scripts/e2e-mobile-wallet.js` | **14/14 passing** |

## 5. Phase 2 — failure & boundary spot-checks (DAPP-18)

Execution model: `scripts/e2e-failure-paths.js` spawns its own attester child (port 3101, temp `DATA_DIR`) so the restart case is deterministic. All refusal checks run in **real time** (chain ≈ wall clock); only the final settlement phase fast-forwards the chain (`evm_increaseTime +3606 s`) past every `settlementDeadline`. Sessions: F1/F2 = alice solo 2 min; F3 = bob solo 2 min started then left unbound; S2 = alice solo 1 min clean; admitDefeat/void sessions = bob supervised one-off tasks. Recorded run 2026-10-20 ~07:40–07:49 UTC; full transcript attached to the DAPP-18 result comment.

### 5.1 Attester failure paths (machine-proof)

| ID | AC | Check | Expected | Actual | Result |
| --- | --- | --- | --- | --- | --- |
| B-00 | — | script-spawned attester healthy | 200, signer = on-chain attester | `0x7099…79C8` | PASS |
| B-01 | — | F1 bind before start | 200 `{clientToken, status:ready}` | as expected | PASS |
| B-02 | AC-31 | consumed challenge nonce reused | 401 `nonce_used` | 401 `nonce_used` | PASS |
| B-03 | — | F1 arm after `startSession` | `state:monitoring` | monitoring | PASS |
| B-04 | AC-12/29 | `visibility_hidden` event mid-window | **instant violation on the event response itself** | `{ok:true, violation:true}` | PASS |
| B-05 | AC-12 | F1 status after the event | `violation=hidden` | `hidden` | PASS |
| B-06 | AC-03/25 | `forfeit` before `settlementDeadline` | revert `NotYetForfeitable` | as expected | PASS |
| B-07 | AC-12 | attestation after endTime (violated session) | 409 `{state:refused, reason:violation}` | as expected | PASS |
| B-10 | AC-12 | 10 s refresh-recovery gap | no violation | `{violation:false}` | PASS |
| B-11 | AC-12 | 18 s gap (> 15 s tolerance) | violation flagged | `{violation:true}` | PASS |
| B-12 | AC-12 | heartbeats resumed after the gap | violation **not** cleared | stays `true` | PASS |
| B-13 | AC-22 | attester SIGTERM + restart (same `DATA_DIR`) | healthy, same signer | as expected | PASS |
| B-14 | AC-22 | judgment state after restart | violation + seq watermark preserved | `heartbeat_timeout`, `nextHeartbeatSeq=8` = client seq | PASS |
| B-15 | AC-22 | attestation after restart | refusal persists: 409 `violation` | as expected | PASS |
| B-20 | — | S2 clean 1-min window | no violation, full coverage | 14 beats, clean | PASS |
| B-21 | — | S2 attestation issued | 200 `{typedData, signature}` | as expected | PASS |
| B-30 | AC-21 | first bind 316 s after `startTime` (> 5 min window) | token issued (window unknown to service at bind), fail-closed flag follows | 200, elapsed 316 s | PASS |
| B-31 | AC-21 | bind backstop after the watcher learns the window | `violation=bind_timeout` | as expected | PASS |
| B-32 | AC-21 | attestation for the late-bound session | 409 `late_bind` | as expected | PASS |

### 5.2 Settlement-signature abuse (on-chain, AC-02)

All against S2's real attestation, via `staticCall` (no state change on revert):

| ID | AC | Check | Expected | Actual | Result |
| --- | --- | --- | --- | --- | --- |
| B-22 | AC-02 | `settle` with a non-attester signature (staker key) | revert `InvalidAttestation` | as expected | PASS |
| B-23 | AC-02 | `settle` with an attester signature over wrong fields (sessionId + 999) | revert `InvalidAttestation` (digest rebuilt from stored fields, R9) | as expected | PASS |
| B-60 | AC-02/13 | `settle` with the (valid) attestation **after** `settlementDeadline` — expired proof | revert `OutsideSettlementWindow` | as expected | PASS |
| M-08a | AC-07 | replayed `settle` on the completed mobile session | revert `WrongStatus` | see §6 | PASS |

### 5.3 admitDefeat payout routes (AC-06) and admin void (AC-08)

| ID | AC | Check | Expected | Actual | Result |
| --- | --- | --- | --- | --- | --- |
| B-40 | AC-06 | confess, route Charity | `claimable[charity] += 0.02`, staker NFT count unchanged | as expected | PASS |
| B-41 | AC-06 | confess, route Verifier | `claimable[vera] = 0.03` | as expected | PASS |
| B-42 | AC-06 | confess, route Custom (friend) | `claimable[fred] = 0.04` | as expected | PASS |
| B-50 | AC-08 | owner `voidSession` on Active session | `Voided`, full principal to claimable, no mint | as expected | PASS |
| B-51 | AC-08 | owner `voidSession` on Pending session | full refund `claimable[alice] = 0.05` | as expected | PASS |
| B-53 | AC-08 | `voidSession` by non-owner | revert `OwnableUnauthorizedAccount` | as expected | PASS |
| B-67 | AC-08 | `voidSession` on a terminal (Forfeited) session | revert `WrongStatus` | as expected | PASS |

### 5.4 Terminal-state rejections (AC-07/13) and timeout forfeit (AC-03/21/25)

| ID | AC | Check | Expected | Actual | Result |
| --- | --- | --- | --- | --- | --- |
| B-43 | AC-07 | re-confession on Forfeited position | revert `WrongStatus` | as expected | PASS |
| B-44 | AC-07 | `verify` on Forfeited position | revert `WrongStatus` | as expected | PASS |
| B-45 | AC-07 | `forfeit` on already Forfeited position | revert `WrongStatus` | as expected | PASS |
| B-52 | AC-07/08 | `startSession` on Voided session | revert `WrongStatus` | as expected | PASS |
| B-54 | AC-07 | `admitDefeat` on Voided session | revert `WrongStatus` | as expected | PASS |
| B-61 | AC-13 | `admitDefeat` after `settlementDeadline` | revert `OutsideSettlementWindow` | as expected | PASS |
| B-62 | AC-03/25 | `forfeit` at/after `settlementDeadline` | `Forfeited`, stake to charity claimable | `claimable[charity] 0.02→0.07` | PASS |
| B-63 | AC-03/21 | permissionless `forfeit` (non-participant caller) of F1/F2/F3 | all refused stakes to charity | `claimable[charity] = 0.22` | PASS |
| B-64 | — | no beast minted on any failure path | NFT balances unchanged | alice 0, bob 0 | PASS |
| B-65 | AC-07 | double `forfeit` | revert `WrongStatus` | as expected | PASS |
| B-66 | AC-07/13 | `settle` on Forfeited session | revert `WrongStatus` | as expected | PASS |
| B-90 | AC-11 | every claimant `withdraw()` (charity/vera/fred/bob/alice) | each claimable drained to 0 | 0.22 / 0.03 / 0.04 / 0.02 / 0.05 swept | PASS |
| B-91 | — | contract balance after the sweep | 0 ETH | 0 ETH | PASS |

**Outcome: 46/46 PASS.**

## 6. Phase 2 — mobile-wallet run (DAPP-18)

**Environment substitution (honest statement).** The agent runtime has no physical handset, so the run uses an **equivalent environment** as the task allows: a scripted wallet ("mobile-user", fresh Hardhat account #4) driving exactly the client surface a MetaMask-mobile in-app browser uses — connect (account funding), `personal_sign` for the bind challenge, plain `eth_sendTransaction` contract calls, and the same heartbeat wire protocol. Every signature and chain call is real; only the handset is substituted. Mobile-specific conditions are simulated where they affect the protocol: an ~8 s wallet-confirmation pause before `startSession`, and attestation polling started before the chain reaches `endTime`. **One manual pass on a physical MetaMask-mobile browser before the demo video remains a recommended leftover (§9).**

Step log (UX step → wire action) of the recorded run (2026-10-20 ~07:55–07:59 UTC, session 2, window `startTime 1792483003 → endTime 1792483123`):

| ID | Mobile UX step | Wire action | Expected | Actual | Result |
| --- | --- | --- | --- | --- | --- |
| M-00 | — | attester health | signer = on-chain attester | `0x7099…79C8` | PASS |
| M-01 | open dapp in MetaMask mobile, connect | `createSession` tx | Pending solo, 0.05 ETH escrowed | session 2, `stake=0.05` | PASS |
| M-02 | tap start, sign bind challenge in wallet sheet | `personal_sign` + `POST /v1/bind` | 200 `{clientToken, ready, seq 1}` | as expected | PASS |
| M-03 | wallet confirmation sheet ~8 s, then confirm | `startSession` tx + `POST /v1/arm` | startup protocol tolerates wallet latency (AC-27②) | Active, arm → monitoring | PASS |
| M-04 | focus page foreground, screen on, 2 min | heartbeat 5 s cadence | ≥20 beats, none flagged | 24 beats, no violation | PASS |
| M-05 | session done, app polls for proof | `GET /attestation` loop | **425 → 200 transition observed** | **425 × 2, then 200 after ~3 s** | PASS |
| M-06 | — | verify returned typed data | covers exactly the declared window, recovers attester | `[1792483003, 1792483123]`, `0x7099…79C8` | PASS |
| M-07 | tap "claim your beast" | `settle` tx | Completed, claimable 0.05, NFT minted to mobile-user | tokenId 2, owner `0x15d3…6A65` | PASS |
| M-08a–d | — | terminal-state re-ops on the completed session | replayed `settle` / `forfeit` / `admitDefeat` / owner `void` all revert `WrongStatus` | as expected | PASS |
| M-09 | tap withdraw | `withdraw` tx | +0.05 ETH − gas, claimable 0 | delta 0.04996753 ETH | PASS |
| M-10 | — | contract balance | 0 ETH | 0 ETH | PASS |

**Outcome: 14/14 PASS.** Startup-protocol findings: the ready-first protocol behaved as designed under mobile latency — bind completed inside the `startTime + 5 min` window, arming absorbed the wallet-confirmation pause (no coverage gap scored), and the 425→200 polling transition the frontend will rely on was observed explicitly (2 pending polls, signature served ~3 s after `endTime` under 5 s interval mining).

## 7. Task-item coverage map (DAPP-18 scope → evidence)

| Task spot-check item | Cases | AC | Result |
| --- | --- | --- | --- |
| hidden event → instant violation | B-04/05/07 | AC-12/29 | PASS |
| 15 s interruption judgment (10 s pass / 18 s fail / no recovery) | B-10/11/12 | AC-12 | PASS |
| forged / replayed / expired signature reverts | B-22/23/60, M-08a | AC-02/07 | PASS |
| timeout `forfeit` → charity claimable | B-06/62/63 | AC-03/21/25 | PASS |
| `admitDefeat` three payout routes | B-40/41/42 | AC-06 | PASS |
| admin `void` (+ boundaries) | B-50/51/53/67 | AC-08 | PASS |
| terminal states reject further operations | B-43/44/45/52/54/61/65/66, M-08a–d | AC-07/13 | PASS |
| mobile-wallet flow (equivalent env) | M-01…M-10 | AC-01/27 | PASS |
| attester restart recovery (phase-1 handoff item) | B-13/14/15 | AC-22 | PASS |

## 8. Issue log and fixes

All five issues found across both phases were harness/tooling bugs — **no contract-side or protocol-logic defect was found**; nothing needed escalation to Forge.

| # | Severity | Symptom | Root cause | Fix | Status |
| --- | --- | --- | --- | --- | --- |
| I-1 | low | E2E run crashed at the NFT-metadata check with `TypeError: Do not know how to serialize a BigInt` | test script passed the `beastMeta` struct straight into `JSON.stringify` | read the struct fields individually (`scripts/e2e-solo-success.js` E2E-16) | fixed, verified |
| I-2 | low | E2E-20 net-balance check off by exactly one tx fee (69,469,595,840,898 wei) | script summed gas of create/settle/withdraw but omitted the `startSession` fee | include `startFee` in the total (`scripts/e2e-solo-success.js` E2E-20) | fixed, verified |
| I-3 | medium | `cd attester && npm test` failed on Windows/Node 22 with `Cannot find module …\dist\test` | Node 22 on Windows does not scan a directory argument passed as `node --test dist/test/`; a glob argument is expanded by Node itself | `attester/package.json` test script → `node --test "dist/test/*.test.js"` | fixed, verified (30/30) |
| I-4 | low | every `expectRevert` check mis-reported a genuine revert as FAIL (`ProviderError: VM Exception…`) | Hardhat wraps `staticCall` revert data as `{message, data}` at `e.data.data`, not `e.data` | extract hex from `e.data.data` fallback chain before `parseError` (`scripts/e2e-*.js`) | fixed, verified (46/46) |
| I-5 | low | mobile run observed 0 × 425: the first attestation poll already returned 200 | heartbeat loop ran to `endTime + 1 s` (+5 s sleep), so polling started only after the chain had passed `endTime` | stop the loop 2 s before `endTime`; polling then catches 425 × 2 → 200 (`scripts/e2e-mobile-wallet.js`) | fixed, verified (14/14) |

Environment note for the runbook: stopping `npx hardhat node` via the task wrapper leaves the child `node.exe` holding port 8545; a redeploy against the stale chain then lands on unexpected addresses. Kill the exact listener PID (or verify the port is free) before redeploying — hit again in phase 2 and handled the same way. Operational only, no code change. (Feeding M4 runbook.)

## 9. Leftovers and explicit non-goals

- **Physical handset pass (recommended, non-blocking):** the mobile flow is verified in a scripted-wallet equivalent environment (§6); one manual MetaMask-mobile browser pass is recommended before the demo video. Owner: team member with a handset; no code dependency.
- **Clock-skew refusal paths (`unreliable_time` / `uncertifiable`)** require server-clock/RPC-staleness manipulation and stay in attester unit-test territory (30/30, `recovery.test.ts` / protocol suites) — no integration case added.
- **Exact boundary exactness** (14 s vs 16 s gap, `settlementDeadline ± 1`) is asserted by the unit suites (133/133 contract, 30/30 attester); integration spot-checks use 10 s / 18 s margins per AC-12 text.
- **Duel / co-focus integration runs** are outside M2 scope (P1/P2); their settlement matrices are unit-covered (AC-05/15/19/20/23/24 in `test/StakeBeast.cofocus.test.js` / `humanproof.test.js`).
- Phase-1 §6 handoff items are all closed: arming time-dimension (E2E-06), 15 s boundary moved here (B-10/11), 425→200 (M-05), restart recovery (B-13…15), refusal paths `violation` / `late_bind` (B-07/15/32); `unreliable_time` stays unit-covered per above.
