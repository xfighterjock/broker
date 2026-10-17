# Event Gate abbreviations

Glossary of product terms, futures roots, and methodology tickers used in Event Gate. Alphabetized. Does not list the full S&P 500 scan universe.

If this file disagrees with code, the code wins. Update alongside docs/DESIGN.md.

---

**6E** — CME Euro FX futures. Gated root (GATED_ROOTS). Massive Futures product_code 6E (front-month dated ticker); Yahoo fallback 6E=F.

**20dma** — 20-day simple moving average. Momentum pullback filter uses last vs this SMA (dist20).

**200dma** — 200-day simple moving average. RISK ON requires SPY, ACWI, and HYG last above it. Momentum and ownership filters and below-200 exits use it too. It does not gate the csp sleeve.

**%D** — Stochastic signal line. Day sleeve: 3-period SMA of slow %K (14,3,3). csp sleeve: period 5 (`CSP_STOCH_D`) on the (30,5,5) slow stochastic. A csp entry needs %K to cross up through %D while %K is below 20.

**%K** — Slow stochastic. Day sleeve: (14,3) on MES after Stage-3. csp sleeve: period 30, smooth 5 (`CSP_STOCH_K`, `CSP_STOCH_SMOOTH`). csp enters on a cross up through %D while %K is below 20. That sleeve has no 200-day filter.

**ACWI** — iShares MSCI ACWI ETF (global equities). One of three 200dma legs on the RISK ON badge.

**activity log** — Phone (and desktop) feed of the existing `gate_log` journal (`engine.log`). GET `/api/activity?limit=&before=` pages newest first; `before` is a `gate_log.id` cursor. Default `limit` 50, max 100. Not on GET `/api/status` (`actionLog` / `sessionLog` there are empty). Rows older than `ACTIVITY_LOG_RETENTION_DAYS` (90) are deleted from `gate_log` and `session_logs`. Paper/mock activity only. GET `/api/log` is the same page with a `log` alias. Not on EVENT_GATE_OPS_TOKEN.

**APNs** — Apple Push Notification service. iOS devices receive remote notifications through APNs while Firebase maps delivery through FCM tokens. Firebase Console still needs an APNs Authentication Key (`.p8`) uploaded for the Event Gate iOS app; that key is not in git.

**argon2id** — Password hash for the `users` table. Never stored in plaintext.

**ATM** — At the money. Options-sleeve auto call debit verticals pick the strike closest to last (`pickAtmCallDebit`), 30–45 DTE only.

**auth_needed** — FCM eventType when E*TRADE transitions to `needs_pin`. Deduped as `auth_needed:etrade:needs_pin`.

**AUTH_MODE** — Auth front door. Production `users` (users table + cookie/bearer). Local default `cookie` (GATE_PASSWORD). `nginx` is remapped to `users` in production. GET /api/public/risk is exempt in-app too.

**AUTO PAPER** — Autopilot. Independent enable per sleeve (`autoPaperBySleeve`: day, momentum, options, ownership, csp). Snapshot `autoPaper` is true if ANY sleeve is on (badge / old clients). POST /api/paper/auto `{ enabled }` sets all; `{ sleeveId, enabled }` sets one. Redis `paper:auto` is JSON; legacy `0`/`1` migrates on first boot (`0` all off including csp, `1` all on including csp). Default all on when the key is missing. A missing `csp` key defaults ON even when other sleeves are explicitly false. Explicit `csp: false` stays off. A stored `riskoff` key is stripped. The options-sleeve CSP/CC overlay stays manual. The csp sleeve sells cash-secured puts when its AUTO flag is on, in both risk regimes. GATE still binds day and new csp shorts. Day MES stoch also needs Stage-3: an NFP/CPI/FOMC ET day, knowledge_time on that day at or after the anchor, and now at or after the stamp. A non-print or pre-print stamp does not enter. Idle RTH without the stamp does not enter. On a CPI day, day AUTO also runs `cpiLateFade` when `CPI_LATE_FADE_ENABLED` is true. Essentials and the desktop header chips are D, M, O, Ow, Cs (`AUTO_SLEEVE_CHIPS` in client/src/essentials.ts; iOS `SleeveChip` in EssentialsFormat.swift).

**bearer** — Opaque session token from POST /api/auth/login. Stored as sha256 in Postgres `user_sessions` (`SESSION_TTL_MS` 30 days). iOS keeps the raw token in the Keychain and sends `Authorization: Bearer`. SPA uses cookie `eg.sid` instead.

**beta** — Trailing 252-session beta of daily returns versus SPY (`CSP_BETA_DAYS`, `betaToBenchmark` in server/src/cspMath.ts). The csp sleeve requires beta above 1.3 (`CSP_BETA_MIN`). Recomputed on each csp scan (`cspScanDue` in server/src/cspScan.ts): once per cash-session day in the 16:10–16:25 ET window, or when the stored scan is missing or older than 26 hours. Not a monthly job.

**BIL** — SPDR Bloomberg 1-3 Month T-Bill ETF. The risk-off sleeve that used BIL as an RS cash benchmark and an idle-cash sweep was deleted, including its paper history. BIL is not auto-traded and the csp sleeve does not trade it. The csp Black-Scholes rate uses the live 13-week yield when Yahoo ^IRX returns one, otherwise 0.04 (`CSP_BS_RATE_FALLBACK`). No sleeve earns interest on idle cash. T-bills are only a benchmark.

**BTAL** — AGF U.S. Market Neutral Anti-Beta Fund. Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**BUNDLE_ID** — iOS application id. Event Gate iOS must stay `com.logikmancer.mybroker` to match the existing Firebase iOS app.

