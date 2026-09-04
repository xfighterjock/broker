# Event Gate design

Standing description of coded behavior in xfighterjock/broker.

Product/UI name is Event Gate; package name is broker. Trader: Richard. Product clock: America/New_York (TZ).

If this file disagrees with code, the code wins. Update this file and docs/ABBREVIATIONS.md whenever design, sleeve methodology, tickers, or abbreviations change.

## What it is

Paper risk-gate plus briefing dashboard. Five independent mock $100k sleeves. BUY/SELL fills are MockBroker only (delayed last + hard stop). No live or demo Tradovate orders. TRADING_MODE=live is refused. E*TRADE is quotes, chains, and OAuth only — never orders.

## Runtime

- Client: Vite + React SPA (client/). Desktop layout; phones (narrow viewport or /m) get essentials (GATE, RISK, AUTO PAPER + D/M/O/Ow/R chips, Flatten, sleeve P/L). Native iOS Event Gate (ios/, bundle com.logikmancer.mybroker) is the phone Event Gate client: same essentials plus FCM. Web /m remains for browsers. No WKWebView wrapper. While unlocked, iOS polls GET /api/status every 3 seconds (`StatusController.pollInterval`).
- Server: Node 20 Express (server/), bind 127.0.0.1:3001.
- Shared: clock, constants, types (shared/).
- Store: Postgres (events, freeze snapshots, users + user_sessions, iOS FCM tokens, alert dedupe) + Redis (gate, sleeves, blotter, mock book, session marks, scan cache, per-sleeve AUTO PAPER, SPA cookie sessions, last-known RISK ON/OFF at `risk:on`).
- Front door: nginx TLS at broker.logikmancer.com. Production AUTH_MODE=users (users table + cookie eg.sid and/or opaque bearer). Local default is cookie + GATE_PASSWORD. AUTH_MODE=nginx is remapped to users in production — htpasswd is no longer the app login (deploy/nginx/event-gate.conf has no auth_basic). GET /api/public/risk stays unauthenticated: nginx does not require a session and Express exempts that exact path. It returns only {riskOn, riskChecks, asOf} (no-store) — never P/L, orders, positions, auth state, or secrets. GET /api/status and notification endpoints stay behind app auth. Optional EVENT_GATE_OPS_TOKEN (VPS `.env`, never git) accepts `Authorization: Bearer` over public HTTPS for a narrow ops scope: GET /api/status, GET/PUT /api/freeze, GET /api/health, GET /api/sleeves, POST /api/paper/auto, POST /api/flatten, POST /api/gate/enable. Print-day vetoes are flatten sleeve and GATE OFF (`{ enabled: false }`). The GATE route is a single toggle — `{ enabled: true }` or omitted `enabled` (defaults ON) also GATE ON; there is no separate disable path. Not a full admin session — paper orders, E*TRADE PIN, mock inject, cancel-stops, and user admin stay 401. When unset, behavior unchanged. Agents can freeze-save, status-check, toggle AUTO, flatten, and GATE OFF without Richard's Mac or SSH to 127.0.0.1:3001.
- Unit: systemd event-gate on the VPS. Mac checkout is the deploy source.
- No Docker. Production needs postgres, redis, AUTH_MODE=users, a cookie-signing secret (SESSION_SECRET, or GATE_PASSWORD as fallback), and at least one row in `users`. GATE_PASSWORD is not the users-table login and is not GATE ON/OFF (that is POST /api/gate/enable).
- Push notifications: FCM is fail-closed until `PUSH_FCM_ENABLED=1` plus Firebase Admin credentials on the VPS. The iOS app registers/revokes tokens (Bearer session, still `x-remote-user: event-gate`) and can request a test push. The real `GoogleService-Info.plist` (API_KEY) is not in git.

## Users and login

Postgres `users` (username unique, argon2id `password_hash`, optional `disabled_at`) and `user_sessions` (sha256 of an opaque bearer, 30-day expiry). Migration `003_users.sql`.

Two session stores after a users-table login (`server/src/auth.ts`, `server/src/users.ts`):

- SPA cookie `eg.sid` lives in Redis (`eg:sess:` prefix via connect-redis). Cookie `maxAge` is 7 days (`7 * 24 * 3600 * 1000` in `buildSessionMiddleware`). Cookie name and Redis prefix differ on purpose.
- iOS opaque bearer lives in Postgres `user_sessions` (sha256 of the token). `SESSION_TTL_MS` is 30 days.

