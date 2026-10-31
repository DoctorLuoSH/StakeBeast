/**
 * UI walkthrough (DAPP-38 evidence): drives the real frontend against a local
 * Hardhat node + attester service with a scripted EIP-1193 wallet shim
 * (window.ethereum backed by Hardhat dev accounts), exercising all four
 * session modes and their main terminal states, with screenshots per step.
 *
 * Flows:
 *   1. SoloFocus   create → start → (attester heartbeats) → settle → withdraw
 *   2. Supervised  create → verifier confirms → completed
 *   3. Duel        create → opponent joins → admit defeat (pays opponent) →
 *                  cross-verify → withdraw
 *   4. CoFocus     create (joint-liability consent) → join → start handshake →
 *                  admit defeat (both stakes to charity)
 *   5. SoloFocus   create, never start → cancel after the start window
 *   6. SoloFocus   create → start, no proof → forfeit after the deadline
 *   7. Owner       void a pending session (full refund)
 *
 * Prerequisites (repo root): `npm install && npx hardhat compile`;
 * `cd attester && npm install && npm run build`; frontend `npm install`
 * (playwright-core is a devDependency; a system Chrome is used).
 *
 * Run from the frontend directory:
 *   node scripts/ui-walkthrough.mjs [--shots-dir <dir>]
 *
 * The script writes a temporary `.env` for the dev server (restored on exit),
 * starts and stops its own node / attester / vite children, and deploys its
 * own contract instance with demo-sized windows (join 90 s, start 90 s,
 * grace 120 s) so no chain time travel is needed.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(FRONTEND_DIR, "..");

const SHOTS_DIR = (() => {
  const i = process.argv.indexOf("--shots-dir");
  return i >= 0 ? path.resolve(process.argv[i + 1]) : path.join(FRONTEND_DIR, "walkthrough-shots");
})();

// Non-default ports keep the walkthrough clear of any developer's own node
// / dev server; override via WALK_*_PORT env vars when needed.
const RPC_PORT = Number(process.env.WALK_RPC_PORT || 8546);
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const ATTESTER_PORT = Number(process.env.WALK_ATTESTER_PORT || 3101);
const ATTESTER_URL = `http://localhost:${ATTESTER_PORT}`;
const VITE_PORT = Number(process.env.WALK_VITE_PORT || 5174);
const APP_URL = `http://localhost:${VITE_PORT}`;

const CHAIN_ID = 31337;
const CHAIN_ID_HEX = "0x7a69";
const JOIN_WINDOW = 90;
const START_WINDOW = 90;
const GRACE_DURATION = 120;
const HB_CADENCE_MS = 5000;

const MNEMONIC = "test test test test test test test test test test test junk";
const walletAt = (i) =>
  ethers.HDNodeWallet.fromPhrase(MNEMONIC, "", `m/44'/60'/0'/0/${i}`);

const children = [];
function run(name, command, args, options = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  child.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`[${name}!] ${d}`));
  children.push(child);
  return child;
}
function cleanupChildren() {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
process.on("SIGINT", () => {
  cleanupChildren();
  process.exit(130);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[walkthrough] ${msg}`);

async function waitHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        http
          .get(url, (res) => {
            res.resume();
            resolve();
          })
          .on("error", reject);
      });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
      await sleep(500);
    }
  }
}

async function waitChain(provider, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await provider.getBlockNumber();
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("timed out waiting for the chain");
      await sleep(500);
    }
  }
}

async function chainNow(provider) {
  return Number((await provider.getBlock("latest")).timestamp);
}
async function waitChainTime(provider, targetSec) {
  for (;;) {
    const now = await chainNow(provider);
    if (now >= targetSec) return;
    await sleep(2000);
  }
}

/* ------------------------------------------------------- wallet shim -- */

const SHIM = `(() => {
  window.ethereum = {
    isMetaMask: true,
    request: ({ method, params }) => window.__ethRpc(method, params ?? []),
    on: () => {},
    removeListener: () => {},
  };
})();`;

const lastTxByAddress = new Map();

