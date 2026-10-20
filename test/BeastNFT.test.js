const { expect } = require("chai");
const { ethers } = require("hardhat");

const FOCUS = 0;
const HABIT = 1;
const [SPROUT, JUVENILE, ADULT, GOLDEN] = [0, 1, 2, 3];

describe("BeastNFT", function () {
  let owner, minter, alice, bob, nft;

  beforeEach(async function () {
    [owner, minter, alice, bob] = await ethers.getSigners();
    const BeastNFT = await ethers.getContractFactory("BeastNFT");
    nft = await BeastNFT.deploy(owner.address, minter.address);
    await nft.waitForDeployment();
  });

  async function mintTo(staker, sessionId, beastType, value) {
    return nft.connect(minter).mint(staker.address, sessionId, beastType, value);
  }

  describe("deployment", function () {
    it("sets name, symbol, owner and minter", async function () {
      expect(await nft.name()).to.equal("StakeBeast");
      expect(await nft.symbol()).to.equal("BEAST");
      expect(await nft.owner()).to.equal(owner.address);
      expect(await nft.minter()).to.equal(minter.address);
    });

    it("denies minting when minter is not set", async function () {
      const BeastNFT = await ethers.getContractFactory("BeastNFT");
      const fresh = await BeastNFT.deploy(owner.address, ethers.ZeroAddress);
      await fresh.waitForDeployment();
      await expect(
        fresh.connect(minter).mint(alice.address, 1, FOCUS, 60)
      ).to.be.revertedWithCustomError(fresh, "NotMinter");
    });
  });

  describe("minter management", function () {
    it("lets the owner rotate the minter", async function () {
      await expect(nft.connect(owner).setMinter(alice.address))
        .to.emit(nft, "MinterUpdated")
        .withArgs(minter.address, alice.address);
      expect(await nft.minter()).to.equal(alice.address);
      await expect(mintTo(bob, 1, FOCUS, 60)).to.be.revertedWithCustomError(nft, "NotMinter");
      await expect(nft.connect(alice).mint(bob.address, 1, FOCUS, 60)).to.emit(nft, "BeastMinted");
    });

    it("rejects setMinter from non-owner", async function () {
      await expect(nft.connect(alice).setMinter(alice.address))
        .to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });
  });

  describe("mint permission", function () {
    it("mints to a contract whose receiver hook always reverts (R9: _mint, no callback)", async function () {
      const Probes = await ethers.getContractFactory("HookRevertingReceiver");
      const probe = await Probes.deploy();
      await probe.waitForDeployment();
      // Would revert with _safeMint; succeeds because mint uses _mint.
      await expect(mintTo({ address: await probe.getAddress() }, 1, FOCUS, 60)).to.emit(nft, "BeastMinted");
      expect(await nft.balanceOf(await probe.getAddress())).to.equal(1);
    });

    it("reverts for any caller other than the minter", async function () {
      for (const caller of [owner, alice, bob]) {
        await expect(
          nft.connect(caller).mint(alice.address, 1, FOCUS, 60)
        ).to.be.revertedWithCustomError(nft, "NotMinter").withArgs(caller.address);
      }
    });

    it("mints token id 1 first and emits BeastMinted", async function () {
      await expect(mintTo(alice, 7, FOCUS, 60))
        .to.emit(nft, "BeastMinted")
        .withArgs(1, alice.address, 7, FOCUS, 60, ADULT);
      expect(await nft.ownerOf(1)).to.equal(alice.address);
      expect(await nft.balanceOf(alice.address)).to.equal(1);
    });
  });

  describe("tier ladder (baseline 4.8 / AC-17)", function () {
    it("computes focus tiers at the exact AC-17 boundaries", async function () {
      expect(await nft.tierOf(FOCUS, 24)).to.equal(SPROUT);
      expect(await nft.tierOf(FOCUS, 25)).to.equal(JUVENILE);
      expect(await nft.tierOf(FOCUS, 50)).to.equal(ADULT);
      expect(await nft.tierOf(FOCUS, 120)).to.equal(GOLDEN);
    });

    it("computes habit tiers at the exact AC-17 boundaries", async function () {
      expect(await nft.tierOf(HABIT, 2)).to.equal(SPROUT);
      expect(await nft.tierOf(HABIT, 3)).to.equal(JUVENILE);
      expect(await nft.tierOf(HABIT, 7)).to.equal(ADULT);
      expect(await nft.tierOf(HABIT, 21)).to.equal(GOLDEN);
    });

    it("floors values sitting just below each threshold", async function () {
      expect(await nft.tierOf(FOCUS, 0)).to.equal(SPROUT);
      expect(await nft.tierOf(FOCUS, 49)).to.equal(JUVENILE);
      expect(await nft.tierOf(FOCUS, 119)).to.equal(ADULT);
      expect(await nft.tierOf(HABIT, 0)).to.equal(SPROUT);
      expect(await nft.tierOf(HABIT, 6)).to.equal(JUVENILE);
      expect(await nft.tierOf(HABIT, 20)).to.equal(ADULT);
    });

    it("stamps the computed tier and metadata onto the token", async function () {
      const tx = await mintTo(alice, 3, FOCUS, 120);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const meta = await nft.beastMeta(1);
      expect(meta.kind).to.equal(FOCUS);
      expect(meta.tier).to.equal(GOLDEN);
      expect(meta.metricValue).to.equal(120);
      expect(meta.completionDate).to.equal(block.timestamp);
      expect(meta.sessionId).to.equal(3);
    });
  });

  describe("one beast per stake position per session (D8)", function () {
    it("reverts a repeat mint for the same session and staker", async function () {
      await mintTo(alice, 5, FOCUS, 60);
      await expect(mintTo(alice, 5, HABIT, 21))
        .to.be.revertedWithCustomError(nft, "AlreadyMinted")
        .withArgs(5, alice.address);
    });

    it("allows the other stake position of the same session to mint (dual modes)", async function () {
      await mintTo(alice, 5, FOCUS, 60);
      await expect(mintTo(bob, 5, FOCUS, 60)).to.emit(nft, "BeastMinted");
    });

    it("allows the same staker to mint in a different session", async function () {
      await mintTo(alice, 5, FOCUS, 60);
      await expect(mintTo(alice, 6, HABIT, 21)).to.emit(nft, "BeastMinted");
      expect(await nft.balanceOf(alice.address)).to.equal(2);
    });
  });

  describe("soulbound: transfers always revert", function () {
    beforeEach(async function () {
      await mintTo(alice, 1, FOCUS, 60);
    });

    it("reverts transferFrom", async function () {
      await expect(
        nft.connect(alice).transferFrom(alice.address, bob.address, 1)
      ).to.be.revertedWithCustomError(nft, "Soulbound");
    });

    it("reverts both safeTransferFrom variants", async function () {
      await expect(
        nft.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, 1)
      ).to.be.revertedWithCustomError(nft, "Soulbound");
      await expect(
        nft.connect(alice)["safeTransferFrom(address,address,uint256,bytes)"](
          alice.address, bob.address, 1, "0x"
        )
      ).to.be.revertedWithCustomError(nft, "Soulbound");
    });

    it("reverts approve and setApprovalForAll", async function () {
      await expect(nft.connect(alice).approve(bob.address, 1))
        .to.be.revertedWithCustomError(nft, "Soulbound");
      await expect(nft.connect(alice).setApprovalForAll(bob.address, true))
        .to.be.revertedWithCustomError(nft, "Soulbound");
    });

    it("reverts transfers attempted by a third party", async function () {
      await expect(
        nft.connect(bob).transferFrom(alice.address, bob.address, 1)
      ).to.be.revertedWithCustomError(nft, "Soulbound");
    });
  });

  describe("tokenURI", function () {
    it("returns base64 JSON metadata with the beast attributes", async function () {
      await mintTo(alice, 9, HABIT, 21);
      const uri = await nft.tokenURI(1);
      expect(uri.startsWith("data:application/json;base64,")).to.equal(true);
      const json = JSON.parse(
        Buffer.from(uri.replace("data:application/json;base64,", ""), "base64").toString("utf8")
      );
      expect(json.name).to.equal("StakeBeast #1");
      const attrs = Object.fromEntries(json.attributes.map((a) => [a.trait_type, a.value]));
      expect(attrs["Beast Type"]).to.equal("habit");
      expect(attrs["Tier"]).to.equal("golden");
      expect(attrs["Measured Value"]).to.equal(21);
      expect(attrs["Session ID"]).to.equal(9);
      expect(attrs["Completed At"]).to.be.greaterThan(0);
    });

    it("reverts for a non-existent token", async function () {
      await expect(nft.tokenURI(42)).to.be.revertedWithCustomError(nft, "ERC721NonexistentToken");
    });

    it("renders every tier name in the metadata", async function () {
      await mintTo(alice, 1, FOCUS, 10); // sprout
      await mintTo(alice, 2, FOCUS, 25); // juvenile
      await mintTo(alice, 3, FOCUS, 50); // adult
      const tiers = ["sprout", "juvenile", "adult"];
      for (let tokenId = 1; tokenId <= 3; tokenId++) {
        const uri = await nft.tokenURI(tokenId);
        const json = JSON.parse(
          Buffer.from(uri.replace("data:application/json;base64,", ""), "base64").toString("utf8")
        );
        const attrs = Object.fromEntries(json.attributes.map((a) => [a.trait_type, a.value]));
        expect(attrs["Tier"]).to.equal(tiers[tokenId - 1]);
      }
    });
  });
});
