# Report: accuracy

# ACCURACY AUDIT REPORT

## Scope

Full codebase at `/workspace/synced/opai/` covering ~35 projects, ~15 backend tools, and ~5 MCPs. Audited all files containing calculations, date/time handling, data mapping, statistical operations, and chart/visualization data.

---

## 1. DATE/TIME CALCULATIONS

### FINDING 1.1 — Timezone Inconsistency in Monitor Timestamp
- **File:** `tools/opai-monitor/collectors.py:70`
- **Severity:** Medium
- **Code:**
  ```python
  "timestamp": datetime.now().isoformat(),
  ```
- **Problem:** Uses `datetime.now()` (local time, no timezone info) while other services in the codebase consistently use `datetime.now(timezone.utc)` (e.g., `tools/opai-helm/core/scheduler.py:105`, `tools/opai-dam/core/scheduler.py:54`, `tools/opai-tasks/` services). If this timestamp is compared to UTC timestamps from other services, it will be off by the local timezone offset.
- **Correct behavior:** Should use `datetime.now(timezone.utc).isoformat()` for consistency.
- **Fix:** Replace with `datetime.now(timezone.utc).isoformat()`

### FINDING 1.2 — Timezone Inconsistency in Monitor `started_at`
- **File:** `tools/opai-monitor/collectors.py:230`
- **Severity:** Medium
- **Code:**
  ```python
  "started_at": datetime.fromtimestamp(info.get("create_time", 0)).isoformat(),
  ```
- **Problem:** `datetime.fromtimestamp()` returns local time. The sibling field `uptime_seconds` on line 229 is computed against `time.time()` (UTC epoch), creating an inconsistency. If `create_time` is 0 (the default), this produces `1970-01-01T00:00:00` in local time, not UTC.
- **Correct behavior:** Use `datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()`
- **Fix:** `datetime.fromtimestamp(info.get("create_time", 0), tz=timezone.utc).isoformat()`

### FINDING 1.3 — Benchmark Runner Mixed Timezone in `run_id`
- **File:** `tools/opai-benchmark/runner.py:484`
- **Severity:** Low
- **Code:**
  ```python
  run_id = f"{config_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
  ```
- **Problem:** Uses local time for `run_id` but UTC for the `timestamp` field on line 490 (`datetime.now(timezone.utc).isoformat()`). The `run_id` embedded time and the `timestamp` field will show different times if not in UTC.
- **Correct behavior:** Both should use the same timezone.
- **Fix:** Change to `datetime.now(timezone.utc).strftime(...)` or accept as cosmetic (run_id is for filenames, not comparison).

### FINDING 1.4 — PooPoint 7-Day Trend Uses UTC `isoDate()` but `new Date()` is Local
- **File:** `Projects/PooPoint/Expo/services/analytics.ts:30-34`
- **Severity:** Medium
- **Code:**
  ```typescript
  const today = new Date();
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    days.push(isoDate(d)); // isoDate uses toISOString().slice(0,10) → UTC date
  }
  ```
- **Problem:** `new Date()` is in local time, but `toISOString()` always returns UTC. Near midnight, a user in UTC-5 might get `today` as Jan 5 local time, but `isoDate(today)` returns the UTC date (Jan 6 at 00:30 UTC). The 7-day window would then be off by one day relative to the user's perspective. Also, `p.created_at` on line 38 is compared using the same `isoDate()` function, so if `created_at` was stored in UTC, the comparison is self-consistent, but the "last 7 days" label will be misleading for users far from UTC.
- **Correct behavior:** Either normalize to the user's local timezone or document that the 7-day trend is UTC-based.
- **Fix:** Use local date formatting instead of `toISOString().slice(0,10)` for display purposes:
  ```typescript
  const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  ```

### FINDING 1.5 — NurtureNet Stats Uses `toLocaleDateString()` for Day Grouping
- **File:** `Projects/NurtureNet/Newborn Tracker/Expo/app/(tabs)/stats.tsx:92-93,164-167`
- **Severity:** Medium
- **Code:**
  ```typescript
  const todayStr = new Date().toLocaleDateString();
  const diapersToday = diaperEvents.filter(e =>
    new Date(e.startTime).toLocaleDateString() === todayStr
  ).length;
  // ...
  const dayStr = current.toLocaleDateString();
  const dayEvents = events.filter(e =>
    new Date(e.startTime).toLocaleDateString() === dayStr
  );
  ```
