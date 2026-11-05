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

- Node.js ≥ 20.12 (developed on 22)
- MetaMask (desktop extension or the MetaMask mobile in-app browser)

## Quick start

The frontend starts **last** — after the chain is deployed and the two
services are running (startup order: chain → attester → backend → frontend;
see the repository README for the full walkthrough).

```bash
npm install
cp .env.example .env   # then fill in the values (see below)
npm run dev            # http://localhost:5173
```

Other scripts: `npm run build` (type-check + production build),
`npm run preview`, `npm run lint`, `npm test` (vitest component tests).

## Environment variables

All deployment-specific values are injected through `.env` with the `VITE_`
prefix — the repository carries **zero hardcoded addresses**. See
`.env.example` for the annotated template:

| Variable | Required | Purpose |
| --- | --- | --- |
| `VITE_CONTRACT_ADDRESS` | Yes | StakeBeast session contract — `stakeBeast` in `deployments/<network>.json` |
| `VITE_NFT_CONTRACT_ADDRESS` | Yes | BeastNFT contract — `beastNFT` in `deployments/<network>.json` |
| `VITE_PROOF_SERVICE_URL` | For machine-proof focus sessions | Machine-attestation service — focus tracking (bind/arm/heartbeat) and the settle attestation fetch |
| `VITE_API_BASE_URL` | For social features (P1) | Social backend REST API, including the `/api` suffix |
| `VITE_SEPOLIA_RPC_URL` | No | RPC endpoint used when adding Sepolia to a wallet |
| `VITE_CHAIN_ID` | No | Expected chain override; empty = Sepolia. Set `31337` for a local Hardhat node |
| `VITE_DEMO_MODE` | No | `true` enables the zoo sample shelf in built bundles (dev server always counts as demo mode) |

The app boots with empty values, but the matching feature stays disabled:
create/focus/settle need the contract addresses, machine-proof sessions need
the proof service, and social features need the backend.

## Pointing at Sepolia

Once the contracts are deployed to Sepolia (WP7, `deployments/sepolia.json`):

1. Copy `stakeBeast` → `VITE_CONTRACT_ADDRESS` and `beastNFT` →
   `VITE_NFT_CONTRACT_ADDRESS` in `frontend/.env`.
2. Leave `VITE_CHAIN_ID` empty — Sepolia (11155111) is the default expected
   network, so MetaMask is auto-switched on connect and any other network
   gets the wrong-network screen with a one-click switch.
3. Set `VITE_PROOF_SERVICE_URL` / `VITE_API_BASE_URL` to the deployed
   service URLs (or the local ones while running the services on your own
   machine).

> **Status:** the Sepolia addresses land with the M4-A deployment (DAPP-62);
> until then this section is the mechanism and `deployments/sepolia.json`
> does not exist yet.

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
90 s, grace 120 s) so the whole run takes roughly twelve minutes.

`scripts/ui-social-walkthrough.mjs` covers the social layer and the personal
homepage (DAPP-47) against the same harness plus the social backend:
wallet-signature sign-in, profile edit (nickname + avatar), a supervised
check-in (photo upload → SHA-256 anchor on-chain → backend-confirmed), the
supervisor review list (original bytes re-hashed vs. the on-chain anchor →
"anchored & matching" → on-chain verify), a mutual-bet evidence
cross-confirmation, the co-focus dual side-by-side view, and the My Zoo
homepage with real record stats and mints:

```bash
# additionally: npm --prefix backend install && npm --prefix backend run build
node scripts/ui-social-walkthrough.mjs   # screenshots → ./walkthrough-social-shots/
```

## Project layout

```
src/
├── config/          # env access (zero hardcode) + expected-chain metadata
├── wallet/          # EIP-1193 typing, WalletProvider (connect/switch/listen), useWallet
├── lib/             # explorer links, formatters, tx error classification,
│                    # sessionForm validation (R6 mirror), useNow,
│                    # proofClient + proofTracker + useProofTracking (attester protocol)
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

## Proof tracking (machine-proof sessions)

The focus page owns the attester protocol end to end (`lib/proofTracker.ts` +
`lib/useProofTracking.ts` over `lib/proofClient.ts`): a one-time challenge
bind (one wallet signature) readies tracking; the start click then sends the
`startSession` transaction and posts the arming notice on broadcast; a 5 s
heartbeat loop runs while the window is open, resuming from the service's
`nextHeartbeatSeq` after any reconnect; visibility events are reported (an
in-window hidden tab is a permanent violation). The settlement prompt is
driven by the service-confirmed proof state — it appears only once coverage
is verified — and a bind from another tab/device surfaces the single-client
takeover notice.

## Deliberate non-goals for this wave

The social layer (check-in upload, review feed) and the on-chain profile/zoo
data are separate waves; `/focus` without a session id keeps the
animation-pipeline demo.

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
