# Event Gate abbreviations

Glossary of product terms, futures roots, and methodology tickers used in Event Gate. Alphabetized. Does not list the full S&P 500 scan universe.

If this file disagrees with code, the code wins. Update alongside docs/DESIGN.md.

---

**6E** — CME Euro FX futures. Gated root (GATED_ROOTS); Yahoo ticker 6E=F.

**20dma** — 20-day simple moving average. Momentum pullback filter uses last vs this SMA (dist20).

**200dma** — 200-day simple moving average. RISK ON requires SPY, ACWI, and HYG last above it. Momentum/ownership filters and below-200 exits use it too.

**ACWI** — iShares MSCI ACWI ETF (global equities). One of three 200dma legs on the RISK ON badge.

**ATM** — At the money. Auto debit verticals pick the strike closest to last (pickAtmCallDebit / pickAtmPutDebit).

**AUTH_MODE** — Auth front door. Production nginx; local cookie session eg.sid.

**AUTO PAPER** — Autopilot switch. When on, mock longs and verticals fire from scan/risk rules. Default on. Never CSP/CC/naked. Day sleeve stays manual.

**BIL** — SPDR Bloomberg 1-3 Month T-Bill ETF. Cash/T-bill leg of the risk-off 63d relative-strength overlay. Held when neither GLD nor UUP beats it.

**CC** — Covered call. Manual overlay on the options sleeve, tagged to an ownership or SPCX thesis. Not sold by autopilot. Never naked.

**CPI** — Consumer Price Index print. Seed calendar event; freeze card; flatten 15:45 ET. Day-sleeve event clock only.

**CSP** — Cash-secured put. Manual overlay on the options sleeve. Reserves strike x 100 x qty. Never naked. Not sold by autopilot.

**DTE** — Days to expiration. Auto verticals target 30-45 DTE and exit at 21 DTE (OPTIONS_DTE_EXIT).

**dma** — Daily moving average. See 20dma / 200dma.

**E\*TRADE** — Broker API used for live option chains and OAuth only. Never orders. Production base api.etrade.com.

**ES** — CME E-mini S&P 500 futures. Gated root. Yahoo ES=F. On the momentum quote strip.

**ET** — America/New_York clock. Gate windows, 15:50 vertical cutoff, session marks, E*TRADE renew window, flatten times.

**ETF** — Exchange-traded fund. Risk-off overlay is one of GLD/UUP/BIL; gate names are SPY/ACWI/HYG/UUP.

**FedWatch** — CME FedWatch snapshot field on the freeze card (NFP/CPI/FOMC briefing).

**Flatten** — Close gated day-sleeve names (POST /api/flatten) or a sleeve position. Print-day veto with GATE OFF. Does not flatten other sleeves from the event clock.

**FOMC** — Federal Open Market Committee. Seed events FOMC_STATEMENT and FOMC_PC; flatten 15:30 ET when type contains FOMC.

**FOMC_PC** — FOMC press conference calendar type.

**FOMC_STATEMENT** — FOMC statement calendar type.

**GATE** — Event-clock risk gate on futures roots. Modes: idle, PRE-ARM, NO-STOP BAND, SESSION FLATTEN. Enable via POST /api/gate/enable.

**GATED_ROOTS** — MES, MNQ, ES, NQ, ZN, ZF, ZT, ZB, SR3, 6E, M6E. Longest-first match so MES wins over ES, M6E over 6E, MNQ over NQ.

**GICS** — Global Industry Classification Standard. Momentum ranks one name per sector; ownership allows two.

**GLD** — SPDR Gold Shares. Risk-off 63d RS overlay vs UUP vs BIL.

**HYG** — iShares iBoxx $ High Yield Corporate Bond ETF. RISK ON 200dma leg. Credit-leg ATM put debit on the riskoff sleeve when HYG is below 200dma.

**IEF** — iShares 7-10 Year Treasury Bond ETF. Not a live risk-off expression (refused / not coded).

**IWM** — iShares Russell 2000 ETF. Options quote strip; optional third equity-index put on riskoff when SPY is below 200dma and IWM is quoted.

**knowledge_time** — Timestamp after the print used on the freeze checklist (knowledge_time after print).

**Limit** — Limit order type. Gate leaves limits alone unless oversize.

**M6E** — CME Micro Euro FX futures. Gated root; freeze-card liquid contract; day quote strip M6E=F.

**Market** — Market order type. Cancelled on gated roots in PRE-ARM and NO-STOP BAND.

**Massive** — Market-data vendor (api.massive.com). Equities last, S&P scan dailies, risk-gate bars, GLD/UUP/BIL. 15-minute delayed Starter.

**MES** — CME Micro E-mini S&P 500 futures. Gated root; freeze-card liquid contract; day quote strip MES=F.

**MIT** — Market-if-touched order type. Treated as market-or-stop: cancelled in PRE-ARM and NO-STOP BAND on gated roots.

**MNQ** — CME Micro E-mini Nasdaq-100 futures. Gated root. Yahoo MNQ=F.

**MockBroker** — In-memory paper broker persisted in Redis. The only place Event Gate fills BUY/SELL. Not Tradovate, not E*TRADE.

**NFP** — Nonfarm payrolls print. Seed calendar event; freeze card; flatten 15:45 ET. Day-sleeve event clock only.

**NO-STOP BAND** — Gate mode T-2m to T+2m around the event. Cancels Market / StopMarket / StopLimit / MIT on gated roots.

**NQ** — CME E-mini Nasdaq-100 futures. Gated root. Yahoo NQ=F.

