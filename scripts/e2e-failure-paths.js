// E2E failure & boundary paths (DAPP-18, M2 integration phase 2), on-chain
// spot-checks against the deployed contracts + the real attester service:
//   - hidden event => instant violation, refusal, forfeit to charity (AC-12/29/03)
//   - 10 s refresh gap passes, >15 s gap violates and recovery never clears (AC-12)
//   - attester restart recovers judgment state mid-session (AC-22, WP3 persistence)
//   - late bind (> startTime + 5 min) => late_bind refusal, forfeitable (AC-21)
//   - forged / wrong-field / expired settlement signatures revert (AC-02)
//   - admitDefeat payout routes: Charity / Verifier / Custom (AC-06)
//   - admin void refunds fully without mint; terminal void reverts (AC-08)
//   - terminal states reject every further operation (AC-07/13)
//
// The script spawns its own attester instance (port 3101, temp DATA_DIR) so the
// restart case is deterministic; it requires:
//   1. HARDHAT_MINING_INTERVAL=5000 npx hardhat node
//   2. npx hardhat run scripts/deploy.js --network localhost
//   3. (cd attester && npm run build)
//   4. ATTESTER_PRIVATE_KEY=<key of the attester account> in the environment
// Run:
//   ATTESTER_PRIVATE_KEY=... npx hardhat run scripts/e2e-failure-paths.js --network localhost
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ATTESTER_PORT = Number(process.env.ATTESTER_PORT || 3101);
const ATTESTER_URL = `http://localhost:${ATTESTER_PORT}`;
const STAKE = ethers.parseEther("0.05");
const HB_CADENCE_MS = 5000;