- **Problem:** `toLocaleDateString()` output is locale-dependent (e.g., "1/5/2026" in en-US vs "05/01/2026" in en-GB vs "2026/1/5" in ja-JP). If the app is used on devices with different locales or if data is shared between devices, the string comparison will silently fail to match days. Events could be miscounted or appear on wrong days.
- **Correct behavior:** Use a locale-independent date key like `YYYY-MM-DD` from an explicit formatter.
- **Fix:** Replace `toLocaleDateString()` comparisons with a stable ISO-like key:
  ```typescript
  const dateKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  ```

### FINDING 1.6 — NurtureNet Chart Day Iteration May Miss or Double-Count Days at DST Boundaries
- **File:** `Projects/NurtureNet/Newborn Tracker/Expo/app/(tabs)/stats.tsx:156-196`
- **Severity:** Low
- **Code:**
  ```typescript
  current.setHours(0, 0, 0, 0);
  // ...
  while (current <= end) {
    // ...
    current.setDate(current.getDate() + 1);
  }
  ```
- **Problem:** During DST "spring forward," setting `hours=0` and then advancing by 1 day via `setDate()` is generally safe. However, the `while (current <= end)` condition uses millisecond comparison. If `end` is set to `23:59:59.999` on the last day, and DST shifts cause `current` to land at `01:00:00` instead of `00:00:00`, the loop still works correctly. This is borderline safe but fragile.
- **Correct behavior:** This pattern is acceptable for the use case but should be noted as locale-sensitive.

---

## 2. STATISTICAL / NUMERICAL CALCULATIONS

### FINDING 2.1 — Hosting Calculator `parseDurationToYearFactor` Inverted Logic
- **File:** `Projects/INTERNAL/Hosting Calculator/utils/parsing.ts:94-103`
- **Severity:** Critical
- **Code:**
  ```typescript
  const parseDurationToYearFactor = (lengthStr: string): number => {
    if (!lengthStr) return 1;
    const lower = lengthStr.toString().toLowerCase();
    const match = lower.match(/[\d.]+/);
    const value = match ? parseFloat(match[0]) : 1;

    if (lower.includes('month')) return 12 / value;
    if (lower.includes('year')) return 1 / value;
    return 1;
  };
  ```
- **Problem:** The function is used on line 145 as `annualizedCost = rawAmount * annualFactor`. For "3 months" at $10/month: `annualFactor = 12 / 3 = 4`, and `annualizedCost = 10 * 4 = $40`. But the **actual** annualized cost of $10/month is $120/year. The function divides 12 by the duration value, giving a multiplier that converts the *term total* to annual. So if the `rawAmount` is the **total for the term** (e.g., $30 for 3 months), then `30 * 4 = $120` is correct. But if `rawAmount` is the **monthly rate** ($10), it gives $40, which is wrong.

  For "2 year" at $200 total: `annualFactor = 1/2 = 0.5`, `annualizedCost = 200 * 0.5 = $100/yr`. This is correct only if `rawAmount` is the total for the entire period, not per-year.

  The ambiguity between "raw amount = total for term" vs "raw amount = per-period rate" is **not resolved** by the code. The heuristic on lines 140-142 (if amount < $15, assume monthly) compounds this: it assumes `rawAmount` is a monthly rate and sets `annualFactor = 12`, but the function above would also give 12 for "1 month" — creating a double-multiplication risk if both branches execute.
- **Correct behavior:** Clearly document or detect whether `rawAmount` is term-total or per-period. Add validation to prevent annualized costs that are unreasonably high.
- **Fix:** Add a guard and clarify the interpretation:
  ```typescript
  // Only apply heuristic if lengthKey is absent (lines 139-143)
  // AND ensure parseDurationToYearFactor always treats rawAmount as term-total
  ```

