# Harness Engineering

The discipline of designing systems that enable long-running, fully autonomous AI agents across multiple sessions. Evolution: prompt engineering → context engineering → **harness engineering**.

Sources: AI Jason + Solo Swift Crafter, synthesized from Anthropic, OpenAI, Vercel, and Manis experiments (Dec 2025 – Mar 2026).

**Why this matters:** Models are now capable of fully autonomous long-running tasks. The bottleneck is no longer model quality — it's system design. The right harness unlocks what the model can already do.

---

## The Paradigm Shift

Before (co-pilot era): Human prompts → agent responds → human reviews → human prompts again. Human is the driver.

After (autonomous era): Agent is always-on, proactive, works across sessions, coordinates with other agents, verifies its own work. Human sets direction and approves.

**OPAI is already in the "after" category** — Engine with heartbeat, fleet coordinator, NFS dispatcher, 13-worker fleet, proactive intelligence. This document codifies the principles that make it work.

---

## The Evidence: It's the Harness, Not the Model

**Epics Agent Benchmark** — Researchers tested frontier models on real professional tasks (consulting, legal, analyst work — each taking a human 1-2 hours). Results:
- Best model completed tasks **24% of the time** (1 in 4)
- After 8 attempts with the same model: only **~40%**
- These same models score **90%+** on standard benchmarks

**Why they failed:** Not lack of knowledge or reasoning. Failures were almost entirely **execution and orchestration** — agents got lost after too many steps, looped back to failed approaches, lost track of the goal. The harness is the bottleneck, not the model.

**The Bitter Lesson (Richard Sutton):** Approaches that scale with compute always beat hand-engineered knowledge. Applied here: as models get smarter, your harness should get **simpler**, not more complex. If you're adding more hand-coded logic with every model upgrade, you're swimming against the current.

---

## Principle 1: Legible Environment

**Problem:** When an agent starts a fresh session/context window, it has zero knowledge of what happened before. If the environment isn't self-documenting, the agent wastes time guessing, duplicates work, or breaks things.

**Solution:** Design the environment so any agent can understand the full state of work within the first few tool calls.

### Patterns

**Table of Contents with Progressive Disclosure**
- One root file (e.g., `CLAUDE.md`, `agents.md`) acts as a table of contents
- It links to detailed docs that agents retrieve on demand
- Never dump everything into one massive file — agents choke on too much context
- OPAI example: `CLAUDE.md` → `Library/opai-wiki/` (71 docs, read on demand)

**Structured Feature/Task Lists**
- Break work into discrete items in a structured file (JSON or markdown)
- Each item has: description, spec, status (pass/fail or pending/done)
- Default status = fail/pending — forces agent to verify before marking complete
- Prevents one-shotting (trying to do everything at once) and premature completion
- OPAI example: `tasks/registry.json`, `tasks/queue.json`

**Progress Files + Git Commits**
- After each session, agent writes a summary of what it did to a progress file
- Agent commits changes with descriptive messages
- Next session reads progress file + git log to understand state
- OPAI example: `reports/latest/`, squad run summaries

**Repository as Single Source of Truth**
- All knowledge must be accessible from the agent's environment
- If information lives in Google Docs, Slack, email, etc. — mirror it locally
- From the agent's perspective: if it can't be accessed in the environment, it doesn't exist
- OPAI example: `Library/knowledge/` aggregates external references locally

**Domain Boundaries with Enforcement**
- Define explicit architectural boundaries between domains/modules
- Enforce via linters, structural tests, pre-commit hooks
- Within boundaries, agents have freedom; across boundaries, rules are enforced
- This is normally a "hundreds of engineers" concern — with AI agents it's an early prerequisite

### Legibility Checklist

For any autonomous agent workflow, verify:
- [ ] Can a fresh agent understand the project state in < 3 tool calls?
- [ ] Is there a structured task/feature list with status tracking?
- [ ] Are progress notes written after each session?
- [ ] Is all relevant knowledge accessible from the working environment?
- [ ] Are architectural boundaries defined and enforced?

---

## Principle 2: Verification Over Declaration

**Problem:** Agents have a strong tendency to mark work as "complete" without actually verifying it works end-to-end. Unit tests and API tests often miss integration failures.

**Solution:** Give agents proper tools to verify their own work with fast feedback loops.

### Patterns

**End-to-End Testing > Unit Testing**
- Unit tests pass but the feature is broken in the browser — common failure mode
- Give agents browser automation tools (Puppeteer MCP, Chrome DevTools Protocol, Playwright)
- Agent should: implement → test end-to-end → fix → re-test → only then mark complete

**Record Evidence**
- OpenAI's workflow: reproduce bug → record video of failure → implement fix → record video of resolution → merge
- Evidence-based verification prevents "trust me, it works" declarations

**Fast Feedback Loops**
- The faster an agent can verify, the more iterations it can run
- Bootable-per-worktree setups let agents spin up isolated test environments instantly
- Dev servers should be startable via a single script (e.g., `init.sh`)

**Structural Verification**
- Pre-commit hooks that run linters, type checks, structural tests
- Automatically triggered — agent can't skip them
- Catches drift and violations before they propagate

### OPAI Application
- Anti-slop rule #6 ("anti-mock testing") already captures this spirit
- Anti-slop rule #7 ("quality gates before handoff") enforces verification
- Strengthen by ensuring builder agents always run end-to-end verification (not just "it looks right")
- Browser automation (`opai-browser` on port 8107) is already available for this

---

## Principle 3: Generic Tools Over Specialized Tools

**Problem:** Building specialized tools with heavy prompt engineering and custom schemas seems like the right approach, but creates fragile, slow, high-maintenance systems.

