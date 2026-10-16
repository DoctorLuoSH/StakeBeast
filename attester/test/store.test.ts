/**
 * Persistence tests: judgment state must survive a service restart
 * (baseline section 6 / WP3: recoverable after restart).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/store';
import { createSession, recordBind, recordHeartbeat, recordHidden, type SessionState } from '../src/judgment';

const ADDR = '0x1111111111111111111111111111111111111111';
const T0 = 1_760_000_000_000;

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'attester-store-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('state is recoverable after a restart (new store instance over the same file)', () => {
  withTempDir((dir) => {
    const file = join(dir, 'attester.json');

    // First "process": register, bind, heartbeat, and violate one session.
    const first = new SessionStore(file);
    const cleanBind = recordBind(createSession('clean', ADDR, T0, 25 * 60_000), ADDR, T0 + 1_000);
    assert.ok(cleanBind.ok);
    first.put(cleanBind.state);
    const beat = recordHeartbeat(cleanBind.state, ADDR, T0 + 6_000);
    assert.ok(beat.ok);
    first.put(beat.state);

    const violatedBind = recordBind(createSession('violated', ADDR, T0, 25 * 60_000), ADDR, T0 + 1_000);
    assert.ok(violatedBind.ok);
    const hidden = recordHidden(violatedBind.state, ADDR, T0 + 12_000);
    assert.ok(hidden.ok);
    first.put(hidden.state);

    const issued: SessionState = { ...beat.state, sessionId: 'issued', issued: true };
    first.put(issued);
    first.put(createSession('unbound', ADDR, T0, 25 * 60_000));

    // Simulated restart: a fresh store reads the same file.
    const second = new SessionStore(file);
    const clean = second.get('clean');
    assert.ok(clean);
    assert.equal(clean.bindTime, T0 + 1_000);
    assert.equal(clean.lastHeartbeatAt, T0 + 6_000);
    assert.equal(clean.violation, null);

    const violated = second.get('violated');
    assert.ok(violated);
    assert.equal(violated.violation, 'hidden');
    assert.equal(violated.violatedAt, T0 + 12_000);

    const issuedReloaded = second.get('issued');
    assert.ok(issuedReloaded);
    assert.equal(issuedReloaded.issued, true);

    const unbound = second.get('unbound');
    assert.ok(unbound);
    assert.equal(unbound.bindTime, null);

    assert.equal(second.list().length, 4);
  });
});

test('put overwrites an existing record and persists the update', () => {
  withTempDir((dir) => {
    const file = join(dir, 'attester.json');
    const store = new SessionStore(file);
    const bound = recordBind(createSession('s', ADDR, T0, 25 * 60_000), ADDR, T0 + 1_000);
    assert.ok(bound.ok);
    store.put(bound.state);
    const hidden = recordHidden(bound.state, ADDR, T0 + 5_000);
    assert.ok(hidden.ok);
    store.put(hidden.state);

    const reloaded = new SessionStore(file);
    assert.equal(reloaded.get('s')?.violation, 'hidden');
    assert.equal(reloaded.list().length, 1);
  });
});

test('a missing file starts empty (first boot)', () => {
  withTempDir((dir) => {
    const store = new SessionStore(join(dir, 'nested', 'attester.json'));
    assert.equal(store.list().length, 0);
    // First write creates the directory tree.
    store.put(createSession('s', ADDR, T0, 25 * 60_000));
    assert.equal(new SessionStore(join(dir, 'nested', 'attester.json')).list().length, 1);
  });
});
