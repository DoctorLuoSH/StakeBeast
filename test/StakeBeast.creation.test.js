const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  JOIN_WINDOW, START_WINDOW, GRACE_DURATION,
  Mode, Status, Payee, ONE_ETH,
  deployFixture,
} = require("./helpers");

describe("StakeBeast — deployment & creation (FR-01, R6, AC-26)", function () {
  let fx;
  beforeEach(async function () {
    fx = await deployFixture();
  });

  describe("deployment", function () {
    it("sets owner, attester, charity, nft and windows", async function () {
      const { stake, owner, attester, charity, nft } = fx;
      expect(await stake.owner()).to.equal(owner.address);
      expect(await stake.attester()).to.equal(attester.address);
      expect(await stake.charity()).to.equal(charity.address);
      expect(await stake.beastNFT()).to.equal(await nft.getAddress());
      expect(await stake.JOIN_WINDOW()).to.equal(JOIN_WINDOW);
      expect(await stake.START_WINDOW()).to.equal(START_WINDOW);
      expect(await stake.GRACE_DURATION()).to.equal(GRACE_DURATION);
      expect(await stake.nextSessionId()).to.equal(1);
    });

    it("reverts when deployed with a zero charity (R6)", async function () {
      const { owner, attester, nft } = fx;
      const StakeBeast = await ethers.getContractFactory("StakeBeast");
      await expect(
        StakeBeast.deploy(owner.address, attester.address, ethers.ZeroAddress, await nft.getAddress(), 1, 1, 1)
      ).to.be.revertedWithCustomError(StakeBeast, "ZeroCharity");
    });
  });

  describe("initial state per mode (FR-01)", function () {
    it("SoloFocus enters Pending with a startDeadline and locks the stake", async function () {
      const { stake, alice } = fx;
      const tx = stake.connect(alice).createSession(
        Mode.SoloFocus, ethers.ZeroAddress, Payee.Charity, ethers.ZeroAddress, 60, 0, 0, 0, "", { value: ONE_ETH }
      );
      await expect(tx).to.emit(stake, "SessionCreated");
      const s = await stake.getSession(1);
      expect(s.mode).to.equal(Mode.SoloFocus);
      expect(s.status).to.equal(Status.Pending);
      expect(s.staker).to.equal(alice.address);
      expect(s.stake).to.equal(ONE_ETH);
      expect(s.startDeadline).to.equal(BigInt(s.createdAt) + BigInt(START_WINDOW));
      expect(s.joinDeadline).to.equal(0);
      expect(s.startTime).to.equal(0);
      expect(await ethers.provider.getBalance(await stake.getAddress())).to.equal(ONE_ETH);
      expect(await stake.sessionsOf(alice.address)).to.deep.equal([1n]);
    });

    it("Supervised enters Active immediately with startTime = creation (v1.2 minor)", async function () {
      const { stake, alice, bob } = fx;
      const tx = await stake.connect(alice).createSession(
        Mode.Supervised, bob.address, Payee.Verifier, ethers.ZeroAddress, 0, 7, 1, 7, "gym", { value: ONE_ETH }
      );
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      await expect(tx).to.emit(stake, "SessionCreated");
      await expect(tx)
        .to.emit(stake, "SessionStarted")
        .withArgs(1, block.timestamp, block.timestamp + 7 * 86400, block.timestamp + 7 * 86400 + GRACE_DURATION);
      const s = await stake.getSession(1);
      expect(s.status).to.equal(Status.Active);
      expect(s.verifier).to.equal(bob.address);
      expect(s.startTime).to.equal(block.timestamp);
      expect(s.endTime).to.equal(BigInt(block.timestamp) + 7n * 86400n);
      expect(s.settlementDeadline).to.equal(BigInt(s.endTime) + BigInt(GRACE_DURATION));
      expect(s.criterion).to.equal("gym");
    });

    it("Duel enters Pending awaiting the named opponent", async function () {
      const { stake, alice, bob } = fx;
      await stake.connect(alice).createSession(
        Mode.Duel, bob.address, Payee.Charity, ethers.ZeroAddress, 60, 0, 0, 0, "", { value: ONE_ETH }
      );
      const s = await stake.getSession(1);
      expect(s.status).to.equal(Status.Pending);
      expect(s.partner).to.equal(bob.address);
      expect(s.verifier).to.equal(bob.address); // A's position is verified by B
      expect(s.joinDeadline).to.equal(BigInt(s.createdAt) + BigInt(JOIN_WINDOW));
      expect(s.startDeadline).to.equal(0);
      expect(s.joined).to.equal(false);
    });

    it("CoFocus enters Pending with joinDeadline only (startDeadline re-anchored at join)", async function () {
      const { stake, alice } = fx;
      await stake.connect(alice).createSession(
        Mode.CoFocus, ethers.ZeroAddress, Payee.Charity, ethers.ZeroAddress, 60, 0, 0, 0, "", { value: ONE_ETH }
      );
      const s = await stake.getSession(1);
      expect(s.status).to.equal(Status.Pending);
      expect(s.joinDeadline).to.equal(BigInt(s.createdAt) + BigInt(JOIN_WINDOW));
      expect(s.startDeadline).to.equal(0);
    });
  });

  describe("parameter validation (AC-26)", function () {
    it("reverts on zero stake (E10 / F5)", async function () {
      const { stake, alice } = fx;
      await expect(
        stake.connect(alice).createSession(Mode.SoloFocus, ethers.ZeroAddress, Payee.Charity, ethers.ZeroAddress, 60, 0, 0, 0, "", { value: 0 })
      ).to.be.revertedWithCustomError(stake, "ZeroStake");
    });

    it("reverts on stake above the 100 ether cap", async function () {
      const { stake, alice } = fx;
      await expect(
        stake.connect(alice).createSession(Mode.SoloFocus, ethers.ZeroAddress, Payee.Charity, ethers.ZeroAddress, 60, 0, 0, 0, "", {
          value: ethers.parseEther("101"),
        })
      ).to.be.revertedWithCustomError(stake, "StakeAboveCap");
    });

    it("reverts on out-of-range focus duration (0 and 1441)", async function () {
      const { stake, alice } = fx;
      for (const duration of [0, 1441]) {
        await expect(
          stake.connect(alice).createSession(Mode.SoloFocus, ethers.ZeroAddress, Payee.Charity, ethers.ZeroAddress, duration, 0, 0, 0, "", { value: ONE_ETH })
        ).to.be.revertedWithCustomError(stake, "DurationOutOfRange");
      }
    });

    it("reverts on out-of-range habit period / frequency / target", async function () {
      const { stake, alice, bob } = fx;
      const bad = [
        [0, 0, 1, 7], // period 0
        [0, 366, 1, 7], // period 366
        [0, 7, 0, 7], // checkInsPerDay 0
        [0, 7, 9, 7], // checkInsPerDay 9
        [0, 7, 1, 0], // target 0
        [0, 7, 1, 1001], // target 1001
      ];
      for (const [duration, period, freq, target] of bad) {
        await expect(
          stake.connect(alice).createSession(Mode.Supervised, bob.address, Payee.Charity, ethers.ZeroAddress, duration, period, freq, target, "", { value: ONE_ETH })
        ).to.be.reverted;
      }
    });

    it("reverts a duel carrying both duration and period, or neither", async function () {
      const { stake, alice, bob } = fx;
      await expect(
        stake.connect(alice).createSession(Mode.Duel, bob.address, Payee.Charity, ethers.ZeroAddress, 60, 7, 1, 7, "", { value: ONE_ETH })
      ).to.be.revertedWithCustomError(stake, "DuelTaskParamMismatch");
      await expect(
        stake.connect(alice).createSession(Mode.Duel, bob.address, Payee.Charity, ethers.ZeroAddress, 0, 0, 0, 0, "", { value: ONE_ETH })
      ).to.be.revertedWithCustomError(stake, "DuelTaskParamMismatch");
    });

    it("reverts a supervised session carrying a focus duration (M2 review D3)", async function () {
      const { stake, alice, bob } = fx;
      // periodDays = 7 + durationMinutes = 1 used to be accepted, shrinking
      // the 7-day habit window to 60 seconds.
      await expect(
        stake.connect(alice).createSession(Mode.Supervised, bob.address, Payee.Charity, ethers.ZeroAddress, 1, 7, 1, 7, "", { value: ONE_ETH })
      ).to.be.revertedWithCustomError(stake, "IncompatibleTaskParams");
    });

    it("reverts a focus session carrying a habit period (SoloFocus and CoFocus)", async function () {
      const { stake, alice } = fx;
      await expect(
        stake.connect(alice).createSession(Mode.SoloFocus, ethers.ZeroAddress, Payee.Charity, ethers.ZeroAddress, 60, 7, 0, 0, "", { value: ONE_ETH })
      ).to.be.revertedWithCustomError(stake, "IncompatibleTaskParams");
      await expect(
        stake.connect(alice).createSession(Mode.CoFocus, ethers.ZeroAddress, Payee.Charity, ethers.ZeroAddress, 60, 7, 0, 0, "", { value: ONE_ETH })
      ).to.be.revertedWithCustomError(stake, "IncompatibleTaskParams");
    });

    it("reverts on self as counterparty", async function () {
      const { stake, alice } = fx;
      await expect(
        stake.connect(alice).createSession(Mode.Supervised, alice.address, Payee.Charity, ethers.ZeroAddress, 0, 7, 1, 7, "", { value: ONE_ETH })
      ).to.be.revertedWithCustomError(stake, "SelfCounterparty");
      await expect(
        stake.connect(alice).createSession(Mode.Duel, alice.address, Payee.Charity, ethers.ZeroAddress, 60, 0, 0, 0, "", { value: ONE_ETH })
      ).to.be.revertedWithCustomError(stake, "SelfCounterparty");
    });

    it("reverts supervised creation with a zero verifier", async function () {
      const { stake, alice } = fx;
      await expect(
        stake.connect(alice).createSession(Mode.Supervised, ethers.ZeroAddress, Payee.Charity, ethers.ZeroAddress, 0, 7, 1, 7, "", { value: ONE_ETH })
      ).to.be.revertedWithCustomError(stake, "VerifierRequired");
    });
  });

  describe("payee combination validation (R6)", function () {
    it("rejects Payee.Verifier for SoloFocus and CoFocus", async function () {
      const { stake, alice } = fx;
      await expect(
        stake.connect(alice).createSession(Mode.SoloFocus, ethers.ZeroAddress, Payee.Verifier, ethers.ZeroAddress, 60, 0, 0, 0, "", { value: ONE_ETH })
      ).to.be.revertedWithCustomError(stake, "PayeeVerifierNotAllowed");
      await expect(
        stake.connect(alice).createSession(Mode.CoFocus, ethers.ZeroAddress, Payee.Verifier, ethers.ZeroAddress, 60, 0, 0, 0, "", { value: ONE_ETH })
      ).to.be.revertedWithCustomError(stake, "PayeeVerifierNotAllowed");
    });

    it("rejects Payee.Custom with a zero customPayee on creation", async function () {
      const { stake, alice, bob } = fx;
      await expect(
        stake.connect(alice).createSession(Mode.SoloFocus, ethers.ZeroAddress, Payee.Custom, ethers.ZeroAddress, 60, 0, 0, 0, "", { value: ONE_ETH })
      ).to.be.revertedWithCustomError(stake, "CustomPayeeZero");
      await expect(
        stake.connect(alice).createSession(Mode.Supervised, bob.address, Payee.Custom, ethers.ZeroAddress, 0, 7, 1, 7, "", { value: ONE_ETH })
      ).to.be.revertedWithCustomError(stake, "CustomPayeeZero");
    });

    it("forces CoFocus payee to Charity (rejects Custom even with an address)", async function () {
      const { stake, alice, carol } = fx;
      await expect(
        stake.connect(alice).createSession(Mode.CoFocus, ethers.ZeroAddress, Payee.Custom, carol.address, 60, 0, 0, 0, "", { value: ONE_ETH })
      ).to.be.revertedWithCustomError(stake, "CoFocusPayeeNotCharity");
    });

    it("accepts Payee.Verifier for human-proof modes", async function () {
      const { stake, alice, bob } = fx;
      await expect(
        stake.connect(alice).createSession(Mode.Supervised, bob.address, Payee.Verifier, ethers.ZeroAddress, 0, 7, 1, 7, "", { value: ONE_ETH })
      ).to.emit(stake, "SessionCreated");
      await expect(
        stake.connect(alice).createSession(Mode.Duel, bob.address, Payee.Verifier, ethers.ZeroAddress, 60, 0, 0, 0, "", { value: ONE_ETH })
      ).to.emit(stake, "SessionCreated");
    });
  });

  describe("attester management (R6)", function () {
    it("rejects setAttester(address(0)) and non-owner calls", async function () {
      const { stake, owner, alice } = fx;
      await expect(stake.connect(owner).setAttester(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(stake, "ZeroAttester");
      await expect(stake.connect(alice).setAttester(alice.address))
        .to.be.revertedWithCustomError(stake, "OwnableUnauthorizedAccount");
    });

    it("emits AttesterUpdated on rotation", async function () {
      const { stake, owner, attester, alice } = fx;
      await expect(stake.connect(owner).setAttester(alice.address))
        .to.emit(stake, "AttesterUpdated")
        .withArgs(attester.address, alice.address);
      expect(await stake.attester()).to.equal(alice.address);
    });
  });

  describe("tierFor view (section 7)", function () {
    it("matches the dual-track ladder at boundaries", async function () {
      const { stake } = fx;
      expect(await stake.tierFor(0, 24)).to.equal(0);
      expect(await stake.tierFor(0, 25)).to.equal(1);
      expect(await stake.tierFor(0, 50)).to.equal(2);
      expect(await stake.tierFor(0, 120)).to.equal(3);
      expect(await stake.tierFor(1, 2)).to.equal(0);
      expect(await stake.tierFor(1, 3)).to.equal(1);
      expect(await stake.tierFor(1, 7)).to.equal(2);
      expect(await stake.tierFor(1, 21)).to.equal(3);
    });
  });

  describe("unknown sessions", function () {
    it("reverts every session-scoped call for id 0 or a future id", async function () {
      const { stake, alice } = fx;
      for (const id of [0, 42]) {
        await expect(stake.getSession(id)).to.be.revertedWithCustomError(stake, "UnknownSession");
        await expect(stake.connect(alice).startSession(id)).to.be.revertedWithCustomError(stake, "UnknownSession");
        await expect(stake.connect(alice).cancelPending(id)).to.be.revertedWithCustomError(stake, "UnknownSession");
        await expect(stake.connect(alice).joinSession(id, Payee.Charity, ethers.ZeroAddress)).to.be.revertedWithCustomError(stake, "UnknownSession");
        await expect(stake.connect(alice).settle(id, "0x")).to.be.revertedWithCustomError(stake, "UnknownSession");
        await expect(stake.connect(alice).verify(id)).to.be.revertedWithCustomError(stake, "UnknownSession");
        await expect(stake.connect(alice).admitDefeat(id)).to.be.revertedWithCustomError(stake, "UnknownSession");
        await expect(stake.connect(alice).forfeit(id)).to.be.revertedWithCustomError(stake, "UnknownSession");
        await expect(stake.connect(alice).checkIn(id, ethers.ZeroHash)).to.be.revertedWithCustomError(stake, "UnknownSession");
      }
    });
  });
});
