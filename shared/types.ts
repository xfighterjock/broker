import { SLEEVE_IDS, type OrderType } from "./constants";
import type { MarketSession } from "./marketSession";

export type { MarketClosedReason, MarketSession } from "./marketSession";

export type GateMode = "idle" | "PRE-ARM" | "NO-STOP BAND" | "SESSION FLATTEN";

export interface CalendarEvent {
  id: string;
  timeUtc: string;
  type: string;
  flattenEt: string;
  label?: string;
}

export interface ClockSnapshot {
  nowUtc: string;
  nowEt: string;
  mode: GateMode;
  banner: boolean;
  nextEvent: CalendarEvent | null;
  activeEvent: CalendarEvent | null;
  focusEvent: CalendarEvent | null;
  countdownMs: number | null;
  countdownLabel: string;
  flattenEt: string | null;
  inPreArm: boolean;
  inBand: boolean;
  inSessionFlatten: boolean;
}

export type OrderState =
  | "Working"
  | "Submitted"
  | "Accepted"
  | "Cancelled"
  | "Filled"
  | "Rejected";

export type Side = "Buy" | "Sell";
export type PositionSide = "Long" | "Short" | "Flat";
export type SleeveId = "day" | "momentum" | "options" | "ownership" | "csp";

/** Independent AUTO PAPER flag per sleeve. */
export type AutoPaperBySleeve = Record<SleeveId, boolean>;

export function defaultAutoPaperBySleeve(allOn: boolean): AutoPaperBySleeve {
  return {
    day: allOn,
    momentum: allOn,
    options: allOn,
    ownership: allOn,
    csp: allOn,
  };
}

/** Snapshot `autoPaper` is true if ANY sleeve is on (badge / old clients). */
export function anyAutoPaperOn(flags: AutoPaperBySleeve): boolean {
  return SLEEVE_IDS.some((id) => flags[id] === true);
}

/**
 * Redis `paper:auto` was a global `0`/`1`. JSON is the current shape.
 * Missing/unknown → null (caller keeps its in-memory default).
 * Legacy `0` → all off including csp; `1` → all on including csp.
 * Partial JSON leaves omitted sleeves off so a half-written key cannot
 * silently re-enable day into a print, except `csp`: a missing `csp` key
 * defaults ON (first deploy and any payload that predates the sleeve).
 * A stored `riskoff` key is ignored and counts as a seen payload. Explicit
 * `csp: false` stays off.
 */
export function parseAutoPaperRedis(raw: string | null | undefined): AutoPaperBySleeve | null {
  if (raw == null || raw === "") return null;
  if (raw === "0") return defaultAutoPaperBySleeve(false);
  if (raw === "1") return defaultAutoPaperBySleeve(true);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const out = defaultAutoPaperBySleeve(false);
    let seen = false;
    if ("riskoff" in obj) seen = true;
    for (const id of SLEEVE_IDS) {
      if (!(id in obj)) continue;
      if (typeof obj[id] !== "boolean") return null;
      out[id] = obj[id];
      seen = true;
    }
    if (!seen) return null;
    if (!("csp" in obj)) out.csp = true;
    return out;
  } catch {
    return null;
  }
}

export function serializeAutoPaperBySleeve(flags: AutoPaperBySleeve): string {
  const out = {} as AutoPaperBySleeve;
  for (const id of SLEEVE_IDS) out[id] = flags[id] === true;
  return JSON.stringify(out);
}

export type AutoPaperPatch =
  | { kind: "all"; enabled: boolean }
  | { kind: "one"; sleeveId: SleeveId; enabled: boolean }
  | { kind: "batch"; sleeves: Partial<AutoPaperBySleeve> };

/**
 * POST /api/paper/auto body.
 * `{ sleeves }` wins, then `{ sleeveId, enabled }`, then `{ enabled }` (all sleeves).
 * Empty/`{}` matches the old global path: `Boolean(enabled)` → all off.
 */
