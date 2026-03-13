# OPAI Glossary

> **Last updated:** 2026-03-05
> **Purpose:** Canonical definitions for all OPAI-specific terms, acronyms, and concepts.

---

## Acronyms Quick Reference

| Acronym | Full Name |
|---------|-----------|
| OPAI | Orchestrated Projects + Agent Intelligence |
| AIOS | AI Operating System |
| GEO | Generative Engine Optimization |
| ARL | Agent Response Language |
| RALPH | Recursive Agent Loop for Progressive Handling |
| HITL | Human-In-The-Loop |
| HELM | (brand name, not an acronym) — Autonomous business runner |
| DAM | Do Anything Mode |
| PRDgent | PRD + Agent — product evaluation agent |
| NFS | Network File System (used for external worker dispatch) |
| PTC | Programmatic Tool Calling |
| MCP | Model Context Protocol |
| TCP | Task Control Panel |
| RLS | Row-Level Security (Supabase/Postgres) |
| VPS | Virtual Private Server |
| BB | BoutaByte |
| VEC | Visit Everglades City |
| GHL | GoHighLevel |
| SOP | Standard Operating Procedure |

---

## Platform & Versions

| Term | Definition |
|------|-----------|
| **OPAI** | Orchestrated Projects + Agent Intelligence. The autonomous, self-managing agentic workspace that runs on a dedicated workstation. Consolidates 22 tools, a 13-worker Claude Code fleet, and business operations under one unified system. |
| **AIOS** | AI Operating System. The concept of packaging OPAI as a customized operating system for businesses. Core value proposition for v4 consulting. |
| **The Operator** | Codename for OPAI v2. Focus: consolidated infrastructure (28 to 9 services), unified Engine, WorkerManager, vault integration. Completed 2026-02-25. |
| **Felix** | Codename for OPAI v3. Focus: autonomous operations with proactive heartbeat, memory consolidation, fleet coordination, HELM activation, internal workforce. Named after the Felix concept from Nat Eliason's autonomous agent work. Currently live at v3.5. |
| **Open Doors** | Codename for OPAI v4. Focus: revenue generation. HELM-managed businesses, agency consulting services, ClawBot beta, public-facing product launches. Planned. |
| **Token Burn** | Intensive sprint where agents consume large token budgets to accomplish high-volume work (documentation, cleanup, enrichment) in a single session. |

---

## Core Services

| Term | Definition |
|------|-----------|
| **Engine** | The unified core service (port 8080). Replaced orchestrator + monitor + tasks in v2. Runs 27 route modules and 12+ async background tasks including heartbeat, fleet coordinator, NFS dispatcher, assembly pipeline, and process sweeper. |
| **Portal** | Public-facing entry point (port 8090). Landing page, login, role-based routing, admin dashboard (18 tiles), Pages Manager for content deployment. |
| **Team Hub** | ClickUp-style task/project management (port 8089). Workspaces, folders, lists, board/list/calendar views. v3.5 backbone: single source of truth for all agent tasks, HITL decisions, and proactive suggestions. |
| **Brain** | 2nd Brain cognitive layer (port 8101). Knowledge graph, library (notes/concepts/questions), inbox, canvas, research synthesis, AI co-editor, YouTube/Instagram analysis. |
| **Vault** | Encrypted credential management (port 8105). SOPS+age encrypted store holding 276+ secrets. Per-user vault with AES-256-GCM encryption. Provides tmpfs-injected env vars to all systemd services. |

---

## Tools & Agents

