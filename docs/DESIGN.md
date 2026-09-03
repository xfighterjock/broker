# Event Gate design

Standing description of coded behavior in xfighterjock/broker.

Product/UI name is Event Gate; package name is broker. Trader: Richard. Product clock: America/New_York (TZ).

If this file disagrees with code, the code wins. Update this file and docs/ABBREVIATIONS.md whenever design, sleeve methodology, tickers, or abbreviations change.

## What it is

Paper risk-gate plus briefing dashboard. Five independent mock $100k sleeves. BUY/SELL fills are MockBroker only (delayed last + hard stop). No live or demo Tradovate orders. TRADING_MODE=live is refused. E*TRADE is quotes, chains, and OAuth only — never orders.

## Runtime

- Client: Vite + React SPA (client/). Desktop layout; phones (narrow viewport or /m) get essentials (GATE, RISK, AUTO PAPER, Flatten, sleeve P/L).
- Server: Node 20 Express (server/), bind 127.0.0.1:3001.
- Shared: clock, constants, types (shared/).
- Store: Postgres (events, freeze snapshots, iOS FCM tokens, alert dedupe) + Redis (gate, sleeves, blotter, mock book, session marks, scan cache).
- Front door: nginx TLS at broker.logikmancer.com. Production AUTH_MODE=nginx; local default is cookie eg.sid. GET /api/public/risk is the sole exception: nginx exempts that exact path from basic auth (deploy/nginx/event-gate.conf) and the Express /api auth middleware exempts it too, so it is reachable with no credentials from anywhere. It returns only {riskOn, riskChecks, asOf} (no-store) — never P/L, orders, positions, auth state, or secrets. GET /api/status stays behind auth and is not exposed publicly. Notification token/test endpoints are not public.
- Unit: systemd event-gate on the VPS. Mac checkout is the deploy source.
- No Docker. Production needs postgres, redis, and GATE_PASSWORD.
- Push notifications: backend-only FCM infrastructure exists for iOS tokens, but is disabled by default and fail-closed until explicit Firebase config is provided on the VPS.

## Event clock and GATE

Binds the day sleeve only. Does not flatten momentum, options, ownership, or risk-off. One-second tick when GATE is enabled (server/src/gate.ts, shared/clock.ts).

| Mode | Window | Action on gated roots |
| --- | --- | --- |
| idle | otherwise | none |
| PRE-ARM | T-15m to T-2m (PRE_ARM_MS) | cancel Market / StopMarket / StopLimit / MIT |
| NO-STOP BAND | T-2m to T+2m (BAND_MS) | same cancels |
| SESSION FLATTEN | flatten ET +/- 5m (FLATTEN_WINDOW_MS) | flatten gated names; also daily loss |

- Gated roots (GATED_ROOTS): MES, MNQ, ES, NQ, ZN, ZF, ZT, ZB, SR3, 6E, M6E. Qty over MAX_QTY (1) is cancelled. Limits left alone unless oversize.
- Daily loss cap default $500 (DEFAULT_DAILY_LOSS_USD). Day-sleeve paper entries use that sleeve's realized P/L, not broker-wide mock:day_pnl (other sleeves must not block MES). GATE flatten-on-daily-loss still reads MockBroker.getDayPnl(). FOMC in the event type forces 15:30 ET flatten; NFP/CPI seed flatten 15:45 ET.
- Freeze card (NFP/CPI/FOMC): consensus objects, source, FedWatch, liquid contracts MES/ZN/M6E/SR3. Print-day veto is Flatten or GATE OFF. Freeze auto-save must never flatten or place directional orders.
- Checklist: freeze existed, knowledge_time after print, no market orders, kill/flatten clicked, paper bid/ask seen.

## RISK ON / RISK OFF (badge)

