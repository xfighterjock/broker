import { useEffect, useMemo, useState } from "react";
import { OPTIONS_MULTIPLIER, RISKOFF_ETF_SYMBOLS } from "../../shared/constants";
import type {
  OptionChainSnapshot,
  OptionExpiry,
  OptionLeg,
  OptionRight,
  OverlayThesisSleeve,
  Position,
  SleeveId,
  StatusSnapshot,
} from "../../shared/types";
import { api } from "./api";

function fmt(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(d);
}

function fmtUsd(n: number): string {
  const abs = Math.abs(n).toFixed(2);
  if (n > 0) return `+$${abs}`;
  if (n < 0) return `-$${abs}`;
  return `$${abs}`;
}

function dte(expiry: string, asOf: string): number | null {
  const em = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!em) return null;
  const now = new Date(asOf);
  if (Number.isNaN(now.getTime())) return null;
  const exp = Date.UTC(Number(em[1]), Number(em[2]) - 1, Number(em[3]));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((exp - today) / 86_400_000);
}

type StrikeRow = { strike: number; call?: OptionLeg; put?: OptionLeg };

function rowsFromChain(chain: OptionChainSnapshot | null): StrikeRow[] {
  if (!chain) return [];
  const by = new Map<number, StrikeRow>();
  for (const leg of chain.legs) {
    const row = by.get(leg.strike) ?? { strike: leg.strike };
    if (leg.right === "C") row.call = leg;
    else row.put = leg;
    by.set(leg.strike, row);
  }
  return [...by.values()].sort((a, b) => a.strike - b.strike);
}

const HINT =
  "Massive Starter chain (DELAYED 15m). Paper debit verticals on MockBroker. Never a live send.";

