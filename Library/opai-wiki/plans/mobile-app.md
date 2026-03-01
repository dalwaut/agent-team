# OPAI Mobile App
> Last updated: 2026-02-20 | Source: `Projects/OPAI Mobile App/opai-mobile/`

> React Native / Expo admin companion app. Full-featured mobile interface to the OPAI platform — dashboard, tasks, chat, monitoring, and admin command center.

## Overview

The OPAI Mobile App is a cross-platform (iOS, Android, Web) application built with Expo and React Native. It connects to the OPAI Server at `opai.boutabyte.com` via REST APIs and WebSocket, using Supabase for auth. It provides the same capabilities as the web dashboard in a native mobile experience.

**Key stats**: ~50 screens/components, 6 Zustand stores, 939 LOC state management, 3,166 LOC components.

| Property | Value |
|----------|-------|
| Framework | Expo ~54.0, React Native 0.81.5 |
| Language | TypeScript 5.9 |
| State | Zustand 5.0 |
| Navigation | Expo Router 6.0 (file-based) |
| Auth | Supabase JS SDK 2.49 |
| Bundle ID | `com.boutabyte.opai` |
| Scheme | `opai://` |
| Dark mode | Always (bg: `#0a0a0f`) |

---

## Architecture

```
┌─ App (Expo / React Native)
│
├─ Routes (File-based, Expo Router)
│  ├─ (auth)/       → Login
│  ├─ (tabs)/       → 5 tabs: Home, Tasks, Chat, Monitor, Command
│  ├─ settings      → Modal: profile, prefs, logout
│  └─ notifications → Modal: notification history
│
├─ Stores (Zustand)
│  ├─ authStore      → session, profile, login/logout
│  ├─ dashboardStore → home data, notifications
│  ├─ chatStore      → conversations, messages, WS streaming
│  ├─ tasksStore     → workspaces, items, hierarchy, comments
│  ├─ commandStore   → squads, runs, HITL, services, registry
│  └─ monitorStore   → health, metrics, Claude usage
│
├─ Components
│  ├─ ui/        → GlassCard, Button, Input, Badge, Avatar, Toast, etc.
│  ├─ dashboard/ → QuickActions, TopItems, Upcoming, Overdue cards
│  ├─ chat/      → MessageBubble, ChatInput, StreamingIndicator
│  ├─ tasks/     → TaskListItem, CreateItemSheet, Filters, Pickers
│  ├─ monitor/   → SystemMetrics, ServiceCard, UsageCard
│  └─ command/   → RunCard, SquadCard, HITLCard, PRDSheet
│
├─ Lib (Services)
│  ├─ api.ts       → REST client, auto Bearer token, 401 refresh
│  ├─ supabase.ts  → Supabase client (SecureStore adapter)
│  ├─ storage.ts   → expo-secure-store (native) / localStorage (web)
│  └─ websocket.ts → ChatWebSocket class, auto-reconnect
│
├─ Constants
│  ├─ config.ts → API endpoints, Supabase URL, WS URL
│  ├─ theme.ts  → colors, spacing, fonts, shadows
│  └─ icons.ts  → tab + item type icon maps
│
├─ Types
│  └─ api.ts → All TS interfaces (30+ types)
│
└─ Hooks
   ├─ useNotifications → Supabase Realtime subscription
   └─ useRefresh       → Pull-to-refresh helper
```

---

## Key Files

| File | Purpose |
|------|---------|
| `app/_layout.tsx` | Root layout: font loading, auth listener, session routing |
| `app/(tabs)/_layout.tsx` | 5-tab navigator (Command tab admin-gated) |
| `stores/tasksStore.ts` | Largest store (285 LOC): flat items + Space→Folder→List hierarchy |
| `stores/commandStore.ts` | Admin store (218 LOC): squads, runs, HITL, services, registry |
| `stores/chatStore.ts` | Chat store (164 LOC): WS streaming, conversations, models |
| `lib/api.ts` | REST client: auto Bearer token injection, 401 refresh+retry |
| `lib/websocket.ts` | ChatWebSocket: connect, send, subscribe, auto-reconnect (3s) |
| `types/api.ts` | All TypeScript interfaces (313 LOC, 30+ types) |
| `constants/config.ts` | All API endpoints + base URLs |
| `constants/theme.ts` | Design tokens: colors, spacing, fonts, shadows |

---

## Screens & Routes

### Tab 1: Home (`/(tabs)/index`)
- Time-based greeting + user name
- Notification bell (unread badge) + settings avatar
- Quick Actions row
- Cards: Top Items, Overdue, Upcoming, Workspace Summary
- Pull-to-refresh, skeleton loaders

### Tab 2: Tasks (`/(tabs)/tasks/`)
Hierarchical navigation: **Spaces → Folders → Lists → Items**

