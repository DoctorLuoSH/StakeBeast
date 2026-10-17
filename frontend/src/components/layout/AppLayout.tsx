/**
 * AppLayout — top navigation + routed content shell.
 * Responsive: nav collapses to a horizontal scroll strip on narrow screens
 * (injected-wallet mobile browsers included).
 */

import { NavLink, Outlet } from "react-router-dom";
import { ConnectButton } from "../wallet/ConnectButton";
import "./AppLayout.css";

const NAV_ITEMS = [
  { to: "/", label: "Home", end: true },
  { to: "/create", label: "New Session", end: false },
  { to: "/focus", label: "Focus", end: false },
  { to: "/settlement", label: "Settlement", end: false },
  { to: "/review", label: "Review", end: false },
  { to: "/profile", label: "My Zoo", end: false },
];

export function AppLayout() {
  return (
    <div className="app-shell">
      <header className="app-nav">
        <NavLink to="/" className="app-nav__brand">
          <span aria-hidden>🐾</span> StakeBeast
        </NavLink>
        <nav className="app-nav__links" aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `app-nav__link${isActive ? " app-nav__link--active" : ""}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="app-nav__wallet">
          <ConnectButton />
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
      <footer className="app-footer muted">
        StakeBeast · COMP7610 Final Project · Sepolia testnet — stake to raise a
        beast; break your word and it runs.
      </footer>
    </div>
  );
}
