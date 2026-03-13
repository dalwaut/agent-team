# Instagram Scraper

> Shared capability for scraping, analyzing, and processing Instagram reels across OPAI. Like YouTube Transcriber — a shared library consumed by Telegram, Brain, and Claude Code (MCP). Three modes: **Build** (tutorial extraction), **Intel** (content strategy analysis), and **Visual Analysis** (Playwright browser scrubbing for object identification + materials breakdown).

**Added:** 2026-03-02 | **Last updated:** 2026-03-03

---

## Architecture

Instagram processing is a **shared library** (`tools/shared/instagram.py` + `tools/shared/instagram.js`), not a dedicated service. No port, no systemd unit. Every consumer imports the library and calls its functions.

```
                                        +-----------------+
                                   +--->| Brain (8101)    |  POST /brain/api/instagram/save
                                   |    |                 |  POST /brain/api/instagram/research
                                   |    |                 |  POST /brain/api/instagram/rewrite
                                   |    +-----------------+
+---------------------+            |
| tools/shared/       |            |    +-----------------+
|   instagram.py (core|<-----------+--->| Telegram (8110) |  Auto-detect URL, action buttons
|   instagram.js (node)|           |    +-----------------+
+---------------------+            |
    ^                              |
    |                              |
    +--- Claude Code (MCP: mcps/instagram-scraper/server.py — in-house FastMCP)
    |                                   ↕ metadata + transcript
    |
    +--- Claude Code (Playwright MCP — Visual Analysis mode)
                                        ↕ browser_navigate → JS video scrub →
                                          browser_take_screenshot → visual analysis
```

### Data Flow

1. **URL detection** — regex matches `instagram.com/reel/`, `/reels/`, `/p/`, `/tv/`
2. **Metadata** — Multi-provider:
   - **Primary:** Bright Data Social Media API (rich: likes, views, comments, shares, hashtags, music)
   - **Fallback:** yt-dlp `--dump-json` (basic: author, caption, duration)
3. **Transcript** — Supadata API (shared 100/month pool with YouTube)
4. **Frames** — yt-dlp download → ffmpeg frame extraction (evenly-spaced JPEGs)
5. **Analysis** — Claude CLI (Vision for Build mode, text-only for Intel mode)

### Three Analysis Modes

| Mode | Trigger | What it does | Cost |
|------|---------|-------------|------|
| **Intel** | Default, text button | Transcript + metadata → content strategy JSON | Low (text Claude) |
| **Build** | Explicit button tap | Download + frames + Vision → build guide JSON | High (Vision + download) |
| **Visual Analysis** | Claude Code interactive session | Playwright browser scrubbing → screenshot frames → object ID + materials list | Free (local browser) |

---

## Core Library: `tools/shared/instagram.py`

### Functions

| Function | Purpose |
|----------|---------|
| `extract_shortcode(url)` | Parse shortcode from any IG URL format |
| `is_instagram_url(text)` | Quick check if text contains an IG URL |
| `extract_instagram_url(text)` | Extract first IG URL from text |
| `fetch_transcript(url)` | Supadata API transcript (shared pool with YouTube) |
| `fetch_metadata(url)` | Bright Data (primary) → yt-dlp (fallback) metadata |
| `download_video(url, output_dir)` | yt-dlp download to temp dir |
| `extract_frames(video_path, count, output_dir)` | ffmpeg evenly-spaced JPEG frames |
| `frames_to_base64(frame_paths)` | Convert frames to base64 for API transport |
| `analyze_frames_vision(frames, transcript, mode, metadata)` | Claude CLI Vision analysis |
| `analyze_intel_text(transcript, metadata)` | Text-only intel analysis (no frames) |
| `process_reel(url, mode, include_frames, frame_count)` | Combined pipeline |
| `truncate_transcript(text, max_chars)` | Re-export from youtube.py |

### CLI Usage

