# broker (Event Gate)

Risk-gate and briefing dashboard for futures paper trading. Package name is broker. Product/UI name is Event Gate. Paper BUY/SELL is MockBroker only (delayed last + hard stop). No live/demo Tradovate orders. No EnterLong on a live broker.

Trader: Richard. Timezone America/New_York.

## What it does
1s gate tick when enabled: idle, PRE-ARM (T-15 to T-2), NO-STOP BAND (T-2 to T+2), SESSION FLATTEN (flatten ET +/- 5 min). Cancels Market/StopMarket/StopLimit/MIT on gated roots in those windows. Cancels qty over 1. Limits left alone unless oversize. Flatten gated names at session cap or daily loss ($500). FOMC in the type forces 15:30 flatten. Gated roots: MES MNQ ES NQ ZN ZF ZT ZB SR3 6E M6E. MockBroker default. TradovateDemoBroker stub pinned to demo.tradovateapi.com/v1; construction throws when the URL contains live.
## Seed events
2026-09-04T12:30:00Z NFP flatten 15:45 ET. 2026-09-11T12:30:00Z CPI flatten 15:45 ET. 2026-09-16T18:00:00Z FOMC_STATEMENT flatten 15:30 ET. 2026-09-16T18:30:00Z FOMC_PC flatten 15:30 ET. Also inserted by db/migrations/001_init.sql.
## Layout
client/ Vite+React+TS SPA. server/ Node 20 Express. shared/ clock types. db/migrations/ Postgres. deploy/ nginx systemd setup.sh deploy.sh. tests/ unit tests. No Docker.
## Massive market data
MASSIVE_API_KEY on Mac `.env` and VPS `/opt/broker/.env` (gitignored). Starter plan is 15-minute delayed stocks + options. Equities last quotes, S&P scan dailies, and option chains use `https://api.massive.com`. Futures (`=F` / MES,ZN,6E,M6E,SR3,ES,NQ,MNQ) still use Yahoo. App boots without the key (clear errors on equity/options Massive paths; Yahoo futures still work). Never commit the key. E*TRADE remains in-repo unused for market data when Massive is configured.

## Local development
Requires Node 20. Copy .env.example to .env. Install with npm, then: npm test ; npm run typecheck:server ; npm run typecheck:client ; npm run build:client ; npm run build:server. Dev API: npm run dev:server (127.0.0.1:3001). Dev UI: npm run dev:client (Vite 5173, proxies /api and /ws). If postgres/redis are missing, unit tests still pass; the server in development falls back to seed events and memory sessions. Production refuses to start without postgres, redis, and GATE_PASSWORD. Migrate with: npm run migrate.
## VPS deploy
No Docker. nginx + postgres + redis already on the box. Default path /opt/broker (DEPLOY_PATH override). First time: deploy/setup.sh (creates db/user, redis check, copies nginx and systemd, prompts for GATE_PASSWORD, build, migrate, enable event-gate.service). Later: deploy/deploy.sh (git pull unless dirty/no remote, npm ci, builds, migrate, restart unit, nginx test+reload). TLS comments live in deploy/nginx/event-gate.conf. server_name is event-gate.local or _.
## Security
Bind the API to localhost (BIND=127.0.0.1). Put nginx in front. GATE_PASSWORD cookie session is stored in Redis; unset password refuses production start and warns in development. TRADING_MODE=live is refused. Tradovate stub throws on live hosts. Paper orders stay on MockBroker. No directional orders to Tradovate.
## NinjaTrader API key
A funded live NT account (at least one thousand USD) plus the about twenty-five USD/month API add-on is not required for mock. Do not buy it for paper. This repo is briefing plus risk-gate, not an NT order router.
## Tests
npm test runs vitest. No live postgres required. clock.test.ts injects Date. gate.test.ts covers cancel/flatten on MockBroker. tradovate.test.ts refuses live URLs.
## API on 127.0.0.1:3001
GET /api/status. GET /api/quotes?sleeve=day|momentum|options|ownership (Massive Starter equities 15m delayed, Yahoo futures =F; 45s cache; also marks mock stops). GET /api/scan?sleeve=momentum|ownership (S&P 500 delayed daily scan via Massive aggs, requireAuth; status scanning|ok; Paper this prefills MockBroker, does not auto-place). POST /api/paper/order and POST /api/paper/close (MockBroker paper, requireAuth). GET /api/options/expiries?symbol=SPY and GET /api/options/chain?symbol=AAPL&expiry=YYYY-MM-DD (Massive option snapshot; any US equity/ETF underlyer; Starter 15m delayed). POST /api/paper/vertical opens a two-leg debit vertical on the options sleeve (MockBroker, never an E*TRADE/Tradovate order). POST /api/paper/csp and POST /api/paper/covered-call are paper ownership overlay (options sleeve, tagged thesisSleeve=ownership|spcx; never naked; autopilot does not sell puts/calls). Snapshot sleeveBooks include totalPnlUsd (equity-100k) and dailyPnlUsd. POST /api/paper/auto {enabled} toggles scan autopilot (default on; mock longs + debit-call verticals; never puts/CSP/CC from auto; day sleeve stays manual). Snapshot includes autoPaper, riskOn/riskChecks (automated SPY/ACWI/HYG 200dma + UUP 20d veto; does not bind day/clock/flatten/GATE), and sleeveBooks ($100k mock equity per sleeve). POST /api/sleeves/:id/fills paper journal (not broker). DELETE /api/sleeves/:id/fills/:fillId. GET and PUT /api/freeze. POST /api/knowledge-time. POST /api/gate/enable. POST /api/flatten. POST /api/cancel-stops. POST /api/mock/inject-stop. GET /api/orders. GET /api/events. GET /api/log. WebSocket /ws for live status plus log. Login: POST /api/auth/login with password, cookie eg.sid. No live EnterLong.