export function parseAutoPaperBody(body: unknown): AutoPaperPatch | { error: string } {
  const src = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (src.sleeves && typeof src.sleeves === "object" && !Array.isArray(src.sleeves)) {
    const raw = src.sleeves as Record<string, unknown>;
    const sleeves: Partial<AutoPaperBySleeve> = {};
    let any = false;
    for (const id of SLEEVE_IDS) {
      if (!(id in raw)) continue;
      if (typeof raw[id] !== "boolean") {
        return { error: `sleeves.${id} must be boolean` };
      }
      sleeves[id] = raw[id];
      any = true;
    }
    if (!any) return { error: "sleeves must include at least one known sleeveId" };
    return { kind: "batch", sleeves };
  }
  if (typeof src.sleeveId === "string") {
    if (!(SLEEVE_IDS as readonly string[]).includes(src.sleeveId)) {
      return { error: "unknown sleeveId" };
    }
    if (!("enabled" in src)) return { error: "enabled is required with sleeveId" };
    return { kind: "one", sleeveId: src.sleeveId as SleeveId, enabled: Boolean(src.enabled) };
  }
  return { kind: "all", enabled: Boolean(src.enabled) };
}

export function applyAutoPaperPatch(
  current: AutoPaperBySleeve,
  patch: AutoPaperPatch,
): AutoPaperBySleeve {
  if (patch.kind === "all") return defaultAutoPaperBySleeve(patch.enabled);
  if (patch.kind === "one") return { ...current, [patch.sleeveId]: patch.enabled };
  return { ...current, ...patch.sleeves };
}

export interface WorkingOrder {
  id: string;
  symbol: string;
  root: string | null;
  type: OrderType;
  side: Side;
  qty: number;
  price?: number;
  stopPrice?: number;
  state: OrderState;
  gated: boolean;
  sleeveId?: SleeveId;
}

export interface Position {
  id: string;
  symbol: string;
  root: string | null;
  qty: number;
  side: PositionSide;
  avgPrice: number;
  unrealizedPnl: number;
  /**
   * Open-lot day P/L (blotter dPnL). Stock/futures: signed mark vs prior close.
   * Vertical/overlay: E*TRADE netChange × 100. Absent until the paper mark runs.
   * Not MockBroker.getDayPnl() / account `dayPnl`.
   */
  dayPnl?: number | null;
  gated: boolean;
  sleeveId?: SleeveId;
  /** Two-leg debit vertical on the options sleeve. Absent for stock/futures paper. */
  vertical?: VerticalMeta;
  /** Cash-secured put or covered call on the options sleeve (ownership overlay). */
  overlay?: OverlayMeta;
  /**
   * Paper risk-off gated duration long (TLT/IEF). Distinct from the 63d RS
   * overlay so the two programs do not flatten or rotate each other.
   */
  gatedDuration?: boolean;
  /**
   * Paper risk-off idle-cash T-bill sweep (BIL). Distinct from the 63d RS
   * overlay's own BIL leg so selection, hysteresis, and holds ignore it.
   */
  cashSweep?: boolean;
  /**
   * Day-sleeve CPI late-session fade (`cpiLateFade`). Not the MES stochastic
   * lot: the stoch leg does not manage it, and the 15:45 session flatten
   * does not take it. Blotter notes use the same strategy id.
   */
  cpiLateFade?: boolean;
  /** Cash-secured put on the csp sleeve. Paper / MockBroker only. */
  csp?: CspPutMeta;
  /** Shares assigned from a csp put. Sold next session; not a wheel. */
  cspAssigned?: CspAssignedMeta;
}

/** Short put held by the csp sleeve. Collateral is reservedUsd. */
export interface CspPutMeta {
  underlying: string;
  strike: number;
  expiry: string;
  entryPremium: number;
  contracts: number;
  reservedUsd: number;
  entryYmd: string;
  earningsDates?: string[] | null;
  swingLow: number | null;
  iv: number | null;
  delta: number | null;
  bid: number;
  ask: number;
  mid: number;
  openInterest: number | null;
  volume: number | null;
}

export interface CspAssignedMeta {
  fromPositionId: string;
  strike: number;
  expiry: string;
}

export interface FreezeCard {
  consensusObjects: string;
  sourceLabel: string;
  fedWatchSnapshot: string;
  liquidContracts: {
    MES: string;
    ZN: string;
    M6E: string;
    SR3: string;
  };
  freezeTimestamp: string | null;
}

export interface Checklist {
  freezeExisted: boolean | null;
  knowledgeTimeAfterPrint: boolean | null;
  noMarketOrders: boolean | null;
  killFlattenClicked: boolean | null;
  paperBidAskSeen: boolean | null;
}

export interface SessionLogEntry {
  ts: string;
  kind: string;
  message: string;
}