- POST `/api/auth/login` `{ username, password }` (AUTH_MODE=users) sets cookie `eg.sid` and returns `{ ok, username, token, expiresAt }`. SPA uses the cookie; iOS stores the bearer in the Keychain and sends `Authorization: Bearer`.
- POST `/api/auth/logout` destroys the cookie and revokes the presented bearer.
- GET `/api/auth/status` returns `{ authRequired, authed, mode, username }`.
- AUTH_MODE=cookie still accepts the shared GATE_PASSWORD (local / tests). That path is not production.
- Optional EVENT_GATE_OPS_TOKEN: long-lived HTTPS ops bearer compared constant-time (`tokensEqual`). When it matches, auth attaches `eventGateUser` `{ id: 0, username: "ops-token" }` and `eventGateOps=true`. Fail-closed allowlist in `requireOpsScope` (status, freeze, health, sleeves, POST /api/paper/auto, POST /api/flatten, POST /api/gate/enable). Other mutating routes stay 401. Cookie `eg.sid` and users-table bearer sessions keep full access. Never commit or paste the token.
- First user: set `BOOTSTRAP_ADMIN_USER` / `BOOTSTRAP_ADMIN_PASSWORD` in the VPS `.env` (gitignored) and restart once while `users` is empty — then unset those vars. Or `npm run user:create -- <username>` (password from stdin or `EVENTGATE_NEW_USER_PASSWORD`). Never commit passwords.
- Auth rules (`server/src/users.ts`): usernames are stored lowercase and must match `^[a-z0-9._-]{2,32}$` at create. Passwords are 8–200 characters at create. Failed POST `/api/auth/login` attempts are rate-limited per username (`LOGIN_MAX_FAILURES` = 8 in `LOGIN_WINDOW_MS` = 15 minutes; in-process map).
- iOS: Face ID / Touch ID (LocalAuthentication) only unlocks a Keychain session already issued by login. Settings can disable biometrics. Failure falls back to username/password.

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
| Equities last, S&P scan dailies, risk gate, overlay + LQD/JNK 200dma bars | Massive (api.massive.com), 15-minute delayed Starter | quotes, scan, RISK ON, risk-off ETF RS, credit-leg 200dma |
| Futures =F | Yahoo chart | day/momentum quote strip |
| Option expiries and chains | Live E*TRADE (api.etrade.com) | paper vertical/CSP/CC marks only |
| S&P 500 universe | datasets CSV on GitHub | scan constituents |

E*TRADE: in-process access-token renew every 30 minutes weekdays 09:30-16:00 ET. Midnight ET still needs a human PIN from the dashboard (Authorize + PIN). Snapshot etradeAuth: ok | needs_pin | error (no token material). Keys stay in gitignored .env.etrade on the VPS.

## Paper engine

- MockBroker in Redis (mock:orders, mock:positions, mock:day_pnl). Independent $100k equity per sleeve (DEFAULT_SLEEVE_EQUITY_USD).
- Blotter + sleeve cards in Redis. Session marks (NY calendar date) split daily vs total P/L.
- Autopilot (AUTO_PAPER_INTERVAL_MS = 5 min) per sleeve. Five independent flags (`autoPaperBySleeve`: day, momentum, options, ownership, riskoff). Snapshot `autoPaper` is true if ANY sleeve is on (backward-compatible badge / old clients — not a sixth switch). Default all on when Redis has no key. Never CSP/CC/naked from auto. Day sleeve auto-papers MES (stochastic + VWAP) only when `day` is on; GATE windows still veto. Other sleeves as below.
- Redis `paper:auto` stores JSON `{ day, momentum, options, ownership, riskoff }`. Legacy global `0`/`1` migrates on first boot: `0` → all off, `1` → all on. Do not silently re-enable day into a print. After merge: Mac build + rsync; migration runs when the VPS process hydrates Redis.
- POST /api/paper/auto: `{ enabled }` sets ALL sleeves (old clients); `{ sleeveId, enabled }` sets one; `{ sleeves: { day: bool, … } }` batches. `{ sleeves }` wins, then `{ sleeveId, enabled }`, then `{ enabled }`.
- Vertical guards (shared/constants.ts): no new verticals at/after 15:50 ET weekdays (OPTIONS_VERTICAL_CUTOFF_MINUTES); net debit at most half the width (OPTIONS_DEBIT_MAX_WIDTH_FRAC); same-underlying cooldown the rest of the ET day after a 50% debit stop (OPTIONS_DEBIT_STOP_FRAC). Target 30-45 DTE; exit at 21 DTE; profit take 50% of debit. Size near 1% of sleeve equity (OPTIONS_DEBIT_TARGET_FRAC), hard cap 2% (OPTIONS_DEBIT_CAP_FRAC). Multiplier 100.
- Stops on mock last. Last ≤ 0 is ignored (missing/junk prints must not flatten). One mark-to-market pass at a time so a stop cannot book twice. Paper only.
- Vertical exit fill price is the immediate close natural credit (long bid - short ask), the same number the position marks against; it is not close + entry debit (a 2026-09-03 bug briefly double-counted the debit, e.g. recording .27 instead of .07).

