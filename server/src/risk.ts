import { REDIS_KEYS } from "../../shared/constants";
import type { ScanFeatures } from "./scan";
import { featuresFromBars } from "./scan";
import { fetchMassiveDailyBars, type DailyBar } from "./massive";
import {
  noteServiceDown,
  noteServiceUp,
  notifyRiskFlip,
  resetEventGateAlertState,
  resetOiSkipStreak,
} from "./eventGateAlerts";
import type { RedisClient } from "./redis";

export const RISK_UUP_VETO_FRAC = 0.03;
export const RISK_CACHE_MS = 15 * 60 * 1000;

export type RiskChecks = {
  spyAbove200: boolean;
  acwiAbove200: boolean;
  hygAbove200: boolean;
  uup20dPct: number | null;
  dollarVeto: boolean;
};

/** Autopilot-only. Not on GET /api/public/risk. Null = bars missing (fail closed). */
export type CreditLegAbove200 = {
  lqdAbove200: boolean | null;
  jnkAbove200: boolean | null;
};

export type RiskSnapshot = {
  riskOn: boolean;
  checks: RiskChecks;
  creditLegAbove200: CreditLegAbove200;
};

/** Own-200 for LQD/JNK credit-leg puts. Missing bars or short series → null. */
export function above200FromBars(bars: DailyBar[] | null | undefined): boolean | null {
  if (!bars) return null;
  const feat = featuresFromBars(bars);
  if (!feat) return null;
  return feat.above200;
}

function retN(closes: number[], period: number): number | null {
  const n = closes.length;
  if (n <= period) return null;
  const last = closes[n - 1];
  const base = closes[n - 1 - period];
  if (!(last > 0) || !(base > 0)) return null;
  return last / base - 1;
}

export function uup20dReturn(bars: DailyBar[] | null): number | null {
  if (!bars || bars.length < 21) return null;
  return retN(
    bars.map((b) => b.close).filter((c) => typeof c === "number" && Number.isFinite(c)),
    20,
  );
}

export function riskOffFallback(): RiskSnapshot {
  return {
    riskOn: false,
    checks: {
      spyAbove200: false,
      acwiAbove200: false,
      hygAbove200: false,
      uup20dPct: null,
      dollarVeto: true,
    },
    creditLegAbove200: { lqdAbove200: null, jnkAbove200: null },
  };
}

/** Pure. Missing series fail that check => risk-off. Dollar veto if UUP 20d missing or > +3%. */
export function riskFromFeatures(input: {
  spy: ScanFeatures | null;
  acwi: ScanFeatures | null;
  hyg: ScanFeatures | null;
  uup20dPct: number | null;
  lqd?: ScanFeatures | null;
  jnk?: ScanFeatures | null;
}): RiskSnapshot {
  const spyAbove200 = Boolean(input.spy?.above200);
  const acwiAbove200 = Boolean(input.acwi?.above200);
  const hygAbove200 = Boolean(input.hyg?.above200);
  const dollarVeto = input.uup20dPct === null || input.uup20dPct > RISK_UUP_VETO_FRAC;
  const riskOn = spyAbove200 && acwiAbove200 && hygAbove200 && !dollarVeto;
  return {
    riskOn,
    checks: {
      spyAbove200,
      acwiAbove200,
      hygAbove200,
      uup20dPct: input.uup20dPct,
      dollarVeto,
    },
    creditLegAbove200: {
      lqdAbove200: input.lqd === undefined ? null : input.lqd ? input.lqd.above200 : null,
      jnkAbove200: input.jnk === undefined ? null : input.jnk ? input.jnk.above200 : null,
    },
  };
}

export function riskTooltip(snap: RiskSnapshot): string {
  const c = snap.checks;
  const note = "Does not bind the day book.";
  if (snap.riskOn) {
    const uup =
      c.uup20dPct === null || !Number.isFinite(c.uup20dPct)
        ? "UUP 20d n/a"
        : `UUP 20d ${(c.uup20dPct * 100).toFixed(1)}%`;
    return `SPY/ACWI/HYG above 200dma · ${uup}. ${note}`;
  }
  const failed: string[] = [];
  if (!c.spyAbove200) failed.push("SPY below 200dma");
  if (!c.acwiAbove200) failed.push("ACWI below 200dma");
  if (!c.hygAbove200) failed.push("HYG below 200dma");
  if (c.dollarVeto) {
    failed.push(
      c.uup20dPct === null || !Number.isFinite(c.uup20dPct)
        ? "UUP 20d missing (dollar veto)"
        : `UUP 20d ${(c.uup20dPct * 100).toFixed(1)}% (dollar veto)`,
    );
  }
  return `${failed.join(" · ") || "risk-off"}. ${note}`;
}

let cached: { at: number; snap: RiskSnapshot } | null = null;
let inflight: Promise<RiskSnapshot> | null = null;
let redis: RedisClient | null = null;
let lastKnownRiskOn: boolean | null = null;
let persistedHydrated = false;

