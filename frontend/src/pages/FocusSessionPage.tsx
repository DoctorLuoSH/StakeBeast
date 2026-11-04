/**
 * FocusSessionPage — in-session view (baseline §4.7, PRD §14.1).
 *
 * With a `:sessionId` route param the page renders the live on-chain session
 * (ChainFocusSession): pending-phase join/start/cancel actions and the active
 * countdown anchored to the chain's SessionStarted window. Without a param it
 * renders the original demo session that exercises the animation pipeline.
 */

import { useParams } from "react-router-dom";
import { WalletGate } from "../components/wallet/WalletGate";
import { EmptyState } from "../components/states/EmptyState";
import { ChainFocusSession } from "./focus/ChainFocusSession";
import { DemoFocusSession } from "./focus/DemoFocusSession";

export function FocusSessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();

  let id: bigint | null = null;
  if (sessionId && /^\d+$/.test(sessionId)) {
    try {
      id = BigInt(sessionId);
    } catch {
      id = null;
    }
  }

  if (sessionId && id === null) {
    return (
      <WalletGate>
        <EmptyState icon="🧭" title="Unknown session" hint={`"${sessionId}" is not a valid session id.`} />
      </WalletGate>
    );
  }

  return (
    <WalletGate>{id !== null ? <ChainFocusSession sessionId={id} /> : <DemoFocusSession />}</WalletGate>
  );
}
