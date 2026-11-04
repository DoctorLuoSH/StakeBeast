/**
 * UI walkthrough (DAPP-47 evidence): drives the real frontend against a
 * local Hardhat node + attester + SOCIAL BACKEND with a scripted EIP-1193
 * wallet shim (window.ethereum backed by Hardhat dev accounts), covering the
 * social layer and the personal homepage:
 *
 *   1. Social sign-in (challenge → personal_sign → JWT) + profile edit
 *      (nickname + avatar upload)
 *   2. Supervised Habit full evidence loop: create → staker photo check-in
 *      (original bytes → SHA-256 → on-chain checkIn anchor → backend
 *      confirmed) → verifier review list (photo vs. hash verdict
 *      "anchored & matching") → on-chain verify → Completed
 *   3. Mutual Bet evidence: join → opponent check-in on the mirror position
 *      → creator cross-confirms from the review page
 *   4. Co-Focus Duo dual side-by-side view with live partner status dots
 *   5. Personal homepage: real record stats + My Zoo real mints
 *
 * Prerequisites (repo root): `npm install && npx hardhat compile`;
 * `npm --prefix attester install && npm --prefix attester run build`;
 * `npm --prefix backend install && npm --prefix backend run build`;
 * frontend `npm install` (playwright-core is a devDependency; a system
 * Chrome is used).
 *
 * Run from the frontend directory:
 *   node scripts/ui-social-walkthrough.mjs [--shots-dir <dir>]
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
  return i >= 0 ? path.resolve(process.argv[i + 1]) : path.join(FRONTEND_DIR, "walkthrough-social-shots");
})();

const RPC_PORT = Number(process.env.WALK_RPC_PORT || 8547);
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const ATTESTER_PORT = Number(process.env.WALK_ATTESTER_PORT || 3102);
const ATTESTER_URL = `http://localhost:${ATTESTER_PORT}`;
const BACKEND_PORT = Number(process.env.WALK_BACKEND_PORT || 4102);
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
const VITE_PORT = Number(process.env.WALK_VITE_PORT || 5184);
const APP_URL = `http://localhost:${VITE_PORT}`;

const CHAIN_ID = 31337;
const CHAIN_ID_HEX = "0x7a69";
const JOIN_WINDOW = 90;
const START_WINDOW = 90;
const GRACE_DURATION = 120;

const MNEMONIC = "test test test test test test test test test test test junk";
const walletAt = (i) =>
  ethers.HDNodeWallet.fromPhrase(MNEMONIC, "", `m/44'/60'/0'/0/${i}`);

/** 1x1 solid-red PNG — a real image so the backend thumbnail pipeline runs. */
const PHOTO_RED = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** 1x1 solid-blue PNG (different bytes → different evidence hash). */
const PHOTO_BLUE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

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
const log = (msg) => console.log(`[social-walkthrough] ${msg}`);

async function waitHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        http.get(url, (res) => {
          res.resume();
          resolve();
        }).on("error", reject);
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

/* ------------------------------------------------------- wallet shim -- */

