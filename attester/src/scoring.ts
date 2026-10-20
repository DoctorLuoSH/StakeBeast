/**
 * Coverage scoring — the pure heart of the judgment (attester-service §2, §3.4).
 *
 * Given the journaled receive records of one participant and the chain-anchored
 * window [startTime, endTime], decide whether the recorded coverage proves a
 * clean window, a user violation, or a platform-caused gap (uncertifiable).
 *
 * Rules (frozen):
 *  - a `visibility_hidden` event whose SERVER UTC receive time falls inside the
 *    window is an immediate, permanent violation;
 *  - any in-window silence between consecutive coverage instants longer than
 *    15 s is a violation — including the head gap from `startTime` and the tail
 *    gap to `endTime`;
 *  - silence while the SERVICE was demonstrably down (a cross-run gap spanning
 *    the current run's boot instant) is platform-caused: uncertifiable, never a
 *    user violation and never a remap;
 *  - monotonic arithmetic is used only between records of the SAME run id;
 *    cross-run comparisons use server UTC plus the current boot instant.
 *
 * Everything is a pure function of the inputs — live sweeps, late window
 * re-evaluation, restart recovery and the final coverage check all call the
 * same scorer, so one record set always yields one result.
 */

import { HEARTBEAT_GRACE_MS, type EventRec, type ReceiveRec } from './store';

export type Score =
  | { kind: 'ok' }
  | { kind: 'violation'; reason: 'hidden' | 'heartbeat_timeout'; atMs: number }
  | { kind: 'uncertifiable'; reason: 'restart_gap'; atMs: number };

interface Segment {
  /** silence interval (utc ms), already clamped to the scored range. */
  from: number;
  to: number;
  /**
   * 'same-run'  — both endpoints belong to one run instance (mono comparable)
   * 'up'        — service was running for the whole segment (UTC comparable)
   * 'restarted' — segment spans a service restart: UTC evidence only for the
   *               portion before the current boot, demonstrably-up portion after
   */
  reliability: 'same-run' | 'up' | 'restarted' | 'unknown';
  /** monotonic gap when reliability == 'same-run'. */
  monoGap?: number;
}

const over = (ms: number): boolean => ms > HEARTBEAT_GRACE_MS;

/**
 * Score one participant's records over the window, up to `uptoMs`
 * (sweeper: now; final judgment: endTime). `hasForeignRecords` tells the
 * scorer the session existed in a previous run (downtime may be unobserved).
 */
export function scoreCoverage(
  heartbeats: ReceiveRec[],
  events: EventRec[],
  windowMs: { startMs: number; endMs: number },
  bootUtcMs: number,
  currentRunId: string,
  uptoMs: number,
): Score {
  const start = windowMs.startMs;
  const end = Math.min(uptoMs, windowMs.endMs);
  if (end <= start) return { kind: 'ok' };

  // 1. Hidden events scored by server UTC receive time inside the window.
  let hiddenAt: number | null = null;
  for (const ev of events) {
    if (ev.type === 'visibility_hidden' && ev.rec.utc >= start && ev.rec.utc <= end) {
      if (hiddenAt === null || ev.rec.utc < hiddenAt) hiddenAt = ev.rec.utc;
    }
  }

  // 2. Silence segments between consecutive coverage instants.
  const hbs = [...heartbeats].sort((a, b) => a.utc - b.utc);
  const segments: Segment[] = [];
  const before = hbs.filter((h) => h.utc <= start);
  const inside = hbs.filter((h) => h.utc > start && h.utc < end);
  const anchor: ReceiveRec | null = before.length > 0 ? before[before.length - 1] : null;
  const points: ReceiveRec[] = anchor ? [anchor, ...inside] : inside;

  const classify = (a: ReceiveRec, bUtc: number, b: ReceiveRec | null): Segment => {
    const from = Math.max(a.utc, start);
    const to = Math.min(bUtc, end);
    if (b && b.runId === a.runId) {
      return { from, to, reliability: 'same-run', monoGap: b.mono - a.mono };
    }
    if (b && b.runId !== currentRunId && a.runId !== currentRunId) {
      // Two foreign runs: no boot instant to reason with — wholly unverifiable.
      return { from, to, reliability: 'unknown' };
    }
    return { from, to, reliability: 'restarted' };
  };

  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    segments.push(classify(a, b.utc, b));
  }
  // Head gap: startTime -> first coverage (or whole range if nothing yet).
  if (!anchor) {
    const first = inside[0] ?? null;
    if (first) {
      segments.unshift({
        from: start,
        to: Math.min(first.utc, end),
        reliability: first.runId === currentRunId && bootUtcMs <= start ? 'up' : 'restarted',
      });
    } else {
      segments.push({
        from: start,
        to: end,
        reliability: bootUtcMs <= start ? 'up' : 'restarted',
      });
    }
  }
  // Tail gap: last IN-WINDOW coverage -> range end. Records arriving at or
  // after the range end are out of window: they never patch an in-window gap
  // (frozen rule — out-of-window events do not change the judgment; DAPP-20
  // D2: a post-end heartbeat must not mask a silent tail).
  const covered = hbs.filter((h) => h.utc < end);
  const last = covered.length > 0 ? covered[covered.length - 1] : null;
  if (last) {
    segments.push(
      last.runId === currentRunId
        ? { from: Math.max(last.utc, start), to: end, reliability: 'up' }
        : { from: Math.max(last.utc, start), to: end, reliability: 'restarted' },
    );
  }

  // 3. Judge segments: user violation while demonstrably up; else platform gap.
  let timeoutAt: number | null = null;
  let restartGapAt: number | null = null;
  for (const seg of segments) {
    const len = seg.to - seg.from;
    if (len <= 0) continue;
    switch (seg.reliability) {
      case 'same-run':
        if (over(seg.monoGap!) && over(len) && timeoutAt === null) {
          timeoutAt = seg.from + HEARTBEAT_GRACE_MS;
        }
        break;
      case 'up':
        if (over(len) && timeoutAt === null) timeoutAt = seg.from + HEARTBEAT_GRACE_MS;
        break;
      case 'restarted': {
        // Unverifiable portion: everything before the current run booted.
        const unknownLen = Math.min(seg.to, bootUtcMs) - seg.from;
        // Demonstrably-up portion: everything after boot.
        const upLen = seg.to - Math.max(seg.from, bootUtcMs);
        if (over(upLen) && timeoutAt === null) {
          timeoutAt = Math.max(seg.from, bootUtcMs) + HEARTBEAT_GRACE_MS;
        } else if (over(unknownLen) && restartGapAt === null) {
          restartGapAt = seg.from + HEARTBEAT_GRACE_MS;
        }
        break;
      }
      case 'unknown':
        if (over(len) && restartGapAt === null) restartGapAt = seg.from + HEARTBEAT_GRACE_MS;
        break;
    }
  }

  // Earliest established user violation wins; platform gaps only when the
  // record shows no user fault (fail-closed without masking a violation).
  const candidates: { atMs: number; score: Score }[] = [];
  if (hiddenAt !== null) candidates.push({ atMs: hiddenAt, score: { kind: 'violation', reason: 'hidden', atMs: hiddenAt } });
  if (timeoutAt !== null) candidates.push({ atMs: timeoutAt, score: { kind: 'violation', reason: 'heartbeat_timeout', atMs: timeoutAt } });
  if (candidates.length > 0) {
    candidates.sort((a, b) => a.atMs - b.atMs);
    return candidates[0].score;
  }
  if (restartGapAt !== null) return { kind: 'uncertifiable', reason: 'restart_gap', atMs: restartGapAt };
  return { kind: 'ok' };
}
