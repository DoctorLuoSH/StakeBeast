/**
 * NotFoundPage — catch-all route.
 */

import { Link } from "react-router-dom";
import "../components/states/StateScreens.css";

export function NotFoundPage() {
  return (
    <div className="state-screen">
      <div className="state-screen__icon" aria-hidden>
        🕳️
      </div>
      <h2>Page not found</h2>
      <p className="muted">This path leads nowhere — even the beast got lost.</p>
      <Link className="button" to="/">
        Back home
      </Link>
    </div>
  );
}
