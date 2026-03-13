# Futures Deep Dive — Complete Guide

> Source: Riley Coleman — "How To Start Day Trading Futures As A Beginner In 2026" (3-hour masterclass)
> URL: https://www.youtube.com/watch?v=Kdqi70RP7PM

---

## Futures Mechanics

### Contract Basics

- Futures = contract agreement to buy/sell an asset at a future price
- You don't own the underlying asset — you own a contract whose value tracks it
- Contracts **expire** (unlike stocks) — typically every 1 or 3 months
- Day traders never hold to expiration — close out or roll over well before

### Rollover Process

- S&P 500 futures (ES) expire every 3 months (quarterly: March, June, September, December)
- Expiration = Friday of the 3rd week of the expiration month
- **Roll over ~1 week before expiration** to the next contract (volume shifts to new contract)
- On NinjaTrader: click rollover button or change ticker symbol month code
- Month codes: F=Jan, G=Feb, H=Mar, J=Apr, K=May, M=Jun, N=Jul, Q=Aug, U=Sep, V=Oct, X=Nov, Z=Dec

### Pricing — Points and Ticks

| Market | Symbol | Tick Size | Tick Value | Point Value | Notes |
|--------|--------|-----------|------------|-------------|-------|
| **S&P 500 E-mini** | ES | 0.25 | $12.50 | $50 | Most popular, methodical |
| **S&P 500 Micro** | MES | 0.25 | $1.25 | $5 | 1/10th of ES |
| **NASDAQ E-mini** | NQ | 0.25 | $5.00 | $20 | More volatile than ES |
| **NASDAQ Micro** | MNQ | 0.25 | $0.50 | $2 | 1/10th of NQ |
| **Gold** | GC | 0.10 | $10.00 | $100 | Methodical, trend-following |
| **Crude Oil** | CL | 0.01 | $10.00 | $1,000 | News-driven, gappy |

**Key:** Price movement ≠ dollar movement. A 1-point move in ES = $50, not $1.

### Margin Deep Dive

| Type | When | Typical ES Margin | Notes |
|------|------|-------------------|-------|
| **Intraday** | During NY session (9:30-4:00 EST) | $500 (NinjaTrader) to $7,000 | Broker-dependent, much lower |
| **Overnight** | Outside NY hours | ~$15,000 | Rarely reduced, generally 2x intraday |
| **Micro Intraday** | During NY session | $50 | 1/10th of E-mini |

- Margin = collateral, NOT your risk. Risk = stop-loss distance x tick value x contracts
- Margin ≠ max loss — you can lose more than margin if market gaps against you
- Margin requirements increase during high volatility (e.g., COVID crash = 2-3x normal)
- No interest charges on futures margin (unlike stock margin)

### Leverage Warning

- You are overleveraged relative to margin — $500 margin controls ~$300,000 of S&P 500
- **Always use stop-losses** — no exceptions
- **Never hold through market close** — gap risk on reopen can blow an account
- Slippage on stops is minor in liquid markets (ES, NQ) — usually pennies

### Tax Advantages (Section 1256 — US)

- **60/40 rule:** 60% of futures profits taxed at long-term capital gains rate, 40% at short-term
- This applies even for day trades — no need to hold for a year
- Significant tax savings vs. stocks/options (all short-term if held < 1 year)
- *Note: Not tax advice — consult a professional*

---

## Market Personalities

### ES (S&P 500 Futures) — Recommended for Beginners

- **Personality:** Methodical, predictable, steady moves
- **Volatility:** Moderate — moves are solid but not whipsaw-y
- **Best for:** Beginners, reversal trades, clean support/resistance plays
- **Why start here:** Less likely to fake you out, cleaner structure, less emotional
- **Timeframe:** 1-min for entries, 15-min for big picture

### NQ (NASDAQ Futures) — For Experienced Traders

- **Personality:** Volatile, fast-moving, larger swings
- **Volatility:** High — huge candles, rapid reversals
- **Correlation:** Often moves same direction as ES but with more magnitude
- **Caution:** Easy to get whipsawed; big candles tempt impulsive entries
- **Note:** When choosing between ES and NQ for a trade, short the weaker one (more downside potential)

### Gold Futures (GC)

- **Personality:** Very methodical, trend-following, respects levels well
- **Volatility:** Can have periods of high volatility followed by calm
- **Best for:** Trend-line based trading — wait for clean trend breaks
- **Key insight:** Don't trade counter-trend until trend line clearly broken
- **Levels:** Gold respects support/resistance zones very well

### Oil Futures (CL)