Independent of the riskoff sleeve. Does not bind the day book, event clock, GATE, or flatten (server/src/risk.ts). Cached 15 minutes.
Exposed read-only and unauthenticated at GET /api/public/risk ({riskOn, riskChecks, asOf} only) so external watchers (e.g. Grok's risk-on/off routine) can poll it directly without Mac access or credentials — see Runtime.

RISK ON iff all of:

1. SPY last > 200-day SMA (spyAbove200)
2. ACWI last > 200-day SMA (acwiAbove200)
3. HYG last > 200-day SMA (hygAbove200)
4. UUP 20-session return is present and not greater than +3% (RISK_UUP_VETO_FRAC). Missing UUP 20d is a dollar veto.

Missing series fail closed to RISK OFF (riskOffFallback). Massive dailies.

When RISK OFF: no new momentum longs, no new options call-debit verticals; ownership pauses new adds only (existing longs stay unless their own exits fire). Risk-off sleeve expressions may run (see below).

## Data

| Path | Vendor | Use |
| --- | --- | --- |
| Equities last, S&P scan dailies, risk gate, GLD/UUP/BIL bars | Massive (api.massive.com), 15-minute delayed Starter | quotes, scan, RISK ON, risk-off ETF RS |
| Futures =F | Yahoo chart | day/momentum quote strip |
| Option expiries and chains | Live E*TRADE (api.etrade.com) | paper vertical/CSP/CC marks only |
| S&P 500 universe | datasets CSV on GitHub | scan constituents |

E*TRADE: in-process access-token renew every 30 minutes weekdays 09:30-16:00 ET. Midnight ET still needs a human PIN from the dashboard (Authorize + PIN). Snapshot etradeAuth: ok | needs_pin | error (no token material). Keys stay in gitignored .env.etrade on the VPS.

## Paper engine

- MockBroker in Redis (mock:orders, mock:positions, mock:day_pnl). Independent $100k equity per sleeve (DEFAULT_SLEEVE_EQUITY_USD).
- Blotter + sleeve cards in Redis. Session marks (NY calendar date) split daily vs total P/L.
- Autopilot (AUTO_PAPER_INTERVAL_MS = 5 min) when AUTO PAPER is on. Default on. Never CSP/CC/naked from auto. Day sleeve auto-papers MES (stochastic + VWAP); other sleeves as below.
- Vertical guards (shared/constants.ts): no new verticals at/after 15:50 ET weekdays (OPTIONS_VERTICAL_CUTOFF_MINUTES); net debit at most half the width (OPTIONS_DEBIT_MAX_WIDTH_FRAC); same-underlying cooldown the rest of the ET day after a 50% debit stop (OPTIONS_DEBIT_STOP_FRAC). Target 30-45 DTE; exit at 21 DTE; profit take 50% of debit. Size near 1% of sleeve equity (OPTIONS_DEBIT_TARGET_FRAC), hard cap 2% (OPTIONS_DEBIT_CAP_FRAC). Multiplier 100.
- Stops on mock last. Last ≤ 0 is ignored (missing/junk prints must not flatten). One mark-to-market pass at a time so a stop cannot book twice. Paper only.
- Vertical exit fill price is the immediate close natural credit (long bid - short ask), the same number the position marks against; it is not close + entry debit (a 2026-09-03 bug briefly double-counted the debit, e.g. recording .27 instead of .07).

## Sleeve methodologies

Five sleeves (SLEEVE_IDS). Each has its own mock book.

### 1. day — Day trading (events)

Horizon: intraday. Budget hint 15%. Loss cap $500 (day sleeve realized P/L, not mock:day_pnl).

Event-clock futures sleeve. Instruments on the quote strip: MES, ZN, M6E, SR3 (Yahoo =F). NFP/CPI/FOMC GATE still binds: PRE-ARM, NO-STOP BAND, and session flatten refuse new entries; flatten 15:45 ET (15:30 FOMC). Autopilot papers MES only: 5-minute slow stochastic 14,3,3, longs only above session VWAP, shorts only below, qty 1, stop at least 8 ticks or the signal bar. Yahoo 5m MES=F bars (not E*TRADE). RISK ON does not bind this book. MockBroker only.

### 2. momentum — Short-term momentum

Horizon: days-weeks. Budget hint 25%. Loss cap $1000. Auto cap MAX_AUTO_MOMENTUM = 5.

Universe: S&P 500 constituents (Massive dailies). Filter passesMomentumFilter (server/src/scan.ts): above 200dma, within 10% of 52-week high, last within -4% to +3% of 20dma (pullback-after-strength). Score: RS 3m vs SPY + 0.25 x RS 12m vs SPY + small volume bonus. Rank one name per GICS sector (top 15).

Entries (AUTO PAPER, RISK ON only): long the ranked names. Stop MOMENTUM_STOP_MUL = 0.985. Size about 1% sleeve equity at risk (AUTO_RISK_FRAC). Skip names already open on any sleeve.

Exits: sleeve loss cap; last below 200dma; setup gone (no longer in the momentum scan) when the scan is ready. RISK OFF: no new buys; existing stops/exits still run.

Quote-strip extras: MES, ES, SPY, QQQ, TLT (not auto-traded as a basket).

### 3. options — Options (defined risk)

Horizon: days-months. Budget hint 20%. Loss cap $1000. Auto cap MAX_AUTO_VERTICALS = 5.

Auto (RISK ON only): ATM call debit verticals on momentum-scan names. Never puts, CSP, or covered calls from autopilot. Same 30-45 DTE / 15:50 cutoff / half-width debit / 50% stop machinery (pickAtmCallDebit). Thesis: auto call debit.

Manual: POST /api/paper/vertical (call or put) on this sleeve. POST /api/paper/csp and POST /api/paper/covered-call are ownership overlay booked on the options sleeve, tagged thesisSleeve=ownership or spcx. Never naked. Cash-secured put reserves strike x 100 x qty.

Quote strip: SPY, QQQ, IWM (live chains accept any ordinary US ticker).

### 4. ownership — Longer-term ownership + overlay

Horizon: months+. Budget hint 40%. Loss cap $2000. Auto cap MAX_AUTO_OWNERSHIP = 5.

Universe: same S&P scan. Filter passesOwnershipFilter: above 200dma and positive 3m/6m/12m returns (if 12m history is short, at least two of those legs). Rank by 12m return, max two names per sector (top 20). Skip isOwnershipArtifact (extreme 12m, stale 3m, more than 20% off highs, or last over $800) so autopilot does not buy one-off spikes.

Entries (AUTO PAPER, RISK ON only): long stock via that TA. Stop OWNERSHIP_STOP_MUL = 0.98. Size about 1% equity at risk.

Holds: RISK OFF pauses new adds only. Does not flatten the long-term book. Covered-call underlyers are not auto-sold. Exit if below 200dma or sleeve loss cap.

Overlay: CSP / covered call are manual, tagged to an ownership or SPCX thesis, sitting on the options sleeve. Autopilot does not sell puts or calls.

Quote-strip extras: SPY, QQQ, TLT, IWM.

### 5. riskoff — Puts + GLD/UUP/BIL

Horizon: days-months. Budget hint 10%. Loss cap $1000. Auto cap MAX_AUTO_RISKOFF_VERTICALS = 3 (one per name). Status: paper.

Runs while AUTO PAPER is on and the global badge is RISK OFF. Two put programs plus one ETF long. Puts need a two-sided E*TRADE bid/ask (no invented prices).

HYG credit-leg put (riskoffHygPutAllowed): RISK OFF and hygAbove200 === false. Missing HYG check fail-closed (no new HYG put). ATM put debit, 30-45 DTE, HYG first inside the cap. Thesis: auto put debit HYG credit-leg. Flatten that vertical when HYG is back above 200dma or RISK ON. Missing check does not flatten.

HYG liquidity/size gate (checkHygAutoLiquidity, HYG auto entry only — never SPY/QQQ/IWM riskoff, options-sleeve calls, or manual POST /api/paper/vertical): both legs need open interest >= RISKOFF_HYG_MIN_OPEN_INTEREST (100); the immediate round-trip (long bid - short ask) must be at least 75% of the entry debit (long ask - short bid), i.e. round-trip slippage <= RISKOFF_HYG_MAX_ROUNDTRIP_SLIPPAGE_FRAC (25%); qty is hard-capped at RISKOFF_HYG_MAX_AUTO_QTY (3) regardless of the 1% target sizing that would otherwise apply. Added 2026-09-03 after a live HYG 79/78.5P auto entry (OI 7/0) was sized to 50 contracts on a $0.20 debit and hit its 50% debit stop within ~40 minutes.

SPY/QQQ/IWM equity-index puts (riskoffEquityPutsAllowed): RISK OFF and spyAbove200 === false. Missing SPY check fail-closed. Order after HYG: SPY, QQQ, then IWM if quoted. Flatten leftover equity-index puts when SPY is back above 200dma. Missing check does not flatten.

GLD / UUP / BIL overlay (server/src/riskoffEtf.ts): 20% of the $100k book (RISKOFF_ETF_NOTIONAL_FRAC). 63-session total return (RISKOFF_ETF_LOOKBACK_DAYS). Hold GLD or UUP if that name beats BIL; else BIL. Missing bars mean cash (flatten). Exact GLD/UUP tie keeps the held name, else GLD. Disaster stop RISKOFF_ETF_STOP_MUL = 0.92; rotation is the primary exit. Flatten the ETF on RISK ON, missing bars, or sleeve loss cap. Puts and the ETF are independent (put sells leave the ETF alone).

Quote strip: SPY, QQQ, HYG, GLD, UUP, BIL.

## Out of scope / refused

- Live broker orders (Tradovate, E*TRADE, NinjaTrader). TRADING_MODE=live exits.
- Sixth sleeve.
- Autopilot CSP, covered call, or naked short vol.
- Inverse/vol ETFs (SH, SDS, VXX, SJB) and duration (IEF/TLT) as risk-off expressions — not coded. TLT appears only on momentum/ownership quote strips.
- Day-sleeve directional entries from Event Gate.
- Scan-universe dump in these docs (500 names). Only methodology tickers are listed in ABBREVIATIONS.md.

## iOS push notification backend slice (FCM)

- Provider abstraction: `server/src/notifications.ts` with an FCM provider using Firebase Admin SDK (HTTP v1 under the hood). Config requires `PUSH_FCM_ENABLED=1`, `PUSH_FCM_PROJECT_ID`, and credentials from ADC or a root-owned file path. Without config, sends return structured `disabled` or `not_configured` and do not crash the app.
- Persistence: Postgres tables `notification_device_tokens` and `notification_alert_dedupe` (migration `002_notifications.sql`).
- Auth: token registration/revocation and test-send endpoints are under `/api`, so existing auth protections apply (nginx basic auth + app auth policy).
- Token model: iOS platform, optional `device_label`, created/updated/last_seen timestamps, enabled/revoked state, token rotation via `replaceToken`, token hash for indexing/lookup.
- Alert payload type: `risk_flip | service_fault | auth_needed | paper_guard` with title/body, eventType, occurredAt, dedupeKey, and deepLinkRoute only. No account IDs, positions, secrets, or order controls.
- Dedupe/rate-limit: restart-safe dedupe key store in Postgres; default one delivery per key per 30 minutes (`PUSH_ALERT_DEDUPE_WINDOW_MINUTES`).
- Test endpoint: `POST /api/notifications/test` sends a harmless "Event Gate test notification" only when FCM is enabled and configured; otherwise returns clear disabled/not-configured status.
- Status visibility: `/api/notifications/status` and `/api/status.notifications` expose provider flags and token counts only (no token values, no credential path).
- Integration contract for a future iOS app:
  1) iOS app gets an FCM registration token via Firebase iOS SDK/APNs setup.
  2) After Event Gate login, app calls `POST /api/notifications/tokens/register` with `{ platform: "ios", token, deviceLabel? }`.
  3) On token refresh, app calls register again with `replaceToken` when available.
  4) On logout/device opt-out, app calls `POST /api/notifications/tokens/revoke`.
  5) Push `deepLinkRoute` should route the app to Event Gate screens (example `/status`).
- Hook for server-side producers: call `sendEventGateAlert(principal, payload)` (or `NotificationService.sendAlert`) with a typed `EventGateAlertPayload` from VPS-owned risk-flip / operational guards. `auth_needed` is already wired for an E*TRADE `ok|error → needs_pin` transition (dedupe key `auth_needed:etrade:needs_pin`). Do not wire speculative trading alerts here.
- Credentials: ADC (`PUSH_FCM_CREDENTIAL_SOURCE=adc`) or a root-owned JSON file path. Never accept service-account secrets through the UI. Never persist them in Redis/Postgres. No Firebase project IDs, keys, or tokens are committed. Feature stays disabled until `PUSH_FCM_ENABLED=1` and project/credentials are set on the VPS.