function makeRpc(wallet, provider) {
  return async (method, params = []) => {
    if (process.env.VERBOSE) log(`rpc ${wallet.address.slice(0, 8)} ${method}`);
    switch (method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return [wallet.address];
      case "eth_chainId":
        return CHAIN_ID_HEX;
      case "net_version":
        return String(CHAIN_ID);
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain":
        return null;
      case "personal_sign": {
        const [msg] = params;
        const bytes = typeof msg === "string" && msg.startsWith("0x") ? ethers.getBytes(msg) : msg;
        return wallet.signMessage(bytes);
      }
      case "eth_sendTransaction": {
        const [tx] = params;
        const resp = await wallet.sendTransaction({
          to: tx.to,
          data: tx.data ?? "0x",
          value: tx.value ? BigInt(tx.value) : 0n,
        });
        lastTxByAddress.set(wallet.address.toLowerCase(), resp.hash);
        return resp.hash;
      }
      default:
        return provider.send(method, params ?? []);
    }
  };
}

async function userPage(browser, wallet, provider) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const rpc = makeRpc(wallet, provider);
  await context.exposeBinding("__ethRpc", (_source, method, params) => rpc(method, params));
  await context.addInitScript(SHIM);
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);
  return page;
}

/* ------------------------------------------------------ attester api -- */

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

/** Bind + arm + heartbeat until the session window ends (scripted proof side). */
async function pumpHeartbeats({ sessionId, wallet, startTxHash, contract }) {
  const sessionIdStr = sessionId.toString();
  const base = { chainId: CHAIN_ID, contract, sessionId: sessionIdStr, address: wallet.address };
  const ch = await api("POST", "/v1/bind/challenge", base);
  if (ch.status !== 200) throw new Error(`bind challenge failed: ${JSON.stringify(ch.body)}`);
  const bindSig = await wallet.signMessage(ch.body.message);
  const bind = await api("POST", "/v1/bind", { ...base, nonce: ch.body.nonce, bindSig });
  if (bind.status !== 200) throw new Error(`bind failed: ${JSON.stringify(bind.body)}`);
  const token = bind.body.clientToken;
  let seq = bind.body.nextHeartbeatSeq;

  const arm = await api("POST", "/v1/arm", { sessionId: sessionIdStr, txHash: startTxHash }, token);
  if (arm.status !== 200) throw new Error(`arm failed: ${JSON.stringify(arm.body)}`);

  const s = await pumpHeartbeats.stake.getSession(sessionId);
  const endMs = Number(s.endTime) * 1000;
  while (Date.now() < endMs + 2000) {
    const hb = await api("POST", "/v1/heartbeat", { sessionId: sessionIdStr, seq: seq++ }, token);
    if (hb.status !== 200 || hb.body?.ok !== true) {
      log(`heartbeat rejected: ${hb.status} ${JSON.stringify(hb.body)}`);
    }
    await sleep(HB_CADENCE_MS);
  }
  log(`heartbeats done for session ${sessionIdStr}`);
}

/* ------------------------------------------------------------ helpers -- */

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: true });
  log(`screenshot ${name}`);
}

async function gotoApp(page, route) {
  await page.goto(`${APP_URL}${route}`, { waitUntil: "networkidle" });
}

