const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Lands the NEXT transaction's block exactly at `ts` (verified semantics of
// setNextBlockTimestamp on this Hardhat build — increaseTo is off by one).
// Each target must be strictly greater than the latest block timestamp.
async function setNextBlockTime(ts) {
  await time.setNextBlockTimestamp(Number(ts));
}

// Demo-profile windows used across the unit tests (design: constructor-set).
const JOIN_WINDOW = 3600; // 1 h
const START_WINDOW = 3600; // 1 h
const GRACE_DURATION = 3600; // 1 h

const Mode = { SoloFocus: 0, Supervised: 1, Duel: 2, CoFocus: 3 };
const Status = { Pending: 0, Active: 1, Completed: 2, Forfeited: 3, Voided: 4, Cancelled: 5 };
const Payee = { Charity: 0, Verifier: 1, Custom: 2 };
const Kind = { Focus: 0, Habit: 1 };
const Tier = { Sprout: 0, Juvenile: 1, Adult: 2, Golden: 3 };

const ONE_ETH = ethers.parseEther("1");
const HALF_ETH = ethers.parseEther("0.5");

async function deployFixture() {
  const [owner, attester, charity, alice, bob, carol, dave] = await ethers.getSigners();
  const BeastNFT = await ethers.getContractFactory("BeastNFT");
  const nft = await BeastNFT.deploy(owner.address, owner.address);
  await nft.waitForDeployment();
  const StakeBeast = await ethers.getContractFactory("StakeBeast");
  const stake = await StakeBeast.deploy(
    owner.address,
    attester.address,
    charity.address,
    await nft.getAddress(),
    JOIN_WINDOW,
    START_WINDOW,
    GRACE_DURATION
  );
  await stake.waitForDeployment();
  await nft.connect(owner).setMinter(await stake.getAddress());
  return { owner, attester, charity, alice, bob, carol, dave, nft, stake };
}

// --- creation helpers (return the new session id) ---

async function lastSessionId(stake) {
  return (await stake.nextSessionId()) - 1n;
}

async function createSolo(stake, staker, durationMinutes = 60, value = ONE_ETH, payee = Payee.Charity, customPayee = ethers.ZeroAddress) {
  await stake.connect(staker).createSession(
    Mode.SoloFocus, ethers.ZeroAddress, payee, customPayee, durationMinutes, 0, 0, 0, "", { value }
  );
  return lastSessionId(stake);
}

async function createSupervised(
  stake, staker, verifier, periodDays = 7, value = ONE_ETH, payee = Payee.Charity, customPayee = ethers.ZeroAddress
) {
  await stake.connect(staker).createSession(
    Mode.Supervised, verifier.address, payee, customPayee, 0, periodDays, 1, 7, "gym every day", { value }
  );
  return lastSessionId(stake);
}

async function createDuel(
  stake, staker, opponent, value = ONE_ETH, payee = Payee.Charity, customPayee = ethers.ZeroAddress, habit = false
) {
  const [durationMinutes, periodDays, checkInsPerDay, targetCount, criterion] = habit
    ? [0, 7, 1, 7, "gym every day"]
    : [60, 0, 0, 0, ""];
  await stake.connect(staker).createSession(
    Mode.Duel, opponent.address, payee, customPayee,
    durationMinutes, periodDays, checkInsPerDay, targetCount, criterion, { value }
  );
  return lastSessionId(stake);
}

async function createCoFocus(stake, staker, durationMinutes = 60, value = ONE_ETH) {
  await stake.connect(staker).createSession(
    Mode.CoFocus, ethers.ZeroAddress, Payee.Charity, ethers.ZeroAddress, durationMinutes, 0, 0, 0, "", { value }
  );
  return lastSessionId(stake);
}

// --- EIP-712 attestation helper (mirrors the frozen scheme) ---

const ATTESTATION_TYPES = {
  CompletionAttestation: [
    { name: "sessionId", type: "uint256" },
    { name: "staker", type: "address" },
    { name: "partner", type: "address" },
    { name: "startTime", type: "uint64" },
    { name: "endTime", type: "uint64" },
    { name: "expiry", type: "uint64" },
  ],
};

// Signs an attestation for the stored session fields; `overrides` can corrupt
// any message field or the domain for negative tests.
async function signForSession(signer, stake, sessionId, overrides = {}) {
  const s = await stake.getSession(sessionId);
  const network = await ethers.provider.getNetwork();
  const domain = {
    name: "StakeBeast",
    version: "1",
    chainId: overrides.chainId ?? network.chainId,
    verifyingContract: overrides.verifyingContract ?? (await stake.getAddress()),
  };
  const value = {
    sessionId: overrides.sessionId ?? sessionId,
    staker: overrides.staker ?? s.staker,
    partner: overrides.partner ?? s.partner,
    startTime: overrides.startTime ?? s.startTime,
    endTime: overrides.endTime ?? s.endTime,
    expiry: overrides.expiry ?? s.settlementDeadline,
  };
  return signer.signTypedData(domain, ATTESTATION_TYPES, value);
}

module.exports = {
  JOIN_WINDOW,
  START_WINDOW,
  GRACE_DURATION,
  Mode,
  Status,
  Payee,
  Kind,
  Tier,
  ONE_ETH,
  HALF_ETH,
  setNextBlockTime,
  deployFixture,
  lastSessionId,
  createSolo,
  createSupervised,
  createDuel,
  createCoFocus,
  signForSession,
};