### FINDING 2.2 — Benchmark Report Tool Accuracy Delta Indicator Inverted
- **File:** `tools/opai-benchmark/report.py:122`
- **Severity:** Medium
- **Code:**
  ```python
  delta = t - b
  print(f"... {delta*100:>+9.1f}pp {_delta_indicator(-delta, True)}")
  ```
- **Problem:** The `_delta_indicator` is called with `-delta` and `lower_is_better=True`. For tool accuracy, **higher is better**. If tool accuracy goes from 80% to 90% (delta = +0.1), `_delta_indicator(-0.1, True)` returns `"+"` because -0.1 < 0 and lower_is_better. This produces the correct visual result ("+" = improvement) but via double-negation, making the code confusing and error-prone for maintenance.
- **Correct behavior:** Should call `_delta_indicator(delta, lower_is_better=False)` for clarity.
- **Fix:** `_delta_indicator(delta, lower_is_better=False)`

### FINDING 2.3 — Benchmark Harness F1 Score Edge Case
- **File:** `tools/opai-benchmark/harness.py:260-278`
- **Severity:** Low
- **Code:**
  ```python
  if not expected_tools:
      return 1.0 if not actual_tools else 0.5
  # ...
  if not expected_set:
      return 1.0
  ```
- **Problem:** Lines 260-261 check `if not expected_tools` (the raw list), which handles the empty list case. Then line 266 checks `if not expected_set` (the set version), which is redundant since we already returned. Not a bug, but dead code.
  
  More importantly, on line 273: `precision = len(hits) / len(actual_names) if actual_names else (1.0 if not expected_set else 0.0)`. If `actual_names` is empty (Claude called no tools) and `expected_set` is non-empty, precision = 0.0 and recall = 0/N = 0.0, so F1 = 0.0. This is correct.

  However, if `expected_tools = []` and `actual_tools = ["SomeTool"]`, the function returns 0.5 — but there's no principled reason for this score. It penalizes Claude for calling *any* tool when none were expected, but the penalty is arbitrary.
- **Correct behavior:** Consider returning 0.0 (no tools expected, tools were called = incorrect).
- **Fix:** Change line 261 to `return 1.0 if not actual_tools else 0.0` if strictness is desired.

### FINDING 2.4 — Billing MRR Calculation Doesn't Handle Interval Count
- **File:** `tools/opai-billing/routes_api.py:75-82`
- **Severity:** High
- **Code:**
  ```python
  for sub in active_subs:
      price_data = sub.get("stripe_prices") or {}
      amount = price_data.get("unit_amount", 0) or 0
      interval = price_data.get("recurring_interval", "month")
      if interval == "year":
          mrr += amount / 12
      else:
          mrr += amount
  ```
- **Problem:** This only handles "month" and "year" intervals. Stripe also supports `"week"` and `"day"` intervals, as well as `interval_count` > 1 (e.g., "every 3 months" = interval="month", interval_count=3). A quarterly subscription ($100/quarter) would be treated as monthly ($100/month MRR) instead of the correct $33.33/month MRR. Similarly, a weekly subscription of $10/week would be treated as $10/month instead of ~$43.33/month.
- **Correct behavior:** Account for all Stripe intervals and `interval_count`:
  ```python
  interval_count = price_data.get("recurring_interval_count", 1) or 1
  if interval == "year":
      mrr += amount / (12 * interval_count)
  elif interval == "month":
      mrr += amount / interval_count
  elif interval == "week":
      mrr += amount * (52 / 12) / interval_count
  elif interval == "day":
      mrr += amount * (365.25 / 12) / interval_count
  ```
- **Fix:** Expand the interval handling to cover all Stripe intervals and honor `interval_count`.

### FINDING 2.5 — Bx4 Health Score Weights Don't Sum to 1.0
- **File:** `tools/opai-bx4/core/budget_filter.py:115-121`
- **Severity:** Low (by design)
- **Code:**
  ```python
  score = (
      liquidity_score * 0.25
      + growth_score * 0.20
      + margin_score * 0.20
      + efficiency_score * 0.15
      + reserve_score * 0.20
  )
  ```
