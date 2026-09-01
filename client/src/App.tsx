import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  CHECKLIST_LABELS,
  defaultSleeves,
  emptyFreeze,
  SLEEVE_STATUSES,
  type Checklist,
  type DelayedQuote,
  type FreezeCard,
  type PaperFill,
  type ScanRow,
  type ScanSleeve,
  type SleeveCard,
  type SleeveBook,
  type SleeveId,
  type StatusSnapshot,
} from "../../shared/types";
import { api } from "./api";
import {
  formatPnlPct,
  formatPnlUsd,
  gateModeClass as modeClass,
  riskBadgeTitle,
  SLEEVE_TAB_LABELS as TAB_LABELS,
} from "./essentials";
import { MobileEssentials, useEssentialsView } from "./MobileEssentials";
import { PaperBanner, PaperTradeRow, type PaperPrefill } from "./PaperTrade";
import { OptionsPanel } from "./OptionsPanel";
import { ScanPanel } from "./ScanPanel";

function formatEventEt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}


function formatPx(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 100) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(3);
  return n.toFixed(4);
}

function formatChange(q: DelayedQuote): string {
  if (q.change === null) return "—";
  const sign = q.change > 0 ? "+" : "";
  const pct =
    q.changePct === null
      ? ""
      : ` (${q.changePct > 0 ? "+" : ""}${q.changePct.toFixed(2)}%)`;
  return `${sign}${formatPx(q.change)}${pct}`;
}

function formatAsOf(iso: string | null): string {
  if (!iso) return "—";
  return (
    new Date(iso).toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }) + " ET"
  );
}

