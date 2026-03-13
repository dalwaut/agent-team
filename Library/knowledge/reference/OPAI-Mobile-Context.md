# OPAI Mobile App — Context Document
> For AI assistants and professionals working on OPAI Mobile features.
> Last updated: 2026-02-20

---

## What Is the Mobile App?

The **OPAI Mobile App** is a cross-platform (iOS, Android, Web) admin companion app for the OPAI platform. It provides full-featured access to the OPAI Server at `https://opai.boutabyte.com` via REST APIs and a WebSocket, using Supabase for authentication. It mirrors the capabilities of the web dashboard in a native mobile experience.

**Project location**: `Projects/OPAI Mobile App/opai-mobile/`
**API reference**: `docs/mobile-api-reference.md` (895-line comprehensive reference)

---

## Tech Stack

| Property | Value |
|----------|-------|
| Framework | Expo ~54.0, React Native 0.81.5 |
| Language | TypeScript 5.9 |
| State | Zustand 5.0 |
| Navigation | Expo Router 6.0 (file-based) |
| Auth | Supabase JS SDK 2.49 |
| Bundle ID | `com.boutabyte.opai` |
| Deep link scheme | `opai://` |
| Design | Always dark (bg: `#0a0a0f`) |

---

## Architecture

```
app/
  (auth)/           → Login screen
  (tabs)/
    index           → Home tab
    tasks/          → Task hierarchy (Spaces → Folders → Lists → Items)
    chat/           → AI chat with WebSocket streaming
    monitor/        → System health + metrics
    command/        → Admin hub (admin role only)
  settings          → Modal: profile, prefs, logout
  notifications     → Modal: notification history

stores/
  authStore.ts      → session, profile, login/logout (62 LOC)
  dashboardStore.ts → home data, notifications (64 LOC)
  chatStore.ts      → conversations, messages, WS streaming (164 LOC)
  tasksStore.ts     → workspaces, hierarchy, items, comments (285 LOC)
  commandStore.ts   → squads, runs, HITL, services, registry (218 LOC)
  monitorStore.ts   → health, metrics, Claude usage (146 LOC)

lib/
  api.ts            → REST client (auto Bearer token, 401 refresh+retry)
  supabase.ts       → Supabase client (SecureStore adapter)
  websocket.ts      → ChatWebSocket class (auto-reconnect 3s)

constants/
  config.ts         → All API endpoints + base URLs
  theme.ts          → Design tokens (colors, spacing, fonts, shadows)
  icons.ts          → Tab + item type icon maps

types/
  api.ts            → All TypeScript interfaces (313 LOC, 30+ types)

components/
  ui/               → Shared UI (GlassCard, Button, Input, Badge, Avatar, Toast…)
  dashboard/        → QuickActions, TopItems, Upcoming, Overdue cards
  chat/             → MessageBubble, ChatInput, StreamingIndicator
  tasks/            → TaskListItem, CreateItemSheet, Filters, Pickers
  monitor/          → SystemMetrics, ServiceCard, UsageCard
  command/          → RunCard, SquadCard, HITLCard, PRDSheet
```

---

## Auth Flow

1. App start → `SplashScreen.preventAutoHideAsync()`
2. Load Inter fonts
3. Check existing session: `supabase.auth.getSession()`
4. Subscribe to auth changes: `supabase.auth.onAuthStateChange()`
5. Route guard via `useSegments()`:
   - No session + not in `(auth)` → redirect to `/(auth)`
   - Session + in `(auth)` → redirect to `/(tabs)`
6. Hide splash when fonts loaded + auth resolved

**Token storage**: `expo-secure-store` (native) / `localStorage` (web) via `ExpoSecureStoreAdapter`
**API auth**: Every REST call injects `Authorization: Bearer <access_token>`. On 401, auto-refreshes session and retries.

---

## Screens & Key Features

### Tab 1: Home
- Time-based greeting + notification bell (unread badge)
- Quick Actions row
- Cards: Top Items, Overdue, Upcoming, Workspace Summary
- Pull-to-refresh + skeleton loaders

### Tab 2: Tasks
Hierarchical navigation: **Spaces → Folders → Lists → Items**

| Route | Screen |
|-------|--------|
| `tasks/index` | All workspaces as navigable cards |
| `tasks/space` | Space detail: folders + nested lists |
| `tasks/list` | Items in a list: status filter pills, swipe-to-complete |
| `tasks/create` | Create item: title, description, type/priority pickers |
| `tasks/[id]` | Item detail: comments, status/priority change |

### Tab 3: Chat
- Conversation list with create/delete
- Model picker: Claude Sonnet/Opus, Gemini Flash
- Mozart Mode toggle (musical AI personality, gold styling)
- Real-time streaming via WebSocket

**WebSocket protocol** (`wss://opai.boutabyte.com/ws/chat`):
```
→ Send:    { type: 'auth', token }
→ Send:    { type: 'chat', conversation_id, message, model, mozart_mode? }
← Receive: { type: 'content_delta', text }       — append to stream
← Receive: { type: 'stream_complete', message_id?, usage? }
← Receive: { type: 'error', message }
```

