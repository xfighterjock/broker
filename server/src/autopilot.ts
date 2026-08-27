import { DEFAULT_SLEEVE_EQUITY_USD } from "../../shared/constants";
import type {
  Position,
  ScanRow,
  SleeveCard,
  SleeveId,
} from "../../shared/types";
import { pointValueFor } from "./paper";

export const MAX_AUTO_MOMENTUM = 5;
export const MAX_AUTO_OWNERSHIP = 5;
export const MOMENTUM_STOP_MUL = 0.985;
export const OWNERSHIP_STOP_MUL = 0.98;
export const AUTO_RISK_FRAC = 0.01;

export type AutoBuy = {
  sleeveId: "momentum" | "ownership";
  symbol: string;
  side: "Buy";
  qty: number;
  stopPrice: number;
  thesis: string;
};

export type AutoSell = {
  sleeveId: SleeveId;
  symbol: string;
  reason: string;
};

export function isOwnershipArtifact(
  row: Pick<ScanRow, "ret12m" | "ret3m" | "pctFrom52" | "last">,
): boolean {
  const r12 = row.ret12m;
  if (r12 === null || !Number.isFinite(r12)) return false;
  if (r12 > 5) return true;
  if (r12 > 1.5) {
    if (row.ret3m !== null && row.ret3m < 0) return true;
    if (row.pctFrom52 < -0.2) return true;
    if (row.last > 800) return true;
  }
  return false;
}

export function sizeByStopRisk(
  last: number,
  stopPrice: number,
  symbol: string,
  equityUsd: number,
  riskFrac = AUTO_RISK_FRAC,
): number {
  if (!(last > 0) || !Number.isFinite(stopPrice)) return 1;
  const dist = Math.abs(last - stopPrice);
  const { value } = pointValueFor(symbol);
  const per = dist * value;
  const riskUsd = Math.max(0, equityUsd) * riskFrac;
  if (!(per > 0) || !(riskUsd > 0)) return 1;
  return Math.max(1, Math.floor(riskUsd / per));
}

function isOpen(p: Position): boolean {
  return p.side !== "Flat" && p.qty > 0;
}

function symKey(s: string): string {
  return s.trim().toUpperCase();
}

export function decideBuys(
  rows: ScanRow[],
  openPositions: Position[],
  sleeve: SleeveCard,
): AutoBuy[] {
  if (sleeve.id !== "momentum" && sleeve.id !== "ownership") return [];
  if (sleeve.paper.realizedPnlUsd <= -sleeve.lossCapUsd) return [];

  const openAny = new Set(openPositions.filter(isOpen).map((p) => symKey(p.symbol)));
  const sleeveOpen = openPositions.filter((p) => isOpen(p) && p.sleeveId === sleeve.id);
  const max = sleeve.id === "momentum" ? MAX_AUTO_MOMENTUM : MAX_AUTO_OWNERSHIP;
  let slots = max - sleeveOpen.length;
  if (slots <= 0) return [];

  const stopMul = sleeve.id === "momentum" ? MOMENTUM_STOP_MUL : OWNERSHIP_STOP_MUL;
  let unrealized = 0;
  for (const p of sleeveOpen) unrealized += p.unrealizedPnl;
  const equityUsd = DEFAULT_SLEEVE_EQUITY_USD + sleeve.paper.realizedPnlUsd + unrealized;

  const out: AutoBuy[] = [];
  for (const row of rows) {
    if (slots <= 0) break;
    const symbol = row.symbol.trim().toUpperCase();
    if (!symbol) continue;
    if (openAny.has(symbol)) continue;
    if (!(row.last > 0) || !Number.isFinite(row.last)) continue;
    if (sleeve.id === "ownership" && isOwnershipArtifact(row)) continue;

    const stopPrice = row.last * stopMul;
    const qty = sizeByStopRisk(row.last, stopPrice, symbol, equityUsd);
    const score = Number.isFinite(row.score) ? row.score.toFixed(3) : String(row.score);
    const thesis = `auto ${sleeve.id} score ${score} ${row.sector} ${row.why}`;
    out.push({
      sleeveId: sleeve.id,
      symbol,
      side: "Buy",
      qty,
      stopPrice,
      thesis,
    });
    openAny.add(symbol);
    slots -= 1;
  }
  return out;
}