**calendarStale** — GET `/api/status` flag. True when no future NFP, CPI, or FOMC row falls within 35 days (`CALENDAR_STALE_WITHIN_MS`). The process logs `calendar stale` once per stale stretch. Web and iOS show `Calendar stale: no NFP/CPI/FOMC in the next 35 days`. A September-only `events` table (the old seed) is stale after those prints. Not a GateMode and not an arm by itself.

**cash sweep** — Retired. The risk-off idle-cash BIL lot was deleted with that sleeve, including its paper history.

**CC** — Covered call. Manual overlay on the options sleeve, tagged to an ownership or SPCX thesis. Not sold by autopilot. Never naked.

**CI** — Continuous integration. On every push to master, GitHub Actions runs `npm test` and the server and client typechecks before a VPS deploy. The deploy job does not start unless those pass. See docs/DEPLOY.md.

**CLSE** — Convergence Long/Short Equity ETF. Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**CME** — CME Group. Home of the gated futures roots (MES, ES, NQ, Treasuries, FX, SR3).

**CPI** — Consumer Price Index print. Calendar event; freeze card; flatten 15:45 ET. Day-sleeve event clock only. 08:30 America/New_York. Dates through December 2027 are in `seedEvents()` and migration `005_calendar_through_2027.sql` (BLS CPI schedule; 2027 day-of-month also on the OMB FY2027 principal-indicator schedule). The `cpiLateFade` paper leg reads these same CPI rows (Postgres `events` when present, otherwise `seedEvents()`). It does not hardcode dates. October 2026 CPI is `cpi-2026-10-14` (2026-10-14T12:30:00Z). NFP and FOMC rows are not CPI.

**CPI_LATE_FADE_ENABLED** — Flag in `shared/constants.ts`, default true. When true and day AUTO PAPER is on, the day sleeve may open the `cpiLateFade` paper lot. Set false to stop new entries. An open lot still flattens at the cash close. MockBroker only.

**cpiLateFade** — Day-sleeve paper strategy id for the CPI-day late-session fade. CPI calendar rows only. Signal is the sign of the MES 5-minute move from the prior NYSE session's 16:00 ET close (15:55 bar close; weekends and full holidays skipped) to 10:30 ET (10:25 bar close). The fade series is Yahoo `range=5d` or Massive five-day newest-first aggs, merged with the day series. The Yahoo fallback is `range=5d` (not `range=1d`) so the prior 16:00 ET bar exists. The stochastic leg uses only the current ET day's bars. At 15:30 ET, 1 MES opposite that sign. Missing, stale, or a zero move does not trade. An entry-window skip is logged once per ET day at info. Protective stop 0.4% adverse from the mock fill. Flatten at or after 15:59 ET. Position tag `cpiLateFade`; blotter notes start with `cpiLateFade`. Skips when the stochastic MES lot is already open. The 15:45 session flatten does not take this lot. Stage-3, GATE idle, qty 1, and the day-sleeve loss cap still bind new entries. RISK ON/OFF does not. Paper / MockBroker only.

**credit_put_opened** — FCM helper `notifyCreditPutOpened` still sends “Credit-leg put opened on {symbol}.” `CREDIT_LEG_SYMBOLS` is HYG, LQD, JNK. No trading path calls it (tests only). The credit-leg program was deleted with the risk-off sleeve.

**credit_put_risk_on_flatten** — FCM helper `notifyCreditPutRiskOnFlatten` still sends “RISK ON flattened credit-leg puts.” No trading path calls it (tests only).

**credit_put_stopped** — FCM helper `notifyCreditPutStopped` still sends “Credit-leg put 50% debit stop on {symbol}.” No trading path calls it (tests only).

**Cs** — AUTO PAPER chip initial for the csp sleeve. The five chips are D, M, O, Ow, Cs on the desktop header, web essentials, and iOS. Source: `AUTO_SLEEVE_CHIPS` in client/src/essentials.ts and `SleeveChip` in ios/EventGate/EssentialsFormat.swift. The desktop hint in client/src/App.tsx and the iOS README read D / M / O / Ow / Cs.

**CSP** — Cash-secured put. Two uses. (1) Sleeve id `csp`: paper cash-secured puts on oversold high-beta S&P 500 names. Not gated by RISK ON/OFF. Default AUTO ON. (2) Manual overlay on the options sleeve (`POST /api/paper/csp`), which reserves strike × 100 × qty and is not sold by the csp autopilot. Never naked. Never a live order.

**csp** — Sleeve id for cash-secured puts (oversold high-beta). Trades in both risk regimes. See DESIGN.md.

**CSP_ADR_EXCLUSIONS** — Empty list in shared/cspUniverse.ts. Tickers removed from the csp universe even if a future constituent file lists them. ADRs belong here.

**CSP_BETA_DAYS** — 252. Trailing sessions for csp beta versus SPY (`betaToBenchmark` in server/src/cspMath.ts).

**CSP_BETA_MIN** — 1.3. csp requires beta strictly above this (`isHighBeta`).

**CSP_BS_RATE_FALLBACK** — 0.04. Black-Scholes rate when the Yahoo ^IRX quote is missing (`annualRateFromIrx`). Not a fill and not a paper P/L credit.

**CSP_COLLATERAL_FRAC** — 0.10. Target collateral per csp put is about 10% of sleeve equity (`sizeCashSecuredPut`).

**CSP_DELTA_TARGET** — 0.20. csp strike nearest this absolute delta (`pickCspStrike`).

**CSP_DTE_MAX** — 50. Upper bound of the csp expiry window (`pickCspExpiry`).

**CSP_DTE_MIN** — 35. Lower bound of the csp expiry window (`pickCspExpiry`).

**CSP_MACD_FAST** — 12. MACD fast EMA on the csp sleeve (`macdHistogram`).

**CSP_MACD_SIGNAL** — 9. MACD signal EMA on the csp sleeve.

