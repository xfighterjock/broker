import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  CHECKLIST_LABELS,
  defaultSleeves,
  emptyFreeze,
  SLEEVE_STATUSES,
  type Checklist,
  type FreezeCard,
  type SleeveCard,
  type SleeveId,
  type StatusSnapshot,
} from "../../shared/types";
import { api } from "./api";

const TAB_LABELS: { id: SleeveId; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "momentum", label: "Momentum" },
  { id: "options", label: "Options" },
  { id: "ownership", label: "Ownership" },
];

function modeClass(mode: string): string {
  if (mode === "PRE-ARM") return "pre";
  if (mode === "NO-STOP BAND") return "band";
  if (mode === "SESSION FLATTEN") return "flat";
  return "idle";
}

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

  const working = state.broker.orders.filter(
    (o) => o.state === "Working" || o.state === "Submitted" || o.state === "Accepted" || o.state === "Cancelled",
  );

  return (
    <div className="app">
      <header className="top">
        <div className="brand">EVENT GATE</div>
        <span className="sep">|</span>
        <div className="sim">SIMULATION · {state.broker.name.toUpperCase()}</div>
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
      </header>

      <nav className="tabs">
        {TAB_LABELS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
            type="button"
          >
            {t.label}
          </button>
        ))}
      </nav>

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
            <div className="hint">No buy/sell/EnterLong from this app. Paper only.</div>
          </div>
        </section>
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
          <section className="panel">
            <h2>{sleeveDraft.name}</h2>
            <div className="body">
              <div className="hint">
                Paper only. No buy/sell from this app. Iterate from fills you record here.
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
        </div>
      )}
    </div>
  );
}
