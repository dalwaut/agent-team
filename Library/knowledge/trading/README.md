# Trading Knowledge Branch — OPAI

> **Goal:** Build systematic trading knowledge to eventually provide suggestions, predictions, and profitable automated trading outcomes. Primary focus: **Futures day trading**, with expanding knowledge across markets.

---

## Vision & Roadmap

| Phase | Focus | Status |
|-------|-------|--------|
| **1. Knowledge Accumulation** | Absorb strategies, frameworks, market mechanics, terminology | **Active** |
| 2. Pattern Recognition | Build models for identifying setups, support/resistance, trend shifts | Planned |
| 3. Signal Generation | Generate trade suggestions with confidence scores + reasoning | Planned |
| 4. Backtesting Framework | Test strategies against historical data, measure win rate / R:R | Planned |
| 5. Live Predictions | Real-time analysis with actionable entry/exit/SL/TP levels | Planned |
| 6. Automated Execution | Bot-driven trades with risk management guardrails | Planned |

---

## Knowledge Index

### Foundations

| Topic | Path | Description |
|-------|------|-------------|
| **Trading Foundations** | `foundations.md` | Core concepts: market types, risk-reward, win rates, mental game, scaling, day trading structure |
| **Futures Day Trading** | `futures-day-trading.md` | Futures-specific: contracts, margin, E-mini vs Micro, reversal strategy, entry checklists. Source: Riley Coleman |
| **Futures Deep Dive** | `futures-deep-dive.md` | Complete futures masterclass: pricing/ticks/points, margin deep-dive, market personalities (ES/NQ/Gold/Oil), supply & demand zones, candlestick patterns (top 6), trend lines, live trading psychology, scaling blueprint. Source: Riley Coleman 3hr course |
| **Order Flow Scalping** | `order-flow-scalping.md` | Elite scalping via order flow: absorption, volume profile (VAH/VAL/POC), AAA setup, momentum squeeze, dynamic risk management, multiple portfolio approach, statistics-driven optimization, forex inapplicability. Source: Fabio Valentino live session |

### Strategy & Analysis

| Topic | Path | Description |
|-------|------|-------------|
| *(To be built)* | `supply-demand-mastery.md` | Advanced supply/demand zone analysis, institutional order flow |
| **Candlestick Patterns** | `candlestick-patterns.md` | Complete candlestick reference: anatomy, ~20 patterns (single/double/triple), bullish-bearish spectrum, context rules, entry/exit framework. Source: Ross Cameron |
| **4-Hour Range Scalping** | `four-hour-range-scalping.md` | Rule-based failed-breakout scalping: mark first 4hr candle range, fade breakouts on 5-min chart, 3-step checklist, 2R fixed target. Backtested 70% win rate across crypto/forex/gold. Source: Data Trader |
| **Opening Range Breakout** | `opening-range-breakout.md` | Breakout-with-retest system: mark first 5-min candle range (9:35 AM EST), trade WITH confirmed breakouts, SL at midpoint, 2:1 R:R. Retest filter: 70% vs 33% win rate. Source: Casper SMC |
| **Small Account Growth** | `small-account-growth.md` | 3 strategies + compounding framework: FVG pullback (trend continuation), volume divergence reversal, trend line breakout. 20% risk + 1:3 R:R + compounding = 10x in 5 wins. Source: Data Trader |
| *(To be built)* | `price-action-trading.md` | Pure price action methodology — no indicators |

### Cross-Market Concepts

| Topic | Path | Description |
|-------|------|-------------|
| *(To be built)* | `risk-management.md` | Position sizing, max drawdown, Kelly criterion, portfolio heat |
| *(To be built)* | `trading-psychology.md` | Emotional control, discipline, loss aversion, overtrading |
| *(To be built)* | `technical-analysis.md` | Universal TA: candlestick patterns, indicators, market structure |
| *(To be built)* | `backtesting.md` | Methodology, tools, avoiding curve-fitting, walk-forward analysis |

### Tools & Platforms

| Topic | Path | Description |
|-------|------|-------------|
| *(To be built)* | `platforms.md` | Trading platforms comparison: MT4/MT5, NinjaTrader, TradingView, cTrader |
| *(To be built)* | `apis-and-automation.md` | Broker APIs, Python libraries (ccxt, backtrader, zipline), data feeds |

---

## Sources Log

Track every source consumed for this knowledge branch.

| # | Source | Type | Key Topics | Date |
|---|--------|------|------------|------|
| 1 | [How To Day Trade With Only $4](https://www.youtube.com/watch?v=X2WcL536WYQ) — Riley Coleman | YouTube | Futures basics, scaling, reversal strategy, entry checklist, risk-reward, mental game | 2026-03-10 |
| 2 | [How To Start Day Trading Futures As A Beginner In 2026 (3 Hours)](https://www.youtube.com/watch?v=Kdqi70RP7PM) — Riley Coleman | YouTube | Complete futures masterclass: mechanics, margin, pricing, market personalities, supply/demand, candlestick patterns, trend analysis, live trading, scaling | 2026-03-10 |
| 3 | [Trading LIVE with the BEST Scalper in the World](https://www.youtube.com/watch?v=DyS79Eb92Ug) — Words of Rizdom / Fabio Valentino | YouTube | Live NQ scalping, order flow, volume profile, AAA setup, dynamic risk mgmt, multiple portfolios, statistics-driven optimization, win rate vs R:R tradeoff | 2026-03-10 |
| 4 | [How to Read Candlestick Shapes & Charts](https://www.youtube.com/watch?v=myUKta-wicQ) — Ross Cameron / Warrior Trading | YouTube | Candlestick anatomy, ~20 patterns (single/double/triple), bullish-bearish spectrum, context-dependent interpretation, entry/exit rules, real trade examples | 2026-03-10 |
| 5 | [The BEST 5 Minute Scalping Strategy Ever](https://www.youtube.com/watch?v=O5eC5lY7ZXY) — Data Trader | YouTube | 4-hour range failed-breakout scalping, 3-step checklist, 2R fixed target, backtested on BTC/EUR-USD/Gold (70% win rate, +25R over 23 trades) | 2026-03-10 |
| 6 | [The 5 Minute Scalping Strategy (That Actually Works)](https://www.youtube.com/watch?v=nBOLIrNX_PU) — Casper SMC | YouTube | Opening range breakout with retest, first 5-min candle range, SL at midpoint, 2:1 R:R, retest vs FOMO (70% vs 33% win rate), 3 common mistakes, NQ/ES/Gold examples | 2026-03-10 |
| 7 | [TOP 3 Trading Strategies to Grow a SMALL Trading Account](https://www.youtube.com/watch?v=nnrs06knDEo) — Data Trader | YouTube | Small account growth rules (20% risk, 1:3 R:R, compounding), FVG pullback, volume divergence reversal, trend line breakout with pullback entry | 2026-03-10 |

---

## Notes

- **Futures day trading is the primary focus** — specifically ES (S&P 500) and NQ (NASDAQ) futures
- Core strategy: **reversal at key support/resistance levels** using pure price action (no indicators)
- Building toward automated analysis → suggestions → execution pipeline
- All strategies must be backtested before any real capital recommendations
