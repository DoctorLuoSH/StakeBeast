// Deploys BeastNFT. The StakeBeast main contract is plugged in later via
// `setMinter` once it is deployed (see DAPP-2 design freeze).
//
// Usage: npx hardhat run scripts/deploy.js --network sepolia
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying BeastNFT with owner:", deployer.address);

  const BeastNFT = await ethers.getContractFactory("BeastNFT");
  const nft = await BeastNFT.deploy(deployer.address, ethers.ZeroAddress);
  await nft.waitForDeployment();

  console.log("BeastNFT deployed to:", await nft.getAddress());
  console.log("Minter is unset; call setMinter(<StakeBeast address>) after the main contract is deployed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