## Sleeve methodologies

Five sleeves (SLEEVE_IDS). Each has its own mock book.

### 1. day — Day trading (events)

Horizon: intraday. Budget hint 15%. Loss cap $500 (day sleeve realized P/L, not mock:day_pnl).

Event-clock futures sleeve. Instruments on the quote strip: MES, ZN, M6E, SR3 (Yahoo =F). NFP/CPI/FOMC GATE still binds: PRE-ARM, NO-STOP BAND, and session flatten refuse new entries; flatten 15:45 ET (15:30 FOMC). Per-sleeve AUTO does not bypass GATE vetoes. Autopilot papers MES only when day AUTO is on: 5-minute slow stochastic 14,3,3, longs only above session VWAP, shorts only below, qty 1, stop at least 8 ticks or the signal bar. Yahoo 5m MES=F bars (not E*TRADE). RISK ON does not bind this book. MockBroker only.

### 2. momentum — Short-term momentum

Horizon: days-weeks. Budget hint 25%. Loss cap $1000. Auto cap MAX_AUTO_MOMENTUM = 5.

Universe: S&P 500 constituents (Massive dailies). Filter passesMomentumFilter (server/src/scan.ts): above 200dma, within 10% of 52-week high, last within -4% to +3% of 20dma (pullback-after-strength). Score: RS 3m vs SPY + 0.25 x RS 12m vs SPY + small volume bonus. Rank one name per GICS sector (top 15).

Entries (this sleeve AUTO on, RISK ON only): long the ranked names. Stop MOMENTUM_STOP_MUL = 0.985. Size about 1% sleeve equity at risk (AUTO_RISK_FRAC). Skip names already open on any sleeve.

Exits: sleeve loss cap; last below 200dma; setup gone (no longer in the momentum scan) when the scan is ready. RISK OFF: no new buys; existing stops/exits still run.

Quote-strip extras: MES, ES, SPY, QQQ, TLT (not auto-traded as a basket).

### 3. options — Options (defined risk)

Horizon: days-months. Budget hint 20%. Loss cap $1000. Auto cap MAX_AUTO_VERTICALS = 5.

Auto (this sleeve AUTO on, RISK ON only): ATM call debit verticals on momentum-scan names. Never puts, CSP, or covered calls from autopilot. Same 30-45 DTE / 15:50 cutoff / half-width debit / 50% stop machinery (pickAtmCallDebit). Thesis: auto call debit.

Manual: POST /api/paper/vertical (call or put) on this sleeve. POST /api/paper/csp and POST /api/paper/covered-call are ownership overlay booked on the options sleeve, tagged thesisSleeve=ownership or spcx. Never naked. Cash-secured put reserves strike x 100 x qty.

Quote strip: SPY, QQQ, IWM (live chains accept any ordinary US ticker).

### 4. ownership — Longer-term ownership + overlay

Horizon: months+. Budget hint 40%. Loss cap $2000. Auto cap MAX_AUTO_OWNERSHIP = 5.

Universe: same S&P scan. Filter passesOwnershipFilter: above 200dma and positive 3m/6m/12m returns (if 12m history is short, at least two of those legs). Rank by 12m return, max two names per sector (top 20). Skip isOwnershipArtifact (extreme 12m, stale 3m, more than 20% off highs, or last over $800) so autopilot does not buy one-off spikes.

