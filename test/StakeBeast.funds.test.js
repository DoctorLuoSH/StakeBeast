const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  Status, Payee, ONE_ETH,
  deployFixture, createSolo, createSupervised, signForSession, setNextBlockTime,
} = require("./helpers");

describe("StakeBeast — funds, withdraw, void, check-in (AC-03/08/11, R9)", function () {
  let fx;
  beforeEach(async function () {
    fx = await deployFixture();
  });

  describe("withdraw (AC-11, FR-10)", function () {
    it("sweeps the full claimable balance and zeroes it", async function () {
      const { stake, alice, bob } = fx;
      const id = await createSupervised(stake, alice, bob, 7, ONE_ETH, Payee.Verifier);
      await stake.connect(alice).admitDefeat(id); // credits bob
      await expect(() => stake.connect(bob).withdraw()).to.changeEtherBalance(bob, ONE_ETH);
      expect(await stake.claimableOf(bob.address)).to.equal(0);
    });

    it("emits Withdrawn and reverts a second withdraw with nothing left", async function () {
      const { stake, alice, bob } = fx;
      const id = await createSupervised(stake, alice, bob, 7, ONE_ETH, Payee.Verifier);
      await stake.connect(alice).admitDefeat(id);
      await expect(stake.connect(bob).withdraw())
        .to.emit(stake, "Withdrawn")
        .withArgs(bob.address, ONE_ETH);
      await expect(stake.connect(bob).withdraw())
        .to.be.revertedWithCustomError(stake, "NothingToWithdraw");
    });

    it("one user's unclaimed balance never blocks another user (AC-11)", async function () {
      const { stake, charity, alice, bob, carol } = fx;
      const id1 = await createSupervised(stake, alice, bob, 7, ONE_ETH, Payee.Custom, carol.address);
      const id2 = await createSupervised(stake, bob, alice, 7, ONE_ETH, Payee.Custom, carol.address);
      await stake.connect(alice).admitDefeat(id1);
      await stake.connect(bob).admitDefeat(id2);
      // carol withdraws once for the combined balance; alice/bob are unaffected
      await expect(stake.connect(carol).withdraw())
        .to.emit(stake, "Withdrawn")
        .withArgs(carol.address, 2n * ONE_ETH);
      expect(await stake.claimableOf(carol.address)).to.equal(0);
      expect(await stake.claimableOf(alice.address)).to.equal(0);
    });

    it("a failing receiver can retry later: balance survives the reverted attempt", async function () {
      const { stake, alice, bob } = fx;
      const Probes = await ethers.getContractFactory("WithdrawProbe");
      const probe = await Probes.deploy(await stake.getAddress());
      await probe.waitForDeployment();
      const probeAddr = await probe.getAddress();

      const id = await createSupervised(stake, alice, bob, 7, ONE_ETH, Payee.Custom, probeAddr);
      await stake.connect(alice).admitDefeat(id);
      expect(await stake.claimableOf(probeAddr)).to.equal(ONE_ETH);

      await probe.setFailReceive(true);
      await expect(probe.withdraw()).to.be.revertedWithCustomError(stake, "WithdrawTransferFailed");
      expect(await stake.claimableOf(probeAddr)).to.equal(ONE_ETH); // intact, retryable

      await probe.setFailReceive(false);
      await probe.withdraw();
      expect(await stake.claimableOf(probeAddr)).to.equal(0);
      expect(await ethers.provider.getBalance(probeAddr)).to.equal(ONE_ETH);
    });

    it("blocks a reentrant withdraw attempt (ReentrancyGuard)", async function () {
      const { stake, alice, bob } = fx;
      const Probes = await ethers.getContractFactory("WithdrawProbe");
      const probe = await Probes.deploy(await stake.getAddress());
      await probe.waitForDeployment();
      const probeAddr = await probe.getAddress();

      const id = await createSupervised(stake, alice, bob, 7, ONE_ETH, Payee.Custom, probeAddr);
      await stake.connect(alice).admitDefeat(id);

      await probe.setReenterOnce(true);
      // Outer withdraw pays exactly once; the reentrant call hits the guard and
      // its unexpected success would fail the whole probe transaction.
      await probe.withdraw();
      expect(await stake.claimableOf(probeAddr)).to.equal(0);
      expect(await ethers.provider.getBalance(probeAddr)).to.equal(ONE_ETH);
    });
  });

  describe("voidSession (AC-08, FR-11)", function () {
    it("refunds a non-terminal session in full, no mint, no forfeit routing", async function () {
      const { stake, owner, charity, alice, bob } = fx;
      const id = await createSupervised(stake, alice, bob, 7, ONE_ETH, Payee.Verifier);
      await expect(stake.connect(owner).voidSession(id))
        .to.emit(stake, "SessionVoided")
        .withArgs(id, owner.address);
      expect((await stake.getSession(id)).status).to.equal(Status.Voided);
      expect(await stake.claimableOf(alice.address)).to.equal(ONE_ETH); // principal back to staker
      expect(await stake.claimableOf(bob.address)).to.equal(0); // no payee routing
      expect(await stake.claimableOf(charity.address)).to.equal(0);
      expect(await fx.nft.balanceOf(alice.address)).to.equal(0);
    });

    it("voids a Pending session (never started) with full refund", async function () {
      const { stake, owner, alice } = fx;
      const id = await createSolo(stake, alice);
      await stake.connect(owner).voidSession(id);
      expect((await stake.getSession(id)).status).to.equal(Status.Voided);
      expect(await stake.claimableOf(alice.address)).to.equal(ONE_ETH);
    });

    it("reverts on a terminal session", async function () {
      const { stake, owner, alice, bob } = fx;
      const id = await createSupervised(stake, alice, bob);
      await stake.connect(bob).verify(id);
      await expect(stake.connect(owner).voidSession(id))
        .to.be.revertedWithCustomError(stake, "WrongStatus");
    });

    it("reverts from a non-admin", async function () {
      const { stake, alice, bob } = fx;
      const id = await createSupervised(stake, alice, bob);
      await expect(stake.connect(alice).voidSession(id))
        .to.be.revertedWithCustomError(stake, "OwnableUnauthorizedAccount");
    });

    it("void racing settle/forfeit: first terminal wins (E3/E4)", async function () {
      const { stake, owner, attester, alice } = fx;
      const id = await createSolo(stake, alice);
      await stake.connect(alice).startSession(id);
      // admin void lands first
      await stake.connect(owner).voidSession(id);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.endTime));
      const sig = await signForSession(attester, stake, id);
      await expect(stake.connect(alice).settle(id, sig))
        .to.be.revertedWithCustomError(stake, "WrongStatus");
      await setNextBlockTime(Number(s.settlementDeadline));
      await expect(stake.forfeit(id)).to.be.revertedWithCustomError(stake, "WrongStatus");
    });
  });

  describe("checkIn evidence anchoring (P1, R9, F10)", function () {
    it("emits CheckedIn with the computed period index inside the task window", async function () {
      const { stake, alice, bob } = fx;
      const id = await createSupervised(stake, alice, bob, 7);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("photo-bytes"));
      await expect(stake.connect(alice).checkIn(id, hash))
        .to.emit(stake, "CheckedIn")
        .withArgs(id, alice.address, hash, 0);
      // day 2 -> periodIndex 1
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.startTime) + 86400 + 5);
      await expect(stake.connect(alice).checkIn(id, hash))
        .to.emit(stake, "CheckedIn")
        .withArgs(id, alice.address, hash, 1);
    });

    it("reverts at/after endTime and on a terminal session", async function () {
      const { stake, alice, bob } = fx;
      const id = await createSupervised(stake, alice, bob, 7);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.endTime));
      await expect(stake.connect(alice).checkIn(id, ethers.ZeroHash))
        .to.be.revertedWithCustomError(stake, "OutsideTaskWindow");
      // terminal sessions reject check-ins even inside the window
      const id2 = await createSupervised(stake, alice, bob, 7);
      await stake.connect(bob).verify(id2);
      await expect(stake.connect(alice).checkIn(id2, ethers.ZeroHash))
        .to.be.revertedWithCustomError(stake, "WrongStatus");
    });

    it("reverts from a non-staker", async function () {
      const { stake, alice, bob } = fx;
      const id = await createSupervised(stake, alice, bob);
      await expect(stake.connect(bob).checkIn(id, ethers.ZeroHash))
        .to.be.revertedWithCustomError(stake, "NotStaker");
    });

    it("reverts on a machine-proof session that has not started (Pending)", async function () {
      const { stake, alice } = fx;
      const id = await createSolo(stake, alice);
      await expect(stake.connect(alice).checkIn(id, ethers.ZeroHash))
        .to.be.revertedWithCustomError(stake, "WrongStatus");
    });

    it("works on an active machine-proof session inside its window", async function () {
      const { stake, alice } = fx;
      const id = await createSolo(stake, alice, 60);
      await stake.connect(alice).startSession(id);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("focus-photo"));
      await expect(stake.connect(alice).checkIn(id, hash))
        .to.emit(stake, "CheckedIn")
        .withArgs(id, alice.address, hash, 0);
    });
  });
});
