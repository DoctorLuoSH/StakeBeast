# StakeBeast Frontend

React + Vite + Ethers v6 + MetaMask client for **StakeBeast** — a commitment
DApp on the Sepolia testnet. Stake ETH to open a focus or habit session and
raise a beast: succeed and the stake returns with an untransferable beast
NFT; fail and the stake is forfeited by rules chosen up front.

This wave delivers the engineering skeleton: wallet infrastructure, routing,
page frames, design baseline, and the component interfaces that later waves
(contract integration, proof service, original artwork) plug into.

## Requirements

- Node.js ≥ 20 (developed on 22)
- MetaMask (desktop extension or the MetaMask mobile in-app browser)

## Quick start

```bash
cp .env.example .env   # fill in values when contracts/services are deployed
npm install
npm run dev            # http://localhost:5173
```

Other scripts: `npm run build` (type-check + production build),
`npm run preview`, `npm run lint`.

## Environment variables

All deployment-specific values are injected through `.env` with the `VITE_`
prefix — the repository carries **zero hardcoded addresses**. See
`.env.example` for the full list:

| Variable | Purpose |
| --- | --- |
| `VITE_CONTRACT_ADDRESS` | StakeBeast session contract (after WP1 deploy) |
| `VITE_NFT_CONTRACT_ADDRESS` | BeastNFT contract (after WP2 deploy) |
| `VITE_PROOF_SERVICE_URL` | Machine-attestation service (WP3) |
| `VITE_API_BASE_URL` | Social backend REST API (P1, WP4) |
| `VITE_SEPOLIA_RPC_URL` | Optional RPC used when adding Sepolia to a wallet |

## Wallet flow

1. Detects MetaMask (multi-wallet aware) — otherwise a guided install state.
2. `Connect Wallet` requests accounts, then **auto-switches to Sepolia**
   (`wallet_switchEthereumChain`, falling back to `wallet_addEthereumChain`).
3. `accountsChanged` / `chainChanged` are handled reactively — switching
   accounts or networks in MetaMask updates the UI without a reload.
4. Any non-Sepolia network renders a blocking "wrong network" state with a
   one-click switch.

## Project layout

```
src/
├── config/          # env access (zero hardcode) + Sepolia network metadata
├── wallet/          # EIP-1193 typing, WalletProvider (connect/switch/listen), useWallet
├── lib/             # etherscan links, formatters, tx error classification
├── components/
│   ├── layout/      # AppLayout (responsive nav shell)
│   ├── wallet/      # ConnectButton, WalletGate (guards pages by wallet state)
│   ├── states/      # NoMetaMask, WrongNetwork, EmptyState screens
│   ├── tx/          # TxStatusBanner (pending/success/failure + Etherscan link)
│   ├── beast/       # BeastSprite — reserved interface for teammate B's original art
│   └── CountdownTimer.tsx
└── pages/           # Home, CreateSession (4 modes), FocusSession, Settlement,
                     # Review (supervisor), Profile/My Zoo, NotFound
```

## Deliberate non-goals for this wave

Per the pre-freeze plan, this skeleton does **not** call contracts (ABI
frozen in DAPP-2), talk to the proof/social services, or implement the
business state machine. Buttons that will trigger transactions are visibly
disabled and labelled accordingly.

## Conventions

- UI copy, code, comments and docs are in English.
- Colors/spacing come from the design tokens in `src/index.css`
  (original "calm nature" palette); no hardcoded values in components.
- All artwork is original. `BeastSprite` (`stage` / `tier` / `mood` /
  `progress` props) is the seam where teammate B's sprites and the
  growth/flee animations will land.
- Responsive by default, including narrow injected-wallet mobile browsers.
