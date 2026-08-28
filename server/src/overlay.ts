import {
  DEFAULT_SLEEVE_EQUITY_USD,
  OPTIONS_MULTIPLIER,
  SLEEVE_IDS,
} from "../../shared/constants";
import type {
  OptionLeg,
  OverlayKind,
  OverlayMeta,
  OverlayThesisSleeve,
  Position,
  SleeveId,
} from "../../shared/types";
import {
  daysToExpiry,
  defaultAsOfForExpiry,
  parseYmdParts,
  valuationNow,
} from "./vertical";

export type OverlayBody = {
  kind: OverlayKind;
  symbol: string;
  strike: number;
  expiry: string;
  qty: number;
  thesisSleeve: OverlayThesisSleeve;
  thesisSymbol: string;
  taLevel: string;
  thesis: string;
  asOf?: string;
  allowWeekly?: boolean;
};

export type OverlayOk = {
  ok: true;
  kind: OverlayKind;
  quoteSymbol: string;
  underlying: string;
  expiry: string;
  strike: number;
  qty: number;
  leg: OptionLeg;
  premiumPerShare: number;
  premiumReceived: number;
  cashReserved: number;
  thesisSleeve: OverlayThesisSleeve;
  thesisSymbol: string;
  taLevel: string;
  asOf: string;
  warn?: string;
};

export type OverlayErr = { ok: false; error: string };

function fmtStrike(n: number): string {
  return String(n);
}

export function isWeeklyExpiryType(expiryType: string | null | undefined): boolean {
  return (expiryType ?? "").toUpperCase() === "WEEKLY";
}

export function overlayPackageSymbol(v: {
  kind: OverlayKind;
  underlying: string;
  strike: number;
  expiry: string;
}): string {
  const right = v.kind === "csp" ? "P" : "C";
  const tag = v.kind === "csp" ? "CSP" : "CC";
  return `${v.underlying} ${fmtStrike(v.strike)} ${right} ${v.expiry} ${tag}`;
}

export function isOverlayPosition(p: Position): boolean {
  return Boolean(p.overlay && (p.overlay.kind === "csp" || p.overlay.kind === "covered-call"));
}

export function overlayCashReserved(positions: Position[]): number {
  let n = 0;
  for (const p of positions) {
    if (p.side === "Flat" || p.qty <= 0) continue;
    if (!p.overlay || p.overlay.kind !== "csp") continue;
    n += p.overlay.cashReserved;
  }
  return n;
}

export function optionsFreeCash(equityUsd: number, positions: Position[]): number {
  const equity = Number.isFinite(equityUsd) ? equityUsd : DEFAULT_SLEEVE_EQUITY_USD;
  return equity - overlayCashReserved(positions);
}

export function matchingOwnershipLong(
  positions: Position[],
  symbols: string[],
): Position | null {
  const want = new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean));
  if (want.size === 0) return null;
  for (const p of positions) {
    if (p.sleeveId !== "ownership") continue;
    if (p.side !== "Long" || p.qty <= 0) continue;
    if (p.vertical || p.overlay) continue;
    if (want.has(p.symbol.toUpperCase())) return p;
  }
  return null;
}

export function parsePaperOverlay(kind: OverlayKind, body: unknown): OverlayBody | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const sleeveRaw = String(b.sleeveId ?? "options");
  if (!(SLEEVE_IDS as readonly string[]).includes(sleeveRaw)) {
    return { error: `sleeveId must be ${(SLEEVE_IDS as readonly string[]).join("|")}` };
  }
  if (sleeveRaw !== "options") {
    return { error: "CSP / covered call live on the options sleeve only" };
  }
  const symbol = String(b.symbol ?? "").trim().toUpperCase();
  if (!symbol) return { error: "symbol required" };
  let expiry = String(b.expiry ?? "").trim();
  if (!expiry) {
    const y = Number(b.expiryYear);
    const m = Number(b.expiryMonth);
    const d = Number(b.expiryDay);
    if (Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d)) {
      expiry = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  if (!parseYmdParts(expiry)) return { error: "expiry must be YYYY-MM-DD" };
  const strike = typeof b.strike === "number" ? b.strike : Number(b.strike);
  if (!Number.isFinite(strike) || strike <= 0) return { error: "strike required" };
  const qty = typeof b.qty === "number" ? b.qty : Number(b.qty ?? 1);
  if (!Number.isFinite(qty) || qty < 1 || !Number.isInteger(qty)) {
    return { error: "qty must be an integer >= 1" };
  }
  const thesisRaw = String(b.thesisSleeve ?? "ownership").trim().toLowerCase();
  const thesisSleeve: OverlayThesisSleeve | null =
    thesisRaw === "ownership" || thesisRaw === "spcx" ? thesisRaw : null;
  if (!thesisSleeve) return { error: "thesisSleeve must be ownership or spcx" };
  const thesisSymbol = String(b.thesisSymbol ?? symbol).trim().toUpperCase() || symbol;
  const taLevel = typeof b.taLevel === "string" ? b.taLevel : String(b.taLevel ?? "");
  const thesis = typeof b.thesis === "string" ? b.thesis : String(b.thesis ?? "");
  const asOf = typeof b.asOf === "string" && b.asOf.trim() ? b.asOf.trim() : undefined;
  const allowWeekly = b.allowWeekly === true || b.includeWeekly === true;
  return {
    kind,
    symbol,
    strike,
    expiry,
    qty,
    thesisSleeve,
    thesisSymbol,
    taLevel,
    thesis,
    asOf,
    allowWeekly,
  };
}