const results = [];
function check(id, name, expected, actual, pass) {
  results.push({ id, name, expected, actual, result: pass ? "PASS" : "FAIL" });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name} | expected=${expected} actual=${actual}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body, token) {
  const res = await fetch(`${ATTESTER_URL}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, body: json };
}

// ------------------------------------------------------- attester lifecycle --
let attesterChild = null;
let attesterDataDir = null;
function startAttester(contractAddress, chainId) {
  const key = process.env.ATTESTER_PRIVATE_KEY;
  if (!key) throw new Error("ATTESTER_PRIVATE_KEY is required to spawn the attester");
  const entry = path.join(__dirname, "..", "attester", "dist", "src", "index.js");
  if (!fs.existsSync(entry)) throw new Error("attester not built: run `cd attester && npm run build` first");
  if (!attesterDataDir) attesterDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-attester-"));
  attesterChild = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      RPC_URL: "http://127.0.0.1:8545",
      CONTRACT_ADDRESS: contractAddress,
      ATTESTER_PRIVATE_KEY: key,
      PORT: String(ATTESTER_PORT),
      DATA_DIR: attesterDataDir,
      CHAIN_ID: String(chainId),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  attesterChild.stdout.on("data", (d) => process.stdout.write(`[attester] ${d}`));
  attesterChild.stderr.on("data", (d) => process.stdout.write(`[attester:err] ${d}`));
  return attesterChild;
}
async function stopAttester() {
  if (!attesterChild) return;
  const child = attesterChild;
  attesterChild = null;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 8000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
async function waitHealth(timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await api("GET", "/health");
      if (r.status === 200) return r.body;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error("attester did not become healthy in time");
    await sleep(300);
  }
}

// ------------------------------------------------------------- kit helpers --
async function bindClient(stake, deployment, chainId, signer, sessionId) {
  const ch = await api("POST", "/v1/bind/challenge", {
    chainId,
    contract: deployment.stakeBeast,
    sessionId: sessionId.toString(),
    address: signer.address,
  });
  if (ch.status !== 200) return { bind: ch };
  const bindSig = await signer.signMessage(ch.body.message);
  const bind = await api("POST", "/v1/bind", {
    chainId,
    contract: deployment.stakeBeast,
    sessionId: sessionId.toString(),
    address: signer.address,
    nonce: ch.body.nonce,
    bindSig,
  });
  return { challenge: ch, bind };
}

async function createSolo(stake, signer, durationMinutes) {
  const tx = await stake.connect(signer).createSession(
    0, // Mode.SoloFocus
    ethers.ZeroAddress,
    0, // Payee.Charity
    ethers.ZeroAddress,
    durationMinutes,
    0,
    0,
    0,
    "",
    { value: STAKE }
  );
  await tx.wait();
  return (await stake.nextSessionId()) - 1n;
}

async function createSupervised(stake, signer, verifier, payee, customPayee, stakeValue) {
  const tx = await stake.connect(signer).createSession(
    1, // Mode.Supervised
    verifier,
    payee,
    customPayee,
    0,
    1, // periodDays: one-off task
    1,
    1,
    "spot-check task",
    { value: stakeValue }
  );
  await tx.wait();
  return (await stake.nextSessionId()) - 1n;
}

async function armAndStart(stake, deployment, signer, sessionId, token) {
  const startTx = await stake.connect(signer).startSession(sessionId);
  await startTx.wait();
  const arm = await api("POST", "/v1/arm", { sessionId: sessionId.toString(), txHash: startTx.hash }, token);
  return { startTx, arm };
}

async function heartbeat(sessionId, seq, token) {
  return api("POST", "/v1/heartbeat", { sessionId: sessionId.toString(), seq }, token);
}

async function waitChainPast(provider, unixSeconds) {
  for (;;) {
    const b = await provider.getBlock("latest");
    if (b.timestamp >= unixSeconds) return;
    await sleep(1500);
  }
}

// Expect a specific custom-error revert from a staticCall.
async function expectRevert(contract, id, name, errorName, call) {
  try {
    await call();
    check(id, name, `revert ${errorName}`, "no revert (call succeeded)", false);
  } catch (e) {
    // Hardhat wraps staticCall reverts: the revert data hex sits at
    // e.data.data (e.data is {message, data}); plain nodes give e.data directly.
    const hex = typeof e?.data === "string" ? e.data : e?.data?.data ?? e?.info?.error?.data;
    let parsed = null;
    try {
      parsed = hex ? contract.interface.parseError(hex) : null;
    } catch {
      /* unparsable */
    }
    check(id, name, `revert ${errorName}`, `revert ${parsed ? parsed.name : String(e).slice(0, 80)}`,
      !!parsed && parsed.name === errorName);
  }
}

async function main() {
  const deployment = JSON.parse(
    fs.readFileSync(
      process.env.DEPLOYMENT_JSON || path.join(__dirname, "..", "deployments", "localhost.json"),
      "utf8"
    )
  );
  const signers = await ethers.getSigners();
  const [owner, attester, charity, alice, , bob, vera, fred] = signers;
  const stake = await ethers.getContractAt("StakeBeast", deployment.stakeBeast);
  const nft = await ethers.getContractAt("BeastNFT", deployment.beastNFT);
  const provider = ethers.provider;
  const chainId = Number((await provider.getNetwork()).chainId);
  console.log(`contract=${deployment.stakeBeast} chainId=${chainId} attesterApi=${ATTESTER_URL}`);
  console.log(`alice=${alice.address} bob=${bob.address} vera=${vera.address} fred=${fred.address}`);

  startAttester(deployment.stakeBeast, chainId);
  const health = await waitHealth();
  check("B-00", "attester spawned by the script and healthy",
    "200 + signer==on-chain attester", `${health.signer}`,
    health.signer?.toLowerCase() === attester.address.toLowerCase());

  const statusOf = (sessionId, token) =>
    api("GET", `/v1/sessions/${sessionId}/status?chainId=${chainId}&contract=${deployment.stakeBeast}`, undefined, token);
  const attestationOf = (sessionId, token) =>
    api("GET", `/v1/sessions/${sessionId}/attestation?chainId=${chainId}&contract=${deployment.stakeBeast}`, undefined, token);

  // ============================================================ timeline ----
  // F3's late-bind clock (startTime + 5 min, wall clock) ticks while F1/F2/S2
  // run; all refusal checks happen in real time; only the settlement phase at
  // the end fast-forwards the chain past the settlement deadlines.
  console.log("\n---- F3 setup: solo session started, left unbound (AC-21 late-bind clock starts) ----");
  const f3 = await createSolo(stake, bob, 2);
  await (await stake.connect(bob).startSession(f3)).wait();
  const f3s = await stake.getSession(f3);
  console.log(`F3 session=${f3} startTime=${f3s.startTime} (bind deliberately withheld)`);

  // ------------------------------------------------ F1: hidden event (AC-12/29)
  console.log("\n---- F1: visibility_hidden => instant violation ----");
  const f1 = await createSolo(stake, alice, 2);
  let r = await bindClient(stake, deployment, chainId, alice, f1);
  const f1Token = r.bind.body.clientToken;
  check("B-01", "F1 bound and ready before start", "200 {clientToken,status:ready}",
    `${r.bind.status} ${r.bind.body?.status}`, r.bind.status === 200 && r.bind.body?.status === "ready");
  const reused = await api("POST", "/v1/bind", {
    chainId, contract: deployment.stakeBeast, sessionId: f1.toString(),
    address: alice.address, nonce: r.challenge.body.nonce,
    bindSig: await alice.signMessage(r.challenge.body.message),
  });
  check("B-02", "consumed challenge nonce rejected on reuse (AC-31)",
    "401 nonce_used", `${reused.status} ${reused.body?.error?.code}`,
    reused.status === 401 && reused.body?.error?.code === "nonce_used");
  const f1Start = await armAndStart(stake, deployment, alice, f1, f1Token);
  check("B-03", "F1 armed, monitoring", "200 {state:monitoring}",
    `${f1Start.arm.status} ${f1Start.arm.body?.state}`,
    f1Start.arm.status === 200 && f1Start.arm.body?.state === "monitoring");
  let f1Seq = 1;
  for (let i = 0; i < 3; i++) {
    await heartbeat(f1, f1Seq++, f1Token);
    await sleep(HB_CADENCE_MS);
  }
  const ev = await api("POST", "/v1/event",
    { sessionId: f1.toString(), eventId: `ev-f1-hidden-1`, type: "visibility_hidden" }, f1Token);
  check("B-04", "hidden event flags an instant violation (AC-12)",
    "200 {ok:true,violation:true} on the event response itself",
    `${ev.status} ${JSON.stringify(ev.body)}`,
    ev.status === 200 && ev.body?.ok === true && ev.body?.violation === true);
  const f1Status = await statusOf(f1, f1Token);
  const f1Me = f1Status.body?.participants?.[0];
  check("B-05", "F1 status records the violation reason",
    "violation=hidden", `violation=${f1Me?.violation}`,
    f1Status.status === 200 && f1Me?.violation === "hidden");
  const f1s = await stake.getSession(f1);
  await expectRevert(stake, "B-06", "forfeit before settlementDeadline reverts (AC-03/25)",
    "NotYetForfeitable",
    () => stake.connect(owner).forfeit.staticCall(f1));
  await waitChainPast(provider, Number(f1s.endTime));
  const f1Att = await attestationOf(f1, f1Token);
  check("B-07", "attestation refused for a violated session (AC-12, fail-closed)",
    "409 {state:refused,reason:violation}", `${f1Att.status} ${JSON.stringify(f1Att.body)}`,
    f1Att.status === 409 && f1Att.body?.state === "refused" && f1Att.body?.reason === "violation");

  // ------------------------------------- F2: 10 s pass / >15 s fail (AC-12) + restart (AC-22)
  console.log("\n---- F2: heartbeat-gap boundaries + attester restart recovery ----");
  const f2 = await createSolo(stake, alice, 2);
  r = await bindClient(stake, deployment, chainId, alice, f2);
  const f2Token = r.bind.body.clientToken;
  const f2Start = await armAndStart(stake, deployment, alice, f2, f2Token);
  let f2Seq = 1;
  for (let i = 0; i < 3; i++) {
    await heartbeat(f2, f2Seq++, f2Token);
    await sleep(HB_CADENCE_MS);
  }
  await sleep(10_000); // 10 s refresh-recovery gap: inside the 15 s tolerance
  const after10 = await heartbeat(f2, f2Seq++, f2Token);
  check("B-10", "10 s refresh-recovery gap is not a violation (AC-12)",
    "200 {ok:true,violation:false}", `${after10.status} ${JSON.stringify(after10.body)}`,
    after10.status === 200 && after10.body?.violation === false);
  await sleep(HB_CADENCE_MS);
  await heartbeat(f2, f2Seq++, f2Token);
  await sleep(18_000); // >15 s gap: violation; tolerance is 15 s, margin 3 s
  const after18 = await heartbeat(f2, f2Seq++, f2Token);
  check("B-11", ">15 s gap (18 s) is a violation (AC-12)",
    "200 {ok:true,violation:true}", `${after18.status} ${JSON.stringify(after18.body)}`,
    after18.status === 200 && after18.body?.violation === true);
  await sleep(HB_CADENCE_MS);
  const resumed = await heartbeat(f2, f2Seq++, f2Token);
  check("B-12", "resumed heartbeats do not clear the violation (AC-12)",
    "violation stays true on later beats", JSON.stringify(resumed.body),
    resumed.status === 200 && resumed.body?.violation === true);

  console.log("---- restarting the attester service (SIGTERM, same DATA_DIR) ----");
  await stopAttester();
  startAttester(deployment.stakeBeast, chainId);
  const health2 = await waitHealth();
  check("B-13", "attester restarted and healthy (AC-22)", "200 + same signer",
    health2.signer, health2.signer?.toLowerCase() === attester.address.toLowerCase());
  const f2Status = await statusOf(f2, f2Token);
  const f2Me = f2Status.body?.participants?.[0];
  check("B-14", "judgment state survives the restart: violation + seq watermark preserved",
    "violation=heartbeat_timeout, nextHeartbeatSeq continues from the pre-restart max",
    `violation=${f2Me?.violation}, nextHeartbeatSeq=${f2Status.body?.nextHeartbeatSeq}, clientSeq=${f2Seq}`,
    f2Status.status === 200 && f2Me?.violation === "heartbeat_timeout" &&
      f2Status.body?.nextHeartbeatSeq === f2Seq);
  const f2s = await stake.getSession(f2);
  await waitChainPast(provider, Number(f2s.endTime));
  const f2Att = await attestationOf(f2, f2Token);
  check("B-15", "refusal persists across the restart (AC-22)",
    "409 {state:refused,reason:violation}", `${f2Att.status} ${JSON.stringify(f2Att.body)}`,
    f2Att.status === 409 && f2Att.body?.reason === "violation");

  // ------------------------------------ S2: clean session for signature abuse
  console.log("\n---- S2: clean 1-min session => real attestation, then forged/wrong-field reverts ----");
  const s2 = await createSolo(stake, alice, 1);
  r = await bindClient(stake, deployment, chainId, alice, s2);
  const s2Token = r.bind.body.clientToken;
  await armAndStart(stake, deployment, alice, s2, s2Token);
  const s2s = await stake.getSession(s2);
  let s2Seq = 1;
  let s2Violation = false;
  while (Date.now() < Number(s2s.endTime) * 1000 + 1_000) {
    const hb = await heartbeat(s2, s2Seq++, s2Token);
    if (hb.body?.violation) s2Violation = true;
    await sleep(HB_CADENCE_MS);
  }
  check("B-20", "S2 monitored clean for the full 1-min window", "no violation",
    `violationSeen=${s2Violation}, beats=${s2Seq - 1}`, !s2Violation);
  await waitChainPast(provider, Number(s2s.endTime));
  const s2Att = await attestationOf(s2, s2Token);
  check("B-21", "S2 attestation issued", "200 {typedData,signature}",
    `${s2Att.status}`, s2Att.status === 200 && !!s2Att.body?.signature);
  const td = s2Att.body.typedData;
  const wrongSignerSig = await alice.signTypedData(td.domain, td.types, td.message);
  await expectRevert(stake, "B-22", "settle with a non-attester signature reverts (AC-02)",
    "InvalidAttestation",
    () => stake.connect(alice).settle.staticCall(s2, wrongSignerSig));
  const wrongFieldSig = await attester.signTypedData(td.domain, td.types, {
    ...td.message, sessionId: (BigInt(td.message.sessionId) + 999n).toString(),
  });
  await expectRevert(stake, "B-23", "settle with an attester signature over wrong fields reverts (AC-02)",
    "InvalidAttestation",
    () => stake.connect(alice).settle.staticCall(s2, wrongFieldSig));

  // ------------------------------------------------ F3: late bind (AC-21) ----
  console.log("\n---- F3: first bind after startTime + 5 min ----");
  const f3bindElapsed = Date.now() - Number(f3s.startTime) * 1000;
  r = await bindClient(stake, deployment, chainId, bob, f3);
  check("B-30", "late first bind is accepted into monitoring but flagged (fail-closed, AC-21)",
    "200 token issued (window not yet known to the service at bind time)",
    `${r.bind.status} elapsedSinceStart=${Math.round(f3bindElapsed / 1000)}s`,
    r.bind.status === 200 && !!r.bind.body?.clientToken && f3bindElapsed > 5 * 60_000);
  const f3Token = r.bind.body.clientToken;
  await sleep(4_000); // let the watcher learn the window and sweep the bind backstop
  const f3Status = await statusOf(f3, f3Token);
  const f3Me = f3Status.body?.participants?.[0];
  check("B-31", "bind backstop marks the late binder (AC-21)",
    "violation=bind_timeout", `violation=${f3Me?.violation}`,
    f3Status.status === 200 && f3Me?.violation === "bind_timeout");
  const f3Att = await attestationOf(f3, f3Token);
  check("B-32", "attestation refused as late_bind (AC-21)",
    "409 {state:refused,reason:late_bind}", `${f3Att.status} ${JSON.stringify(f3Att.body)}`,
    f3Att.status === 409 && f3Att.body?.reason === "late_bind");

  // --------------------------------- admitDefeat routes (AC-06) + void (AC-08)
  console.log("\n---- admitDefeat payout routes and admin void ----");
  const stakeA = ethers.parseEther("0.02");
  const stakeB = ethers.parseEther("0.03");
  const stakeC = ethers.parseEther("0.04");
  const nftBob0 = await nft.balanceOf(bob.address);
  const adCharity = await createSupervised(stake, bob, vera.address, 0, ethers.ZeroAddress, stakeA);
  await (await stake.connect(bob).admitDefeat(adCharity)).wait();
  check("B-40", "admitDefeat route Charity credits the charity claimable (AC-06)",
    `claimable[charity] += ${ethers.formatEther(stakeA)} ETH, staker NFT count unchanged`,
    `claimable[charity]=${ethers.formatEther(await stake.claimableOf(charity.address))}`,
    (await stake.claimableOf(charity.address)) === stakeA &&
      (await nft.balanceOf(bob.address)) === nftBob0);
  const adVerifier = await createSupervised(stake, bob, vera.address, 1, ethers.ZeroAddress, stakeB);
  await (await stake.connect(bob).admitDefeat(adVerifier)).wait();
  check("B-41", "admitDefeat route Verifier credits the verifier claimable (AC-06)",
    `claimable[vera] = ${ethers.formatEther(stakeB)} ETH`,
    `claimable[vera]=${ethers.formatEther(await stake.claimableOf(vera.address))}`,
    (await stake.claimableOf(vera.address)) === stakeB);
  const adCustom = await createSupervised(stake, bob, vera.address, 2, fred.address, stakeC);
  await (await stake.connect(bob).admitDefeat(adCustom)).wait();
  check("B-42", "admitDefeat route Custom credits the preset friend address (AC-06)",
    `claimable[fred] = ${ethers.formatEther(stakeC)} ETH`,
    `claimable[fred]=${ethers.formatEther(await stake.claimableOf(fred.address))}`,
    (await stake.claimableOf(fred.address)) === stakeC);
  await expectRevert(stake, "B-43", "re-confession on a terminal position reverts (AC-07)",
    "WrongStatus", () => stake.connect(bob).admitDefeat.staticCall(adCharity));
  await expectRevert(stake, "B-44", "verify on a forfeited position reverts (AC-07)",
    "WrongStatus", () => stake.connect(vera).verify.staticCall(adCharity));
  await expectRevert(stake, "B-45", "forfeit on an already forfeited position reverts (AC-07)",
    "WrongStatus", () => stake.connect(owner).forfeit.staticCall(adCharity));

  const voidActive = await createSupervised(stake, bob, vera.address, 0, ethers.ZeroAddress, stakeA);
  await (await stake.connect(owner).voidSession(voidActive)).wait();
  const voidActiveS = await stake.getSession(voidActive);
  check("B-50", "admin void of an Active session refunds fully without mint (AC-08)",
    `status=Voided(4), claimable[bob] += ${ethers.formatEther(stakeA)} ETH, NFT count unchanged`,
    `status=${voidActiveS.status}, claimable[bob]=${ethers.formatEther(await stake.claimableOf(bob.address))}`,
    voidActiveS.status === 4n && (await stake.claimableOf(bob.address)) === stakeA &&
      (await nft.balanceOf(bob.address)) === nftBob0);
  const voidPending = await createSolo(stake, alice, 2);
  await (await stake.connect(owner).voidSession(voidPending)).wait();
  check("B-51", "admin void of a Pending session refunds fully (AC-08)",
    `claimable[alice] = ${ethers.formatEther(STAKE)} ETH`,
    `claimable[alice]=${ethers.formatEther(await stake.claimableOf(alice.address))}`,
    (await stake.claimableOf(alice.address)) === STAKE);
  await expectRevert(stake, "B-52", "startSession on a voided session reverts (AC-07/08)",
    "WrongStatus", () => stake.connect(alice).startSession.staticCall(voidPending));
  await expectRevert(stake, "B-53", "void by a non-owner reverts (AC-08 admin boundary)",
    "OwnableUnauthorizedAccount", () => stake.connect(alice).voidSession.staticCall(f3));
  await expectRevert(stake, "B-54", "admitDefeat on a voided session reverts (AC-07)",
    "WrongStatus", () => stake.connect(bob).admitDefeat.staticCall(voidActive));

  // -------------------------------------- settlement phase: fast-forward ----
  console.log("\n---- settlement phase: fast-forward past every settlementDeadline ----");
  const deadlines = [f1s, f2s, f3s, s2s].map((s) => Number(s.settlementDeadline));
  const maxDeadline = Math.max(...deadlines);
  const nowTs = (await provider.getBlock("latest")).timestamp;
  await provider.send("evm_increaseTime", [maxDeadline - nowTs + 30]);
  await provider.send("evm_mine", []);
  console.log(`chain time jumped +${maxDeadline - nowTs + 30}s to ${maxDeadline + 30}`);

  await expectRevert(stake, "B-60", "settle with an expired attestation reverts (AC-02/13)",
    "OutsideSettlementWindow",
    () => stake.connect(alice).settle.staticCall(s2, s2Att.body.signature));
  await expectRevert(stake, "B-61", "admitDefeat after the deadline reverts (AC-13)",
    "OutsideSettlementWindow",
    () => stake.connect(alice).admitDefeat.staticCall(s2));

  const charityBefore = await stake.claimableOf(charity.address);
  const expectCharity = charityBefore + STAKE * 4n; // S2 + F1 + F2 + F3
  await (await stake.connect(owner).forfeit(s2)).wait();
  const s2f = await stake.getSession(s2);
  check("B-62", "forfeit at/after settlementDeadline succeeds, stake to charity (AC-03/25)",
    `status=Forfeited(3), claimable[charity] += ${ethers.formatEther(STAKE)}`,
    `status=${s2f.status}, claimable[charity]=${ethers.formatEther(await stake.claimableOf(charity.address))}`,
    s2f.status === 3n && (await stake.claimableOf(charity.address)) === charityBefore + STAKE);
  await (await stake.connect(owner).forfeit(f1)).wait();
  await (await stake.connect(owner).forfeit(f2)).wait();
  await (await stake.connect(owner).forfeit(f3)).wait();
  check("B-63", "permissionless forfeit (called by a non-participant) routes all refused stakes to charity (AC-03/21)",
    `claimable[charity] = ${ethers.formatEther(expectCharity)} ETH`,
    `claimable[charity]=${ethers.formatEther(await stake.claimableOf(charity.address))}`,
    (await stake.claimableOf(charity.address)) === expectCharity);
  const nftAlice = await nft.balanceOf(alice.address);
  const nftBob = await nft.balanceOf(bob.address);
  check("B-64", "no beast minted on any failure path",
    `alice NFTs unchanged (${nftAlice}), bob NFTs unchanged (${nftBob})`,
    `alice=${nftAlice}, bob=${nftBob}`,
    nftAlice === 0n && nftBob === nftBob0);
  await expectRevert(stake, "B-65", "double forfeit reverts (AC-07)",
    "WrongStatus", () => stake.connect(owner).forfeit.staticCall(f1));
  await expectRevert(stake, "B-66", "settle on a forfeited session reverts (AC-07/13)",
    "WrongStatus", () => stake.connect(alice).settle.staticCall(f1, s2Att.body.signature));
  await expectRevert(stake, "B-67", "void on a terminal session reverts (AC-08)",
    "WrongStatus", () => stake.connect(owner).voidSession.staticCall(f1));

  // ------------------------------------------------------ withdraw sweep ----
  console.log("\n---- withdraw sweep: every claimant pulls, contract drains to zero ----");
  for (const [label, signer] of [["charity", charity], ["vera", vera], ["fred", fred], ["bob", bob], ["alice", alice]]) {
    const c = await stake.claimableOf(signer.address);
    if (c === 0n) continue;
    await (await stake.connect(signer).withdraw()).wait();
    check(`B-90-${label}`, `withdraw sweeps ${label}'s claimable`, "claimable=0 after withdraw",
      `was=${ethers.formatEther(c)}, now=${ethers.formatEther(await stake.claimableOf(signer.address))}`,
      (await stake.claimableOf(signer.address)) === 0n);
  }
  check("B-91", "contract balance back to zero after the sweep", "0 ETH",
    ethers.formatEther(await provider.getBalance(deployment.stakeBeast)),
    (await provider.getBalance(deployment.stakeBeast)) === 0n);

  // ------------------------------------------------------------ summary ---
  await stopAttester();
  if (attesterDataDir) fs.rmSync(attesterDataDir, { recursive: true, force: true });
  const failed = results.filter((x) => x.result === "FAIL");
  console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed ====`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error);
  await stopAttester();
  process.exitCode = 1;
});