Entries (this sleeve AUTO on, RISK ON only): long stock via that TA. Stop OWNERSHIP_STOP_MUL = 0.98. Size about 1% equity at risk.

Holds: RISK OFF pauses new adds only. Does not flatten the long-term book. Covered-call underlyers are not auto-sold. Exit if below 200dma or sleeve loss cap.

Overlay: CSP / covered call are manual, tagged to an ownership or SPCX thesis, sitting on the options sleeve. Autopilot does not sell puts or calls.

Quote-strip extras: SPY, QQQ, TLT, IWM.

### 5. riskoff — Puts + defensive ETF RS

Horizon: days-months. Budget hint 10%. Loss cap $1000. Auto cap MAX_AUTO_RISKOFF_VERTICALS = 3 (one per name). Status: paper.

Runs while this sleeve AUTO is on and the global badge is RISK OFF. Two put programs plus one ETF long. Puts need a two-sided E*TRADE bid/ask (no invented prices). Turning day AUTO off does not stop this sleeve.

Credit-leg puts HYG / LQD / JNK (riskoffCreditLegPutAllowed / riskoffHygPutAllowed): RISK OFF and that name's own 200dma is known below (hygAbove200 / lqdAbove200 / jnkAbove200 === false). Do not use spyAbove200 for LQD/JNK. Missing 200 check fail-closed (no new put on that name). ATM put debit, 30-45 DTE, existing vertical machinery. Fill order inside the cap of 3: HYG, then LQD, then JNK (prefer LQD over sitting idle when HYG is not below 200 or fails liquidity). One vertical per name. Thesis: auto put debit {name} credit-leg. Flatten that name's vertical when the name is back above 200dma or RISK ON. Missing check does not flatten. LQD/JNK 200dma is computed in the risk feature path (Massive dailies + featuresFromBars) and passed to autopilot only — GET /api/public/risk stays {spyAbove200, acwiAbove200, hygAbove200, uup20dPct, dollarVeto}.

Credit-leg liquidity/size gate (checkCreditLegAutoLiquidity, generalized from checkHygAutoLiquidity; HYG/LQD/JNK auto entry only — never SPY/QQQ/IWM riskoff, options-sleeve calls, or manual POST /api/paper/vertical): both legs need open interest >= RISKOFF_HYG_MIN_OPEN_INTEREST (100); the immediate round-trip (long bid - short ask) must be at least 75% of the entry debit (long ask - short bid), i.e. round-trip slippage <= RISKOFF_HYG_MAX_ROUNDTRIP_SLIPPAGE_FRAC (25%); qty is hard-capped at RISKOFF_HYG_MAX_AUTO_QTY (3) regardless of the 1% target sizing that would otherwise apply. RISKOFF_CREDIT_LEG_* aliases keep the same numbers. Added 2026-09-03 after a live HYG 79/78.5P auto entry (OI 7/0) was sized to 50 contracts on a $0.20 debit and hit its 50% debit stop within ~40 minutes.

SPY/QQQ/IWM equity-index puts (riskoffEquityPutsAllowed): RISK OFF and spyAbove200 === false. Missing SPY check fail-closed. Order after the credit legs: SPY, QQQ, then IWM if quoted. Flatten leftover equity-index puts when SPY is back above 200dma. Missing check does not flatten.

Defensive ETF overlay (server/src/riskoffEtf.ts): 40% of the $100k book (RISKOFF_ETF_NOTIONAL_FRAC — paper step toward half the sleeve, not a full 50%). 63-session total return (RISKOFF_ETF_LOOKBACK_DAYS). Candidates: GLD, UUP, TLT, IEF, XLU, XLP, DBMF vs BIL cash/T-bill benchmark (RISKOFF_ETF_SYMBOLS). Hold the name that beats BIL with the highest 63d return; else BIL. Missing any overlay-universe bar means cash (flatten). Exact RS tie keeps the held name if it is still eligible, else preference order GLD > UUP > duration (TLT, IEF) > defensives (XLU, XLP) > trend (DBMF). Disaster stop RISKOFF_ETF_STOP_MUL = 0.92 (unchanged); rotation is the primary exit. Flatten the ETF on RISK ON, missing bars, or sleeve loss cap. Puts and the ETF are independent (put sells leave the ETF alone).