**Solution:** Give agents generic, code-native tools and let the model figure out how to use them.

### The Vercel Case Study

Vercel spent months building a sophisticated text-to-SQL agent with:
- Specialized tools for each step
- Heavy prompt engineering
- Careful context management

Result: fragile, slow, constant maintenance for edge cases.

Then they **deleted most specialized tools** and gave the agent a single bash command tool.

Results:
- **3.5x faster**
- **37% fewer tokens**
- **Success rate: 80% → 100%**

### Why This Works

- LLMs have billions of training tokens on native tools (grep, git, npm, bash, etc.)
- They have near-zero training tokens on your custom tool-calling JSON schemas
- Generic tools = the model's comfort zone
- Specialized tools = forcing the model to learn your bespoke API on the fly

### The Anthropic Validation

Anthropic's team found the same pattern:
- Instead of specialized search/execute tools → one bash tool where agents run `grep`, `cat`, `npm run lint`, etc.
- Agents performed better with fewer, more powerful generic tools

### Practical Rules

1. **Start with generic tools** (read, write, edit, bash, browser) — only specialize when generic provably fails
2. **Don't wrap reasoning in tools** — let the model reason, let tools execute
3. **Don't prematurely optimize** — a "dumb" bash tool that works > a "smart" specialized tool that breaks
4. **Good context environment is the foundation** — generic tools work because the agent can progressively retrieve context through them

### The Manis Case Study (5 Rebuilds in 6 Months)

Manis (acquired by Meta) rebuilt their entire agent framework five times. Biggest gains came from **removing** features, not adding them:

- Ripped out complex document retrieval
- Killed fancy routing logic
- Replaced management agents with simple structured handoffs
- Every iteration: simpler AND better

Key finding: agents averaged **~50 tool calls per task**. Even with large context windows, performance degrades — early instructions get buried under hundreds of intermediate results. Signal lost under noise.

**Their fix:** Treat the file system as the model's external memory. Instead of cramming everything into context, agent writes key info to a file and reads it back when needed. This is exactly what `CLAUDE.md`, progress files, and memory files do in OPAI.

**Pattern: Reduce / Offload / Isolate**
1. **Reduce** — actively shrink context to what's relevant now
2. **Offload** — use the file system for memory, not the context window
3. **Isolate** — spin up sub-agents for heavy tasks, bring back only the summary

### OPAI Application
- OPAI's `claude -p` + stdout approach already follows this principle
- Agent safety rules (read-only, no git push) are the right constraints on generic tools
- When building new agent capabilities, prefer expanding what agents can *read/access* over building specialized tool schemas
- The skill library pattern (OpenClaw) = generic tools + expanding context, not specialized tooling
- Manis's reduce/offload/isolate maps directly to OPAI's fleet coordinator (isolate) + wiki system (offload) + focused agent prompts (reduce)

---

## Three Convergent Architectures

Three successful agent systems arrived at the same place from different directions:

| System | Architecture | Philosophy |
|--------|-------------|------------|
| **Codex** (OpenAI) | Orchestrator → Executor → Recovery layer | Layered: plan, execute, catch failures. Robust enough to hand off and walk away. |
| **Claude Code** (Anthropic) | 4 core tools (read/write/edit/bash) + MCP extensibility | Minimal: most intelligence lives in the model. Harness stays thin. Extend via MCP/skills. |
| **Manis** (Meta) | Reduce context, offload to filesystem, isolate via sub-agents | Pragmatic: actively manage what the model sees. File system as external brain. |

**All three converge on:** The harness matters more than the model. The same model behaves completely differently depending on the harness around it.

**OPAI's position:** Closest to Claude Code's philosophy (minimal core tools, MCP extensibility) with Manis's pragmatic context management (wiki offloading, fleet isolation) and Codex's recovery patterns (heartbeat, health checks, service monitor).

---

## The Autonomous Agent Workflow (Synthesized)

Putting all three principles together, the ideal long-running agent workflow:

```
1. INITIALIZE
   - Initializer agent sets up environment (dev server, dependencies)
   - Breaks goal into structured feature list (JSON, all marked "pending")
   - Creates progress tracking file
   - Initial git commit

2. EACH SESSION (coding agent)
   a. Read feature list → understand overall plan
   b. Read progress file + git log → understand current state
   c. Run init script → start dev server / verify environment
   d. Pick highest-priority pending feature
   e. Implement incrementally (not one-shot)
   f. Verify end-to-end (browser, tests, linters)
   g. Update feature status (pending → pass/fail)
   h. Write progress summary
   i. Git commit with descriptive message
   j. Leave environment in clean state

3. REPEAT until all features pass
```

### How OPAI Maps to This

| Workflow Step | OPAI Equivalent |
|--------------|-----------------|
| Initializer agent | Builder spec (`scripts/run_builder.sh`) + PRD pipeline |
| Feature list | `tasks/registry.json` + Team Hub tasks |
| Progress file | `reports/latest/` + squad run summaries |
| Environment setup | `scripts/opai-control.sh` + service templates |
| Session context | `CLAUDE.md` → wiki progressive disclosure |
| End-to-end verify | `opai-browser` (Playwright) + pre-commit hooks |
| Generic tools | `claude -p` + bash + read/write/edit |
| Multi-agent coord | Fleet coordinator + NFS dispatcher |

---

## Key Takeaway

> The model is already more powerful than you think. The job isn't to make the model smarter — it's to design the harness that lets it operate at its actual capability level across long-running, multi-session, multi-agent work.

This is what OPAI does. This document names and formalizes the discipline.