export function attachRiskRedis(client: RedisClient | null): void {
  redis = client;
}

/** Test/boot helper. Null = unknown baseline (first snap after this will not notify). */
export function seedPersistedRiskOn(value: boolean | null): void {
  lastKnownRiskOn = value;
  persistedHydrated = true;
}

export function getLastKnownRiskOn(): boolean | null {
  return lastKnownRiskOn;
}

export function resetRiskCache(): void {
  cached = null;
  inflight = null;
  lastKnownRiskOn = null;
  persistedHydrated = false;
  resetEventGateAlertState();
}

export function getRiskSnapshot(): RiskSnapshot {
  return cached?.snap ?? riskOffFallback();
}

/** Epoch ms the cached risk snapshot was computed, or null if nothing has resolved yet. */
export function getRiskAsOf(): number | null {
  return cached?.at ?? null;
}

async function hydratePersistedRiskOn(): Promise<void> {
  if (persistedHydrated) return;
  persistedHydrated = true;
  if (!redis) return;
  try {
    const raw = await redis.get(REDIS_KEYS.riskOn);
    if (raw === "1") lastKnownRiskOn = true;
    else if (raw === "0") lastKnownRiskOn = false;
  } catch {
    /* keep unknown baseline */
  }
}

async function persistRiskOn(riskOn: boolean): Promise<void> {
  lastKnownRiskOn = riskOn;
  if (!redis) return;
  try {
    await redis.set(REDIS_KEYS.riskOn, riskOn ? "1" : "0");
  } catch {
    /* in-memory lastKnown still holds */
  }
}

/** After a computed (or fallback) snap: baseline, flip, or quotes fault. Never throws. */
export async function applyResolvedRisk(
  snap: RiskSnapshot,
  opts: { hardFailure?: boolean } = {},
): Promise<void> {
  try {
    await hydratePersistedRiskOn();
    if (opts.hardFailure) await noteServiceDown("quotes");
    else noteServiceUp("quotes");
    if (snap.riskOn) resetOiSkipStreak();
    const prev = lastKnownRiskOn;
    if (prev === null) {
      await persistRiskOn(snap.riskOn);
      return;
    }
    if (prev === snap.riskOn) return;
    await persistRiskOn(snap.riskOn);
    await notifyRiskFlip(snap);
  } catch (err) {
    console.warn("[EventGate] risk alert hook failed", err instanceof Error ? err.message : err);
  }
}

function gateBarsMissing(
  spyBars: DailyBar[] | null,
  acwiBars: DailyBar[] | null,
  hygBars: DailyBar[] | null,
  uupBars: DailyBar[] | null,
): boolean {
  return !spyBars && !acwiBars && !hygBars && !uupBars;
}

async function runRisk(): Promise<RiskSnapshot> {
  const [spyBars, acwiBars, hygBars, uupBars, lqdBars, jnkBars] = await Promise.all([
    fetchMassiveDailyBars("SPY"),
    fetchMassiveDailyBars("ACWI"),
    fetchMassiveDailyBars("HYG"),
    fetchMassiveDailyBars("UUP"),
    fetchMassiveDailyBars("LQD"),
    fetchMassiveDailyBars("JNK"),
  ]);
  const hardFailure = gateBarsMissing(spyBars, acwiBars, hygBars, uupBars);
  const snap = hardFailure
    ? riskOffFallback()
    : riskFromFeatures({
        spy: spyBars ? featuresFromBars(spyBars) : null,
        acwi: acwiBars ? featuresFromBars(acwiBars) : null,
        hyg: hygBars ? featuresFromBars(hygBars) : null,
        uup20dPct: uup20dReturn(uupBars),
        lqd: lqdBars ? featuresFromBars(lqdBars) : null,
        jnk: jnkBars ? featuresFromBars(jnkBars) : null,
      });
  cached = { at: Date.now(), snap };
  await applyResolvedRisk(snap, { hardFailure });
  return snap;
}

async function resolveRiskFailure(err: unknown): Promise<RiskSnapshot> {
  console.warn("[EventGate] risk gate failed", err instanceof Error ? err.message : err);
  if (cached) return cached.snap;
  const snap = riskOffFallback();
  cached = { at: Date.now(), snap };
  await applyResolvedRisk(snap, { hardFailure: true });
  return snap;
}

export function kickRisk(): void {
  if (inflight) return;
  inflight = runRisk()
    .catch((err) => resolveRiskFailure(err))
    .finally(() => {
      inflight = null;
    });
}

export async function ensureRisk(now = Date.now()): Promise<RiskSnapshot> {
  if (cached && now - cached.at < RISK_CACHE_MS) return cached.snap;
  if (inflight) {
    try {
      return await inflight;
    } catch {
      return getRiskSnapshot();
    }
  }
  inflight = runRisk().catch((err) => resolveRiskFailure(err));
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
