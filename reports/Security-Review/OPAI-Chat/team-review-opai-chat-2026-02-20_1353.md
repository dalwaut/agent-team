# Team Review Report: tools/opai-chat
**Date:** 2026-02-20
**Reviewers:** Security · Performance · Architecture (3 parallel agents)
**Files reviewed:** 22 source files
**Total findings:** 59 raw → 49 unique after deduplication

---

## CRITICAL (5)

These require immediate attention — active exploitability or complete auth bypass.

---

### CR-1 — User message injected as raw CLI prompt (Prompt-to-file exfiltration path)
**Dimensions:** Security (C-4)
**File:** `claude_session_manager.py:26-58`

The entire conversation history including the raw user message is concatenated into a single string and passed as a positional arg to `claude --print`. The working directory is `/workspace/synced/opai`. A crafted prompt can instruct Claude CLI to read workspace files and return them in its response — closing a full prompt-injection-to-exfiltration chain.

**Fix:** Separate user content from system context in the CLI invocation. Add server-side injection pattern screening on inbound messages (same patterns already in `file_scanner.py`). Add `MAX_HISTORY_CHARS` truncation in `config.py`.

---

### CR-2 — Model parameter passed to CLI without server-side validation
**Dimensions:** Security (C-5)
**File:** `routes_ws.py:88`, `claude_session_manager.py:43`

The `model` string arrives from the WebSocket client and is passed directly to `--model` in the CLI. An attacker can supply arbitrary strings attempting flag injection.

**Fix (one line):**
```python
VALID_MODELS = {m["id"] for m in config.MODELS}
if model not in VALID_MODELS:
    model = config.DEFAULT_MODEL
```

---

### CR-3 — `fnmatch **` does not match recursively — blocked path patterns silently bypass
**Dimensions:** Security (C-3, M-1)
**File:** `context_resolver.py:33-36`, `config.py:47-57`

`BLOCKED_PATTERNS` includes `notes/Access/**`, `**/credentials*`, `**/secrets*` — but Python's `fnmatch` treats `**` as a literal, not a recursive wildcard. These patterns block nothing. Files in `notes/Access/` are fully readable via `/api/files/read`.

**Fix:** Replace fnmatch glob checks with `Path.is_relative_to()` checks for critical blocked directories:
```python
BLOCKED_DIRS = [config.OPAI_ROOT / "notes" / "Access", ...]
if any(resolved_path.is_relative_to(d) for d in BLOCKED_DIRS):
    return False
```

---

### CR-4 — Wildcard CORS + `allow_credentials=True` (spec-invalid, cross-origin exposure)
**Dimensions:** Security (C-1), Architecture (L-2)
**File:** `app.py:30-36`

`allow_origins=["*"]` with `allow_credentials=True` is rejected by browsers per spec, but the intent signals CORS was not properly configured. All methods and headers are also wildcarded.

**Fix:** Restrict to explicit trusted origins from config:
```python
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "https://opai.boutabyte.com").split(",")
```

---

### CR-5 — `AUTH_DISABLED=1` grants unconditional admin to every request
**Dimensions:** Security (C-2)
**File:** `shared/auth.py:40`

A single env var disables all authentication. If accidentally set in production, every visitor is an admin.

**Fix:** Add startup guard that refuses to run if `AUTH_DISABLED=1` and the host is not localhost. Log a loud warning at every startup when this flag is active.

---

## HIGH (12)

---

### H-1 — Client-supplied attachment paths read without ownership check (Path traversal / IDOR)
**Dimensions:** Security (H-1)
**File:** `routes_ws.py:103-114`

The `attachments` array is fully client-controlled. The server reads `att.get("path")` directly via `Path.read_text()` — no `is_path_allowed()` check, no user ownership verification. Any authenticated user can supply `/workspace/synced/opai/notes/Access/anything` as an attachment path.

**Fix:** Route all attachment reads through `resolver.read_file(att_path)`. Verify path is under `config.USERS_ROOT / user.id`.

---

### H-2 — PATCH and DELETE on conversations have no ownership check (IDOR)
**Dimensions:** Security (H-2), Architecture (M-5)
**File:** `routes_api.py:61-78`

`GET /api/conversations/{id}` checks ownership. `PATCH` and `DELETE` do not. Any authenticated user can modify or delete another user's conversation by guessing the ID (which is low-entropy — see H-3).

**Fix:**
```python
def _assert_ownership(conv, user):
    if conv.user_id and conv.user_id != user.id and not user.is_admin:
        raise HTTPException(status_code=404, detail="Conversation not found")
```
Apply in `update_conversation` and `delete_conversation`.

---

### H-3 — Time-based, low-entropy conversation IDs (enumerable)
**Dimensions:** Security (H-3), Performance (M-9), Architecture (H-4)
**File:** `conversation_store.py:78-79`

IDs use wall-clock time + `id(timestamp) % 10000` (a memory address). Predictable and brute-forceable. Additionally causes silent overwrites under concurrent creation.

