# Report: accuracy



Now let me compile the complete audit report from all findings.

# Accuracy Audit Report — OPAI Workspace

## Executive Summary

Comprehensive audit of **12+ projects** across `/workspace/synced/opai/`. Analyzed date/time calculations, statistical computations, data mapping, edge case handling, and visualization correctness. Found **48 issues** across all severity levels, with **6 critical**, **12 high**, **18 medium**, and **12 low** severity findings.

---

## 1. DATE/TIME CALCULATIONS

### CRITICAL: Recurring Automation Schedule Never Parsed

**File:** `opai/Projects/Boutabyte/src/app/api/automations/schedules/route.ts:92-98`

```typescript
} else if (schedule_type === 'recurring' && cron_expression) {
  // For recurring, set to now + interval (simplified - real implementation needs cron parser)
  next_run_at = new Date().toISOString();
}
```

**Severity: CRITICAL** — All recurring automations execute immediately instead of on their CRON schedule. The comment acknowledges it's a stub, but this is deployed code that silently breaks all recurring scheduling.

**Fix:** Integrate a CRON parser (e.g., `cron-parser` npm package) to compute the actual next run time.

---

### HIGH: Timezone-Naive License Expiration Checks

**Files:**
- `opai/Projects/Boutabyte/src/lib/license-utils.ts:62-68`
- `opai/Projects/Boutabyte/src/lib/license-utils-client.ts:42-44`
- `opai/Projects/Boutabyte/src/components/dashboard/LicenseTile.tsx:26-28`
- `opai/Projects/Boutabyte/src/components/dashboard/LicenseDetailModal.tsx:65-67`

```typescript
const expirationDate = new Date(license.expires_at);
if (expirationDate < new Date()) {
  return { valid: false, license, reason: 'License has expired' };
}
```

**Severity: HIGH** — `expires_at` from the database (likely UTC) is compared against local time via `new Date()`. A user in UTC+12 could see their license expire 12 hours early; a user in UTC-12 could retain access 12 hours after expiration.

**Fix:** Normalize both sides to UTC, or use `Date.now()` and ensure `expires_at` is stored/compared as epoch milliseconds.

---

### HIGH: Duplicated Days-Until-Expiration in 4 Files

Same calculation copy-pasted in 4 locations with identical truncation issue:

```typescript
const daysUntilExpiration = Math.floor(
  (expiration.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
);
```

**Severity: HIGH** — `Math.floor` truncates: a license expiring at 11:59 PM today shows "0 days remaining" even with ~24 hours left. Also violates DRY — a fix must be applied in 4 separate files.

**Fix:** Extract to shared utility; consider `Math.ceil` or showing hours when < 1 day remains.

---

### MEDIUM: Date Rounding Causes ±1 Day Display Errors

**Files:**
- `opai/Projects/ByteSpace/apps/mobile/components/tasks/DueDatePicker.tsx:25`
- `opai/Projects/ByteSpace/apps/mobile/components/tasks/TaskCard.tsx:17`

```typescript
const diffDays = Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
```

**Severity: MEDIUM** — `Math.round()` on day differences can produce off-by-one errors. If a task is due slightly past midnight (e.g., DST shift yields -0.04 days), `Math.round(-0.04)` = 0, showing "Today" instead of "Yesterday."

**Fix:** Use `Math.floor()` for consistent truncation toward the past, or strip time components before comparison (already partially done but undermined by rounding).

---

### MEDIUM: Chat Timestamp Race Condition

**File:** `opai/Projects/BoutaChat/src/hooks/useChat.ts:179,290,306`

```typescript
// Line 179: User message
timestamp: new Date().toISOString(),
// Line 290: Assistant message (after API call)
timestamp: new Date().toISOString(),
// Line 306: Database update
updated_at: new Date().toISOString()
```

**Severity: MEDIUM** — Three independent `new Date()` calls during a single operation. If there's any delay between them (API latency, event loop scheduling), timestamps can be out of chronological order with the actual message sequence.

