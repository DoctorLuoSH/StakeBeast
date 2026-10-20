// Mobile-wallet flow run (DAPP-18, M2 integration phase 2).
//
// Equivalent environment: the agent runtime has no physical handset, so this
// script drives the exact client surface a MetaMask-mobile in-app browser
// would use — a fresh wallet account ("mobile-user"), `personal_sign` for the
// bind challenge, plain contract transactions for create/start/settle/withdraw,
// and the same heartbeat wire protocol — while simulating the mobile-specific
// behaviors that matter to the startup protocol (wallet-confirmation latency,
// attestation polling through the 425 -> 200 transition). Every chain call and
// signature is real; only the handset is substituted.
//
// Prerequisites: same as scripts/e2e-failure-paths.js (node + deploy + attester
// build + ATTESTER_PRIVATE_KEY). Run:
//   ATTESTER_PRIVATE_KEY=... npx hardhat run scripts/e2e-mobile-wallet.js --network localhost
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ATTESTER_PORT = Number(process.env.ATTESTER_PORT || 3101);
const ATTESTER_URL = `http://localhost:${ATTESTER_PORT}`;
const STAKE = ethers.parseEther("0.05");
const DURATION_MINUTES = 2;
const HB_CADENCE_MS = 5000;
const WALLET_CONFIRM_DELAY_MS = 8_000; // simulated mobile wallet confirmation sheet

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