**Fix:** `conv_id = f"conv_{uuid.uuid4().hex}"` — one line, solves collision and enumeration.

---

### H-4 — WebSocket disconnect does not kill in-flight subprocess (resource leak)
**Dimensions:** Performance (H-4), Performance (H-3 partly)
**File:** `routes_ws.py:180-218`, `claude_session_manager.py:53`

When a client disconnects mid-stream, the `claude` subprocess continues running. No timeout, no cancellation signal. Under concurrent load, orphaned processes accumulate indefinitely.

**Fix:** Wrap streaming in an `asyncio.Task`; cancel on `WebSocketDisconnect`. Add `asyncio.wait_for(..., timeout=120)` around `process.wait()`. Call `process.kill()` in the finally block.

---

### H-5 — No concurrency limit on subprocess spawning
**Dimensions:** Performance (H-3)
**File:** `claude_session_manager.py:53`

10 simultaneous users = 10 `claude` CLI processes launched, each loading a full Node runtime. No semaphore, no cap.

**Fix:** `_sem = asyncio.Semaphore(4)` at module level. Wrap the subprocess block with `async with _sem:`.

---

### H-6 — Gemini API key passed in URL query string (logged in access logs)
**Dimensions:** Security (H-5)
**File:** `gemini_handler.py:50, 97`

`?key={api_key}` appears in server access logs, browser history, and proxy logs.

**Fix:** Use `X-goog-api-key` request header instead. Two-line change in `gemini_handler.py`.

---

### H-7 — Blocking sync I/O in async route handlers (event loop blocked)
**Dimensions:** Performance (H-1)
**File:** `conversation_store.py` (all methods), `context_resolver.py:56,84`

Every `open()` / `json.load()` / `json.dump()` call blocks the uvicorn event loop. All concurrent WebSocket sessions stall during each disk operation.

**Fix:** Wrap store/resolver I/O with `asyncio.to_thread()`. Most impactful: `save_conversation`, `get_conversation`, `list_conversations`.

---

### H-8 — `list_conversations` reads every file on every request, triggered after every message
**Dimensions:** Performance (H-2), Architecture (M-9)
**File:** `conversation_store.py:21-54`, `chat.js:285`

Every completed message causes the sidebar to reload, which reads and parses every conversation JSON file. With 500 conversations: 500 synchronous file opens per message.

**Fix:** Maintain an in-memory `index.json` updated on create/save/delete. `list_conversations` reads only the index.

---

### H-9 — Raw exception strings forwarded to client (information disclosure)
**Dimensions:** Security (H-4), Architecture (L-3)
**File:** `routes_ws.py:201-208`, `routes_api.py:131,146,160`

`f"Error: {str(e)}"` is sent to the client. Gemini errors include raw API response bodies which may contain account details.

**Fix:** Log full exception server-side. Send generic message to client: `{"type": "error", "message": "An error occurred. Please try again."}`.

---

### H-10 — Race condition on conversation writes (no locking)
**Dimensions:** Architecture (H-5)
**File:** `conversation_store.py:94-149`

Two concurrent `add_message` calls for the same conversation (two browser tabs) both read the same file, append independently, and the second write clobbers the first. Silent message loss.

**Fix:** Per-conversation `asyncio.Lock` keyed by `conversation_id`, held for the full read-mutate-write cycle.

---

### H-11 — `search_files` root not scoped for non-admin users (filesystem enumeration)
**Dimensions:** Security (H-6)
**File:** `routes_api.py:149-160`

Non-admin users can supply `root=/workspace/synced/opai` and enumerate filenames across the entire OPAI workspace.

**Fix:** If `not user.is_admin`, force `root = config.USERS_ROOT / user.id` regardless of client value.

---

### H-12 — God handler in `routes_ws.py` chat branch (123 lines of mixed concerns)
**Dimensions:** Architecture (H-1)
**File:** `routes_ws.py:85-208`

Attachment injection, prompt assembly, provider routing, conversation creation, persistence, and streaming all live in one `elif` block. Any change risks regression across unrelated concerns.

**Fix:** Extract `build_effective_prompt()`, `resolve_provider()`, `ensure_conversation()` into a `ChatOrchestrator` class. Handler becomes: parse → orchestrate → stream.

---

## MEDIUM (17)

