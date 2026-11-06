// Verifies a recorded deployment (deployments/<network>.json) against the
// contracts in this repo:
//   1. on-chain runtime bytecode equals the locally compiled artifact
//      (immutable slots of StakeBeast are masked before comparing),
//   2. constructor args decoded from the recorded creation transactions match
//      the recorded role addresses / window parameters,
//   3. wiring reads (minter, attester, charity, windows, owner) are consistent,
//   4. smoke scan: SessionCreated events since the deploy block.
//
// Usage (reads the RPC from hardhat network config, i.e. RPC_URL in .env):
//   npx hardhat run scripts/verify-deployment.js --network sepolia
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const art = (n) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, `../artifacts/contracts/${n}.sol/${n}.json`), "utf8"));

// immutableReferences from the build-info compiler output (StakeBeast embeds
// charity / beastNFT / window constants into its runtime bytecode).
function immutableRefs(name) {
  const dir = path.join(__dirname, "../artifacts/build-info");
  for (const f of fs.readdirSync(dir)) {
    const bi = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const c = bi.output?.contracts?.[`contracts/${name}.sol`]?.[name];
    if (c) return c.evm.deployedBytecode.immutableReferences || {};
  }
  throw new Error(`build-info not found for ${name} — run npx hardhat compile first`);
}

async function main() {
  const record = JSON.parse(
    fs.readFileSync(path.join(__dirname, `../deployments/${network.name}.json`), "utf8")
  );
  const provider = ethers.provider;
  let failures = 0;
  const check = (label, ok, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  };

  for (const name of ["BeastNFT", "StakeBeast"]) {
    const entry = record.contracts[name];
    const chain = Buffer.from((await provider.getCode(entry.address)).slice(2), "hex");
    const local = Buffer.from(art(name).deployedBytecode.slice(2), "hex");
    const mask = [];
    for (const list of Object.values(immutableRefs(name))) for (const r of list) mask.push([r.start, r.length]);
    let outsideImmutable = chain.length === local.length ? 0 : -1;
    if (outsideImmutable === 0) {
      for (let i = 0; i < chain.length; i++) {
        if (chain[i] === local[i]) continue;
        if (!mask.some(([s, l]) => i >= s && i < s + l)) outsideImmutable++;
      }
    }
    check(`${name} bytecode matches repo build`, outsideImmutable === 0,
      outsideImmutable === 0 ? "immutable slots masked" : `length/code mismatch (${outsideImmutable})`);

    const tx = await provider.getTransaction(entry.creationTxHash);
    const argsRaw = "0x" + tx.data.slice(2).slice(art(name).bytecode.length - 2);
    const iface = new ethers.Interface(art(name).abi);
    const args = ethers.AbiCoder.defaultAbiCoder().decode(iface.deploy.inputs, argsRaw);
    if (name === "BeastNFT") {
      check("BeastNFT ctor initialOwner == record.owner", args[0] === record.owner, args[0]);
    } else {
      check("StakeBeast ctor attester == record.attester", args[1] === record.attester, args[1]);
      check("StakeBeast ctor charity == record.charity", args[2] === record.charity, args[2]);
      check("StakeBeast ctor beastNFT == record.beastNFT", args[3] === record.beastNFT, args[3]);
      check("StakeBeast ctor windows == 3600/3600/3600",
        args[4] === 3600n && args[5] === 3600n && args[6] === 3600n,
        `${args[4]}/${args[5]}/${args[6]}`);
    }
  }

  const stake = new ethers.Contract(record.stakeBeast, art("StakeBeast").abi, provider);
  const nft = new ethers.Contract(record.beastNFT, art("BeastNFT").abi, provider);
  check("BeastNFT.minter == StakeBeast", (await nft.minter()) === record.stakeBeast);
  check("StakeBeast.beastNFT == BeastNFT", (await stake.beastNFT()) === record.beastNFT);
  check("StakeBeast.attester == record.attester", (await stake.attester()) === record.attester);
  check("StakeBeast.charity == record.charity", (await stake.charity()) === record.charity);
  check("StakeBeast.owner == record.owner", (await stake.owner()) === record.owner);
  check("StakeBeast windows == record",
    (await stake.JOIN_WINDOW()) == record.joinWindow &&
    (await stake.START_WINDOW()) == record.startWindow &&
    (await stake.GRACE_DURATION()) == record.graceDuration);

  const ev = new ethers.Interface(art("StakeBeast").abi).getEvent("SessionCreated");
  const logs = await provider.getLogs({
    address: record.stakeBeast,
    topics: [ev.topicHash],
    fromBlock: record.contracts.StakeBeast.deployBlockNumber,
    toBlock: "latest",
  });
  console.log(`INFO  SessionCreated events since deploy: ${logs.length}`);
  for (const l of logs) {
    const d = new ethers.Interface(art("StakeBeast").abi).decodeEventLog(ev, l.data, l.topics);
    const s = await stake.getSession(d[0]);
    console.log(
      `INFO  session #${d[0]} tx=${l.transactionHash} mode=${s.mode} status=${s.status} ` +
      `stake=${ethers.formatEther(s.stake)} ETH minted=${s.minted}`
    );
  }

  if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log("\nAll deployment checks passed.");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
