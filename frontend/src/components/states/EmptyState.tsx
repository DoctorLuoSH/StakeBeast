/**
 * Inline empty-state block for lists/sections with nothing to show yet
 * (no sessions, no beasts, no pending reviews, ...).
 */

import type { ReactNode } from "react";
import "./StateScreens.css";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}

export function EmptyState({ icon = "🌱", title, hint, action }: EmptyStateProps) {
  return (
    <div className="state-screen" style={{ minHeight: "unset" }}>
      <div className="state-screen__icon" aria-hidden>
        {icon}
      </div>
      <h2>{title}</h2>
      {hint ? <p className="muted">{hint}</p> : null}
      {action}
    </div>
  );
}
