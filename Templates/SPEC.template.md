# {{project_name}} — Technical Specification

**Version:** 1.0
**Date:** {{date}}
**Status:** Draft
**PRD Reference:** {{prd_id}}
**Project Slug:** `{{project_slug}}`

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Tech Stack](#2-tech-stack)
3. [Application Structure](#3-application-structure)
4. [Data Models](#4-data-models)
5. [API Design](#5-api-design)
6. [Infrastructure & Deployment](#6-infrastructure--deployment)
7. [Environment Variables](#7-environment-variables)
8. [Third-Party Services](#8-third-party-services)
9. [Dependencies](#9-dependencies)
10. [MVP Scope & Phased Delivery](#10-mvp-scope--phased-delivery)
11. [Decision Points](#11-decision-points)

---

## 1. System Architecture

### High-Level Architecture Diagram

```
<!-- Replace with ASCII architecture diagram -->

  +------------------+
  |    Client App    |
  +--------+---------+
           |
  +--------v---------+
  |   Application    |
  |   Server         |
  +--------+---------+
           |
  +--------v---------+
  |    Database      |
  +------------------+
```

### Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| <!-- e.g. Monorepo vs Separate --> | <!-- Choice --> | <!-- Why --> |
| <!-- e.g. SSR vs SPA --> | <!-- Choice --> | <!-- Why --> |
| <!-- e.g. Auth strategy --> | <!-- Choice --> | <!-- Why --> |

---

## 2. Tech Stack

### Frontend

| Technology | Version | Purpose |
|-----------|---------|---------|
| <!-- e.g. React --> | <!-- e.g. 18.x --> | <!-- e.g. UI framework --> |

### Backend

| Technology | Version | Purpose |
|-----------|---------|---------|
| <!-- e.g. Node.js --> | <!-- e.g. 20.x --> | <!-- e.g. API server --> |

### Infrastructure

| Technology | Version | Purpose |
|-----------|---------|---------|
| <!-- e.g. PostgreSQL --> | <!-- e.g. 15 --> | <!-- e.g. Primary database --> |

### Dev Tools

| Technology | Purpose |
|-----------|---------|
| <!-- e.g. ESLint --> | <!-- e.g. Linting --> |

---

## 3. Application Structure

```
{{project_slug}}/
├── README.md
├── PRD.md
├── SPEC.md
├── DEV.md
├── package.json
├── src/
│   ├── <!-- app structure here -->
│   └── ...
├── public/
│   └── ...
└── tests/
    └── ...
```

<!-- Describe the purpose of key directories and files -->

---

## 4. Data Models

### Entity Overview

| Entity | Description | Key Fields |
|--------|-------------|------------|
| <!-- e.g. User --> | <!-- Description --> | <!-- id, email, role --> |
| <!-- e.g. Project --> | <!-- Description --> | <!-- id, name, status --> |

### Relationships

<!-- Describe entity relationships (1:1, 1:N, M:N) -->

### Schema Definition

```
<!-- Full schema in your ORM format (Prisma, SQL, etc.) -->
```

---

## 5. API Design

### REST Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/...` | Yes | <!-- Description --> |
| POST | `/api/v1/...` | Yes | <!-- Description --> |

### WebSocket Events (if applicable)

| Event | Direction | Payload | Description |
|-------|-----------|---------|-------------|
| <!-- e.g. update --> | server→client | `{...}` | <!-- Description --> |

### Authentication

| Method | Provider | Notes |
|--------|----------|-------|
| <!-- e.g. JWT --> | <!-- e.g. Supabase Auth --> | <!-- Notes --> |

---

## 6. Infrastructure & Deployment

### Hosting

| Component | Provider | Tier | Notes |
|-----------|----------|------|-------|
| <!-- e.g. Frontend --> | <!-- e.g. Vercel --> | <!-- e.g. Free --> | <!-- Notes --> |
| <!-- e.g. Database --> | <!-- e.g. Supabase --> | <!-- e.g. Free --> | <!-- Notes --> |

### CI/CD Pipeline

<!-- Describe build, test, deploy workflow -->

### Deployment Strategy

| Environment | Branch | URL | Auto-deploy |
|-------------|--------|-----|-------------|
| Production | `main` | <!-- URL --> | Yes/No |
| Staging | `develop` | <!-- URL --> | Yes/No |

---

## 7. Environment Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `DATABASE_URL` | Yes | <!-- Description --> | `postgresql://...` |
| `API_KEY` | Yes | <!-- Description --> | `sk-...` |

---

## 8. Third-Party Services

| Service | Purpose | Tier | Est. Monthly Cost |
|---------|---------|------|-------------------|
| <!-- e.g. Supabase --> | <!-- Database + Auth --> | <!-- Free --> | $0 |
| <!-- e.g. OpenAI --> | <!-- AI features --> | <!-- Pay-as-you-go --> | ~$X |

**Estimated Total Monthly Cost:** $X

---

## 9. Dependencies

### Runtime Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| <!-- e.g. react --> | `^18.0.0` | <!-- UI framework --> |

### Dev Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| <!-- e.g. typescript --> | `^5.0.0` | <!-- Type checking --> |

---

## 10. MVP Scope & Phased Delivery

### Phase 1 — MVP

**Target:** <!-- Timeline -->

- [ ] <!-- Core feature 1 -->
- [ ] <!-- Core feature 2 -->
- [ ] <!-- Core feature 3 -->
- [ ] <!-- Basic auth -->
- [ ] <!-- Deploy to production -->

**NOT in MVP scope:** <!-- List deferred items -->

### Phase 2 — Enhancement

**Target:** <!-- Timeline -->

- [ ] <!-- Feature 4 -->
- [ ] <!-- Feature 5 -->
- [ ] <!-- Performance optimization -->

### Phase 3 — Scale

**Target:** <!-- Timeline -->

- [ ] <!-- Advanced feature -->
- [ ] <!-- Analytics / monitoring -->
- [ ] <!-- Growth features -->

---

## 11. Decision Points

### Resolved

| # | Decision | Options Considered | Choice | Rationale |
|---|----------|-------------------|--------|-----------|
| 1 | <!-- e.g. Database --> | <!-- PostgreSQL, MongoDB --> | <!-- PostgreSQL --> | <!-- Relational data, Supabase integration --> |

### Open (Needs Resolution)

| # | Decision | Options | Impact | Deadline |
|---|----------|---------|--------|----------|
| <!-- 1 --> | <!-- Question --> | <!-- Options --> | <!-- High/Med/Low --> | <!-- Date --> |

---

*Generated from OPAI SPEC template v1.0 — {{date}}*