export interface ActionLogEntry {
  ts: string;
  message: string;
}

/** One row from GET /api/activity (gate_log / engine.log). Newest-first pages. */
export interface ActivityLogEntry {
  id: number;
  ts: string;
  message: string;
}

export interface ActivityLogPage {
  entries: ActivityLogEntry[];
  /** Pass as `before` to fetch the next older page. Null when hasMore is false. */
  nextBefore: number | null;
  hasMore: boolean;
}

export interface BrokerSnapshot {
  name: string;
  mode: "mock" | "demo";
  liveRefused: boolean;
  stubNote: string | null;
  orders: WorkingOrder[];
  positions: Position[];
  dayPnl: number;
  account: string;
}

export type GateAction =
  | { kind: "cancel"; orderId: string; reason: string }
  | { kind: "flatten"; symbol: string; reason: string }
  | { kind: "refuse"; reason: string }
  | { kind: "log"; message: string };

export const CHECKLIST_LABELS: { key: keyof Checklist; label: string }[] = [
  { key: "freezeExisted", label: "Freeze existed" },
  { key: "knowledgeTimeAfterPrint", label: "knowledge_time after print" },
  { key: "noMarketOrders", label: "No market orders" },
  { key: "killFlattenClicked", label: "Kill/flatten clicked" },
  { key: "paperBidAskSeen", label: "Paper bid/ask seen" },
];

export function emptyFreeze(): FreezeCard {
  return {
    consensusObjects: "",
    sourceLabel: "",
    fedWatchSnapshot: "",
    liquidContracts: { MES: "", ZN: "", M6E: "", SR3: "" },
    freezeTimestamp: null,
  };
}

export function emptyChecklist(): Checklist {
  return {
    freezeExisted: null,
    knowledgeTimeAfterPrint: null,
    noMarketOrders: null,
    killFlattenClicked: null,
    paperBidAskSeen: null,
  };
}

export type SleeveStatus = "idea" | "paper" | "promote" | "killed";

export const SLEEVE_STATUSES: readonly SleeveStatus[] = [
  "idea",
  "paper",
  "promote",
  "killed",
];

export interface PaperStats {
  trades: number;
  wins: number;
  losses: number;
  realizedPnlUsd: number;
  notes: string;
}

export interface SleeveCard {
  id: SleeveId;
  name: string;
  horizon: string;
  budgetPct: number; // book allocation hint
  lossCapUsd: number;
  thesis: string;
  macroDrivers: string;
  microDrivers: string;
  instruments: string;
  structure: string; // for options/ownership overlay
  killRules: string;
  status: SleeveStatus;
  paper: PaperStats;
  updatedAt: string | null;
}

export function emptyPaperStats(): PaperStats {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    realizedPnlUsd: 0,
    notes: "",
  };
}

