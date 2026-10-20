// Deploys the full StakeBeast stack: BeastNFT + StakeBeast main contract,
// then points BeastNFT's minter at the main contract (contract-design v4).
//
// Local integration (Hardhat node):
//   HARDHAT_MINING_INTERVAL=5000 npx hardhat node          # terminal 1
//   npx hardhat run scripts/deploy.js --network localhost  # terminal 2
// Sepolia:
//   npx hardhat run scripts/deploy.js --network sepolia
//
// Writes deployments/<network>.json with the addresses, window parameters and
// the role accounts, and prints the matching attester `.env` lines.
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Demo-profile windows in seconds (same profile as the unit-test fixture).
const JOIN_WINDOW = 3600;
const START_WINDOW = 3600;
const GRACE_DURATION = 3600;

async function main() {
  const [owner, attester, charity] = await ethers.getSigners();
  console.log(`Network:  ${network.name} (chainId ${(await ethers.provider.getNetwork()).chainId})`);
  console.log(`Owner:    ${owner.address}`);
  console.log(`Attester: ${attester.address}`);
  console.log(`Charity:  ${charity.address}`);

  const BeastNFT = await ethers.getContractFactory("BeastNFT");
  const nft = await BeastNFT.deploy(owner.address, owner.address);
  await nft.waitForDeployment();
  const nftAddress = await nft.getAddress();
  console.log(`BeastNFT deployed:   ${nftAddress}`);

  const StakeBeast = await ethers.getContractFactory("StakeBeast");
  const stake = await StakeBeast.deploy(
    owner.address,
    attester.address,
    charity.address,
    nftAddress,
    JOIN_WINDOW,
    START_WINDOW,
    GRACE_DURATION
  );
  await stake.waitForDeployment();
  const stakeAddress = await stake.getAddress();
  console.log(`StakeBeast deployed: ${stakeAddress}`);

  await (await nft.connect(owner).setMinter(stakeAddress)).wait();
  console.log("BeastNFT minter -> StakeBeast");

  const info = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    stakeBeast: stakeAddress,
    beastNFT: nftAddress,
    owner: owner.address,
    attester: attester.address,
    charity: charity.address,
    joinWindow: JOIN_WINDOW,
    startWindow: START_WINDOW,
    graceDuration: GRACE_DURATION,
    deployedAt: new Date().toISOString(),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(info, null, 2) + "\n");
  console.log(`Wrote ${file}`);

  console.log("\nAttester .env (fill in the signing key for the attester account):");
  console.log(`RPC_URL=http://127.0.0.1:8545`);
  console.log(`CONTRACT_ADDRESS=${stakeAddress}`);
  console.log(`ATTESTER_PRIVATE_KEY=<key of ${attester.address}>`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
