// Regression for DAPP-68: the deploy script must inject the attester /
// charity role addresses from ATTESTER_ADDRESS / CHARITY_ADDRESS (Sepolia
// provides only the deployer key), falling back to the local dev signers on
// the Hardhat network.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { resolveRoleAddresses } = require("../scripts/role-addresses");

const ENV_KEYS = ["ATTESTER_ADDRESS", "CHARITY_ADDRESS"];

describe("deploy role-address resolution", function () {
  let saved;
  beforeEach(function () {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(function () {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("falls back to the dev signers when the env vars are unset (local network)", async function () {
    const signers = await ethers.getSigners();
    const { owner, attester, charity } = await resolveRoleAddresses();
    expect(owner.address).to.equal(signers[0].address);
    expect(attester).to.equal(signers[1].address);
    expect(charity).to.equal(signers[2].address);
  });

  it("prefers ATTESTER_ADDRESS / CHARITY_ADDRESS over the dev signers", async function () {
    const signers = await ethers.getSigners();
    process.env.ATTESTER_ADDRESS = signers[5].address;
    process.env.CHARITY_ADDRESS = signers[6].address.toLowerCase();
    const { attester, charity } = await resolveRoleAddresses();
    expect(attester).to.equal(signers[5].address);
    expect(charity).to.equal(signers[6].address); // normalized to checksum form
  });

  it("rejects a malformed ATTESTER_ADDRESS with a .env hint", async function () {
    process.env.ATTESTER_ADDRESS = "not-an-address";
    await expect(resolveRoleAddresses()).to.be.rejectedWith(/ATTESTER_ADDRESS/);
  });

  it("rejects a zero CHARITY_ADDRESS", async function () {
    process.env.CHARITY_ADDRESS = ethers.ZeroAddress;
    await expect(resolveRoleAddresses()).to.be.rejectedWith(/CHARITY_ADDRESS/);
  });

  it("deploys the stack with env-injected role addresses end to end", async function () {
    const signers = await ethers.getSigners();
    process.env.ATTESTER_ADDRESS = signers[7].address;
    process.env.CHARITY_ADDRESS = signers[8].address;

    const { owner, attester, charity } = await resolveRoleAddresses();
    const BeastNFT = await ethers.getContractFactory("BeastNFT");
    const nft = await BeastNFT.deploy(owner.address, owner.address);
    const StakeBeast = await ethers.getContractFactory("StakeBeast");
    const stake = await StakeBeast.deploy(
      owner.address,
      attester,
      charity,
      await nft.getAddress(),
      3600,
      3600,
      3600
    );
    expect(await stake.attester()).to.equal(signers[7].address);
    expect(await stake.charity()).to.equal(signers[8].address);
  });
});
