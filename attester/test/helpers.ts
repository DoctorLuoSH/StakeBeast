/**
 * Shared test rig: controllable clock + store + core + fake chain, plus the
 * bind/arm/heartbeat flow helpers every test builds on.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { AttesterStore } from '../src/store';
import { AttesterCore, type AuthContext } from '../src/core';
import { AttestationSigner } from '../src/signer';
import { CHAIN_ID, CONTRACT, FakeChain } from './fake-chain';

export const T0_MS = 1_800_000_000_000; // arbitrary fixed epoch ms
export const ATTESTER_KEY = '0x' + '11'.repeat(32);

export interface Rig {
  dir: string;
  nowMs: number;
  store: AttesterStore;
  chain: FakeChain;
  signer: AttestationSigner;
  core: AttesterCore;
  /** Advance the fake clock and keep the chain block fresh alongside it. */
  advanceTo(ms: number): void;
  advanceBy(ms: number): void;
  cleanup(): void;
}

export function makeRig(startMs = T0_MS, key = ATTESTER_KEY): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'attester-test-'));
  const rig = {
    dir,
    nowMs: startMs,
  } as Rig;
  const now = () => rig.nowMs;
  const monoBase = startMs;
  rig.store = new AttesterStore(dir, now, () => rig.nowMs - monoBase);
  rig.signer = new AttestationSigner(key);
  rig.chain = new FakeChain(rig.signer.address);
  rig.chain.setBlock(Math.floor(startMs / 1000));
  rig.core = new AttesterCore(rig.store, rig.chain, rig.signer, {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    now,
  });
  rig.advanceTo = (ms: number) => {
    rig.nowMs = ms;
    rig.chain.setBlock(Math.floor(ms / 1000));
  };
  rig.advanceBy = (ms: number) => rig.advanceTo(rig.nowMs + ms);
  rig.cleanup = () => {
    rig.store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return rig;
}

/** Run the full challenge+bind flow for a wallet; returns the client token. */
export async function bindWallet(
  rig: Rig,
  wallet: ethers.Wallet,
  sessionId: string,
): Promise<{ token: string; nextHeartbeatSeq: number; status: string }> {
  const ch = rig.core.createChallenge({
    chainId: CHAIN_ID,
    contract: CONTRACT,
    sessionId,
    address: wallet.address,
  });
  const bindSig = await wallet.signMessage(ch.message);
  const res = await rig.core.bind({
    chainId: CHAIN_ID,
    contract: CONTRACT,
    sessionId,
    address: wallet.address,
    nonce: ch.nonce,
    bindSig,
  });
  return { token: res.clientToken, nextHeartbeatSeq: res.nextHeartbeatSeq, status: res.status };
}

export function authOf(rig: Rig, token: string): AuthContext {
  const ctx = rig.core.authenticate(`Bearer ${token}`);
  if (!ctx) throw new Error('token did not authenticate');
  return ctx;
}

/** Send `count` heartbeats 5 s apart starting at the rig's current time. */
export function heartbeatSeries(rig: Rig, token: string, sessionId: string, fromSeq: number, count: number): number {
  const auth = authOf(rig, token);
  let seq = fromSeq;
  for (let i = 0; i < count; i++) {
    rig.core.heartbeat(auth, { sessionId, seq, clientTs: rig.nowMs });
    seq++;
    if (i + 1 < count) rig.advanceBy(5_000);
  }
  return seq;
}

/** Deterministic wallets for tests. */
export const walletA = new ethers.Wallet('0x' + 'aa'.repeat(32));
export const walletB = new ethers.Wallet('0x' + 'bb'.repeat(32));

export const TX_HASH = '0x' + 'ab'.repeat(32);