Quote strip (RISKOFF_QUOTE_STRIP): SPY, QQQ, HYG, GLD, UUP, BIL, TLT, IEF, XLU, XLP, DBMF, LQD, JNK, SJB. SJB is visibility only (not a traded inverse). symbolsForSleeve always includes this strip for riskoff, then any extra card instruments.

## Out of scope / refused

- Live broker orders (Tradovate, E*TRADE, NinjaTrader). TRADING_MODE=live exits.
- Sixth sleeve.
- Autopilot CSP, covered call, or naked short vol.
- Inverse/vol ETFs as risk-off expressions (SH, SDS, VXX; SJB is quote-strip visibility only). No levered inverse. SJB is never a traded inverse.
- Day-sleeve directional entries from Event Gate.
- Scan-universe dump in these docs (500 names). Only methodology tickers are listed in ABBREVIATIONS.md.

## iOS push notification slice (FCM)

- Provider abstraction: `server/src/notifications.ts` with an FCM provider using Firebase Admin SDK (HTTP v1 under the hood). Config requires `PUSH_FCM_ENABLED=1`, `PUSH_FCM_PROJECT_ID`, and credentials from ADC or a root-owned file path. Without config, sends return structured `disabled` or `not_configured` and do not crash the app.
- Persistence: Postgres tables `notification_device_tokens` and `notification_alert_dedupe` (migration `002_notifications.sql`).
- Auth: token registration/revocation and test-send endpoints are under `/api`, so users-table session/bearer applies. Token principal is `x-remote-user` / `x-forwarded-user`, else the logged-in username, else `event-gate`. iOS still sends `x-remote-user: event-gate`.
- Token model: iOS platform, optional `device_label`, created/updated/last_seen timestamps, enabled/revoked state, token rotation via `replaceToken`, token hash for indexing/lookup.
- Alert payload type: `risk_flip | service_fault | auth_needed | paper_guard` with title/body, eventType, occurredAt, dedupeKey, and deepLinkRoute only. No account IDs, positions, secrets, or order controls.
- Dedupe/rate-limit: restart-safe dedupe key store in Postgres; default one delivery per key per 30 minutes (`PUSH_ALERT_DEDUPE_WINDOW_MINUTES`).
- Test endpoint: `POST /api/notifications/test` sends a harmless "Event Gate test notification" only when FCM is enabled and configured; otherwise returns clear disabled/not-configured status.
- Status visibility: `/api/notifications/status` and `/api/status.notifications` expose provider flags and token counts only (no token values, no credential path).
- Native iOS client (`ios/EventGate`, display name Event Gate, bundle `com.logikmancer.mybroker`):
  1) `FirebaseApp.configure()`, notification permission, `UNUserNotificationCenter`, `registerForRemoteNotifications`, `MessagingDelegate`, FCM token. SPM: FirebaseCore + FirebaseMessaging.
  2) Login: username/password against `/api/auth/login`. Bearer in Keychain. Home screen is essentials (clock/mode, GATE, RISK, AUTO PAPER + D/M/O/Ow/R, Flatten with `FLATTEN_CONFIRM`, sleeve P/L, E*TRADE PIN). While unlocked, `StatusController` polls GET `/api/status` every 3 seconds (`pollInterval`) and stops when locked. Settings (secondary) holds base URL, biometric unlock, and FCM Register/Revoke/Test. After token + session, `POST /api/notifications/tokens/register` with `Authorization: Bearer` and `{ platform: "ios", token, deviceLabel? }`. App still sends `x-remote-user: event-gate` so tokens match the VPS default principal.
  3) On FCM refresh, register again with `replaceToken` when a previous token exists.
  4) Revoke calls `POST /api/notifications/tokens/revoke`. Buttons also send a test push and refresh status. UI shows a redacted token preview and permission state.
  5) Push `deepLinkRoute` (`/status`, `/m`) opens essentials. Not a desktop blotter.
  6) Entitlements: Push Notifications + remote-notification background mode. Open `ios/EventGate.xcodeproj` on a Mac; Richard picks the Apple Team. Simulator will not get real APNs. Copy `~/Downloads/GoogleService-Info.plist` to `ios/EventGate/GoogleService-Info.plist` before building. Example plist is `ios/GoogleService-Info.plist.example` (`API_KEY=REPLACE_ME`). `project.yml` can regenerate the xcodeproj via XcodeGen.
  7) Firebase Console still needs an APNs Authentication Key (`.p8`) uploaded for the iOS app. That key is not in this repo and must be created in Apple Developer / uploaded by Richard.
  8) Lock-screen / Notification Center glyph is the compiled AppIcon (auto-agent A: teal robot + amber sparkline). `GENERATE_INFOPLIST_FILE` is NO, so `Info.plist` sets `CFBundleIconName=AppIcon`. The AppIcon set includes iPhone 20/29/40/60pt slots plus the 1024 marketing PNG. FCM messages are title/body + data only — no Android `icon` / `image` fields.
