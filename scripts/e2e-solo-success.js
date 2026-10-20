// E2E single-user success path (DAPP-17, M2 integration phase 1):
//   create session -> one-time challenge bind / ready -> startSession
//   (arming-exemption boundary) -> heartbeats over the full monitored window
//   -> attestation -> settle -> withdraw
// asserting on-chain state and balance changes at every step.
//
// Prerequisites (see docs/test-report-m2.md):
//   1. HARDHAT_MINING_INTERVAL=5000 npx hardhat node
//   2. npx hardhat run scripts/deploy.js --network localhost
//   3. attester service running with CONTRACT_ADDRESS from deployments/localhost.json
// Run:
//   npx hardhat run scripts/e2e-solo-success.js --network localhost
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const ATTESTER_URL = process.env.ATTESTER_URL || "http://localhost:3001";
const STAKE = ethers.parseEther("0.05");
const DURATION_MINUTES = 2;
const HB_CADENCE_MS = 5000;
const PRE_START_SILENCE_MS = 17_000; // arming-phase silence: exempt by rule (AC-27)

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

async function main() {
  const deployment = JSON.parse(
    fs.readFileSync(
      process.env.DEPLOYMENT_JSON || path.join(__dirname, "..", "deployments", "localhost.json"),
      "utf8"
    )
  );
  const [owner, attester, , alice] = await ethers.getSigners();
  void owner;
  const stake = await ethers.getContractAt("StakeBeast", deployment.stakeBeast);
  const nft = await ethers.getContractAt("BeastNFT", deployment.beastNFT);
  const provider = ethers.provider;
  const chainId = Number((await provider.getNetwork()).chainId);
  console.log(`contract=${deployment.stakeBeast} chainId=${chainId} attesterApi=${ATTESTER_URL}`);
  console.log(`alice=${alice.address} attester=${attester.address}`);

  const health = await api("GET", "/health");
  check("E2E-00", "attester service healthy", "200 + signer==on-chain attester",
    `${health.status} signer=${health.body?.signer}`,
    health.status === 200 && health.body?.signer?.toLowerCase() === attester.address.toLowerCase());

  // ---------------------------------------------------------- 1. create ---
  const balAlice0 = await provider.getBalance(alice.address);
  const balContract0 = await provider.getBalance(deployment.stakeBeast);
  const createTx = await stake.connect(alice).createSession(
    0, // Mode.SoloFocus
    ethers.ZeroAddress,
    0, // Payee.Charity
    ethers.ZeroAddress,
    DURATION_MINUTES,
    0,
    0,
    0,
    "",
    { value: STAKE }
  );
  const createRcpt = await createTx.wait();
  const sessionId = (await stake.nextSessionId()) - 1n;
  const createFee = createRcpt.gasUsed * createRcpt.gasPrice;
  let s = await stake.getSession(sessionId);
  check("E2E-01", "createSession returns a Pending SoloFocus session",
    "status=Pending(0), staker=alice, stake=0.05 ETH, duration=2",
    `status=${s.status}, staker=${s.staker}, stake=${ethers.formatEther(s.stake)}, duration=${s.durationMinutes}`,
    s.status === 0n && s.staker === alice.address && s.stake === STAKE && s.durationMinutes === BigInt(DURATION_MINUTES));
  check("E2E-02", "startDeadline anchored at creation + START_WINDOW",
    `createdAt+${deployment.startWindow}`,
    `${Number(s.startDeadline) - Number(s.createdAt)}`,
    Number(s.startDeadline) - Number(s.createdAt) === deployment.startWindow);
  check("E2E-03", "stake escrowed by the contract",
    "+0.05 ETH contract, alice -0.05 ETH - gas",
    `contract +${ethers.formatEther((await provider.getBalance(deployment.stakeBeast)) - balContract0)}, alice -${ethers.formatEther(balAlice0 - (await provider.getBalance(alice.address)) - createFee)}`,
    (await provider.getBalance(deployment.stakeBeast)) - balContract0 === STAKE &&
      balAlice0 - (await provider.getBalance(alice.address)) === STAKE + createFee);

  // ------------------------------------------------------------ 2. bind ---
  const ch = await api("POST", "/v1/bind/challenge", {
    chainId,
    contract: deployment.stakeBeast,
    sessionId: sessionId.toString(),
    address: alice.address,
  });
  check("E2E-04", "bind challenge issued", "200 {nonce,message,expiresAt}",
    `${ch.status} keys=${ch.body ? Object.keys(ch.body).join(",") : "-"}`,
    ch.status === 200 && !!ch.body?.nonce && !!ch.body?.message);
  const bindSig = await alice.signMessage(ch.body.message);
  const bind = await api("POST", "/v1/bind", {
    chainId,
    contract: deployment.stakeBeast,
    sessionId: sessionId.toString(),
    address: alice.address,
    nonce: ch.body.nonce,
    bindSig,
  });
  check("E2E-05", "bind verifies and issues a client token (ready)",
    "200 {clientToken,status:ready,nextHeartbeatSeq:1}",
    `${bind.status} ${JSON.stringify({ status: bind.body?.status, nextHeartbeatSeq: bind.body?.nextHeartbeatSeq })}`,
    bind.status === 200 && !!bind.body?.clientToken && bind.body?.status === "ready" && bind.body?.nextHeartbeatSeq === 1);
  const token = bind.body.clientToken;
  let seq = bind.body.nextHeartbeatSeq;

  // --------------------------------- 3. arming-exemption boundary (AC-27) --
  // Stay silent well beyond the 15 s grace BEFORE the on-chain start, then send
  // one pre-start heartbeat: pre-window silence and pre-window coverage must
  // both be exempt from scoring.
  await sleep(PRE_START_SILENCE_MS);
  const preHb = await api("POST", "/v1/heartbeat", { sessionId: sessionId.toString(), seq: seq++ }, token);
  check("E2E-06", "pre-start heartbeat accepted, no violation after 17 s arming silence",
    "200 {ok:true,violation:false}",
    `${preHb.status} ${JSON.stringify(preHb.body)}`,
    preHb.status === 200 && preHb.body?.ok === true && preHb.body?.violation === false);

  // -------------------------------------------------- 4. startSession/arm --
  const startTx = await stake.connect(alice).startSession(sessionId);
  const startRcpt = await startTx.wait();
  const startFee = startRcpt.gasUsed * startRcpt.gasPrice;
  s = await stake.getSession(sessionId);
  const startBlock = await provider.getBlock(startRcpt.blockNumber);
  check("E2E-07", "startSession activates the session",
    "status=Active(1), startTime=tx block time, endTime=startTime+120, settlementDeadline=endTime+3600",
    `status=${s.status}, startTime=${s.startTime}, endTime=${s.endTime}, settlementDeadline=${s.settlementDeadline}`,
    s.status === 1n &&
      Number(s.startTime) === startBlock.timestamp &&
      Number(s.endTime) === Number(s.startTime) + DURATION_MINUTES * 60 &&
      Number(s.settlementDeadline) === Number(s.endTime) + deployment.graceDuration);
  const arm = await api("POST", "/v1/arm", { sessionId: sessionId.toString(), txHash: startTx.hash }, token);
  check("E2E-08", "arm acknowledges the startSession tx; monitoring begins",
    "200 {ok:true,state:monitoring}",
    `${arm.status} ${JSON.stringify(arm.body)}`,
    arm.status === 200 && arm.body?.ok === true && arm.body?.state === "monitoring");
  const startMs = Number(s.startTime) * 1000;
  const endMs = Number(s.endTime) * 1000;

  // --------------------------------------------- 5. full-window heartbeats --
  let hbCount = 0;
  let violationSeen = false;
  let midChecked = false;
  while (Date.now() < endMs + 2_000) {
    const hb = await api("POST", "/v1/heartbeat", { sessionId: sessionId.toString(), seq: seq++ }, token);
    if (hb.status !== 200 || hb.body?.ok !== true) {
      check("E2E-10", `heartbeat #${hbCount + 1} accepted`, "200 {ok:true}", `${hb.status} ${JSON.stringify(hb.body)}`, false);
      break;
    }
    hbCount++;
    if (hb.body?.violation) violationSeen = true;
    if (!midChecked && Date.now() > startMs + (endMs - startMs) / 2) {
      midChecked = true;
      const st = await api("GET", `/v1/sessions/${sessionId}/status?chainId=${chainId}&contract=${deployment.stakeBeast}`, undefined, token);
      const me = st.body?.participants?.[0];
      check("E2E-09", "mid-session status: monitoring, bound, no violation",
        "state=monitoring, bound=true, violation=null",
        `state=${st.body?.state}, bound=${me?.bound}, violation=${me?.violation}, nextHeartbeatSeq=${st.body?.nextHeartbeatSeq}`,
        st.status === 200 && st.body?.state === "monitoring" && me?.bound === true && me?.violation === null);
    }
    await sleep(HB_CADENCE_MS);
  }
  check("E2E-10", "heartbeats accepted for the whole window (5 s cadence)",
    ">=20 accepted beats over a 2 min window, none flagged",
    `${hbCount} beats, violationSeen=${violationSeen}`,
    hbCount >= 20 && !violationSeen);

  // ------------------------------------------------------- 6. attestation --
  let att = null;
  let pendingCount = 0;
  for (let i = 0; i < 30; i++) {
    const r = await api("GET", `/v1/sessions/${sessionId}/attestation?chainId=${chainId}&contract=${deployment.stakeBeast}`, undefined, token);
    if (r.status === 200) {
      att = r.body;
      break;
    }
    if (r.status === 425) {
      pendingCount++;
      await sleep(2_000);
      continue;
    }
    check("E2E-11", "attestation issued", "200 {typedData,signature}", `${r.status} ${JSON.stringify(r.body)}`, false);
    break;
  }
  check("E2E-11", "attestation issued once the chain passed endTime",
    "200 {typedData,signature} (425 pending retries allowed)",
    att ? `200 after ${pendingCount} pending retries` : "no 200 response",
    !!att?.typedData && !!att?.signature);

  const td = att.typedData;
  check("E2E-12", "typed data mirrors the on-chain session",
    `domain{StakeBeast,1,${chainId},contract}, msg{id,staker,partner=0,startTime,endTime,expiry=settlementDeadline}`,
    JSON.stringify({ domain: td.domain, message: td.message }),
    td.domain.name === "StakeBeast" && td.domain.version === "1" &&
      Number(td.domain.chainId) === chainId &&
      td.domain.verifyingContract.toLowerCase() === deployment.stakeBeast.toLowerCase() &&
      String(td.message.sessionId) === sessionId.toString() &&
      td.message.staker.toLowerCase() === alice.address.toLowerCase() &&
      td.message.partner === ethers.ZeroAddress &&
      Number(td.message.startTime) === Number(s.startTime) &&
      Number(td.message.endTime) === Number(s.endTime) &&
      Number(td.message.expiry) === Number(s.settlementDeadline));
  const recovered = ethers.verifyTypedData(td.domain, td.types, td.message, att.signature);
  check("E2E-13", "signature recovers the on-chain attester",
    attester.address, recovered, recovered.toLowerCase() === attester.address.toLowerCase());

  // ------------------------------------------------------------ 7. settle --
  const balAlice1 = await provider.getBalance(alice.address);
  const settleTx = await stake.connect(alice).settle(sessionId, att.signature);
  const settleRcpt = await settleTx.wait();
  const settleFee = settleRcpt.gasUsed * settleRcpt.gasPrice;
  s = await stake.getSession(sessionId);
  check("E2E-14", "settle completes the session and credits the claimable balance",
    "status=Completed(2), claimable[alice]=0.05 ETH",
    `status=${s.status}, claimable=${ethers.formatEther(await stake.claimableOf(alice.address))}`,
    s.status === 2n && (await stake.claimableOf(alice.address)) === STAKE);
  const completedLog = settleRcpt.logs
    .map((l) => {
      try {
        return stake.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((x) => x && x.name === "SessionCompleted");
  check("E2E-15", "SessionCompleted event names alice and token #1",
    "beneficiaries=[alice], tokenIds=[1]",
    completedLog ? `beneficiaries=${completedLog.args.beneficiaries}, tokenIds=${completedLog.args.tokenIds}` : "event missing",
    !!completedLog && completedLog.args.beneficiaries[0] === alice.address && completedLog.args.tokenIds[0] === 1n);
  const nftOwner = await nft.ownerOf(1);
  const meta = await nft.beastMeta(1);
  const metaStr = `owner=${nftOwner}, kind=${meta.kind}, metricValue=${meta.metricValue}, tier=${meta.tier}, sessionId=${meta.sessionId}`;
  check("E2E-16", "beast NFT minted to alice with focus/sprout metadata",
    "ownerOf(1)=alice, kind=Focus(0), metricValue=2, tier=Sprout(0), sessionId=1",
    metaStr,
    nftOwner === alice.address &&
      meta.kind === 0n &&
      meta.metricValue === BigInt(DURATION_MINUTES) &&
      meta.tier === 0n &&
      meta.sessionId === sessionId);
  check("E2E-17", "attestation re-served idempotently after settle",
    "same signature as before",
    (await api("GET", `/v1/sessions/${sessionId}/attestation?chainId=${chainId}&contract=${deployment.stakeBeast}`, undefined, token)).body?.signature,
    (await api("GET", `/v1/sessions/${sessionId}/attestation?chainId=${chainId}&contract=${deployment.stakeBeast}`, undefined, token)).body?.signature === att.signature);
  void balAlice1;

  // ---------------------------------------------------------- 8. withdraw --
  const balAlice2 = await provider.getBalance(alice.address);
  const wdTx = await stake.connect(alice).withdraw();
  const wdRcpt = await wdTx.wait();
  const wdFee = wdRcpt.gasUsed * wdRcpt.gasPrice;
  const balAlice3 = await provider.getBalance(alice.address);
  check("E2E-18", "withdraw sweeps the claimable balance",
    "claimable=0, alice +0.05 ETH - gas, Withdrawn event",
    `claimable=${await stake.claimableOf(alice.address)}, delta=${ethers.formatEther(balAlice3 - balAlice2 + wdFee)}`,
    (await stake.claimableOf(alice.address)) === 0n && balAlice3 - balAlice2 === STAKE - wdFee);
  check("E2E-19", "contract balance back to zero",
    "0 ETH",
    ethers.formatEther(await provider.getBalance(deployment.stakeBeast)),
    (await provider.getBalance(deployment.stakeBeast)) === 0n);
  const net = balAlice3 - balAlice0;
  const totalGas = createFee + startFee + settleFee + wdFee;
  check("E2E-20", "alice net effect: principal fully refunded, only gas spent",
    "delta = -(create+start+settle+withdraw gas)",
    `net=${ethers.formatEther(net)} ETH, gas=${ethers.formatEther(totalGas)} ETH`,
    net === -totalGas);

  // ------------------------------------------------------------ summary ---
  const failed = results.filter((r) => r.result === "FAIL");
  console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed ====`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