- **Personality:** Choppy, news-driven, gappy
- **Volatility:** Can be dead for hours then spike violently on news
- **Tick behavior:** Gaps between individual ticks (illiquidity compared to ES/NQ)
- **Best timeframe:** 5-min often better than 1-min (too choppy on 1-min)
- **Recommendation:** Rare setups but can be very profitable when they align. Most beginners should avoid.

---

## Supply and Demand Zones

### Core Concept

Supply = resistance (sellers overwhelm buyers, price drops)
Demand = support (buyers overwhelm sellers, price rises)

**Think zones, not lines** — price reverses somewhere in a range, not at an exact number.

### How to Draw Zones

1. Look at recent price action (last few days for day trading)
2. Find areas where price reversed sharply — especially with velocity
3. Draw a rectangle covering the reversal area (not a single line)
4. Mark both the swing high/low and the consolidation before the move

### Zone Quality Criteria

| Factor | Strong Zone | Weak Zone |
|--------|------------|-----------|
| **Location** | At extremes (top/bottom of range) | Middle of range |
| **Velocity** | Fast move away from zone (imbalance) | Slow drift, choppy |
| **Freshness** | Recent (last few days) | Old (weeks/months ago) |
| **Tests** | 1-2 clean bounces | Over-tested (3+ touches = likely to break) |
| **Big picture** | Aligned with higher TF trend | Against the trend |

### Trending Supply/Demand

- Diagonal S/D levels that track a trend (like a trendline but used as S/D)
- Example: rising demand trendline connecting higher lows
- Previous supply becomes demand when broken (and vice versa) — called "flip zones"

### How Price Approaches Matters

| Approach Type | Description | Likelihood of Bounce |
|---------------|-------------|---------------------|
| **Fast/unhealthy** | Parabolic spike into zone | High — needs equilibrium pullback |
| **Slow/methodical** | Gradual grind into zone | Moderate — momentum may push through |
| **Choppy** | Back and forth near zone | Low — indecision, may break through |

---

## Candlestick Patterns (Top 6)

### 1. Engulfing Pattern

- **Bullish:** Bearish candle followed by larger bullish candle that engulfs it
- **Bearish:** Bullish candle followed by larger bearish candle that engulfs it
- **Signal:** Massive momentum reversal — previous candle completely overtaken
- **Use:** Confirmation at S/D zones for entry

### 2. Shooting Star / Hammer

- **Shooting Star (bearish):** Small body at bottom, long upper wick — rejection of higher prices
- **Hammer (bullish):** Small body at top, long lower wick — rejection of lower prices
- **Signal:** Momentum flip — price attempted one direction but was rejected
- **Key:** The wick shows where the battle was fought and lost

### 3. Three-Line Strike

- **Pattern:** Multiple candles moving in one direction, then one massive candle engulfs all of them
- **Signal:** Extreme momentum switch — slow grind reversed by explosive move
- **Use:** Very high-confidence reversal signal at key levels

### 4. Doji

- **Pattern:** Open and close nearly identical — small or no body, wicks on both sides
- **Signal:** Indecision — neither buyers nor sellers in control
- **Context matters:**
  - A few dojis in a flag pattern = normal (catching breath)
  - Many dojis = momentum dried up, likely failed breakout
  - Doji at key level = potential reversal

### 5. Head and Shoulders

- **Bearish:** Three peaks — middle one (head) highest, two shoulders lower
- **Bullish (inverse):** Three troughs — middle one lowest
- **Signal:** Major reversal pattern — structure shift from HH/HL to LH/LL
- **Key:** The final shoulder should ideally be a higher low (bullish) or lower high (bearish)

### 6. Flag Pattern

- **Pattern:** Strong move followed by tight consolidation (the flag)
- **Signal:** Continuation — market taking a breather before resuming
- **Caution:** Too many dojis in the flag = failed breakout risk
- **Failed breakout:** If flag consolidation drags on too long, momentum is dead

---

## Trend Lines

### Drawing Rules

1. Connect at least 2 swing highs (resistance) or swing lows (support)
2. The more touches, the more valid — but 2 is minimum
3. **Think of it as a zone, not an exact line** — allow some flexibility
4. Extend forward to predict where price may react next

### Trend Line Breaks

- **Clean break:** Candles clearly close beyond the line = trend likely over
- **Fake break:** Wick through but close back inside = trend still intact
- After break: market can go sideways OR reverse — it doesn't guarantee direction

### Channel Trading

- Draw parallel trend lines on both swings (highs AND lows)
- Creates a channel — trade bounces between upper and lower lines
- Very effective in ranging markets

---

## Live Trading Psychology (Real-Time Observations)

### Decision-Making Under Pressure

