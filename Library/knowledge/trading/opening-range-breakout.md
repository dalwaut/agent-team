# Opening Range Breakout — 5-Minute Scalping Strategy

> Source: "The 5 Minute Scalping Strategy (That Actually Works)" — Casper SMC
> URL: https://www.youtube.com/watch?v=nBOLIrNX_PU
> Claim: $9,000 → $134,000 in under 90 days
> Type: Rule-based breakout system — no indicators, 3-step mechanical process

---

## Strategy Overview

A breakout-with-retest scalping system built around the **opening range** — the high and low of the first 5-minute candle at market open (9:30–9:35 AM EST).

**Core thesis**: The first 5-minute candle establishes the day's initial range. When price breaks out and retests the level (proving it holds), enter in the **breakout direction** for a continuation move.

**Key properties**:
- No indicators required — pure price action
- 100% mechanical / rule-based (3 steps)
- Under 90 minutes of active trading per day
- Works across futures, stocks, crypto, forex
- Fixed 2:1 reward-to-risk ratio
- Stop-loss at midpoint of range (controlled risk)

---

## Contrast: Breakout vs Failed-Breakout

This strategy trades **WITH** the breakout direction (continuation), which is the **opposite** of the 4-Hour Range strategy (which fades failed breakouts).

| Aspect | Opening Range Breakout (this) | 4-Hour Range Scalping |
|--------|-------------------------------|----------------------|
| **Range** | First 5-min candle (9:30-9:35) | First 4-hour candle |
| **Breakout** | Candle closes outside range | Candle closes outside range |
| **Retest** | Trades into level, closes BACK OUTSIDE | Closes back INSIDE range |
| **Direction** | WITH the breakout (trend follow) | AGAINST the breakout (mean reversion) |
| **Logic** | Confirmed breakout = continuation | Failed breakout = reversal |
| **Stop-loss** | Midpoint of range | Breakout extreme |

**Both can be valid** — they capture different market behaviors. The key is knowing which conditions favor each.

---

## The 3-Step System

### Step 1: Mark Your Levels (at 9:35 AM EST)

1. Open any chart on the **5-minute time frame**
2. Wait for the first candle (9:30–9:35 AM EST) to **fully close**
3. Mark the **high** and **low** of that candle with horizontal lines
4. Mark the **midpoint** (50% level) using a fib retracement tool (high to low, only show 0, 0.5, 1)

Takes less than 30 seconds. Two lines + midpoint. Nothing else on the chart.

```
─────────────── Range High (first 5-min candle high)

         - - - - Midpoint (50% fib — this is your stop-loss level)

─────────────── Range Low (first 5-min candle low)
```

### Step 2: Wait for Breakout + Retest

**Breakout** (required first):
- A 5-minute candle **closes completely outside** the range
- Full body close beyond the high or below the low
- Wicks touching/piercing do NOT count — must be a body close

**Retest** (required second):
- After the breakout, price trades **back into** the level
- The candle that retests must **close back outside** the range
- This proves the level is holding — buyers/sellers are defending it

**Invalid retest** (DO NOT enter):
- If the retest candle **closes inside** the range → level is NOT holding
- Wait — the market may still give a valid setup later

```
VALID RETEST (bullish):                 INVALID RETEST:

  ──── Range High ────                    ──── Range High ────
         │                                       │
    ▲    │  ◄─ breaks above                 ▲    │  ◄─ breaks above
    │    │                                  │    │
    └────┤  ◄─ retests, closes              └────┼──── closes INSIDE
         │     BACK ABOVE                        │     = NOT VALID
         │     = VALID ENTRY                     │     = WAIT
```

**Slingshot analogy**: The breakout is pulling back the slingshot. The retest is the rubber band at full tension. The close back outside is releasing — price explodes in the breakout direction.

### Step 3: Enter, Stop-Loss, and Target

**Entry**: Immediately on the retest candle's close (back outside the range).

| Breakout Direction | Trade | Entry |
|-------------------|-------|-------|
| Broke ABOVE range high, retested, closed back above | **LONG** | On retest candle close |
| Broke BELOW range low, retested, closed back below | **SHORT** | On retest candle close |

**Stop-loss**: At the **midpoint** of the range (the 50% fib level).
- For longs: just below the midpoint
- For shorts: just above the midpoint
- This keeps risk small and controlled

**Take-profit**: **2:1 risk-to-reward** (fixed).
- Measure the distance from entry to stop-loss
- Target is 2x that distance in the trade direction