**CSP_MACD_SLOW** — 26. MACD slow EMA on the csp sleeve.

**CSP_MAX_POSITIONS** — 10. Cap on concurrent csp short puts (`sizeCashSecuredPut`).

**CSP_MAX_SPREAD_OF_MID** — 0.5. Skip a csp put when the bid/ask spread is wider than half the mid (`planCspEntry`).

**CSP_MIN_BID** — 0.05. Skip a csp put when the bid is not above this.

**CSP_MIN_OPEN_INTEREST** — 100. Minimum open interest on the chosen csp put (`openInterestOk`).

**CSP_ONE_LOT_MAX_FRAC** — 0.15. Skip when one contract's collateral would exceed 15% of sleeve equity.

**CSP_RECORDER_TOP_BETA** — 50. The chain recorder also snapshots the 50 highest betas (`recorderSymbols` in server/src/cspScan.ts).

**CSP_SCAN_END_MINUTE** — 16:25 ET (990 minutes). End of the after-close csp scan window (`cspCloseScanWindow`).

**CSP_SCAN_STALE_MS** — 26 hours. A missing or older stored scan is retried on the next autopilot tick (`cspScanDue`).

**CSP_SCAN_START_MINUTE** — 16:10 ET (970 minutes). Start of the after-close csp scan window.

**CSP_SHADOW_RULES** — Log-only exit ids in server/src/cspMath.ts: tp50, dte21, combined, tp75, swing_low, spy_200, 7, 8, 7+2x, 8+2x, 7+8+2x, 7d03, 8d40, 7d03+2x, 8d40+2x, 7d03+8d40+2x. `shadowOrders` rejects any order whose reason starts with shadow. They do not trade.

**CSP_SHARE_CLASS_DROP** — GOOG, FOX, NWS. Secondary share classes dropped when the primary class is also in the csp universe (shared/cspUniverse.ts).

**CSP_STOCH_D** — 5. csp slow-stochastic %D period (`slowStochastic`).

**CSP_STOCH_K** — 30. csp slow-stochastic %K period.

**CSP_STOCH_SMOOTH** — 5. csp slow-stochastic %K smooth.

**CSP_STOP_MULT** — 2. Live csp exit when the put mid reaches 2× the entry premium (`twoXStopHit`). Shadow rules do not use this as an order.

**CSP_SWING_LOOKBACK** — 20. Sessions of swing low stored for the shadow `swing_low` rule only (`swingLowBeforeEntry`).

**CSP_TARGET_DTE** — 45. csp expiry nearest this DTE inside 35–50 (`pickCspExpiry`).

**CSP_UNIVERSE** — Baked S&P 500 single-name list in shared/cspUniverse.ts. Not fetched at runtime and not the momentum scan CSV. The file is the name list; this glossary does not dump it.

**CSP_UNIVERSE_REFRESHED** — 2026-10-17. Date stamp on `CSP_UNIVERSE` in shared/cspUniverse.ts.

**CTA** — Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**day_loss_cap** — FCM eventType for a paper loss flatten. Two payloads: GATE daily-loss on mock dayPnl (`day_loss_cap:gate_daily:{NY date}`) vs the day sleeve’s own `lossCapUsd` (`day_loss_cap:sleeve:{NY date}`). The sleeve body is used only when that sleeve’s book actually crossed its cap.

