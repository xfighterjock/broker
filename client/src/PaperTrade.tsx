import { useEffect, useState, type FormEvent } from "react";
import type {
  DelayedQuote,
  Position,
  SleeveId,
  StatusSnapshot,
  WorkingOrder,
} from "../../shared/types";
import { api } from "./api";

export type PaperPrefill = {
  symbol: string;
  stopPrice: string;
  side?: "Buy" | "Sell";
  thesis?: string;
  key: number;
};

function formatPx(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 100) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(3);
  return n.toFixed(4);
}

const HINT =
  "Fills at delayed last. Stop is working on the mock book. Not live.";

export function PaperBanner() {
  return (
    <div className="paper-banner">
      <span className="badge delayed">PAPER · MOCK</span>
      <span className="hint">{HINT}</span>
    </div>
  );
}

function lastForSymbol(quotes: DelayedQuote[], symbol: string): number | null {
  const u = symbol.trim().toUpperCase();
  if (!u) return null;
  const hit = quotes.find(
    (q) => q.symbol.toUpperCase() === u || q.symbol.toUpperCase() === `${u}=F`,
  );
  return hit && hit.last !== null ? hit.last : null;
}

function belongsToSleeve(sleeveId: SleeveId, tagged?: SleeveId): boolean {
  if (tagged === sleeveId) return true;
  if (!tagged && sleeveId === "day") return true;
  return false;
}

export function PaperTradeRow({
  sleeveId,
  quotes,
  positions,
  orders,
  apply,
  setAuthNeeded,
  setErr,
  prefill,
}: {
  sleeveId: SleeveId;
  quotes: DelayedQuote[];
  positions: Position[];
  orders: WorkingOrder[];
  apply: (s: StatusSnapshot) => void;
  setAuthNeeded: (v: boolean) => void;
  setErr: (v: string | null) => void;
  prefill?: PaperPrefill | null;
}) {
  const [form, setForm] = useState({
    symbol: "",
    side: "Buy" as "Buy" | "Sell",
    qty: "1",
    stopPrice: "",
    thesis: "",
  });

  useEffect(() => {
    if (prefill) return;
    const first = quotes[0]?.symbol;
    if (!form.symbol && first) {
      setForm((f) => (f.symbol ? f : { ...f, symbol: first }));
    }
  }, [quotes, form.symbol, prefill]);

  useEffect(() => {
    if (!prefill) return;
    setForm((f) => ({
      ...f,
      symbol: prefill.symbol,
      stopPrice: prefill.stopPrice,
      side: prefill.side ?? "Buy",
      thesis: prefill.thesis ?? f.thesis,
    }));
  }, [prefill?.key]);

  const open = positions.filter(
    (p) => p.side !== "Flat" && p.qty > 0 && belongsToSleeve(sleeveId, p.sleeveId),
  );
  const stops = orders.filter(
    (o) =>
      (o.state === "Working" || o.state === "Submitted" || o.state === "Accepted") &&
      (o.type === "StopMarket" || o.type === "StopLimit") &&
      belongsToSleeve(sleeveId, o.sleeveId),
  );

  async function submit(side: "Buy" | "Sell") {
    try {
      const s = (await api("/api/paper/order", {
        method: "POST",
        body: JSON.stringify({
          sleeveId,
          symbol: form.symbol,
          side,
          qty: Number(form.qty),
          stopPrice: Number(form.stopPrice),
          thesis: form.thesis,
        }),
      })) as StatusSnapshot;
      apply(s);
      setErr(null);
    } catch (err: any) {
      if (err.status === 401) setAuthNeeded(true);
      else setErr(err.message);
    }
  }

  async function close(e?: FormEvent) {
    e?.preventDefault();
    const symbol = form.symbol.trim() || open[0]?.symbol;
    if (!symbol) {
      setErr("no symbol to close");
      return;
    }
    try {
      const s = (await api("/api/paper/close", {
        method: "POST",
        body: JSON.stringify({ sleeveId, symbol, reason: "manual" }),
      })) as StatusSnapshot;
      apply(s);
      setErr(null);
    } catch (err: any) {
      if (err.status === 401) setAuthNeeded(true);
      else setErr(err.message);
    }
  }

  function suggestStop() {
    const last = lastForSymbol(quotes, form.symbol);
    if (last === null) {
      setErr("no delayed last for that symbol");
      return;
    }
    const dir = form.side === "Buy" ? -1 : 1;
    const stop = last * (1 + dir * 0.015);
    setForm((f) => ({ ...f, stopPrice: String(Number(stop.toFixed(4))) }));
    setErr(null);
  }

  return (
    <section className="panel paper-trade">
      <h2>Paper trade</h2>
      <div className="body">
        <div className="hint">{HINT}</div>
        <form
          className="paper-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(form.side);
          }}
        >
          <div>
            <label>Symbol</label>
            <input
              value={form.symbol}
              onChange={(e) => setForm({ ...form, symbol: e.target.value })}
              placeholder={sleeveId === "day" ? "MES" : "SPY"}
            />
          </div>
          <div>
            <label>Side</label>
            <select
              value={form.side}
              onChange={(e) => setForm({ ...form, side: e.target.value as "Buy" | "Sell" })}
            >
              <option>Buy</option>
              <option>Sell</option>
            </select>
          </div>
          <div>
            <label>Qty</label>
            <input
              value={form.qty}
              onChange={(e) => setForm({ ...form, qty: e.target.value })}
            />
          </div>
          <div>
            <label>Stop</label>
            <input
              value={form.stopPrice}
              onChange={(e) => setForm({ ...form, stopPrice: e.target.value })}
              placeholder="required"
            />
          </div>
          <div>
            <label>Thesis</label>
            <input
              value={form.thesis}
              onChange={(e) => setForm({ ...form, thesis: e.target.value })}
              placeholder="why this trade"
            />
          </div>
          <button type="button" className="good" onClick={() => void submit("Buy")}>
            Paper buy
          </button>
          <button type="button" className="good" onClick={() => void submit("Sell")}>
            Paper sell
          </button>
          <button type="button" className="danger" onClick={() => void close()}>
            Close paper
          </button>
          <button type="button" onClick={suggestStop}>
            Stop ~1.5%
          </button>
        </form>
        <label>Open mock positions</label>
        <table>
          <thead>
            <tr>
              <th>Sym</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Avg</th>
              <th>uPnL</th>
            </tr>
          </thead>
          <tbody>
            {open.map((p) => (
              <tr key={p.id}>
                <td>{p.symbol}</td>
                <td>{p.side}</td>
                <td>{p.qty}</td>
                <td>{formatPx(p.avgPrice)}</td>
                <td>{formatPx(p.unrealizedPnl)}</td>
              </tr>
            ))}
            {open.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">flat</td>
              </tr>
            )}
          </tbody>
        </table>
        <label>Working stops</label>
        <table>
          <thead>
            <tr>
              <th>Sym</th>
              <th>Type</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Stop</th>
              <th>St</th>
            </tr>
          </thead>
          <tbody>
            {stops.map((o) => (
              <tr key={o.id}>
                <td>{o.symbol}</td>
                <td>{o.type}</td>
                <td>{o.side}</td>
                <td>{o.qty}</td>
                <td>{formatPx(o.stopPrice)}</td>
                <td className="ok">{o.state}</td>
              </tr>
            ))}
            {stops.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">none</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
