// Deploys the full StakeBeast stack: BeastNFT + StakeBeast main contract,
// then points BeastNFT's minter at the main contract (contract-design v4.1).
//
// Local integration (Hardhat node):
//   HARDHAT_MINING_INTERVAL=5000 npx hardhat node          # terminal 1
//   npx hardhat run scripts/deploy.js --network localhost  # terminal 2
// Sepolia (fill the root .env first, see .env.example):
//   npx hardhat run scripts/deploy.js --network sepolia
//
// Role addresses: on a live network the attester and charity addresses are
// read from the environment (ATTESTER_ADDRESS / CHARITY_ADDRESS) because only
// the deployer key is configured; on a local dev node they default to
// Hardhat's well-known accounts #1 and #2 unless the variables are set.
//
// Writes deployments/<network>.json with the addresses, window parameters,
// role accounts, deploy transaction hashes / block numbers and the exact
// constructor arguments, and prints the attester `.env` lines. On a live
// network it also prints copy-paste `hardhat verify` commands and, when
// ETHERSCAN_API_KEY is set, attempts source verification right away
// (best-effort: re-run any time with `scripts/verify.js`).
const { ethers, network, run } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Demo-profile windows in seconds (same profile as the unit-test fixture).
// contract-design v4.1 section 1: the production profile is 24 h / 24 h / 24 h;
// demo deployments pass shorter values so 2-3 min sessions stay demonstrable.
const JOIN_WINDOW = 3600;
const START_WINDOW = 3600;
const GRACE_DURATION = 3600;

const LIVE_NETWORKS = new Set(["sepolia"]);

function envAddress(name) {
  const value = (process.env[name] || "").trim();
  if (!value) return undefined;
  if (!ethers.isAddress(value)) {
    throw new Error(`${name} is not a valid address: "${value}"`);
  }
  return ethers.getAddress(value); // checksummed
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function verifyWithRetry(label, payload, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await run("verify:verify", payload);
      console.log(`${label}: verified on Etherscan`);
      return true;
    } catch (error) {
      const message = String((error && error.message) || error);
      if (/already verified/i.test(message)) {
        console.log(`${label}: already verified on Etherscan`);
        return true;
      }
      console.log(`${label}: verify attempt ${i}/${attempts} failed (${message.split("\n")[0]})`);
      if (i < attempts) await sleep(15000); // Etherscan needs time to index
    }
  }
  return false;
}