const SHIM = `(() => {
  window.ethereum = {
    isMetaMask: true,
    request: ({ method, params }) => window.__ethRpc(method, params ?? []),
    on: () => {},
    removeListener: () => {},
  };
})();`;

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
  page.on("pageerror", (err) => log(`PAGEERROR: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") log(`CONSOLE: ${msg.text().slice(0, 300)}`);
  });
  return page;
}

/* ------------------------------------------------------------ helpers -- */

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: true });
  log(`screenshot ${name}`);
}

async function gotoApp(page, route) {
  await page.goto(`${APP_URL}${route}`, { waitUntil: "networkidle" });
}

/** Sign the page's wallet into the social backend via the profile page. */
async function uiSignIn(page, who) {
  await gotoApp(page, "/profile");
  const signInBtn = page.getByRole("button", { name: /Sign in with wallet/ });
  const editorBtn = page.getByRole("button", { name: /Edit nickname/ });
  // The wallet connects asynchronously (silent restore) — wait for whichever
  // state arrives: a stored session (editor directly) or the sign-in CTA.
  const which = await Promise.race([
    signInBtn.waitFor({ timeout: 60_000 }).then(() => "signin"),
    editorBtn.waitFor({ timeout: 60_000 }).then(() => "editor"),
  ]).catch(async (err) => {
    log(`uiSignIn stuck — page text: ${(await page.locator("body").innerText()).slice(0, 600)}`);
    throw err;
  });
  if (which === "signin") {
    await signInBtn.click();
    await editorBtn.waitFor({ timeout: 60_000 });
  }
  log(`${who} signed in`);
}

/** Create a session through the UI; returns the new session id. */
async function uiCreateSession(page, { mode, stake, duration, period, checkIns, target, counterparty, cofocus }) {
  await gotoApp(page, "/create");
  await page.getByRole("tab", { name: new RegExp(mode) }).click();
  await page.getByLabel(/Stake amount/).fill(stake);
  if (duration) await page.getByLabel(/Focus duration/).fill(duration);
  if (period) await page.getByLabel(/Period \(days\)/).fill(period);
  if (checkIns) await page.getByLabel(/Check-ins per day/).fill(checkIns);
  if (target) await page.getByLabel(/Target check-ins total/).fill(target);
  if (counterparty) {
    const label = mode.startsWith("Supervised") ? /Supervisor address/ : /Opponent address/;
    await page.getByLabel(label).fill(counterparty);
  }
  await page.getByRole("button", { name: /Stake & Create/ }).click();
  if (cofocus) {
    // Creator-side joint-liability consent precedes the create tx.
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

/** Upload a photo check-in on the open focus page; waits for the anchor. */
async function uiCheckIn(page, photo, photoName) {
  const input = page.locator(".checkins__upload input[type=file]");
  await input.setInputFiles({ name: photoName, mimeType: "image/png", buffer: photo });
  await page.getByRole("button", { name: /Upload & anchor on-chain/ }).click();
  await page.getByText("anchored ✓").waitFor({ timeout: 90_000 });
  log("check-in uploaded and anchored");
}

/** Open the review page, expand the session's evidence, expect the verdict. */
async function uiReviewVerify(page, sessionId, shotName) {
  await gotoApp(page, "/review");
  const heading = page.getByRole("heading", { name: new RegExp(`Session #${sessionId} —`) });
  // The review list rides the backend mirror (15 s index throttle) — reload
  // until the session shows up.
  for (let i = 0; i < 10; i++) {
    if (await heading.isVisible().catch(() => false)) break;
    await sleep(6000);
    await page.reload({ waitUntil: "networkidle" });
  }
  await heading.waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: /Evidence \(/ }).click();
  await page.getByText(/Anchored & matching/).waitFor({ timeout: 60_000 });
  await shot(page, shotName);
  await clickAndConfirm(page, /Confirm completion on-chain/);
}

