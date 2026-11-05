// Re-verifies both deployed contracts on Etherscan from the recorded
// deployment file — use this when the deploy-time auto-verification was
// skipped (no ETHERSCAN_API_KEY) or failed transiently:
//
//   npx hardhat run scripts/verify.js --network sepolia
//
// Reads deployments/<network>.json (written by scripts/deploy.js) for the
// contract addresses and exact constructor arguments; requires
// ETHERSCAN_API_KEY in the root .env.
const { network, run } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment record at ${file} — run scripts/deploy.js first.`);
  }
  const info = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!process.env.ETHERSCAN_API_KEY) {
    throw new Error("ETHERSCAN_API_KEY is not set (see .env.example).");
  }

  console.log(`Verifying on ${network.name} (chainId ${info.chainId})...`);
  await run("verify:verify", {
    address: info.beastNFT,
    constructorArguments: info.constructorArgs.beastNFT,
  });
  console.log(`BeastNFT ${info.beastNFT}: verified`);
  await run("verify:verify", {
    address: info.stakeBeast,
    constructorArguments: info.constructorArgs.stakeBeast,
  });
  console.log(`StakeBeast ${info.stakeBeast}: verified`);

  info.verified = true;
  fs.writeFileSync(file, JSON.stringify(info, null, 2) + "\n");
  console.log(`Updated ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
