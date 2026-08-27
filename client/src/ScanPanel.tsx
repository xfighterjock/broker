import { useEffect, useState } from "react";
import type { ScanResponse, ScanRow, ScanSleeve } from "../../shared/types";
import { api } from "./api";

function fmtPx(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 100) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(3);
  return n.toFixed(4);
}

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(1)}%`;
}

function fmtAsOf(iso: string | null): string {
  if (!iso) return "—";
  return (
    new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }) + " ET"
  );
}

const HINT =
  "S&P 500 delayed daily scan. Not the full CRSP tape. One per sector on momentum. Auto paper from S&P scan. Mock only. Stops in the book. Day sleeve not auto.";

export function ScanPanel({
  sleeve,
  onPaperThis,
  setAuthNeeded,
  setErr,
}: {
  sleeve: ScanSleeve;
  onPaperThis: (row: ScanRow) => void;
  setAuthNeeded: (v: boolean) => void;
  setErr: (v: string | null) => void;
}) {
  const [scan, setScan] = useState<ScanResponse | null>(null);

  useEffect(() => {
    let cancel = false;
    async function load() {
      try {
        const body = (await api(`/api/scan?sleeve=${sleeve}`)) as ScanResponse;
        if (cancel) return;
        setScan(body);
        setErr(null);
      } catch (e: any) {
        if (cancel) return;
        if (e.status === 401) setAuthNeeded(true);
        else setErr(e.message);
      }
    }
    void load();
    const t = setInterval(() => {
      if (cancel) return;
      void load();
    }, scan?.status === "ok" ? 60_000 : 4_000);
    return () => {
      cancel = true;
      clearInterval(t);
    };
  }, [sleeve, scan?.status, setAuthNeeded, setErr]);

  const rows = scan?.rows ?? [];
  const scanning = !scan || scan.status === "scanning";

  return (
    <section className="panel scan-panel">
      <h2>
        Scan
        <span className="badge delayed">DELAYED</span>
        <span className="muted scan-asof">as-of {fmtAsOf(scan?.asOf ?? null)}</span>
      </h2>
      <div className="body">
        <div className="hint">{HINT}</div>
        {scanning && <div className="muted">scanning S&amp;P 500 delayed dailies…</div>}
        <div className="scan-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Sym</th>
                <th>Name</th>
                <th>Sector</th>
                <th>Last</th>
                <th>%52w</th>
                <th>dist20</th>
                <th>3m</th>
                <th>6m</th>
                <th>12m</th>
                <th>RS3m</th>
                <th>volx</th>
                <th>score</th>
                <th>why</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol}>
                  <td className="mono">{r.symbol}</td>
                  <td>{r.name}</td>
                  <td>{r.sector}</td>
                  <td className="mono">{fmtPx(r.last)}</td>
                  <td className="mono">{fmtPct(r.pctFrom52)}</td>
                  <td className="mono">{fmtPct(r.dist20)}</td>
                  <td className="mono">{fmtPct(r.ret3m)}</td>
                  <td className="mono">{fmtPct(r.ret6m)}</td>
                  <td className="mono">{fmtPct(r.ret12m)}</td>
                  <td className="mono">{fmtPct(r.rs3m)}</td>
                  <td className="mono">{r.volx.toFixed(2)}</td>
                  <td className="mono">{r.score.toFixed(3)}</td>
                  <td>{r.why}</td>
                  <td>
                    <button
                      type="button"
                      className="tiny good"
                      onClick={() => onPaperThis(r)}
                    >
                      Paper this
                    </button>
                  </td>
                </tr>
              ))}
              {!scanning && rows.length === 0 && (
                <tr>
                  <td colSpan={14} className="muted">no names passed the filter</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
