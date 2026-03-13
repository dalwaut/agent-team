# Trading Foundations

> Core concepts applicable across all markets (forex, futures, stocks, crypto). Distilled from multiple sources.

---

## Market Types Overview

| Market | What You Trade | Key Characteristics |
|--------|---------------|---------------------|
| **Forex** | Currency pairs (EUR/USD, GBP/JPY) | 24/5, highest liquidity, leverage up to 500:1, no PDT rule |
| **Futures** | Contracts on indices, commodities, currencies | Nearly 24/7, high leverage, margin-based, E-mini & Micro sizes |
| **Stocks** | Company shares | PDT rule ($25K min for frequent day trading), market hours only |
| **Options** | Derivatives on stocks/indices | Complex (Greeks, decay), high leverage, many variables |
| **Crypto** | Digital currencies | 24/7, high volatility, unregulated, variable liquidity |

**Why forex for our focus:** Highest liquidity, no PDT restrictions, 24/5 trading, tight spreads on majors, well-established broker APIs for automation.

---

## Core Concepts

### Risk-Reward Ratio (R:R)

The ratio of potential loss to potential profit on a trade.

| R:R | Risk | Reward | Min Win Rate to Break Even |
|-----|------|--------|---------------------------|
| 1:1 | $100 | $100 | 50% |
| 1:2 | $100 | $200 | 33% |
| **1:3** | $100 | $300 | **25%** |
| 1:4 | $100 | $400 | 20% |

**Key insight:** Higher R:R means you can be wrong more often and still profit. A 1:3 R:R only needs ~30% win rate to be profitable (accounting for fees).

**Practical trade-off:** Higher R:R targets are hit less frequently. The "sweet spot" varies per strategy — but 1:2 to 1:3 is widely considered optimal for day trading.

### Win Rate vs R:R — The Profitability Matrix

| Win Rate | 1:1 R:R | 1:2 R:R | 1:3 R:R |
|----------|---------|---------|---------|
| 30% | -$40/trade | +$20/trade | **+$60/trade** |
| 40% | -$20/trade | +$40/trade | +$80/trade |
| 50% | Break even | +$50/trade | +$100/trade |
| 60% | +$20/trade | +$80/trade | +$120/trade |

*(Per $100 risk, simplified without fees)*

### Position Sizing

Never risk more than a fixed percentage of your account per trade.

| Account Size | 1% Risk | 2% Risk | 3% Risk |
|-------------|---------|---------|---------|
| $1,000 | $10 | $20 | $30 |
| $5,000 | $50 | $100 | $150 |
| $25,000 | $250 | $500 | $750 |

**Standard rule:** Risk 1-2% per trade maximum. This ensures a losing streak doesn't blow the account.

### Stop-Loss

A predetermined price level where you exit a losing trade. **Non-negotiable for every trade.**

- Place based on market structure (support/resistance), not arbitrary dollar amounts
- Moving to break-even after trade moves in your favor reduces risk to zero
- Trailing stops lock in profit as trade continues in your direction

---

## Market Structure

### Trend Identification

- **Uptrend:** Higher highs (HH) + higher lows (HL)
- **Downtrend:** Lower highs (LH) + lower lows (LL)
- **Range/consolidation:** Price bouncing between support and resistance

### Structure Shifts

When a trend changes character:
- Uptrend → first lower low = potential shift to downtrend
- Downtrend → first higher high = potential shift to uptrend
- These shifts are the foundation of **reversal trading strategies**

### Support & Resistance

- **Support:** Price level where buying pressure historically stops decline
- **Resistance:** Price level where selling pressure historically stops advance
- These zones (not exact lines) are where reversals frequently occur
- Previous support becomes resistance when broken (and vice versa)

---

## Day Trading Framework

### Time Commitment

- **Optimal session:** 1-2 hours at peak performance
- **Why not longer:** Trading is a decision game — hundreds of micro-decisions per hour cause mental fatigue
- **Quality over quantity:** Better to trade 1 hour well than 6 hours with declining decision quality

### Trade Frequency

- Good setups don't appear often — 1-3 quality trades per week is normal
- Overtrading is the #1 account killer (fees + bad decisions compound)
- **"The market comes to you"** — don't chase, wait for your checklist to be met

### The Mental Game

- Trading is **extremely psychological** — managing emotions is as important as strategy
- Scale gradually: $20 → $50 → $100 → $500 → $1,000+ risk per trade
- Each size increase triggers new emotional responses that must be managed
- Seeing large P&L swings is a skill that's trained over months/years
- **Boredom is good** — exciting trading is usually bad trading

---

## Strategy Development Principles

### Entry Checklist Method

Before every trade, have a clear checklist. Example (5-point):

1. **Big picture context** (15-min chart) — what's the overall trend/structure?
2. **Setup pattern** — has your specific pattern appeared? (e.g., reversal at key level)
3. **Confirmation** — candle pattern or price action confirming the move
4. **Entry trigger** — exact point to enter (break of candle, retest, etc.)
5. **Exit plan** — stop-loss placement AND profit target(s) defined BEFORE entry

**If any item is missing, no trade.**

### Reversal Strategy (from Source #1 — Riley Coleman)

Core approach: Trade reversals at key levels.

1. Identify strong move (up or down) on higher timeframe
2. Look for structural shift (HH/HL pattern breaks into LH/LL or vice versa)
3. Mark support/resistance zones as reversal targets
4. Wait for confirmation candle at the zone
5. Enter on break of confirmation candle
6. Stop above/below the reversal zone
7. Target next major support/resistance level
8. Move to break-even once trade shows conviction
9. Trail stop with trend as trade progresses

**No indicators used** — pure price action and market structure.

### What Makes a Bad Trade

- No plan before entry — reacting to price movement
- FOMO — entering because "the move is happening right now"
- Revenge trading — trying to win back losses immediately
- Overtrading — taking marginal setups because you want action
- Moving stop-loss further away to "give it more room"

---

## Scaling Path

| Stage | Duration | Account Type | Risk/Trade | Goal |
|-------|----------|-------------|------------|------|
| 1. Demo | 1-2 months | Paper trading | $0 | Learn platform, practice strategy, build routine |
| 2. Micro | 2-3 months | Small live account | $10-50 | Introduce real money psychology, validate strategy |
| 3. Small | 3-6 months | Live account | $50-200 | Build consistency, refine risk management |
| 4. Standard | 6-12 months | Growing account | $200-1,000 | Compound gains, handle larger P&L swings |
| 5. Professional | 12+ months | Full-size | $1,000+ | Optimize, diversify strategies |

**Key rule:** Never skip stages. Each stage builds the mental framework for the next.

---

## Sources

1. Riley Coleman — "How To Day Trade With Only $4" (YouTube, 2026) — Futures day trading, reversal strategy, scaling, mental game
