import type {
  AutoPaperBySleeve,
  MarketSession,
  Position,
  SleeveBook,
  SleeveId,
  StatusSnapshot,
} from "../../shared/types";
import { anyAutoPaperOn, defaultAutoPaperBySleeve } from "../../shared/types";
import { etParts } from "../../shared/clock";
import { marketSessionBanner } from "../../shared/marketSession";

export { marketSessionBanner };
export type { MarketSession };

/** Phone / small-tablet cutoff. Desktop layout stays as-is above this. */
export const ESSENTIALS_MAX_WIDTH_PX = 767;

/** Narrow width, or a coarse-pointer landscape phone (short height). `/m` always wins. */
export const ESSENTIALS_MEDIA_QUERY = `(max-width: ${ESSENTIALS_MAX_WIDTH_PX}px), (max-height: 540px) and (pointer: coarse)`;

export const SLEEVE_TAB_LABELS: { id: SleeveId; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "momentum", label: "Momentum" },
  { id: "options", label: "Options" },
  { id: "ownership", label: "Ownership" },
  { id: "riskoff", label: "Risk-off" },
];

/** Compact AUTO PAPER chip initials (desktop header + mobile essentials). */
export const AUTO_SLEEVE_CHIPS: { id: SleeveId; initial: string; label: string }[] = [
  { id: "day", initial: "D", label: "Day" },
  { id: "momentum", initial: "M", label: "Momentum" },
  { id: "options", initial: "O", label: "Options" },
  { id: "ownership", initial: "Ow", label: "Ownership" },
  { id: "riskoff", initial: "R", label: "Risk-off" },
];

/** Prefer per-sleeve flags; fall back to the derived/global boolean for old snapshots. */
export function autoPaperFlags(
  s: Pick<StatusSnapshot, "autoPaper" | "autoPaperBySleeve">,
): AutoPaperBySleeve {
  const raw = s.autoPaperBySleeve;
  if (raw && typeof raw === "object") {
    return { ...defaultAutoPaperBySleeve(false), ...raw };
  }
  return defaultAutoPaperBySleeve(s.autoPaper !== false);
}

export function autoPaperAnyOn(
  s: Pick<StatusSnapshot, "autoPaper" | "autoPaperBySleeve">,
): boolean {
  return anyAutoPaperOn(autoPaperFlags(s));
}

export function pathWantsEssentials(pathname: string): boolean {
  const path = pathname.split("?")[0].split("#")[0];
  return path === "/m" || path.startsWith("/m/");
}

export function essentialsViewActive(pathname: string, narrowViewport: boolean): boolean {
  return pathWantsEssentials(pathname) || narrowViewport;
}

export function gateModeClass(mode: string): string {
  if (mode === "PRE-ARM") return "pre";
  if (mode === "NO-STOP BAND") return "band";
  if (mode === "SESSION FLATTEN") return "flat";
  return "idle";
}

export function formatPnlUsd(n: number): string {
  const abs = Math.abs(n).toFixed(2);
  if (n > 0) return `+$${abs}`;
  if (n < 0) return `-$${abs}`;
  return `$${abs}`;
}