export function decideSells(
  positions: Position[],
  momentumRows: ScanRow[],
  featureRows: Array<{ symbol: string; above200: boolean }>,
  sleeves: Record<SleeveId, SleeveCard>,
  scanReady = true,
): AutoSell[] {
  const momentumSyms = new Set(momentumRows.map((r) => symKey(r.symbol)));
  const feat = new Map<string, { above200: boolean }>();
  for (const f of featureRows) feat.set(symKey(f.symbol), f);

  const covered = new Set(
    positions
      .filter((x) => isOpen(x) && x.overlay?.kind === "covered-call")
      .flatMap((x) => {
        const o = x.overlay!;
        return [o.underlying, o.quoteSymbol, o.thesisSymbol, x.symbol].map((s) => s.toUpperCase());
      }),
  );

  const out: AutoSell[] = [];
  for (const p of positions) {
    if (!isOpen(p) || p.side !== "Long") continue;
    if (p.overlay || p.vertical) continue;
    const sleeveId = p.sleeveId;
    if (sleeveId !== "momentum" && sleeveId !== "ownership") continue;
    if (sleeveId === "ownership" && covered.has(symKey(p.symbol))) continue;
    const sleeve = sleeves[sleeveId];
    if (!sleeve) continue;

    if (sleeve.paper.realizedPnlUsd <= -sleeve.lossCapUsd) {
      out.push({ sleeveId, symbol: p.symbol, reason: "sleeve loss cap" });
      continue;
    }
    const f = feat.get(symKey(p.symbol));
    if (f && !f.above200) {
      out.push({ sleeveId, symbol: p.symbol, reason: "below 200dma" });
      continue;
    }
    if (scanReady && sleeveId === "momentum" && !momentumSyms.has(symKey(p.symbol))) {
      out.push({ sleeveId, symbol: p.symbol, reason: "setup gone" });
      continue;
    }
  }
  return out;
}

export type PlaceResult = { ok: true } | { ok: false; error: string };
export type CloseResult = { ok: true } | { ok: false; error: string };

export type AutopilotCtx = {
  enabled: boolean;
  getPositions: () => Position[];
  getSleeves: () => Record<SleeveId, SleeveCard>;
  momentumRows: ScanRow[];
  ownershipRows: ScanRow[];
  featureRows: Array<{ symbol: string; above200: boolean }>;
  scanReady: boolean;
  place: (buy: AutoBuy) => Promise<PlaceResult>;
  close: (sell: AutoSell) => Promise<CloseResult>;
  log: (line: string) => void;
};

export async function runAutopilot(ctx: AutopilotCtx): Promise<{
  bought: AutoBuy[];
  sold: AutoSell[];
}> {
  const bought: AutoBuy[] = [];
  const sold: AutoSell[] = [];
  if (!ctx.enabled) return { bought, sold };

  const sells = decideSells(
    ctx.getPositions(),
    ctx.momentumRows,
    ctx.featureRows,
    ctx.getSleeves(),
    ctx.scanReady,
  );
  for (const s of sells) {
    const r = await ctx.close(s);
    if (r.ok) {
      ctx.log(
        `auto paper close ${s.sleeveId} ${s.symbol} ${s.reason} (MockBroker, not Tradovate, not live)`,
      );
      sold.push(s);
    } else {
      ctx.log(`auto paper close skip ${s.symbol}: ${r.error}`);
    }
  }

  if (!ctx.scanReady) return { bought, sold };

  for (const sleeveId of ["momentum", "ownership"] as const) {
    const rows = sleeveId === "momentum" ? ctx.momentumRows : ctx.ownershipRows;
    const buys = decideBuys(rows, ctx.getPositions(), ctx.getSleeves()[sleeveId]);
    for (const b of buys) {
      const r = await ctx.place(b);
      if (r.ok) {
        ctx.log(
          `auto paper buy ${b.sleeveId} ${b.qty} ${b.symbol} stop ${b.stopPrice} ${b.thesis} (MockBroker, not Tradovate, not live)`,
        );
        bought.push(b);
      } else if (/no delayed last/i.test(r.error)) {
        ctx.log(`auto paper skip ${b.symbol} no delayed last`);
      } else {
        ctx.log(`auto paper skip ${b.symbol}: ${r.error}`);
      }
    }
  }
  return { bought, sold };
}