export function validateCsp(
  input: {
    leg: OptionLeg;
    qty: number;
    asOf?: string;
    quoteSymbol?: string;
    thesisSleeve: OverlayThesisSleeve;
    thesisSymbol: string;
    taLevel: string;
  },
  freeCashUsd: number,
  now?: Date,
): OverlayOk | OverlayErr {
  const { leg } = input;
  if (leg.right !== "P") return { ok: false, error: "CSP requires a put" };
  const bid = leg.bid;
  if (bid === null || !Number.isFinite(bid) || !(bid > 0)) {
    return { ok: false, error: "missing put bid; refuse" };
  }
  const qty = input.qty;
  const cashReserved = leg.strike * OPTIONS_MULTIPLIER * qty;
  if (!(freeCashUsd >= cashReserved)) {
    return {
      ok: false,
      error: `CSP cash ${cashReserved.toFixed(0)} exceeds options cash ${Math.max(0, freeCashUsd).toFixed(0)} (never naked)`,
    };
  }
  const premiumPerShare = bid;
  const premiumReceived = premiumPerShare * OPTIONS_MULTIPLIER * qty;
  const clock = valuationNow(input.asOf, now);
  const asOf = input.asOf ?? defaultAsOfForExpiry(leg.expiry, clock);
  return {
    ok: true,
    kind: "csp",
    quoteSymbol: (input.quoteSymbol || leg.underlying).toUpperCase(),
    underlying: leg.underlying.toUpperCase(),
    expiry: leg.expiry,
    strike: leg.strike,
    qty,
    leg,
    premiumPerShare,
    premiumReceived,
    cashReserved,
    thesisSleeve: input.thesisSleeve,
    thesisSymbol: input.thesisSymbol,
    taLevel: input.taLevel,
    asOf,
  };
}

export function validateCoveredCall(
  input: {
    leg: OptionLeg;
    qty: number;
    asOf?: string;
    quoteSymbol?: string;
    thesisSleeve: OverlayThesisSleeve;
    thesisSymbol: string;
    taLevel: string;
    stock: Position | null;
  },
  now?: Date,
): OverlayOk | OverlayErr {
  const { leg, stock } = input;
  if (leg.right !== "C") return { ok: false, error: "covered call requires a call" };
  if (!stock || stock.side !== "Long" || stock.qty <= 0) {
    return { ok: false, error: "naked call refused: no matching long shares" };
  }
  const sharesNeeded = input.qty * OPTIONS_MULTIPLIER;
  if (stock.qty < sharesNeeded) {
    return {
      ok: false,
      error: `naked call refused: need ${sharesNeeded} long shares, have ${stock.qty}`,
    };
  }
  const bid = leg.bid;
  if (bid === null || !Number.isFinite(bid) || !(bid > 0)) {
    return { ok: false, error: "missing call bid; refuse" };
  }
  const cost = stock.avgPrice;
  if (!(leg.strike + bid > cost)) {
    return {
      ok: false,
      error: `call strike below cost (strike + premium ${ (leg.strike + bid).toFixed(2) } must exceed cost ${cost.toFixed(2)})`,
    };
  }
  const premiumPerShare = bid;
  const premiumReceived = premiumPerShare * OPTIONS_MULTIPLIER * input.qty;
  const clock = valuationNow(input.asOf, now);
  const asOf = input.asOf ?? defaultAsOfForExpiry(leg.expiry, clock);
  return {
    ok: true,
    kind: "covered-call",
    quoteSymbol: (input.quoteSymbol || leg.underlying).toUpperCase(),
    underlying: leg.underlying.toUpperCase(),
    expiry: leg.expiry,
    strike: leg.strike,
    qty: input.qty,
    leg,
    premiumPerShare,
    premiumReceived,
    cashReserved: 0,
    thesisSleeve: input.thesisSleeve,
    thesisSymbol: input.thesisSymbol,
    taLevel: input.taLevel,
    asOf,
  };
}