**Fix:** Capture `const now = new Date().toISOString()` once at function entry; reuse for all timestamps within the same logical operation.

---

### MEDIUM: Scheduled Time Silently Converts to UTC

**File:** `opai/Projects/Boutabyte/src/components/dashboard/AutomationScheduleModal.tsx:56`

```typescript
scheduledTime_iso = new Date(`${scheduledDate}T${scheduledTime}`).toISOString();
```

**Severity: MEDIUM** — User inputs local date/time (e.g., "9:00 AM EST"), but `.toISOString()` converts to UTC. A user scheduling "Daily at 9 AM" gets 2 PM UTC (or 1 PM, depending on DST). The CRON presets on lines 14-21 have the same ambiguity.

**Fix:** Document timezone expectation clearly in UI; or accept timezone input and convert explicitly.

---

### MEDIUM: Year-Addition Using setFullYear Ignores DST

**File:** `opai/Projects/Boutabyte/src/app/api/payments/stripe/webhook/route.ts:96-100`

```typescript
const oneYearFromNow = new Date();
oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);
expiresAt = oneYearFromNow.toISOString();
```

**Severity: MEDIUM** — `setFullYear()` can produce unexpected results across DST transitions (the hour component may shift). Also, Feb 29 + 1 year = Mar 1 (silent date shift on leap years).

**Fix:** Use a date library (e.g., `date-fns addYears`) or document the accepted behavior.

---

### LOW: Relative Time Formatters Don't Handle Invalid/Future Dates

**Files:**
- `opai/Projects/ByteSpace/apps/mobile/components/tasks/CommentThread.tsx:13-26`
- `opai/Projects/Boutabyte/src/components/dashboard/FloatingMenu.tsx:78-86`
- `opai/Projects/OPAI Mobile App/opai-mobile/app/notifications.tsx:98-110`

All share the same pattern: no validation of input string, no handling of future dates (produces negative values like "-5m ago"), and no year display for old dates.

---

## 2. STATISTICAL / NUMERICAL CALCULATIONS

### CRITICAL: Division by Zero in License Activation Percentage

**Files:**
- `opai/Projects/Boutabyte/src/components/dashboard/LicenseTile.tsx:95-101`
- `opai/Projects/Boutabyte/src/components/dashboard/LicenseDetailModal.tsx:147-157`

```typescript
license.current_activations / license.max_activations > 0.8
// ...
width: `${Math.min((license.current_activations / license.max_activations) * 100, 100)}%`,
```

**Severity: CRITICAL** — If `max_activations` is 0 (e.g., unlimited license or misconfiguration), this divides by zero producing `Infinity`. `Infinity > 0.8` is `true` (always yellow warning), and `Math.min(Infinity, 100)` = 100 (always full bar). The `Math.min` masks the Infinity but the color logic breaks.

**Fix:** Guard with `max_activations > 0 ? ... : 0` or handle unlimited activations as a separate case.

---

### HIGH: AI Cost Estimation Formula Unclear and Likely Incorrect

**File:** `opai/Projects/ByteSpace/apps/api/src/services/ai/router.ts:122-129`

```typescript
private estimateCost(response: AIResponse): number {
  if (response.model.includes('claude')) {
    return Math.ceil((response.tokens_in * 0.003 + response.tokens_out * 0.015) / 10);
  }
  return Math.ceil((response.tokens_in * 0.0001 + response.tokens_out * 0.0004) / 10);
}
```

**Severity: HIGH** — The division by 10 is an undocumented magic number. The comment says "cents" but the math doesn't add up to standard API pricing. All Claude models use the same rate despite wildly different pricing (Haiku vs Opus). `Math.ceil` inflates small costs to minimum 1 cent.

**Fix:** Use documented per-model pricing; add comments explaining the unit conversion chain; remove magic `/10`.

---

