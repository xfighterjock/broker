# Event Gate abbreviations

Glossary of product terms, futures roots, and methodology tickers used in Event Gate. Alphabetized. Does not list the full S&P 500 scan universe.

If this file disagrees with code, the code wins. Update alongside docs/DESIGN.md.

---

**6E** — CME Euro FX futures. Gated root (GATED_ROOTS). Massive Futures product_code 6E (front-month dated ticker); Yahoo fallback 6E=F.

**20dma** — 20-day simple moving average. Momentum pullback filter uses last vs this SMA (dist20).

**200dma** — 200-day simple moving average. RISK ON requires SPY, ACWI, and HYG last above it. Momentum/ownership filters and below-200 exits use it too. Risk-off credit-leg puts (HYG/LQD/JNK) need SPY below 200dma (spyAbove200 === false; missing fails closed, no new put) and that name below its own 200dma. HYG-only OFF (SPY still above 200) does not open a new credit-leg put. Existing credit verticals are not flattened just because SPY is above 200. Risk-off ETF RS overlay: a candidate qualifies only if it beats BIL and is above its own 200dma; CTA names (DBMF, KMLM) must also beat BIL over 21 sessions; none → BIL. Overlay 200 filter is independent of credit-leg and gated duration. Overlay notional uses the same spyAbove200: 60% while SPY is above 200 (puts gated), 40% once SPY loses 200.

**%D** — 3-period SMA of slow %K. Day-sleeve MES stochastic signal line.

**%K** — Slow stochastic (14,3). Day-sleeve MES momentum after knowledge_time on that ET print day. Long when %K crosses up through %D after %K was at or below 20; short is the mirror above 80.

**ACWI** — iShares MSCI ACWI ETF (global equities). One of three 200dma legs on the RISK ON badge.

**activity log** — Phone (and desktop) feed of the existing `gate_log` journal (`engine.log`). GET `/api/activity?limit=&before=` pages newest first; `before` is a `gate_log.id` cursor. Default `limit` 50, max 100. Not on GET `/api/status` (`actionLog` / `sessionLog` there are empty). Rows older than `ACTIVITY_LOG_RETENTION_DAYS` (90) are deleted from `gate_log` and `session_logs`. Paper/mock activity only. GET `/api/log` is the same page with a `log` alias. Not on EVENT_GATE_OPS_TOKEN.

**APNs** — Apple Push Notification service. iOS devices receive remote notifications through APNs while Firebase maps delivery through FCM tokens. Firebase Console still needs an APNs Authentication Key (`.p8`) uploaded for the Event Gate iOS app; that key is not in git.

**argon2id** — Password hash for the `users` table. Never stored in plaintext.

**ATM** — At the money. Auto debit verticals pick the strike closest to last (pickAtmCallDebit / pickAtmPutDebit). Credit-leg HYG/LQD/JNK AUTO puts try ATM first, then walk ±2 strikes and the next 30-45 DTE expiries when ATM fails the OI/close-value gate; if that band is empty, one 3rd-Friday monthly in 21–60 DTE (paper only, same gates). SPY/QQQ/IWM riskoff puts and options-sleeve calls stay ATM-only and 30-45 DTE only.

**auth_needed** — FCM eventType when E*TRADE transitions to `needs_pin`. Deduped as `auth_needed:etrade:needs_pin`.

**AUTH_MODE** — Auth front door. Production `users` (users table + cookie/bearer). Local default `cookie` (GATE_PASSWORD). `nginx` is remapped to `users` in production. GET /api/public/risk is exempt in-app too.

**AUTO PAPER** — Autopilot. Independent enable per sleeve (`autoPaperBySleeve`: day, momentum, options, ownership, riskoff). Snapshot `autoPaper` is true if ANY sleeve is on (badge / old clients). POST /api/paper/auto `{ enabled }` sets all; `{ sleeveId, enabled }` sets one. Redis `paper:auto` is JSON; legacy `0`/`1` migrates on first boot. Default all on when the key is missing. Never CSP/CC/naked. GATE still binds day. Day MES stoch also needs knowledge_time for that ET print day (Stage-3); idle RTH without the stamp does not enter.

**bearer** — Opaque session token from POST /api/auth/login. Stored as sha256 in Postgres `user_sessions` (`SESSION_TTL_MS` 30 days). iOS keeps the raw token in the Keychain and sends `Authorization: Bearer`. SPA uses cookie `eg.sid` instead.

**BIL** — SPDR Bloomberg 1-3 Month T-Bill ETF. Cash/T-bill benchmark of the risk-off 63d relative-strength overlay (RISKOFF_ETF_CASH_SYMBOL). Held when no candidate beats BIL and sits above its own 200dma. Also the 21-session benchmark for the CTA confirmation (RISKOFF_ETF_CTA_CONFIRM_DAYS). BIL itself is never 200-filtered and never 21d-filtered.

**BUNDLE_ID** — iOS application id. Event Gate iOS must stay `com.logikmancer.mybroker` to match the existing Firebase iOS app.

**CC** — Covered call. Manual overlay on the options sleeve, tagged to an ownership or SPCX thesis. Not sold by autopilot. Never naked.

**CLSE** — Convergence Long/Short Equity ETF. Multi-factor long/short equity candidate on the risk-off 63d RS overlay (valuation/growth/momentum/quality). Same 63d-vs-BIL and own-200 gates as the other overlay names. Not CTA (not in RISKOFF_ETF_CTA_FAMILY) and not subject to the 21d beat-BIL confirmation; can fill non-CTA #2 when RS #1 is DBMF/KMLM. Aimed at HYG-only RISK OFF when puts are gated. Paper / MockBroker only.

**CME** — CME Group. Home of the gated futures roots (MES, ES, NQ, Treasuries, FX, SR3).