export function makeOverlayMeta(v: OverlayOk, openedAt = new Date().toISOString()): OverlayMeta {
  return {
    kind: v.kind,
    right: v.kind === "csp" ? "P" : "C",
    expiry: v.expiry,
    underlying: v.underlying,
    quoteSymbol: v.quoteSymbol,
    qty: v.qty,
    strike: v.strike,
    premiumPerShare: v.premiumPerShare,
    premiumReceived: v.premiumReceived,
    cashReserved: v.cashReserved,
    thesisSleeve: v.thesisSleeve,
    thesisSymbol: v.thesisSymbol,
    taLevel: v.taLevel,
    openedAt,
    asOf: v.asOf,
    leg: v.leg,
  };
}

/** Buy-to-close a short option at ask. */
export function overlayCloseCost(leg: OptionLeg, qty: number): number | null {
  if (leg.ask === null || !Number.isFinite(leg.ask)) return null;
  return leg.ask * OPTIONS_MULTIPLIER * qty;
}

export function overlayUnrealized(meta: OverlayMeta, leg: OptionLeg): number | null {
  const close = overlayCloseCost(leg, meta.qty);
  if (close === null) return null;
  return meta.premiumReceived - close;
}

export function applyOverlayMarks(meta: OverlayMeta, leg: OptionLeg): OverlayMeta {
  return {
    ...meta,
    leg: {
      ...meta.leg,
      ...leg,
      right: meta.leg.right,
      strike: meta.leg.strike,
      expiry: meta.leg.expiry,
    },
  };
}

export type OverlaySettle = {
  position: Position;
  reason: string;
  last: number;
  optionsRealizedPnl: number;
  stockTransfer?: {
    action: "assign" | "callaway";
    symbol: string;
    qty: number;
    price: number;
    sleeveId: "ownership";
  };
};

export function detectOverlaySettlements(
  positions: Position[],
  lastBySymbol: Record<string, number>,
  now?: Date,
): OverlaySettle[] {
  const hits: OverlaySettle[] = [];
  for (const p of positions) {
    const o = p.overlay;
    if (!o || p.side === "Flat" || p.qty <= 0) continue;
    const markNow = valuationNow(o.asOf, now);
    const dte = daysToExpiry(o.expiry, markNow);
    if (!Number.isFinite(dte) || dte > 0) continue;
    const last =
      lastBySymbol[o.underlying.toUpperCase()] ??
      lastBySymbol[o.quoteSymbol.toUpperCase()] ??
      lastBySymbol[o.thesisSymbol.toUpperCase()];
    if (last === undefined || !Number.isFinite(last)) continue;
    const shares = o.qty * OPTIONS_MULTIPLIER;
    if (o.kind === "csp") {
      if (last <= o.strike) {
        hits.push({
          position: p,
          reason: "CSP assigned",
          last,
          optionsRealizedPnl: 0,
          stockTransfer: {
            action: "assign",
            symbol: o.thesisSymbol || o.underlying,
            qty: shares,
            price: o.strike - o.premiumPerShare,
            sleeveId: "ownership",
          },
        });
      } else {
        hits.push({
          position: p,
          reason: "CSP expired OTM",
          last,
          optionsRealizedPnl: o.premiumReceived,
        });
      }
    } else {
      if (last >= o.strike) {
        hits.push({
          position: p,
          reason: "called away",
          last,
          optionsRealizedPnl: o.premiumReceived,
          stockTransfer: {
            action: "callaway",
            symbol: o.thesisSymbol || o.underlying,
            qty: shares,
            price: o.strike,
            sleeveId: "ownership",
          },
        });
      } else {
        hits.push({
          position: p,
          reason: "CC expired OTM",
          last,
          optionsRealizedPnl: o.premiumReceived,
        });
      }
    }
  }
  return hits;
}

export function overlayThesisTag(meta: OverlayMeta): string {
  const ta = meta.taLevel ? ` TA ${meta.taLevel}` : "";
  return `${meta.kind} ${meta.thesisSleeve}${ta}`.trim();
}

export type { SleeveId };
