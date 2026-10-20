const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  JOIN_WINDOW, START_WINDOW, GRACE_DURATION,
  Mode, Status, Payee, ONE_ETH,
  deployFixture, createSolo, createDuel, createCoFocus, setNextBlockTime,
} = require("./helpers");

describe("StakeBeast — pending lifecycle: start / join / cancel (AC-16a/b/c, AC-18, AC-04, AC-23, R6)", function () {
  let fx;
  beforeEach(async function () {
    fx = await deployFixture();
  });

  describe("startSession", function () {
    it("anchors startTime and emits SessionStarted for a solo session", async function () {
      const { stake, alice } = fx;
      const id = await createSolo(stake, alice, 60);
      const tx = await stake.connect(alice).startSession(id);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      await expect(tx)
        .to.emit(stake, "SessionStarted")
        .withArgs(id, block.timestamp, block.timestamp + 3600, block.timestamp + 3600 + GRACE_DURATION);
      const s = await stake.getSession(id);
      expect(s.status).to.equal(Status.Active);
      expect(s.startTime).to.equal(block.timestamp);
      expect(s.endTime).to.equal(BigInt(block.timestamp) + 3600n);
    });

    it("reverts for a non-staker caller", async function () {
      const { stake, alice, bob } = fx;
      const id = await createSolo(stake, alice);
      await expect(stake.connect(bob).startSession(id))
        .to.be.revertedWithCustomError(stake, "NotStaker");
    });

    it("reverts at/after startDeadline and the session stays Pending (AC-16b)", async function () {
      const { stake, alice } = fx;
      const id = await createSolo(stake, alice);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.startDeadline));
      await expect(stake.connect(alice).startSession(id))
        .to.be.revertedWithCustomError(stake, "StartDeadlinePassed");
      expect((await stake.getSession(id)).status).to.equal(Status.Pending);
    });

    it("reverts on human-proof modes (supervised / duel)", async function () {
      const { stake, alice, bob } = fx;
      await stake.connect(alice).createSession(
        Mode.Supervised, bob.address, Payee.Charity, ethers.ZeroAddress, 0, 7, 1, 7, "", { value: ONE_ETH }
      );
      await expect(stake.connect(alice).startSession(1))
        .to.be.revertedWithCustomError(stake, "WrongMode");
      await createDuel(stake, alice, bob);
      await expect(stake.connect(bob).startSession(2))
        .to.be.revertedWithCustomError(stake, "WrongMode");
    });

    it("reverts when the session is already Active", async function () {
      const { stake, alice } = fx;
      const id = await createSolo(stake, alice);
      await stake.connect(alice).startSession(id);
      await expect(stake.connect(alice).startSession(id))
        .to.be.revertedWithCustomError(stake, "WrongStatus");
    });
  });

  describe("cancelPending (phase-matched, R6)", function () {
    it("refunds a never-started solo session in full after startDeadline (AC-16a)", async function () {
      const { stake, alice } = fx;
      const id = await createSolo(stake, alice);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.startDeadline));
      await expect(stake.connect(alice).cancelPending(id))
        .to.emit(stake, "SessionCancelled")
        .withArgs(id, 1);
      expect((await stake.getSession(id)).status).to.equal(Status.Cancelled);
      expect(await stake.claimableOf(alice.address)).to.equal(ONE_ETH);
      expect(await fx.nft.balanceOf(alice.address)).to.equal(0);
    });

    it("reverts a too-early solo cancel (start phase judges startDeadline only)", async function () {
      const { stake, alice } = fx;
      const id = await createSolo(stake, alice);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.startDeadline) - 10);
      await expect(stake.connect(alice).cancelPending(id))
        .to.be.revertedWithCustomError(stake, "StartWindowOpen");
    });

    it("reverts cancelPending on a started solo session (AC-16c: failure path, no cancel)", async function () {
      const { stake, alice } = fx;
      const id = await createSolo(stake, alice);
      await stake.connect(alice).startSession(id);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.settlementDeadline) + 100);
      await expect(stake.connect(alice).cancelPending(id))
        .to.be.revertedWithCustomError(stake, "WrongStatus");
    });

    it("reverts cancelPending from a non-staker", async function () {
      const { stake, alice, bob } = fx;
      const id = await createSolo(stake, alice);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.startDeadline));
      await expect(stake.connect(bob).cancelPending(id))
        .to.be.revertedWithCustomError(stake, "NotStaker");
    });

    it("refunds a never-joined duel after joinDeadline (AC-18)", async function () {
      const { stake, alice, bob } = fx;
      const id = await createDuel(stake, alice, bob);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.joinDeadline));
      await expect(stake.connect(alice).cancelPending(id))
        .to.emit(stake, "SessionCancelled")
        .withArgs(id, 0);
      expect(await stake.claimableOf(alice.address)).to.equal(ONE_ETH);
    });

    it("a duel cannot be cancelled before joinDeadline even though startDeadline is 0 (R6 phase-matching)", async function () {
      const { stake, alice, bob } = fx;
      const id = await createDuel(stake, alice, bob);
      const s = await stake.getSession(id);
      expect(s.startDeadline).to.equal(0);
      await setNextBlockTime(Number(s.joinDeadline) - 10);
      await expect(stake.connect(alice).cancelPending(id))
        .to.be.revertedWithCustomError(stake, "JoinWindowOpen");
    });

    it("refunds a never-joined cofocus after joinDeadline (AC-04)", async function () {
      const { stake, alice } = fx;
      const id = await createCoFocus(stake, alice);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.joinDeadline));
      await expect(stake.connect(alice).cancelPending(id))
        .to.emit(stake, "SessionCancelled")
        .withArgs(id, 0);
      expect(await stake.claimableOf(alice.address)).to.equal(ONE_ETH);
    });

    it("an unjoined cofocus cannot be cancelled on its unset start field (R6)", async function () {
      const { stake, alice } = fx;
      const id = await createCoFocus(stake, alice);
      const s = await stake.getSession(id);
      expect(s.startDeadline).to.equal(0);
      await setNextBlockTime(Number(s.joinDeadline) - 10);
      await expect(stake.connect(alice).cancelPending(id))
        .to.be.revertedWithCustomError(stake, "JoinWindowOpen");
    });

    it("reverts cancelPending on supervised (never Pending)", async function () {
      const { stake, alice, bob } = fx;
      await stake.connect(alice).createSession(
        Mode.Supervised, bob.address, Payee.Charity, ethers.ZeroAddress, 0, 7, 1, 7, "", { value: ONE_ETH }
      );
      await expect(stake.connect(alice).cancelPending(1))
        .to.be.revertedWithCustomError(stake, "WrongStatus");
    });
  });

  describe("duel joinSession", function () {
    it("creates the mirror position, activates both on a shared window, and copies task params (R7)", async function () {
      const { stake, alice, bob, carol } = fx;
      const aId = await createDuel(stake, alice, bob, ONE_ETH, Payee.Custom, carol.address, true);
      const tx = await stake.connect(bob).joinSession(aId, Payee.Verifier, ethers.ZeroAddress, { value: ONE_ETH });
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const bId = aId + 1n;

      await expect(tx).to.emit(stake, "SessionJoined").withArgs(aId, bob.address, ONE_ETH, bId);
      await expect(tx).to.emit(stake, "SessionStarted");

      const a = await stake.getSession(aId);
      const b = await stake.getSession(bId);
      expect(a.status).to.equal(Status.Active);
      expect(b.status).to.equal(Status.Active);
      expect(a.startTime).to.equal(block.timestamp);
      expect(b.startTime).to.equal(block.timestamp);
      expect(a.endTime).to.equal(b.endTime);
      expect(a.settlementDeadline).to.equal(b.settlementDeadline);
      expect(a.linkedSessionId).to.equal(bId);
      expect(b.linkedSessionId).to.equal(aId);

      // B's mirror carries A's task params, B as staker, A as verifier (R7/F14).
      expect(b.staker).to.equal(bob.address);
      expect(b.partner).to.equal(alice.address);
      expect(b.verifier).to.equal(alice.address);
      expect(b.periodDays).to.equal(7);
      expect(b.targetCount).to.equal(7);
      expect(b.criterion).to.equal("gym every day");
      expect(b.stake).to.equal(ONE_ETH);
      expect(b.joined).to.equal(true);
      // B's own route recorded on B's position; A's route stays A's.
      expect(b.payee).to.equal(Payee.Verifier);
      expect(a.payee).to.equal(Payee.Custom);
      expect(a.customPayee).to.equal(carol.address);
      expect(await stake.sessionsOf(bob.address)).to.deep.equal([bId]);
      expect(await ethers.provider.getBalance(await stake.getAddress())).to.equal(2n * ONE_ETH);
    });

    it("reverts for anyone but the named opponent (F3)", async function () {
      const { stake, alice, bob, carol } = fx;
      const aId = await createDuel(stake, alice, bob);
      await expect(stake.connect(carol).joinSession(aId, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH }))
        .to.be.revertedWithCustomError(stake, "NotOpponent");
      await expect(stake.connect(alice).joinSession(aId, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH }))
        .to.be.revertedWithCustomError(stake, "NotOpponent");
    });

    it("reverts on unequal stake (F3)", async function () {
      const { stake, alice, bob } = fx;
      const aId = await createDuel(stake, alice, bob);
      await expect(
        stake.connect(bob).joinSession(aId, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH - 1n })
      ).to.be.revertedWithCustomError(stake, "StakeMismatch");
      await expect(
        stake.connect(bob).joinSession(aId, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH + 1n })
      ).to.be.revertedWithCustomError(stake, "StakeMismatch");
    });

    it("reverts a second join on an already-joined duel (joined flag)", async function () {
      const { stake, alice, bob } = fx;
      const aId = await createDuel(stake, alice, bob);
      await stake.connect(bob).joinSession(aId, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH });
      await expect(stake.connect(bob).joinSession(aId, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH }))
        .to.be.revertedWithCustomError(stake, "WrongStatus"); // A's position is Active now
    });

    it("reverts a join at/after joinDeadline", async function () {
      const { stake, alice, bob } = fx;
      const aId = await createDuel(stake, alice, bob);
      const s = await stake.getSession(aId);
      await setNextBlockTime(Number(s.joinDeadline));
      await expect(stake.connect(bob).joinSession(aId, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH }))
        .to.be.revertedWithCustomError(stake, "JoinDeadlinePassed");
    });

    it("rejects Payee.Custom with zero address on duel join (R6)", async function () {
      const { stake, alice, bob } = fx;
      const aId = await createDuel(stake, alice, bob);
      await expect(stake.connect(bob).joinSession(aId, Payee.Custom, ethers.ZeroAddress, { value: ONE_ETH }))
        .to.be.revertedWithCustomError(stake, "CustomPayeeZero");
    });

    it("reverts joinSession on solo and supervised sessions", async function () {
      const { stake, alice, bob } = fx;
      const soloId = await createSolo(stake, alice);
      await expect(stake.connect(bob).joinSession(soloId, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH }))
        .to.be.revertedWithCustomError(stake, "WrongMode");
      await stake.connect(alice).createSession(
        Mode.Supervised, bob.address, Payee.Charity, ethers.ZeroAddress, 0, 7, 1, 7, "", { value: ONE_ETH }
      );
      await expect(stake.connect(bob).joinSession(2, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH }))
        .to.be.revertedWithCustomError(stake, "WrongMode");
    });
  });

  describe("cofocus joinSession", function () {
    it("funds the partner, re-anchors startDeadline, and stays Pending", async function () {
      const { stake, alice, bob } = fx;
      const id = await createCoFocus(stake, alice);
      const tx = await stake.connect(bob).joinSession(id, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH });
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      await expect(tx).to.emit(stake, "SessionJoined").withArgs(id, bob.address, ONE_ETH, 0);
      const s = await stake.getSession(id);
      expect(s.status).to.equal(Status.Pending);
      expect(s.partner).to.equal(bob.address);
      expect(s.joined).to.equal(true);
      expect(s.startDeadline).to.equal(BigInt(block.timestamp) + BigInt(START_WINDOW));
      expect(await stake.sessionsOf(bob.address)).to.deep.equal([id]);
    });

    it("reverts when the creator joins their own cofocus session (R6)", async function () {
      const { stake, alice } = fx;
      const id = await createCoFocus(stake, alice);
      await expect(stake.connect(alice).joinSession(id, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH }))
        .to.be.revertedWithCustomError(stake, "SelfJoinNotAllowed");
    });

    it("reverts a double join via the joined flag (state is still Pending)", async function () {
      const { stake, alice, bob, carol } = fx;
      const id = await createCoFocus(stake, alice);
      await stake.connect(bob).joinSession(id, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH });
      await expect(stake.connect(carol).joinSession(id, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH }))
        .to.be.revertedWithCustomError(stake, "AlreadyJoined");
    });

    it("reverts a non-Charity payee on cofocus join", async function () {
      const { stake, alice, bob } = fx;
      const id = await createCoFocus(stake, alice);
      await expect(stake.connect(bob).joinSession(id, Payee.Verifier, ethers.ZeroAddress, { value: ONE_ETH }))
        .to.be.revertedWithCustomError(stake, "CoFocusPayeeNotCharity");
      await expect(stake.connect(bob).joinSession(id, Payee.Custom, bob.address, { value: ONE_ETH }))
        .to.be.revertedWithCustomError(stake, "CoFocusPayeeNotCharity");
    });

    it("reverts on unequal stake (F4)", async function () {
      const { stake, alice, bob } = fx;
      const id = await createCoFocus(stake, alice);
      await expect(stake.connect(bob).joinSession(id, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH - 1n }))
        .to.be.revertedWithCustomError(stake, "StakeMismatch");
    });
  });

  describe("cofocus start handshake (F1, AC-23)", function () {
    it("reverts startSession before the partner joins (joined gate)", async function () {
      const { stake, alice } = fx;
      const id = await createCoFocus(stake, alice);
      await expect(stake.connect(alice).startSession(id))
        .to.be.revertedWithCustomError(stake, "NotJoinedYet");
    });

    it("first confirm keeps Pending; second confirm anchors startTime to the second tx", async function () {
      const { stake, alice, bob } = fx;
      const id = await createCoFocus(stake, alice);
      await stake.connect(bob).joinSession(id, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH });

      await expect(stake.connect(alice).startSession(id))
        .to.emit(stake, "StartConfirmed")
        .withArgs(id, alice.address);
      expect((await stake.getSession(id)).status).to.equal(Status.Pending);

      const tx = await stake.connect(bob).startSession(id);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      await expect(tx).to.emit(stake, "StartConfirmed").withArgs(id, bob.address);
      await expect(tx)
        .to.emit(stake, "SessionStarted")
        .withArgs(id, block.timestamp, block.timestamp + 3600, block.timestamp + 3600 + GRACE_DURATION);
      const s = await stake.getSession(id);
      expect(s.status).to.equal(Status.Active);
      expect(s.startTime).to.equal(block.timestamp);
    });

    it("reverts a repeated confirm by the same participant", async function () {
      const { stake, alice, bob } = fx;
      const id = await createCoFocus(stake, alice);
      await stake.connect(bob).joinSession(id, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH });
      await stake.connect(alice).startSession(id);
      await expect(stake.connect(alice).startSession(id))
        .to.be.revertedWithCustomError(stake, "AlreadyConfirmed");
    });

    it("reverts a confirm from a non-participant", async function () {
      const { stake, alice, bob, carol } = fx;
      const id = await createCoFocus(stake, alice);
      await stake.connect(bob).joinSession(id, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH });
      await expect(stake.connect(carol).startSession(id))
        .to.be.revertedWithCustomError(stake, "NotParticipant");
    });

    it("only one confirmed by startDeadline: both principals refundable via cancelPending (AC-23)", async function () {
      const { stake, alice, bob } = fx;
      const id = await createCoFocus(stake, alice);
      await stake.connect(bob).joinSession(id, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH });
      await stake.connect(alice).startSession(id); // only A confirms
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.startDeadline));
      // second confirm now reverts (deadline passed) — session never Active
      await expect(stake.connect(bob).startSession(id))
        .to.be.revertedWithCustomError(stake, "StartDeadlinePassed");
      // either participant may trigger the joint refund
      await expect(stake.connect(bob).cancelPending(id))
        .to.emit(stake, "SessionCancelled")
        .withArgs(id, 1);
      expect(await stake.claimableOf(alice.address)).to.equal(ONE_ETH);
      expect(await stake.claimableOf(bob.address)).to.equal(ONE_ETH);
    });

    it("a joined cofocus cannot be cancelled before startDeadline", async function () {
      const { stake, alice, bob } = fx;
      const id = await createCoFocus(stake, alice);
      await stake.connect(bob).joinSession(id, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH });
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.startDeadline) - 10);
      await expect(stake.connect(alice).cancelPending(id))
        .to.be.revertedWithCustomError(stake, "StartWindowOpen");
    });

    it("joined-cofocus cancel reverts for a non-participant", async function () {
      const { stake, alice, bob, carol } = fx;
      const id = await createCoFocus(stake, alice);
      await stake.connect(bob).joinSession(id, Payee.Charity, ethers.ZeroAddress, { value: ONE_ETH });
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.startDeadline));
      await expect(stake.connect(carol).cancelPending(id))
        .to.be.revertedWithCustomError(stake, "NotParticipant");
    });
  });
});
