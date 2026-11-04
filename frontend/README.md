# StakeBeast Frontend

React + Vite + Ethers v6 + MetaMask client for **StakeBeast** — a commitment
DApp on the Sepolia testnet. Stake ETH to open a focus or habit session and
raise a beast: succeed and the stake returns with an untransferable beast
NFT; fail and the stake is forfeited by rules chosen up front.

The app is wired to the real contract: four-mode session creation with
rule-level validation, pending-phase join / start / cancel actions, the
chain-anchored focus countdown, all settlement terminal states, and the
pull-payment withdraw entry.

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
`npm run preview`, `npm run lint`, `npm test` (vitest component tests).

## Environment variables

All deployment-specific values are injected through `.env` with the `VITE_`
prefix — the repository carries **zero hardcoded addresses**. See
`.env.example` for the full list:

| Variable | Purpose |
| --- | --- |
| `VITE_CONTRACT_ADDRESS` | StakeBeast session contract (after WP1 deploy) |
| `VITE_NFT_CONTRACT_ADDRESS` | BeastNFT contract (after WP2 deploy) |
| `VITE_PROOF_SERVICE_URL` | Machine-attestation service (WP3) — used for the settle attestation fetch |
| `VITE_API_BASE_URL` | Social backend REST API (P1, WP4) |
| `VITE_SEPOLIA_RPC_URL` | Optional RPC used when adding Sepolia to a wallet |
| `VITE_CHAIN_ID` | Expected chain override; empty = Sepolia. Set `31337` for a local Hardhat node |
| `VITE_DEMO_MODE` | `true` enables the zoo sample shelf in built bundles (dev server always counts as demo mode) |

## Wallet flow

1. Detects MetaMask (multi-wallet aware) — otherwise a guided install state.
2. `Connect Wallet` requests accounts, then **auto-switches to the expected
   network** (Sepolia by default; a local Hardhat node when
   `VITE_CHAIN_ID=31337`) via `wallet_switchEthereumChain`, falling back to
   `wallet_addEthereumChain`.
3. `accountsChanged` / `chainChanged` are handled reactively — switching
   accounts or networks in MetaMask updates the UI without a reload.
4. Any wrong network renders a blocking state with a one-click switch.

## Local Hardhat walkthrough

`scripts/ui-walkthrough.mjs` drives the real UI (headless Chrome + a scripted
EIP-1193 wallet shim over the Hardhat dev accounts) through all four modes
and their main terminal states — solo success with attestation settle +
withdraw, supervised verify, mutual-bet join / admit-defeat / cross-verify,
co-focus handshake + joint forfeit, cancel-after-start-window, permissionless
timeout forfeit, and admin void — saving a screenshot per step:

```bash
# from the repo root: npm install && npx hardhat compile
# from attester/:     npm install && npm run build
npm install                              # frontend deps incl. playwright-core
node scripts/ui-walkthrough.mjs          # screenshots → ./walkthrough-shots/
```

The script starts and stops its own Hardhat node, attester and dev server,
and deploys a contract instance with demo-sized windows (join 90 s, start
90 s, grace 120 s) so the whole run takes roughly ten minutes.

## Project layout

```
src/
├── config/          # env access (zero hardcode) + expected-chain metadata
├── wallet/          # EIP-1193 typing, WalletProvider (connect/switch/listen), useWallet
├── lib/             # explorer links, formatters, tx error classification,
│                    # sessionForm validation (R6 mirror), proofClient (DAPP-35 seam), useNow
├── contract/        # StakeBeast ABI + typed client, revert decoding → human messages,
│                    # sessionView derivation, useStakeBeast/useSession/useClaimable hooks
├── components/
│   ├── layout/      # AppLayout (responsive nav shell)
│   ├── wallet/      # ConnectButton, WalletGate (guards pages by wallet state)
│   ├── states/      # NoMetaMask, WrongNetwork, EmptyState screens
│   ├── tx/          # TxStatusBanner (pending/success/failure + explorer link), useTx
│   ├── beast/       # BeastSprite (SVG growth/flee animation pipeline), BeastCard,
│   │                # ZooShelf (real mints / demo samples / empty state — mutually exclusive)
│   └── CountdownTimer.tsx
└── pages/           # Home, CreateSession (4 modes), FocusSession (+ focus/ chain views),
                     # Settlement, Review (supervisor), Profile/My Zoo, NotFound
```

## Deliberate non-goals for this wave

The proof-service session protocol (bind at creation, arming, heartbeat loop,
proof-state-driven settlement hints) is DAPP-35 — `lib/proofClient.ts` carries
only the attestation retrieval the settle call needs. The social layer
(check-in upload, review feed) and the on-chain profile/zoo data are separate
waves; `/focus` without a session id keeps the animation-pipeline demo.

## Conventions

- UI copy, code, comments and docs are in English.
- Colors/spacing come from the design tokens in `src/index.css` — the frozen
  PRD v4.1 §14.5 "dark night-forest" palette (beast lime accent; gold
  reserved for the Golden tier; red reserved for forfeit/violation). No
  hardcoded values in components.
- All artwork is original. `BeastSprite` (`stage` / `tier` / `mood` /
  `progress` props) renders the blob-beast as inline SVG with a CSS keyframe
  animation pipeline (PRD §14.2/§14.3): five growth phases (egg → cracked →
  hatchling → near-final → final), four tier silhouettes, and mood overlays
  (growing / happy / warning / fled → withered / minted). Teammate B's final
  original sprites swap in behind the same props.
- Responsive by default, including narrow injected-wallet mobile browsers.