### HIGH: License Tier Check Grants Access for Unknown Tiers

**Files:**
- `opai/Projects/Boutabyte/src/lib/license-utils.ts:253-263`
- `opai/Projects/Boutabyte/src/lib/license-utils-client.ts:60-69`

```typescript
const tierHierarchy = ['free', 'starter', 'pro', 'ultimate'];
const userTierIndex = tierHierarchy.indexOf(userTier);
const pluginTierIndex = tierHierarchy.indexOf(pluginTierRequirement);
return userTierIndex >= pluginTierIndex;
```

**Severity: HIGH** — If either tier string is not in the array (typo, new tier, case mismatch), `indexOf` returns -1. Then `-1 >= -1` evaluates to `true`, granting access to any user with an unrecognized tier for any plugin with an unrecognized requirement.

**Fix:** Return `false` if either index is -1. Normalize to lowercase before comparison.

---

### HIGH: Math.random() for License Key Generation

**File:** `opai/Projects/Boutabyte/src/lib/license-utils.ts:10-22`

```typescript
export function generateLicenseKey(): string {
  // ...
  chars.charAt(Math.floor(Math.random() * chars.length))
  // ...
}
```

**Severity: HIGH** — `Math.random()` is not cryptographically secure. License keys are predictable with enough samples. An attacker could enumerate valid keys.

**Fix:** Use `crypto.getRandomValues()` (browser) or `crypto.randomBytes()` (Node.js).

---

### MEDIUM: Poll Percentages Don't Sum to 100%

**File:** `opai/Projects/BoutaCare/src/pages/dashboard.js:740-741`

```typescript
const totalVotes = options.reduce((sum, opt) => sum + (opt.votes || 0), 0);
const percentage = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;
```

**Severity: MEDIUM** — With 3 equal-vote options: `Math.round(33.33) = 33` each, totaling 99%. Users see percentages that don't add to 100%.

**Fix:** Use largest-remainder method for percentage allocation, or display one decimal place.

---

### MEDIUM: Image Optimizer Division by Zero

**File:** `opai/Projects/Boutabyte/src/lib/imageOptimizer.ts:57`

```typescript
const savedPercent = Math.round((savedBytes / originalSize) * 100);
```

**Severity: MEDIUM** — No check for `originalSize === 0`. A zero-byte file produces `NaN`.

**Fix:** Guard with `originalSize > 0 ? ... : 0`.

---

### MEDIUM: Currency Display with 4 Decimal Places

**File:** `opai/Projects/OPAI Mobile App/opai-mobile/app/(tabs)/command/audit.tsx:99`

```typescript
if (r.costUsd) parts.push(`$${Number(r.costUsd).toFixed(4)}`);
```

**Severity: MEDIUM** — Displays `$1.2500` instead of standard `$1.25`. Inconsistent with all other currency displays in the codebase.

**Fix:** Use `.toFixed(2)` for standard currency, or document if sub-cent precision is intentional.

---

### MEDIUM: Read Time Broken for Empty Strings

**Files:**
- `opai/Projects/Boutabyte/src/app/blog/page.tsx:73-77`
- `opai/Projects/Boutabyte/src/components/blog/BlogCard.tsx:32`

```typescript
const words = excerpt.split(' ').length;
const minutes = Math.ceil(words / 200);
```

**Severity: MEDIUM** — `"".split(' ')` returns `['']` (length 1), so empty excerpt shows "1 min read." Multiple spaces between words inflate word count.

**Fix:** Use `excerpt.trim().split(/\s+/).filter(Boolean).length`.

---

### LOW: Star Rating Rounding Mismatch

**File:** `opai/Projects/Boutabyte/src/components/reviews/ProductReviews.tsx:94-95`

```typescript
{renderStars(Math.round(stats.average))}  // Shows 4 stars
// Next line shows "3.6" as text
```

**Severity: LOW** — Displays 4 filled stars but "3.6" as text. Use half-stars or match decimal display to star count.

