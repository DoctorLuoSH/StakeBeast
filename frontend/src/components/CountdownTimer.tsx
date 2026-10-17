/**
 * CountdownTimer — ticks down to a target timestamp.
 * Used by the focus page (endTime) and deadlines (join / start / settlement).
 */

import { useEffect, useState } from "react";
import { formatDuration } from "../lib/format";

interface CountdownTimerProps {
  /** Target time in unix ms. */
  targetMs: number;
  label?: string;
  onElapsed?: () => void;
}

export function CountdownTimer({ targetMs, label, onElapsed }: CountdownTimerProps) {
  const [remaining, setRemaining] = useState(() => targetMs - Date.now());

  useEffect(() => {
    const tick = () => {
      const left = targetMs - Date.now();
      setRemaining(left);
      if (left <= 0 && onElapsed) onElapsed();
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [targetMs, onElapsed]);

  const elapsed = remaining <= 0;
  return (
    <div className="countdown" role="timer" aria-live="off">
      {label ? <span className="countdown__label muted">{label}</span> : null}
      <span className={`countdown__value mono${elapsed ? " countdown__value--done" : ""}`}>
        {elapsed ? "00:00" : formatDuration(remaining)}
      </span>
    </div>
  );
}
