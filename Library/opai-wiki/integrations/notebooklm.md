# NotebookLM Integration

> Shared capability for offloading research, analysis, and content generation to Google's NotebookLM (Gemini-powered RAG). Not a standalone service — a shared library consumed by Engine, Brain, and HELM. Reduces Claude CLI token usage ~60-70% on research tasks while gaining new deliverable types (podcasts, study guides, quizzes, slide decks).

**Added:** 2026-03-05 | **Last updated:** 2026-03-06

---

## Architecture

NotebookLM processing is a **shared library** (`tools/shared/nlm.py`), not a dedicated service. No port, no systemd unit, no Caddy route. Every consumer imports the library and calls its functions. Uses the unofficial `notebooklm-py` v0.3.3 async Python API (MIT, 2.9K stars).

```
                                        +-----------------+
                                   +--->| Brain (8101)    |  Research, YouTube, Instagram, AI, Deliverables
                                   |    +-----------------+
+---------------------+            |
| tools/shared/       |            |    +-----------------+
|   nlm.py  (core)    |<-----------+--->| Engine (8080)   |  Admin API, Wiki Sync, Status/Usage
+---------------------+            |    +-----------------+
    ^                              |
    |                              |    +-----------------+
    +--- notebooklm-py             +--->| HELM (8102)     |  Reports, Content, Competitors
         (v0.3.3, async)                +-----------------+
    ^
    |
    +--- Google NotebookLM (Gemini RAG backend, Plus tier)
         500 queries/day, 20 audio/day, 300 sources/notebook
```

### Wrap-and-Fallback Pattern

Every integration point follows the same pattern:

**Pattern 1: RAG-First (for OPAI knowledge queries — preferred)**
```python
try:
    from nlm import is_available, get_client, ask_rag
    if is_available():
        client = await get_client()
        async with client:
            result = await ask_rag(client, question, topic_hint="technical api")
            if result and len(result.get("answer", "")) > 200:
                content = result["answer"]  # Free, grounded in curated knowledge
                source = "notebooklm_rag"
except Exception:
    pass
```

**Pattern 2: Ephemeral Notebook (for external web research or one-off content)**
```python
try:
    from nlm import is_available, get_client, ensure_notebook, ask_notebook
    if is_available():
        client = await get_client()
        async with client:
            nb_id = await ensure_notebook(client, "Research Topic")
            result = await ask_notebook(client, nb_id, question)
            if len(result.get("answer", "")) > 200:
                content = result["answer"]
                source = "notebooklm"
except Exception:
    pass
```

Both fall through to Claude CLI if NLM is unavailable — nothing breaks.

---

## Shared Library — `tools/shared/nlm.py`

~627 lines. Core wrapper around `notebooklm-py` v0.3.3. Follows the same patterns as `tools/shared/youtube.py`.

### Authentication

Three-tier auth discovery:

1. **Environment variable** — `NOTEBOOKLM_AUTH_PATH` (path to storage state JSON)
2. **Disk** — `~/.notebooklm/storage_state.json` (default from `notebooklm login`)
3. **Vault** — `notebooklm-auth-json` credential key

Auth is Playwright browser cookies from a Google login session. The `notebooklm-py` library uses `NotebookLMClient.from_storage(path)` to create an async client.

### Key Functions