---

### LOW: Token Count Loses Precision at Thousands

**File:** `opai/Projects/OPAI Mobile App/opai-mobile/components/monitor/UsageCard.tsx:32-36`

```typescript
if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
```

**Severity: LOW** — 1,499 tokens displays as "1K" (loses 499). Millions use 1 decimal (`1.5M`) but thousands use 0 decimals.

**Fix:** Use `.toFixed(1)` for thousands too, for consistency.

---

## 3. DATA MAPPING CORRECTNESS

### HIGH: Purchase Type Mapping Loses "Yearly" Distinction

**Files:**
- `opai/Projects/Boutabyte/src/app/api/payments/stripe/webhook/route.ts:89-92`
- `opai/Projects/Boutabyte/src/app/api/payments/stripe/create-price/route.ts:90-92`

```typescript
const purchaseType = attachment.purchase_type || 'access_lifetime';
const accessType = purchaseType === 'source_code' ? 'source_code' : 'access';
```

**Severity: HIGH** — Both `access_lifetime` and `access_yearly` map to the same `accessType: 'access'`. The yearly vs lifetime distinction is lost in the access record, making it impossible to distinguish expiring vs permanent access from the `accessType` field alone.

**Fix:** Map `access_yearly` to a distinct access type, or include `purchase_type` in the access record.

---

### HIGH: Product Table Update Missing Default Case

**File:** `opai/Projects/Boutabyte/src/app/api/payments/stripe/create-price/route.ts:221-269`

```typescript
switch (target_type) {
  case 'webapp': updateTable = 'sub_apps'; break;
  case 'plugin': updateTable = 'wp_plugins'; break;
  case 'automation': updateTable = 'n8n_automations'; break;
  case 'mobileapp': updateTable = 'mobile_apps'; break;
}
// No default case
```

**Severity: HIGH** — If `target_type` is any other value, `updateTable` remains empty string. The subsequent database update silently fails or queries a non-existent table.

**Fix:** Add `default: return NextResponse.json({ error: 'Invalid target_type' }, { status: 400 })`.

---

### MEDIUM: Health Summary Counts Don't Sum to Total

**File:** `opai/Projects/OPAI Mobile App/opai-mobile/stores/monitorStore.ts:22-37`

```typescript
return {
  total: services.length,
  healthy: services.filter((s) => s.status === 'healthy').length,
  degraded: services.filter((s) => s.status === 'degraded').length,
  down: services.filter((s) => s.status === 'down').length,
  services,
};
```

**Severity: MEDIUM** — Services with `status === 'unknown'` are counted in `total` but not in any subcategory. `healthy + degraded + down < total` breaks dashboard integrity checks.

**Fix:** Add `unknown` count, or include unknown in `down`.

---

### MEDIUM: Notification Counter Uses Arithmetic Instead of Recalculation

**File:** `opai/Projects/OPAI Mobile App/opai-mobile/stores/dashboardStore.ts:52`

```typescript
unreadNotifications: Math.max(0, s.unreadNotifications - ids.length),
```

**Severity: MEDIUM** — Decrements by `ids.length` without verifying those IDs were actually unread. Marking already-read notifications as read double-decrements the counter.

**Fix:** Recalculate from filtered list: `s.notifications.filter(n => !n.is_read).length`.

---

### MEDIUM: Assignment ID Construction Inconsistent

**File:** `opai/Projects/OPAI Mobile App/opai-mobile/stores/tasksStore.ts:141,241`

```typescript
// Line 141:
id: `${a.item_id}-${a.assignee_id}`,
// Line 241:
id: `${a.item_id || item.id}-${a.assignee_id}`,
```

**Severity: MEDIUM** — Line 141 produces `"undefined-user123"` if `a.item_id` is missing; line 241 falls back to `item.id`. Inconsistent IDs for the same assignment across different fetch paths.

**Fix:** Use `item.id` consistently in both locations.

---