- Events that actually send (principal `event-gate`, matching iOS `x-remote-user`). Title/body + `deepLinkRoute` `/status` only — no secrets, position dumps, or order controls. 30-minute Postgres dedupe plus type-specific keys. Missing FCM returns `disabled` / `not_configured` and never crashes trading loops.
  1) `auth_needed` — E*TRADE `ok|error → needs_pin` in the status snapshot (`auth_needed:etrade:needs_pin`).
  2) `risk_flip` — global RISK ON/OFF badge change from `ensureRisk` / `kickRisk`. Title `Event Gate: RISK ON` or `Event Gate: RISK OFF`; body is the failed/cleared SPY/ACWI/HYG 200dma + dollar-veto reason. Last-known `riskOn` in memory and Redis `risk:on` so a restart baselines without a false flip; unchanged `riskOn` does not send. Key `risk_flip:{on|off}:{checkSignature}:{UTC hour}`.
  3) `service_fault` — operational up→down after the subsystem was seen up: Postgres, Redis, quotes (Massive hard failure that forces `riskOffFallback`, or scan failure). Key `service_fault:{postgres|redis|quotes}`. Not paper fills, not AUTO skips, not disabled/not_configured FCM tests.
  4) `pre_arm` — clock enters PRE-ARM (T−15) for an NFP/CPI/FOMC focus event. One ping per event id.
  5) `freeze_missing` — morning-of a scheduled print (within 2h of print or at PRE-ARM) if the freeze card has no `freezeTimestamp`. One per event id.
  6) `day_fill` — day-sleeve paper fill opened (`day_fill:{symbol}:{NY date}`).
  7) `day_flatten` — day sleeve flattened by session flatten or manual POST `/api/flatten`.
  8) `day_loss_cap` — day hits GATE daily-loss or the day sleeve `lossCapUsd` (default −$500). Once per NY date.
  9) `veto_confirm` — POST `/api/flatten` or GATE OFF (`POST /api/gate/enable { enabled: false }`) succeeded.
  10) `overlay_rotation` — risk-off ETF RS overlay rotates (e.g. XLP→GLD), body includes the new symbol.
  11) `credit_put_opened` / `credit_put_stopped` / `credit_put_risk_on_flatten` — HYG/LQD/JNK credit-leg put opened, 50% debit stop, or RISK ON flatten.
  12) `oi_skip_streak` — HYG/LQD/JNK auto OI/liquidity skips reach 6 in ~30 minutes. One quiet “credit puts blocked on OI”. Reset when a credit put opens or RISK ON.
  13) `etrade_renew_failed` — E*TRADE access-token renew fails (not on success, not on silent missing credentials).
  14) `sleeve_loss_warn` — any sleeve realized+unrealized at or beyond ~80% of `lossCapUsd`. Once per sleeve per NY date.
  15) `paper_guard` — `POST /api/notifications/test` only (`event-gate-test`).
- Hook: `sendEventGateAlert(principal, payload)` / `NotificationService.sendAlert` via `server/src/eventGateAlerts.ts`. Do not wire inverse-ETF trading or live broker orders.
- Credentials: ADC (`PUSH_FCM_CREDENTIAL_SOURCE=adc`) or a root-owned JSON file path. Never accept service-account secrets through the UI. Never persist them in Redis/Postgres. No Firebase API keys, service-account JSON, nginx passwords, or FCM device tokens are committed. Feature stays disabled until `PUSH_FCM_ENABLED=1` and project/credentials are set on the VPS.