- **Problem:** The weights sum to 0.25 + 0.20 + 0.20 + 0.15 + 0.20 = **1.00**. This is correct. However, `reserve_score` is hard-coded to 50 (line 112), meaning 20% of the total score is always 10 points (50 * 0.20). This creates a silent floor of 10 and a ceiling reduction of 10 on the final score. Not a calculation error per se, but worth documenting.
- **Correct behavior:** Acceptable as designed; the 20% reserve is intentional padding for future KPIs.

### FINDING 2.6 — ThisKitchen Checkout Tax Calculation Uses Floating Point
- **File:** `Projects/ThisKitchen/ThisKitchen/components/CheckoutModal.tsx:189-191`
- **Severity:** Medium
- **Code:**
  ```typescript
  const taxRate = 0.07;
  const grandTotalCash = totalCash * (1 + taxRate);
  const grandTotalCredit = totalCredit * (1 + taxRate);
  ```
- **Problem:** This is a classic floating point issue. For example, if `totalCash = 10.00`, then `10.00 * 1.07 = 10.700000000000001` in IEEE 754. The display uses `.toFixed(2)` (line 313), which rounds correctly for display. However, if this value is ever compared for equality or stored directly, it could cause off-by-one-cent errors.
- **Correct behavior:** For financial calculations, round before display and ideally work in integer cents:
  ```typescript
  const grandTotalCash = Math.round(totalCash * (1 + taxRate) * 100) / 100;
  ```
- **Fix:** Add explicit rounding after the multiplication.

### FINDING 2.7 — NurtureNet Sleep Average Divides by Zero When No Sleep Events With `endTime`
- **File:** `Projects/NurtureNet/Newborn Tracker/Expo/app/(tabs)/stats.tsx:104`
- **Severity:** Low
- **Code:**
  ```typescript
  avgLength: sleepEvents.reduce((acc, curr) => acc + (curr.endTime! - curr.startTime), 0)
    / (sleepEvents.length || 1) / (1000 * 60 * 60),
  ```
- **Problem:** Uses `sleepEvents.length || 1` to avoid division by zero — correct. However, the `sleepEvents` filter on line 67 already ensures `e.endTime` exists, so the non-null assertion `curr.endTime!` is safe. But if `endTime < startTime` (invalid data), the reduction would produce negative values, and the average could be negative or misleading.
- **Correct behavior:** Filter out events where `endTime <= startTime` to guard against invalid data.
- **Fix:** Add `&& e.endTime > e.startTime` to the filter on line 67.

---

## 3. DATA MAPPING CORRECTNESS

### FINDING 3.1 — Billing Dashboard Uses Joined Field Name That May Not Match
- **File:** `tools/opai-billing/routes_api.py:73-78`
- **Severity:** Medium
- **Code:**
  ```python
  active_subs = await bb_query(
      "subscriptions",
      "status=eq.active&select=*,stripe_prices:price_id(unit_amount,recurring_interval)"
  )
  for sub in active_subs:
      price_data = sub.get("stripe_prices") or {}
      amount = price_data.get("unit_amount", 0) or 0
      interval = price_data.get("recurring_interval", "month")
  ```
- **Problem:** The PostgREST join syntax `stripe_prices:price_id(...)` renames the foreign key column `price_id` to `stripe_prices` in the response. This returns a single object (FK is to-one), so `price_data` is a dict. This is correct if the `subscriptions` table has a `price_id` FK referencing `stripe_prices`. However, if the FK name changes or the table name is different, this silently returns `None`, and the default values (`0` and `"month"`) would be used, making all subscriptions appear as $0/month MRR.
- **Correct behavior:** Add a check/log when `price_data` is empty for an active subscription.
- **Fix:** Add warning logging when `price_data` is empty.

### FINDING 3.2 — Boutabyte License Validation Uses `current_activations` Field Without Incrementing
- **File:** `Projects/Boutabyte/src/lib/license-utils.ts:87-89`
- **Severity:** High
- **Code:**
  ```typescript
  if (license.current_activations >= license.max_activations) {
    return { valid: false, license, reason: 'Maximum activations reached' };
  }
  ```