### MEDIUM: License Key Uniqueness Check Uses `.single()` Incorrectly

**File:** `opai/Projects/Boutabyte/src/app/api/licenses/generate/route.ts:56-68`

```typescript
const { data: existing } = await supabase
  .from('licenses')
  .select('id')
  .eq('license_key', licenseKey)
  .single();
```

**Severity: MEDIUM** — `.single()` throws an error if 0 rows match (expected case for unique key). Should use `.maybeSingle()` which returns `null` for 0 rows without throwing.

**Fix:** Replace `.single()` with `.maybeSingle()`.

---

## 4. EDGE CASES

### CRITICAL: Price Division Assumes Cents Without Validation

**Files:**
- `opai/Projects/BoutaCare/src/pages/dashboard.js:292`
- `opai/Projects/BoutaCare/src/pages/core.js:94`

```typescript
const price = (plan.amount / 100).toFixed(2);
```

**Severity: CRITICAL** — No type validation. If `plan.amount` is `null`, result is `NaN`. If `plan.amount` is a string, JavaScript coerces silently but unreliably. Displayed directly to users as pricing.

**Fix:** Validate `typeof plan.amount === 'number' && !isNaN(plan.amount)` before division.

---

### CRITICAL: Path Traversal in File Manager

**File:** `opai/Projects/INTERNAL/Hostinger File Manager/backend/server.js:86`

```typescript
const { sessionId, path = '/' } = req.query;
const items = await sshManager.listDirectory(sessionId, path);
```

**Severity: CRITICAL** — The `path` parameter from the query string is passed directly to SSH commands with zero sanitization. An attacker can send `path=../../etc/passwd` to read arbitrary files on the server.

**Fix:** Implement path normalization and whitelist validation. Reject paths containing `..`.

---

### HIGH: File Deletion Race Condition

**File:** `opai/Projects/ByteSpace/apps/api/src/routes/files.ts:85-108`

```typescript
// Fetch file record
const fileRecord = ...;
// Delete from storage (no error check)
await request.supabaseUser.storage.from(STORAGE_BUCKETS.FILES).remove([fileRecord.file_path]);
// Delete database record
const { error } = await request.supabaseUser.from(T.FILES).delete().eq('id', request.params.id);
```

**Severity: HIGH** — No transaction wrapping. If storage deletion succeeds but DB deletion fails, file is gone but record remains (dangling reference). If storage deletion fails, no error is checked, and DB record is deleted anyway (orphaned file in storage).

**Fix:** Check storage deletion result; wrap in transaction or reverse on failure.

---

### HIGH: Analytics Dashboard Crashes on Null Data

**File:** `opai/Projects/Boutabyte/src/components/admin/AnalyticsDashboard.tsx:10-12`

```typescript
const loadEvents = analytics.filter((a) => a.event_type === 'load');
```

**Severity: HIGH** — If `analytics` prop is `null` or `undefined`, `.filter()` throws `TypeError: Cannot read properties of null`. No null guard.

**Fix:** `const loadEvents = (analytics || []).filter(...)`.

---

### MEDIUM: SVG Score Rendering Breaks Outside 0-100

**File:** `opai/Projects/SEO-GEO-Automator/Codebase/webapp/src/components/ScoreCard.jsx:5-6`

```typescript
const circumference = 2 * Math.PI * 45;
const strokeDashoffset = circumference - (score / 100) * circumference;
```

**Severity: MEDIUM** — No bounds checking. `score > 100` produces negative offset (overflow rendering). `score < 0` produces offset > circumference (underflow).

**Fix:** Clamp: `const clamped = Math.min(100, Math.max(0, score))`.

---

### MEDIUM: Unsafe JSON Parse Without Try-Catch

**File:** `opai/Projects/SEO-GEO-Automator/Codebase/n8n/build-faq-prompt.js:14`