| Route | Screen | Description |
|-------|--------|-------------|
| `tasks/index` | Spaces list | All workspaces as navigable cards with emoji icons |
| `tasks/space` | Space detail | Expandable folders with nested lists, folderless lists section |
| `tasks/list` | List items | Items in a list with status filter pills, swipe-to-complete |
| `tasks/create` | Create item | Title, description, type/priority pickers for a specific list |
| `tasks/[id]` | Item detail | Full item view with comments, status/priority change |

**Store hierarchy methods**: `fetchSpaces()` → `fetchSpaceDetail(wsId)` → `fetchListItems(listId, status?)` → `createItemInList(listId, data)`

**API endpoints used**:
- `GET /team-hub/api/workspaces` — all spaces
- `GET /team-hub/api/workspaces/{id}/folders` — folders + lists with task counts
- `GET /team-hub/api/lists/{id}/items` — items in a list (with statuses array)
- `POST /team-hub/api/lists/{id}/items` — create item in list

### Tab 3: Chat (`/(tabs)/chat/`)
- Conversation list with create/delete
- Model picker (Claude Sonnet/Opus, Gemini Flash)
- Mozart Mode toggle (musical AI personality, gold styling)
- Real-time streaming via WebSocket
- Command palette: `-status`, `-squad run <name>`, `-ClaudeCode Launch`

**WebSocket protocol**:
- Connect to `wss://opai.boutabyte.com/ws/chat`
- Send `{ type: 'auth', token }` on open
- Send `{ type: 'chat', conversation_id, message, model, mozart_mode? }`
- Receive `{ type: 'content_delta', text }` — append to stream
- Receive `{ type: 'stream_complete', message_id?, usage? }` — finalize message
- Receive `{ type: 'error', message }` — show error
- Auto-reconnect on disconnect (3s delay)

