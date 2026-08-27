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

export type SleeveId = "day" | "momentum" | "options" | "ownership";
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
        "NFP / CPI / FOMC event gate. Flatten into the print; no directional entries from this app.",
      macroDrivers: "Payrolls, CPI, FOMC statement/presser vs freeze card.",
      microDrivers: "knowledge_time after print; paper bid/ask; checklist.",
      instruments: "MES / ZN / M6E / SR3",
      structure: "Futures event sleeve. Clock + freeze + flatten bound here.",
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
      structure: "debit spreads / calendars / collars — no naked short vol",
      killRules: "thesis broken / max debit lost / sleeve loss cap",
      status: "idea",
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
  broker: BrokerSnapshot;
  sleeves: Record<SleeveId, SleeveCard>;
  activeSleeve: SleeveId;
}