```bash
# Intel mode (default — metadata + transcript + text analysis)
python3 tools/shared/instagram.py https://www.instagram.com/reel/XXXXX/

# Build mode with frames (downloads video, extracts frames, Vision analysis)
python3 tools/shared/instagram.py https://www.instagram.com/reel/XXXXX/ --mode build --frames

# Metadata only (fast)
python3 tools/shared/instagram.py https://www.instagram.com/reel/XXXXX/ --metadata-only
```

### Node.js Wrapper: `tools/shared/instagram.js`

```javascript
const { isInstagramUrl, extractInstagramUrl, processInstagramUrl } = require('../shared/instagram');

// Check URL
if (isInstagramUrl(message)) { ... }

// Process reel
const result = await processInstagramUrl(url, { mode: 'intel' });
const buildGuide = await processInstagramUrl(url, { mode: 'build', frames: true });
```

---

## MCP Server: `mcps/instagram-scraper/server.py`

FastMCP server registered in `.mcp.json`. Data-only tools (no nested Claude calls).

| Tool | Returns |
|------|---------|
| `get_reel_transcript(url)` | Transcript text + metadata |
| `get_reel_metadata(url)` | Caption, author, hashtags, duration, engagement |
| `get_reel_frames(url, count)` | Base64 JPEG frames + transcript |
| `search_reel_transcript(url, query)` | Keyword search across transcript segments |

---

## Integrations

### Telegram (`tools/opai-telegram/`)

- **Detection**: `IG_REGEX` in `handlers/messages.js` — auto-detects Instagram URLs
- **Action Buttons**: Inline keyboard with 4 actions:
  - **Build Guide** (`ig:build:shortcode`) — heavy: download + frames + Vision
  - **Intel Report** (`ig:intel:shortcode`) — light: text analysis
  - **Save to Brain** (`ig:save:shortcode`) — persist as brain node
  - **Research** (`ig:research:shortcode`) — deep Claude research
- **Cache**: `reelCache` (Map, 1hr TTL) in `handlers/callbacks.js`

### Brain (`tools/opai-brain/routes/instagram.py`)

| Endpoint | Purpose | Background? |
|----------|---------|-------------|
| `POST /api/instagram/save` | Save reel as brain node | No |
| `POST /api/instagram/research` | Deep research session | Yes |
| `POST /api/instagram/rewrite` | Content pack (reel script, carousel, blog, social) | Yes |

Node structure: `type: "note"`, tags: `["instagram", "reel", ...hashtags]`

---

## Shared Resources

### Supadata API (Transcript Provider)

Shared 100/month pool with YouTube. Tracked in `tools/opai-engine/data/supadata-usage.json` with per-source attribution.

```python
# Extracted into tools/shared/supadata.py
from supadata import get_supadata_usage, fetch_transcript_supadata
```

### Bright Data API (Metadata Provider)

Optional — provides rich engagement data (likes, views, comments, shares, music, hashtags). Token stored in Vault as `BRIGHTDATA_API_TOKEN`. Falls back to yt-dlp if unavailable.

---

## Dependencies

| Dependency | Purpose | Install |
|------------|---------|---------|
| `yt-dlp` | Video download + fallback metadata | `pip install yt-dlp` |
| `ffmpeg` | Frame extraction | `sudo apt install ffmpeg` |
| `httpx` | Async HTTP (Bright Data, Supadata) | Already in shared deps |
| `mcp` | FastMCP server | Already installed for YouTube MCP |

---

## Visual Analysis via Playwright (Claude Code Interactive)

> **Added 2026-03-03.** Most reliable method for extracting visual details from Instagram videos. Bypasses all API/download restrictions by using the browser directly.

### Why This Exists

- MCP `get_reel_frames` is unreliable (Instagram blocks video downloads frequently)
- Reel audio is often just background music — transcripts yield no useful content
- The actual value (product details, costs, build specs) is in **text overlays on video frames** and **visual inspection of objects**
- Playwright can directly control the `<video>` element via JS — seek, pause, screenshot

### Workflow