### Tab 4: Monitor (`/(tabs)/monitor`)
- Claude Usage card (plan quota + today's tokens)
- Health summary banner (healthy/degraded/down counts)
- System metrics (CPU %, Memory GB, Disk GB, Load avg)
- Managed services list with start/stop/restart buttons
- Auto-refresh every 30s + pull-to-refresh

### Tab 5: Command (`/(tabs)/command/`) — Admin Only
Admin hub with 8 navigable tiles + PRD Pipeline + Quick Links.

| Route | Screen | Description |
|-------|--------|-------------|
| `command/index` | Hub | 8 tiles with live count badges, PRD modal, external links |
| `command/squads` | Squads | Squad list, "Run" button, active runs with cancel |
| `command/hitl` | HITL Queue | Pending briefings with priority/source badges |
| `command/hitl-detail` | HITL Detail | Full briefing markdown + Run/Queue/Reject/Dismiss actions |
| `command/registry` | Registry | Server task registry with status filters |
| `command/feedback` | Feedback | Browse feedback with status filter pills, expandable cards |
| `command/audit` | Audit | Per-run token cost + step trace |
| `command/logs` | Logs | System log viewer |
| `command/users` | Users | Team member list |
| `command/user-detail` | User Detail | Profile + permissions |
| `command/agents` | Agents | Agent directory, run individually |

**PRD Pipeline**: Modal JSON editor submitting to `POST https://n8n.boutabyte.com/webhook/xideas`. Expected fields: `title`, `painPoint`, `reasoning`, `solution`, `productDescription`, `coreMagic`, `mvpScope`, `techStackRecommendations`, etc.

---

## Stores Detail

### authStore (62 LOC)
| State | Type | Description |
|-------|------|-------------|
| `session` | Session \| null | Supabase JWT session |
| `profile` | Profile \| null | User profile from DB |
| `loading` | boolean | Auth in progress |

Actions: `setSession()`, `fetchProfile()`, `login(email, pw)`, `logout()`

### dashboardStore (64 LOC)
| State | Type | Description |
|-------|------|-------------|
| `homeData` | HomeData \| null | Dashboard aggregation |
| `notifications` | Notification[] | User notifications |

Actions: `fetchHome()`, `fetchNotifications()`, `markNotificationAsRead()`, `searchProfiles()`, `searchWorkspaces()`

### chatStore (164 LOC)
| State | Type | Description |
|-------|------|-------------|
| `conversations` | Conversation[] | Chat history |
| `currentConversation` | Conversation \| null | Active chat |
| `messages` | Message[] | Current thread |
| `models` | ChatModel[] | Available AI models |
| `selectedModel` | string | Active model (default: 'sonnet') |
| `mozartMode` | boolean | Musical AI personality toggle |
| `streaming` | boolean | WS stream in progress |
| `streamContent` | string | Accumulating stream text |

Actions: `fetchConversations()`, `createConversation()`, `deleteConversation()`, `selectConversation()`, `fetchMessages()`, `sendMessage()`, `fetchModels()`, `setModel()`, `toggleMozart()`, `connectWS()`, `disconnectWS()`

### tasksStore (285 LOC)
| State | Type | Description |
|-------|------|-------------|
| `workspaces` | Workspace[] | All workspaces |
| `items` | WorkspaceItem[] | Flat item list (legacy) |
| `spaces` | Workspace[] | Hierarchy: spaces |
| `spaceDetail` | SpaceDetail \| null | Folders + lists for a space |
| `listDetail` | ListDetail \| null | Items + statuses for a list |
| `currentItem` | WorkspaceItem \| null | Selected item detail |
| `comments` | Comment[] | Item comments |
| `filters` | ItemFilters | Active filters |

**Flat actions** (legacy): `fetchWorkspaces()`, `fetchAllItems()`, `setActiveWorkspace()`, `setFilters()`, `createItem()`, `updateItem()`

**Hierarchy actions**: `fetchSpaces()`, `fetchSpaceDetail(wsId)`, `fetchListItems(listId, status?)`, `createItemInList(listId, data)`

**Comment actions**: `fetchComments(itemId)`, `addComment(itemId, content)`

### commandStore (218 LOC)
| State | Type | Description |
|-------|------|-------------|
| `squads` | Record<string, Squad> | Available squads |
| `activeRuns` | AgentRun[] | Currently running |
| `runHistory` | AgentRun[] | Past executions |
| `hitlItems` | HITLItem[] | Pending approvals |
| `services` | ManagedService[] | Systemd services |
| `registryTasks` | RegistryTask[] | Task registry |

Actions: `fetchSquads()`, `runSquad(name)`, `cancelRun(id)`, `fetchRuns()`, `fetchHITL()`, `enrichHITLItem()`, `respondHITL(filename, action, notes)`, `fetchServices()`, `controlService(name, action)`, `fetchRegistryTasks()`, `fetchAllCounts()`

### monitorStore (146 LOC)
| State | Type | Description |
|-------|------|-------------|
| `health` | HealthSummary \| null | Service health rollup |
| `metrics` | SystemMetrics \| null | CPU/memory/disk |
| `planUsage` | PlanUsage \| null | Claude plan quotas |
| `liveUsage` | LiveUsage \| null | Today's token usage |

Actions: `fetchHealth()`, `fetchMetrics()`, `fetchUsage()`, `fetchAll()`

---

## API Endpoints

All calls go through `lib/api.ts` which injects `Authorization: Bearer <supabase_token>` and handles 401 refresh.

**Base URL**: `https://opai.boutabyte.com`

| Category | Endpoint | Method | Used By |
|----------|----------|--------|---------|
| **Dashboard** | `/team-hub/api/my/home` | GET | dashboardStore |
| | `/team-hub/api/my/notifications` | GET | dashboardStore |
| | `/team-hub/api/my/all-items` | GET | tasksStore (flat) |
| **Workspaces** | `/team-hub/api/workspaces` | GET | tasksStore |
| | `/team-hub/api/workspaces/{id}/folders` | GET | tasksStore (hierarchy) |
| | `/team-hub/api/lists/{id}/items` | GET/POST | tasksStore (hierarchy) |
| | `/team-hub/api/items/{id}` | GET/PATCH | tasksStore |
| | `/team-hub/api/items/{id}/comments` | GET/POST | tasksStore |
| **Chat** | `/chat/api/conversations` | GET/POST | chatStore |
| | `/chat/api/conversations/{id}/messages` | GET | chatStore |
| | `/chat/api/models` | GET | chatStore |
| **Monitor** | `/monitor/api/health/summary` | GET | monitorStore |
| | `/monitor/api/system/stats` | GET | monitorStore |
| | `/monitor/api/system/services` | GET | commandStore |
| | `/monitor/api/system/services/{name}/{action}` | POST | commandStore |
| | `/monitor/api/claude/plan-usage` | GET | monitorStore |
| | `/monitor/api/claude/usage` | GET | monitorStore |
| | `/monitor/api/tasks/registry` | GET | commandStore |
| | `/monitor/api/logs` | GET | commandStore |
| **Agents** | `/agents/api/agents` | GET | commandStore |
| | `/agents/api/squads` | GET | commandStore |
| | `/agents/api/run/squad/{name}` | POST | commandStore |
| | `/agents/api/runs` | GET | commandStore |
| | `/agents/api/runs/{id}/cancel` | POST | commandStore |
| **HITL** | `/tasks/api/hitl` | GET | commandStore |
| | `/tasks/api/hitl/{filename}/respond` | POST | commandStore |
| **Feedback** | `/tasks/api/feedback` | GET | feedback screen |
| | `/api/feedback` | POST | FeedbackSheet |
| **Auth** | `/api/me/apps` | GET | auth gating |
| | `/team-hub/api/profiles` | GET | user management |
| **External** | `n8n.boutabyte.com/webhook/xideas` | POST | PRDSheet |
| **WebSocket** | `wss://opai.boutabyte.com/ws/chat` | WS | chatStore |

---

## UI Component Library

All in `components/ui/`, exported via barrel `index.ts`.

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
| `Toast` / `useToast` | Auto-dismiss notification overlay (Zustand store) |

---

## Design System

From `constants/theme.ts`:

| Token | Values |
|-------|--------|
| **Colors** | bg: `#0a0a0f`, card: `#12121a`, accent: `#6c5ce7`, text: `#e0e0e8`, muted: `#8888a0` |
| **Status** | success: `#10b981`, error: `#ef4444`, warning: `#fdcb6e`, info: `#3b82f6` |
| **Spacing** | xs(4) sm(8) md(12) lg(16) xl(20) xxl(24) xxxl(32) |
| **Radius** | sm(6) md(10) lg(14) xl(20) full(9999) |
| **Fonts** | Inter: Regular(400), Medium(500), SemiBold(600), Bold(700) |
| **Shadows** | sm, md, glow (accent-colored) |

---

## Auth Flow

1. App starts → `SplashScreen.preventAutoHideAsync()`
2. Load fonts (Inter family)
3. Check existing session: `supabase.auth.getSession()`
4. Listen for auth changes: `supabase.auth.onAuthStateChange()`
5. Route guard via `useSegments()`:
   - No session + not in `(auth)` → redirect to `/(auth)`
   - Session + in `(auth)` → redirect to `/(tabs)`
6. Hide splash when fonts loaded + auth resolved

**Token storage**: `expo-secure-store` (native) / `localStorage` (web) via `ExpoSecureStoreAdapter`.

**API auth**: Every REST call includes `Authorization: Bearer <access_token>`. On 401, auto-refreshes session and retries.

---

## Known Issues & Gotchas

- **Pre-existing TS errors**: `Avatar.tsx` (ViewStyle vs ImageStyle overflow) and `Input.tsx` (TextStyle vs ViewStyle cursor) — cosmetic, don't affect runtime
- **WebSocket message types**: Server sends `content_delta`/`stream_complete` (not `token`/`done`). Mobile types updated to match as of 2026-02-19
- **PRD Pipeline**: n8n workflow "X idea Generator" has downstream nodes (Google Sheets, Chat, Discord, Respond to Webhook) currently disabled. Webhook trigger responds immediately so POST returns 200, but data isn't processed. Re-enable nodes in n8n editor to fix
- **PRD expected JSON**: Full schema is `title`, `painPoint`, `reasoning`, `solution`, `productDescription`, `coreMagic`, `connectivity`, `notes`, `whyShippableToday`, `validationSources`, `marketGap`, `mvpScope`, `techStackRecommendations`, `monetizationModel`, `gtmStrategy`, `successMetrics`, `risksAndMitigations`
- **Command tab**: Admin-gated via `profile.role === 'admin'` — hidden from regular users
- **useToast patterns**: Two usage patterns exist: `useToast()` (returns full store, call `.show()`) and `useToast((s) => s.show)` (returns function directly). Both work
- **Expo Router Stack.Screen**: Must be direct children of `<Stack>` — no `<>` fragment wrappers or conditional rendering around them (causes "Layout children must be of type Screen" warning). Use `useSegments` + `router.replace` for auth routing instead
- **FlatList key prop**: Some API responses (feedback) may lack unique `id` — use index-based fallback keys

---

## Development

```bash
# Start dev server
cd "Projects/OPAI Mobile App/opai-mobile"
npx expo start

# TypeScript check
npx tsc --noEmit

# Run on device
npx expo start --android   # Android
npx expo start --ios       # iOS (Mac only)
```

**Project location**: `Projects/OPAI Mobile App/opai-mobile/`

**API reference doc**: `docs/mobile-api-reference.md` (895-line comprehensive reference)

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `expo` | ~54.0.33 | Framework |
| `react-native` | 0.81.5 | UI runtime |
| `expo-router` | 6.0.23 | File-based navigation |
| `@supabase/supabase-js` | ^2.49.0 | Auth + DB |
| `zustand` | ^5.0.0 | State management |
| `date-fns` | ^4.1.0 | Date formatting |
| `react-native-markdown-display` | ^7.0.2 | Markdown rendering |
| `react-native-gesture-handler` | — | Swipe gestures |
| `expo-secure-store` | — | Credential storage |
| `@expo-google-fonts/inter` | — | Typography |
| `@expo/vector-icons` | ^15.0.3 | Ionicons |
