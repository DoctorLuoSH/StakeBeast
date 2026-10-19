const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  Mode, Status, Payee, Tier, ONE_ETH,
  deployFixture, createSolo, createCoFocus, signForSession, setNextBlockTime,
} = require("./helpers");

describe("StakeBeast — machine-proof settlement (AC-01/02/07/24/25, R2, R9)", function () {
  let fx;
  beforeEach(async function () {
    fx = await deployFixture();
  });

  async function startedSolo(stake, staker, durationMinutes = 60, value = ONE_ETH) {
    const id = await createSolo(stake, staker, durationMinutes, value);
    await stake.connect(staker).startSession(id);
    return id;
  }

  async function startedCoFocus(stake, a, b, durationMinutes = 60, value = ONE_ETH) {
    const id = await createCoFocus(stake, a, durationMinutes, value);
    await stake.connect(b).joinSession(id, Payee.Charity, ethers.ZeroAddress, { value });
    await stake.connect(a).startSession(id);
    await stake.connect(b).startSession(id);
    return id;
  }

  describe("happy path (AC-01, FR-03)", function () {
    it("settles a qualified solo session exactly once: balance + mint + event", async function () {
      const { stake, nft, attester, alice } = fx;
      const id = await startedSolo(stake, alice, 60);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.endTime));
      const sig = await signForSession(attester, stake, id);
      await expect(stake.connect(alice).settle(id, sig))
        .to.emit(stake, "SessionCompleted")
        .withArgs(id, [alice.address], [1]);
      const after = await stake.getSession(id);
      expect(after.status).to.equal(Status.Completed);
      expect(after.minted).to.equal(true);
      expect(await stake.claimableOf(alice.address)).to.equal(ONE_ETH);
      expect(await nft.ownerOf(1)).to.equal(alice.address);
      const meta = await nft.beastMeta(1);
      expect(meta.kind).to.equal(0); // focus
      expect(meta.metricValue).to.equal(60);
      expect(meta.tier).to.equal(Tier.Adult);
      expect(meta.sessionId).to.equal(id);
    });

    it("mints the declared-duration tier (24/25/50/120 min, AC-17 machine side)", async function () {
      const { stake, nft, attester, alice, bob, carol, dave } = fx;
      const cases = [
        [alice, 24, Tier.Sprout],
        [bob, 25, Tier.Juvenile],
        [carol, 50, Tier.Adult],
        [dave, 120, Tier.Golden],
      ];
      let tokenId = 1;
      for (const [who, minutes, tier] of cases) {
        const id = await startedSolo(stake, who, minutes);
        const s = await stake.getSession(id);
        await setNextBlockTime(Number(s.endTime));
        const sig = await signForSession(attester, stake, id);
        await stake.connect(who).settle(id, sig);
        expect((await nft.beastMeta(tokenId)).tier).to.equal(tier);
        tokenId += 1;
      }
    });

    it("credits both cofocus participants and mints one beast each", async function () {
      const { stake, nft, attester, alice, bob } = fx;
      const id = await startedCoFocus(stake, alice, bob);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.endTime));
      const sig = await signForSession(attester, stake, id);
      await expect(stake.connect(bob).settle(id, sig)) // either participant may settle
        .to.emit(stake, "SessionCompleted")
        .withArgs(id, [alice.address, bob.address], [1, 2]);
      expect(await stake.claimableOf(alice.address)).to.equal(ONE_ETH);
      expect(await stake.claimableOf(bob.address)).to.equal(ONE_ETH);
      expect(await nft.ownerOf(1)).to.equal(alice.address);
      expect(await nft.ownerOf(2)).to.equal(bob.address);
    });
  });

  describe("window guards (AC-25, FR-08)", function () {
    it("reverts before endTime, succeeds at endTime", async function () {
      const { stake, attester, alice } = fx;
      const id = await startedSolo(stake, alice);
      const s = await stake.getSession(id);
      const sig = await signForSession(attester, stake, id);
      await setNextBlockTime(Number(s.endTime) - 1);
      await expect(stake.connect(alice).settle(id, sig))
        .to.be.revertedWithCustomError(stake, "OutsideSettlementWindow");
      await setNextBlockTime(Number(s.endTime));
      await expect(stake.connect(alice).settle(id, sig)).to.emit(stake, "SessionCompleted");
    });

    it("succeeds at settlementDeadline - 1, reverts at settlementDeadline", async function () {
      const { stake, attester, alice, bob } = fx;
      // boundary - 1
      let id = await startedSolo(stake, alice);
      let s = await stake.getSession(id);
      let sig = await signForSession(attester, stake, id);
      await setNextBlockTime(Number(s.settlementDeadline) - 1);
      await expect(stake.connect(alice).settle(id, sig)).to.emit(stake, "SessionCompleted");

      // exact boundary
      id = await startedSolo(stake, bob);
      s = await stake.getSession(id);
      sig = await signForSession(attester, stake, id);
      await setNextBlockTime(Number(s.settlementDeadline));
      await expect(stake.connect(bob).settle(id, sig))
        .to.be.revertedWithCustomError(stake, "OutsideSettlementWindow");
    });

    it("reverts settle from a non-participant", async function () {
      const { stake, attester, alice, carol } = fx;
      const id = await startedSolo(stake, alice);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.endTime));
      const sig = await signForSession(attester, stake, id);
      await expect(stake.connect(carol).settle(id, sig))
        .to.be.revertedWithCustomError(stake, "NotParticipant");
    });

    it("reverts settle on supervised / duel positions (mode gate)", async function () {
      const { stake, alice, bob } = fx;
      await stake.connect(alice).createSession(
        Mode.Supervised, bob.address, Payee.Charity, ethers.ZeroAddress, 0, 7, 1, 7, "", { value: ONE_ETH }
      );
      await expect(stake.connect(alice).settle(1, "0x"))
        .to.be.revertedWithCustomError(stake, "WrongMode");
    });
  });

  describe("forged / replayed / wrong-field attestations (AC-02, FR-04)", function () {
    it("reverts a signature from a non-attester key", async function () {
      const { stake, attester, alice, bob } = fx;
      const id = await startedSolo(stake, alice);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.endTime));
      const sig = await signForSession(bob, stake, id); // wrong signer
      await expect(stake.connect(alice).settle(id, sig))
        .to.be.revertedWithCustomError(stake, "InvalidAttestation");
    });

    it("reverts a signature naming a different session (wrong-session replay)", async function () {
      const { stake, attester, alice, bob } = fx;
      await startedSolo(stake, alice); // idA — the session the signature is submitted against
      const idB = await startedSolo(stake, bob);
      const sB = await stake.getSession(idB);
      await setNextBlockTime(Number(sB.endTime));
      // attester-signed for idA but replayed against idB: digest mismatch
      const sig = await signForSession(attester, stake, idB, { sessionId: 1n });
      await expect(stake.connect(bob).settle(idB, sig))
        .to.be.revertedWithCustomError(stake, "InvalidAttestation");
    });

    it("reverts a signature over a wrong-chain domain", async function () {
      const { stake, attester, alice } = fx;
      const id = await startedSolo(stake, alice);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.endTime));
      const network = await ethers.provider.getNetwork();
      const sig = await signForSession(attester, stake, id, { chainId: network.chainId + 1n });
      await expect(stake.connect(alice).settle(id, sig))
        .to.be.revertedWithCustomError(stake, "InvalidAttestation");
    });

    it("reverts a signature over a different contract address domain", async function () {
      const { stake, attester, alice } = fx;
      const id = await startedSolo(stake, alice);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.endTime));
      const sig = await signForSession(attester, stake, id, { verifyingContract: alice.address });
      await expect(stake.connect(alice).settle(id, sig))
        .to.be.revertedWithCustomError(stake, "InvalidAttestation");
    });

    it("reverts mismatched startTime / endTime / expiry fields", async function () {
      const { stake, attester, alice } = fx;
      const id = await startedSolo(stake, alice);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.endTime));
      for (const overrides of [
        { startTime: BigInt(s.startTime) + 1n },
        { endTime: BigInt(s.endTime) + 1n },
        { expiry: BigInt(s.settlementDeadline) + 1n },
      ]) {
        const sig = await signForSession(attester, stake, id, overrides);
        await expect(stake.connect(alice).settle(id, sig))
          .to.be.revertedWithCustomError(stake, "InvalidAttestation");
      }
    });

    it("reverts a replayed signature after success (AC-07 terminal mutex)", async function () {
      const { stake, attester, alice } = fx;
      const id = await startedSolo(stake, alice);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.endTime));
      const sig = await signForSession(attester, stake, id);
      await stake.connect(alice).settle(id, sig);
      await expect(stake.connect(alice).settle(id, sig))
        .to.be.revertedWithCustomError(stake, "WrongStatus");
    });

    it("reverts garbage-length signatures (OZ ECDSA guard)", async function () {
      const { stake, alice } = fx;
      const id = await startedSolo(stake, alice);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.endTime));
      await expect(stake.connect(alice).settle(id, "0x1234")).to.be.reverted;
    });
  });

  describe("cofocus attestation coverage (AC-24)", function () {
    it("reverts single-participant, mismatched-partner and partial-window attestations", async function () {
      const { stake, attester, alice, bob, carol } = fx;
      const id = await startedCoFocus(stake, alice, bob);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.endTime));
      // covers only one participant (partner zeroed)
      let sig = await signForSession(attester, stake, id, { partner: ethers.ZeroAddress });
      await expect(stake.connect(alice).settle(id, sig))
        .to.be.revertedWithCustomError(stake, "InvalidAttestation");
      // wrong partner
      sig = await signForSession(attester, stake, id, { partner: carol.address });
      await expect(stake.connect(alice).settle(id, sig))
        .to.be.revertedWithCustomError(stake, "InvalidAttestation");
      // swapped pair (partner in the staker slot)
      sig = await signForSession(attester, stake, id, { staker: bob.address, partner: alice.address });
      await expect(stake.connect(alice).settle(id, sig))
        .to.be.revertedWithCustomError(stake, "InvalidAttestation");
      // partial window (endTime short by a second)
      sig = await signForSession(attester, stake, id, { endTime: BigInt(s.endTime) - 1n });
      await expect(stake.connect(alice).settle(id, sig))
        .to.be.revertedWithCustomError(stake, "InvalidAttestation");
      // the honest attestation still settles afterwards
      sig = await signForSession(attester, stake, id);
      await expect(stake.connect(alice).settle(id, sig)).to.emit(stake, "SessionCompleted");
    });
  });

  describe("key rotation (R2)", function () {
    it("invalidates old-key signatures immediately; a re-signed session settles", async function () {
      const { stake, owner, attester, alice, dave } = fx;
      const id = await startedSolo(stake, alice);
      const s = await stake.getSession(id);
      await setNextBlockTime(Number(s.endTime));
      const oldSig = await signForSession(attester, stake, id);

      await stake.connect(owner).setAttester(dave.address);
      await expect(stake.connect(alice).settle(id, oldSig))
        .to.be.revertedWithCustomError(stake, "InvalidAttestation");

      const newSig = await signForSession(dave, stake, id);
      await expect(stake.connect(alice).settle(id, newSig)).to.emit(stake, "SessionCompleted");
    });
  });

  describe("mint path (R9)", function () {
    it("settles even when the beneficiary contract reverts on any receiver hook", async function () {
      const { stake, nft, attester } = fx;
      const Probes = await ethers.getContractFactory("HookRevertingReceiver");
      const probe = await Probes.deploy();
      await probe.waitForDeployment();
      const probeAddr = await probe.getAddress();
      const stakeAddr = await stake.getAddress();

      const createData = stake.interface.encodeFunctionData("createSession", [
        Mode.SoloFocus, ethers.ZeroAddress, Payee.Charity, ethers.ZeroAddress, 60, 0, 0, 0, "",
      ]);
      await probe.drive(stakeAddr, createData, { value: ONE_ETH });
      const id = await stake.nextSessionId() - 1n;

      await probe.drive(stakeAddr, stake.interface.encodeFunctionData("startSession", [id]));
      const s = await stake.getSession(id);
      expect(s.staker).to.equal(probeAddr);
      await setNextBlockTime(Number(s.endTime));

      const sig = await signForSession(attester, stake, id);
      await probe.drive(stakeAddr, stake.interface.encodeFunctionData("settle", [id, sig]));
      expect((await stake.getSession(id)).status).to.equal(Status.Completed);
      expect(await stake.claimableOf(probeAddr)).to.equal(ONE_ETH);
      expect(await nft.ownerOf(1)).to.equal(probeAddr);
    });
  });

  describe("settle vs forfeit race (E3)", function () {
    it("first terminal finalization wins", async function () {
      const { stake, attester, alice } = fx;
      const id = await startedSolo(stake, alice);
      const s = await stake.getSession(id);
      const sig = await signForSession(attester, stake, id);
      // settle lands first inside the window
      await setNextBlockTime(Number(s.settlementDeadline) - 1);
      await stake.connect(alice).settle(id, sig);
      // a later forfeit attempt reverts
      await setNextBlockTime(Number(s.settlementDeadline));
      await expect(stake.connect(alice).forfeit(id))
        .to.be.revertedWithCustomError(stake, "WrongStatus");
    });

    it("solo violation (attester refuses): after the deadline forfeit credits charity", async function () {
      const { stake, charity, alice, carol } = fx;
      const id = await startedSolo(stake, alice);
      const s = await stake.getSession(id);
      // no attestation is ever produced; the session lapses past the deadline
      await setNextBlockTime(Number(s.settlementDeadline));
      await expect(stake.connect(carol).forfeit(id))
        .to.emit(stake, "SessionForfeited")
        .withArgs(id, 1);
      expect((await stake.getSession(id)).status).to.equal(Status.Forfeited);
      expect(await stake.claimableOf(charity.address)).to.equal(ONE_ETH);
      expect(await stake.claimableOf(alice.address)).to.equal(0);
      expect(await fx.nft.balanceOf(alice.address)).to.equal(0);
    });
  });
});