**NY** — New York session date (America/New_York calendar YYYY-MM-DD) used for sleeve session marks and same-day vertical stop cooldown.

**OAuth** — E*TRADE 1.0a handshake. In-app Authorize + PIN; in-process renew during the cash session.

**OTM** — Out of the money. Put debit shorts a lower strike; call debit shorts a higher strike.

**P/L** — Profit and loss. Sleeve books expose realized, unrealized, dailyPnlUsd, totalPnlUsd (equity minus $100k).

**PIN** — E*TRADE verifier after Authorize. Typed in Event Gate (desktop header or /m). Needed after midnight ET. Never stored in git or chat.

**PRE-ARM** — Gate mode T-15m to T-2m. Cancels Market / StopMarket / StopLimit / MIT on gated roots.

**QQQ** — Invesco QQQ Trust (Nasdaq-100). Options quote strip; risk-off equity-index put when SPY is below 200dma; momentum/ownership quote strip.

**Redis** — Cache/store for gate flags, mock book, sleeves, blotter, session marks, scan, AUTO PAPER.

**RISK OFF** — Badge when RISK ON is false. Pauses new momentum longs and options call-debits; ownership pauses new adds. May run the riskoff sleeve. Does not bind the day book.

**RISK ON** — Badge iff SPY, ACWI, and HYG are above 200dma and UUP 20d is not greater than +3%. Missing series fail closed to RISK OFF.

**RS** — Relative strength. Momentum score vs SPY; risk-off ETF overlay is 63-session total return of GLD vs UUP vs BIL.

**SDS** — ProShares UltraShort S&P 500. Not a live risk-off expression.

**SESSION FLATTEN** — Gate mode around flatten ET +/- 5m (and daily-loss). Flattens gated day-sleeve names.

**SH** — ProShares Short S&P 500. Not a live risk-off expression.

**SJB** — ProShares Short High Yield. Not a live risk-off expression (HYG put is the credit-leg instead).

**SMA** — Simple moving average. 20- and 200-day windows in scan/risk features.

**SOFR** — Secured Overnight Financing Rate. Underlyer of SR3 (three-month SOFR futures).

**SPA** — Single-page app. Event Gate client is Vite + React.

**SPCX** — SPAC and New Issue ETF. Overlay thesisSleeve may be tagged spcx (manual CSP/CC). Not auto-traded.

**SPY** — SPDR S&P 500 ETF Trust. RISK ON 200dma leg; scan RS benchmark; risk-off equity-index puts only when SPY is below 200dma; options quote strip.

**SR3** — CME Three-Month SOFR futures. Gated root; freeze-card liquid contract; day quote strip SR3=F.

**StopLimit** — Stop-limit order type. Cancelled as market-or-stop on gated roots in PRE-ARM and NO-STOP BAND.

**StopMarket** — Stop-market order type. Same cancel rules as Market on gated roots in those windows.

**TA** — Technical analysis. Momentum/ownership entries come from the S&P scan filters and scores, not from the event clock.

**TLT** — iShares 20+ Year Treasury Bond ETF. On momentum and ownership quote strips only. Not a live risk-off expression.

**TRADING_MODE** — Process env. mock is required; live is refused. TradovateDemoBroker is a stub pinned to demo.tradovateapi.com.

**Tradovate** — Futures broker. Demo stub only (demo.tradovateapi.com). Order/position calls are not wired; gate uses MockBroker. Live host URLs throw.

**UUP** — Invesco DB US Dollar Index Bullish Fund. RISK ON dollar veto if 20-session return is missing or greater than +3%. Also a 63d RS candidate on the risk-off ETF overlay.

**uPnL** — Unrealized profit and loss on open mock positions. Marks from delayed last (or vertical/overlay MTM).

**VPS** — Virtual private server running Event Gate (systemd event-gate, nginx, postgres, redis).

**VXX** — iPath Series B S&P 500 VIX Short-Term Futures ETN. Not a live risk-off expression.

**WS** — WebSocket /ws for live status and log.

**Yahoo** — Yahoo Finance chart API for futures =F quotes (and fallbacks). Equities prefer Massive.

**ZB** — CME 30-Year U.S. Treasury Bond futures. Gated root.

**ZF** — CME 5-Year U.S. Treasury Note futures. Gated root.

**ZN** — CME 10-Year U.S. Treasury Note futures. Gated root; freeze-card liquid contract; day quote strip ZN=F.

**ZT** — CME 2-Year U.S. Treasury Note futures. Gated root.

**CME** — CME Group. Home of the gated futures roots (MES, ES, NQ, Treasuries, FX, SR3).

**MTM** — Mark to market. Vertical and overlay unrealized P/L use chain marks, not invented prices.

**NinjaTrader** — Futures platform. README notes a live NT API add-on is not required for mock. This repo is not an NT order router.

**Postgres** — Database for calendar events and freeze snapshots.

**nginx** — TLS reverse proxy in front of 127.0.0.1:3001. Production AUTH_MODE=nginx.

**Vite** — Client bundler/dev server for the React SPA.

**%D** — 3-period SMA of slow %K. Day-sleeve MES stochastic signal line.

**%K** — Slow stochastic (14,3). Day-sleeve MES momentum. Long when %K crosses up through %D after %K was at or below 20; short is the mirror above 80.

**RTH** — Regular trading hours, 09:30-16:00 ET. Day-sleeve VWAP and entry window (09:35-15:45) use RTH only.

**VWAP** — Volume-weighted average price (session, RTH). Day-sleeve MES longs only above it, shorts only below; lose VWAP and the paper position exits.