export function defaultSleeves(): Record<SleeveId, SleeveCard> {
  return {
    day: {
      id: "day",
      name: "Day trading (events)",
      horizon: "intraday",
      budgetPct: 15,
      lossCapUsd: 500,
      thesis:
        "NFP / CPI / FOMC event gate plus MES 5m stochastic 14,3,3 momentum (VWAP filter). Flatten into the print.",
      macroDrivers: "Payrolls, CPI, FOMC statement/presser vs freeze card.",
      microDrivers:
        "MES 5m slow stochastic 14,3,3; longs above session VWAP, shorts below; GATE windows; 15:45 flatten. CPI-day cpiLateFade (CPI_LATE_FADE_ENABLED): fade the prior-close→10:30 MES move at 15:30, flat at the cash close.",
      instruments: "MES / ZN / M6E / SR3",
      structure:
        "Event clock + MES stochastic paper, plus a separate CPI-day cpiLateFade MES lot. Qty 1. MockBroker only.",
      killRules:
        "flatten 15:45 ET / 15:30 FOMC or -$500; GATE OFF / Flatten sleeve",
      status: "paper",
      paper: emptyPaperStats(),
      updatedAt: null,
    },
    momentum: {
      id: "momentum",
      name: "Short-term momentum",
      horizon: "days–weeks",
      budgetPct: 25,
      lossCapUsd: 1000,
      thesis: "",
      macroDrivers: "",
      microDrivers: "",
      instruments: "",
      structure: "",
      killRules: "thesis broken / time stop / sleeve loss cap",
      status: "idea",
      paper: emptyPaperStats(),
      updatedAt: null,
    },
    options: {
      id: "options",
      name: "Options (defined risk)",
      horizon: "days–months",
      budgetPct: 20,
      lossCapUsd: 1000,
      thesis: "",
      macroDrivers: "",
      microDrivers: "",
      instruments: "",
      structure: "debit verticals; CSP/CC overlay tagged to ownership — no naked short vol",
      killRules: "thesis broken / max debit lost / sleeve loss cap",
      status: "idea",
      paper: emptyPaperStats(),
      updatedAt: null,
    },
    csp: {
      id: "csp",
      name: "Cash-secured puts (oversold high-beta)",
      horizon: "days–months",
      budgetPct: 100,
      lossCapUsd: 10000,
      thesis:
        "Sell cash-secured puts on high-beta S&P 500 common stocks after a slow stochastic (30,5,5) cross up through %D while %K < 20 and the MACD histogram turns up. No 200-day filter. Trades in both RISK ON and RISK OFF.",
      macroDrivers: "None. The RISK ON/OFF badge does not gate this sleeve.",
      microDrivers:
        "Trailing 252-day beta to SPY > 1.3. Earnings between entry and expiry skip the name. 35–50 DTE, nearest 0.20 delta. 2x premium stop else hold to expiry.",
      instruments: "SPY",
      structure:
        "1+ cash-secured puts. Collateral strike×100×contracts plus assigned-share market value never exceeds sleeve equity. Max 10 positions. No naked short vol and no leverage.",
      killRules:
        "2× entry premium, earnings date inside the window, sleeve loss cap, GATE OFF / freeze for new entries, AUTO off. Exits still run when GATE is off.",
      status: "paper",
      paper: emptyPaperStats(),
      updatedAt: null,
    },
    ownership: {
      id: "ownership",
      name: "Longer-term ownership + overlay",
      horizon: "months+",
      budgetPct: 40,
      lossCapUsd: 2000,
      thesis: "",
      macroDrivers: "",
      microDrivers: "",
      instruments: "",
      structure: "stock + covered call or protective put",
      killRules: "thesis broken (not session clock)",
      status: "idea",
      paper: emptyPaperStats(),
      updatedAt: null,
    },
  };
}

const SLEEVE_PATCH_KEYS = [
  "thesis",
  "macroDrivers",
  "microDrivers",
  "instruments",
  "structure",
  "killRules",
  "status",
  "paper",
  "horizon",
  "budgetPct",
  "lossCapUsd",
] as const;

export function applyPaperPatch(
  current: PaperStats,
  body: Partial<PaperStats> | Record<string, unknown> | null | undefined,
): PaperStats {
  const src = body && typeof body === "object" ? body : {};
  const next: PaperStats = { ...current };
  const num = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const trades = num((src as PaperStats).trades);
  if (trades !== null) next.trades = trades;
  const wins = num((src as PaperStats).wins);
  if (wins !== null) next.wins = wins;
  const losses = num((src as PaperStats).losses);
  if (losses !== null) next.losses = losses;
  const pnl = num((src as PaperStats).realizedPnlUsd);
  if (pnl !== null) next.realizedPnlUsd = pnl;
  if (typeof (src as PaperStats).notes === "string") next.notes = (src as PaperStats).notes;
  return next;
}

/** Merge a PUT body onto a sleeve. Unknown keys (buy/sell/EnterLong/…) are ignored. */
export function applySleevePatch(
  current: SleeveCard,
  body: Record<string, unknown> | Partial<SleeveCard> | null | undefined,
): SleeveCard {
  const src = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const next: SleeveCard = { ...current, paper: { ...current.paper } };
  if (typeof src.thesis === "string") next.thesis = src.thesis;
  if (typeof src.macroDrivers === "string") next.macroDrivers = src.macroDrivers;
  if (typeof src.microDrivers === "string") next.microDrivers = src.microDrivers;
  if (typeof src.instruments === "string") next.instruments = src.instruments;
  if (typeof src.structure === "string") next.structure = src.structure;
  if (typeof src.killRules === "string") next.killRules = src.killRules;
  if (typeof src.horizon === "string") next.horizon = src.horizon;
  if (typeof src.status === "string" && (SLEEVE_STATUSES as readonly string[]).includes(src.status)) {
    next.status = src.status as SleeveStatus;
  }
  const budget = typeof src.budgetPct === "number" ? src.budgetPct : Number(src.budgetPct);
  if (Number.isFinite(budget)) next.budgetPct = budget;
  const cap = typeof src.lossCapUsd === "number" ? src.lossCapUsd : Number(src.lossCapUsd);
  if (Number.isFinite(cap)) next.lossCapUsd = cap;
  if (src.paper && typeof src.paper === "object") {
    next.paper = applyPaperPatch(current.paper, src.paper as Partial<PaperStats>);
  }
  next.updatedAt = new Date().toISOString();
  void SLEEVE_PATCH_KEYS;
  return next;
}