- **Problem:** The `validateLicense` function checks `current_activations >= max_activations` to reject new activations. But `activateLicense` (line 98) calls `validateLicense` first, then inserts a new `license_activations` row — but **never increments `current_activations`** on the `licenses` table. Unless there's a database trigger doing this increment, the `current_activations` count will never increase and the check will never reject.
  
  Looking at the `deactivateLicense` function (line 180), it also doesn't decrement `current_activations`. This means either:
  1. A database trigger handles it (not verifiable from code alone), or
  2. `current_activations` is stale and the activation limit is effectively unenforced.
- **Correct behavior:** After inserting a new activation, increment `current_activations` on the `licenses` row. Or use a COUNT query on `license_activations` where `is_active = true` instead of a cached counter.
- **Fix:** Add an increment after successful activation:
  ```typescript
  await supabase.rpc('increment_activations', { license_id: license.id });
  ```
  Or replace the counter check with:
  ```typescript
  const { count } = await supabase.from('license_activations')
    .select('*', { count: 'exact', head: true })
    .eq('license_id', license.id).eq('is_active', true);
  if (count >= license.max_activations) { ... }
  ```

### FINDING 3.3 — Boutabyte License Key Validation Regex Mismatch
- **File:** `Projects/Boutabyte/src/lib/license-utils.ts:13,28`
- **Severity:** Low
- **Code:**
  ```typescript
  // Generation: chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' (no I, O, 0, 1)
  // Validation: pattern = /^BBYTE-[A-Z0-9]{4}-...$/
  ```
- **Problem:** The generation function excludes ambiguous characters (I, O, 0, 1) to improve readability, but the validation regex accepts `[A-Z0-9]` which includes all of them. This means the validation would accept keys with characters that the generator never produces. Not a correctness bug (valid keys always pass), but keys manually entered with `I`, `O`, `0`, `1` would pass format validation but never match a real key.
- **Correct behavior:** Tighten the regex to match only the characters used in generation, or accept this as intentional leniency.
- **Fix:** Change regex to: `/^BBYTE-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-...$/`

### FINDING 3.4 — ProductReviews `renderStars` Rounds Average But Displays Raw Value
- **File:** `Projects/Boutabyte/src/components/reviews/ProductReviews.tsx:94-95`
- **Severity:** Low
- **Code:**
  ```typescript
  {renderStars(Math.round(stats.average))}
  <span className="text-white font-medium">{stats.average}</span>
  ```
- **Problem:** Stars are rendered with `Math.round(stats.average)` (e.g., 4.3 shows 4 stars), but the numeric value shown is the raw `stats.average` (e.g., "4.3"). If `stats.average` is a number like `4.7`, the stars show 5 but the number shows "4.7". This creates a visual mismatch between the star count and the displayed number.
- **Correct behavior:** Either show fractional stars, or display the rounded value alongside the stars.
- **Fix:** Consider using half-star rendering or displaying `stats.average.toFixed(1)`.

---

## 4. EDGE CASES

### FINDING 4.1 — PooPoint Geospatial Bucketing Uses `Math.round` Instead of `Math.floor`
- **File:** `Projects/PooPoint/Expo/services/analytics.ts:45`
- **Severity:** Medium
- **Code:**
  ```typescript
  const bucket = (lat: number, lng: number) =>
    `${Math.round(lat / 0.0002)}:${Math.round(lng / 0.0002)}`;
  ```
- **Problem:** `Math.round` means that a coordinate at the boundary between two buckets (e.g., `lat = 0.0001`) could round up or down depending on the exact value. Two points that are 10 meters apart could end up in different buckets or the same bucket depending on rounding. Using `Math.floor` would create consistent, non-overlapping bucket boundaries. With `Math.round`, the effective bucket boundaries shift by half a bucket width, creating a 50% overlap zone at every boundary.
- **Correct behavior:** Use `Math.floor` for consistent grid bucketing.
- **Fix:** `const bucket = (lat: number, lng: number) => \`${Math.floor(lat / 0.0002)}:${Math.floor(lng / 0.0002)}\`;`

### FINDING 4.2 — Monitor `formatBytes` Breaks on Negative Values
- **File:** `tools/opai-monitor/static/app.js:32-38`
- **Severity:** Low
- **Code:**
  ```javascript
  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
  }
  ```