### Tab 4: Monitor
- Claude Usage card (plan quota + today's tokens)
- Health summary banner (healthy/degraded/down counts)
- System metrics: CPU %, Memory GB, Disk GB, Load avg
- Managed services list with start/stop/restart buttons
- Auto-refresh every 30s + pull-to-refresh

### Tab 5: Command (Admin Only — `profile.role === 'admin'`)
8 navigable tiles + PRD Pipeline modal + Quick Links.

| Screen | Purpose |
|--------|---------|
| Squads | List squads, run squad, view active runs + cancel |
| HITL Queue | Pending briefings with priority/source badges |
| HITL Detail | Full briefing markdown + Run/Queue/Reject/Dismiss actions |
| Registry | Server task registry with status filters |
| Feedback | Browse feedback items with expandable cards |
| Audit | Per-run token cost + step-by-step execution trace |
| Logs | System log viewer |
| Users | Team member list + user detail / permissions |
| Agents | Agent directory, run agents individually |

**PRD Pipeline**: Modal JSON editor → `POST n8n.boutabyte.com/webhook/xideas`

---

## Full API Surface

Base URL: `https://opai.boutabyte.com`

| Category | Endpoint | Method |
|----------|----------|--------|
| Dashboard | `/team-hub/api/my/home` | GET |
| | `/team-hub/api/my/notifications` | GET |
| Workspaces | `/team-hub/api/workspaces` | GET |
| | `/team-hub/api/workspaces/{id}/folders` | GET |
| | `/team-hub/api/lists/{id}/items` | GET/POST |
| | `/team-hub/api/items/{id}` | GET/PATCH |
| | `/team-hub/api/items/{id}/comments` | GET/POST |
| Chat | `/chat/api/conversations` | GET/POST |
| | `/chat/api/conversations/{id}/messages` | GET |
| | `/chat/api/models` | GET |
| Monitor | `/monitor/api/health/summary` | GET |
| | `/monitor/api/system/stats` | GET |
| | `/monitor/api/system/services` | GET |
| | `/monitor/api/system/services/{name}/{action}` | POST |
| | `/monitor/api/claude/plan-usage` | GET |
| | `/monitor/api/claude/usage` | GET |
| | `/monitor/api/tasks/registry` | GET |
| | `/monitor/api/logs` | GET |
| Agents | `/agents/api/agents` | GET |
| | `/agents/api/squads` | GET |
| | `/agents/api/run/squad/{name}` | POST |
| | `/agents/api/runs` | GET |
| | `/agents/api/runs/{id}/cancel` | POST |
| HITL | `/tasks/api/hitl` | GET |
| | `/tasks/api/hitl/{filename}/respond` | POST |
| Feedback | `/tasks/api/feedback` | GET |
| | `/api/feedback` | POST |
| Auth | `/api/me/apps` | GET |
| WebSocket | `wss://opai.boutabyte.com/ws/chat` | WS |

---

## Design System

All tokens in `constants/theme.ts`:

| Token | Value |
|-------|-------|
| Background | `#0a0a0f` |
| Card | `#12121a` |
| Accent | `#6c5ce7` |
| Text | `#e0e0e8` |
| Muted | `#8888a0` |
| Success | `#10b981` |
| Error | `#ef4444` |
| Warning | `#fdcb6e` |
| Font | Inter (Regular/Medium/SemiBold/Bold) |

---

## UI Component Library (`components/ui/`)

| Component | Purpose |
|-----------|---------|
| `GlassCard` | Semi-transparent card with border |
| `Button` | Primary action button with loading state |
| `Input` | TextInput with label and error |
| `Badge` | Color-coded status/tag pill |
| `Avatar` | User image with initials fallback |
| `LoadingSkeleton` / `CardSkeleton` | Animated placeholders |
| `EmptyState` | Icon + title + message for empty lists |
| `StatusDot` | Colored circle indicator |
| `PullToRefresh` | RefreshControl wrapper |
| `Toast` / `useToast` | Auto-dismiss notification overlay |

---

## Extensibility

### Add a New Screen
1. Create file under `app/(tabs)/` (Expo Router file-based)
2. Add to `_layout.tsx` if it's a new tab, or navigate via `router.push()`
3. Add types to `types/api.ts`
4. Add endpoint to `constants/config.ts`
5. Call via `lib/api.ts`

### Add a New Zustand Store
1. Create `stores/<name>Store.ts` with `create<State>()((set, get) => ({ ... }))`
2. Define state + actions
3. Import in components via `use<Name>Store()`

### Add a New API Feature
All REST calls go through `lib/api.ts`:
```typescript
import { api } from '@/lib/api'
const data = await api.get('/your-endpoint')
const result = await api.post('/your-endpoint', { key: value })
```

### Key Gotchas
- **Stack.Screen**: Must be direct children of `<Stack>` — no fragment wrappers
- **Expo Router Stack**: Use `useSegments` + `router.replace` for auth routing
- **FlatList keys**: Some API responses may lack unique `id` — use index-based fallback
- **Pre-existing TS errors**: `Avatar.tsx` (ViewStyle vs ImageStyle overflow) and `Input.tsx` (TextStyle vs ViewStyle cursor) — cosmetic, don't affect runtime
- **Mozart mode**: Server sends `content_delta`/`stream_complete` (not `token`/`done`)

---

## Development

```bash
cd "Projects/OPAI Mobile App/opai-mobile"

# Start dev server
npx expo start

# TypeScript check
npx tsc --noEmit

# Run on device
npx expo start --android
npx expo start --ios        # Mac only
```