/* -------------------------------------------------------------- main --- */

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  const artifactsOk = ["StakeBeast", "BeastNFT"].every((n) =>
    fs.existsSync(path.join(REPO_ROOT, "artifacts", "contracts", `${n}.sol`, `${n}.json`)),
  );
  if (!artifactsOk) throw new Error("artifacts missing — run `npx hardhat compile` at repo root");
  for (const dir of ["attester", "backend"]) {
    if (!fs.existsSync(path.join(REPO_ROOT, dir, "dist", "src", "index.js"))) {
      throw new Error(`${dir} not built — run npm --prefix ${dir} run build`);
    }
  }

  log("starting hardhat node (interval mining 5 s)…");
  run(
    "hardhat",
    process.execPath,
    [path.join(REPO_ROOT, "node_modules", "hardhat", "internal", "cli", "cli.js"), "node", "--port", String(RPC_PORT)],
    { cwd: REPO_ROOT, env: { ...process.env, HARDHAT_MINING_INTERVAL: "5000" } },
  );
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

  log("deploying contracts (demo windows: join 90 s / start 90 s / grace 120 s)…");
  const nftArtifact = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "artifacts", "contracts", "BeastNFT.sol", "BeastNFT.json"), "utf8"),
  );
  const sbArtifact = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "artifacts", "contracts", "StakeBeast.sol", "StakeBeast.json"), "utf8"),
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
  log(`StakeBeast at ${stakeAddress}`);

  log("starting attester…");
  const attesterData = fs.mkdtempSync(path.join(os.tmpdir(), "sb-social-attester-"));
  run("attester", process.execPath, [path.join(REPO_ROOT, "attester", "dist", "src", "index.js")], {
    cwd: path.join(REPO_ROOT, "attester"),
    env: {
      ...process.env,
      RPC_URL,
      CONTRACT_ADDRESS: stakeAddress,
      ATTESTER_PRIVATE_KEY: attester.privateKey,
      PORT: String(ATTESTER_PORT),
      DATA_DIR: attesterData,
      CHAIN_ID: String(CHAIN_ID),
    },
  });
  await waitHttp(`${ATTESTER_URL}/health`);

  log("starting social backend…");
  const backendData = fs.mkdtempSync(path.join(os.tmpdir(), "sb-social-backend-"));
  run("backend", process.execPath, [path.join(REPO_ROOT, "backend", "dist", "src", "index.js")], {
    cwd: path.join(REPO_ROOT, "backend"),
    env: {
      ...process.env,
      RPC_URL,
      CONTRACT_ADDRESS: stakeAddress,
      PORT: String(BACKEND_PORT),
      DATA_DIR: backendData,
      CHAIN_ID: String(CHAIN_ID),
      JWT_SECRET: "walkthrough-dev-secret",
      FRONTEND_ORIGIN: APP_URL,
      INDEXER_START_BLOCK: "0",
    },
  });
  await waitHttp(`${BACKEND_URL}/api/health`);

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
      `VITE_API_BASE_URL=${BACKEND_URL}/api`,
      "",
    ].join("\n"),
  );
  const vite = run(
    "vite",
    process.execPath,
    [path.join(FRONTEND_DIR, "node_modules", "vite", "bin", "vite.js"), "--port", String(VITE_PORT), "--strictPort"],
    { cwd: FRONTEND_DIR },
  );
  await waitHttp(`${APP_URL}/`);
  if (vite.exitCode !== null) {
    throw new Error(`vite exited (${vite.exitCode}) — port ${VITE_PORT} likely already in use`);
  }

  log("launching browser…");
  const browser = await chromium.launch({ channel: "chrome", headless: true });

  try {
    const alicePage = await userPage(browser, alice, provider);
    const bobPage = await userPage(browser, bob, provider);
    const veraPage = await userPage(browser, vera, provider);

    // --------------------------------- 1. sign-in + profile edit --------
    log("flow 1: social sign-in + profile edit");
    await uiSignIn(alicePage, "alice");
    await shot(alicePage, "01-signed-in-profile");
    await alicePage.getByRole("button", { name: /Edit nickname/ }).click();
    await alicePage.getByLabel(/Nickname/).fill("alice-focusses");
    await alicePage.getByRole("button", { name: "Save" }).click();
    await alicePage.getByRole("heading", { name: /alice-focusses/ }).waitFor({ timeout: 30_000 });
    await alicePage
      .locator('input[type=file][accept="image/png,image/jpeg,image/webp"]')
      .setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: PHOTO_RED });
    await alicePage.waitForTimeout(1500);
    await shot(alicePage, "02-profile-edited");

    // ---------------------- 2. supervised evidence loop -----------------
    log("flow 2: supervised habit — check-in, review, verify");
    const supId = await uiCreateSession(alicePage, {
      mode: "Supervised Habit",
      stake: "0.02",
      period: "1",
      checkIns: "1",
      target: "1",
      counterparty: vera.address,
    });
    await shot(alicePage, "03-supervised-active-checkin-panel");
    await uiCheckIn(alicePage, PHOTO_RED, "day-1.png");
    await shot(alicePage, "04-checkin-anchored");

    await uiSignIn(veraPage, "vera");
    await uiReviewVerify(veraPage, supId, "05-review-anchored-matching");
    await shot(veraPage, "06-review-verify-confirmed");

    // Alice's homepage: real record + freshly minted habit beast.
    await gotoApp(alicePage, "/profile");
    await alicePage.getByText("Sessions succeeded").waitFor({ timeout: 60_000 });
    await alicePage.locator(".beast-card__metric", { hasText: "1-day habit" }).waitFor({ timeout: 60_000 });
    await shot(alicePage, "07-profile-stats-and-zoo");

    // ---------------------- 3. duel evidence + cross-confirm ------------
    log("flow 3: mutual bet — join, opponent check-in, creator verifies");
    const duelId = await uiCreateSession(alicePage, {
      mode: "Mutual Bet",
      stake: "0.05",
      duration: "2",
      counterparty: bob.address,
    });
    await uiSignIn(bobPage, "bob");
    await gotoApp(bobPage, `/focus/${duelId}`);
    await bobPage.getByLabel(/Your forfeit route/).selectOption("1");
    await clickAndConfirm(bobPage, /Join & stake/);
    await bobPage.getByRole("link", { name: /Open your position/ }).click();
    await bobPage.waitForURL(/\/focus\/\d+$/, { timeout: 60_000 });
    const mirrorId = bobPage.url().match(/\/focus\/(\d+)/)[1];
    log(`bob mirror position ${mirrorId}`);
    await uiCheckIn(bobPage, PHOTO_BLUE, "proof.png");
    await shot(bobPage, "08-duel-opponent-checkin");

    await uiReviewVerify(alicePage, mirrorId, "09-duel-review-matching");
    await shot(alicePage, "10-duel-verify-confirmed");

    // Bob's homepage: the mirror position completed, a sprout focus beast.
    await gotoApp(bobPage, "/profile");
    await bobPage.getByText("Sessions succeeded").waitFor({ timeout: 60_000 });
    await bobPage.locator(".beast-card__metric", { hasText: "2 min focus" }).waitFor({ timeout: 60_000 });
    await shot(bobPage, "11-duel-bob-profile");

    // ---------------------- 4. co-focus dual view -----------------------
    log("flow 4: co-focus duo — dual side-by-side view");
    const coId = await uiCreateSession(alicePage, {
      mode: "Co-Focus Duo",
      stake: "0.02",
      duration: "2",
      cofocus: true,
    });
    await gotoApp(bobPage, `/focus/${coId}`);
    await bobPage.getByRole("button", { name: /Join & stake/ }).click();
    await bobPage.getByText(/Joint liability — please confirm/).waitFor({ timeout: 60_000 });
    await clickAndConfirm(bobPage, /I understand/);
    await clickAndConfirm(bobPage, /Confirm start/);
    await alicePage.reload();
    await clickAndConfirm(alicePage, /Confirm start/);
    // Reload both pages so the Active phase renders from a fresh chain read
    // (the second StartConfirmed event does not always reach the open page).
    // An already-Active session auto-binds the tracker on mount (one silent
    // shim signature), so both seats start heartbeating without clicks.
    await alicePage.reload({ waitUntil: "networkidle" });
    await bobPage.reload({ waitUntil: "networkidle" });
    await alicePage.getByText(/Monitoring — heartbeat|Monitoring starts|Arming/).waitFor({ timeout: 60_000 });
    await bobPage.getByText(/Monitoring — heartbeat|Monitoring starts|Arming/).waitFor({ timeout: 60_000 });
    // Wait for both partner dots to read "tracking" (5 s heartbeats, 10 s
    // status poll), then capture the dual side-by-side view.
    await alicePage.waitForTimeout(15_000);
    await alicePage.reload({ waitUntil: "networkidle" });
    await alicePage.getByText(/Monitoring — heartbeat|Monitoring starts|Arming/).waitFor({ timeout: 60_000 });
    await alicePage.locator(".focus__duo-dot--tracking").nth(1).waitFor({ timeout: 60_000 });
    await shot(alicePage, "12-cofocus-duo-view");

    log("all social flows completed");
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