- **Problem:** If `bytes` is negative, `Math.log(negative)` returns `NaN`, making `i = NaN`, `sizes[NaN] = undefined`, and the output becomes `"NaN undefined"`. Negative byte values shouldn't normally occur, but could appear from delta calculations (e.g., network counter wraparound).
- **Correct behavior:** Handle negative/invalid inputs gracefully.
- **Fix:** Add `if (bytes < 0) return '-' + formatBytes(-bytes);`

### FINDING 4.3 — NurtureNet `lifetimeInsights` Calls `.toFixed()` on Potentially `null` Values
- **File:** `Projects/NurtureNet/Newborn Tracker/Expo/app/(tabs)/stats.tsx:257-269`
- **Severity:** High
- **Code:**
  ```tsx
  <Text>{lifetimeInsights?.feed.avgDaily.toFixed(1)}</Text>
  <Text>{lifetimeInsights?.diaper.avgDaily.toFixed(1)}</Text>
  <Text>{lifetimeInsights?.sleep.avgLength.toFixed(1)}h</Text>
  <Text>{lifetimeInsights?.sleep.totalHours.toFixed(1)} total hrs</Text>
  ```
- **Problem:** `lifetimeInsights` can be `null` (line 117: `if (!selectedChild || events.length === 0) return null;`). The optional chaining `lifetimeInsights?.feed` returns `undefined` when null, and `.avgDaily` on `undefined` throws a TypeError at runtime. The JSX will crash the component.
- **Correct behavior:** Either conditionally render the entire block only when `lifetimeInsights` is non-null, or use a more complete null guard.
- **Fix:** Wrap the lifetime card in `{lifetimeInsights && ( ... )}` or move the null check to before the JSX block.

### FINDING 4.4 — NurtureNet Chart Data `maxFeeds` with Empty Array
- **File:** `Projects/NurtureNet/Newborn Tracker/Expo/app/(tabs)/stats.tsx:201`
- **Severity:** Low
- **Code:**
  ```typescript
  const maxFeeds = Math.max(...feedData.map(d => d.value || 0), 10);
  ```
- **Problem:** If `feedData` is empty (start date = end date with `setHours(0,0,0,0)` and `end.setHours(23,59,59,999)` might produce zero iterations), `Math.max(...[], 10)` = `10`, which is fine. But the spread of a very large array (thousands of days if date range is huge) could cause a stack overflow. Practically unlikely for this UI.
- **Correct behavior:** Safe for typical use; would break with extreme date ranges.

### FINDING 4.5 — Benchmark `_avg` Returns `0` Instead of `None` for Empty Lists
- **File:** `tools/opai-benchmark/runner.py:435-436`
- **Severity:** Low
- **Code:**
  ```python
  def _avg(values: list) -> float:
      return round(sum(values) / len(values), 3) if values else 0
  ```
- **Problem:** Returning `0` for an empty list means "no data" is indistinguishable from "actual average is 0". For token counts and costs this is fine (0 is a reasonable default), but for accuracy scores, a 0 could be misinterpreted as "0% accuracy" rather than "not measured."
- **Correct behavior:** Acceptable for this use case since the results are always non-empty (checked at line 391-392).

### FINDING 4.6 — Bx4 Health Score Does Not Handle Negative `burn_rate`
- **File:** `tools/opai-bx4/core/budget_filter.py:82-87`
- **Severity:** Low
- **Code:**
  ```python
  cash = snapshot.get("cash_on_hand", 0) or 0
  burn = snapshot.get("burn_rate", 0) or 0
  if burn > 0:
      runway_months = cash / burn
  else:
      runway_months = 12  # no burn = healthy
  ```
- **Problem:** If `burn_rate` is negative (indicating net positive cash flow, i.e., making money), it's treated the same as 0 burn, yielding runway_months = 12. A negative burn rate actually means infinite runway, so 12 is conservative but not wrong. However, a large negative burn should arguably score *higher* than a company with zero burn.
- **Correct behavior:** Acceptable as designed; negative burn is treated as healthy.

---