export interface DelayedQuote {
  symbol: string;
  last: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  asOf: string | null; // ISO from regularMarketTime
  exchange: string | null;
  delayed: true;
  source: "yahoo" | "massive";
  error?: string;
}

export interface PaperFill {
  id: string;
  sleeveId: SleeveId;
  ts: string;
  symbol: string;
  side: "Buy" | "Sell";
  qty: number;
  price: number;
  notes: string;
}

export type ScanSleeve = "momentum" | "ownership";

export interface ScanRow {
  symbol: string;
  name: string;
  sector: string;
  last: number;
  pctFrom52: number;
  dist20: number;
  above200: boolean;
  ret3m: number | null;
  ret6m: number | null;
  ret12m: number | null;
  rs3m: number | null;
  volx: number;
  score: number;
  why: string;
}

export interface ScanResponse {
  sleeve: ScanSleeve;
  asOf: string | null;
  universe: "sp500";
  delayed: true;
  source: "yahoo" | "massive";
  status: "ok" | "scanning";
  rows: ScanRow[];
}

/** Derived mock book per sleeve. Not persisted — equity = 100k + realized + unrealized. */
export interface SleeveBook {
  equityUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  pnlUsd: number;
  /** equityUsd - DEFAULT_SLEEVE_EQUITY_USD (same as realized + unrealized). */
  totalPnlUsd: number;
  /** Session realized + change in unrealized vs session mark (or vs 0 uPnL if no mark). */
  dailyPnlUsd: number;
}

export type EtradeAuthState = "ok" | "needs_pin" | "error";

export interface StatusSnapshot {
  trader: string;
  tz: string;
  clock: ClockSnapshot;
  /**
   * NYSE cash-session calendar (weekend / full holiday / early close) plus
   * inCashSession and next open/close instants for the web countdown.
   * Top-level so clients do not overload GateMode. Does not flatten or pause AUTO.
   */
  marketSession: MarketSession;
  events: CalendarEvent[];
  freeze: FreezeCard;
  knowledgeTime: string | null;
  /**
   * Stage-3 may open a new MES stoch lot: this ET day has an NFP/CPI/FOMC row,
   * the stamp is on that day at or after the anchor print, and now >= stamp.
   * iOS has no event list and reads this flag. Web recomputes the same rule from `events`.
   */
  stage3Armed: boolean;
  /** True when no future NFP/CPI/FOMC falls within the next 35 days. */
  calendarStale: boolean;
  checklist: Checklist;
  /**
   * Always empty on GET `/api/status` (status payload must stay small for iOS).
   * History is GET `/api/activity` (paged, newest first) from the existing gate_log journal.
   * Kept on the snapshot type so old clients still decode.
   */
  sessionLog: SessionLogEntry[];
  actionLog: ActionLogEntry[];
  gateEnabled: boolean;
  dailyLossUsd: number;
  qtyCap: number;
  gatedRoots: readonly string[];
  authRequired: boolean;
  /** Quotes/chains OAuth. Never includes tokens, PIN, or authorize URLs. */
  etradeAuth: EtradeAuthState;
  broker: BrokerSnapshot;
  sleeves: Record<SleeveId, SleeveCard>;
  activeSleeve: SleeveId;
  paperBlotter: PaperFill[];
  /**
   * True if ANY sleeve AUTO flag is on. Backward-compatible badge / old clients.
   * Not a sixth switch — derived from `autoPaperBySleeve`.
   */
  autoPaper: boolean;
  /** Independent AUTO PAPER per sleeve. */
  autoPaperBySleeve: AutoPaperBySleeve;
  sleeveBooks: Record<SleeveId, SleeveBook>;
  /** Global risk-on/off. Not a toggle. Does not bind day sleeve / clock / flatten / GATE. */
  riskOn: boolean;
  riskChecks: {
    /** True/false from real bars. Null means that series was missing — not "below 200dma". */
    spyAbove200: boolean | null;
    acwiAbove200: boolean | null;
    hygAbove200: boolean | null;
    uup20dPct: number | null;
    dollarVeto: boolean;
  };
  /** CSP sleeve book, recorder, and shadow summary. Absent on old clients. */
  csp?: CspStatusView;
  notifications?: {
    provider: "fcm";
    enabled: boolean;
    configured: boolean;
    dedupeWindowMinutes: number;
    tokens: { total: number; active: number; revoked: number };
  };
}