/** Create a session through the UI; returns the new session id. */
async function uiCreateSession(page, { mode, stake, duration, period, checkIns, target, counterparty, duelTask, payee, cofocus }) {
  await gotoApp(page, "/create");
  await page.getByRole("tab", { name: new RegExp(mode) }).click();
  await page.getByLabel(/Stake amount/).fill(stake);
  if (duelTask === "habit") await page.getByLabel(/Habit \(days/).check();
  if (duration) await page.getByLabel(/Focus duration/).fill(duration);
  if (period) await page.getByLabel(/Period \(days\)/).fill(period);
  if (checkIns) await page.getByLabel(/Check-ins per day/).fill(checkIns);
  if (target) await page.getByLabel(/Target check-ins total/).fill(target);
  if (counterparty) {
    const label = mode.startsWith("Supervised") ? /Supervisor address/ : /Opponent address/;
    await page.getByLabel(label).fill(counterparty);
  }
  if (payee) await page.getByLabel(/Forfeit destination/).selectOption(payee);
  await page.getByRole("button", { name: /Stake & Create/ }).click();
  if (cofocus) {
    await shot(page, "14-cofocus-consent-modal");
    await page.getByRole("button", { name: /I understand/ }).click();
  }
  await page.waitForURL(/\/focus\/\d+$/, { timeout: 60_000 });
  const id = page.url().match(/\/focus\/(\d+)/)[1];
  log(`session ${id} created (${mode})`);
  return BigInt(id);
}

async function clickAndConfirm(page, name) {
  await page.getByRole("button", { name }).click();
  const confirmed = page.getByText(/confirmed\./).first();
  const alertBox = page.locator(".tx-banner--error, [role='alert']").first();
  const winner = await Promise.race([
    confirmed.waitFor({ timeout: 90_000 }).then(() => "confirmed"),
    alertBox.waitFor({ timeout: 90_000 }).then(() => "alert"),
  ]).catch(async () => {
    await shot(page, `failure-${Date.now()}`);
    throw new Error("clickAndConfirm timed out with no confirmation and no error banner");
  });
  if (winner === "alert") {
    const text = await alertBox.innerText();
    await shot(page, `failure-${Date.now()}`);
    throw new Error(`action "${name}" failed in the UI: ${text}`);
  }
}

/* -------------------------------------------------------------- main --- */

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  // 0. environment -------------------------------------------------------
  const artifactsOk = ["StakeBeast", "BeastNFT"].every((n) =>
    fs.existsSync(path.join(REPO_ROOT, "artifacts", "contracts", `${n}.sol`, `${n}.json`)),
  );
  if (!artifactsOk) throw new Error("artifacts missing — run `npx hardhat compile` at repo root");

  log("starting hardhat node (interval mining 5 s)…");
  run(
    "hardhat",
    process.execPath,
    [path.join(REPO_ROOT, "node_modules", "hardhat", "internal", "cli", "cli.js"), "node", "--port", String(RPC_PORT)],
    { cwd: REPO_ROOT, env: { ...process.env, HARDHAT_MINING_INTERVAL: "5000" } },
  );
  // cacheTimeout: -1 — interval mining means several txs can land in one
  // block window; ethers' default per-block cache would serve stale pending
  // nonces ("Nonce too low") for back-to-back deploys and UI actions.
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  await waitChain(provider);

  const owner = walletAt(0).connect(provider);
  const attester = walletAt(1).connect(provider);
  const charity = walletAt(2).connect(provider);
  const alice = walletAt(3).connect(provider);
  const bob = walletAt(5).connect(provider);
  const vera = walletAt(6).connect(provider);
  const eve = walletAt(8).connect(provider);

  log("deploying contracts (demo windows: join 90 s / start 90 s / grace 120 s)…");
  const nftArtifact = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "artifacts", "contracts", "BeastNFT.sol", "BeastNFT.json"), "utf8"),
  );
  const sbArtifact = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "artifacts", "contracts", "StakeBeast.sol", "StakeBeast.json")),
  );
  const nft = await (
    await new ethers.ContractFactory(nftArtifact.abi, nftArtifact.bytecode, owner).deploy(
      owner.address,
      owner.address,
    )
  ).waitForDeployment();
  const stake = await (
    await new ethers.ContractFactory(sbArtifact.abi, sbArtifact.bytecode, owner).deploy(
      owner.address,
      attester.address,
      charity.address,
      await nft.getAddress(),
      JOIN_WINDOW,
      START_WINDOW,
      GRACE_DURATION,
    )
  ).waitForDeployment();
  await (await nft.setMinter(await stake.getAddress())).wait();
  const stakeAddress = await stake.getAddress();
  pumpHeartbeats.stake = stake;
  log(`StakeBeast at ${stakeAddress}`);

  log("starting attester…");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-walkthrough-attester-"));
  run("attester", process.execPath, [path.join(REPO_ROOT, "attester", "dist", "src", "index.js")], {
    cwd: path.join(REPO_ROOT, "attester"),
    env: {
      ...process.env,
      RPC_URL,
      CONTRACT_ADDRESS: stakeAddress,
      ATTESTER_PRIVATE_KEY: attester.privateKey,
      PORT: String(ATTESTER_PORT),
      DATA_DIR: dataDir,
      CHAIN_ID: String(CHAIN_ID),
    },
  });
  await waitHttp(`${ATTESTER_URL}/health`);

  log("writing frontend .env and starting vite…");
  const envPath = path.join(FRONTEND_DIR, ".env");
  const envBackup = fs.existsSync(envPath) ? fs.readFileSync(envPath) : null;
  fs.writeFileSync(
    envPath,
    [
      `VITE_CONTRACT_ADDRESS=${stakeAddress}`,
      `VITE_NFT_CONTRACT_ADDRESS=${await nft.getAddress()}`,
      `VITE_CHAIN_ID=${CHAIN_ID}`,
      `VITE_PROOF_SERVICE_URL=${ATTESTER_URL}`,
      "",
    ].join("\n"),
  );
  run(
    "vite",
    process.execPath,
    [path.join(FRONTEND_DIR, "node_modules", "vite", "bin", "vite.js"), "--port", String(VITE_PORT), "--strictPort"],
    { cwd: FRONTEND_DIR },
  );
  await waitHttp(`${APP_URL}/`);

  log("launching browser…");
  const browser = await chromium.launch({ channel: "chrome", headless: true });

  try {
    const alicePage = await userPage(browser, alice, provider);
    const bobPage = await userPage(browser, bob, provider);

    // ------------------------------------------- 1. SoloFocus success --
    log("flow 1: solo focus success");
    const soloId = await uiCreateSession(alicePage, {
      mode: "Solo Focus",
      stake: "0.05",
      duration: "2",
    });
    await shot(alicePage, "01-solo-pending-start");
    await clickAndConfirm(alicePage, /Start session/);
    const startTxHash = lastTxByAddress.get(alice.address.toLowerCase());
    pumpHeartbeats({ sessionId: soloId, wallet: alice, startTxHash, contract: stakeAddress }).catch(
      (e) => log(`heartbeat pumper failed: ${e.message}`),
    );
    await alicePage.waitForTimeout(3000);
    await shot(alicePage, "02-solo-active-countdown");

    const soloSession = await stake.getSession(soloId);
    await waitChainTime(provider, Number(soloSession.endTime) + 2);
    await alicePage.getByRole("link", { name: /Go to settlement/ }).click();
    await alicePage.waitForURL(new RegExp(`/settlement/${soloId}`));
    await shot(alicePage, "03-solo-settlement-ready");
    await clickAndConfirm(alicePage, /Fetch attestation & settle/);
    await alicePage.getByText(/Beast minted, stake returned/).waitFor({ timeout: 60_000 });
    await shot(alicePage, "04-solo-settled-beast-minted");
    await clickAndConfirm(alicePage, "Withdraw");
    await shot(alicePage, "05-solo-withdrawn");

    // ------------------------------------------- 2. Supervised verify --
    log("flow 2: supervised habit, verifier confirms");
    const supId = await uiCreateSession(alicePage, {
      mode: "Supervised Habit",
      stake: "0.02",
      period: "1",
      checkIns: "1",
      target: "1",
      counterparty: vera.address,
    });
    await shot(alicePage, "06-supervised-active");
    const veraPage = await userPage(browser, vera, provider);
    await gotoApp(veraPage, `/focus/${supId}`);
    await veraPage.getByRole("button", { name: /Verify completion/ }).waitFor();
    await shot(veraPage, "07-supervised-verifier-view");
    await clickAndConfirm(veraPage, /Verify completion/);
    await gotoApp(veraPage, `/settlement/${supId}`);
    await veraPage.getByText(/Beast minted, stake returned/).waitFor({ timeout: 60_000 });
    await shot(veraPage, "08-supervised-completed");
    await veraPage.context().close();

    // --------------------------------- 3. Duel join / defeat / verify --
    log("flow 3: mutual bet — join, admit defeat, cross-verify");
    const duelId = await uiCreateSession(alicePage, {
      mode: "Mutual Bet",
      stake: "0.05",
      duration: "2",
      counterparty: bob.address,
    });
    await shot(alicePage, "09-duel-waiting-opponent");

    await gotoApp(bobPage, `/focus/${duelId}`);
    await bobPage.getByLabel(/Your forfeit route/).selectOption("1"); // verifier = opponent
    await shot(bobPage, "10-duel-join-form");
    await clickAndConfirm(bobPage, /Join & stake/);
    await bobPage.getByRole("link", { name: /Open your position/ }).click();
    await bobPage.waitForURL(/\/focus\/\d+$/, { timeout: 60_000 });
    const mirrorId = bobPage.url().match(/\/focus\/(\d+)/)[1];
    log(`bob mirror position ${mirrorId}`);
    await shot(bobPage, "11-duel-bob-position");
    await bobPage.getByRole("button", { name: "Admit defeat" }).click();
    await clickAndConfirm(bobPage, /Yes, admit defeat/);
    await bobPage.getByText(/Session forfeited/).waitFor({ timeout: 60_000 });
    await shot(bobPage, "12-duel-admit-defeat");

    await gotoApp(bobPage, `/focus/${duelId}`);
    await clickAndConfirm(bobPage, /Verify completion/);
    await gotoApp(alicePage, `/settlement/${duelId}`);
    await alicePage.getByText(/Beast minted, stake returned/).waitFor({ timeout: 60_000 });
    await shot(alicePage, "13-duel-alice-completed");
    await gotoApp(alicePage, "/settlement");
    await alicePage.getByText(/0\.1/).waitFor({ timeout: 60_000 });
    await clickAndConfirm(alicePage, "Withdraw");
    await shot(alicePage, "14-duel-withdraw-stake-plus-forfeit");

    // ----------------------------- 4. CoFocus handshake + joint forfeit --
    log("flow 4: co-focus duo — consent, join, handshake, joint forfeit");
    const coId = await uiCreateSession(alicePage, {
      mode: "Co-Focus Duo",
      stake: "0.02",
      duration: "2",
      cofocus: true,
    });
    await shot(alicePage, "15-cofocus-waiting-partner");

    await gotoApp(bobPage, `/focus/${coId}`);
    await clickAndConfirm(bobPage, /Join & stake/);
    await shot(bobPage, "16-cofocus-joined-handshake");
    await clickAndConfirm(bobPage, /Confirm start/);
    await alicePage.reload();
    await clickAndConfirm(alicePage, /Confirm start/);
    await alicePage.getByText(/status/i).waitFor();
    await alicePage.reload();
    await alicePage.getByRole("button", { name: "Admit defeat" }).waitFor({ timeout: 60_000 });
    await shot(alicePage, "17-cofocus-active");
    await alicePage.getByRole("button", { name: "Admit defeat" }).click();
    await clickAndConfirm(alicePage, /Yes, admit defeat/);
    await gotoApp(alicePage, `/settlement/${coId}`);
    await alicePage.getByText(/joint liability/).waitFor({ timeout: 60_000 });
    await shot(alicePage, "18-cofocus-joint-forfeit");
    await bobPage.context().close();

    // --------------------------------- 5. cancel after the start window --
    log("flow 5: solo focus cancelled after the start window");
    const cancelId = await uiCreateSession(alicePage, {
      mode: "Solo Focus",
      stake: "0.01",
      duration: "1",
    });
    const cancelSession = await stake.getSession(cancelId);
    await waitChainTime(provider, Number(cancelSession.startDeadline) + 8);
    await alicePage.reload();
    await alicePage.getByRole("button", { name: /Cancel session & refund/ }).waitFor({ timeout: 60_000 });
    await shot(alicePage, "19-cancel-available");
    await clickAndConfirm(alicePage, /Cancel session & refund/);
    await alicePage.getByText(/Session cancelled/).waitFor({ timeout: 60_000 });
    await shot(alicePage, "20-cancelled");

    // --------------------- 6. forfeit after the settlement deadline -----
    log("flow 6: solo focus forfeited to charity after the deadline");
    const forfeitId = await uiCreateSession(alicePage, {
      mode: "Solo Focus",
      stake: "0.01",
      duration: "1",
    });
    await clickAndConfirm(alicePage, /Start session/);
    const forfeitSession = await stake.getSession(forfeitId);
    const evePage = await userPage(browser, eve, provider);
    await gotoApp(evePage, `/settlement/${forfeitId}`);
    await waitChainTime(provider, Number(forfeitSession.settlementDeadline) + 8);
    await evePage.reload();
    await evePage.getByRole("button", { name: /Forfeit to charity/ }).waitFor({ timeout: 60_000 });
    await shot(evePage, "21-forfeit-available");
    await clickAndConfirm(evePage, /Forfeit to charity/);
    await evePage.getByText(/settlement deadline passed/).waitFor({ timeout: 60_000 });
    await shot(evePage, "22-forfeited-timeout");
    await evePage.context().close();

    // ----------------------------------------- 7. owner voids a session --
    log("flow 7: admin void");
    const voidId = await uiCreateSession(alicePage, {
      mode: "Solo Focus",
      stake: "0.01",
      duration: "1",
    });
    const ownerPage = await userPage(browser, owner, provider);
    await gotoApp(ownerPage, `/focus/${voidId}`);
    await ownerPage.getByRole("button", { name: "Void session" }).click();
    await clickAndConfirm(ownerPage, /Confirm void/);
    await ownerPage.getByText(/Session voided/).waitFor({ timeout: 60_000 });
    await shot(ownerPage, "23-voided");
    await ownerPage.context().close();

    log("all flows completed");
  } finally {
    await browser.close();
    if (envBackup) fs.writeFileSync(envPath, envBackup);
    else fs.rmSync(envPath, { force: true });
    cleanupChildren();
  }
}

main().catch((error) => {
  console.error(error);
  cleanupChildren();
  process.exitCode = 1;
});
