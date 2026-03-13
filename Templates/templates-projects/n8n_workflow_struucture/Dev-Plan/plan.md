# Workflow Design — [Product Name]

## Product Definition

**What it does**: [One-sentence pitch]

**Who it's for**: [Specific sub-niche]

**Trigger**: [webhook / schedule / manual / event]

**Inputs**: [Data sources, user input, API calls]

**Outputs**: [API response, email, DB write, file, notification]

---

## Workflow Graph

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ Trigger  │────▶│ Process  │────▶│ Decision │────▶│ Output   │
│ (type)   │     │ (step)   │     │ (IF/Sw)  │     │ (action) │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
```

---

## Node Specification

| # | Node Name | Type | Key Parameters | Input | Output |
|---|-----------|------|----------------|-------|--------|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |

---

## Credentials Required

- [ ] [Service] — `ENV_VAR_NAME`

---

## Error Handling

| Error Scenario | Handling |
|---------------|----------|
| API timeout | Retry 3x with backoff |
| Invalid input | Return 400 with error message |
| Auth failure | Log + notify |

---

## Testing Plan

1. Happy path: [describe]
2. Error case: [describe]
3. Edge case: [describe]
