import type { StatusSnapshot } from "../../shared/types";

function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n).toFixed(2);
  if (n > 0) return `+$${abs}`;
  if (n < 0) return `-$${abs}`;
  return `$${abs}`;
}

export function CspBook({ status }: { status: StatusSnapshot }) {
  const book = status.csp;
  const rec = book?.recorder;
  const auth = rec?.auth ?? status.etradeAuth ?? "unknown";
  const blocking = rec?.blocking === true || auth === "needs_pin";
  return (
    <div className="csp-book">
      <div className="hint">
        Recorder {rec?.lastAt ?? "never"} · {rec?.rows ?? 0} rows · E*TRADE {auth}
        {blocking ? " · auth blocking" : ""}
      </div>
      <div className="kv">
        <div className="k">equity</div>
        <div>{usd(book?.equityUsd)}</div>
        <div className="k">cash</div>
        <div>{usd(book?.cashUsd)}</div>
        <div className="k">reserved</div>
        <div>{usd(book?.reservedUsd)}</div>
        <div className="k">utilization</div>
        <div>{book ? `${book.utilizationPct.toFixed(1)}%` : "—"}</div>
        <div className="k">realized</div>
        <div>{usd(book?.realizedPnlUsd)}</div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Put</th>
            <th>Strike</th>
            <th>Expiry</th>
            <th>DTE</th>
            <th>Entry</th>
            <th>Mark</th>
            <th>2x</th>
            <th>P/L</th>
          </tr>
        </thead>
        <tbody>
          {(book?.openPuts ?? []).map((p) => (
            <tr key={p.symbol}>
              <td>{p.underlying}</td>
              <td>{p.strike}</td>
              <td>{p.expiry}</td>
              <td>{p.dte ?? "—"}</td>
              <td>{p.entryPremium.toFixed(2)}</td>
              <td>{p.mark === null ? "—" : p.mark.toFixed(2)}</td>
              <td>{p.stop.toFixed(2)}</td>
              <td>{usd(p.pnlUsd)}</td>
            </tr>
          ))}
          {(book?.openPuts.length ?? 0) === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                no open puts
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {(book?.assigned.length ?? 0) > 0 && (
        <div className="hint">
          Assigned {book!.assigned.map((a) => `${a.qty} ${a.symbol} @ ${a.avgPrice}`).join(", ")}
        </div>
      )}
      {book?.betaAsOfYmd ? <div className="hint">Beta as of {book.betaAsOfYmd}</div> : null}
      {(book?.queued?.length ?? 0) > 0 && (
        <div className="hint">
          Queued{" "}
          {book!.queued
            .map((q) => `${q.symbol} beta ${q.beta.toFixed(2)} as of ${q.betaAsOfYmd ?? book!.betaAsOfYmd ?? "unknown"}`)
            .join(", ")}
        </div>
      )}
      {(book?.signals.length ?? 0) > 0 && <div className="hint">Signals {book!.signals.join(", ")}</div>}
      {(book?.skips.length ?? 0) > 0 && (
        <div className="hint">
          Skipped {book!.skips.map((s) => `${s.symbol}: ${s.reason}`).join(" · ")}
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>Shadow</th>
            <th>n</th>
            <th>Win</th>
            <th>Total</th>
            <th>Avg</th>
            <th>vs actual</th>
          </tr>
        </thead>
        <tbody>
          {(book?.shadow ?? [])
            .filter((s) => s.count > 0)
            .map((s) => (
              <tr key={s.ruleId}>
                <td>{s.ruleId}</td>
                <td>{s.count}</td>
                <td>{s.winRate === null ? "—" : `${(s.winRate * 100).toFixed(0)}%`}</td>
                <td>{usd(s.totalPnl)}</td>
                <td>{usd(s.avgPnl)}</td>
                <td>{usd(s.vsActual)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