let attesterChild = null;
let attesterDataDir = null;
function startAttester(contractAddress, chainId) {
  const key = process.env.ATTESTER_PRIVATE_KEY;
  if (!key) throw new Error("ATTESTER_PRIVATE_KEY is required to spawn the attester");
  const entry = path.join(__dirname, "..", "attester", "dist", "src", "index.js");
  if (!fs.existsSync(entry)) throw new Error("attester not built: run `cd attester && npm run build` first");
  if (!attesterDataDir) attesterDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-attester-mobile-"));
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
  const [owner, attester, , , mobileUser] = signers;
  const stake = await ethers.getContractAt("StakeBeast", deployment.stakeBeast);
  const nft = await ethers.getContractAt("BeastNFT", deployment.beastNFT);
  const provider = ethers.provider;
  const chainId = Number((await provider.getNetwork()).chainId);
  console.log(`contract=${deployment.stakeBeast} chainId=${chainId} attesterApi=${ATTESTER_URL}`);
  console.log(`mobile-user=${mobileUser.address} (fresh wallet, funded like a new handset account)`);
  console.log("step log: [mobile ux step] -> wire action");

  startAttester(deployment.stakeBeast, chainId);
  const health = await waitHealth();
  check("M-00", "attester healthy", "200 + signer==on-chain attester",
    health.signer, health.signer?.toLowerCase() === attester.address.toLowerCase());

  // ------------------------------------------- 1. connect + create session --
  console.log("[open dapp in MetaMask mobile browser, connect wallet] -> fresh account, create session tx");
  const createTx = await stake.connect(mobileUser).createSession(
    0, // Mode.SoloFocus
    ethers.ZeroAddress,
    0, // Payee.Charity
    ethers.ZeroAddress,
    DURATION_MINUTES,
    0, 0, 0, "",
    { value: STAKE }
  );
  await createTx.wait();
  const sessionId = (await stake.nextSessionId()) - 1n;
  let s = await stake.getSession(sessionId);
  check("M-01", "session created from the mobile wallet", "Pending SoloFocus, stake 0.05 ETH",
    `session=${sessionId}, status=${s.status}, stake=${ethers.formatEther(s.stake)}`,
    s.status === 0n && s.staker === mobileUser.address && s.stake === STAKE);

  // ------------------------------------------ 2. bind (personal_sign sheet) --
  console.log("[tap 'start focusing', sign the bind challenge in the wallet sheet] -> personal_sign + POST /v1/bind");
  const ch = await api("POST", "/v1/bind/challenge", {
    chainId, contract: deployment.stakeBeast, sessionId: sessionId.toString(), address: mobileUser.address,
  });
  const bindSig = await mobileUser.signMessage(ch.body.message); // personal_sign, what the mobile wallet shows
  const bind = await api("POST", "/v1/bind", {
    chainId, contract: deployment.stakeBeast, sessionId: sessionId.toString(),
    address: mobileUser.address, nonce: ch.body.nonce, bindSig,
  });
  check("M-02", "bind via mobile personal_sign issues the client token",
    "200 {clientToken,status:ready,nextHeartbeatSeq:1}",
    `${bind.status} ${JSON.stringify({ status: bind.body?.status, nextHeartbeatSeq: bind.body?.nextHeartbeatSeq })}`,
    bind.status === 200 && !!bind.body?.clientToken && bind.body?.status === "ready" && bind.body?.nextHeartbeatSeq === 1);
  const token = bind.body.clientToken;
  let seq = bind.body.nextHeartbeatSeq;

  // --------------------- 3. wallet-confirmation latency, then startSession --
  console.log(`[wallet confirmation sheet stays up ~${WALLET_CONFIRM_DELAY_MS / 1000}s] -> startSession tx, then arm`);
  await sleep(WALLET_CONFIRM_DELAY_MS); // AC-27 (2): wallet-confirmation delay must not break the startup protocol
  const startTx = await stake.connect(mobileUser).startSession(sessionId);
  await startTx.wait();
  s = await stake.getSession(sessionId);
  const arm = await api("POST", "/v1/arm", { sessionId: sessionId.toString(), txHash: startTx.hash }, token);
  check("M-03", "startup protocol tolerates wallet-confirmation latency (AC-27)",
    "Active on-chain; arm -> monitoring",
    `status=${s.status}, arm=${arm.status} ${arm.body?.state}`,
    s.status === 1n && arm.status === 200 && arm.body?.state === "monitoring");
  const endMs = Number(s.endTime) * 1000;

  // ------------------------- 4. screen-on heartbeat loop over the window ----
  console.log("[focus page stays in the foreground, screen on] -> 5 s heartbeat cadence");
  let beats = 0;
  let violationSeen = false;
  // Stop beating ~2 s before endTime so the attestation poll below starts
  // BEFORE the chain passes endTime (tail gap to endTime stays << 15 s).
  while (Date.now() < endMs - 2_000) {
    const hb = await api("POST", "/v1/heartbeat", { sessionId: sessionId.toString(), seq: seq++ }, token);
    if (hb.status === 200 && hb.body?.ok) beats++;
    if (hb.body?.violation) violationSeen = true;
    await sleep(HB_CADENCE_MS);
  }
  check("M-04", "heartbeats accepted for the whole window from the mobile client",
    ">=20 beats at 5 s cadence, none flagged",
    `${beats} beats, violationSeen=${violationSeen}`,
    beats >= 20 && !violationSeen);

  // ------------------------- 5. attestation polling: 425 -> 200 transition --
  console.log("[session complete, app polls for the proof] -> GET /attestation until 200");
  const pollT0 = Date.now();
  let att = null;
  let pending = 0;
  for (let i = 0; i < 40; i++) {
    const r = await api("GET", `/v1/sessions/${sessionId}/attestation?chainId=${chainId}&contract=${deployment.stakeBeast}`, undefined, token);
    if (r.status === 200) {
      att = r.body;
      break;
    }
    if (r.status === 425) {
      pending++;
      await sleep(1500);
      continue;
    }
    break;
  }
  check("M-05", "attestation polling exercises the 425 -> 200 transition",
    ">=1 pending (425) response, then 200 {typedData,signature}",
    `425 x ${pending}, then ${att ? "200" : "no 200"} after ${Math.round((Date.now() - pollT0) / 1000)}s`,
    pending >= 1 && !!att?.signature);
  const td = att.typedData;
  const recovered = ethers.verifyTypedData(td.domain, td.types, td.message, att.signature);
  check("M-06", "proof covers exactly the declared window and recovers the attester",
    `window [${s.startTime}, ${s.endTime}], signer=${attester.address}`,
    `window [${td.message.startTime}, ${td.message.endTime}], signer=${recovered}`,
    recovered.toLowerCase() === attester.address.toLowerCase() &&
      Number(td.message.startTime) === Number(s.startTime) &&
      Number(td.message.endTime) === Number(s.endTime));

  // ------------------------------------------------------------- 6. settle --
  console.log("[tap 'claim your beast'] -> settle tx in the mobile wallet");
  const settleTx = await stake.connect(mobileUser).settle(sessionId, att.signature);
  const settleRcpt = await settleTx.wait();
  s = await stake.getSession(sessionId);
  const completedLog = settleRcpt.logs
    .map((l) => {
      try {
        return stake.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((x) => x && x.name === "SessionCompleted");
  const tokenId = completedLog?.args?.tokenIds?.[0];
  check("M-07", "settle from the mobile wallet completes and mints the beast",
    "status=Completed, claimable=0.05 ETH, NFT to mobile-user",
    `status=${s.status}, claimable=${ethers.formatEther(await stake.claimableOf(mobileUser.address))}, tokenId=${tokenId}, owner=${tokenId !== undefined ? await nft.ownerOf(tokenId) : "-"}`,
    s.status === 2n && (await stake.claimableOf(mobileUser.address)) === STAKE &&
      tokenId !== undefined && (await nft.ownerOf(tokenId)) === mobileUser.address);

  // ------------------------------------ 7. terminal-state rejections (AC-07/08)
  await expectRevert(stake, "M-08a", "replayed settle on the completed session reverts (AC-07)",
    "WrongStatus", () => stake.connect(mobileUser).settle.staticCall(sessionId, att.signature));
  await expectRevert(stake, "M-08b", "forfeit on a completed session reverts (AC-07)",
    "WrongStatus", () => stake.connect(owner).forfeit.staticCall(sessionId));
  await expectRevert(stake, "M-08c", "admitDefeat on a completed session reverts (AC-07)",
    "WrongStatus", () => stake.connect(mobileUser).admitDefeat.staticCall(sessionId));
  await expectRevert(stake, "M-08d", "admin void on a completed session reverts (AC-08)",
    "WrongStatus", () => stake.connect(owner).voidSession.staticCall(sessionId));

  // ------------------------------------------------------------ 8. withdraw --
  console.log("[tap 'withdraw'] -> withdraw tx in the mobile wallet");
  const balBefore = await provider.getBalance(mobileUser.address);
  const wdTx = await stake.connect(mobileUser).withdraw();
  const wdRcpt = await wdTx.wait();
  const wdFee = wdRcpt.gasUsed * wdRcpt.gasPrice;
  const balAfter = await provider.getBalance(mobileUser.address);
  check("M-09", "withdraw returns the full stake to the mobile wallet (minus gas)",
    "+0.05 ETH - withdraw gas, claimable=0",
    `delta=${ethers.formatEther(balAfter - balBefore)} ETH, claimable=${await stake.claimableOf(mobileUser.address)}`,
    balAfter - balBefore === STAKE - wdFee && (await stake.claimableOf(mobileUser.address)) === 0n);
  check("M-10", "contract balance back to zero", "0 ETH",
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