- **Half-size when less confident** — reduce position when setup isn't A+
- **Sleep affects decisions** — trading on poor sleep = worse outcomes
- **Choose one market** — watching ES and NQ simultaneously leads to regret ("classic — you choose one and the other does better")
- **Step away when emotions peak** — "I'm going to step away for a while because this is driving me a little crazy"

### Managing Doubt in Real-Time

- "Part of me wants to move my stop... but the big picture hasn't changed"
- **Don't exit because you're nervous** — exit because the market structure is violated
- "I don't want to get out because I'm nervous when there's no real market reason to get out"
- It's OK to feel doubt — the plan is what matters, not the feeling

### Trade Management Philosophy

- Move to break-even once initial move confirms
- **Partial exits:** Take half off at 2x, let rest run with trailing stop
- **Don't give back large moves:** Trail tightly in parabolic conditions
- "There's no point in risking $1,000 to make another $400" — math changes as trade progresses

---

## The Strategy — Reversal at Key Levels

### Entry Checklist (Refined)

1. **Fair value gap / overextension indicators** — market stretched far from mean
2. **Key support/resistance level** — price at a zone where reversals historically occur
3. **Trend break** — uptrend or downtrend line broken on 1-min
4. **Reversal candlestick pattern** — engulfing, three-line strike, double top/bottom, head & shoulders
5. **Timing window** — first 30-60 minutes after open, or specific reversal times (30 min, 8:00 AM)

### Timing Windows

| Window | What Happens |
|--------|-------------|
| **Market open (9:30 EST)** | Highest volatility, opening drive |
| **30 min after open (10:00 EST)** | Common reversal point |
| **8:00 AM EST** | Pre-market reversal opportunities |
| **After first hour** | Volatility dies down, fewer setups |

### Trade Management Steps

1. **Enter** on confirmation candle break
2. **Stop-loss** above/below the reversal zone
3. **Break-even** once initial move confirms (protects from loss)
4. **Partial exit** at 2x risk (lock in profit)
5. **Trail remainder** with trendline or previous candle highs/lows
6. **Full exit** at major S/D zone or when structure breaks

### Risk Rules

- **Max 5% per trade when starting** (5% of account)
- Scale down to **1-2%** as account grows
- **Keep risk consistent** — same dollar amount per trade (use position sizing calculator)
- **Half-size on B-grade setups** — only full size on A+ setups

---

## Scaling Blueprint

| Stage | Account Size | Contracts | Risk/Trade | Notes |
|-------|-------------|-----------|------------|-------|
| Demo | $0 | MES 1-2 | $0 | 2+ months minimum. Practice platform, strategy, routine |
| Micro Real | $500-1,000 | MES 1-2 | $20-50 | Introduce real money psychology |
| Micro Growth | $1,000-3,000 | MES 2-5 | $50-150 | Prove consistency with real capital |
| E-mini Entry | $3,000-10,000 | ES 1 | $200-500 | Same strategy, larger contract size |
| E-mini Scale | $10,000+ | ES 2-4 | $500-1,500 | Where significant income begins |
| Advanced | $25,000+ | ES 3-6+ | $1,000-2,500+ | Full professional trading |

### Key Scaling Principles

- Same strategy, same chart, same checklist — just change contract size
- Each size increase triggers new emotional responses — give yourself weeks to adjust
- If you start losing at new size, **go back down** and rebuild confidence
- "There are no shortcuts in trading. Anyone who tells you otherwise is trying to get your money."

---

## Common Mistakes (Explicit from Video)

1. **Jumping to real money too fast** — loses money on platform mistakes alone
2. **Overtrading** — 5-10 trades/day when 1-3/week is optimal
3. **Negative risk-reward** — risking $100 to make $50 = needs 67% win rate
4. **Strategy hopping** — new strategy every week after watching a YouTube video
5. **Too many indicators** — creates impossible checklist, can't identify what works
6. **Trading middle of range** — best setups are at extremes, not in chop
7. **Holding through market close** — gap risk can destroy account
8. **Moving stop-loss further away** — increases risk after entry = cardinal sin
9. **Getting married to a trade** — hoping it works instead of following the plan
10. **Prop firm trap** — <5% pass, monthly fees, still demo trading with extra pressure

---

## Sources

- Riley Coleman — "How To Start Day Trading Futures As A Beginner In 2026"
  - URL: https://www.youtube.com/watch?v=Kdqi70RP7PM
  - Duration: ~3 hours
  - Content: Complete futures course — mechanics, margin, pricing, market personalities, supply/demand, candlestick patterns, trend analysis, strategy, live trading examples, scaling
