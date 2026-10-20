require("dotenv").config();
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-network-helpers");
require("@nomicfoundation/hardhat-verify");
require("solidity-coverage");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
      // The 24-field Session struct (public getter + getSession copies) needs
      // the IR pipeline to avoid legacy-codegen stack-too-deep.
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      // `npx hardhat node` for local integration: opt into interval mining via
      // env so the attester's signing gate always sees fresh blocks without a
      // transaction (attester README, "Local demo"). Unit tests run without the
      // variable and keep plain automine.
      mining: process.env.HARDHAT_MINING_INTERVAL
        ? { auto: true, interval: Number(process.env.HARDHAT_MINING_INTERVAL) }
        : { auto: true },
    },
    sepolia: {
      url: process.env.RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
};