| Function | Purpose |
|----------|---------|
| `is_available() -> bool` | Quick check: auth file exists + package importable |
| `get_client()` | Create async client from auth (context manager) |
| `ensure_notebook(client, title, nb_id?)` | Get-or-create notebook by title, returns ID |
| `list_notebooks(client)` | List all notebooks |
| **`ask_rag(client, question, topic_hint)`** | **Smart-route to organized RAG notebook** (primary token saver) |
| `get_rag_notebook_id(topic)` | Get organized notebook ID by topic keyword |
| `get_all_rag_notebooks()` | Get all organized notebook IDs |
| `add_source_text(client, nb_id, title, content)` | Add text source |
| `add_source_url(client, nb_id, url)` | Add web URL source |
| `add_source_youtube(client, nb_id, url)` | Add YouTube URL (native NLM indexing) |
| `add_source_file(client, nb_id, path)` | Add file (PDF, etc.) |
| `ask_notebook(client, nb_id, question)` | Grounded Q&A with citations |
| `generate_audio(client, nb_id, ...)` | Audio overview (podcast-style) |
| `generate_report(client, nb_id, ...)` | Written report / study guide |
| `generate_slide_deck(client, nb_id, ...)` | Slide deck |
| `generate_infographic(client, nb_id, ...)` | Infographic |
| `generate_quiz(client, nb_id)` | Quiz |
| `generate_flashcards(client, nb_id)` | Flashcards |
| `generate_mind_map(client, nb_id)` | Mind map (synchronous, no polling) |
| `research_topic(client, nb_id, query)` | Web/scholar research with source import |
| `get_usage()` | Usage stats (queries/audio used today vs limits) |

### Error Classes

- `NotebookLMError` — base error
- `NotebookLMAuthError` — auth expired or missing
- `NotebookLMRateLimitError` — daily limit reached

### Usage Tracking

JSON file at `tools/opai-engine/data/notebooklm-usage.json`, auto-resets daily:

```json
{
  "date": "2026-03-05",
  "queries_used": 12,
  "queries_limit": 500,
  "audio_used": 1,
  "audio_limit": 20,
  "recent_calls": [...]
}
```

Functions check budget before calling — return gracefully when limits hit.

---

## Engine Integration (Port 8080)

**File:** `tools/opai-engine/routes/notebooklm.py` (~217 lines)

Admin-gated REST API for direct notebook management.

### Routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/notebooklm/status` | Auth status + usage stats |
| `GET` | `/api/notebooklm/notebooks` | List all notebooks |
| `POST` | `/api/notebooklm/notebooks` | Create notebook |
| `POST` | `/api/notebooklm/notebooks/{id}/sources` | Add source (text/url/youtube/file) |
| `POST` | `/api/notebooklm/notebooks/{id}/ask` | Grounded Q&A |
| `POST` | `/api/notebooklm/notebooks/{id}/generate` | Generate artifact |
| **`GET`** | **`/api/notebooklm/rag/notebooks`** | **List organized RAG notebooks + topic keywords** |
| **`POST`** | **`/api/notebooklm/rag/ask`** | **Smart-routed RAG query (auto-selects notebook by topic)** |
| `GET` | `/api/notebooklm/usage` | Detailed usage breakdown |

### Wiki Sync Background Job

**File:** `tools/opai-engine/background/notebooklm_sync.py` (~163 lines)

Daily sync of `Library/opai-wiki/` docs to the "OPAI System Knowledge" notebook:

- Walks wiki directory, compares file timestamps to sync state
- Uploads new/changed `.md` files as text sources
- State tracking: `tools/opai-engine/data/notebooklm-sync-state.json`
- 5-minute startup delay, checks every hour, syncs every 24 hours
- Rate-limit friendly: 2-second pause between uploads

---

## Organized RAG Knowledge Base

**Added:** 2026-03-06

NotebookLM serves as a **free RAG layer** — query it for grounded answers instead of burning Claude tokens. Knowledge is organized into 5 topic-specific notebooks, each loaded with curated sources.

### Notebook Registry

| Notebook | ID | Sources | Query For |
|----------|----|---------|-----------|
| **OPAI System Knowledge** | `a6a01b61` | 60 | Architecture, tools, how everything works (auto-synced from wiki) |
| **Client Portfolio** | `9da52106` | 36 | Client drive files, brand assets, project context, drive structures |
| **Business & HELM** | `66a05943` | 12 | Playbooks, pricing, GEO audit, service delivery, strategy |
| **Technical Reference** | `34e7ff8f` | 16 | Dev commands, APIs, troubleshooting, infra, MCP |
| **Agent Ops** | `fb03cd3a` | 16 | Prompts, agent framework, conventions, fleet ops |