export function formatPnlPct(pnl: number, equity: number): string {
  if (!Number.isFinite(equity) || equity === 0) return "";
  const start = equity - pnl;
  if (!Number.isFinite(start) || start === 0) return "";
  const pct = (pnl / start) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

/** Same SPY/ACWI/HYG/UUP reasons as the desktop badge, without the day-book footnote. */
export function riskWhyLine(s: StatusSnapshot): string {
  const c = s.riskChecks;
  if (!c) return "SPY/ACWI/HYG 200dma + UUP 20d";
  if (s.riskOn) {
    const uup =
      c.uup20dPct === null || !Number.isFinite(c.uup20dPct)
        ? "UUP 20d n/a"
        : `UUP 20d ${(c.uup20dPct * 100).toFixed(1)}%`;
    return `SPY/ACWI/HYG above 200dma · ${uup}`;
  }
  const failed: string[] = [];
  const above = (label: string, value: boolean | null) => {
    if (value === false) failed.push(`${label} below 200dma`);
    else if (value === null) failed.push(`${label} 200dma missing`);
  };
  above("SPY", c.spyAbove200);
  above("ACWI", c.acwiAbove200);
  above("HYG", c.hygAbove200);
  if (c.dollarVeto) {
    failed.push(
      c.uup20dPct === null || !Number.isFinite(c.uup20dPct)
        ? "UUP 20d missing (dollar veto)"
        : `UUP 20d ${(c.uup20dPct * 100).toFixed(1)}% (dollar veto)`,
    );
  }
  return failed.join(" · ") || "risk-off";
}

export function riskBadgeTitle(s: StatusSnapshot): string {
  const note = "Does not bind the day book.";
  if (!s.riskChecks) return `Risk gate (SPY/ACWI/HYG 200dma, UUP 20d veto). ${note}`;
  return `${riskWhyLine(s)}. ${note}`;
}

function belongsToSleeve(sleeveId: SleeveId, tagged?: SleeveId): boolean {
  if (tagged === sleeveId) return true;
  if (!tagged && sleeveId === "day") return true;
  return false;
}

export function sleeveOpenHint(
  sleeveId: SleeveId,
  positions: Position[] | undefined,
): string | null {
  if (!positions?.length) return null;
  const open = positions.filter(
    (p) => p.side !== "Flat" && p.qty > 0 && belongsToSleeve(sleeveId, p.sleeveId),
  );
  if (open.length === 0) return null;
  const lots = open.reduce((n, p) => n + p.qty, 0);
  return lots === open.length ? `${open.length} open` : `${open.length} open · ${lots} lots`;
}

export type SleevePnlRow = {
  id: SleeveId;
  label: string;
  daily: number;
  total: number;
  equity: number;
  hint: string | null;
};

export function sleevePnlRows(
  books: Record<SleeveId, SleeveBook> | undefined,
  positions?: Position[],
): SleevePnlRow[] {
  return SLEEVE_TAB_LABELS.map((t) => {
    const book = books?.[t.id];
    const total = book?.totalPnlUsd ?? book?.pnlUsd ?? 0;
    const daily = book?.dailyPnlUsd ?? 0;
    const equity = book?.equityUsd ?? 100_000;
    return {
      id: t.id,
      label: t.label,
      daily,
      total,
      equity,
      hint: sleeveOpenHint(t.id, positions),
    };
  });
}

export const FLATTEN_CONFIRM =
  "Flatten gated paper positions? This is the print-day / emergency veto (MockBroker, not live).";

export const STAGE3_ARMED_LABEL = "Stage-3 armed (auto)";
export const STAGE3_NOT_ARMED_LABEL = "Stage-3 not armed";

function sameEtCalendarDay(a: Date, b: Date): boolean {
  const pa = etParts(a);
  const pb = etParts(b);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

/** Display twin of server `dayStochArmed`: same ET day and now at or after the stamp. */
export function stage3Armed(now: Date, knowledgeTime: string | null | undefined): boolean {
  if (!knowledgeTime) return false;
  const kt = Date.parse(knowledgeTime);
  if (!Number.isFinite(kt)) return false;
  if (now.getTime() < kt) return false;
  return sameEtCalendarDay(now, new Date(kt));
}

export function stage3Line(now: Date, knowledgeTime: string | null | undefined): string {
  return stage3Armed(now, knowledgeTime) ? STAGE3_ARMED_LABEL : STAGE3_NOT_ARMED_LABEL;
}

export function snapshotNow(state: Pick<StatusSnapshot, "clock"> | null | undefined): Date {
  const raw = state?.clock?.nowUtc;
  if (raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return new Date(t);
  }
  return new Date();
}

export function marketSessionLine(
  s: Pick<StatusSnapshot, "marketSession"> | null | undefined,
): string | null {
  if (!s?.marketSession) return null;
  return marketSessionBanner(s.marketSession);
}
