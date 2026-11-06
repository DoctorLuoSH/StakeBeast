// Resolves the attester / charity role addresses at deploy time.
//
// Real networks (Sepolia) configure a single deployer key, so the two role
// addresses must come from ATTESTER_ADDRESS / CHARITY_ADDRESS in `.env`.
// Local Hardhat networks expose the well-known dev accounts, so when the
// variables are unset we fall back to signers[1] / signers[2] to keep the
// local demo flow zero-config.
const { ethers } = require("hardhat");

function readAddressEnv(name, purpose) {
  const raw = (process.env[name] || "").trim();
  if (!raw) return null;
  if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) {
    throw new Error(
      `${name} is set to "${raw}", which is not a valid non-zero Ethereum address.\n` +
        `Fix ${name} in .env — it must be the ${purpose} address written into the contract at deploy time (see .env.example).`
    );
  }
  return ethers.getAddress(raw); // normalize to checksum form
}

async function resolveRoleAddresses() {
  const signers = await ethers.getSigners();
  const owner = signers[0];
  if (!owner) {
    throw new Error(
      "No deployer account available: set PRIVATE_KEY in .env for this network (see .env.example)."
    );
  }
  const attester =
    readAddressEnv("ATTESTER_ADDRESS", "attestation service signer") ??
    signers[1]?.address;
  const charity =
    readAddressEnv("CHARITY_ADDRESS", "forfeit charity recipient") ??
    signers[2]?.address;
  const missing = [];
  if (!attester) missing.push("ATTESTER_ADDRESS=<attestation service signer address>");
  if (!charity) missing.push("CHARITY_ADDRESS=<forfeit charity recipient address>");
  if (missing.length) {
    throw new Error(
      "This network provides only the deployer account, so the role addresses must come from .env.\n" +
        `Add to .env: ${missing.join(" and ")} (see .env.example).`
    );
  }
  return { owner, attester, charity };
}

module.exports = { resolveRoleAddresses };
