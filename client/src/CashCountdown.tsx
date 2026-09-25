import { useEffect, useState } from "react";
import {
  cashCountdownLabel,
  cashCountdownTarget,
  type MarketSession,
} from "../../shared/marketSession";

/**
 * Live cash-open / cash-close countdown. Ticks on the client from the
 * timestamps already on `marketSession` — no extra status poll.
 */
export function CashCountdown({
  session,
}: {
  session: MarketSession | null | undefined;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let timer = 0;
    const arm = () => {
      const delay = 1000 - (Date.now() % 1000);
      timer = window.setTimeout(() => {
        setNowMs(Date.now());
        arm();
      }, delay === 0 ? 1000 : delay);
    };
    arm();
    return () => window.clearTimeout(timer);
  }, []);

  if (!session) return null;
  const target = cashCountdownTarget(session, nowMs);
  if (!target) return null;
  const label = cashCountdownLabel(target.kind, target.atMs - nowMs);
  const wall = target.kind === "open" ? session.nextOpenEt : session.nextCloseEt;
  return (
    <span className="cash-cd" title={wall ?? undefined}>
      {label}
    </span>
  );
}
