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
}
