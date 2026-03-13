# 4-Hour Range Scalping Strategy

> Source: "The BEST 5 Minute Scalping Strategy Ever (Simple and Proven)" — Data Trader
> URL: https://www.youtube.com/watch?v=O5eC5lY7ZXY
> Type: Rule-based scalping system — no indicators, 3-step checklist

---

## Strategy Overview

A simple failed-breakout scalping system built around a single concept: the **4-hour range** — the high and low of the first 4-hour candle of the trading day.

**Core thesis**: When price breaks outside the 4-hour range but quickly re-enters, the breakout has failed and price is likely to move in the **opposite** direction. Fade the failed breakout.

**Key properties**:
- No indicators required
- Completely rule-based (3-step checklist)
- Works on 5-minute chart
- Applicable across markets: crypto, forex, gold, stocks
- Fixed 2:1 reward-to-risk ratio
- Can be combined with other systems (price action, trends) for enhancement

---

## The 3-Step Checklist

### Step 1: Mark the 4-Hour Range

1. Open chart of your instrument on the **4-hour time frame**
2. Set time zone to **New York time** (critical — range is anchored to NY session)
3. Find the **first 4-hour candle** that formed on today's date
4. Draw horizontal lines at the **high** and **low** of that candle
5. Extend both lines to the end of the day

**Rules**:
- The first 4-hour candle must be **fully closed** before marking the range
- Do NOT mark the range while the candle is still forming
- The range is valid for the entire trading day (same day only)

```
4-Hour Range:
─────────────── Range High (first 4hr candle high)

   [  Trading zone  ]

─────────────── Range Low (first 4hr candle low)
```

### Step 2: Find the Scalp Setup (on 5-min chart)

Switch to the **5-minute time frame** and watch for this sequence:

1. **Breakout**: A 5-minute candle **closes** outside the range (above range high OR below range low)
   - The candle body must close outside — **wicks alone do NOT count**
2. **Re-entry**: Price then **closes back inside** the range on a subsequent 5-minute candle

Both events must occur **within the same trading day** as the marked 4-hour range.

```
BEARISH SETUP (short):                    BULLISH SETUP (long):

     ▲ breakout above range high               range low ───────────
  ───┼───── Range High                              │
     │  ◄── re-entry back inside                    ▼ breakout below
     │                                         ────►  re-entry back inside
  ───────── Range Low                          ─────────────────────
```

### Step 3: Enter the Trade

| Breakout Direction | Trade Direction | Logic |
|-------------------|-----------------|-------|
| Broke ABOVE range high, re-entered | **SHORT** | Failed breakout above = sell |
| Broke BELOW range low, re-entered | **LONG** | Failed breakout below = buy |

**Stop-loss**: At the **exact high** (for shorts) or **exact low** (for longs) of the breakout move.

**Take-profit**: **2x the stop-loss size** (fixed 2R target).

**Large breakout exception**: If the breakout was very large (making the stop-loss too wide), use the **nearest key level** (support/resistance, order block) for the stop-loss instead of the exact extreme.

---

## Trade Examples Summary

### Entry Logic Flowchart

```
Mark 4hr range (Step 1)
        │
        ▼
Does 5-min candle CLOSE outside range?
        │
   NO ──┤── YES
   │         │
 Wait    Does price CLOSE back inside?
              │
         NO ──┤── YES
         │         │
       Wait    ENTER TRADE
               │
               ├── Broke above → SHORT
               └── Broke below → LONG
               │
               ├── SL: breakout extreme
               └── TP: 2x SL (2R)
```

### Multiple Trades Per Day

As long as the trading day hasn't ended, **multiple valid setups can occur**. Each breakout + re-entry sequence within the same day's range is a separate trade opportunity.

---

## Backtested Results

### Crypto — Bitcoin (BTC)