**CPI** — Consumer Price Index print. Seed calendar event; freeze card; flatten 15:45 ET. Day-sleeve event clock only.

**CSP** — Cash-secured put. Manual overlay on the options sleeve. Reserves strike x 100 x qty. Never naked. Not sold by autopilot.

**CTA** — Commodity Trading Advisor / managed-futures sleeve family on the risk-off 63d RS overlay (RISKOFF_ETF_CTA_FAMILY = DBMF, KMLM). Must also beat BIL over RISKOFF_ETF_CTA_CONFIRM_DAYS (21) or that name is skipped. When RS #1 is in this set, #2 is a non-CTA qualifier that clears beat-BIL and own-200 (GDX may fill that slot); if none does, #2 is BIL at 50/50. Never hold two CTA names together. GDX is not in this set.

**day_loss_cap** — FCM eventType for a paper loss flatten. Two payloads: GATE daily-loss on mock dayPnl (`day_loss_cap:gate_daily:{NY date}`) vs the day sleeve’s own `lossCapUsd` (`day_loss_cap:sleeve:{NY date}`). The sleeve body is used only when that sleeve’s book actually crossed its cap.

**dayPnl** — MockBroker.getDayPnl(): Redis `mock:day_pnl` realized accumulator plus open unrealized. GATE flatten-on-daily-loss ($500 dailyLossUsd). Not the day sleeve `lossCapUsd`. Not the blotter **dPnL** column (that is one open lot's mark vs prior close). Does not roll with NY session marks. POST `/api/paper/reset` rebuilds it from remaining sleeves' session daily; POST `/api/day-pnl` sets it by hand.

**DBMF** — iMGP DBi Managed Futures Strategy ETF. Managed-futures / CTA-family candidate on the risk-off 63d RS overlay (RISKOFF_ETF_CTA_FAMILY with KMLM; trend bucket after defensives XLU/XLP). Also needs a 21-session total return strictly above BIL (RISKOFF_ETF_CTA_CONFIRM_DAYS); missing 21d bars skip DBMF.

**dPnL** — Day P/L on one open mock lot in the paper blotter (`Position.dayPnl`). Stock and futures: same `signedPnl` as uPnL (side, qty, point value) vs prior close, or the quote's day change when prior close is missing. Debit vertical: (long netChange − short netChange) × 100 × qty. Short overlay: −netChange × 100 × qty. Signed dollars, green/red, same as sleeve-tab P/L. Distinct from uPnL and from account dayPnl. Flat or zero qty is not an open row. Fill journal has no dPnL column.

**DTE** — Days to expiration. Auto verticals target 30-45 DTE and exit at 21 DTE (OPTIONS_DTE_EXIT). Credit-leg AUTO may try up to 3 expiries in that band (closest to midpoint first) when the first expiry's strikes fail the liquidity gate. Paper-only credit-leg fallback: if the 30-45 band is empty, one standard monthly (3rd Friday) in 21–60 DTE (RISKOFF_CREDIT_LEG_MONTHLY_DTE_MIN/MAX). Equity-index puts and options-sleeve calls do not use that fallback.

**dma** — Daily moving average. See 20dma / 200dma.

**dollar veto** — RISK ON fails when UUP's 20-session return is missing or greater than +3% (RISK_UUP_VETO_FRAC). Exposed as dollarVeto on GET /api/public/risk. Also required clear (dollarVeto === false) before the risk-off gated TLT/IEF duration long may open; missing check fails closed.

**duration** — Treasury-bond exposure (TLT long-duration, IEF intermediate). Two distinct paper programs: (1) TLT/IEF as 63d RS overlay candidates vs BIL; (2) gated duration — a separate TLT/IEF long only on RISK OFF + SPY below 200dma + dollar veto clear (RISKOFF_DURATION_NOTIONAL_FRAC 20%). Not another RS pick.

**E\*TRADE** — Broker API used for live option chains and OAuth only. Never orders. Production base api.etrade.com.

**ES** — CME E-mini S&P 500 futures. Gated root. Massive Futures product_code ES (front-month); Yahoo fallback ES=F. On the momentum quote strip.

**ET** — America/New_York clock. Gate windows, 15:50 vertical cutoff, session marks, E*TRADE renew window, flatten times.

**ETF** — Exchange-traded fund. Risk-off 63d RS overlay is GLD/GDX/PDBC/UUP/TLT/IEF/XLU/XLP/DBMF/KMLM/CLSE/USMV/FTLS/BIL sized at RISKOFF_ETF_NOTIONAL_FRAC (40% of the $100k book) when SPY is below 200, or RISKOFF_ETF_NOTIONAL_FRAC_PUT_GATED (60%) while SPY is above 200 and puts stay gated; split 50/50 across the top-2 qualifiers (beat BIL and above own 200). A lone non-gold non-CTA takes the full overlay fraction; a lone CTA or a lone gold name is 50/50 with BIL. CTA family {DBMF, KMLM} must also beat BIL over 21 sessions and is never paired with the other CTA. Gold family {GLD, GDX} is never paired together (never GLD+GDX); #2 is a non-gold qualifier or else BIL. GDX, PDBC, USMV, and FTLS are in the basket and are not CTA. GDX is not subject to the 21-session beat-BIL confirmation. RS re-rank and resize run once per NY cash session at the cash close (16:00 ET, 13:00 ET on early-close days), not on midday bars. A name is not RS-rotated off until RISKOFF_ETF_MIN_HOLD_SESSIONS (5) cash sessions, counting the entry session. Missing overlay bars debounce via RISKOFF_ETF_MISSING_BARS_MAX_MISSES (hold last sleeve; do not flatten on a single miss). After that flatten, bars that return before the cash close rebuy the prior targets. A missing 21d CTA check skips that CTA and does not start that debounce. Gated duration is a separate TLT/IEF long at RISKOFF_DURATION_NOTIONAL_FRAC (20%). Gate names are SPY/ACWI/HYG/UUP.

**EVENT_GATE_OPS_TOKEN** — Optional long-lived HTTPS ops bearer (VPS `/opt/broker/.env`, never git). When set, `Authorization: Bearer` matching the env value authenticates a narrow ops scope: GET /api/status, GET/PUT /api/freeze, GET /api/health, GET /api/sleeves, POST /api/paper/auto, POST /api/flatten, POST /api/paper/reset, POST /api/gate/enable, POST /api/knowledge-time, POST /api/etrade/renew (print-day vetoes: flatten + GATE OFF; paper sleeve reset without a delayed last; same knowledge_time stamp as a user). Same GATE route also GATE ON (`{ enabled: true }` or omitted, defaults ON) — no separate disable path. POST `/api/etrade/renew` only resets idle expiry (GET oauth/renew_access_token); midnight ET still needs a human PIN. Not a users-table session. Paper orders, PIN (`/api/etrade/oauth/start` and `/pin` stay 401 for ops), mock inject, cancel-stops, user admin stay 401. When unset, behavior unchanged. Agents freeze-save, status-check, toggle AUTO, flatten, reset one mock sleeve, GATE OFF, stamp knowledge_time, and force-renew the E*TRADE access token at https://broker.logikmancer.com without the Mac.

**Face ID** — iOS LocalAuthentication unlock of a Keychain session. Optional. Not a remote password. Touch ID is the same path.

**FedWatch** — CME FedWatch snapshot field on the freeze card (NFP/CPI/FOMC briefing).

**FCM** — Firebase Cloud Messaging. Event Gate push provider (HTTP v1 via Firebase Admin SDK on the VPS; Firebase iOS SDK in `ios/`). Disabled by default until `PUSH_FCM_ENABLED=1` and credentials are configured. The iOS client registers tokens with a users-table bearer; it does not hold the Admin service-account JSON. Live eventTypes: `risk_flip`, `service_fault`, `auth_needed`, `pre_arm`, `freeze_missing`, `day_fill`, `day_flatten`, `day_loss_cap`, `veto_confirm`, `overlay_rotation`, `credit_put_opened`, `credit_put_stopped`, `credit_put_risk_on_flatten`, `oi_skip_streak`, `etrade_renew_failed`, `sleeve_loss_warn`, plus test `paper_guard`.

**Flatten** — Close gated day-sleeve names (POST /api/flatten) or a sleeve position (POST /api/paper/close, needs a delayed last). Print-day veto with GATE OFF. Does not flatten other sleeves from the event clock. Not a sleeve reset — that is POST /api/paper/reset.

**FOMC** — Federal Open Market Committee. Seed events FOMC_STATEMENT and FOMC_PC; flatten 15:30 ET when type contains FOMC.

**FOMC_PC** — FOMC press conference calendar type.

**FOMC_STATEMENT** — FOMC statement calendar type.

**FTLS** — First Trust Long/Short Equity ETF. Long/short equity candidate on the risk-off 63d RS overlay, alongside USMV. Same gates as the other non-CTA names: 63d total return strictly above BIL, and last above its own 200dma, or that name is skipped (none left → BIL). Exact RS ties use preference order after USMV (GLD > GDX > PDBC > UUP > duration > defensives > trend > CLSE > USMV > FTLS). Top-2 50/50 and the 50bp hysteresis apply. Not CTA (not in RISKOFF_ETF_CTA_FAMILY) and not subject to the 21-session beat-BIL confirmation; a weak or missing 21d return does not skip FTLS. Can fill non-CTA #2 when RS #1 is DBMF/KMLM. If no non-CTA clears, that #2 is BIL rather than the other CTA. RS re-rank still waits for the NY cash close, and the 5-session hold applies. Paper / MockBroker only.

**GATE** — Event-clock risk gate on futures roots. Modes: idle, PRE-ARM, NO-STOP BAND, SESSION FLATTEN. Enable via POST /api/gate/enable. Not the login password (GATE_PASSWORD is cookie-mode / signing only).

**GATED_ROOTS** — MES, MNQ, ES, NQ, ZN, ZF, ZT, ZB, SR3, 6E, M6E. Longest-first match so MES wins over ES, M6E over 6E, MNQ over NQ.

**GDX** — VanEck Gold Miners ETF. Equity-levered gold beta on the risk-off 63d RS overlay (RISKOFF_ETF_GOLD_FAMILY with GLD). Same gates as the other non-CTA names: 63d total return strictly above BIL, and last above its own 200dma, or that name is skipped (none left → BIL). Exact RS ties place it with gold, immediately after GLD and before PDBC (GLD > GDX > PDBC > UUP > duration > defensives > trend > CLSE > USMV > FTLS). Bullion still wins an exact tie. Top-2 50/50 and the 50bp hysteresis apply. Not CTA (not in RISKOFF_ETF_CTA_FAMILY) and not subject to the 21-session beat-BIL confirmation; a weak or missing 21d return does not skip GDX. When RS #1 is GLD or GDX, #2 is the highest non-gold qualifier; if none clears, #2 is BIL at 50/50 — never GLD+GDX. A non-gold #1 may still take GDX as #2. GDX can fill non-CTA #2 when RS #1 is DBMF/KMLM. The never-dual-gold rule wins at the cash-close rebalance even inside the 5-session min-hold, same as never-dual-CTA. A missing GDX 63d return is an incomplete-universe missing-bars miss (GDX is in RISKOFF_ETF_SYMBOLS). Aimed at HYG-only RISK OFF when puts are gated and GLD is below its own 200 while GDX is above its 200. Paper / MockBroker only.

**GICS** — Global Industry Classification Standard. Momentum ranks one name per sector; ownership allows two.

**GLD** — SPDR Gold Shares. First-preference candidate on the risk-off 63d RS overlay vs BIL, and the bullion leg of RISKOFF_ETF_GOLD_FAMILY (with GDX). Equity-levered gold (GDX) is next on an exact tie; bullion still wins. Still needs to be above its own 200dma after the RS pick; otherwise that name is skipped. When GLD is RS #1, #2 is the highest non-gold qualifier, else BIL at 50/50 — never GLD+GDX. Not CTA and not subject to the 21-session beat-BIL confirmation.

**holiday** — NYSE full-day cash close. Status `marketSession.closedReason` (`holiday` / `weekend` / `early_close`). Web and iOS show a muted closed strip. Does not change GateMode, flatten books, or pause AUTO.

**HYG** — iShares iBoxx $ High Yield Corporate Bond ETF. RISK ON 200dma leg. First credit-leg put debit on the riskoff sleeve when RISK OFF, SPY is below 200dma, and HYG is below its own 200dma. HYG-only OFF (SPY still above 200) does not open a new HYG put. AUTO tries ATM first, then ±2 strikes, then up to two more 30-45 DTE expiries; if that band is empty, one 3rd-Friday monthly in 21–60 DTE (paper only). Each candidate still needs OI >= 100 on each leg, a round-trip within 25% of the entry debit, and a hard 3-contract cap (RISKOFF_HYG_* / RISKOFF_CREDIT_LEG_* aliases). Paper only.

**IEF** — iShares 7-10 Year Treasury Bond ETF. Intermediate-duration candidate on the risk-off 63d RS overlay (after TLT in the duration bucket). Also the fallback for gated duration when TLT is unquoted or sizes to 0.

**iOS Event Gate** — Native SwiftUI app in ios/ (bundle com.logikmancer.mybroker). Phone Event Gate client: essentials (clock, US cash closed/holiday strip, GATE, RISK, AUTO PAPER chips, knowledge_time / Stage-3 arm + Stamp knowledge time, Flatten, sleeve P/L, E*TRADE PIN), paged Activity log, plus FCM. Users-table login + optional Face ID / Touch ID unlock of the Keychain session. Web `/m` remains for browsers. Push notification glyph is the AppIcon (same auto-agent artwork as the web favicon).

**IWM** — iShares Russell 2000 ETF. Options quote strip; optional third equity-index put on riskoff when SPY is below 200dma and IWM is quoted.

**JNK** — SPDR Bloomberg High Yield Bond ETF. Credit-leg put debit on the riskoff sleeve when RISK OFF, SPY is below 200dma, and JNK is below its own 200dma. HYG-only OFF does not open a new JNK put. Same ATM-then-ladder + liquidity/size envelope as HYG. After HYG and LQD inside the cap of 3. Paper only.

**Keychain** — iOS credential store. Event Gate iOS keeps the session bearer, login username, and last registered FCM token (`replaceToken`) here only — never UserDefaults, never git.

**KMLM** — KFA Mount Lucas Managed Futures Index Strategy ETF. Managed-futures / CTA-family candidate on the risk-off 63d RS overlay (RISKOFF_ETF_CTA_FAMILY with DBMF). Same 63d-vs-BIL and own-200 gates as the other overlay names, plus the 21-session beat-BIL confirmation (missing 21d bars skip KMLM).

**knowledge_time** — Timestamp after the print used on the freeze checklist (knowledge_time after print). Also the day-sleeve Stage-3 arm: new MES stoch entries only when this stamp is set, `now` is at or after it, and both share the same America/New_York calendar day. Ordinary idle RTH without a same-day stamp does not open MES. PRE-ARM and NO-STOP BAND still veto new entries. Existing lots keep stop / VWAP-exit / 15:45 flatten / sleeve loss cap. Stamp paths: desktop and iOS POST `/api/knowledge-time` (manual), EVENT_GATE_OPS_TOKEN (ops), and auto-stamp on event day once the print `timeUtc` is reached if a freeze card exists (`freezeTimestamp` set) and that ET day is still unstamped. FOMC auto-stamp uses STATEMENT time when both STATEMENT and PC exist; NFP/CPI use the print time. No freeze → no auto-stamp. Same-ET-day stamp is idempotent. Logs: `knowledge_time manual`, `knowledge_time ops-stamped`, `knowledge_time auto-stamped`.

**Limit** — Limit order type. Gate leaves limits alone unless oversize.

**LQD** — iShares iBoxx $ Investment Grade Corporate Bond ETF. Credit-leg put debit on the riskoff sleeve when RISK OFF, SPY is below 200dma, and LQD is below its own 200dma. HYG-only OFF does not open a new LQD put. Same ATM-then-ladder + liquidity/size envelope as HYG. Tried after HYG (including when HYG fails liquidity) and before JNK. Paper only.

**M6E** — CME Micro Euro FX futures. Gated root; freeze-card liquid contract; day quote strip. Massive Futures product_code M6E (front-month); Yahoo fallback M6E=F.

**Market** — Market order type. Cancelled on gated roots in PRE-ARM and NO-STOP BAND.

**marketSession** — Top-level GET `/api/status` field: NYSE cash open/closed in ET (`cashOpen`, `closedReason`, `holidayName`, `asOfEt`, `nextOpenEt`). Not a GateMode.

**Massive** — Market-data vendor (api.massive.com). Same MASSIVE_API_KEY: Stocks Starter for equities last / S&P scan dailies / risk-gate and risk-off ETF bars (15-minute delayed); Futures for day MES 5m aggs and futures quote-strip lasts (front-month dated contracts such as MESU6 via `/futures/v1/contracts` + `/futures/v1/aggs` + `/futures/v1/snapshot`). No documented continuous F: ticker — do not invent one. Yahoo =F is the futures fallback.

**MES** — CME Micro E-mini S&P 500 futures. Gated root; freeze-card liquid contract; day quote strip and paper symbol MES=F. Day-sleeve 5m stoch/VWAP bars prefer Massive Futures front-month (product_code MES); Yahoo MES=F fallback.

**MIT** — Market-if-touched order type. Treated as market-or-stop: cancelled in PRE-ARM and NO-STOP BAND on gated roots.

**MNQ** — CME Micro E-mini Nasdaq-100 futures. Gated root. Massive Futures product_code MNQ; Yahoo fallback MNQ=F.

**MockBroker** — In-memory paper broker persisted in Redis. The only place Event Gate fills BUY/SELL. Not Tradovate, not E*TRADE.

**MTM** — Mark to market. Vertical and overlay unrealized P/L use chain marks, not invented prices.

**NFP** — Nonfarm payrolls print. Seed calendar event; freeze card; flatten 15:45 ET. Day-sleeve event clock only.

**nginx** — TLS reverse proxy in front of 127.0.0.1:3001. No htpasswd on /api or the SPA; app auth is the users table. GET /api/public/risk stays unauthenticated.

**NinjaTrader** — Futures platform. README notes a live NT API add-on is not required for mock. This repo is not an NT order router.

**NO-STOP BAND** — Gate mode T-2m to T+2m around the event. Cancels Market / StopMarket / StopLimit / MIT on gated roots.

**NQ** — CME E-mini Nasdaq-100 futures. Gated root. Massive Futures product_code NQ; Yahoo fallback NQ=F.

**NY** — New York session date (America/New_York calendar YYYY-MM-DD) used for sleeve session marks and same-day vertical stop cooldown.

**NYSE** — New York Stock Exchange cash calendar. Event Gate `marketSession` uses the NYSE equity holiday set (New Year’s, MLK, Presidents’, Good Friday, Memorial Day, Juneteenth, Independence Day, Labor Day, Thanksgiving, Christmas, plus weekend observance) in America/New_York. Orthogonal to GATE.

**OAuth** — E*TRADE 1.0a handshake. In-app Authorize + PIN; in-process renew during the cash session.

**OI** — Open interest. Options-chain leg field. HYG/LQD/JNK auto put-debit entries refuse either leg below RISKOFF_HYG_MIN_OPEN_INTEREST (100), including every ladder candidate (nearby strikes / next 30-45 DTE expiry / credit-leg monthly 21–60 fallback); no OI floor on manual entries or SPY/QQQ/IWM/options auto verticals.

**OTM** — Out of the money. Put debit shorts a lower strike; call debit shorts a higher strike.

**paper_guard** — FCM eventType used only by `POST /api/notifications/test` (`dedupeKey` `event-gate-test`). Not a live trading alert.

**P/L** — Profit and loss. Sleeve books expose realized, unrealized, dailyPnlUsd, totalPnlUsd (equity minus $100k).

**PDBC** — Invesco Optimum Yield Diversified Commodity Strategy ETF. Broad commodity beta (energy, agriculture, industrial and precious metals) on the risk-off 63d RS overlay. Same gates as the other non-CTA names: 63d total return strictly above BIL, and last above its own 200dma, or that name is skipped (none left → BIL). Exact RS ties place it with commodities, after GDX and before UUP (GLD > GDX > PDBC > UUP > duration > defensives > trend > CLSE > USMV > FTLS). Bullion still wins a tie against miners; PDBC is not in the gold family. Top-2 50/50 and the 50bp hysteresis apply. Not CTA (not in RISKOFF_ETF_CTA_FAMILY) and not subject to the 21-session beat-BIL confirmation; a weak or missing 21d return does not skip PDBC. Can fill non-CTA #2 when RS #1 is DBMF/KMLM. If no non-CTA clears, that #2 is BIL rather than the other CTA. Aimed at HYG-only RISK OFF, when credit is soft and equities still hold their 200s, so the sleeve can rank a commodity diversifier while puts stay gated and gated duration stays flat. Paper / MockBroker only.

**PIN** — E*TRADE verifier after Authorize. Typed in Event Gate (desktop header, web /m, or the iOS essentials home). Needed after midnight ET. Never stored in git or chat.

**Postgres** — Database for calendar events, freeze snapshots, `users` + `user_sessions`, iOS FCM device tokens, push-alert dedupe, and the activity journal (`gate_log`, plus `session_logs`). Activity rows older than 90 days are deleted.

**PRE-ARM** — Gate mode T-15m to T-2m. Cancels Market / StopMarket / StopLimit / MIT on gated roots.

**push dedupe key** — Stable alert key used to suppress repeat deliveries in a configured window (default 30 minutes).

**QQQ** — Invesco QQQ Trust (Nasdaq-100). Options quote strip; risk-off equity-index put when SPY is below 200dma; momentum/ownership quote strip.

**Redis** — Cache/store for gate flags, mock book, sleeves, blotter, session marks, scan, AUTO PAPER (per-sleeve JSON on `paper:auto`), last-known RISK ON/OFF (`risk:on`), and SPA cookie sessions (cookie name `eg.sid`, Redis prefix `eg:sess:`).

**RISK OFF** — Badge when RISK ON is false. Pauses new momentum longs and options call-debits; ownership pauses new adds. May run the riskoff sleeve (ETF overlay always — 60% while SPY is above 200 and puts stay gated, 40% once SPY loses 200; credit-leg and equity-index puts only when SPY is below 200dma). Overlay missing-bars misses hold the last sleeve for RISKOFF_ETF_MISSING_BARS_MAX_MISSES consecutive decide() calls before flattening. Does not bind the day book.

**RISK ON** — Badge iff SPY, ACWI, and HYG are above 200dma and UUP 20d is not greater than +3%. Missing series fail closed to RISK OFF.

**RISKOFF_DURATION_NOTIONAL_FRAC** — Fraction of the $100k risk-off mock book for the gated TLT/IEF duration long. 0.20 (~$20k). Mild so it does not crowd out the 40% RS overlay that applies when SPY is below 200 (combined 60%; puts keep the rest). Duration is already flat while SPY is above 200, so it never stacks with the 60% put-gated overlay. Same disaster stop as the overlay (RISKOFF_DURATION_STOP_MUL = 0.92). Paper only. Distinct from the 63d RS pick.

**RISKOFF_ETF_CTA_CONFIRM_DAYS** — 21 trading sessions. Extra beat-BIL gate for RISKOFF_ETF_CTA_FAMILY only (DBMF, KMLM). Same total return as the 63d overlay (last close / close 21 sessions earlier − 1), strict greater-than BIL. Missing or non-finite 21d on the CTA or on BIL skips that CTA (fail closed) and does not trip the 63d missing-bars debounce. Non-CTA overlay names are not gated. None left → BIL. Paper / MockBroker only.

**RISKOFF_ETF_CTA_FAMILY** — Managed-futures / CTA tickers on the risk-off 63d RS overlay (DBMF, KMLM). Each member must also beat BIL on RISKOFF_ETF_CTA_CONFIRM_DAYS or it is skipped. When RS #1 is in this set, #2 is a non-CTA qualifier that clears beat-BIL and own-200; if none does, #2 is BIL at 50/50. Never KMLM+DBMF. Add future CTA names here and to RISKOFF_ETF_SYMBOLS. GDX, PDBC, CLSE, USMV, and FTLS are not members.

**RISKOFF_ETF_GOLD_FAMILY** — Gold-beta tickers on the risk-off 63d RS overlay (GLD, GDX). Not subject to RISKOFF_ETF_CTA_CONFIRM_DAYS. When RS #1 is in this set, #2 is a non-gold qualifier that clears beat-BIL and own-200; if none does, #2 is BIL at 50/50. Never GLD+GDX. A non-gold #1 may still hold one gold name. A CTA #1 may take GDX as non-CTA #2. The cash-close rebalance breaks a dual-gold sleeve to BIL (or a non-gold qualifier) even inside RISKOFF_ETF_MIN_HOLD_SESSIONS, same as never-dual-CTA. Add future gold names here and to RISKOFF_ETF_SYMBOLS. PDBC is not a member. Paper / MockBroker only.

**RISKOFF_ETF_MIN_HOLD_SESSIONS** — 5 NY cash sessions. Once an overlay candidate is entered, RS may not rotate it off until this many sessions are held, counting the entry session as session 1 (eligible on the cash close of session 5). Weekends and full holidays do not count; early-close days do. BIL is not on this clock. The hold applies while the name still clears its gates (beat-BIL, own-200, and the CTA 21d check when it is CTA). A name that fails those gates can leave at the cash-close rebalance inside the 5 sessions; it is not rotated off on a midday bar. Stops, missing-bars flatten, RISK ON, and the sleeve loss cap still exit immediately. The never-dual-CTA rule can still replace a second CTA with BIL at the cash-close rebalance. The never-dual-gold rule can still replace a second gold name (GLD/GDX) with BIL (or a non-gold qualifier) at that same cash-close rebalance. A held name with no entry stamp is treated as entered on that rebalance. Paper / MockBroker only.

**RISKOFF_ETF_MISSING_BARS_MAX_MISSES** — Consecutive failed missing-bars / incomplete-returns overlay decisions before fail-closed flatten. 3 (≈15 min at AUTO_PAPER_INTERVAL_MS 5 min). A miss is `returns === null` or any RISKOFF_ETF_SYMBOLS name lacking a finite 63d return. Misses 1–2 hold the last open overlay sleeve (no sells, no new buys). Miss 3 flattens with note "missing risk-off ETF bars". If bars return before the NY cash-close rebalance, rebuy those prior targets instead of a new RS pair. RS hysteresis does not apply until returns are ready. Paper / MockBroker only.

**RISKOFF_ETF_NOTIONAL_FRAC** — Base fraction of the $100k risk-off mock book for the defensive ETF RS overlay long while RISK OFF and spyAbove200 === false (puts can come online). 0.40 (~$40k). Split 50/50 across the top-2 qualifiers; one non-gold non-CTA qualifier takes the full 40%; a lone CTA or a lone gold name is 50/50 with BIL. Puts keep the rest (and the 20% gated duration sleeve when that program is on). Lookback and stop unchanged (RISKOFF_ETF_LOOKBACK_DAYS 63, RISKOFF_ETF_STOP_MUL 0.92). Notional resize runs only at the NY cash-close rebalance.

**RISKOFF_ETF_NOTIONAL_FRAC_PUT_GATED** — Overlay fraction while RISK OFF and spyAbove200 === true (same SPY-above-200 check that gates equity/credit puts). 0.60 (~$60k). Split 50/50 across the top-2 qualifiers; one non-gold non-CTA qualifier takes the full 60%; a lone CTA or a lone gold name is 50/50 with BIL. Missing spyAbove200 does not scale up (stays RISKOFF_ETF_NOTIONAL_FRAC). When SPY loses 200, MockBroker close+reopen cuts held lots back toward 40%. RISK ON still flattens. Paper only.

**RISKOFF_ETF_REQUIRE_ABOVE_200** — Absolute-trend filter on risk-off ETF RS overlay candidates. True: a name qualifies only if it beats BIL and is above its own 200dma; otherwise that name is skipped. None qualify → BIL. BIL is never 200-filtered. Independent of credit-leg 200dma puts and gated TLT/IEF.

**RISKOFF_ETF_REBALANCE_MINUTE** — 16:00 ET (960 minutes). Overlay RS re-rank and notional resize run once per NY cash session at or after this time. Early-close days use 13:00 ET (RISKOFF_ETF_EARLY_CLOSE_REBALANCE_MINUTE). Weekends and full holidays do not rebalance. Midday bars hold the open sleeve. Paper / MockBroker only.

**RISKOFF_ETF_RESIZE_NOTIONAL_FRAC** — Deadband on overlay lot resize. Rebalance a held overlay name when |held−target| notional is at least this fraction of the $100k book (0.08 / ~$8k). Catches 40%↔60% (and 20%↔30% per top-2 name) without churning 1-share quote drift. Close+reopen in MockBroker. Applied only on the once-per-session cash-close rebalance, not on midday bars.

**RISKOFF_ETF_RS_HYSTERESIS** — Mild absolute 63d total-return margin (0.005 / 50bp) on the risk-off ETF overlay. A challenger must beat a held name by this much before displacing that slot, so tiny GLD↔DBMF (etc.) edges do not churn. Exact RS ties still use preference order. Does not apply when held is ineligible (≤ BIL / not above 200) or missing. Does not apply on a missing-bars miss — that path short-circuits before RS; hysteresis resumes only after returns are ready again.

**risk_flip** — FCM eventType when the global RISK ON/OFF badge changes. Last-known state is in memory and Redis `risk:on` so a restart does not false-flip.

**RS** — Relative strength. Momentum score vs SPY; risk-off ETF overlay is 63-session total return of GLD/GDX/PDBC/UUP/TLT/IEF/XLU/XLP/DBMF/KMLM/CLSE/USMV/FTLS vs BIL, sized at RISKOFF_ETF_NOTIONAL_FRAC (40%, SPY below 200) or RISKOFF_ETF_NOTIONAL_FRAC_PUT_GATED (60%, SPY above 200 / puts gated) and split top-2 50/50 among qualifiers (beat BIL and above own 200). Mild 50bp hysteresis (RISKOFF_ETF_RS_HYSTERESIS) only when the 63d universe is complete — missing bars debounce (RISKOFF_ETF_MISSING_BARS_MAX_MISSES) short-circuits first. Re-rank and resize once per NY cash session at the cash close, not on midday bars. A name stays at least RISKOFF_ETF_MIN_HOLD_SESSIONS (5) cash sessions before an RS rotate. CTA family {DBMF, KMLM} must also beat BIL over 21 sessions (RISKOFF_ETF_CTA_CONFIRM_DAYS; missing 21d skips that CTA only). When #1 is CTA, #2 is a non-CTA qualifier (GDX, PDBC, CLSE, USMV, and FTLS can fill that slot) or else BIL — never both CTAs. Gold family {GLD, GDX} is the same shape: when #1 is gold, #2 is a non-gold qualifier or else BIL — never GLD+GDX. That dual-gold break also wins at the cash-close rebalance inside the 5-session hold. GDX is not 21d-gated. Gated TLT/IEF duration is not an RS pick.

**RTH** — Regular trading hours, 09:30-16:00 ET. Day-sleeve VWAP and entry window (09:35-15:45) use RTH only. Distinct from `marketSession.cashOpen`, which is the NYSE calendar day (not “are we inside 09:30–16:00 right now”).

**SDS** — ProShares UltraShort S&P 500. Not a live risk-off expression.

**service_fault** — FCM eventType for an operational up→down (postgres, redis, or quotes). Deduped per fault class. Not paper fills or AUTO skips.

**SESSION FLATTEN** — Gate mode around flatten ET +/- 5m (and daily-loss). Flattens gated day-sleeve names.

**SESSION_SECRET** — Cookie-signing secret for `eg.sid`. Production AUTH_MODE=users requires this or GATE_PASSWORD as fallback. Not the users-table login.

**SH** — ProShares Short S&P 500. Not a live risk-off expression.

**SJB** — ProShares Short High Yield. Risk-off quote-strip visibility only — not a traded inverse (HYG/LQD/JNK puts are the credit-leg instead).

**sleeve reset** — POST `/api/paper/reset` `{ sleeveId }`. MockBroker only. One sleeve back to a clean $100k book: no open position, no working stop, empty blotter, journal realized 0, session mark aligned so daily and total P/L are 0. Rebuilds mock:day_pnl from remaining sleeves' session daily so stale account dayPnl cannot keep tripping GATE daily-loss after leftover books are flat; does not wipe another sleeve's today. Does not need a delayed last (unlike POST /api/paper/close). Does not flatten other sleeves, does not toggle AUTO PAPER, does not change GATE. Refuses when the process is not MockBroker. Never a live or E*TRADE order. EVENT_GATE_OPS_TOKEN may call it. POST `/api/day-pnl` is the manual accumulator path (not on the ops-token allowlist). Do not stop event-gate or edit Redis (`mock:positions`, `mock:orders`, `mock:day_pnl`, `sleeves:cards`, `sleeves:blotter`, `sleeves:session_marks`) to wipe a stuck premarket lot.

**SMA** — Simple moving average. 20- and 200-day windows in scan/risk features.

**SOFR** — Secured Overnight Financing Rate. Underlyer of SR3 (three-month SOFR futures).

**SPA** — Single-page app. Event Gate web client is Vite + React.

**SPM** — Swift Package Manager. Event Gate iOS pulls FirebaseCore and FirebaseMessaging from firebase-ios-sdk.

**SPCX** — SPAC and New Issue ETF. Overlay thesisSleeve may be tagged spcx (manual CSP/CC). Not auto-traded.

**SPY** — SPDR S&P 500 ETF Trust. RISK ON 200dma leg; scan RS benchmark; risk-off equity-index puts and new credit-leg (HYG/LQD/JNK) puts only when SPY is below 200dma (missing spyAbove200 fails closed); same spyAbove200 scales the 63d ETF overlay (60% while above 200 / puts gated, 40% once below); options quote strip.

**SR3** — CME Three-Month SOFR futures. Gated root; freeze-card liquid contract; day quote strip. Massive Futures product_code SR3 (front-month); Yahoo fallback SR3=F.

**SYMBOL_DESCRIPTIONS** — Shared map in `shared/symbolDescriptions.ts` of Event Gate ticker → short full name (methodology ETFs/futures roots from this glossary: SPY, QQQ, HYG, GLD, GDX, PDBC, UUP, BIL, TLT, IEF, XLU, XLP, DBMF, KMLM, CLSE, USMV, FTLS, LQD, JNK, SJB, ACWI, IWM, and gated roots MES/MNQ/ES/NQ/ZN/ZF/ZT/ZB/SR3/6E/M6E). Web paper UI sets HTML `title` (and an accessibility label) on primary symbol labels: quote strips, sleeve instrument chips, positions, orders, blotter, overlay names, options underlyings, and gated-root chips. Dated futures (`MESU6`) and Yahoo `=F` resolve to the root; option packages resolve to the underlying. Unknown symbols show the bare ticker with no tooltip. Display only. Does not change MockBroker orders. iOS essentials does not list individual tickers, so it has no VoiceOver symbol description.

**Stage-3** — Post-print window on an NFP/CPI/FOMC day after knowledge_time is stamped (manual, ops, or auto-stamp after the print when a freeze card exists). Day-sleeve MES stoch may open only then, and only while GATE is idle. Not PRE-ARM or NO-STOP BAND. iOS essentials shows whether Stage-3 is armed.

**StopLimit** — Stop-limit order type. Cancelled as market-or-stop on gated roots in PRE-ARM and NO-STOP BAND.

**StopMarket** — Stop-market order type. Same cancel rules as Market on gated roots in those windows.

**TA** — Technical analysis. Momentum/ownership entries come from the S&P scan filters and scores, not from the event clock.

**TLT** — iShares 20+ Year Treasury Bond ETF. Long-duration candidate on the risk-off 63d RS overlay (first in the duration bucket). Preferred name for gated duration (IEF fallback) when RISK OFF, SPY is below 200dma, and the dollar veto is clear. Also on momentum and ownership quote strips.

**TRADING_MODE** — Process env. mock is required; live is refused. TradovateDemoBroker is a stub pinned to demo.tradovateapi.com.

**Tradovate** — Futures broker. Demo stub only (demo.tradovateapi.com). Order/position calls are not wired; gate uses MockBroker. Live host URLs throw.

**UUP** — Invesco DB US Dollar Index Bullish Fund. RISK ON dollar veto if 20-session return is missing or greater than +3%. Also a 63d RS candidate on the risk-off ETF overlay (second preference after GLD). Dollar veto must be clear for the gated TLT/IEF duration long.

**USMV** — iShares MSCI USA Min Vol Factor ETF. Min-vol equity candidate on the risk-off 63d RS overlay. Same gates as the other non-CTA names: 63d total return strictly above BIL, and last above its own 200dma, or that name is skipped (none left → BIL). Exact RS ties use preference order after CLSE and before FTLS (GLD > GDX > PDBC > UUP > duration > defensives > trend > CLSE > USMV > FTLS). Top-2 50/50 and the 50bp hysteresis apply. Not CTA (not in RISKOFF_ETF_CTA_FAMILY) and not subject to the 21-session beat-BIL confirmation; a weak or missing 21d return does not skip USMV. Can fill non-CTA #2 when RS #1 is DBMF/KMLM. If no non-CTA clears, that #2 is BIL rather than the other CTA. Paper / MockBroker only.

**uPnL** — Unrealized profit and loss on open mock positions. Marks from delayed last (or vertical/overlay MTM). The paper blotter shows that mark on each open sleeve row as signed dollars (green/red), beside dPnL. Flat or zero qty is not an open row.

**Vite** — Client bundler/dev server for the React SPA.

**VPS** — Virtual private server running Event Gate (systemd event-gate, nginx, postgres, redis).

**VWAP** — Volume-weighted average price (session, RTH). Day-sleeve MES longs only above it, shorts only below. Paper exit (“VWAP lost”) needs two consecutive completed 5m closes on the wrong side (DAY_VWAP_EXIT_CLOSES = 2). A single-bar pierce holds.

**VXX** — iPath Series B S&P 500 VIX Short-Term Futures ETN. Not a live risk-off expression.

**WS** — WebSocket /ws for live status and log. The status snapshot kicks paper-stop marks in the background and does not wait on delayed quotes or option chains (GET /api/quotes still awaits the mark).

**XcodeGen** — Optional Mac tool. `ios/project.yml` can regenerate `ios/EventGate.xcodeproj`. The checked-in xcodeproj is enough to open on a Mac without installing XcodeGen.

**XLP** — Consumer Staples Select Sector SPDR Fund. Defensive-equity candidate on the risk-off 63d RS overlay (after XLU).

**XLU** — Utilities Select Sector SPDR Fund. Defensive-equity candidate on the risk-off 63d RS overlay (first in the defensives bucket).

**Yahoo** — Yahoo Finance chart API. Fallback for futures =F lasts and day MES 5m bars when Massive Futures is unconfigured or errors. Equities stay Massive Stocks Starter.

**ZB** — CME 30-Year U.S. Treasury Bond futures. Gated root.

**ZF** — CME 5-Year U.S. Treasury Note futures. Gated root.

**ZN** — CME 10-Year U.S. Treasury Note futures. Gated root; freeze-card liquid contract; day quote strip. Massive Futures product_code ZN (front-month); Yahoo fallback ZN=F.

**ZT** — CME 2-Year U.S. Treasury Note futures. Gated root.