**Total:** 5 notebooks, 140 sources

### Knowledge Loader Script

**File:** `scripts/nlm-knowledge-loader.py`

Bulk loader that creates/updates all organized notebooks. Idempotent — skips unchanged files on re-run.

```bash
# Load/refresh all notebooks
python3 scripts/nlm-knowledge-loader.py

# State tracked at:
# tools/opai-engine/data/nlm-loader-state.json
```

**How it works:**
1. Resolves sources per notebook (explicit paths + glob patterns)
2. Compares file mtimes against loader state — skips unchanged
3. Creates notebook if missing, finds by title if exists
4. Uploads text sources with 2-second rate-limit pause
5. Saves state after each notebook for crash recovery

**Adding new sources:** Edit the `NOTEBOOKS` dict in the script. Each notebook has:
- `sources` — explicit `{path, title}` entries
- `glob_sources` — `{pattern, title_prefix}` for auto-discovery (e.g., all `*-Structure.md` files)

### Query Patterns

**Via RAG API (preferred — auto-routes to best notebook):**
```bash
curl -X POST http://localhost:8080/api/notebooklm/rag/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "What API endpoints does Team Hub expose?", "topic_hint": "technical api"}'
```

**Via specific notebook:**
```bash
curl -X POST http://localhost:8080/api/notebooklm/notebooks/9da52106-.../ask \
  -H "Content-Type: application/json" \
  -d '{"question": "What brand assets does IronBrick have?"}'
```

**Via Telegram:**
```
/rag What services run on port 8080?
/rag tech How does the fleet coordinator work?
/rag business What is the AIOS consulting pricing?
/rag client What drives does IronBrick have?
```

**Via Brain (auto-routes):** Brain research tries organized RAG notebooks first, then ephemeral notebooks with web research, then Claude.

**Via Assembly Pipeline:** PRD and SPEC generation automatically pre-loads context from Technical Reference and Agent Ops RAG notebooks before calling Claude — reducing hallucinated file paths and API endpoints.

**Token savings:** NLM queries are free (Google Gemini backend). Every query that NLM answers is one Claude CLI call avoided. At ~4K tokens/query average, 100 NLM queries/day saves ~400K Claude tokens.

### Sync Strategy

| Source Type | Sync Method | Frequency |
|-------------|-------------|-----------|
| Wiki docs | `notebooklm_sync.py` background job | Daily (auto) |
| Drive structures, knowledge library, playbooks, prompts | `nlm-knowledge-loader.py` | On-demand (manual) |
| YouTube/Instagram content | Brain routes (per-request) | Real-time |
| HELM business data | HELM jobs (competitor research, reports) | Per-job |

---

## Brain Integration (Port 8101)

### Research Pre-Analysis

**File:** `tools/opai-brain/routes/research.py`

```
Step 1:  query → RAG notebooks (curated, grounded) → brain_node  [notebooklm_rag]
Step 2:  query → ephemeral notebook + web research → brain_node   [notebooklm]
Step 3:  query → Claude CLI (180s, heavy) → brain_node            [claude]
```

RAG notebooks are tried first — if the topic maps to an organized notebook (tech, business, agent, client), it returns grounded answers from curated knowledge at zero cost. Web research only runs if RAG misses.

Node metadata includes `"analysis_source": "notebooklm_rag" | "notebooklm" | "claude"` for traceability.

### YouTube Research

**File:** `tools/opai-brain/routes/youtube.py`

NotebookLM natively accepts YouTube URLs — no transcript extraction needed. Both `_run_youtube_research()` and `_run_youtube_rewrite()` try NLM first:

- Research: `add_source_youtube()` + `ask_notebook()` for deep analysis
- Rewrite: NLM pre-analysis enriches theme extraction for Claude content generation

### Instagram Research

**File:** `tools/opai-brain/routes/instagram.py`