export function OptionsPanel({
  positions,
  equityUsd,
  apply,
  setAuthNeeded,
  setErr,
  sleeveId = "options",
  defaultRight = "C",
  showOverlay = true,
}: {
  positions: Position[];
  equityUsd: number;
  apply: (s: StatusSnapshot) => void;
  setAuthNeeded: (v: boolean) => void;
  setErr: (v: string | null) => void;
  sleeveId?: SleeveId;
  defaultRight?: OptionRight;
  showOverlay?: boolean;
}) {
  const putsOnly = sleeveId === "riskoff";
  const [symbol, setSymbol] = useState("SPY");
  const [symbolDraft, setSymbolDraft] = useState("SPY");
  const [expiries, setExpiries] = useState<OptionExpiry[]>([]);
  const [expiry, setExpiry] = useState("");
  const [chain, setChain] = useState<OptionChainSnapshot | null>(null);
  const [right, setRight] = useState<OptionRight>(putsOnly ? "P" : defaultRight);
  const [longStrike, setLongStrike] = useState("");
  const [shortStrike, setShortStrike] = useState("");
  const [qty, setQty] = useState("");
  const [thesis, setThesis] = useState("");
  const [loading, setLoading] = useState(false);
  const [overlayStrike, setOverlayStrike] = useState("");
  const [overlayQty, setOverlayQty] = useState("1");
  const [thesisSleeve, setThesisSleeve] = useState<OverlayThesisSleeve>("ownership");
  const [taLevel, setTaLevel] = useState("");
  const [allowWeekly, setAllowWeekly] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const body = (await api(`/api/options/expiries?symbol=${symbol}`)) as {
          expiries: OptionExpiry[];
        };
        if (cancel) return;
        const list = body.expiries ?? [];
        setExpiries(list);
        setExpiry((cur) => {
          if (cur && list.some((e) => e.expiry === cur)) return cur;
          return list[0]?.expiry ?? "";
        });
        setErr(null);
      } catch (e: any) {
        if (cancel) return;
        if (e.status === 401) setAuthNeeded(true);
        else setErr(e.message);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [symbol, setAuthNeeded, setErr]);

  useEffect(() => {
    if (!expiry) {
      setChain(null);
      return;
    }
    let cancel = false;
    (async () => {
      setLoading(true);
      try {
        const body = (await api(
          `/api/options/chain?symbol=${symbol}&expiry=${expiry}`,
        )) as OptionChainSnapshot;
        if (cancel) return;
        setChain(body);
        setErr(null);
      } catch (e: any) {
        if (cancel) return;
        if (e.status === 401) setAuthNeeded(true);
        else setErr(e.message);
        setChain(null);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [symbol, expiry, setAuthNeeded, setErr]);

  const rows = useMemo(() => rowsFromChain(chain), [chain]);
  const strikes = rows.map((r) => r.strike);

  useEffect(() => {
    if (!strikes.length) return;
    if (!longStrike || !strikes.includes(Number(longStrike))) {
      setLongStrike(String(strikes[0]));
    }
    if (!shortStrike || !strikes.includes(Number(shortStrike))) {
      setShortStrike(String(strikes[Math.min(1, strikes.length - 1)]));
    }
    if (!overlayStrike || !strikes.includes(Number(overlayStrike))) {
      setOverlayStrike(String(strikes[0]));
    }
  }, [strikes.join(","), longStrike, shortStrike, overlayStrike]);

  const ticketRight: OptionRight = putsOnly ? "P" : right;
  const long = chain?.legs.find(
    (l) => l.right === ticketRight && Math.abs(l.strike - Number(longStrike)) < 1e-6,
  );
  const short = chain?.legs.find(
    (l) => l.right === ticketRight && Math.abs(l.strike - Number(shortStrike)) < 1e-6,
  );
  const debitPer = long?.ask != null && short?.bid != null ? long.ask - short.bid : null;
  const width =
    Number.isFinite(Number(longStrike)) && Number.isFinite(Number(shortStrike))
      ? Math.abs(Number(shortStrike) - Number(longStrike))
      : null;
  const qtyN = qty.trim() ? Number(qty) : NaN;
  const estQty = Number.isInteger(qtyN) && qtyN >= 1 ? qtyN : 1;
  const estDebit = debitPer !== null && debitPer > 0 ? debitPer * OPTIONS_MULTIPLIER * estQty : null;
  const estMaxProfit =
    debitPer !== null && width !== null && debitPer > 0 && width > debitPer
      ? (width - debitPer) * OPTIONS_MULTIPLIER * estQty
      : null;

  const open = positions.filter(
    (p) => p.side !== "Flat" && p.qty > 0 && p.sleeveId === sleeveId && p.vertical,
  );
  const etfOpen = positions.filter(
    (p) =>
      p.side !== "Flat" &&
      p.qty > 0 &&
      p.sleeveId === sleeveId &&
      !p.vertical &&
      !p.overlay,
  );
  const overlays = positions.filter(
    (p) => p.side !== "Flat" && p.qty > 0 && p.sleeveId === "options" && p.overlay,
  );

  async function paperBuy() {
    try {
      const body: Record<string, unknown> = {
        sleeveId,
        symbol,
        right: ticketRight,
        expiry,
        longStrike: Number(longStrike),
        shortStrike: Number(shortStrike),
        thesis,
      };
      if (qty.trim()) body.qty = Number(qty);
      const s = (await api("/api/paper/vertical", {
        method: "POST",
        body: JSON.stringify(body),
      })) as StatusSnapshot;
      apply(s);
      setErr(null);
    } catch (e: any) {
      if (e.status === 401) setAuthNeeded(true);
      else setErr(e.message);
    }
  }

  async function closeVertical(symbolToClose: string) {
    try {
      const s = (await api("/api/paper/close", {
        method: "POST",
        body: JSON.stringify({ sleeveId, symbol: symbolToClose, reason: "manual" }),
      })) as StatusSnapshot;
      apply(s);
      setErr(null);
    } catch (e: any) {
      if (e.status === 401) setAuthNeeded(true);
      else setErr(e.message);
    }
  }

  async function paperOverlay(kind: "csp" | "covered-call") {
    try {
      const path = kind === "csp" ? "/api/paper/csp" : "/api/paper/covered-call";
      const s = (await api(path, {
        method: "POST",
        body: JSON.stringify({
          sleeveId: "options",
          symbol,
          expiry,
          strike: Number(overlayStrike),
          qty: Number(overlayQty),
          thesisSleeve,
          thesisSymbol: symbol,
          taLevel,
          allowWeekly,
          thesis: `${kind} ${thesisSleeve}${taLevel ? " TA " + taLevel : ""}`.trim(),
        }),
      })) as StatusSnapshot;
      apply(s);
      setErr(null);
    } catch (e: any) {
      if (e.status === 401) setAuthNeeded(true);
      else setErr(e.message);
    }
  }

  return (
    <section className="panel options-panel">
      <h2>
        {putsOnly ? "Put debit vertical" : "Debit vertical"}
        <span className="badge delayed">DELAYED · MOCK</span>
        {chain && (
          <span className="muted scan-asof">
            chain {chain.underlying} {chain.expiry} ({chain.source})
          </span>
        )}
      </h2>
      <div className="body">
        <div className="hint">
          {putsOnly
            ? "Massive Starter chain (DELAYED 15m). Paper put debit verticals on MockBroker (SPY/QQQ/IWM after SPY 200dma break; HYG when credit is the broken leg). The defensive ETF long (GLD/UUP/TLT/IEF/XLU/XLP vs BIL) is a separate sleeve position when RISK OFF. Never a live send."
            : HINT}
        </div>
        <div className="paper-form options-form">
          <div>
            <label>Underlyer</label>
            <input
              value={symbolDraft}
              onChange={(e) => setSymbolDraft(e.target.value.toUpperCase())}
              onBlur={() => {
                const t = symbolDraft.trim().toUpperCase() || "SPY";
                setSymbolDraft(t);
                setSymbol(t);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const t = symbolDraft.trim().toUpperCase() || "SPY";
                  setSymbolDraft(t);
                  setSymbol(t);
                }
              }}
              placeholder="SPY"
              spellCheck={false}
            />
          </div>
          <div>
            <label>Expiry</label>
            <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              {expiries.map((e) => (
                <option key={e.expiry} value={e.expiry}>
                  {e.expiry}
                  {e.expiryType ? ` ${e.expiryType}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Right</label>
            {putsOnly ? (
              <select value="P" disabled>
                <option value="P">Put debit</option>
              </select>
            ) : (
              <select value={right} onChange={(e) => setRight(e.target.value as OptionRight)}>
                <option value="C">Call debit</option>
                <option value="P">Put debit</option>
              </select>
            )}
          </div>
          <div>
            <label>Long strike</label>
            <select value={longStrike} onChange={(e) => setLongStrike(e.target.value)}>
              {strikes.map((s) => (
                <option key={`l${s}`}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Short strike</label>
            <select value={shortStrike} onChange={(e) => setShortStrike(e.target.value)}>
              {strikes.map((s) => (
                <option key={`s${s}`}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Qty (blank ≈ 1%)</label>
            <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="auto" />
          </div>
          <div>
            <label>Thesis</label>
            <input value={thesis} onChange={(e) => setThesis(e.target.value)} placeholder="why this spread" />
          </div>
          <button type="button" className="good" onClick={() => void paperBuy()}>
            Paper buy
          </button>
        </div>
        <div className="kv">
          <div className="k">est. debit</div>
          <div>{estDebit === null ? "—" : fmtUsd(estDebit)} (max loss)</div>
          <div className="k">max profit</div>
          <div>{estMaxProfit === null ? "—" : fmtUsd(estMaxProfit)}</div>
          <div className="k">width / debit</div>
          <div>
            {width ?? "—"} / {debitPer === null ? "—" : fmt(debitPer, 2)}
          </div>
        </div>
        <label>Chain {loading ? "…" : ""}</label>
        <div className="scan-table-wrap">
          <table className="opt-chain">
            <thead>
              <tr>
                <th>C bid</th>
                <th>C ask</th>
                <th>δ</th>
                <th>Strike</th>
                <th>P bid</th>
                <th>P ask</th>
                <th>δ</th>
                <th>OI</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.strike}
                  className={
                    String(r.strike) === longStrike || String(r.strike) === shortStrike
                      ? "active-row"
                      : ""
                  }
                >
                  <td className="mono">{fmt(r.call?.bid)}</td>
                  <td className="mono">{fmt(r.call?.ask)}</td>
                  <td className="mono">{fmt(r.call?.delta, 3)}</td>
                  <td className="mono">{r.strike}</td>
                  <td className="mono">{fmt(r.put?.bid)}</td>
                  <td className="mono">{fmt(r.put?.ask)}</td>
                  <td className="mono">{fmt(r.put?.delta, 3)}</td>
                  <td className="mono">{fmt(r.call?.openInterest ?? r.put?.openInterest, 0)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    {loading ? "loading chain…" : "no chain"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {putsOnly && (
          <>
            <label>{RISKOFF_ETF_SYMBOLS.join(" / ")} (one name)</label>
            <div className="hint">
              Autopilot holds whichever of GLD, UUP, TLT, IEF, XLU, or XLP has the strongest 63-session
              return vs BIL while RISK OFF. Sits in BIL (or cash) if they all trail T-bills. Flattened on
              RISK ON. Modest size so puts still have room.
            </div>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Shares</th>
                  <th>Avg</th>
                  <th>uPnL</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {etfOpen.map((p) => (
                  <tr key={p.id}>
                    <td>{p.symbol}</td>
                    <td>{p.qty}</td>
                    <td>{fmt(p.avgPrice)}</td>
                    <td>{fmtUsd(p.unrealizedPnl)}</td>
                    <td>
                      <button
                        type="button"
                        className="tiny danger"
                        onClick={() => void closeVertical(p.symbol)}
                      >
                        Close
                      </button>
                    </td>
                  </tr>
                ))}
                {etfOpen.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      cash
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        )}
        <label>Open verticals</label>
        <table>
          <thead>
            <tr>
              <th>Pkg</th>
              <th>Qty</th>
              <th>Debit</th>
              <th>MTM</th>
              <th>Max L / P</th>
              <th>DTE</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {open.map((p) => {
              const v = p.vertical!;
              const days = dte(v.expiry, v.asOf);
              return (
                <tr key={p.id}>
                  <td>{p.symbol}</td>
                  <td>{v.qty}</td>
                  <td>{fmtUsd(v.netDebitPaid)}</td>
                  <td>{fmtUsd(p.unrealizedPnl)}</td>
                  <td>
                    {fmtUsd(v.maxLoss)} / {fmtUsd(v.maxProfit)}
                  </td>
                  <td>{days === null ? "—" : days}</td>
                  <td>
                    <button type="button" className="tiny danger" onClick={() => void closeVertical(p.symbol)}>
                      Close
                    </button>
                  </td>
                </tr>
              );
            })}
            {open.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">flat</td>
              </tr>
            )}
          </tbody>
        </table>
{showOverlay && (
        <>
        <label>Ownership overlay (CSP / covered call)</label>
        <div className="hint">
          Paper only. Fill at bid. CSP reserves strike×100×qty on the options sleeve. Covered call needs matching long shares.
          Autopilot does not sell puts or calls. DELAYED / MOCK.
        </div>
        <div className="paper-form options-form overlay-form">
          <div>
            <label>Strike</label>
            <select value={overlayStrike} onChange={(e) => setOverlayStrike(e.target.value)}>
              {strikes.map((s) => (
                <option key={`o${s}`}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Qty</label>
            <input value={overlayQty} onChange={(e) => setOverlayQty(e.target.value)} />
          </div>
          <div>
            <label>Thesis sleeve</label>
            <select
              value={thesisSleeve}
              onChange={(e) => setThesisSleeve(e.target.value as OverlayThesisSleeve)}
            >
              <option value="ownership">ownership</option>
              <option value="spcx">spcx</option>
            </select>
          </div>
          <div>
            <label>TA level</label>
            <input value={taLevel} onChange={(e) => setTaLevel(e.target.value)} placeholder="after a TA level" />
          </div>
          <label className="overlay-weekly">
            <input
              type="checkbox"
              checked={allowWeekly}
              onChange={(e) => setAllowWeekly(e.target.checked)}
            />
            <span>allow weekly</span>
          </label>
          <button type="button" className="good" onClick={() => void paperOverlay("csp")}>
            Sell CSP
          </button>
          <button type="button" className="good" onClick={() => void paperOverlay("covered-call")}>
            Sell CC
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Pkg</th>
              <th>Kind</th>
              <th>Thesis</th>
              <th>Qty</th>
              <th>Prem</th>
              <th>MTM</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {overlays.map((p) => {
              const o = p.overlay!;
              return (
                <tr key={p.id}>
                  <td>{p.symbol}</td>
                  <td>{o.kind}</td>
                  <td>
                    {o.thesisSleeve}
                    {o.taLevel ? ` · TA ${o.taLevel}` : ""}
                    {` · ${o.thesisSymbol}`}
                  </td>
                  <td>{o.qty}</td>
                  <td>{fmtUsd(o.premiumReceived)}</td>
                  <td>{fmtUsd(p.unrealizedPnl)}</td>
                  <td>
                    <button type="button" className="tiny danger" onClick={() => void closeVertical(p.symbol)}>
                      Close
                    </button>
                  </td>
                </tr>
              );
            })}
            {overlays.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">no CSP / CC</td>
              </tr>
            )}
          </tbody>
        </table>
        </>
      )}
      </div>
    </section>
  );
}