## 5. CHART / VISUALIZATION DATA

### FINDING 5.1 — Flipper ChannelChart Filters Out Channel 0 but Not 165+
- **File:** `Projects/Flipper/maruader/companion-app/components/Charts/ChannelChart.tsx:14`
- **Severity:** Low
- **Code:**
  ```typescript
  if (n.channel > 0 && n.channel < 165) {
  ```
- **Problem:** Valid WiFi channels go up to 177 (6GHz band, channels 1-233 in some regions). The filter `< 165` excludes valid 5GHz DFS channels (149, 153, 157, 161, 165) and all 6GHz channels. Channel 165 itself is excluded (`<` not `<=`).
- **Correct behavior:** Use `n.channel > 0 && n.channel <= 233` to include all valid WiFi channels, or at minimum `<= 165`.
- **Fix:** Change to `n.channel > 0 && n.channel <= 233` (or document the intentional 2.4/5GHz-only filter).

### FINDING 5.2 — Flipper ChannelChart Hardcodes "Main Channels" as 1, 6, 11 Only
- **File:** `Projects/Flipper/maruader/companion-app/components/Charts/ChannelChart.tsx:62`
- **Severity:** Low
- **Code:**
  ```typescript
  entry.channel === 1 || entry.channel === 6 || entry.channel === 11
      ? '#00d9ff' : '#3b82f6'
  ```
- **Problem:** Channels 1, 6, 11 are the non-overlapping 2.4GHz channels. The 5GHz band has different non-overlapping channels (36, 40, 44, 48, 52, etc.). The color highlighting only covers 2.4GHz. This is not incorrect but could be misleading when 5GHz data is present.
- **Correct behavior:** Add 5GHz primary channels to the highlight list or use a different color scheme for bands.

### FINDING 5.3 — NurtureNet Diaper Chart Expanded Modal Shows `0` as Dash Inconsistently
- **File:** `Projects/NurtureNet/Newborn Tracker/Expo/app/(tabs)/stats.tsx:445-447`
- **Severity:** Low
- **Code:**
  ```tsx
  <Text>{expandedChart.dataSet![0].data[index].value || '-'}</Text>
  <Text>{expandedChart.dataSet![1].data[index].value || '-'}</Text>
  <Text>{expandedChart.dataSet![2].data[index].value || '-'}</Text>
  ```
- **Problem:** `value || '-'` will show `-` for both `0` and `undefined`/`null`. A day with zero wet diapers shows `-` instead of `0`, which could be confusing (does `-` mean no data or zero changes?).
- **Correct behavior:** Use `value ?? '-'` or `value !== undefined ? value : '-'` to show `0` as `0`.
- **Fix:** Change to `{expandedChart.dataSet![0].data[index].value ?? '-'}`

---

## Summary Table