Adds reel caption + transcript as text source, uses grounded Q&A for content analysis. Falls back to Claude.

### AI Co-Editor (Summarize)

**File:** `tools/opai-brain/routes/ai.py`

Only the `summarize` action uses NLM — good fit for grounded Q&A. Other actions (`expand`, `rewrite`, `extract_tasks`, `find_related`) stay Claude-only (generative/creative tasks).

### Deliverables Engine

**File:** `tools/opai-brain/routes/notebooklm.py` (~275 lines)

Generate artifacts from brain nodes. Tier-gated (Pro/Ultimate/admin).

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/notebooklm/ask` | Q&A against selected brain nodes |
| `POST` | `/api/notebooklm/generate` | Start artifact generation (returns task_id) |
| `GET` | `/api/notebooklm/generate/{task_id}` | Poll generation status |

**Flow:** Select nodes → create ephemeral notebook → add node contents as text sources → generate artifact → poll until complete.

**Artifact types:** `audio`, `report`, `study_guide`, `quiz`, `flashcards`, `slide_deck`, `mind_map`

**UI:** Brain toolbar has NLM buttons — Podcast, Guide, Quiz, Cards, Slides, Ask. Functions in `app.js`: `nlmGenerate()`, `_pollNlmTask()`, `nlmAsk()`.

---

## HELM Integration (Port 8102)

### Weekly Reports

**File:** `tools/opai-helm/jobs/report_weekly.py`

Two NLM integration points:

1. **Pre-analysis:** Before Claude report generation, NLM analyzes recent actions for trends and anomalies. Injected into `extra_context` so Claude produces a more informed report.
2. **Audio briefing:** After report generation, optionally creates a podcast-style audio overview via `generate_audio()`. Audio path attached to HITL review item.

### Content Generation

**File:** `tools/opai-helm/jobs/content_generate.py`

When `job_config.research_first: true` and a topic is specified, NLM researches the topic first. Research findings injected into `extra_context` for Claude content generation.

### Competitor Research

**File:** `tools/opai-helm/jobs/competitor_research.py` (~132 lines, **new**)

Full NLM-native job — no Claude fallback (competitors without NLM are skipped):

1. Load business profile + competitors list from `helm_businesses` metadata
2. `ensure_notebook(f"HELM Competitors: {biz_name}")` — persistent per-business
3. Add competitor URLs as web sources
4. `research_topic()` for each competitor (NLM web research)
5. `ask_notebook()` for synthesized competitive analysis
6. Save as `helm_business_knowledge` entry + HITL review item

---

## Database

**Migration:** `config/supabase-migrations/045_notebooklm_notebooks.sql`

```sql
notebooklm_notebooks
├── id            uuid PK
├── notebook_id   text UNIQUE      -- NotebookLM notebook ID
├── title         text
├── purpose       text             -- system, research, helm, wiki
├── owner_type    text             -- system, business, user
├── owner_id      text
├── source_count  int
├── last_synced   timestamptz
├── metadata      jsonb
└── created_at    timestamptz
```

RLS: Service role full access. Indexes on `purpose` and `(owner_type, owner_id)`.

### Persistent Notebooks

**RAG Knowledge Base (loaded via `scripts/nlm-knowledge-loader.py`):**

| Notebook | ID | Sources | Owner |
|----------|----|---------|-------|
| "OPAI System Knowledge" | `a6a01b61` | 60 wiki docs | system |
| "Client Portfolio — Drive & Project Files" | `9da52106` | 36 drive structures | system |
| "Business & HELM — Playbooks & Strategy" | `66a05943` | 12 playbooks + refs | system |
| "Technical Reference — Dev & API Docs" | `34e7ff8f` | 16 dev/API/infra docs | system |
| "Agent Ops — Prompts, Framework & Conventions" | `fb03cd3a` | 16 prompts + framework | system |

**Dynamic Notebooks (created on demand by tools):**

| Notebook | Purpose | Owner |
|----------|---------|-------|
| "OPAI Research" | Brain research sessions | system |
| "YouTube Research" | YouTube video analysis | system |
| "Instagram Research" | Instagram reel analysis | system |
| "Brain Summarize" | AI summarize action | system |
| "HELM: {BusinessName}" | Per-business knowledge | business |
| "HELM Competitors: {BusinessName}" | Competitor research | business |
| "Brain: {NodeTitles}" | Ephemeral deliverable notebooks | user |

---

## Setup & Authentication

### Initial Setup

```bash
# 1. Install package
pip install "notebooklm-py[browser]" --break-system-packages
playwright install chromium

