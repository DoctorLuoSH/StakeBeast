/**
 * HomePage — product intro and entry points.
 * Read-only: no wallet required to browse.
 */

import { Link } from "react-router-dom";
import "./HomePage.css";

const MODES = [
  {
    badge: "P0",
    badgeClass: "badge--p0",
    title: "Solo Focus",
    body: "Stake ETH, start a machine-attested focus session. Leave the page and the beast runs.",
  },
  {
    badge: "P0",
    badgeClass: "badge--p0",
    title: "Supervised Habit",
    body: "Pick a human supervisor. Their on-chain confirmation is the only proof that counts.",
  },
  {
    badge: "P1",
    badgeClass: "badge--p1",
    title: "Mutual Bet",
    body: "Two stakers, two independent positions, each supervising the other.",
  },
  {
    badge: "P2",
    badgeClass: "badge--p2",
    title: "Co-Focus Duo",
    body: "Focus side by side. Shared fate: if either fails, both stakes go to charity.",
  },
];

export function HomePage() {
  return (
    <div className="home">
      <section className="home__hero card">
        <h1>
          Stake to raise a beast.
          <br />
          Break your word, and it runs.
        </h1>
        <p className="muted">
          StakeBeast is a commitment device on Sepolia: stake ETH to open a
          focus or habit session. Succeed and your stake returns with an
          untransferable beast NFT; fail and the stake is forfeited by the
          rules you chose up front.
        </p>
        <div className="home__cta">
          <Link className="button" to="/create">
            Start a Session
          </Link>
          <Link className="button button--ghost" to="/profile">
            Visit My Zoo
          </Link>
        </div>
      </section>
      <section className="home__modes">
        {MODES.map((m) => (
          <article key={m.title} className="card home__mode">
            <span className={`badge ${m.badgeClass}`}>{m.badge}</span>
            <h3>{m.title}</h3>
            <p className="muted">{m.body}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
