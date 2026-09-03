import type { OrderType } from "./constants";

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
export type SleeveId = "day" | "momentum" | "options" | "ownership" | "riskoff";

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
  gated: boolean;
  sleeveId?: SleeveId;
  /** Two-leg debit vertical on the options or riskoff sleeve. Absent for stock/futures paper. */
  vertical?: VerticalMeta;
  /** Cash-secured put or covered call on the options sleeve (ownership overlay). */
  overlay?: OverlayMeta;
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
      microDrivers: "MES 5m slow stochastic 14,3,3; longs above session VWAP, shorts below; GATE windows; 15:45 flatten.",
      instruments: "MES / ZN / M6E / SR3",
      structure: "Event clock + MES stochastic paper. Qty 1. MockBroker only.",
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
    riskoff: {
      id: "riskoff",
      name: "Risk-off (puts + GLD/UUP)",
      horizon: "days–months",
      budgetPct: 10,
      lossCapUsd: 1000,
      thesis:
        "Defined-risk put debit while RISK OFF: SPY/QQQ/IWM only after SPY breaks 200dma; one HYG ATM put when credit is the broken leg; plus one GLD/UUP/BIL relative-strength ETF long.",
      macroDrivers: "SPY/ACWI/HYG 200dma + UUP 20d dollar veto (global risk-off).",
      microDrivers:
        "30–45 DTE put debit verticals: HYG when HYG is below 200dma (credit-leg); SPY/QQQ/IWM only after an equity 200dma break (SPY below). Prefer HYG first inside the auto cap. Skip missing bid/ask. GLD vs UUP vs BIL 63d total return; hold the winner if it beats T-bills, else BIL/cash. Flatten the ETF on RISK ON; flatten equity-index puts while SPY is still above 200dma; flatten the HYG put when HYG is back above 200 or RISK ON.",
      instruments: "SPY / QQQ / HYG / GLD / UUP / BIL",
      structure:
        "put debit verticals + one GLD/UUP/BIL ETF long; no naked short vol",
      killRules: "max debit lost / DTE / sleeve loss cap; ETF rotates only when the winner changes",
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
  events: CalendarEvent[];
  freeze: FreezeCard;
  knowledgeTime: string | null;
  checklist: Checklist;
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
  autoPaper: boolean;
  sleeveBooks: Record<SleeveId, SleeveBook>;
  /** Global risk-on/off. Not a toggle. Does not bind day sleeve / clock / flatten / GATE. */
  riskOn: boolean;
  riskChecks: {
    spyAbove200: boolean;
    acwiAbove200: boolean;
    hygAbove200: boolean;
    uup20dPct: number | null;
    dollarVeto: boolean;
  };
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