| Term | Definition |
|------|-----------|
| **HELM** | Autonomous business runner (port 8102). Given a business plan, bootstraps and operates a full business presence. Multi-tenant, Stripe integration, CEO-gate for financial decisions. |
| **DAM** | Do Anything Mode (port 8104). Meta-orchestrator that takes any goal, decomposes it via Claude, executes via agents/squads/tools, with tiered approval gates. |
| **PRDgent** | Product Requirements Document agent. Scores ideas across 5 criteria (market demand, differentiation, feasibility, monetization, timing), issues verdicts (good/not_ready/poor), and scaffolds project directories. |
| **Marq** | App store publisher agent (port 8103). Pre-submission checks (31 automated), metadata editor, submission workflow, review monitoring, rejection relay to Team Hub. |
| **Bx4** | Business intelligence bot (port 8100). 4 wings: Financial, Market, Social, Operations. Budget-aware Green Filter, multi-tenant. |
| **Studio** | AI image generation + editing suite (port 8108). Gemini-powered generation, Fabric.js canvas with layers/shapes/text. |
| **Assembly** | End-to-end autonomous build pipeline. Idea to PRD to spec to build to review to ship. 6-phase state machine with two human gates (plan + ship). |
| **ClawBot** | Containerized agent runtime. Docker-based isolated agent environments with access manifests, vault credentials, kill switch, and full audit trail. Managed by OpenClaw Broker (port 8106). |

---

## Infrastructure Concepts

| Term | Definition |
|------|-----------|
| **Heartbeat** | Proactive 30-minute background loop. Aggregates worker/task/session/resource snapshots, detects changes (completions, failures, stalls), auto-restarts crashed workers, sends Telegram alerts with HITL escalation. |
| **Fleet Coordinator** | Work dispatch backbone. Routes tasks to available workers based on category/keyword matching, manages worker capacity, integrates with Team Hub for task tracking. |
| **NFS Dispatcher** | File-based communication system for external ClawBot workers via NFS mount. Uses inbox/outbox folders with READY/DONE sentinel files for coordination. |
| **Proactive Intelligence** | Autonomous detection system within the heartbeat loop. Identifies overdue tasks, stalled workers, idle resources, and recurring patterns. Generates actionable suggestions without being asked. |
| **Meta-Assessment** | Second-order self-improvement loop. Verifies whether the daily_evolve fix pipeline actually lands fixes, cross-validates agent outputs, measures fleet token efficiency, audits prompt quality. Runs after evolve squad. |
| **Worker** | A Claude Code CLI process managed by the Engine's WorkerManager. Up to 13 concurrent workers, each assigned to a specific task category. Workers communicate via Worker Mail (SQLite). |
| **Squad** | A coordinated group of agents that run together to accomplish a task. 27 defined squads (e.g., audit, wiki, evolve, forge). Each squad has a specific composition and execution order. |
| **HITL** | Human-In-The-Loop. Any decision point where the system pauses and asks a human (usually via Telegram) before proceeding. 5-button gate: Run, Approve, Dismiss, Reject, GC (garbage collect). 15-minute escalation timer. |
| **ARL** | Agent Response Language. Structured skill system used by the Email Agent. 14 built-in skills across 5 types (classify, tag, draft, organize, act). |
| **RALPH** | Recursive Agent Loop for Progressive Handling. A delegation pattern where agents recursively decompose complex tasks into smaller sub-tasks, each handled by specialized sub-agents. |

---

## Business & Brand

| Term | Definition |
|------|-----------|
| **BoutaByte** | Parent brand. Technology company that owns and operates OPAI, Paradise Web, and client services. |
| **Paradise Web** | Web agency brand under BoutaByte. Client-facing web development and digital marketing services. |
| **GEO** | Generative Engine Optimization. Optimizing web content for AI search engines (ChatGPT, Perplexity, Gemini) rather than traditional SEO. 5-dimension scoring system. |
| **CEO-gate** | Any financial decision or external-facing action that requires Dallas's explicit approval before HELM or any agent can proceed. |
| **Musical Framework** | OPAI's brand metaphor. Maps agentic concepts to musical terms: Composer (creators), Score (prompts), Conductor (orchestrator), Players (agents), Ensemble (squad), Performance (reports). |

---

## Adding New Terms

When a new term, acronym, or concept is introduced to OPAI:
1. Add it to the appropriate section above
2. Add to the Acronyms Quick Reference if it has an acronym
3. Keep definitions to 1-3 sentences max