**dayPnl** — MockBroker.getDayPnl(): Redis `mock:day_pnl` realized accumulator plus open unrealized. GATE flatten-on-daily-loss ($500 dailyLossUsd). Not the day sleeve `lossCapUsd`. Not the blotter **dPnL** column (that is one open lot's mark vs prior close). Does not roll with NY session marks. POST `/api/paper/reset` rebuilds it from remaining sleeves' session daily; POST `/api/day-pnl` sets it by hand.

**DBMF** — iMGP DBi Managed Futures Strategy ETF. Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**delta** — Option delta. csp targets absolute delta 0.20. Shadow probability rules use absolute delta. E*TRADE greek when the chain has it; otherwise Black-Scholes from chain IV (13-week rate when known, else 0.04).

**distribution** — Retired. Risk-off ETF dividend credits were deleted with that sleeve, including Redis `paper:riskoff_distributions`.

**dma** — Daily moving average. See 20dma / 200dma.

**dollar veto** — RISK ON fails when UUP's 20-session return is missing or greater than +3% (RISK_UUP_VETO_FRAC). Exposed as dollarVeto on GET /api/public/risk. It does not gate the csp sleeve.

**dPnL** — Day P/L on one open mock lot in the paper blotter (`Position.dayPnl`). Stock and futures: same `signedPnl` as uPnL (side, qty, point value) vs prior close, or the quote's day change when prior close is missing. Debit vertical: (long netChange − short netChange) × 100 × qty. Short overlay: −netChange × 100 × qty. Signed dollars, green/red, same as sleeve-tab P/L. Distinct from uPnL and from account dayPnl. Flat or zero qty is not an open row. Fill journal has no dPnL column.

**DTE** — Days to expiration. Options-sleeve auto verticals target 30-45 DTE and exit at 21 DTE (OPTIONS_DTE_EXIT). The csp sleeve targets 45 DTE and accepts 35–50. A shadow rule exits at 21 DTE on paper only (it does not trade).

**duration** — Treasury-bond exposure (TLT, IEF). The risk-off gated-duration long and the RS overlay that held them were deleted, including paper history. TLT stays on the momentum and ownership quote strips. Duration does not gate the csp sleeve.

**E\*TRADE** — Broker API used for live option chains and OAuth only. Never orders. Production base api.etrade.com.

**ES** — CME E-mini S&P 500 futures. Gated root. Massive Futures product_code ES (front-month); Yahoo fallback ES=F. On the momentum quote strip.

**ET** — America/New_York clock. Gate windows, 15:50 vertical cutoff, session marks, E*TRADE renew window, flatten times.

**ETF** — Exchange-traded fund. The csp universe excludes ETFs, ETNs, and funds. The risk-off ETF relative-strength overlay was deleted, including its paper history.

**EVENT_GATE_OPS_TOKEN** — Optional long-lived HTTPS ops bearer (VPS `/opt/broker/.env`, never git). When set, `Authorization: Bearer` matching the env value authenticates a narrow ops scope: GET /api/status, GET/PUT /api/freeze, GET /api/health, GET /api/sleeves, POST /api/paper/auto, POST /api/flatten, POST /api/paper/reset, POST /api/gate/enable, POST /api/knowledge-time, POST /api/etrade/renew (print-day vetoes: flatten + GATE OFF; paper sleeve reset without a delayed last; same knowledge_time stamp as a user). Same GATE route also GATE ON (`{ enabled: true }` or omitted, defaults ON) — no separate disable path. POST `/api/etrade/renew` only resets idle expiry (GET oauth/renew_access_token); midnight ET still needs a human PIN. Not a users-table session. Paper orders, PIN (`/api/etrade/oauth/start` and `/pin` stay 401 for ops), mock inject, cancel-stops, user admin stay 401. When unset, behavior unchanged. Agents freeze-save, status-check, toggle AUTO, flatten, reset one mock sleeve, GATE OFF, stamp knowledge_time, and force-renew the E*TRADE access token at https://broker.logikmancer.com without the Mac.

**Face ID** — iOS LocalAuthentication unlock of a Keychain session. Optional. Not a remote password. Touch ID is the same path.

**FedWatch** — CME FedWatch snapshot field on the freeze card (NFP/CPI/FOMC briefing).

**FCM** — Firebase Cloud Messaging. Event Gate push provider (HTTP v1 via Firebase Admin SDK on the VPS; Firebase iOS SDK in `ios/`). Disabled by default until `PUSH_FCM_ENABLED=1` and credentials are configured. The iOS client registers tokens with a users-table bearer; it does not hold the Admin service-account JSON. Trading or status paths can send `risk_flip`, `service_fault`, `auth_needed`, `pre_arm`, `freeze_missing`, `day_fill`, `day_flatten`, `day_loss_cap`, `veto_confirm`, `etrade_renew_failed`, `sleeve_loss_warn`, plus test `paper_guard`. `overlay_rotation`, `credit_put_opened`, `credit_put_stopped`, `credit_put_risk_on_flatten`, and `oi_skip_streak` stay in `EVENT_GATE_ALERT_TYPES` but no trading path calls their helpers after the risk-off sleeve was deleted.

**Flatten** — Close gated day-sleeve names (POST /api/flatten) or a sleeve position (POST /api/paper/close, needs a delayed last). Print-day veto with GATE OFF. Does not flatten momentum, options, ownership, or csp from the event clock. Not a sleeve reset — that is POST /api/paper/reset.

**FOMC** — Federal Open Market Committee. Calendar rows FOMC_STATEMENT (14:00 ET) and FOMC_PC (14:30 ET) on the second meeting day; flatten 15:30 ET when type contains FOMC. Dates through December 2027 are from federalreserve.gov/monetarypolicy/fomccalendars.htm and the September 5, 2025 schedule release (statement 2:00 p.m. ET, press conference 2:30 p.m. ET). January 2028 is listed by the Fed but not seeded.

**FOMC_PC** — FOMC press conference calendar type.

**FOMC_STATEMENT** — FOMC statement calendar type.

**FLOT** — iShares Floating Rate Bond ETF. Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**FTLS** — First Trust Long/Short Equity ETF. Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**GATE** — Event-clock risk gate on futures roots. Modes: idle, PRE-ARM, NO-STOP BAND, SESSION FLATTEN. Enable via POST /api/gate/enable. Not the login password (GATE_PASSWORD is cookie-mode / signing only). Session flatten does not close a csp put. `planCspEntry` skips a new csp short when GATE is off or the mode is not idle.

**GATED_ROOTS** — MES, MNQ, ES, NQ, ZN, ZF, ZT, ZB, SR3, 6E, M6E. Longest-first match so MES wins over ES, M6E over 6E, MNQ over NQ.

**GDX** — VanEck Gold Miners ETF. Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**GHA** — GitHub Actions. Hosted CI that builds Event Gate and rsyncs the server bundle, `client/dist/`, and `db/migrations/*.sql` to the VPS (no `--delete` on the SQL directory). Repository secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, and optional `DEPLOY_PORT` are never committed. If `DEPLOY_SSH_KEY` is unset, the deploy step skips with a notice and the workflow stays green. See docs/DEPLOY.md.

**GICS** — Global Industry Classification Standard. Momentum ranks one name per sector; ownership allows two.

**GLD** — SPDR Gold Shares. Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**holiday** — NYSE full-day cash close. Status `marketSession.closedReason` (`holiday` / `weekend` / `early_close`). Web and iOS show a muted closed strip. Does not change GateMode, flatten books, or pause AUTO.

**HYG** — iShares iBoxx $ High Yield Corporate Bond ETF. One of three 200dma legs on the RISK ON badge. It does not gate the csp sleeve. The credit-leg put program was deleted with the risk-off sleeve.

**IEF** — iShares 7-10 Year Treasury Bond ETF. Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**inCashSession** — `marketSession` flag, true only from 09:30 ET until the NYSE cash close (16:00 ET, 13:00 ET on early-close days). Distinct from `cashOpen` (calendar day). Web and iOS countdowns use it to choose `Cash close in` vs `Cash open in`.

**inverse-vol** — Retired. Inverse realized-vol weights belonged to the deleted risk-off RS overlay.

**iOS Event Gate** — Native SwiftUI app in ios/ (bundle com.logikmancer.mybroker). Phone Event Gate client: essentials (clock, cash open/close countdown under the ET clock, US cash closed/holiday strip, GATE, RISK, AUTO PAPER chips D/M/O/Ow/Cs (`SleeveChip` in EssentialsFormat.swift), read-only knowledge_time and Stage-3 (`Stage-3 armed (auto)` / `Stage-3 not armed`; no stamp button), Flatten, sleeve P/L, E*TRADE re-auth banner), paged Activity log, plus FCM. When `etradeAuth` is not `ok`, the banner opens in-app Safari (SFSafariViewController) and the PIN is typed in the app. Settings links to the web app as a fallback. Users-table login + optional Face ID / Touch ID unlock of the Keychain session. Web `/m` remains for browsers. A new phone build is an Xcode install, not a web deploy. Push notification glyph is the AppIcon (same auto-agent artwork as the web favicon).

**IRX** — Yahoo chart symbol `^IRX`, the 13-week T-bill yield. `tbillRate` in server/src/cspLive.ts reads it. `annualRateFromIrx` treats a last above 1 as percent. Used only as the Black-Scholes rate when the E*TRADE greek is missing. A missing quote uses `CSP_BS_RATE_FALLBACK` (0.04). Not a paper P/L credit. No sleeve accrues interest on cash.

**IV** — Implied volatility from the option chain, stored as a decimal (0.21 is 21%). csp records it and uses it for the Black-Scholes delta fallback.

**IWM** — iShares Russell 2000 ETF. Options quote strip. Not a csp underlying. The risk-off equity-index put was deleted with that sleeve.

**JNK** — SPDR Bloomberg High Yield Bond ETF. The credit-leg put on the risk-off sleeve was deleted with that sleeve, including paper history. Not a RISK ON badge leg.

**Keychain** — iOS credential store. Event Gate iOS keeps the session bearer, login username, and last registered FCM token (`replaceToken`) here only — never UserDefaults, never git.

**KMLM** — KFA Mount Lucas Managed Futures Index Strategy ETF. Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**knowledge_time** — Timestamp after the print used on the freeze checklist (knowledge_time after print). Also the day-sleeve Stage-3 arm: new MES stoch entries only when this stamp is set, `now` is at or after it, both share the same America/New_York calendar day, that day has an NFP, CPI, or FOMC row, and the stamp is at or after the anchor print. A stamp on a non-print day (jobless claims, a blank day) does not arm (`knowledge_time not on a print day`). A stamp before the anchor does not arm (`knowledge_time before print`). Ordinary idle RTH without a same-day stamp does not open MES. PRE-ARM, NO-STOP BAND, and SESSION FLATTEN still veto new entries. Existing lots keep stop / VWAP-exit / 15:45 flatten / sleeve loss cap. Auto-stamp is the primary path: on an NFP, CPI, or FOMC America/New_York day, at or after the anchor print time, the status snapshot and the autopilot tick stamp if that ET day has no at-or-after-anchor stamp, whether or not a freeze card exists. A pre-print stamp does not block that write. FOMC uses STATEMENT time when both STATEMENT and PC exist; otherwise the FOMC row. NFP and CPI use the print time. Jobless claims and other non-print rows do not stamp. POST `/api/knowledge-time` remains a backstop for a user session (manual) or EVENT_GATE_OPS_TOKEN (ops). On a non-print ET day, or before the anchor, it returns 409, stores nothing, and logs `knowledge_time refused (manual|ops): …`. Desktop, web `/m`, and iOS do not show a stamp button; they display the stamp and `Stage-3 armed (auto)` / `Stage-3 not armed`. Web uses the same print-day rule from `events`. iOS has no event list and reads `stage3Armed` on the snapshot. A stamp already at or after the anchor that ET day is idempotent. Logs: `knowledge_time manual`, `knowledge_time ops-stamped`, `knowledge_time auto-stamped`, `knowledge_time refused`.

**Limit** — Limit order type. Gate leaves limits alone unless oversize.

**lossCapUsd** — Per-sleeve paper loss cap in dollars. Day 500, momentum 1000, options 1000, ownership 2000, csp 10000. The csp cap blocks new shorts when realized P/L or the sleeve book's total P/L is at or below −lossCapUsd; the 2× stop, earnings close, and expiration still run. Other sleeves key the cap off realized P/L. Paper / MockBroker only.

**LQD** — iShares iBoxx $ Investment Grade Corporate Bond ETF. The credit-leg put on the risk-off sleeve was deleted with that sleeve, including paper history. Not a RISK ON badge leg.

**M6E** — CME Micro Euro FX futures. Gated root; freeze-card liquid contract; day quote strip. Massive Futures product_code M6E (front-month); Yahoo fallback M6E=F.

**MACD** — Moving average convergence/divergence. csp uses MACD(12,26,9). The histogram must be higher than the prior day. No 200-day filter on this sleeve.

**Market** — Market order type. Cancelled on gated roots in PRE-ARM and NO-STOP BAND.

**marketSession** — Top-level GET `/api/status` field: NYSE cash calendar in ET (`cashOpen`, `inCashSession`, `closedReason`, `holidayName`, `asOfEt`, `nextOpenEt`, `nextCloseEt`, `nextOpenAt`, `nextCloseAt`). Not a GateMode. Web header, `/m`, and the iOS essentials header count down to `nextCloseAt` while `inCashSession` (`Cash close in 2h 14m 03s`) and to `nextOpenAt` otherwise (`Cash open in …`). Tick is client-side (Swift `TimelineView` on iOS, about once a second, no extra status poll). Early close is 13:00 ET.

**Massive** — Market-data vendor (api.massive.com). Same MASSIVE_API_KEY: Stocks Starter for equities last, S&P scan dailies, RISK ON bars (SPY, ACWI, HYG, UUP), and csp daily OHLC (`fetchMassiveOhlcDailyBars`, used when at least 80 bars come back). Futures for day MES 5m aggs and futures quote-strip lasts (front-month dated contracts such as MESZ6 via `/futures/v1/contracts?date=` the ET session + `/futures/v1/aggs` + `/futures/v1/snapshot`). No documented continuous F: ticker — do not invent one. Yahoo =F `range=5d` is the futures 5m fallback so the prior 16:00 ET bar is present. LQD/JNK 200dma bars and the risk-off ETF RS overlay are not fetched.

**MES** — CME Micro E-mini S&P 500 futures. Gated root; freeze-card liquid contract; day quote strip and paper symbol MES=F. Day-sleeve 5m stoch/VWAP bars prefer Massive Futures front-month (product_code MES); Yahoo MES=F fallback.

**MIT** — Market-if-touched order type. Treated as market-or-stop: cancelled in PRE-ARM and NO-STOP BAND on gated roots.

**MNQ** — CME Micro E-mini Nasdaq-100 futures. Gated root. Massive Futures product_code MNQ; Yahoo fallback MNQ=F.

**MockBroker** — In-memory paper broker persisted in Redis. The only place Event Gate fills BUY/SELL. Not Tradovate, not E*TRADE.

**MTM** — Mark to market. Vertical and overlay unrealized P/L use chain marks, not invented prices.

**NFP** — Nonfarm payrolls (Employment Situation) print. Calendar event; freeze card; flatten 15:45 ET. Day-sleeve event clock only. 08:30 America/New_York. Dates through December 2027 are in `seedEvents()` and migration `005_calendar_through_2027.sql` (BLS Employment Situation schedule; 2027 day-of-month also on the OMB FY2027 principal-indicator schedule).

**nginx** — TLS reverse proxy in front of 127.0.0.1:3001. No htpasswd on /api or the SPA; app auth is the users table. GET /api/public/risk stays unauthenticated.

**NinjaTrader** — Futures platform. README notes a live NT API add-on is not required for mock. This repo is not an NT order router.

**NO-STOP BAND** — Gate mode T-2m to T+2m around the event. Cancels Market / StopMarket / StopLimit / MIT on gated roots.

**NQ** — CME E-mini Nasdaq-100 futures. Gated root. Massive Futures product_code NQ; Yahoo fallback NQ=F.

**NY** — New York session date (America/New_York calendar YYYY-MM-DD) used for sleeve session marks and same-day vertical stop cooldown.

**NYSE** — New York Stock Exchange cash calendar. Event Gate `marketSession` uses the NYSE equity holiday set (New Year’s, MLK, Presidents’, Good Friday, Memorial Day, Juneteenth, Independence Day, Labor Day, Thanksgiving, Christmas, plus weekend observance) in America/New_York. Orthogonal to GATE.

**OAuth** — E*TRADE 1.0a handshake. Authorize + PIN (`oauth_callback=oob`); in-process renew during the cash session. Web and iOS both call `POST /api/etrade/oauth/start` then `POST /api/etrade/oauth/pin`. The authorize URL is not shown as text.

**OI** — Open interest. A csp short requires at least 100 on the chosen put. Manual options-sleeve verticals have no OI floor.

**oi_skip_streak** — FCM helper `noteCreditLegOiSkip` still counts HYG/LQD/JNK skips and would send once at 6 inside about 30 minutes. No trading path calls it. `resetOiSkipStreak` still runs when RISK ON is true (`runAutopilot`, `applyResolvedRisk`).

**OTM** — Out of the money. Put debit shorts a lower strike; call debit shorts a higher strike.

**overlay_rotation** — FCM eventType still in `EVENT_GATE_ALERT_TYPES`. `notifyOverlayRotation` body is `Risk-off overlay {from} → {to}`. No caller outside tests after the risk-off sleeve was deleted. It does not fire on csp.

**paper_guard** — FCM eventType used only by `POST /api/notifications/test` (`dedupeKey` `event-gate-test`). Not a live trading alert.

**P/L** — Profit and loss. Sleeve books expose realized, unrealized, dailyPnlUsd, totalPnlUsd (equity minus $100k). The csp loss cap reads realized and total. See lossCapUsd.

**PDBC** — Invesco Optimum Yield Diversified Commodity Strategy ETF. Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**PIN** — E*TRADE verifier after Authorize. Typed in Event Gate (desktop banner under the header, web `/m`, or the iOS essentials banner). Needed after midnight ET, and when renew returns HTTP 401 (`etradeAuth` `needs_pin`). Never stored in git or chat.

**Postgres** — Database for calendar events, freeze snapshots, `users` + `user_sessions`, iOS FCM device tokens, push-alert dedupe, and the activity journal (`gate_log`, plus `session_logs`). Activity rows older than 90 days are deleted. Production calendar is the `events` table: if it has any rows, those replace `seedEvents()`. Migration `001_init.sql` inserted only September 2026, which is why the live book went idle after those prints. Migration `005_calendar_through_2027.sql` adds the later NFP, CPI, and FOMC rows. Migration `006_csp_and_drop_riskoff.sql` adds `csp_option_snapshots` and `csp_shadow_exits` and deletes rows tagged `riskoff`.

**PRE-ARM** — Gate mode T-15m to T-2m. Cancels Market / StopMarket / StopLimit / MIT on gated roots.

**push dedupe key** — Stable alert key used to suppress repeat deliveries in a configured window (default 30 minutes).

**QQQ** — Invesco QQQ Trust (Nasdaq-100). Options quote strip and momentum/ownership quote strip. The risk-off equity-index put was deleted with that sleeve.

**QUAL** — iShares MSCI USA Quality Factor ETF. Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**realized vol** — Sample standard deviation of returns. The risk-off overlay's 20-session inverse-vol weight was deleted with that sleeve. Not the 20-session UUP dollar veto.

**Redis** — Cache/store for gate flags, mock book, sleeves, blotter, session marks, scan, AUTO PAPER (per-sleeve JSON on `paper:auto`), last-known RISK ON/OFF (`risk:on`), and SPA cookie sessions (cookie name `eg.sid`, Redis prefix `eg:sess:`). csp scan state is `paper:csp_state` (`REDIS_KEYS.cspState`). Boot purge deletes `paper:riskoff_distributions`.

**RISK OFF** — Badge when RISK ON is false. Pauses new momentum longs and options call-debits. Ownership pauses new adds. The csp sleeve keeps trading. The day sleeve is not bound. The former risk-off sleeve was deleted, including its history. A null above200 check is not a below-200 read.

**RISK ON** — Badge iff SPY, ACWI, and HYG are above 200dma and UUP 20d is not greater than +3%. A missing or too-short series is null on that check and fails the badge closed to RISK OFF. Null is not reported as below 200dma. The badge does not gate the csp sleeve; csp trades in both regimes.

**RISK_ABOVE200_STALE_MAX_MISSES** — 3. Consecutive risk refreshes that may repeat the last computed SPY/ACWI/HYG above200 boolean before that check is published as null. At the 15-minute risk cache, misses 1–2 are about 45 minutes (a few refreshes, inside one cash session); the third null is "200dma missing", not "below". Process-local, not persisted. Does not carry the dollar veto. Does not gate the csp sleeve.

**risk_flip** — FCM eventType when the global RISK ON/OFF badge changes. Last-known state is in memory and Redis `risk:on` so a restart does not false-flip.

**RS** — Relative strength. Momentum score versus SPY. The risk-off 63-session ETF overlay was deleted with that sleeve.

**RTH** — Regular trading hours, 09:30-16:00 ET (13:00 ET close on NYSE early-close days). Day-sleeve VWAP and entry window (09:35-15:45) use RTH only. `marketSession.inCashSession` is inside those hours. Distinct from `marketSession.cashOpen`, which is the NYSE calendar day (not “are we inside 09:30–16:00 right now”).

**SDS** — ProShares UltraShort S&P 500. Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**service_fault** — FCM eventType for an operational up→down (postgres, redis, or quotes). Deduped per fault class. Not paper fills or AUTO skips.

**SESSION FLATTEN** — Gate mode around flatten ET +/- 5m (and daily-loss). Flattens gated day-sleeve names.

**SESSION_SECRET** — Cookie-signing secret for `eg.sid`. Production AUTH_MODE=users requires this or GATE_PASSWORD as fallback. Not the users-table login.

**SFSafariViewController** — In-app Safari sheet in the iOS Event Gate app. Used only to show the E*TRADE authorize page during PIN re-auth. Done returns to the native PIN field. Not a WKWebView of the Event Gate SPA. The authorize URL is not logged.

**SH** — ProShares Short S&P 500. Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**shadow exit** — Log-only csp hypothetical. `applyShadowCheck` records the first trigger, the put mid and bid/ask, a buy fill of min(ask, mid + 0.25×spread), and P/L versus the actual close. It never places or closes an order (`shadowOrders` in server/src/cspCycle.ts).

**SJB** — ProShares Short High Yield. Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**sleeve reset** — POST `/api/paper/reset` `{ sleeveId }`. MockBroker only. One sleeve back to a clean $100k book: no open position, no working stop, empty blotter, journal realized 0, session mark aligned so daily and total P/L are 0. Rebuilds mock:day_pnl from remaining sleeves' session daily so stale account dayPnl cannot keep tripping GATE daily-loss after leftover books are flat; does not wipe another sleeve's today. Does not need a delayed last (unlike POST /api/paper/close). Does not flatten other sleeves, does not toggle AUTO PAPER, does not change GATE. Refuses when the process is not MockBroker. Never a live or E*TRADE order. EVENT_GATE_OPS_TOKEN may call it. POST `/api/day-pnl` is the manual accumulator path (not on the ops-token allowlist). Do not stop event-gate or edit Redis (`mock:positions`, `mock:orders`, `mock:day_pnl`, `sleeves:cards`, `sleeves:blotter`, `sleeves:session_marks`) to wipe a stuck premarket lot.

**slow stochastic (30,5,5)** — csp entry oscillator. %K period 30, smooth 5, %D period 5. Entry when %K crosses up through %D while %K is below 20. Distinct from the day sleeve's 14,3,3 stochastic.

**SMA** — Simple moving average. 20- and 200-day windows in scan/risk features.

**SOFR** — Secured Overnight Financing Rate. Underlyer of SR3 (three-month SOFR futures).

**SPA** — Single-page app. Event Gate web client is Vite + React.

**SPM** — Swift Package Manager. Event Gate iOS pulls FirebaseCore and FirebaseMessaging from firebase-ios-sdk.

**SPCX** — SPAC and New Issue ETF. Overlay thesisSleeve may be tagged spcx (manual CSP/CC). Not auto-traded.

**SPY** — SPDR S&P 500 ETF Trust. RISK ON 200dma leg and the scan RS benchmark. csp beta is measured against SPY. SPY's 200-day average does not gate csp entries. The risk-off equity-index put was deleted with that sleeve.

**SR3** — CME Three-Month SOFR futures. Gated root; freeze-card liquid contract; day quote strip. Massive Futures product_code SR3 (front-month); Yahoo fallback SR3=F.

**SYMBOL_DESCRIPTIONS** — Shared map in `shared/symbolDescriptions.ts` of Event Gate ticker → short full name (methodology ETFs/futures roots from this glossary: SPY, QQQ, HYG, GLD, GDX, PDBC, UUP, BIL, TLT, IEF, FLOT, XLU, XLP, DBMF, KMLM, CLSE, USMV, QUAL, FTLS, BTAL, LQD, JNK, SJB, ACWI, IWM, and gated roots MES/MNQ/ES/NQ/ZN/ZF/ZT/ZB/SR3/6E/M6E). Web paper UI sets HTML `title` (and an accessibility label) on primary symbol labels: quote strips, sleeve instrument chips, positions, orders, blotter, overlay names, options underlyings, and gated-root chips. Dated futures (`MESU6`) and Yahoo `=F` resolve to the root; option packages resolve to the underlying. Unknown symbols show the bare ticker with no tooltip. Display only. Does not change MockBroker orders. iOS essentials does not list individual tickers, so it has no VoiceOver symbol description.

**Stage-3** — Post-print window on an NFP/CPI/FOMC day after knowledge_time is stamped for that America/New_York day at or after the anchor print (auto-stamp at or after the anchor, with or without a freeze card, or the POST `/api/knowledge-time` backstop). A same-day stamp on a non-print day, or a stamp from before the print, is not Stage-3. Day-sleeve MES stoch may open only then, and only while GATE is idle. PRE-ARM, NO-STOP BAND, and SESSION FLATTEN still veto new entries. Exits (stop, VWAP exit, 15:45 flatten, loss cap) do not require the arm. Desktop, web `/m`, and iOS show a read-only line: `Stage-3 armed (auto)` or `Stage-3 not armed`. Web applies `stage3Arm` to `events`. iOS reads snapshot `stage3Armed` because it does not decode the calendar. No stamp button. Snapshot field `stage3Armed` is the same rule.

**StopLimit** — Stop-limit order type. Cancelled as market-or-stop on gated roots in PRE-ARM and NO-STOP BAND.

**StopMarket** — Stop-market order type. Same cancel rules as Market on gated roots in those windows.

**TA** — Technical analysis. Momentum/ownership entries come from the S&P scan filters and scores, not from the event clock.

**tbillDayAccrual** — Removed. No sleeve earns interest on idle cash. T-bills are only a benchmark. Startup `reverseCspTbillAccrual` (server/src/cspTbillReversal.ts) subtracts whatever `tbillAccruedUsd` is still stored on Redis `paper:csp_state` from the csp sleeve's realized P/L, then deletes `tbillAccruedUsd` and `tbillAccruedYmd`. A second boot reverses 0. Queued signals and other sleeves stay. ^IRX remains the Black-Scholes rate only.

**TLT** — iShares 20+ Year Treasury Bond ETF. On the momentum and ownership quote strips. The risk-off RS overlay and gated-duration long were deleted with that sleeve.

**TRADING_MODE** — Process env. mock is required; live is refused. TradovateDemoBroker is a stub pinned to demo.tradovateapi.com.

**Tradovate** — Futures broker. Demo stub only (demo.tradovateapi.com). Order/position calls are not wired; gate uses MockBroker. Live host URLs throw.

**UUP** — Invesco DB US Dollar Index Bullish Fund. RISK ON dollar veto if the 20-session return is missing or greater than +3%. The veto does not gate the csp sleeve. The risk-off RS candidate was deleted with that sleeve.

**USMV** — iShares MSCI USA Min Vol Factor ETF. Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**uPnL** — Unrealized profit and loss on open mock positions. Marks from delayed last (or vertical/overlay MTM). The paper blotter shows that mark on each open sleeve row as signed dollars (green/red), beside dPnL. Flat or zero qty is not an open row.

**Vite** — Client bundler/dev server for the React SPA.

**VPS** — Virtual private server running Event Gate (systemd event-gate, nginx, postgres, redis).

**VWAP** — Volume-weighted average price (session, RTH). Day-sleeve MES longs only above it, shorts only below. Paper exit (“VWAP lost”) needs two consecutive completed 5m closes on the wrong side (DAY_VWAP_EXIT_CLOSES = 2). A single-bar pierce holds.

**VXX** — iPath Series B S&P 500 VIX Short-Term Futures ETN. Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**WS** — WebSocket /ws for live status and log. The status snapshot kicks paper-stop marks in the background and does not wait on delayed quotes or option chains (GET /api/quotes still awaits the mark).

**XcodeGen** — Optional Mac tool. `ios/project.yml` can regenerate `ios/EventGate.xcodeproj`. The checked-in xcodeproj is enough to open on a Mac without installing XcodeGen.

**XLP** — Consumer Staples Select Sector SPDR Fund. Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**XLU** — Utilities Select Sector SPDR Fund. Retired with the risk-off sleeve, which was deleted including its paper history. Not a current rule, and it does not gate csp.

**Yahoo** — Yahoo Finance chart API. Fallback for futures =F lasts and day MES 5m bars when Massive Futures is unconfigured or errors. csp daily OHLC fallback (`interval=1d&range=2y`) when Massive returns fewer than 80 bars, plus the csp earnings calendar (`quoteSummary` `calendarEvents`) and the 13-week yield (`^IRX`). Equity lasts stay Massive Stocks Starter.

**ZB** — CME 30-Year U.S. Treasury Bond futures. Gated root.

**ZF** — CME 5-Year U.S. Treasury Note futures. Gated root.

**ZN** — CME 10-Year U.S. Treasury Note futures. Gated root; freeze-card liquid contract; day quote strip. Massive Futures product_code ZN (front-month); Yahoo fallback ZN=F.

**ZT** — CME 2-Year U.S. Treasury Note futures. Gated root.