# 2. Login (opens browser for Google OAuth)
notebooklm login
# Sign in → wait for notebooklm.google.com homepage → press ENTER

# 3. Verify
notebooklm auth check --test

# 4. Check via Engine API
curl http://localhost:8080/api/notebooklm/status
# → {"available": true, "usage": {...}}
```

### Re-authentication

If auth expires (cookies typically last weeks):

```bash
rm -rf ~/.notebooklm/storage_state.json ~/.notebooklm/browser_profile
notebooklm login
```

**Critical:** Browser must be on `notebooklm.google.com` when pressing Enter. If redirected to YouTube during OAuth, cookies get wrong domain scope and API calls fail.

---

## File Inventory

### New Files (8)

| File | Lines | Purpose |
|------|-------|---------|
| `tools/shared/nlm.py` | ~627 | Core shared library |
| `tools/opai-engine/routes/notebooklm.py` | ~217 | Engine management API |
| `tools/opai-engine/background/notebooklm_sync.py` | ~163 | Wiki sync background job |
| `tools/opai-brain/routes/notebooklm.py` | ~275 | Brain deliverables routes |
| `tools/opai-helm/jobs/competitor_research.py` | ~132 | HELM competitor research |
| `config/supabase-migrations/045_notebooklm_notebooks.sql` | ~31 | Notebook registry table |
| `scripts/nlm-knowledge-loader.py` | ~230 | Bulk notebook loader (organized RAG) |
| `tools/opai-engine/data/nlm-loader-state.json` | — | Loader state (tracks uploaded sources) |

### Modified Files (9)

| File | Change |
|------|--------|
| `tools/opai-engine/app.py` | Mount NLM router + wiki sync bg task |
| `tools/opai-brain/app.py` | Mount NLM deliverables router |
| `tools/opai-brain/routes/research.py` | NLM pre-research with Claude fallback |
| `tools/opai-brain/routes/youtube.py` | NLM YouTube source with fallback |
| `tools/opai-brain/routes/ai.py` | NLM for summarize action |
| `tools/opai-brain/routes/instagram.py` | NLM for research with fallback |
| `tools/opai-brain/static/app.js` | Deliverables UI (buttons + polling) |
| `tools/opai-helm/jobs/report_weekly.py` | Pre-analysis + audio briefing |
| `tools/opai-helm/jobs/content_generate.py` | Optional topic research |

---

## Gotchas

| Issue | Solution |
|-------|----------|
| Module name collision | Shared library is `nlm.py`, NOT `notebooklm.py` — the latter shadows the installed `notebooklm` package |
| Cookie domain scoping | Login must capture cookies while on `notebooklm.google.com`, not YouTube |
| `AskResult` fields | Uses `.answer` (not `.text`), `.conversation_id`, `.references` |
| `generate_mind_map()` | Returns dict directly — no polling needed (unlike all other generators) |
| Self-hosted Supabase | Run migrations via `psql -h localhost -p 54322 -U postgres` (not `supabase-sql.sh` which needs `.env`) |
| Rate limits | 500 queries/day, 20 audio/day. Functions check budget before calling |
| Unofficial API | `notebooklm-py` is community-maintained. Every call has try/except fallback |

---

## Dependencies

- `notebooklm-py>=0.3.3` (pip, unofficial async API, MIT license)
- `playwright` + chromium (for browser-based auth)
- Google Workspace account (Plus tier for full limits)
