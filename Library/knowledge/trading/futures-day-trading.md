# Futures Day Trading

> Futures-specific knowledge. Source: Riley Coleman's day trading methodology.

---

## What Are Futures?

- **Contracts** to buy/sell an asset at a future price
- Derivatives of underlying indices/commodities (S&P 500, NASDAQ, oil, gold)
- Trade like stocks on a chart (candlesticks, same TA) but with built-in leverage
- Can go **long** (bet price goes up) or **short** (bet price goes down) equally easily

### Why Futures Over Other Markets

| Advantage | Detail |
|-----------|--------|
| No PDT rule | Trade as often as you want with any account size |
| Nearly 24/7 | Sunday evening to Friday afternoon (US) |
| Extreme liquidity | S&P 500, NASDAQ futures = most liquid markets in the world |
| Scale-friendly | Same chart, same strategy — just change contract size |
| Simple execution | Enter/exit like stocks, no Greeks or decay like options |
| Low fees relative to size | ~$3-9 round-trip per contract on good brokers |

---

## Key Futures Products

### E-mini vs Micro

| Product | Symbol | Point Value | Typical Margin (Intraday) | Best For |
|---------|--------|-------------|--------------------------|----------|
| E-mini S&P 500 | ES | $50/point | $500-7,000 (varies by broker) | Experienced traders |
| **Micro E-mini S&P 500** | MES | **$5/point** | **$50-700** | **Beginners / small accounts** |
| E-mini NASDAQ | NQ | $20/point | $500-7,500 | Experienced, higher volatility |
| Micro E-mini NASDAQ | MNQ | $2/point | $50-750 | Beginners |

**Start with Micros (MES/MNQ)** — same chart, same strategy, 1/10th the risk.

### Margin Explained

- **Margin ≠ risk** — it's collateral required to hold a position
- Intraday margin is much lower than overnight margin
- Your actual risk is determined by your **stop-loss distance**, not margin
- Example: 1 MES contract with a 4-point stop = $20 risk (regardless of $50 margin)

**Critical broker choice:** Some brokers require $7,000+ margin for ES. Others offer $500 intraday. For small accounts, choose brokers with low intraday margins.

---

## Riley Coleman's Reversal Strategy — Detailed

### Timeframes Used

- **15-minute chart:** Big picture — overall trend direction, major S/R levels
- **1-minute chart:** Execution — entry timing, candle confirmation, trade management

### The 5-Point Entry Checklist

1. **Strong directional move** — market has made a clear push up or down (on 15-min)
2. **Structure shift** — swing pattern changes (HH/HL → LH/LL or vice versa, on 1-min)
3. **Key level reached** — price is at a major support/resistance zone
4. **Confirmation candle** — large bearish/bullish candle at the zone
5. **Trigger** — price breaks the low/high of the confirmation candle → enter

### Trade Management

| Phase | Action |
|-------|--------|
| Entry | Place stop above/below reversal zone |
| Early | Let trade develop, don't micromanage |
| Momentum confirmed | Move stop to **break-even** (critical risk reduction) |
| Trending | Trail stop using trendline or structure |
| Parabolic move | Tighten stop aggressively — don't give back large gains |
| Exit | Hit profit target OR trailed out |

### Example Trade Walkthrough (S&P 500 / ES)

1. Market opens, strong move up from 9:30 AM EST
2. 15-min chart shows extended push — looking for reversal
3. On 1-min: Market makes a lower low, then a lower high (structure shift)
4. Large bearish candle forms at resistance zone
5. Enter short on break below that candle's low
6. Stop placed above the high of the reversal zone
7. Target: next major support zone below
8. Moved to break-even after initial move in favor
9. Trailed stop with descending trendline
10. Closed at ~$5,000 profit (large size, 15-30 min trade)

Same trade at micro size: ~$50-100 profit with identical chart/strategy.

---

## Trading Session Structure

### Daily Routine

1. **Pre-market (15 min before open):** Review 15-min chart, mark S/R levels, assess overnight price action
2. **Open (9:30 AM EST):** Watch for first 5-10 min to see opening move direction
3. **Active window (9:30-10:30 AM):** Primary trading window — peak volatility and setups
4. **Done by 10:30-11:00 AM** — close charts, move on with day

### Why This Window

- Market open = highest volume and volatility = best setups
- After first hour, moves become choppier and less directional
- Aligns with peak mental energy (especially for West Coast: 6:30-7:30 AM)

---

## Common Pitfalls (Futures-Specific)

| Pitfall | Reality |
|---------|---------|
| Prop firms as shortcut | <5% pass rate, monthly fees compound, still demo trading until "funded" |
| Overleveraging micros | Micros are cheap but 10 MES = 1 ES. Easy to accidentally take too much size |
| Ignoring overnight gaps | Futures trade nearly 24/7 — price can gap significantly at session open |
| Fee death from overtrading | $4-9/contract adds up fast at 20+ trades/day |
| Skipping demo stage | Real money amplifies every mistake — practice first, always |

---

## Platform: NinjaTrader

- Futures-focused trading platform
- Free demo with live data for 14 days, then $4/month for data
- Charting: candles, indicators, S/R drawing tools
- Order management: click-drag stop-losses on chart
- Supported brokers: NinjaTrader Brokerage (integrated), others via adapter

---

## Relevance to Forex

Most concepts from futures day trading transfer directly to forex:

| Concept | Futures | Forex Equivalent |
|---------|---------|-----------------|
| Reversal at S/R | ES/NQ at key levels | EUR/USD at session highs/lows |
| Structure shifts | HH/HL → LH/LL | Identical price action reading |
| Entry checklist | 5-point system | Same framework, different instruments |
| Risk per trade | Stop-loss × point value × contracts | Stop-loss in pips × lot size |
| Session timing | Market open (9:30 EST) | London open (3 AM EST), NY open (8 AM EST) |
| Scaling | MES → ES | Micro lots → Mini lots → Standard lots |

---

## Sources

1. Riley Coleman — "How To Day Trade With Only $4" (YouTube, 2026)
   - URL: https://www.youtube.com/watch?v=X2WcL536WYQ
   - Platform: NinjaTrader
   - Strategy: Price action reversal, no indicators
   - Timeframes: 15-min (big picture) + 1-min (execution)
   - Risk-reward: 1:3 preferred
   - Trade frequency: 1-3 per week