function formatFillTs(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function lastForSymbol(quotes: DelayedQuote[], symbol: string): number | null {
  const u = symbol.trim().toUpperCase();
  if (!u) return null;
  const hit = quotes.find(
    (q) => q.symbol.toUpperCase() === u || q.symbol.toUpperCase() === `${u}=F`,
  );
  return hit && hit.last !== null ? hit.last : null;
}

const DELAYED_HINT =
  "Delayed last: Massive Starter (equities/ETFs, 15m) or Yahoo (futures =F). Not a live book. Paper fills are a journal, not broker orders.";

function QuoteStrip({ quotes }: { quotes: DelayedQuote[] }) {
  return (
    <div className="quotes">
      {quotes.map((q) => {
        const dir =
          q.change === null || q.change === 0 ? "flat" : q.change > 0 ? "up" : "down";
        return (
          <div key={q.symbol} className={`quote ${dir}`}>
            <span className="sym">{q.symbol}</span>
            <span className="last">{q.error ? "—" : formatPx(q.last)}</span>
            <span className="chg">{q.error ? q.error : formatChange(q)}</span>
            <span className="badge delayed">DELAYED</span>
            <span className="asof muted">{formatAsOf(q.asOf)}</span>
          </div>
        );
      })}
      {quotes.length === 0 && <div className="muted">quotes…</div>}
      <span className="hint">{DELAYED_HINT}</span>
    </div>
  );
}

function PaperBlotter({
  sleeveId,
  fills,
  quotes,
  apply,
  setAuthNeeded,
  setErr,
}: {
  sleeveId: SleeveId;
  fills: PaperFill[];
  quotes: DelayedQuote[];
  apply: (s: StatusSnapshot) => void;
  setAuthNeeded: (v: boolean) => void;
  setErr: (v: string | null) => void;
}) {
  const [form, setForm] = useState({
    symbol: "",
    side: "Buy" as "Buy" | "Sell",
    qty: "1",
    price: "",
    notes: "",
  });

  useEffect(() => {
    const first = quotes[0]?.symbol;
    if (!form.symbol && first) {
      setForm((f) => (f.symbol ? f : { ...f, symbol: first }));
    }
  }, [quotes, form.symbol]);

  const sleeveFills = fills.filter((f) => f.sleeveId === sleeveId);

  function fillAtLast() {
    const want = form.symbol.trim() || quotes[0]?.symbol || "";
    const last = lastForSymbol(quotes, want);
    if (last === null) {
      setErr("no delayed last for that symbol");
      return;
    }
    setForm((f) => ({ ...f, symbol: want, price: String(last) }));
    setErr(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const s = (await api(`/api/sleeves/${sleeveId}/fills`, {
        method: "POST",
        body: JSON.stringify({
          symbol: form.symbol,
          side: form.side,
          qty: Number(form.qty),
          price: Number(form.price),
          notes: form.notes,
        }),
      })) as StatusSnapshot;
      apply(s);
      setForm((f) => ({ ...f, qty: "1", price: "", notes: "" }));
      setErr(null);
    } catch (err: any) {
      if (err.status === 401) setAuthNeeded(true);
      else setErr(err.message);
    }
  }

  async function remove(id: string) {
    try {
      const s = (await api(`/api/sleeves/${sleeveId}/fills/${id}`, {
        method: "DELETE",
      })) as StatusSnapshot;
      apply(s);
      setErr(null);
    } catch (err: any) {
      if (err.status === 401) setAuthNeeded(true);
      else setErr(err.message);
    }
  }

  return (
    <section className="panel">
      <h2>Paper blotter</h2>
      <div className="body">
        <div className="hint">{DELAYED_HINT}</div>
        <form className="fill-form" onSubmit={submit}>
          <div>
            <label>Symbol</label>
            <input
              value={form.symbol}
              onChange={(e) => setForm({ ...form, symbol: e.target.value })}
              placeholder="MES=F"
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
            <label>Price</label>
            <input
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
            />
          </div>
          <div>
            <label>Notes</label>
            <input
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="journal"
            />
          </div>
          <button type="button" onClick={fillAtLast}>Fill at last</button>
          <button type="submit" className="good">Record paper fill</button>
        </form>
        <table>
          <thead>
            <tr>
              <th>Ts</th>
              <th>Sym</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Px</th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...sleeveFills].reverse().map((f) => (
              <tr key={f.id}>
                <td className="mono">{formatFillTs(f.ts)}</td>
                <td>{f.symbol}</td>
                <td className={f.side === "Buy" ? "ok" : "err"}>{f.side}</td>
                <td>{f.qty}</td>
                <td>{formatPx(f.price)}</td>
                <td>{f.notes}</td>
                <td>
                  <button type="button" className="tiny" onClick={() => void remove(f.id)}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
            {sleeveFills.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">no paper fills</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OwnershipOverlayNote({ positions }: { positions: StatusSnapshot["broker"]["positions"] }) {
  const rows = positions.filter(
    (p) =>
      p.side !== "Flat" &&
      p.qty > 0 &&
      p.overlay &&
      (p.overlay.thesisSleeve === "ownership" || p.overlay.thesisSleeve === "spcx"),
  );
  return (
    <div className="hint overlay-note">
      <span className="badge delayed">DELAYED · MOCK</span>{" "}
      Ownership overlay is paper CSP/CC on the options sleeve (never autopilot, never live).
      {rows.length === 0 ? (
        <div className="muted">no tagged overlay</div>
      ) : (
        <ul className="overlay-list">
          {rows.map((p) => {
            const o = p.overlay!;
            return (
              <li key={p.id}>
                {o.kind} {p.symbol} · thesis {o.thesisSleeve}
                {o.taLevel ? ` · TA ${o.taLevel}` : ""} · {o.thesisSymbol}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<StatusSnapshot | null>(null);
  const [authNeeded, setAuthNeeded] = useState(false);
  const [password, setPassword] = useState("");
  const [freeze, setFreeze] = useState<FreezeCard>(emptyFreeze());
  const [err, setErr] = useState<string | null>(null);
  const [inject, setInject] = useState({
    symbol: "MESU6",
    type: "StopMarket",
    side: "Buy",
    qty: "1",
    stopPrice: "5800",
  });
  const [tab, setTab] = useState<SleeveId>("day");
  const [sleeveDraft, setSleeveDraft] = useState<SleeveCard | null>(null);
  const [quotes, setQuotes] = useState<DelayedQuote[]>([]);
  const [paperPrefill, setPaperPrefill] = useState<PaperPrefill | null>(null);
  const essentials = useEssentialsView();

  const apply = useCallback((s: StatusSnapshot) => {
    setState(s);
    if (s.freeze) setFreeze(s.freeze);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = (await api("/api/status")) as StatusSnapshot;
      apply(s);
      setAuthNeeded(false);
      setErr(null);
    } catch (e: any) {
      if (e.status === 401) setAuthNeeded(true);
      else setErr(e.message);
    }
  }, [apply]);

  useEffect(() => {
    let cancel = false;
    let ws: WebSocket | null = null;
    (async () => {
      try {
        const st = await api("/api/auth/status");
        if (cancel) return;
        if (st.authRequired && !st.authed) {
          setAuthNeeded(true);
          return;
        }
        await refresh();
        const proto = location.protocol === "https:" ? "wss" : "ws";
        ws = new WebSocket(`${proto}://${location.host}/ws`);
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === "status" && msg.payload) apply(msg.payload);
            if (msg.type === "log") void refresh();
          } catch {
            /* ignore */
          }
        };
        ws.onerror = () => {
          /* polling fallback below */
        };
      } catch (e: any) {
        if (!cancel) setErr(e.message);
      }
    })();
    const t = setInterval(() => {
      if (!cancel) void refresh();
    }, 1000);
    return () => {
      cancel = true;
      clearInterval(t);
      ws?.close();
    };
  }, [apply, refresh]);

  useEffect(() => {
    if (authNeeded || essentials) return;
    let cancel = false;
    async function loadQuotes() {
      try {
        const body = await api(`/api/quotes?sleeve=${tab}`);
        if (cancel) return;
        setQuotes((body.quotes ?? []) as DelayedQuote[]);
      } catch (e: any) {
        if (cancel) return;
        if (e.status === 401) setAuthNeeded(true);
        else setErr(e.message);
      }
    }
    void loadQuotes();
    const t = setInterval(() => {
      if (!cancel) void loadQuotes();
    }, 20_000);
    return () => {
      cancel = true;
      clearInterval(t);
    };
  }, [tab, authNeeded, essentials]);

  async function login(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      setPassword("");
      setAuthNeeded(false);
      await refresh();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function post(path: string, body?: unknown, method = "POST") {
    try {
      const s = (await api(path, {
        method,
        body: body !== undefined ? JSON.stringify(body) : "{}",
      })) as StatusSnapshot;
      apply(s);
    } catch (e: any) {
      if (e.status === 401) setAuthNeeded(true);
      else setErr(e.message);
    }
  }

  const clock = state?.clock;
  const freezeDirty = useMemo(
    () => JSON.stringify(freeze) !== JSON.stringify(state?.freeze),
    [freeze, state],
  );

  const sleeves = state?.sleeves ?? defaultSleeves();
  useEffect(() => {
    setPaperPrefill(null);
    if (tab === "day") return;
    const card = sleeves[tab];
    if (card) setSleeveDraft({ ...card, paper: { ...card.paper } });
    // Sync draft when switching tabs, not on every 1s poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  if (authNeeded) {
    return (
      <div className="login">
        <form className="panel" onSubmit={login}>
          <h2>Event Gate</h2>
          <div className="body">
            <p className="hint">Shared password required. Paper only. No directional orders from this app.</p>
            <label>GATE_PASSWORD</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            {err && <div className="err">{err}</div>}
            <button type="submit" className="good">Enter</button>
          </div>
        </form>
      </div>
    );
  }

  if (!state) {
    return <div className="login muted">Loading Event Gate… {err}</div>;
  }

  if (essentials) {
    return (
      <MobileEssentials
        state={state}
        err={err}
        onToggleGate={() => post("/api/gate/enable", { enabled: !state.gateEnabled })}
        onToggleAutoPaper={() => post("/api/paper/auto", { enabled: state.autoPaper === false })}
        onFlatten={() => post("/api/flatten")}
      />
    );
  }

  const working = state.broker.orders.filter(
    (o) => o.state === "Working" || o.state === "Submitted" || o.state === "Accepted" || o.state === "Cancelled",
  );

  return (
    <div className="app">
      <header className="top">
        <div className="brand">EVENT GATE</div>
        <span className="sep">|</span>
        <div className="sim">PAPER · MOCK</div>
        <span className="sep">|</span>
        <div className="muted">{state.broker.name}</div>
        <span className="sep">|</span>
        <div className="clock">{clock?.nowEt}</div>
        <div className="grow" />
        <label className="toggle">
          <input
            type="checkbox"
            checked={state.gateEnabled}
            onChange={() => post("/api/gate/enable", { enabled: !state.gateEnabled })}
          />
          <span className="switch" />
          <span className={`badge ${state.gateEnabled ? "on" : "off"}`}>
            GATE {state.gateEnabled ? "ON" : "OFF"}
          </span>
        </label>
        <label className="toggle" title="Auto paper from S&P scan. Mock only. Stops in the book. Day sleeve not auto.">
          <input
            type="checkbox"
            checked={state.autoPaper !== false}
            onChange={() => post("/api/paper/auto", { enabled: state.autoPaper === false })}
          />
          <span className="switch" />
          <span className={`badge ${state.autoPaper !== false ? "on" : "off"}`}>
            AUTO PAPER {state.autoPaper !== false ? "ON" : "OFF"}
          </span>
        </label>
        <span
          className={`badge ${state.riskOn ? "risk-on" : "risk-off"}`}
          title={riskBadgeTitle(state)}
        >
          {state.riskOn ? "RISK ON" : "RISK OFF"}
        </span>
      </header>

      <nav className="tabs">
        {TAB_LABELS.map((t) => {
          const book: SleeveBook | undefined = state.sleeveBooks?.[t.id];
          const total = book?.totalPnlUsd ?? book?.pnlUsd ?? 0;
          const daily = book?.dailyPnlUsd ?? 0;
          const equity = book?.equityUsd ?? 100_000;
          const totalCls = total > 0 ? "ok" : total < 0 ? "err" : "muted";
          const dailyCls = daily > 0 ? "ok" : daily < 0 ? "err" : "muted";
          const pct = formatPnlPct(total, equity);
          return (
            <button
              key={t.id}
              className={`tab ${tab === t.id ? "active" : ""}`}
              onClick={() => setTab(t.id)}
              type="button"
              title={`Mock $${equity.toFixed(0)} equity · day ${formatPnlUsd(daily)} · total ${formatPnlUsd(total)}${pct ? " " + pct : ""}`}
            >
              <span>{t.label}</span>
              <span className={`tab-pnl ${dailyCls}`}>
                d {formatPnlUsd(daily)}
              </span>
              <span className={`tab-pnl ${totalCls}`}>
                tot {formatPnlUsd(total)}
                {pct ? <span className="tab-pct"> {pct}</span> : null}
              </span>
            </button>
          );
        })}
      </nav>
      <div className="hint auto-hint">
        Auto paper from S&amp;P scan. Mock only. Stops in the book. Day sleeve not auto. RISK ON/OFF is automated (SPY/ACWI/HYG 200dma, UUP 20d) and does not bind the day book. Each sleeve starts at mock $100,000.
      </div>

      {tab === "day" && (
      <>
      <div className={`banner ${modeClass(clock?.mode ?? "idle")}`}>
        <span className={`badge ${modeClass(clock?.mode ?? "idle")}`}>{clock?.mode}</span>
        <span>
          {clock?.focusEvent?.type ?? "—"} {clock?.focusEvent ? formatEventEt(clock.focusEvent.timeUtc) : ""}
        </span>
        <span className="cd">{clock?.countdownLabel}</span>
        <span>flatten {clock?.flattenEt ?? "—"} ET</span>
        {clock?.nextEvent && clock.mode === "idle" && (
          <span className="muted">next {clock.nextEvent.type}</span>
        )}
      </div>

      <QuoteStrip quotes={quotes} />
      <PaperBanner />
      <div className="blotter-wrap">
        <PaperTradeRow
          sleeveId="day"
          quotes={quotes}
          positions={state.broker.positions}
          orders={state.broker.orders}
          apply={apply}
          setAuthNeeded={setAuthNeeded}
          setErr={setErr}
        />
      </div>

      <div className="grid">
        <section className="panel">
          <h2>Clock</h2>
          <div className="body">
            <table>
              <thead>
                <tr>
                  <th>ET</th>
                  <th>Type</th>
                  <th>Flatten</th>
                </tr>
              </thead>
              <tbody>
                {state.events.map((ev) => {
                  const active = clock?.focusEvent?.id === ev.id;
                  return (
                    <tr key={ev.id} className={active ? "active-row" : ""}>
                      <td className="mono">{formatEventEt(ev.timeUtc)}</td>
                      <td>{ev.type}</td>
                      <td>{ev.type.toUpperCase().includes("FOMC") ? "15:30" : ev.flattenEt} ET</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="hint">
              Trader {state.trader} · {state.tz}. Times stored UTC. FOMC type forces flatten 15:30 ET.
            </div>
          </div>
        </section>

        <section className="panel">
          <h2>Freeze</h2>
          <div className="body">
            <label>Consensus (human-entered)</label>
            <textarea
              value={freeze.consensusObjects}
              onChange={(e) => setFreeze({ ...freeze, consensusObjects: e.target.value })}
              placeholder="payrolls / U-rate / AHE … ECOS numbers"
            />
            <div className="row">
              <div>
                <label>Source</label>
                <input
                  value={freeze.sourceLabel}
                  onChange={(e) => setFreeze({ ...freeze, sourceLabel: e.target.value })}
                  placeholder="Bloomberg ECOS / Econoday"
                />
              </div>
              <div>
                <label>FedWatch</label>
                <input
                  value={freeze.fedWatchSnapshot}
                  onChange={(e) => setFreeze({ ...freeze, fedWatchSnapshot: e.target.value })}
                  placeholder="hold % / +25 bp %"
                />
              </div>
            </div>
            <div className="contracts">
              {(["MES", "ZN", "M6E", "SR3"] as const).map((k) => (
                <div key={k}>
                  <label>{k}</label>
                  <input
                    value={freeze.liquidContracts[k]}
                    onChange={(e) =>
                      setFreeze({
                        ...freeze,
                        liquidContracts: { ...freeze.liquidContracts, [k]: e.target.value },
                      })
                    }
                    placeholder={`${k} volume-leading`}
                  />
                </div>
              ))}
            </div>
            <div className="kv">
              <div className="k">freeze stamp</div>
              <div className="mono">{freeze.freezeTimestamp ?? "—"}</div>
              <div className="k">knowledge_time</div>
              <div className="mono">{state.knowledgeTime ?? "—"}</div>
            </div>
            <div className="btns">
              <button
                className="good"
                onClick={() => post("/api/freeze", freeze, "PUT")}
              >
                Save freeze {freezeDirty ? "*" : ""}
              </button>
              <button onClick={() => post("/api/knowledge-time")}>Stamp knowledge time</button>
            </div>
            {CHECKLIST_LABELS.map(({ key, label }) => {
              const v = (state.checklist as Checklist)[key];
              return (
                <div className="check" key={key}>
                  <span>{label}</span>
                  <span className="btns">
                    <button
                      className={`tiny pass ${v === true ? "active" : ""}`}
                      onClick={() => post("/api/checklist", { [key]: true })}
                    >
                      Pass
                    </button>
                    <button
                      className={`tiny fail ${v === false ? "active" : ""}`}
                      onClick={() => post("/api/checklist", { [key]: false })}
                    >
                      Fail
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel">
          <h2>Broker</h2>
          <div className="body">
            {state.broker.liveRefused && <div className="err">LIVE REFUSED — no orders sent</div>}
            {state.broker.stubNote && <div className="warn">{state.broker.stubNote}</div>}
            <div className="kv">
              <div className="k">account</div>
              <div>{state.broker.account} · {state.broker.mode}</div>
              <div className="k">daily loss</div>
              <div>
                <input
                  defaultValue={state.dailyLossUsd}
                  key={state.dailyLossUsd}
                  onBlur={(e) => post("/api/daily-loss", { dailyLossUsd: Number(e.target.value) })}
                />
              </div>
              <div className="k">qty cap</div>
              <div>{state.qtyCap}</div>
              <div className="k">day P&amp;L</div>
              <div>
                <input
                  defaultValue={state.broker.dayPnl}
                  key={state.broker.dayPnl}
                  onBlur={(e) => post("/api/day-pnl", { dayPnl: Number(e.target.value) })}
                />
              </div>
            </div>
            <label>Working orders</label>
            <table>
              <thead>
                <tr>
                  <th>Sym</th>
                  <th>Type</th>
                  <th>Side</th>
                  <th>Qty</th>
                  <th>St</th>
                </tr>
              </thead>
              <tbody>
                {working.slice(-16).map((o) => (
                  <tr key={o.id}>
                    <td>{o.symbol}</td>
                    <td>{o.type}</td>
                    <td>{o.side}</td>
                    <td>{o.qty}</td>
                    <td className={o.state === "Cancelled" ? "err" : "ok"}>{o.state}</td>
                  </tr>
                ))}
                {working.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">none</td>
                  </tr>
                )}
              </tbody>
            </table>
            <label>Positions</label>
            <table>
              <thead>
                <tr>
                  <th>Sym</th>
                  <th>Side</th>
                  <th>Qty</th>
                  <th>uPnL</th>
                </tr>
              </thead>
              <tbody>
                {state.broker.positions.map((p) => (
                  <tr key={p.id}>
                    <td>{p.symbol}</td>
                    <td>{p.side}</td>
                    <td>{p.qty}</td>
                    <td>{p.unrealizedPnl}</td>
                  </tr>
                ))}
                {state.broker.positions.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">flat</td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="btns">
              <button className="danger" onClick={() => post("/api/flatten")}>Flatten sleeve</button>
              <button onClick={() => post("/api/cancel-stops")}>Cancel market/stops</button>
            </div>
            <label>Inject stop (watch the gate cancel it — not a directional entry)</label>
            <div className="inject">
              <input value={inject.symbol} onChange={(e) => setInject({ ...inject, symbol: e.target.value })} />
              <select value={inject.type} onChange={(e) => setInject({ ...inject, type: e.target.value })}>
                {["StopMarket", "StopLimit", "Market", "MIT", "Limit"].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <select value={inject.side} onChange={(e) => setInject({ ...inject, side: e.target.value })}>
                <option>Buy</option>
                <option>Sell</option>
              </select>
              <input value={inject.qty} onChange={(e) => setInject({ ...inject, qty: e.target.value })} />
              <button
                onClick={() =>
                  post("/api/mock/inject-stop", {
                    symbol: inject.symbol,
                    type: inject.type,
                    side: inject.side,
                    qty: Number(inject.qty),
                    stopPrice: Number(inject.stopPrice),
                  })
                }
              >
                Inject stop
              </button>
            </div>
            <label>Gated roots</label>
            <div className="roots">
              {state.gatedRoots.map((r) => (
                <span key={r} className="mono">{r}</span>
              ))}
            </div>
            <div className="hint">Paper buy/sell is MockBroker only. Live Tradovate stays off. Flatten sleeve + gate still bind the day book.</div>
          </div>
        </section>
      </div>

      <div className="blotter-wrap">
        <PaperBlotter
          sleeveId="day"
          fills={state.paperBlotter ?? []}
          quotes={quotes}
          apply={apply}
          setAuthNeeded={setAuthNeeded}
          setErr={setErr}
        />
      </div>

      <div className="log-wrap">
        <h2>[EventGate] log</h2>
        <div className="log">
          {[...state.actionLog].slice(-200).reverse().map((e, i) => (
            <div key={i}>{e.ts}  {e.message}</div>
          ))}
          {state.actionLog.length === 0 && <div className="muted">empty</div>}
        </div>
        {err && <div className="err" style={{ padding: "4px 14px" }}>{err}</div>}
      </div>
      </>
      )}

      {tab !== "day" && sleeveDraft && (
        <div className="sleeve-grid">
          {(tab === "momentum" || tab === "ownership") && (
            <ScanPanel
              sleeve={tab as ScanSleeve}
              setAuthNeeded={setAuthNeeded}
              setErr={setErr}
              onPaperThis={(row: ScanRow) => {
                const pct = tab === "momentum" ? 0.015 : 0.02;
                setPaperPrefill({
                  symbol: row.symbol,
                  stopPrice: String(Number((row.last * (1 - pct)).toFixed(4))),
                  side: "Buy",
                  thesis: row.why,
                  key: Date.now(),
                });
              }}
            />
          )}
          <section className="panel">
            <h2>{sleeveDraft.name}</h2>
            <div className="body">
              <QuoteStrip quotes={quotes} />
              <PaperBanner />
              {tab === "options" || tab === "riskoff" ? (
                <OptionsPanel
                  key={tab}
                  sleeveId={tab}
                  defaultRight={tab === "riskoff" ? "P" : "C"}
                  showOverlay={tab === "options"}
                  positions={state.broker.positions}
                  equityUsd={state.sleeveBooks?.[tab]?.equityUsd ?? 100_000}
                  apply={apply}
                  setAuthNeeded={setAuthNeeded}
                  setErr={setErr}
                />
              ) : (
                <>
                  <PaperTradeRow
                    sleeveId={tab}
                    quotes={quotes}
                    positions={state.broker.positions}
                    orders={state.broker.orders}
                    apply={apply}
                    setAuthNeeded={setAuthNeeded}
                    setErr={setErr}
                    prefill={paperPrefill}
                  />
                  {tab === "ownership" ? (
                    <OwnershipOverlayNote positions={state.broker.positions} />
                  ) : null}
                </>
              )}
              <div className="hint">
                {tab === "options"
                  ? "Paper debit verticals on MockBroker. Massive Starter chain (15m delayed). Not live."
                  : tab === "riskoff"
                    ? "Paper put debit verticals plus one GLD/UUP/BIL ETF long on MockBroker when RISK OFF. Massive delayed dailies for the ETF RS. Not live. Day book is not gated by this sleeve."
                    : "Paper buy/sell fills at delayed last on MockBroker. Iterate from fills. Not live."}
              </div>
              <div className="kv">
                <div className="k">horizon</div>
                <div>
                  <input
                    value={sleeveDraft.horizon}
                    onChange={(e) => setSleeveDraft({ ...sleeveDraft, horizon: e.target.value })}
                  />
                </div>
                <div className="k">budget %</div>
                <div>
                  <input
                    type="number"
                    value={sleeveDraft.budgetPct}
                    onChange={(e) =>
                      setSleeveDraft({ ...sleeveDraft, budgetPct: Number(e.target.value) })
                    }
                  />
                </div>
                <div className="k">loss cap $</div>
                <div>
                  <input
                    type="number"
                    value={sleeveDraft.lossCapUsd}
                    onChange={(e) =>
                      setSleeveDraft({ ...sleeveDraft, lossCapUsd: Number(e.target.value) })
                    }
                  />
                </div>
                <div className="k">status</div>
                <div>
                  <select
                    value={sleeveDraft.status}
                    onChange={(e) =>
                      setSleeveDraft({
                        ...sleeveDraft,
                        status: e.target.value as SleeveCard["status"],
                      })
                    }
                  >
                    {SLEEVE_STATUSES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
              <label>Thesis</label>
              <textarea
                value={sleeveDraft.thesis}
                onChange={(e) => setSleeveDraft({ ...sleeveDraft, thesis: e.target.value })}
                placeholder="What has to be true"
              />
              <label>Macro drivers</label>
              <textarea
                value={sleeveDraft.macroDrivers}
                onChange={(e) => setSleeveDraft({ ...sleeveDraft, macroDrivers: e.target.value })}
              />
              <label>Micro drivers</label>
              <textarea
                value={sleeveDraft.microDrivers}
                onChange={(e) => setSleeveDraft({ ...sleeveDraft, microDrivers: e.target.value })}
              />
              <label>Instruments</label>
              <input
                value={sleeveDraft.instruments}
                onChange={(e) => setSleeveDraft({ ...sleeveDraft, instruments: e.target.value })}
              />
              <label>Structure</label>
              <textarea
                value={sleeveDraft.structure}
                onChange={(e) => setSleeveDraft({ ...sleeveDraft, structure: e.target.value })}
              />
              <label>Kill rules</label>
              <textarea
                value={sleeveDraft.killRules}
                onChange={(e) => setSleeveDraft({ ...sleeveDraft, killRules: e.target.value })}
              />
              <label>Paper stats</label>
              <div className="stats-row">
                <div>
                  <label>Trades</label>
                  <input
                    type="number"
                    value={sleeveDraft.paper.trades}
                    onChange={(e) =>
                      setSleeveDraft({
                        ...sleeveDraft,
                        paper: { ...sleeveDraft.paper, trades: Number(e.target.value) },
                      })
                    }
                  />
                </div>
                <div>
                  <label>Wins</label>
                  <input
                    type="number"
                    value={sleeveDraft.paper.wins}
                    onChange={(e) =>
                      setSleeveDraft({
                        ...sleeveDraft,
                        paper: { ...sleeveDraft.paper, wins: Number(e.target.value) },
                      })
                    }
                  />
                </div>
                <div>
                  <label>Losses</label>
                  <input
                    type="number"
                    value={sleeveDraft.paper.losses}
                    onChange={(e) =>
                      setSleeveDraft({
                        ...sleeveDraft,
                        paper: { ...sleeveDraft.paper, losses: Number(e.target.value) },
                      })
                    }
                  />
                </div>
                <div>
                  <label>Realized P&amp;L</label>
                  <input
                    type="number"
                    value={sleeveDraft.paper.realizedPnlUsd}
                    onChange={(e) =>
                      setSleeveDraft({
                        ...sleeveDraft,
                        paper: { ...sleeveDraft.paper, realizedPnlUsd: Number(e.target.value) },
                      })
                    }
                  />
                </div>
              </div>
              <label>Notes</label>
              <textarea
                value={sleeveDraft.paper.notes}
                onChange={(e) =>
                  setSleeveDraft({
                    ...sleeveDraft,
                    paper: { ...sleeveDraft.paper, notes: e.target.value },
                  })
                }
                placeholder="fills you recorded by hand"
              />
              <div className="kv">
                <div className="k">updated</div>
                <div className="mono">{sleeveDraft.updatedAt ?? "—"}</div>
              </div>
              <div className="btns">
                <button
                  className="good"
                  type="button"
                  onClick={async () => {
                    try {
                      const s = (await api(`/api/sleeves/${sleeveDraft.id}`, {
                        method: "PUT",
                        body: JSON.stringify(sleeveDraft),
                      })) as StatusSnapshot;
                      apply(s);
                      const next = s.sleeves?.[sleeveDraft.id];
                      if (next) setSleeveDraft({ ...next, paper: { ...next.paper } });
                      setErr(null);
                    } catch (e: any) {
                      if (e.status === 401) setAuthNeeded(true);
                      else setErr(e.message);
                    }
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </section>
          <div className="blotter-wrap">
            <PaperBlotter
              sleeveId={tab}
              fills={state.paperBlotter ?? []}
              quotes={quotes}
              apply={apply}
              setAuthNeeded={setAuthNeeded}
              setErr={setErr}
            />
          </div>
        </div>
      )}
      {err && tab !== "day" && <div className="err" style={{ padding: "4px 14px" }}>{err}</div>}
    </div>
  );
}