| Day | Trades | Wins | Losses | Net R |
|-----|--------|------|--------|-------|
| Day 1 | 1 | 1 | 0 | +2R |
| Day 2 | 4 | 4 | 0 | +8R |
| Day 3 | 2 | 0 | 2 | -2R |
| **Total** | **7** | **5** | **2** | **+8R** |

**Win rate**: 72% | **Profit factor**: 4:1

### Forex — EUR/USD

| Day | Trades | Wins | Losses | Net R |
|-----|--------|------|--------|-------|
| Day 1 | 4 | 3 | 1 | +5R |
| Day 2 | 2 | 2 | 0 | +4R |
| Day 3 | 0 | — | — | 0R |
| **Total** | **6** | **5** | **1** | **+9R** |

**Win rate**: 83% | **Profit factor**: 10:1

### Gold — XAU/USD

| Day | Trades | Wins | Losses | Net R |
|-----|--------|------|--------|-------|
| Day 1 | 3 | 2 | 1 | +3R |
| Day 2 | 4 | 3 | 1 | +5R |
| Day 3 | 3 | 1 | 2 | 0R |
| **Total** | **10** | **6** | **4** | **+8R** |

**Win rate**: 60% | **Profit factor**: 3:1

### Combined Results

| Market | Trades | Win Rate | Net R |
|--------|--------|----------|-------|
| Crypto (BTC) | 7 | 72% | +8R |
| Forex (EUR/USD) | 6 | 83% | +9R |
| Gold (XAU) | 10 | 60% | +8R |
| **All Markets** | **23** | **70%** | **+25R** |

**Note**: This is a small sample (23 trades across 3 markets over ~3 days each). Larger backtesting recommended before live trading. These results use the basic version without any additional filters.

---

## Critical Rules

| Rule | Detail |
|------|--------|
| **Candle must CLOSE outside** | Wicks piercing the range do NOT count — body must close beyond |
| **Candle must CLOSE back inside** | Re-entry also requires a close, not just a wick |
| **Same day only** | All activity must occur within the same trading day as the 4-hour range |
| **NY time zone** | The first 4-hour candle is based on New York time |
| **Wait for 4hr candle to close** | Do not mark the range while the first candle is still forming |
| **Fixed 2R target** | Take-profit is always 2x the stop-loss distance |
| **Large breakout adjustment** | If SL would be too wide, use nearest key level instead of exact extreme |

---

## Enhancement Opportunities

The strategy as presented is the "basic version." Potential combinations to boost performance:

| Enhancement | How It Helps |
|-------------|-------------|
| **Price action confluence** | Only take setups that align with candlestick reversal patterns (hammer, doji, engulfing at re-entry) |
| **Trend filter** | Only take longs in uptrends, shorts in downtrends (higher timeframe trend) |
| **Volume confirmation** | Look for volume spike on breakout + declining volume = failed breakout signal |
| **Supply/demand zones** | Only take trades where the range aligns with known S/D zones |
| **Order flow** | Use order flow to confirm absorption at range boundaries |
| **Multiple timeframe** | Confirm with 15-min or 1-hr candle structure before entering on 5-min |

---

## Key Takeaways

1. **Simplicity wins** — one candle (the 4-hour range) creates a complete trading system
2. **Failed breakouts are high-probability** — when price breaks out and quickly returns, the breakout was false
3. **Rule-based = repeatable** — no discretion required, just follow the 3-step checklist
4. **Cross-market applicability** — tested on crypto, forex, and commodities with consistent results
5. **Fixed risk management** — always 2R target, stop at breakout extreme
6. **Combinable** — the basic system works standalone but can layer with other methods

---

## Sources

- Data Trader — "The BEST 5 Minute Scalping Strategy Ever (Simple and Proven)"
  - Channel: Data Trader
  - URL: https://www.youtube.com/watch?v=O5eC5lY7ZXY
  - Content: 4-hour range failed-breakout scalping, 3-step checklist, backtested on BTC/EUR-USD/Gold, 70% combined win rate at 2R