export type OptionRight = "C" | "P";

export interface OptionLeg {
  underlying: string;
  osiKey: string;
  displaySymbol: string;
  right: OptionRight;
  strike: number;
  expiry: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  /** E*TRADE netChange: premium points vs prior close. Absent on hand-built legs. */
  netChange?: number | null;
  bidSize: number | null;
  askSize: number | null;
  openInterest: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
}

export interface OptionExpiry {
  year: number;
  month: number;
  day: number;
  expiry: string;
  expiryType: string | null;
}

export interface OptionExpiriesResponse {
  symbol: string;
  delayed: boolean;
  source: "etrade-sandbox" | "etrade" | "massive";
  expiries: OptionExpiry[];
}

export interface OptionChainSnapshot {
  symbol: string;
  underlying: string;
  expiry: string;
  delayed: boolean;
  source: "etrade-sandbox" | "etrade" | "massive";
  chainType: "CALLPUT";
  legs: OptionLeg[];
}

export interface VerticalMeta {
  kind: "debit-vertical";
  right: OptionRight;
  expiry: string;
  underlying: string;
  /** v1 chain fetch symbol (SPY/QQQ/IWM). Sandbox may return a different underlyer. */
  quoteSymbol: string;
  qty: number;
  long: OptionLeg;
  short: OptionLeg;
  longFill: number;
  shortFill: number;
  netDebitPerShare: number;
  netDebitPaid: number;
  maxLoss: number;
  maxProfit: number;
  width: number;
  openedAt: string;
  /** Valuation clock for DTE/MTM. Sandbox 2013 expiries pin this so wall clock does not false-close. */
  asOf: string;
  lastExitReason?: string;
}

export type OverlayKind = "csp" | "covered-call";
export type OverlayThesisSleeve = "ownership" | "spcx";

/** Short option on the options sleeve, tagged to an ownership (or SPCX) thesis. */
export interface OverlayMeta {
  kind: OverlayKind;
  right: OptionRight;
  expiry: string;
  underlying: string;
  quoteSymbol: string;
  qty: number;
  strike: number;
  premiumPerShare: number;
  premiumReceived: number;
  /** CSP only: strike * 100 * qty. Never naked. */
  cashReserved: number;
  thesisSleeve: OverlayThesisSleeve;
  thesisSymbol: string;
  taLevel: string;
  openedAt: string;
  asOf: string;
  leg: OptionLeg;
}

export interface CspStatusView {
  equityUsd: number;
  cashUsd: number;
  reservedUsd: number;
  utilizationPct: number;
  realizedPnlUsd: number;
  openPuts: Array<{
    symbol: string;
    underlying: string;
    strike: number;
    expiry: string;
    dte: number | null;
    entryPremium: number;
    mark: number | null;
    stop: number;
    pnlUsd: number | null;
    contracts: number;
  }>;
  assigned: Array<{ symbol: string; qty: number; avgPrice: number }>;
  skips: Array<{ symbol: string; reason: string }>;
  signals: string[];
  /** Queued candidates with the month-end beta that made them eligible. */
  queued: Array<{
    symbol: string;
    tradeYmd: string;
    beta: number;
    betaAsOfYmd: string | null;
  }>;
  /** Last trading day of the prior calendar month. Eligibility uses this session. */
  betaAsOfYmd: string | null;
  recorder: {
    lastAt: string | null;
    rows: number;
    blocking: boolean;
    auth: string;
  };
  shadow: Array<{
    ruleId: string;
    count: number;
    winRate: number | null;
    totalPnl: number;
    avgPnl: number | null;
    vsActual: number | null;
  }>;
}
