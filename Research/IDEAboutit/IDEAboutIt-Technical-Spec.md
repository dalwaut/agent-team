# IDEAboutIt.com - Technical Specification Document

**Version:** 1.0
**Date:** February 9, 2026
**Status:** FINALIZED - All Decision Points Resolved (Feb 10, 2026)
**Product:** IDEAboutIt.com - IDE Review & Sentiment Hub

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Tech Stack (Recommended)](#2-tech-stack-recommended)
3. [Application Structure](#3-application-structure)
4. [Data Models](#4-data-models)
5. [API Design](#5-api-design)
6. [Data Pipeline & Ingestion](#6-data-pipeline--ingestion)
7. [AI/ML Layer](#7-aiml-layer)
8. [Authentication & Authorization](#8-authentication--authorization)
9. [Frontend Architecture](#9-frontend-architecture)
10. [Real-Time System](#10-real-time-system)
11. [Workflows](#11-workflows)
12. [Infrastructure & DevOps](#12-infrastructure--devops)
13. [Third-Party Services & API Keys Required](#13-third-party-services--api-keys-required)
14. [Full Dependency List](#14-full-dependency-list)
15. [MVP Scope & Phased Delivery](#15-mvp-scope--phased-delivery)
16. [Decision Points — RESOLVED](#16-decision-points--resolved)
17. [Custom Analytics Schema (Supabase)](#17-custom-analytics-schema-supabase)

---

## 1. System Architecture

### High-Level Architecture Diagram (Text)

```
                          +------------------+
                          |   CDN (Vercel)   |
                          +--------+---------+
                                   |
                          +--------v---------+
                          |  Next.js Frontend |
                          |  (SSR + SPA)      |
                          +--------+---------+
                                   |
                    +--------------+--------------+
                    |                             |
           +-------v--------+          +---------v--------+
           | Next.js API     |          | WebSocket Server  |
           | Routes (REST)   |          | (Socket.io)       |
           +-------+--------+          +---------+---------+
                   |                              |
        +----------+----------+                   |
        |                     |                   |
+-------v------+   +----------v----+   +----------v----+
| PostgreSQL    |   | Redis          |   | Redis PubSub   |
| (Primary DB)  |   | (Cache/Queue)  |   | (Real-time)    |
+--------------+   +---------------+   +----------------+
        |
+-------v--------------+
| Data Ingestion Worker |
| (Node.js / Bull Queue)|
+-------+--------------+
        |
+-------v--------------+       +------------------+
| External APIs         |       | AI Processing    |
| - Reddit API          |       | - OpenAI API     |
| - X/Twitter API       |       | - Sentiment NLP  |
| - HN (Algolia)        |       | - Embeddings     |
| - RSS Feeds           |       +------------------+
| - ProductHunt API     |
+-----------------------+
```

### Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Monorepo vs. Separate | Monorepo | Shared types, simpler CI, one deploy target for MVP |
| SSR vs. SPA | Next.js (hybrid) | SEO for IDE pages, SPA for dashboard/interactive tools |
| SQL vs. NoSQL | PostgreSQL primary | Structured review data, relational queries for comparisons |
| Real-time approach | Socket.io over Redis PubSub | Proven, good DX, fallback to polling |
| AI provider | Multi-provider (Gemini primary) | Provider-agnostic adapter; switch via env config; Gemini Pro existing plan |

---

## 2. Tech Stack (Recommended)

### Frontend
| Technology | Version | Purpose |
|-----------|---------|---------|
| Next.js | 15.x | React framework, SSR, API routes, file-based routing |
| React | 19.x | UI library |
| TypeScript | 5.x | Type safety |
| Tailwind CSS | 4.x | Utility-first styling |
| shadcn/ui | latest | Component library (Radix-based, accessible) |
| Recharts | 2.x | Charts for sentiment/comparison dashboards |
| Socket.io-client | 4.x | Real-time updates on frontend |
| Zustand | 5.x | Lightweight global state management |
| React Hook Form | 7.x | Form handling (recommendation wizard, review submission) |
| Zod | 3.x | Schema validation (shared frontend/backend) |

### Backend
| Technology | Version | Purpose |
|-----------|---------|---------|
| Next.js API Routes | 15.x | REST API endpoints (co-located with frontend) |
| Prisma | 6.x | ORM for PostgreSQL |
| PostgreSQL | 16 | Primary relational database |
| Redis | 7.x | Caching, session store, real-time pub/sub, job queue |
| BullMQ | 5.x | Job queue for data ingestion and AI processing |
| Socket.io | 4.x | WebSocket server for real-time feeds |
| Supabase Auth | via @supabase/ssr | Authentication (GitHub OAuth + email/password with confirmation) |

### AI/ML (Multi-Provider Architecture)
| Technology | Purpose |
|-----------|---------|
| AI Provider Router | Provider-agnostic interface with env-based switching |
| Gemini Pro (primary) | Sentiment analysis, summarization, theme extraction (existing paid plan) |
| DeepSeek (secondary) | Fallback / A/B testing alternative |
| OpenAI (optional) | Embeddings (text-embedding-3-small) if needed |
| pgvector (PostgreSQL extension) | Vector storage and similarity search |

**Provider switching via environment config:**
```
AI_PROVIDER=gemini                    # gemini | deepseek | openai | claude
AI_MODEL=gemini-2.0-flash
AI_FALLBACK_PROVIDER=deepseek
AI_SENTIMENT_PROVIDER=gemini          # per-task overrides
AI_EMBEDDING_PROVIDER=gemini
AI_RECOMMENDATION_PROVIDER=gemini
```

### Infrastructure
| Technology | Purpose |
|-----------|---------|
| VPS (Hostinger) | Self-hosted: Next.js, Redis, workers, WebSocket, Nginx |
| Supabase | Managed PostgreSQL + pgvector (existing Pro plan) |
| Redis (self-hosted) | Caching, job queue, real-time pub/sub (installed on VPS) |
| Nginx + Let's Encrypt | Reverse proxy, SSL termination |
| PM2 | Process manager for Node.js services |
| GitHub Actions | CI/CD pipeline |
| Sentry | Error monitoring |
| Google Analytics | Traffic, referrers, SEO, demographics |
| Custom Supabase tracking | In-app event stream, session tracking, custom dashboard |

### Development Tools
| Tool | Purpose |
|------|---------|
| pnpm | Package manager (faster, disk-efficient) |
| ESLint + Prettier | Code quality |
| Vitest | Unit/integration testing |
| Playwright | E2E testing |
| Docker Compose | Local development (PostgreSQL, Redis) |
| Prisma Studio | Database GUI for development |

---

## 3. Application Structure

```
ideaboutit/
├── .github/
│   └── workflows/
│       ├── ci.yml                    # Lint, test, build
│       └── deploy.yml                # Production deploy
├── prisma/
│   ├── schema.prisma                 # Database schema
│   ├── migrations/                   # SQL migrations
│   └── seed.ts                       # Seed data (IDE profiles)
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── layout.tsx                # Root layout
│   │   ├── page.tsx                  # Homepage
│   │   ├── (marketing)/              # Public pages
│   │   │   ├── about/page.tsx
│   │   │   └── pricing/page.tsx
│   │   ├── (app)/                    # Authenticated app pages
│   │   │   ├── dashboard/page.tsx
│   │   │   ├── recommendations/page.tsx
│   │   │   └── saved/page.tsx
│   │   ├── ide/
│   │   │   ├── page.tsx              # IDE directory/search
│   │   │   └── [slug]/
│   │   │       ├── page.tsx          # IDE profile page
│   │   │       ├── reviews/page.tsx
│   │   │       └── compare/page.tsx
│   │   ├── compare/page.tsx          # Side-by-side comparison tool
│   │   ├── wizard/page.tsx           # Recommendation wizard
│   │   ├── api/
│   │   │   ├── ides/route.ts
│   │   │   ├── ides/[slug]/route.ts
│   │   │   ├── reviews/route.ts
│   │   │   ├── sentiment/route.ts
│   │   │   ├── recommend/route.ts
│   │   │   ├── compare/route.ts
│   │   │   ├── contribute/route.ts
│   │   │   ├── auth/callback/route.ts
│   │   │   └── webhooks/
│   │   │       └── ingestion/route.ts
│   │   └── admin/                    # Admin panel
│   │       ├── layout.tsx
│   │       ├── page.tsx
│   │       └── moderation/page.tsx
│   ├── components/
│   │   ├── ui/                       # shadcn/ui components
│   │   ├── ide/
│   │   │   ├── IdeCard.tsx
│   │   │   ├── IdeProfile.tsx
│   │   │   ├── SentimentGauge.tsx
│   │   │   ├── PainPointList.tsx
│   │   │   └── PricingBreakdown.tsx
│   │   ├── compare/
│   │   │   ├── ComparisonTable.tsx
│   │   │   └── ComparisonChart.tsx
│   │   ├── reviews/
│   │   │   ├── ReviewFeed.tsx
│   │   │   ├── ReviewCard.tsx
│   │   │   └── ReviewSubmitForm.tsx
│   │   ├── wizard/
│   │   │   ├── WizardStepper.tsx
│   │   │   ├── WizardStep.tsx
│   │   │   └── RecommendationResult.tsx
│   │   ├── dashboard/
│   │   │   ├── SentimentChart.tsx
│   │   │   ├── TrendingIDEs.tsx
│   │   │   └── UserInsights.tsx
│   │   └── layout/
│   │       ├── Header.tsx
│   │       ├── Footer.tsx
│   │       └── Sidebar.tsx
│   ├── lib/
│   │   ├── db.ts                     # Prisma client singleton
│   │   ├── redis.ts                  # Redis client
│   │   ├── supabase/
│   │   │   ├── client.ts             # Browser Supabase client
│   │   │   ├── server.ts             # Server Supabase client
│   │   │   └── middleware.ts          # Auth middleware
│   │   ├── ai/
│   │   │   ├── provider.ts           # Provider router (reads env config)
│   │   │   ├── gemini.ts             # Gemini adapter
│   │   │   ├── deepseek.ts           # DeepSeek adapter
│   │   │   ├── openai.ts             # OpenAI adapter
│   │   │   └── types.ts              # Shared AI response types
│   │   └── socket.ts                 # Socket.io setup
│   ├── services/
│   │   ├── ide.service.ts            # IDE CRUD operations
│   │   ├── review.service.ts         # Review aggregation logic
│   │   ├── sentiment.service.ts      # Sentiment analysis orchestration
│   │   ├── recommendation.service.ts # Recommendation engine
│   │   ├── comparison.service.ts     # Comparison logic
│   │   └── ingestion.service.ts      # Data ingestion orchestration
│   ├── workers/
│   │   ├── ingestion.worker.ts       # BullMQ worker: scrape + ingest
│   │   ├── sentiment.worker.ts       # BullMQ worker: AI sentiment processing
│   │   └── embedding.worker.ts       # BullMQ worker: generate embeddings
│   ├── scrapers/
│   │   ├── reddit.scraper.ts
│   │   ├── twitter.scraper.ts
│   │   ├── hackernews.scraper.ts
│   │   ├── producthunt.scraper.ts
│   │   └── rss.scraper.ts
│   ├── types/
│   │   ├── ide.ts
│   │   ├── review.ts
│   │   ├── sentiment.ts
│   │   └── recommendation.ts
│   └── utils/
│       ├── text.ts                   # Text cleaning, HTML stripping
│       ├── rate-limiter.ts
│       └── validators.ts
├── docker-compose.yml                # Local dev: PostgreSQL + Redis
├── .env.example
├── .env.local
├── next.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── vitest.config.ts
├── playwright.config.ts
├── package.json
└── CLAUDE.md
```

---

## 4. Data Models

### Prisma Schema (Core Entities)

```prisma
// prisma/schema.prisma

generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [pgvector(map: "vector")]
}

model Ide {
  id              String           @id @default(cuid())
  slug            String           @unique
  name            String
  description     String
  category        IdeCategory
  website         String
  logoUrl         String?
  screenshotUrls  String[]
  pricingTiers    Json             // { free: bool, plans: [{name, price, features}] }
  features        Json             // { languages: [], platforms: [], aiAssisted: bool, ... }
  sentimentScore  Float?           // Computed aggregate (1.0-5.0)
  totalReviews    Int              @default(0)
  painPoints      Json?            // AI-extracted top pain points
  embedding       Unsupported("vector(1536)")?  // For similarity matching
  createdAt       DateTime         @default(now())
  updatedAt       DateTime         @updatedAt

  reviews         Review[]
  sourcePosts     SourcePost[]
  sentimentLogs   SentimentLog[]
  comparisonsA    Comparison[]     @relation("ideA")
  comparisonsB    Comparison[]     @relation("ideB")

  @@index([category])
  @@index([sentimentScore])
}

enum IdeCategory {
  DESKTOP
  CLOUD
  ONLINE_BUILDER
  BROWSER_EXTENSION
  HYBRID
}

model Review {
  id              String        @id @default(cuid())
  ideId           String
  ide             Ide           @relation(fields: [ideId], references: [id])
  userId          String?
  user            User?         @relation(fields: [userId], references: [id])
  sourcePostId    String?       @unique
  sourcePost      SourcePost?   @relation(fields: [sourcePostId], references: [id])
  title           String?
  body            String
  rating          Float?        // User-submitted rating (1-5)
  sentimentScore  Float?        // AI-computed sentiment (-1.0 to 1.0)
  sentimentLabel  SentimentLabel?
  themes          String[]      // AI-extracted themes ["pricing", "performance", "ui"]
  isUserSubmitted Boolean       @default(false)
  isModerated     Boolean       @default(false)
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt

  @@index([ideId, createdAt])
  @@index([sentimentLabel])
}

enum SentimentLabel {
  POSITIVE
  NEUTRAL
  NEGATIVE
  MIXED
}

model SourcePost {
  id              String       @id @default(cuid())
  platform        Platform
  externalId      String       // ID from the source platform
  ideId           String?
  ide             Ide?         @relation(fields: [ideId], references: [id])
  author          String?
  body            String
  url             String
  postedAt        DateTime
  scrapedAt       DateTime     @default(now())
  sentimentScore  Float?
  sentimentLabel  SentimentLabel?
  processed       Boolean      @default(false)

  review          Review?

  @@unique([platform, externalId])
  @@index([ideId, postedAt])
  @@index([processed])
}

enum Platform {
  REDDIT
  TWITTER
  HACKERNEWS
  PRODUCTHUNT
  BLOG
  RSS
  USER_SUBMITTED
}

model SentimentLog {
  id              String       @id @default(cuid())
  ideId           String
  ide             Ide          @relation(fields: [ideId], references: [id])
  score           Float        // Aggregate score at this point in time
  positiveCount   Int
  negativeCount   Int
  neutralCount    Int
  topPainPoints   Json         // Snapshot of pain points
  periodStart     DateTime
  periodEnd       DateTime
  createdAt       DateTime     @default(now())

  @@index([ideId, periodEnd])
}

model User {
  id              String       @id @default(cuid())
  email           String       @unique
  name            String?
  avatarUrl       String?
  role            UserRole     @default(USER)
  preferences     Json?        // { languages: [], useCases: [], budget: ... }
  embedding       Unsupported("vector(1536)")?  // User preference vector
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt

  reviews         Review[]
  recommendations Recommendation[]
  savedComparisons SavedComparison[]
  accounts        Account[]
  sessions        Session[]
}

enum UserRole {
  USER
  PREMIUM
  ADMIN
}

model Recommendation {
  id              String       @id @default(cuid())
  userId          String
  user            User         @relation(fields: [userId], references: [id])
  inputData       Json         // Wizard form answers
  results         Json         // Ranked IDE suggestions with scores and reasons
  createdAt       DateTime     @default(now())

  @@index([userId, createdAt])
}

model Comparison {
  id              String       @id @default(cuid())
  ideAId          String
  ideA            Ide          @relation("ideA", fields: [ideAId], references: [id])
  ideBId          String
  ideB            Ide          @relation("ideB", fields: [ideBId], references: [id])
  comparisonData  Json         // Cached comparison result
  generatedAt     DateTime     @default(now())

  @@unique([ideAId, ideBId])
}

model SavedComparison {
  id              String       @id @default(cuid())
  userId          String
  user            User         @relation(fields: [userId], references: [id])
  ideIds          String[]     // Array of IDE IDs being compared
  createdAt       DateTime     @default(now())

  @@index([userId])
}

// NextAuth.js required models
model Account {
  id                String  @id @default(cuid())
  userId            String
  user              User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  type              String
  provider          String
  providerAccountId String
  refresh_token     String?
  access_token      String?
  expires_at        Int?
  token_type        String?
  scope             String?
  id_token          String?
  session_state     String?

  @@unique([provider, providerAccountId])
}

model Session {
  id           String   @id @default(cuid())
  sessionToken String   @unique
  userId       String
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expires      DateTime
}
```

---

## 5. API Design

### REST Endpoints

#### IDEs
| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/api/ides` | List IDEs (paginated, filterable) | Public |
| GET | `/api/ides/[slug]` | Get IDE profile with aggregated data | Public |
| GET | `/api/ides/[slug]/reviews` | Get reviews for an IDE | Public |
| GET | `/api/ides/[slug]/sentiment` | Get sentiment history/breakdown | Public |
| GET | `/api/ides/[slug]/posts` | Get latest source posts | Public |

#### Comparisons
| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/api/compare?ids=slug1,slug2` | Compare 2-4 IDEs side-by-side | Public |
| POST | `/api/compare/save` | Save a comparison to user profile | User |

#### Reviews
| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | `/api/contribute` | Submit a user review | User |
| GET | `/api/reviews/recent` | Get recent reviews across all IDEs | Public |

#### Recommendations
| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | `/api/recommend` | Get AI recommendations from wizard input | Public* |
| GET | `/api/recommendations/history` | Get user's past recommendations | User |

#### Search
| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/api/search?q=term` | Full-text search across IDEs and reviews | Public |

#### Admin
| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/api/admin/moderation` | Queue of unmoderated reviews | Admin |
| PATCH | `/api/admin/moderation/[id]` | Approve/reject a review | Admin |
| POST | `/api/admin/ingestion/trigger` | Manually trigger data ingestion | Admin |

*Rate-limited for unauthenticated users.

### WebSocket Events

| Event | Direction | Payload | Description |
|-------|-----------|---------|-------------|
| `ide:update` | Server -> Client | `{ slug, sentimentScore, newReviewCount }` | IDE data changed |
| `post:new` | Server -> Client | `{ ideSlug, post }` | New source post ingested |
| `subscribe:ide` | Client -> Server | `{ slug }` | Subscribe to IDE updates |
| `unsubscribe:ide` | Client -> Server | `{ slug }` | Unsubscribe |

---

## 6. Data Pipeline & Ingestion

### Ingestion Workflow

```
[Cron Trigger: every 15 min]
        |
        v
[Ingestion Scheduler]
        |
        +---> [Reddit Scraper Job] ---> BullMQ Queue
        +---> [Twitter Scraper Job] --> BullMQ Queue
        +---> [HN Scraper Job] -------> BullMQ Queue
        +---> [RSS Scraper Job] ------> BullMQ Queue
        +---> [ProductHunt Job] ------> BullMQ Queue
        |
        v
[Ingestion Worker] (processes queue)
        |
        +---> Deduplicate (check platform + externalId)
        +---> Match to IDE (keyword matching / AI classification)
        +---> Store as SourcePost (processed = false)
        |
        v
[Sentiment Worker] (processes unprocessed posts)
        |
        +---> Send text to OpenAI API
        +---> Receive: sentimentScore, sentimentLabel, themes[]
        +---> Update SourcePost (processed = true)
        +---> Create/update Review record
        +---> Recalculate IDE aggregate sentimentScore
        |
        v
[Embedding Worker] (runs after sentiment)
        |
        +---> Generate embedding for new review text
        +---> Store in pgvector column
        +---> Emit WebSocket event for real-time subscribers
```

### Source-Specific Details

| Source | API/Method | Rate Limits | Data Extracted |
|--------|-----------|-------------|----------------|
| Reddit | Reddit API (OAuth) | 100 req/min | Posts + comments from r/programming, r/webdev, IDE-specific subs |
| X/Twitter | X API v2 (Basic tier) | 100 reads/mo (Basic) or 10K (Pro) | Tweets mentioning IDE names, hashtags |
| Hacker News | Algolia HN API | No auth needed, be polite | Stories + comments matching IDE keywords |
| ProductHunt | ProductHunt API v2 | GraphQL, auth required | Product pages, reviews, upvote counts |
| RSS/Blogs | RSS feeds | N/A | Dev blog posts mentioning IDEs |

### Keyword Matching Strategy

Each IDE gets a keyword config:
```typescript
const IDE_KEYWORDS: Record<string, string[]> = {
  'cursor': ['cursor ide', 'cursor ai', 'cursor editor', '@cursor_ai'],
  'windsurf': ['windsurf ide', 'windsurf editor', 'codeium windsurf'],
  'bolt-new': ['bolt.new', 'bolt new', 'stackblitz bolt'],
  'replit': ['replit', 'repl.it'],
  'vscode': ['vs code', 'vscode', 'visual studio code'],
  // ...
};
```

---

## 7. AI/ML Layer

### Sentiment Analysis Pipeline

**Input:** Raw post/review text
**Output:** `{ score: float, label: enum, themes: string[], painPoints: string[], summary: string }`

```typescript
// Prompt template for OpenAI
const SENTIMENT_PROMPT = `Analyze the following developer review/post about the IDE "{ideName}".

Return JSON with:
- sentimentScore: float from -1.0 (very negative) to 1.0 (very positive)
- sentimentLabel: "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "MIXED"
- themes: array of 1-5 theme tags (e.g., "pricing", "ai-quality", "performance", "ui", "support")
- painPoints: array of specific pain points mentioned (empty if none)
- summary: one-sentence summary of the sentiment

Text: "{text}"`;
```

### Recommendation Engine

**Phase 1 (MVP):** Weighted scoring
- User answers wizard questions (languages, project type, budget, team size, cloud vs. local)
- Each answer maps to IDE feature weights
- Score = sum of (weight * IDE feature match)
- Return top 5 ranked IDEs with explanations

**Phase 2:** Vector similarity
- User preferences encoded as embedding vector
- IDE profiles encoded as embedding vectors
- Cosine similarity between user vector and all IDE vectors
- Combined with collaborative filtering (users with similar profiles liked these IDEs)

### AI Cost Estimates (Monthly)

| Operation | Provider (Primary) | Volume (est.) | Cost |
|-----------|-------------------|---------------|------|
| Sentiment analysis | Gemini 2.0 Flash | 10K posts/mo | ~$1-3 |
| Theme extraction | Gemini 2.0 Flash | 10K posts/mo | (included above) |
| Embeddings | Gemini / OpenAI fallback | 10K texts/mo | ~$0-1 |
| Recommendation generation | Gemini 2.0 Flash | 2K requests/mo | ~$0.50 |
| **Total** | | | **~$2-5/mo** |

*Costs assume Gemini Pro existing plan. Switchable to DeepSeek (~$1-2/mo) or OpenAI (~$7-10/mo) via env config.*

---

## 8. Authentication & Authorization

### Auth Provider: Supabase Auth

| Provider | Purpose |
|----------|---------|
| GitHub OAuth | Primary login (developers already have accounts) |
| Email/Password | Standard signup with Supabase email confirmation |

### Role-Based Access

| Role | Permissions |
|------|-------------|
| Anonymous | Browse IDEs, view reviews, use comparison tool, use wizard (rate-limited) |
| User | Submit reviews (requires verified account), save comparisons, view recommendation history |
| Premium | Ad-free, advanced analytics, export reports, priority AI recommendations |
| Admin | Moderation queue, trigger ingestion, view admin dashboard |

---

## 9. Frontend Architecture

### Page-by-Page Breakdown

| Page | Route | Key Components | Data Fetching |
|------|-------|---------------|---------------|
| Homepage | `/` | Search bar, TrendingIDEs, FeaturedComparisons, SentimentOverview | SSR + ISR (60s) |
| IDE Directory | `/ide` | IdeCard grid, filters (category, language, price), sort | SSR + client filter |
| IDE Profile | `/ide/[slug]` | IdeProfile, SentimentGauge, ReviewFeed, PainPointList, PricingBreakdown, LatestPosts | SSR + WebSocket |
| Comparison | `/compare?ids=a,b` | ComparisonTable, ComparisonChart, side-by-side reviews | Client-side fetch |
| Wizard | `/wizard` | WizardStepper (multi-step form), RecommendationResult | Client-side POST |
| Dashboard | `/dashboard` | UserInsights, SavedComparisons, RecommendationHistory | Client-side fetch (auth) |
| Admin | `/admin` | ModerationQueue, IngestionStatus, AnalyticsDashboard | Client-side fetch (admin) |

### State Management

- **Server state:** React Query (TanStack Query) for API data fetching, caching, revalidation
- **Client state:** Zustand for UI state (wizard form data, comparison selections, sidebar state)
- **Real-time state:** Socket.io client events update React Query cache directly

---

## 10. Real-Time System

### Architecture

```
[Ingestion Worker completes]
        |
        v
[Redis PUBLISH "ide:update" {slug, data}]
        |
        v
[Socket.io Server subscribes to Redis]
        |
        v
[Socket.io emits to clients in room "ide:{slug}"]
        |
        v
[Client receives, updates React Query cache]
```

### Implementation Notes

- Socket.io server runs as a separate process (or custom Next.js server in dev)
- In production on Vercel: Use a separate WebSocket service (e.g., Railway, Fly.io, or Ably/Pusher as managed alternative)
- Fallback: If WebSocket connection fails, client falls back to polling every 30s

---

## 11. Workflows

### Workflow 1: User Searches for an IDE

```
User types "Cursor" in search bar
  -> Client debounced search (300ms)
  -> GET /api/search?q=cursor
  -> Server: full-text search across IDE names, descriptions, review text
  -> Return ranked results
  -> User clicks IDE card
  -> Navigate to /ide/cursor
  -> SSR: fetch IDE profile, sentiment data, recent reviews, latest posts
  -> Client: subscribe to WebSocket room "ide:cursor"
  -> Real-time: new posts/reviews stream in as they're ingested
```

### Workflow 2: User Compares IDEs

```
User is on /ide/cursor
  -> Clicks "Compare" button
  -> Comparison tray opens (bottom bar)
  -> User navigates to /ide/windsurf, clicks "Add to comparison"
  -> Tray shows 2 IDEs selected
  -> User clicks "Compare Now"
  -> Navigate to /compare?ids=cursor,windsurf
  -> Client: GET /api/compare?ids=cursor,windsurf
  -> Server: fetch both IDE profiles, compute side-by-side metrics
  -> Render ComparisonTable (features, pricing, sentiment)
  -> Render ComparisonChart (sentiment over time overlay)
  -> User can save comparison (if authenticated)
```

### Workflow 3: Recommendation Wizard

```
User clicks "Find My IDE" on homepage
  -> Navigate to /wizard
  -> Step 1: "What do you primarily build?" (web, mobile, data, devops, games)
  -> Step 2: "What languages do you use?" (multi-select: JS, Python, Java, ...)
  -> Step 3: "Team or solo?" + "Team size?"
  -> Step 4: "Budget?" (free only, <$20/mo, <$50/mo, any)
  -> Step 5: "What matters most?" (rank: AI assistance, performance, ecosystem, price, cloud access)
  -> User clicks "Get Recommendations"
  -> POST /api/recommend { answers }
  -> Server:
     1. Encode answers as feature vector
     2. Score each IDE against feature vector (weighted match)
     3. (Phase 2) Also compute vector similarity
     4. Generate AI explanation for top 3 matches
  -> Return ranked list with scores and explanations
  -> Render RecommendationResult cards
  -> User can click through to IDE profiles or save results
```

### Workflow 4: User Submits a Review

```
User is on /ide/cursor (authenticated)
  -> Clicks "Write a Review"
  -> ReviewSubmitForm opens (modal or inline)
  -> Fields: rating (1-5 stars), title, body text, tags (optional)
  -> User submits
  -> POST /api/contribute { ideSlug, rating, title, body, tags }
  -> Server:
     1. Validate input (Zod schema)
     2. Create Review (isUserSubmitted=true, isModerated=false)
     3. Queue sentiment analysis job
  -> Sentiment Worker:
     1. Analyze text with OpenAI
     2. Update review with sentimentScore, sentimentLabel, themes
     3. Mark isModerated=true (auto if sentiment is clear)
     4. Recalculate IDE aggregate score
     5. Emit WebSocket event
  -> Review appears in feed (marked as "User Review")
```

### Workflow 5: Data Ingestion Cycle

```
[Every 15 minutes - Cron job]
  -> Ingestion Scheduler runs
  -> For each source (Reddit, X, HN, ProductHunt, RSS):
     -> Create scraper job in BullMQ queue
  -> Ingestion Worker processes jobs:
     -> Scraper fetches new posts since last scrape timestamp
     -> For each post:
        -> Check dedup (platform + externalId)
        -> Keyword match to determine which IDE(s)
        -> If ambiguous, queue for AI classification
        -> Store as SourcePost (processed=false)
  -> Sentiment Worker picks up unprocessed posts:
     -> Batch of 10 at a time
     -> Send to OpenAI for sentiment analysis
     -> Update records, recalculate IDE scores
     -> Emit real-time updates
  -> SentimentLog created hourly (aggregate snapshot)
```

### Workflow 6: Admin Moderation

```
Admin logs in -> /admin/moderation
  -> GET /api/admin/moderation (unmoderated reviews)
  -> For each review:
     -> See: original text, AI sentiment, AI themes, flagged issues
     -> Actions: Approve, Edit, Reject, Flag for manual review
  -> PATCH /api/admin/moderation/[id] { action, notes }
  -> Approved reviews become visible in public feeds
```

---

## 12. Infrastructure & DevOps

### Environment Variables Required

```bash
# Database (Supabase)
DATABASE_URL=postgresql://...@db.<project>.supabase.co:5432/postgres
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Redis (self-hosted on VPS)
REDIS_URL=redis://127.0.0.1:6379

# Auth (Supabase Auth - GitHub OAuth + Email/Password)
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# AI Provider (multi-provider router)
AI_PROVIDER=gemini                         # gemini | deepseek | openai | claude
AI_MODEL=gemini-2.0-flash
AI_FALLBACK_PROVIDER=deepseek
GEMINI_API_KEY=
DEEPSEEK_API_KEY=
OPENAI_API_KEY=                            # optional, for embeddings or fallback

# Per-task overrides (optional)
AI_SENTIMENT_PROVIDER=gemini
AI_EMBEDDING_PROVIDER=gemini
AI_RECOMMENDATION_PROVIDER=gemini

# External APIs
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
# TWITTER_BEARER_TOKEN=                    # Phase 2
# PRODUCTHUNT_API_TOKEN=                   # Phase 2

# Monitoring
SENTRY_DSN=
NEXT_PUBLIC_GA_MEASUREMENT_ID=             # Google Analytics

# App
NEXT_PUBLIC_APP_URL=https://ideaboutit.com
NEXT_PUBLIC_WS_URL=wss://ws.ideaboutit.com
```

### CI/CD Pipeline

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  lint-test-build:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_PASSWORD: test
        ports: ['5432:5432']
      redis:
        image: redis:7
        ports: ['6379:6379']
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm prisma generate
      - run: pnpm prisma migrate deploy
      - run: pnpm test
      - run: pnpm build
```

### Deployment Strategy (Self-Hosted VPS)

| Component | Platform | Notes |
|-----------|----------|-------|
| Next.js app | VPS (PM2) | Reverse proxied through Nginx |
| PostgreSQL + pgvector | Supabase (existing Pro plan) | Managed, automatic backups |
| Redis | VPS (redis-server) | Installed directly, ~5MB RAM |
| WebSocket server | VPS (PM2) | Socket.io as separate PM2 process |
| Cron jobs (ingestion) | VPS (node-cron or crontab) | Every 15 min triggers |
| Workers (BullMQ) | VPS (PM2) | Long-running processes managed by PM2 |
| SSL | Let's Encrypt via Certbot | Auto-renewing certificates |
| Reverse proxy | Nginx | Routes traffic to Next.js, WebSocket server |

---

## 13. Third-Party Services & API Keys Required

| Service | Tier Needed | Est. Cost/mo | Notes |
|---------|------------|--------------|-------|
| VPS (Hostinger) | Existing plan | $5-15 | Hosts: Next.js, Redis, workers, Nginx |
| Supabase (PostgreSQL) | Pro (existing) | $0 additional | Already paid; DB + Auth + pgvector |
| Redis | Self-hosted on VPS | $0 | Installed via apt, no managed service |
| Gemini Pro (AI) | Existing plan | $0-5 | Sentiment, recommendations, embeddings |
| DeepSeek (AI fallback) | Pay-as-you-go | $0-2 | Secondary provider for A/B testing |
| Reddit API | Free tier | $0 | reddit.com/dev |
| X/Twitter API | **Deferred to Phase 2** | $0 | Evaluate need after MVP launch |
| ProductHunt API | **Deferred to Phase 2** | $0 | producthunt.com/v2/docs |
| GitHub OAuth | Free | $0 | github.com/settings/developers |
| Google Analytics | Free | $0 | analytics.google.com |
| Sentry | Free tier | $0 | sentry.io |
| Domain | Annual | ~$12/yr | Already verified |
| **Total (est.)** | | **~$5-20/mo** | |

---

## 14. Full Dependency List

### Production Dependencies

```json
{
  "dependencies": {
    "next": "^15.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@prisma/client": "^6.0.0",
    "prisma": "^6.0.0",
    "@supabase/supabase-js": "^2.0.0",
    "@supabase/ssr": "^0.5.0",
    "openai": "^4.0.0",
    "@google/generative-ai": "^0.21.0",
    "bullmq": "^5.0.0",
    "ioredis": "^5.0.0",
    "socket.io": "^4.0.0",
    "socket.io-client": "^4.0.0",
    "@tanstack/react-query": "^5.0.0",
    "zustand": "^5.0.0",
    "react-hook-form": "^7.0.0",
    "@hookform/resolvers": "^3.0.0",
    "zod": "^3.0.0",
    "tailwindcss": "^4.0.0",
    "@radix-ui/react-dialog": "^1.0.0",
    "@radix-ui/react-dropdown-menu": "^2.0.0",
    "@radix-ui/react-tabs": "^1.0.0",
    "@radix-ui/react-select": "^2.0.0",
    "@radix-ui/react-tooltip": "^1.0.0",
    "recharts": "^2.0.0",
    "lucide-react": "^0.400.0",
    "date-fns": "^3.0.0",
    "snoowrap": "^1.0.0",
    "rss-parser": "^3.0.0",
    "cheerio": "^1.0.0",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.0.0",
    "tailwind-merge": "^2.0.0"
  }
}
```

### Dev Dependencies

```json
{
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "eslint": "^9.0.0",
    "eslint-config-next": "^15.0.0",
    "prettier": "^3.0.0",
    "prettier-plugin-tailwindcss": "^0.6.0",
    "vitest": "^2.0.0",
    "@testing-library/react": "^16.0.0",
    "playwright": "^1.0.0",
    "@playwright/test": "^1.0.0",
    "prisma": "^6.0.0"
  }
}
```

---

## 15. MVP Scope & Phased Delivery

### Phase 1: MVP (Weeks 1-8)

**Goal:** Launchable product with core value proposition.

| Feature | Details |
|---------|---------|
| IDE Directory | 10 IDEs seeded: Cursor, Windsurf, VS Code, IntelliJ IDEA, Zed, Bolt.new, Replit, Lovable, v0, GitHub Codespaces |
| IDE Profiles | Name, description, features, pricing, screenshots |
| Basic Sentiment | OpenAI sentiment on ingested posts, aggregate score displayed |
| Reddit + HN ingestion | Automated scraping every 15 min |
| Search | Full-text search across IDEs |
| Comparison Tool | Side-by-side for 2 IDEs |
| Recommendation Wizard | 5-step form with weighted scoring (no ML yet) |
| Auth | GitHub OAuth + email/password with Supabase email confirmation |
| User Reviews | Submit and display, AI auto-moderation |
| Responsive UI | Mobile-friendly, Tailwind + shadcn/ui |

**NOT in MVP:** Twitter/X ingestion, ProductHunt, premium tier, real-time WebSocket, vector embeddings, collaborative filtering, admin dashboard (use Prisma Studio).

### Phase 2: Intelligence (Weeks 9-16)

| Feature | Details |
|---------|---------|
| Real-time updates | WebSocket for live post feeds |
| Vector recommendations | pgvector embeddings, similarity matching |
| Twitter/X + ProductHunt | Additional data sources |
| Sentiment history | Time-series charts on IDE pages |
| Pain point extraction | AI-generated pain point summaries |
| Premium tier | Stripe integration, ad-free, advanced analytics |
| Admin panel | Moderation queue, ingestion monitoring |

### Phase 3: Scale (Weeks 17+)

| Feature | Details |
|---------|---------|
| Collaborative filtering | "Users like you also liked..." |
| User dashboards | Personalized insights |
| RSS/blog ingestion | Broader data sources |
| SEO optimization | Structured data, meta tags, sitemap |
| Export reports | PDF/CSV for premium users |
| API for third parties | Public API for IDE data |

---

## 16. Decision Points — RESOLVED

**All critical decisions have been made. Development can begin.**

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Domain & Hosting | Domain verified. **Self-hosted VPS** (Hostinger). No Vercel/Railway. | Cost reduction: ~$5-20/mo vs $57-180/mo. Full control. |
| 2 | Twitter/X API | **Deferred to Phase 2.** Reddit + HN only for MVP. | $100/mo is 5-20x the rest of the infrastructure combined. |
| 3 | Standalone vs Monorepo | **Standalone repository.** | No shared code with other projects. Clean separation. |
| 4 | Auth Providers | **GitHub OAuth + email/password** via Supabase Auth with email confirmation. | Developers have GitHub. Email/pass is a universal fallback. |
| 5 | Initial IDE List (10) | **Desktop:** Cursor, Windsurf, VS Code, IntelliJ IDEA, Zed. **Cloud/Builder:** Bolt.new, Replit, Lovable, v0, GitHub Codespaces. | Swapped Glitch/CodeSandbox for Lovable/v0 (higher current buzz). |
| 6 | User Reviews | **Require verified account.** No anonymous reviews. | One-click GitHub OAuth is low friction. Prevents spam. |
| 7 | Moderation | **Hybrid.** AI auto-approves high-confidence, flags ambiguous for manual review. | Best quality/effort balance. Prisma Studio for manual review in MVP. |
| 8 | Branding/Design | **Dark theme, developer-focused, glowing/tech aesthetic.** Iterate post-launch. | Start functional, refine visually after core features work. |
| 9 | Analytics | **Google Analytics** (traffic/SEO) + **custom Supabase event tracking** (in-app behavior, session tracking, custom dashboard). | GA for standard metrics, custom tracking for product-specific insights. |
| 10 | Budget | **Target: $5-20/mo.** Self-hosted VPS eliminates Vercel/Railway/Upstash costs. Gemini Pro (existing plan) for AI. | Cheapest viable MVP. Scale spending only when traffic demands it. |

### Additional Decisions Made

| Decision | Choice | Notes |
|----------|--------|-------|
| AI Provider | **Multi-provider with Gemini Pro primary** | Provider-agnostic adapter with env-based switching. DeepSeek as fallback. Can A/B test providers without code changes. |
| Redis | **Self-hosted on VPS** | `apt install redis-server`. Replaces Upstash ($0). |
| Process Manager | **PM2** | Manages Next.js, workers, WebSocket server on VPS. |
| Reverse Proxy | **Nginx + Let's Encrypt** | SSL termination, routing to services. |

---

## 17. Custom Analytics Schema (Supabase)

Alongside Google Analytics, we track granular in-app events in Supabase for a custom dashboard.

```prisma
model VisitorSession {
  id              String       @id @default(cuid())
  sessionId       String       @unique    // Generated client-side, stored in cookie
  userId          String?                 // Linked if authenticated
  ipHash          String?                 // Hashed IP for geo (not raw IP)
  country         String?
  region          String?
  city            String?
  userAgent       String?
  browser         String?
  os              String?
  device          String?                 // desktop | mobile | tablet
  referrer        String?                 // Where they came from
  utmSource       String?
  utmMedium       String?
  utmCampaign     String?
  landingPage     String?
  firstSeenAt     DateTime     @default(now())
  lastSeenAt      DateTime     @updatedAt

  events          VisitorEvent[]

  @@index([firstSeenAt])
  @@index([referrer])
  @@index([country])
}

model VisitorEvent {
  id              String          @id @default(cuid())
  sessionId       String
  session         VisitorSession  @relation(fields: [sessionId], references: [sessionId])
  eventType       String          // page_view | ide_view | comparison | wizard_start | wizard_complete | review_submit | search | signup
  eventData       Json?           // { slug: "cursor", step: 3, query: "best ai ide", ... }
  pageUrl         String?
  timestamp       DateTime        @default(now())

  @@index([sessionId, timestamp])
  @@index([eventType, timestamp])
}
```

**Key dashboard metrics from this data:**
- Visitor flow: landing page → IDE views → comparison → wizard → signup
- Most viewed IDEs, most compared pairs
- Wizard completion rate and drop-off step
- Referrer attribution (which sources drive signups)
- Geographic distribution
- Device/browser breakdown

---

*This document is finalized and ready for Phase 1 MVP development.*