| # | File | Lines | Severity | Category | Issue |
|---|------|-------|----------|----------|-------|
| 2.1 | `Projects/INTERNAL/Hosting Calculator/utils/parsing.ts` | 94-145 | **Critical** | Numerical | `parseDurationToYearFactor` produces wrong annualized cost when `rawAmount` is per-period rate vs term total |
| 3.2 | `Projects/Boutabyte/src/lib/license-utils.ts` | 87-89, 98-175 | **High** | Data Mapping | `current_activations` never incremented — activation limit unenforced |
| 2.4 | `tools/opai-billing/routes_api.py` | 75-82 | **High** | Numerical | MRR calculation ignores `interval_count`, weekly/daily intervals; quarterly subs report 3x actual MRR |
| 4.3 | `Projects/NurtureNet/.../stats.tsx` | 257-269 | **High** | Edge Case | `.toFixed()` on nullable `lifetimeInsights` causes runtime crash |
| 1.1 | `tools/opai-monitor/collectors.py` | 70 | **Medium** | Date/Time | `datetime.now()` uses local time, inconsistent with UTC used elsewhere |
| 1.2 | `tools/opai-monitor/collectors.py` | 230 | **Medium** | Date/Time | `datetime.fromtimestamp()` uses local time, inconsistent with UTC epoch |
| 1.4 | `Projects/PooPoint/.../analytics.ts` | 30-34 | **Medium** | Date/Time | `isoDate()` uses UTC but `new Date()` is local — off-by-one day near midnight |
| 1.5 | `Projects/NurtureNet/.../stats.tsx` | 92-93, 164-167 | **Medium** | Date/Time | `toLocaleDateString()` is locale-dependent; day grouping breaks across locales |
| 2.2 | `tools/opai-benchmark/report.py` | 122 | **Medium** | Numerical | Tool accuracy delta uses double-negation; confusing but functionally correct |
| 2.6 | `Projects/ThisKitchen/.../CheckoutModal.tsx` | 189-191 | **Medium** | Numerical | Floating-point tax calculation; `.toFixed(2)` masks but doesn't fix penny rounding |
| 3.1 | `tools/opai-billing/routes_api.py` | 73-78 | **Medium** | Data Mapping | PostgREST join silently returns `None` if FK changes; no warning logged |
| 4.1 | `Projects/PooPoint/.../analytics.ts` | 45 | **Medium** | Edge Case | Geospatial bucketing uses `Math.round` instead of `Math.floor`; creates overlapping boundaries |
| 1.3 | `tools/opai-benchmark/runner.py` | 484 | **Low** | Date/Time | `run_id` uses local time, `timestamp` uses UTC; mixed in same record |
| 1.6 | `Projects/NurtureNet/.../stats.tsx` | 156-196 | **Low** | Date/Time | Day iteration via `setDate()` is fragile at DST boundaries |
| 2.3 | `tools/opai-benchmark/harness.py` | 260-261 | **Low** | Numerical | F1 returns 0.5 for unexpected tool calls; arbitrary score |
| 2.5 | `tools/opai-bx4/core/budget_filter.py` | 112, 115-121 | **Low** | Numerical | 20% of health score is always 10 pts (hardcoded reserve); acceptable by design |
| 2.7 | `Projects/NurtureNet/.../stats.tsx` | 67, 104 | **Low** | Numerical | Sleep events with `endTime < startTime` not filtered; could produce negative averages |
| 3.3 | `Projects/Boutabyte/src/lib/license-utils.ts` | 13, 28 | **Low** | Data Mapping | License key generation excludes chars I/O/0/1 but validation accepts them |
| 3.4 | `Projects/Boutabyte/.../ProductReviews.tsx` | 94-95 | **Low** | Data Mapping | Star display rounds average but raw number shown; visual mismatch |
| 4.2 | `tools/opai-monitor/static/app.js` | 32-38 | **Low** | Edge Case | `formatBytes` breaks on negative values (NaN output) |
| 4.4 | `Projects/NurtureNet/.../stats.tsx` | 201 | **Low** | Edge Case | `Math.max(...spread)` could stack overflow on huge arrays |
| 4.5 | `tools/opai-benchmark/runner.py` | 435-436 | **Low** | Edge Case | `_avg` returns 0 for empty list; indistinguishable from real 0 |
| 4.6 | `tools/opai-bx4/core/budget_filter.py` | 82-87 | **Low** | Edge Case | Negative burn rate treated same as zero; conservative but loses signal |
| 5.1 | `Projects/Flipper/.../ChannelChart.tsx` | 14 | **Low** | Chart | Channel filter excludes valid WiFi channels 165-233 |
| 5.2 | `Projects/Flipper/.../ChannelChart.tsx` | 62 | **Low** | Chart | Primary channel highlighting only covers 2.4GHz band |
| 5.3 | `Projects/NurtureNet/.../stats.tsx` | 445-447 | **Low** | Chart | `value \|\| '-'` shows dash for zero; should use nullish coalescing |

---

**Totals:** 1 Critical, 3 High, 7 Medium, 15 Low = **26 findings**

**Top priority fixes:**
1. **Hosting Calculator** annualization logic (Critical) — could produce wildly incorrect pricing comparisons
2. **License activation counter** (High) — activation limits are silently unenforced
3. **Billing MRR** (High) — quarterly/weekly/daily subscriptions miscounted in revenue dashboard
4. **NurtureNet crash** (High) — runtime TypeError when `lifetimeInsights` is null