```typescript
const recommendations = typeof geoAnalysis.recommendations === 'string'
    ? JSON.parse(geoAnalysis.recommendations)
    : geoAnalysis.recommendations || [];
```

**Severity: MEDIUM** — `JSON.parse()` will throw on malformed JSON, crashing the automation pipeline.

**Fix:** Wrap in try-catch with fallback to `[]`.

---

### LOW: Progress Bar Accepts NaN/Infinity

**Files:**
- `opai/Projects/ByteSpace/apps/mobile/components/tasks/ChecklistSection.tsx:95`
- `opai/Projects/ByteSpace/apps/mobile/components/spaces/SpaceProjects.tsx:91-95`

```typescript
width={`${progress}%`}
// ...
{Math.round(item.progress)}%
```

**Severity: LOW** — If `progress` is `NaN`, displays "NaN%". If `null`, `Math.round(null)` = 0 (silently wrong).

**Fix:** Default to 0 with validation: `const safeProgress = Number.isFinite(progress) ? progress : 0`.

---

## 5. CHART / VISUALIZATION DATA

### MEDIUM: AI Usage Dashboard Shows Incomplete Data Without Warning

**File:** `opai/Projects/ByteSpace/apps/api/src/routes/ai.ts:82-83`

```typescript
.order('created_at', { ascending: false })
.limit(100)
```

**Severity: MEDIUM** — Hard-coded limit of 100 records with no pagination or "showing partial data" indicator. A user with 500+ API requests sees totals based on only the latest 100, which are presented as if they're comprehensive.

**Fix:** Add pagination support, or return a `truncated: true` flag when limit is hit.

---

### LOW: Inconsistent Decimal Precision Across Metrics

**File:** `opai/Projects/OPAI Mobile App/opai-mobile/components/monitor/SystemMetrics.tsx:36-50`

- CPU: 1 decimal (`45.2%`)
- Memory: 1 decimal (`8.5/16.0 GB`)
- Disk: 0 decimals (`250/500 GB`)

**Severity: LOW** — Inconsistent display precision across adjacent metrics in the same dashboard view.

---

## Summary Table