| ID | Dim | File | Issue |
|----|-----|------|-------|
| M-1 | Sec | `context_resolver.py:111` | Context cache constant defined, never wired in |
| M-2 | Sec | `routes_ws.py:125` | `preface_prompt` from DB injected without injection scanning |
| M-3 | Sec | `routes_ws.py:53` | No WebSocket message size limit (memory exhaustion) |
| M-4 | Sec | `routes_api.py:257` | Upload filename sanitization incomplete (null bytes, hidden files) |
| M-5 | Sec | All routes | No rate limiting (API cost exhaustion, disk fill) |
| M-6 | Sec | `mozart_prompt.py:17` | Full internal port map + security context injected into LLM |
| M-7 | Perf | `context_resolver.py:89` | `rglob` unbounded sync scan in async route handler |
| M-8 | Perf | `conversation_store.py:140` | Two file round-trips per message (read-write-read-write per turn) |
| M-9 | Perf | `static/js/chat.js:255` | Full Markdown re-render on every streaming chunk (no rAF throttle) |
| M-10 | Perf | `static/js/app.js:525` | Unthrottled `mousemove` listener on `document` for sidebar |
| M-11 | Perf | `routes_api.py:202` | Sync `subprocess.Popen` for email notification in async handler |
| M-12 | Arch | `claude_session_manager.py:26` | History flattened to string, no token/char limit |
| M-13 | Arch | `claude_session_manager.py:58` | `cwd` hardcoded string, duplicates `config.OPAI_ROOT` |
| M-14 | Arch | `tools.js:115` | Dead backend route — tool approval UI silently does nothing |
| M-15 | Arch | `gemini_handler.py:9` | Gemini model name hardcoded, disconnected from model registry |
| M-16 | Arch | `routes_api.py:21` | Extension allowlists duplicated across 3 files, can drift |
| M-17 | Arch | `routes_ws.py:133` | Adding a 3rd AI provider requires editing core dispatch — no provider interface |

---

## LOW (15)

| ID | Dim | File | Issue |
|----|-----|------|-------|
| L-1 | Sec | `app.py:55` | Health endpoint IP check bypassed by reverse proxy |
| L-2 | Sec | `static/js/chat.js:160` | `marked.js` output injected as `innerHTML` without DOMPurify |
| L-3 | Sec | `routes_api.py:94` | Audio MIME type accepted from client without validation |
| L-4 | Perf | `context_resolver.py:77` | Per-item `path.resolve()` syscall in directory listing |
| L-5 | Perf | `static/js/sidebar.js:139` | O(n) title-text match to find sidebar item *(also Arch L-8)* |
| L-6 | Perf | `static/js/canvas.js:17` | `Canvas.items` array grows unboundedly |
| L-7 | Perf | `static/js/app.js:96` | Model dropdown rebuilt on every toggle, leaks event listeners |
| L-8 | Perf | `app.py:39` | No shutdown hook to drain subprocesses on service restart |
| L-9 | Perf/Arch | `routes_ws.py:73` | `conv.dict()` deprecated — use `conv.model_dump()` |
| L-10 | Arch | `requirements.txt` | Unpinned deps (`websockets`, `httpx`, `python-jose>=3.3.0`) |
| L-11 | Arch | `app.py:30` | `@app.on_event("startup")` deprecated since FastAPI 0.93 |
| L-12 | Arch | `mozart_prompt.py:56` | Port numbers + squad counts hardcoded — will go stale |
| L-13 | Arch | `app.js:370` | Inline `onclick` in generated HTML (CSP-incompatible) |
| L-14 | Arch | `config.py:37` | `mkdir` at import time (hidden side effect, breaks tests) |
| L-15 | Arch | Multiple | `datetime.utcnow()` deprecated (Python 3.12+), used in 6+ places |

---

## Consolidated Priority Action Plan

### Do immediately (correctness + active exploitability)
1. **CR-2** — Validate model against allowlist before CLI use. One line.
2. **H-2** — Add `_assert_ownership()` to PATCH and DELETE routes. Two lines each.
3. **H-1** — Route attachment path reads through `resolver.read_file()`.
4. **CR-3** — Fix fnmatch `**` bug — replace with `Path.is_relative_to()` for `notes/Access/`.
5. **H-3** — Replace conversation ID with `uuid.uuid4().hex`.
6. **H-6** — Move Gemini API key from URL query to `X-goog-api-key` header.

### Do this week (stability + resource safety)
7. **H-4 + H-5** — Subprocess timeout, disconnect cancellation, semaphore cap.
8. **H-7** — Wrap store I/O with `asyncio.to_thread()`.
9. **H-8** — In-memory conversation index (eliminates per-request full scan).
10. **H-10** — Per-conversation `asyncio.Lock` on read-modify-write.
11. **H-9** — Sanitize exception messages to client.

### Do this sprint (quality + architecture)
12. **M-6** — Remove internal port map from Mozart system prompt.
13. **M-9** — `requestAnimationFrame` throttle on Markdown re-render.
14. **M-14** — Complete or remove the dead tool approval UI.
15. **L-2** — Add DOMPurify to Markdown rendering pipeline.
16. **CR-4** — Lock down CORS to explicit origin list.

---

## Stats

| Severity | Count |
|----------|-------|
| Critical | 5 |
| High | 12 |
| Medium | 17 |
| Low | 15 |
| **Total** | **49** |

Cross-dimension duplicates removed: 10
(conversation IDs appeared in all 3 reports; ownership checks appeared in 2; exception leaks appeared in 2; sidebar title match appeared in 2)