---

## Critical Rules

| Rule | Detail |
|------|--------|
| **Body close required** | Breakout candle must close completely outside — wicks don't count |
| **Retest must close outside** | Retest candle trades into the level but must close back outside it |
| **If retest closes inside → invalid** | Do NOT enter. Wait for a new valid setup |
| **Stop-loss at midpoint** | Always the 50% level of the opening range, not the extreme |
| **Fixed 2:1 R:R** | Target is always 2x the stop-loss distance |
| **9:35 AM EST** | Range is based on the first 5-min candle after US market open |
| **First candle must be closed** | Do not mark range while the candle is still forming |

---

## The 3 Common Mistakes

### Mistake 1: FOMO — Chasing the Breakout

Entering immediately on the breakout candle instead of waiting for the retest.

**Impact**: Backtested win rate drops from **70% → 33%** without the retest.

**Why it hurts**:
- Entry price is worse (further from the range)
- No confirmation that the level holds
- Sacrifices nearly half the potential profit
- Many breakouts fail — the retest filters out fakeouts

### Mistake 2: Accepting Invalid Retests

Entering when the retest candle **closes inside** the range.

**Impact**: The level isn't holding — this is likely a fakeout.

**Fix**: Be patient. The market often provides a valid setup later in the same session. In the video example, price traded higher into the range (invalid), but then later broke back out and provided a clean retest entry.

### Mistake 3: Exiting During Chop

Cutting the trade early because price isn't moving straight to target.

**Impact**: Leaves money on the table. The strategy's edge comes from the 2:1 R:R — if you exit early, you destroy the math.

**Fix**: Trust the system. Set your stop-loss and target, then let the market work. Some trades take 30 minutes, others take until 1:00 PM. The chop is normal — let the system do the heavy lifting.

---

## Backtested Results

**Period**: 1 month+ of price action
**Instruments**: NASDAQ, S&P 500, Gold

| Metric | Value |
|--------|-------|
| Total trades | 20 |
| Winners | 14 |
| Losers | 6 |
| **Win rate** | **70%** |
| Net profit (1 contract) | **$10,000** |
| Max drawdown | **$1,000** |
| R:R per trade | 2:1 |

### Retest vs No-Retest Comparison

| Approach | Win Rate |
|----------|----------|
| **With retest** | **70%** |
| Without retest (FOMO) | 33% |

The retest more than doubles the win rate. This single rule is the difference between profitability and losing money.

---

## Daily Workflow

| Time (EST) | Action |
|-----------|--------|
| **9:30** | Market opens — first 5-min candle begins forming |
| **9:35** | Candle closes — mark high, low, midpoint (30 seconds) |
| **9:35–9:40** | Watch for breakout candle close outside range |
| **After breakout** | Wait for retest — candle touches level, closes back outside |
| **On valid retest** | Enter trade, set SL at midpoint, TP at 2:1 |
| **Trade active** | Hands off — let system run to SL or TP |
| **~11:00 AM** | Most trades resolve within 90 minutes |

---

## Execution on TradingView

1. **Time frame**: Click the time frame selector → 5 minutes
2. **Mark levels**: Left toolbar → Trend Line tool → draw at high and low of first candle
3. **Find midpoint**: Left toolbar → Fib Retracement tool → draw from high to low
   - Settings: only check 1, 0.5, and 0 levels
4. **Map trade**: Left toolbar → Long/Short Position tool → set entry, SL, TP
5. **Execute**: Click Buy/Sell button → set stop-loss and take-profit on the order

---

## Key Takeaways

1. **Simplicity beats complexity** — two lines and a midpoint, that's the entire system
2. **The retest is everything** — 70% win rate with it, 33% without it
3. **Mechanical execution eliminates emotion** — no interpretation, no guesswork
4. **Patience pays** — wait for valid retests, don't FOMO, don't cut trades early
5. **Under 90 minutes/day** — most setups appear and resolve quickly after open
6. **Universal** — works on futures (NQ, ES), gold, crypto, forex, stocks

---

## Sources

- Casper SMC — "The 5 Minute Scalping Strategy (That Actually Works)"
  - Channel: Casper SMC
  - URL: https://www.youtube.com/watch?v=nBOLIrNX_PU
  - Content: Opening range breakout with retest, 3-step system, 3 common mistakes, backtested 70% win rate over 20 trades, NASDAQ/S&P/Gold examples
  - Claim: $9K → $134K in 90 days
