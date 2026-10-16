# StakeBeast

Stake-to-commit DApp (HKU COMP7610 final project): stake ETH to open a focus or
habit session; succeed to get your stake back plus a soulbound beast NFT, fail
and the stake is forfeited (charity / supervisor / friend wallet).

This repository currently contains the on-chain groundwork: the Hardhat project
skeleton and `BeastNFT`, implemented ahead of the interface design freeze
(DAPP-2). The `StakeBeast` main contract follows once the design is frozen.

## Project layout

- `contracts/` — Solidity sources (`^0.8.24`, OpenZeppelin v5)
- `test/` — Hardhat + Chai unit tests
- `scripts/` — deployment / ops scripts
- `.env.example` — required environment variables (copy to `.env`)

## Getting started

Requirements: Node.js >= 18 and npm.

```bash
npm install
cp .env.example .env   # fill in values as needed
npx hardhat test
```

## Contracts

### BeastNFT

Soulbound ERC721 minted on session success (requirements baseline v1.4 section
4.8 / D8 / AC-17):

- Only the parameterized `minter` address can mint; the StakeBeast main
  contract is plugged in via `setMinter` after deployment.
- All transfers and approvals revert (`Soulbound`).
- Dual-track tiers, floored: focus by declared minutes
  (>=120 golden / >=50 adult / >=25 juvenile / else sprout), habit by cycle
  days (>=21 golden / >=7 adult / >=3 juvenile / else sprout).
- At most one beast per stake position per session (`mintedBySession` gate).
- Fully on-chain base64 JSON metadata (type, measured value, completion date,
  tier, session id).

## Deployment (Sepolia)

Set `PRIVATE_KEY` / `RPC_URL` / `ETHERSCAN_API_KEY` in `.env`, then:

```bash
npx hardhat run scripts/deploy.js --network sepolia
npx hardhat verify --network sepolia <BEAST_NFT_ADDRESS> <OWNER> 0x0000000000000000000000000000000000000000
```

(Etherscan verification runbook lands with WP7.)
