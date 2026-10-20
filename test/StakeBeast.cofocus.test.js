const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  Status, Payee, ONE_ETH,
  deployFixture, createCoFocus, signForSession, setNextBlockTime,
} = require("./helpers");

describe("StakeBeast — cofocus joint liability (AC-05, E9, section 6.4/7.2)", function () {
  let fx;
  beforeEach(async function () {
    fx = await deployFixture();
  });

  async function activeCoFocus(stake, a, b, value = ONE_ETH) {
    const id = await createCoFocus(stake, a, 60, value);
    await stake.connect(b).joinSession(id, Payee.Charity, ethers.ZeroAddress, { value });
    await stake.connect(a).startSession(id);
    await stake.connect(b).startSession(id);
    return id;
  }

  it("either party's admitDefeat forfeits BOTH stakes to charity immediately (joint)", async function () {
    const { stake, charity, alice, bob } = fx;
    const id = await activeCoFocus(stake, alice, bob);
    await expect(stake.connect(bob).admitDefeat(id)) // the partner concedes
      .to.emit(stake, "SessionForfeited")
      .withArgs(id, 2);
    expect((await stake.getSession(id)).status).to.equal(Status.Forfeited);
    expect(await stake.claimableOf(charity.address)).to.equal(2n * ONE_ETH);
    expect(await stake.claimableOf(alice.address)).to.equal(0);
    expect(await stake.claimableOf(bob.address)).to.equal(0);
  });

  it("admitDefeat reverts for a non-participant", async function () {
    const { stake, alice, bob, carol } = fx;
    const id = await activeCoFocus(stake, alice, bob);
    await expect(stake.connect(carol).admitDefeat(id))
      .to.be.revertedWithCustomError(stake, "NotParticipant");
  });

  it("attester refusal => after the deadline forfeit sends BOTH stakes to charity (AC-05)", async function () {
    const { stake, charity, alice, bob, carol } = fx;
    const id = await activeCoFocus(stake, alice, bob);
    const s = await stake.getSession(id);
    await setNextBlockTime(Number(s.settlementDeadline));
    await expect(stake.connect(carol).forfeit(id)) // permissionless
      .to.emit(stake, "SessionForfeited")
      .withArgs(id, 1);
    expect(await stake.claimableOf(charity.address)).to.equal(2n * ONE_ETH);
    expect(await fx.nft.balanceOf(alice.address)).to.equal(0);
    expect(await fx.nft.balanceOf(bob.address)).to.equal(0);
  });

  it("no single-participant success path: settle without a dual attestation reverts, then joint forfeit applies", async function () {
    const { stake, attester, charity, alice, bob } = fx;
    const id = await activeCoFocus(stake, alice, bob);
    const s = await stake.getSession(id);
    await setNextBlockTime(Number(s.endTime));
    // attestation naming only the creator (partner zeroed)
    const sig = await signForSession(attester, stake, id, { partner: ethers.ZeroAddress });
    await expect(stake.connect(alice).settle(id, sig))
      .to.be.revertedWithCustomError(stake, "InvalidAttestation");
    await setNextBlockTime(Number(s.settlementDeadline));
    await stake.forfeit(id);
    expect(await stake.claimableOf(charity.address)).to.equal(2n * ONE_ETH);
  });

  it("admin void refunds both principals, no mint (platform fault)", async function () {
    const { stake, owner, alice, bob } = fx;
    const id = await activeCoFocus(stake, alice, bob);
    await expect(stake.connect(owner).voidSession(id))
      .to.emit(stake, "SessionVoided")
      .withArgs(id, owner.address);
    expect((await stake.getSession(id)).status).to.equal(Status.Voided);
    expect(await stake.claimableOf(alice.address)).to.equal(ONE_ETH);
    expect(await stake.claimableOf(bob.address)).to.equal(ONE_ETH);
    expect(await fx.nft.balanceOf(alice.address)).to.equal(0);
    expect(await fx.nft.balanceOf(bob.address)).to.equal(0);
  });
});
