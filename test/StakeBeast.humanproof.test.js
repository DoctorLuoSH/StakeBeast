const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  Status, Payee, Tier, ONE_ETH,
  deployFixture, createSupervised, createDuel, setNextBlockTime,
} = require("./helpers");

describe("StakeBeast — human-proof settlement: supervised & duel (AC-03/06/07/10/13/15/19/20, R7/R9)", function () {
  let fx;
  beforeEach(async function () {
    fx = await deployFixture();
  });

  describe("supervised verify (AC-10, FR-07)", function () {
    it("verifier confirmation settles success: refund + mint, no check-in count evaluated", async function () {
      const { stake, nft, alice, bob } = fx;
      const id = await createSupervised(stake, alice, bob, 7);
      // zero check-ins — the verifier's confirm is the sole basis (v1.4 D4)
      await expect(stake.connect(bob).verify(id))
        .to.emit(stake, "SessionCompleted")
        .withArgs(id, [alice.address], [1]);
      const s = await stake.getSession(id);
      expect(s.status).to.equal(Status.Completed);
      expect(s.minted).to.equal(true);
      expect(await stake.claimableOf(alice.address)).to.equal(ONE_ETH);
      const meta = await nft.beastMeta(1);
      expect(meta.kind).to.equal(1); // habit
      expect(meta.metricValue).to.equal(7);
      expect(meta.tier).to.equal(Tier.Adult);
    });

    it("reverts verify from a non-verifier", async function () {
      const { stake, alice, bob, carol } = fx;
      const id = await createSupervised(stake, alice, bob);
      await expect(stake.connect(carol).verify(id))
        .to.be.revertedWithCustomError(stake, "NotVerifier");
      await expect(stake.connect(alice).verify(id))
        .to.be.revertedWithCustomError(stake, "NotVerifier");
    });

    it("mints the habit tier by declared period (2/3/7/21 d boundaries, AC-17)", async function () {
      const { stake, nft, alice, bob, carol, dave, attester } = fx;
      const cases = [
        [alice, 2, Tier.Sprout],
        [bob, 3, Tier.Juvenile],
        [carol, 7, Tier.Adult],
        [dave, 21, Tier.Golden],
      ];
      let tokenId = 1;
      for (const [who, period, tier] of cases) {
        const id = await createSupervised(stake, who, attester, period); // attester plays verifier here
        await stake.connect(attester).verify(id);
        expect((await nft.beastMeta(tokenId)).tier).to.equal(tier);
        tokenId += 1;
      }
    });

    it("habit verify succeeds even when the staker is a hook-reverting contract (R9)", async function () {
      const { stake, nft, bob } = fx;
      const Probes = await ethers.getContractFactory("HookRevertingReceiver");
      const probe = await Probes.deploy();
      await probe.waitForDeployment();
      const stakeAddr = await stake.getAddress();
      const data = stake.interface.encodeFunctionData("createSession", [
        1, bob.address, Payee.Charity, ethers.ZeroAddress, 0, 7, 1, 7, "",
      ]);
      await probe.drive(stakeAddr, data, { value: ONE_ETH });
      const id = (await stake.nextSessionId()) - 1n;
      await stake.connect(bob).verify(id);
      expect((await stake.getSession(id)).status).to.equal(Status.Completed);
      expect(await nft.ownerOf(1)).to.equal(await probe.getAddress());
    });
  });

  describe("admitDefeat routes (AC-06)", function () {
    it("pays the preset Charity route", async function () {
      const { stake, charity, alice, bob } = fx;
      const id = await createSupervised(stake, alice, bob, 7, ONE_ETH, Payee.Charity);
      await expect(stake.connect(alice).admitDefeat(id))
        .to.emit(stake, "SessionForfeited")
        .withArgs(id, 0);
      expect((await stake.getSession(id)).status).to.equal(Status.Forfeited);
      expect(await stake.claimableOf(charity.address)).to.equal(ONE_ETH);
      expect(await fx.nft.balanceOf(alice.address)).to.equal(0);
    });

    it("pays the preset Verifier route (confession pays the supervisor)", async function () {
      const { stake, alice, bob } = fx;
      const id = await createSupervised(stake, alice, bob, 7, ONE_ETH, Payee.Verifier);
      await stake.connect(alice).admitDefeat(id);
      expect(await stake.claimableOf(bob.address)).to.equal(ONE_ETH);
    });

    it("pays the preset Custom route (friend wallet)", async function () {
      const { stake, alice, bob, carol } = fx;
      const id = await createSupervised(stake, alice, bob, 7, ONE_ETH, Payee.Custom, carol.address);
      await stake.connect(alice).admitDefeat(id);
      expect(await stake.claimableOf(carol.address)).to.equal(ONE_ETH);
    });

    it("reverts from a non-staker and on a Pending session (F6/E15)", async function () {
      const { stake, alice, bob } = fx;
      const id = await createSupervised(stake, alice, bob);
      await expect(stake.connect(bob).admitDefeat(id))
        .to.be.revertedWithCustomError(stake, "NotStaker");

      // solo session still Pending
      await stake.connect(alice).createSession(
        0, ethers.ZeroAddress, Payee.Charity, ethers.ZeroAddress, 60, 0, 0, 0, "", { value: ONE_ETH }
      );
      await expect(stake.connect(alice).admitDefeat(2))
        .to.be.revertedWithCustomError(stake, "WrongStatus");
    });
  });

  describe("deadline behavior (AC-03, AC-13, FR-08)", function () {
    it("forfeit reverts before settlementDeadline and succeeds at it, permissionlessly", async function () {
      const { stake, charity, alice, bob, carol } = fx;
      const id = await createSupervised(stake, alice, bob);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.settlementDeadline) - 1);
      await expect(stake.connect(carol).forfeit(id))
        .to.be.revertedWithCustomError(stake, "NotYetForfeitable");
      await setNextBlockTime(Number(s.settlementDeadline));
      await expect(stake.connect(carol).forfeit(id)) // anyone may trigger
        .to.emit(stake, "SessionForfeited")
        .withArgs(id, 1);
      expect(await stake.claimableOf(charity.address)).to.equal(ONE_ETH);
    });

    it("after settlementDeadline verify / settle / admitDefeat all revert (AC-13)", async function () {
      const { stake, alice, bob } = fx;
      const id = await createSupervised(stake, alice, bob);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.settlementDeadline));
      await expect(stake.connect(bob).verify(id))
        .to.be.revertedWithCustomError(stake, "OutsideSettlementWindow");
      await expect(stake.connect(alice).admitDefeat(id))
        .to.be.revertedWithCustomError(stake, "OutsideSettlementWindow");
      await expect(stake.connect(alice).settle(id, "0x"))
        .to.be.revertedWithCustomError(stake, "WrongMode"); // settle is machine-proof only
      // forfeit and voidSession remain
      await expect(stake.connect(alice).forfeit(id)).to.emit(stake, "SessionForfeited");
    });

    it("supervisor refusal routes the stake to charity at the deadline (supervisor gains nothing)", async function () {
      const { stake, charity, alice, bob } = fx;
      const id = await createSupervised(stake, alice, bob, 7, ONE_ETH, Payee.Verifier);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.settlementDeadline));
      await stake.connect(bob).forfeit(id);
      expect(await stake.claimableOf(charity.address)).to.equal(ONE_ETH);
      expect(await stake.claimableOf(bob.address)).to.equal(0);
    });
  });

  describe("duel settlement matrix (AC-15/19/20, R7, R9)", function () {
    async function joinedDuel(fx, aPayee = Payee.Charity, aCustom = ethers.ZeroAddress, bPayee = Payee.Charity, bCustom = ethers.ZeroAddress) {
      const { stake, alice, bob } = fx;
      const aId = await createDuel(stake, alice, bob, ONE_ETH, aPayee, aCustom);
      await stake.connect(bob).joinSession(aId, bPayee, bCustom, { value: ONE_ETH });
      return { aId, bId: aId + 1n };
    }

    it("win/win: cross-verification completes both positions, both minted", async function () {
      const { stake, nft, alice, bob } = fx;
      const { aId, bId } = await joinedDuel(fx);
      await stake.connect(bob).verify(aId); // B verifies A's position
      await stake.connect(alice).verify(bId); // A verifies B's position
      expect((await stake.getSession(aId)).status).to.equal(Status.Completed);
      expect((await stake.getSession(bId)).status).to.equal(Status.Completed);
      expect(await stake.claimableOf(alice.address)).to.equal(ONE_ETH);
      expect(await stake.claimableOf(bob.address)).to.equal(ONE_ETH);
      expect(await nft.balanceOf(alice.address)).to.equal(1);
      expect(await nft.balanceOf(bob.address)).to.equal(1);
    });

    it("win/lose (AC-15): one confirms, the other side forfeits to charity at the deadline", async function () {
      const { stake, charity, alice, bob } = fx;
      const { aId, bId } = await joinedDuel(fx);
      await stake.connect(bob).verify(aId); // A succeeds
      const b = await stake.getSession(bId);
      await setNextBlockTime(Number(b.settlementDeadline));
      await stake.connect(alice).forfeit(bId); // B's side refused -> charity
      expect(await stake.claimableOf(alice.address)).to.equal(ONE_ETH);
      expect(await stake.claimableOf(charity.address)).to.equal(ONE_ETH);
      expect(await stake.claimableOf(bob.address)).to.equal(0);
    });

    it("lose/lose (AC-19): both unconfirmed past the deadline, both stakes to charity", async function () {
      const { stake, charity } = fx;
      const { aId, bId } = await joinedDuel(fx);
      const a = await stake.getSession(aId);
      await setNextBlockTime(Number(a.settlementDeadline));
      await stake.forfeit(aId);
      await stake.forfeit(bId);
      expect(await stake.claimableOf(charity.address)).to.equal(2n * ONE_ETH);
    });

    it("both admit defeat (AC-20): each pays their own preset route", async function () {
      const { stake, charity, alice, bob, carol } = fx;
      // A: Verifier route (pays B); B: Custom route (pays carol)
      const { aId, bId } = await joinedDuel(fx, Payee.Verifier, ethers.ZeroAddress, Payee.Custom, carol.address);
      await stake.connect(alice).admitDefeat(aId);
      await stake.connect(bob).admitDefeat(bId);
      expect(await stake.claimableOf(bob.address)).to.equal(ONE_ETH); // A's stake -> B
      expect(await stake.claimableOf(carol.address)).to.equal(ONE_ETH); // B's stake -> carol
      expect(await stake.claimableOf(charity.address)).to.equal(0);
    });

    it("B's admitDefeat pays B's own route, never A's (R7)", async function () {
      const { stake, charity, alice, bob, carol, dave } = fx;
      // A: Custom -> dave; B: Charity
      const { bId } = await joinedDuel(fx, Payee.Custom, dave.address, Payee.Charity, ethers.ZeroAddress);
      await stake.connect(bob).admitDefeat(bId);
      expect(await stake.claimableOf(charity.address)).to.equal(ONE_ETH);
      expect(await stake.claimableOf(dave.address)).to.equal(0);
      expect(await stake.claimableOf(alice.address)).to.equal(0);
      expect(await stake.claimableOf(carol.address)).to.equal(0);
    });

    it("duel verify independence (R9): verifier's own terminal position never gates the target", async function () {
      const { stake, alice, bob } = fx;
      const { aId, bId } = await joinedDuel(fx);
      // B forfeits their own position first
      await stake.connect(bob).admitDefeat(bId);
      expect((await stake.getSession(bId)).status).to.equal(Status.Forfeited);
      // B can still verify A's position
      await expect(stake.connect(bob).verify(aId)).to.emit(stake, "SessionCompleted");
      expect((await stake.getSession(aId)).status).to.equal(Status.Completed);
    });

    it("terminal positions reject further operations (AC-07)", async function () {
      const { stake, alice, bob } = fx;
      const { aId, bId } = await joinedDuel(fx);
      await stake.connect(alice).admitDefeat(aId);
      await expect(stake.connect(bob).verify(aId))
        .to.be.revertedWithCustomError(stake, "WrongStatus");
      await expect(stake.connect(alice).admitDefeat(aId))
        .to.be.revertedWithCustomError(stake, "WrongStatus");
      // forfeit on a terminal position reverts at the status check at any time
      await expect(stake.forfeit(aId)).to.be.revertedWithCustomError(stake, "WrongStatus");
      // the linked position is unaffected and settles independently
      await expect(stake.connect(alice).verify(bId)).to.emit(stake, "SessionCompleted");
      await expect(stake.connect(alice).admitDefeat(bId))
        .to.be.revertedWithCustomError(stake, "WrongStatus");
    });

    it("verify on a solo / cofocus session reverts (mode gate)", async function () {
      const { stake, alice } = fx;
      await stake.connect(alice).createSession(
        0, ethers.ZeroAddress, Payee.Charity, ethers.ZeroAddress, 60, 0, 0, 0, "", { value: ONE_ETH }
      );
      await expect(stake.connect(alice).verify(1))
        .to.be.revertedWithCustomError(stake, "WrongMode");
    });
  });
});
