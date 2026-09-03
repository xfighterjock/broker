import { useEffect, useState, type ReactNode } from "react";
import type { SleeveId, StatusSnapshot } from "../../shared/types";
import { AutoPaperChips } from "./AutoPaperChips";
import {
  autoPaperAnyOn,
  autoPaperFlags,
  ESSENTIALS_MEDIA_QUERY,
  FLATTEN_CONFIRM,
  essentialsViewActive,
  formatPnlPct,
  formatPnlUsd,
  gateModeClass,
  riskWhyLine,
  sleevePnlRows,
} from "./essentials";

export function useEssentialsView(): boolean {
  const [narrow, setNarrow] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(ESSENTIALS_MEDIA_QUERY).matches;
  });
  const [path, setPath] = useState(() =>
    typeof window === "undefined" ? "/" : window.location.pathname,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(ESSENTIALS_MEDIA_QUERY);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => {
      mq.removeEventListener("change", onChange);
      window.removeEventListener("popstate", onPop);
    };
  }, []);

  return essentialsViewActive(path, narrow);
}

export function MobileEssentials({
  state,
  err,
  onToggleGate,
  onToggleAutoPaper,
  onToggleAutoSleeve,
  onFlatten,
  pin,
}: {
  state: StatusSnapshot;
  err?: string | null;
  onToggleGate: () => void;
  onToggleAutoPaper: () => void;
  onToggleAutoSleeve: (sleeveId: SleeveId, enabled: boolean) => void;
  onFlatten: () => void;
  pin?: ReactNode;
}) {
  const clock = state.clock;
  const mode = clock?.mode ?? "idle";
  const autoOn = autoPaperAnyOn(state);
  const rows = sleevePnlRows(state.sleeveBooks, state.broker.positions);

  function flatten() {
    if (typeof window !== "undefined" && !window.confirm(FLATTEN_CONFIRM)) return;
    onFlatten();
  }

  return (
    <div className="essentials">
      <header className="essentials-top">
        <div className="essentials-brand">EVENT GATE</div>
        <div className="sim">PAPER · MOCK</div>
        <div className="essentials-clock">{clock?.nowEt ?? "—"}</div>
      </header>

      {pin}

      <section className="essentials-summary" aria-label="session">
        <div className="essentials-summary-row">
          <span className={`badge ${gateModeClass(mode)}`}>{mode}</span>
          <span className={`badge ${state.gateEnabled ? "on" : "off"}`}>
            GATE {state.gateEnabled ? "ON" : "OFF"}
          </span>
        </div>
        <div className="essentials-meta">
          {state.broker.mode.toUpperCase()} · {state.broker.name}
          {clock?.focusEvent?.type ? ` · ${clock.focusEvent.type}` : ""}
          {clock?.countdownLabel ? ` · ${clock.countdownLabel}` : ""}
        </div>
      </section>

      <section
        className={`essentials-risk ${state.riskOn ? "risk-on" : "risk-off"}`}
        aria-label="risk gate"
      >
        <div className={`essentials-risk-badge ${state.riskOn ? "risk-on" : "risk-off"}`}>
          {state.riskOn ? "RISK ON" : "RISK OFF"}
        </div>
        <div className="essentials-risk-why">{riskWhyLine(state)}</div>
      </section>

      <section className="essentials-controls" aria-label="controls">
        <label className="essentials-toggle">
          <input
            type="checkbox"
            checked={state.gateEnabled}
            onChange={onToggleGate}
            aria-label="GATE ON/OFF"
          />
          <span className="switch" />
          <span className={`badge ${state.gateEnabled ? "on" : "off"}`}>
            GATE {state.gateEnabled ? "ON" : "OFF"}
          </span>
        </label>
        <label className="essentials-toggle">
          <input
            type="checkbox"
            checked={autoOn}
            onChange={onToggleAutoPaper}
            aria-label="AUTO PAPER on/off"
          />
          <span className="switch" />
          <span className={`badge ${autoOn ? "on" : "off"}`}>
            AUTO PAPER {autoOn ? "ON" : "OFF"}
          </span>
        </label>
        <AutoPaperChips
          flags={autoPaperFlags(state)}
          variant="essentials"
          onToggle={onToggleAutoSleeve}
        />
        <button type="button" className="essentials-flatten danger" onClick={flatten}>
          Flatten
        </button>
        <div className="hint">Print-day / emergency veto. Paper only.</div>
      </section>

      <section className="essentials-sleeves" aria-label="sleeve P/L">
        <h2>Sleeves</h2>
        <ul>
          {rows.map((row) => {
            const totalCls = row.total > 0 ? "ok" : row.total < 0 ? "err" : "muted";
            const dailyCls = row.daily > 0 ? "ok" : row.daily < 0 ? "err" : "muted";
            const pct = formatPnlPct(row.total, row.equity);
            return (
              <li key={row.id} data-sleeve={row.id}>
                <div className="essentials-sleeve-name">{row.label}</div>
                <div className="essentials-sleeve-pnl">
                  <span className={dailyCls}>d {formatPnlUsd(row.daily)}</span>
                  <span className={totalCls}>
                    tot {formatPnlUsd(row.total)}
                    {pct ? ` ${pct}` : ""}
                  </span>
                </div>
                {row.hint ? <div className="essentials-sleeve-hint muted">{row.hint}</div> : null}
              </li>
            );
          })}
        </ul>
      </section>

      {err ? <div className="err essentials-err">{err}</div> : null}
    </div>
  );
}