async function main() {
  const isLive = LIVE_NETWORKS.has(network.name);
  if (isLive) {
    // Fail fast with readable messages instead of provider errors.
    if (!process.env.SEPOLIA_RPC_URL) {
      throw new Error("SEPOLIA_RPC_URL is not set (see .env.example).");
    }
    if (!process.env.DEPLOYER_PRIVATE_KEY) {
      throw new Error("DEPLOYER_PRIVATE_KEY is not set (see .env.example).");
    }
  }

  // Resolve and validate the role addresses from the environment before any
  // RPC connection is attempted, so a missing or malformed value fails fast.
  let attesterAddress = envAddress("ATTESTER_ADDRESS");
  let charityAddress = envAddress("CHARITY_ADDRESS");
  if (isLive) {
    if (!attesterAddress) {
      throw new Error(
        "ATTESTER_ADDRESS is required on this network (the address of the " +
          "attester service's ATTESTER_PRIVATE_KEY). See .env.example."
      );
    }
    if (!charityAddress) {
      throw new Error(
        "CHARITY_ADDRESS is required on this network (forfeit sink, must be " +
          "non-zero; the constructor reverts on address(0)). See .env.example."
      );
    }
  }

  const signers = await ethers.getSigners();
  const owner = signers[0];
  if (!owner) {
    throw new Error(
      "No deployer account configured — set DEPLOYER_PRIVATE_KEY in the root .env."
    );
  }

  // Local dev nodes fall back to Hardhat's well-known accounts #1 and #2.
  attesterAddress = attesterAddress || (signers[1] && signers[1].address);
  charityAddress = charityAddress || (signers[2] && signers[2].address);
  if (!attesterAddress) {
    throw new Error("ATTESTER_ADDRESS is not set and no fallback account exists.");
  }
  if (!charityAddress) {
    throw new Error("CHARITY_ADDRESS is not set and no fallback account exists.");
  }
  if (charityAddress === ethers.ZeroAddress) {
    throw new Error("CHARITY_ADDRESS must not be the zero address.");
  }

  console.log(`Network:  ${network.name} (chainId ${(await ethers.provider.getNetwork()).chainId})`);
  console.log(`Owner:    ${owner.address}`);
  console.log(`Attester: ${attesterAddress}`);
  console.log(`Charity:  ${charityAddress}`);

  const BeastNFT = await ethers.getContractFactory("BeastNFT");
  const nft = await BeastNFT.deploy(owner.address, owner.address);
  await nft.waitForDeployment();
  const nftAddress = await nft.getAddress();
  console.log(`BeastNFT deployed:   ${nftAddress}`);

  const StakeBeast = await ethers.getContractFactory("StakeBeast");
  const stake = await StakeBeast.deploy(
    owner.address,
    attesterAddress,
    charityAddress,
    nftAddress,
    JOIN_WINDOW,
    START_WINDOW,
    GRACE_DURATION
  );
  await stake.waitForDeployment();
  const stakeAddress = await stake.getAddress();
  console.log(`StakeBeast deployed: ${stakeAddress}`);

  const setMinterTx = await nft.connect(owner).setMinter(stakeAddress);
  await setMinterTx.wait();
  console.log("BeastNFT minter -> StakeBeast");

  const receiptOf = async (contract) => {
    const receipt = await contract.deploymentTransaction().wait();
    return { hash: receipt.hash, blockNumber: receipt.blockNumber };
  };
  const info = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    stakeBeast: stakeAddress,
    beastNFT: nftAddress,
    owner: owner.address,
    attester: attesterAddress,
    charity: charityAddress,
    joinWindow: JOIN_WINDOW,
    startWindow: START_WINDOW,
    graceDuration: GRACE_DURATION,
    transactions: {
      beastNFT: await receiptOf(nft),
      stakeBeast: await receiptOf(stake),
      setMinter: { hash: setMinterTx.hash, blockNumber: (await setMinterTx.wait()).blockNumber },
    },
    // Exact constructor arguments, kept for Etherscan verification
    // (scripts/verify.js reads them back).
    constructorArgs: {
      beastNFT: [owner.address, owner.address],
      stakeBeast: [
        owner.address,
        attesterAddress,
        charityAddress,
        nftAddress,
        JOIN_WINDOW,
        START_WINDOW,
        GRACE_DURATION,
      ],
    },
    verified: false,
    deployedAt: new Date().toISOString(),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  const writeInfo = () => fs.writeFileSync(file, JSON.stringify(info, null, 2) + "\n");
  writeInfo();
  console.log(`Wrote ${file}`);

  console.log("\nAttester .env (fill in the signing key for the attester account):");
  console.log(`RPC_URL=${isLive ? "<your Sepolia RPC URL>" : "http://127.0.0.1:8545"}`);
  console.log(`CONTRACT_ADDRESS=${stakeAddress}`);
  console.log(`ATTESTER_PRIVATE_KEY=<key of ${attesterAddress}>`);

  if (isLive) {
    const verifyCommands = [
      `npx hardhat verify --network ${network.name} ${nftAddress} ${owner.address} ${owner.address}`,
      `npx hardhat verify --network ${network.name} ${stakeAddress} ${owner.address} ${attesterAddress} ${charityAddress} ${nftAddress} ${JOIN_WINDOW} ${START_WINDOW} ${GRACE_DURATION}`,
    ];
    if (process.env.ETHERSCAN_API_KEY) {
      console.log("\nVerifying sources on Etherscan (best-effort)...");
      // Give Etherscan a moment to index the new contracts.
      await sleep(10000);
      const nftOk = await verifyWithRetry("BeastNFT", {
        address: nftAddress,
        constructorArguments: info.constructorArgs.beastNFT,
      });
      const stakeOk = await verifyWithRetry("StakeBeast", {
        address: stakeAddress,
        constructorArguments: info.constructorArgs.stakeBeast,
      });
      info.verified = nftOk && stakeOk;
      writeInfo();
      if (!info.verified) {
        console.log("\nAuto-verification incomplete; re-run later with:");
        console.log(`  npx hardhat run scripts/verify.js --network ${network.name}`);
      }
    } else {
      console.log("\nETHERSCAN_API_KEY not set — verify the sources manually:");
    }
    console.log("\nVerify commands (copy-paste):");
    for (const cmd of verifyCommands) console.log(`  ${cmd}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