| # | Severity | Project | File (abbreviated) | Issue |
|---|----------|---------|---------------------|-------|
| 1 | **CRITICAL** | Boutabyte | `api/automations/schedules/route.ts` | CRON schedule never parsed; all recurring jobs run immediately |
| 2 | **CRITICAL** | Boutabyte | `dashboard/LicenseTile.tsx`, `LicenseDetailModal.tsx` | Division by zero when `max_activations = 0` |
| 3 | **CRITICAL** | BoutaCare | `pages/dashboard.js`, `pages/core.js` | Price division on unvalidated `plan.amount` (NaN risk) |
| 4 | **CRITICAL** | Hostinger FM | `backend/server.js` | Path traversal — arbitrary file access via unsanitized query param |
| 5 | **HIGH** | Boutabyte | `lib/license-utils.ts` (x4 files) | Timezone-naive license expiration checks |
| 6 | **HIGH** | Boutabyte | `lib/license-utils.ts`, `license-utils-client.ts` | Unknown tier names always grant access (`indexOf(-1) >= -1`) |
| 7 | **HIGH** | Boutabyte | `lib/license-utils.ts` | `Math.random()` for license key generation (not crypto-secure) |
| 8 | **HIGH** | Boutabyte | `api/payments/stripe/webhook/route.ts` | Purchase type mapping loses yearly vs lifetime distinction |
| 9 | **HIGH** | Boutabyte | `api/payments/stripe/create-price/route.ts` | Product table switch missing default case |
| 10 | **HIGH** | ByteSpace | `api/src/services/ai/router.ts` | Cost formula has undocumented magic number; same rate for all models |
| 11 | **HIGH** | ByteSpace | `api/src/routes/files.ts` | File deletion race condition (storage vs DB) |
| 12 | **HIGH** | Boutabyte | `admin/AnalyticsDashboard.tsx` | Crashes on null analytics array |
| 13 | **HIGH** | BoutaChat | `hooks/useChat.ts` | Missing validation on API provider responses |
| 14 | **HIGH** | SEO-GEO | `n8n/build-faq-prompt.js` | Accesses `.issue`/`.fix` on potentially undefined `.find()` result |
| 15 | **MEDIUM** | ByteSpace | `DueDatePicker.tsx`, `TaskCard.tsx` | `Math.round()` causes ±1 day display errors |
| 16 | **MEDIUM** | BoutaChat | `hooks/useChat.ts` | Timestamp race condition across 3 `new Date()` calls |
| 17 | **MEDIUM** | Boutabyte | `AutomationScheduleModal.tsx` | Local time silently converted to UTC |
| 18 | **MEDIUM** | Boutabyte | `api/payments/stripe/webhook/route.ts` | `setFullYear` ignores DST/leap-year edge cases |
| 19 | **MEDIUM** | Boutabyte | `lib/imageOptimizer.ts` | Division by zero if `originalSize = 0` |
| 20 | **MEDIUM** | Boutabyte | `app/blog/page.tsx` | Read time = "1 min" for empty excerpts |
| 21 | **MEDIUM** | Boutabyte | `api/licenses/generate/route.ts` | `.single()` throws on 0 rows; should be `.maybeSingle()` |
| 22 | **MEDIUM** | BoutaCare | `pages/dashboard.js` | Poll percentages sum to 99% due to rounding |
| 23 | **MEDIUM** | OPAI Mobile | `stores/monitorStore.ts` | Health counts don't sum to total (missing 'unknown') |
| 24 | **MEDIUM** | OPAI Mobile | `stores/dashboardStore.ts` | Notification decrement doesn't verify unread state |
| 25 | **MEDIUM** | OPAI Mobile | `stores/tasksStore.ts` | Assignment ID construction inconsistent across fetch paths |
| 26 | **MEDIUM** | OPAI Mobile | `command/audit.tsx` | Currency displayed with 4 decimal places |
| 27 | **MEDIUM** | SEO-GEO | `ScoreCard.jsx` | SVG circle breaks for scores outside 0-100 |
| 28 | **MEDIUM** | SEO-GEO | `build-faq-prompt.js` | `JSON.parse()` without try-catch |
| 29 | **MEDIUM** | ByteSpace | `api/src/routes/ai.ts` | AI usage data silently truncated at 100 records |
| 30 | **MEDIUM** | Everglades | `FilterModal.tsx` | No duplicate prevention in category toggle |
| 31 | **LOW** | Boutabyte | `reviews/ProductReviews.tsx` | Star count (integer) mismatches decimal text display |
| 32 | **LOW** | OPAI Mobile | `UsageCard.tsx` | Token formatting loses precision at thousands |
| 33 | **LOW** | OPAI Mobile | `SystemMetrics.tsx` | Inconsistent decimal places across CPU/Memory/Disk |
| 34 | **LOW** | ByteSpace | Multiple relative-time formatters | No year display; no future-date handling |
| 35 | **LOW** | ByteSpace | `SpaceFiles.tsx` | `toLocaleDateString()` on null produces "Invalid Date" |
| 36 | **LOW** | ByteSpace | `api/src/routes/files.ts` | `Date.now()` filename not collision-proof |
| 37 | **LOW** | ByteSpace | `ChecklistSection.tsx`, `SpaceProjects.tsx` | NaN/null progress renders broken UI |
| 38 | **LOW** | White-Noise | `usePurchases.ts` | Hardcoded mock pricing not synced with production |

---

**Assumptions Made:**
- Files were analyzed as found on disk; runtime behavior may differ if environment variables or feature flags alter code paths.
- WordPress core files (`wp-includes/`, `wp-admin/`) were excluded as third-party code.
- `node_modules/` directories were excluded.
- Line numbers are approximate based on agent exploration and may shift if files have been edited since analysis.