```
1. MCP metadata/transcript (parallel)     ← context: caption, hashtags, engagement
         │
2. Playwright browser_navigate(url)        ← load the Instagram post page
         │
3. Close login dialog                      ← Instagram shows signup prompt for logged-out
         │
4. Get video duration via JS               ← document.querySelector('video').duration
         │
5. Scrub to 6-8 timestamps, screenshot     ← video.currentTime = N; video.pause();
   each:                                      wait 1s; browser_take_screenshot()
   ┌──────────────────────────────────┐
   │  0s  — opening (object intro)    │
   │  3s  — establishing shot         │
   │  5s  — early detail              │
   │  8s  — close-up / specs          │
   │  12s — mid-video detail          │
   │  16s — summary / totals          │
   │  20s — event / context shot      │
   │  24s — closing / CTA             │
   └──────────────────────────────────┘
         │
6. Analyze screenshots visually            ← identify objects, materials, dimensions,
                                              text overlays (costs, specs, brand names)
         │
7. Compile materials/build list            ← structured output: materials table,
                                              dimensions, tools, steps, cost breakdown
```

### Key JavaScript for Video Scrubbing

```javascript
// Get video duration
() => {
  const v = document.querySelector('video');
  return v ? v.duration : 'no video';
}

// Seek to specific timestamp
() => {
  const v = document.querySelector('video');
  v.currentTime = 8;  // seconds
  v.pause();
  return 'Set to 8s';
}
```

### Instagram Login Wall Handling

Instagram shows a modal dialog for logged-out users. Steps:
1. After `browser_navigate`, take a snapshot
2. Find the "Close" button on the dialog (`button "Close"`)
3. `browser_click` on the close button
4. Page now shows the post with the video playing

### What to Extract from Screenshots

| Element | Where to Look |
|---------|---------------|
| **Text overlays** | Bold text on video frames — costs, specs, dimensions, brand names |
| **Object structure** | Shape, material, finish, color visible in frames |
| **Dimensions** | Relative to people or known objects in frame |
| **Components** | Embedded parts (pans, inserts, hardware, accessories) |
| **Setup/assembly** | Early frames often show assembly or transport |
| **In-use context** | Later frames show the finished product at events |

### Bonus: Related Posts Metadata

After closing the login dialog, the page snapshot includes **"More posts from"** section with alt-text from related posts. These captions often contain additional details (exact costs, measurements, tips) that supplement the video being analyzed.

### Example Output

Given a video URL, this workflow produces:
- Object identification (what it is, how it's built)
- Materials list with estimated costs
- Dimensions (estimated from visual context)
- Tools needed for construction
- Step-by-step build instructions
- ASCII blueprint/diagram if applicable
- Business model details (if shown in video)

### When to Use Visual Analysis vs Build Mode

| Scenario | Use |
|----------|-----|
| Need to identify a physical object / product in a video | **Visual Analysis** (Playwright) |
| Want a general tutorial summary from a how-to reel | **Build** (MCP frames + Vision) |
| Content strategy / engagement analysis | **Intel** (text-only) |
| MCP frame extraction fails | **Visual Analysis** (Playwright fallback) |

### Persistence

Workflow documented in Claude Code memory: `memory/media-analysis-workflow.md`
Convention registered in `memory/MEMORY.md` for auto-use in future sessions.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Instagram blocks yt-dlp | Metadata falls back to empty; transcript still tries Supadata |
| No Bright Data token | Silent skip, uses yt-dlp fallback |
| Supadata pool exhausted | Warning at 80%; degrades to metadata-only |
| Video > 10 min | Frame extraction skipped (cost protection) |
| Video download fails | Analysis returns `{"error": "Video download failed"}` |
| Temp files | Auto-cleaned via `_temp_workspace()` context manager |

---

## File Map

| File | Purpose |
|------|---------|
| `tools/shared/instagram.py` | Core library — all scraping/analysis logic |
| `tools/shared/instagram.js` | Node.js wrapper (Telegram) |
| `tools/shared/supadata.py` | Shared Supadata API utilities |
| `mcps/instagram-scraper/server.py` | MCP server for Claude Code |
| `tools/opai-brain/routes/instagram.py` | Brain integration routes |
| `tools/opai-telegram/handlers/messages.js` | URL detection |
| `tools/opai-telegram/handlers/callbacks.js` | Action button callbacks |
