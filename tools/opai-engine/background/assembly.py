"""OPAI Engine — Assembly Line: End-to-End Autonomous Build Pipeline (v3.7).

On-demand pipeline that takes an idea/PRD/spec/task and drives it through:
  Phase 0: Intake    — PRDgent evaluate + PRD generate
  Phase 1: Plan      — AI-generated SPEC.md + project scaffold
  Phase 2: Build     — Fleet dispatches project-lead → builders
  Phase 3: Review    — Fleet dispatches reviewer + accuracy + security
  Phase 4: Iterate   — Fix P0/P1 findings, rebuild, re-review (max 3 loops)
  Phase 5: Ship      — Start service, screenshots, delivery package

Two human gates:
  1. Plan approval (after Phase 1) — confirm the spec before building
  2. Ship approval (after Phase 5) — confirm before marking complete

State persisted to assembly-runs.json for restart resilience.
Not a background loop — triggered via API or Telegram, runs as async tasks.
"""

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx

import config
from audit import log_audit

logger = logging.getLogger("opai-engine.assembly")

# Phase constants
PHASE_INTAKE = 0
PHASE_PLAN = 1
PHASE_BUILD = 2
PHASE_REVIEW = 3
PHASE_ITERATE = 4
PHASE_SHIP = 5

PHASE_NAMES = {
    0: "intake", 1: "plan", 2: "build",
    3: "review", 4: "iterate", 5: "ship",
}


class AssemblyPipeline:
    """Assembly Line — end-to-end build pipeline."""

    def __init__(self, fleet_coordinator, worker_manager, worker_mail):
        self.fleet = fleet_coordinator
        self.workers = worker_manager
        self.mail = worker_mail
        self.runs: dict[str, dict] = {}
        self._active_tasks: dict[str, asyncio.Task] = {}
        self._load_runs()

    # ── Persistence ─────────────────────────────────────────

    def _load_runs(self):
        try:
            if config.ASSEMBLY_RUNS_FILE.is_file():
                data = json.loads(config.ASSEMBLY_RUNS_FILE.read_text())
                if isinstance(data, dict):
                    self.runs = data
                elif isinstance(data, list):
                    self.runs = {r["id"]: r for r in data if "id" in r}
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Failed to load assembly runs: %s", e)

    def _save_runs(self):
        config.ASSEMBLY_RUNS_FILE.parent.mkdir(parents=True, exist_ok=True)
        config.ASSEMBLY_RUNS_FILE.write_text(
            json.dumps(self.runs, indent=2, default=str)
        )

    def _save_run(self, run: dict):
        """Save a single run (updates in-memory dict and persists)."""
        self.runs[run["id"]] = run
        self._save_runs()

    # ── Run Creation ────────────────────────────────────────

    def _generate_id(self) -> str:
        today = datetime.now(timezone.utc).strftime("%Y%m%d")
        existing = [
            r for r in self.runs
            if r.startswith(f"asm-{today}-")
        ]
        seq = len(existing) + 1
        return f"asm-{today}-{seq:03d}"

    def create_run(
        self,
        input_type: str,
        input_text: str,
        input_ref: str | None = None,
        auto_ship: bool = False,
        max_review_iterations: int | None = None,
    ) -> dict:
        """Create a new assembly run and start advancing it."""
        cfg = config.load_orchestrator_config().get("assembly", {})

        if not cfg.get("enabled", True):
            return {"success": False, "error": "Assembly pipeline is disabled"}

        # Check concurrency limit
        active = sum(
            1 for r in self.runs.values()
            if r.get("status") == "running"
        )
        max_concurrent = cfg.get("max_concurrent_runs", 2)
        if active >= max_concurrent:
            return {
                "success": False,
                "error": f"Max concurrent runs ({max_concurrent}) reached",
            }

        run_id = self._generate_id()
        max_iters = max_review_iterations or cfg.get("max_review_iterations", 3)

        run = {
            "id": run_id,
            "status": "running",
            "current_phase": PHASE_INTAKE,
            "phase_status": "starting",
            "input_type": input_type,
            "input_text": input_text,
            "input_ref": input_ref,
            "artifacts": {
                "prd_id": None,
                "prd_text": None,
                "evaluation": None,
                "spec_path": None,
                "project_path": None,
                "project_slug": None,
                "build_dispatches": [],
                "review_results": [],
                "fix_iterations": 0,
                "screenshots": [],
                "delivery_package": None,
            },
            "gates": {
                "plan_approved": None,
                "ship_approved": None,
            },
            "config": {
                "max_review_iterations": max_iters,
                "auto_ship": auto_ship or cfg.get("auto_ship", False),
            },
            "phase_log": [],
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "error": None,
        }

        self._save_run(run)
        self._log_phase(run, "created", f"Assembly run {run_id} created (input_type={input_type})")

        log_audit(
            tier="execution",
            service="assembly",
            event="assembly_created",
            summary=f"Assembly run {run_id} created",
            details={"run_id": run_id, "input_type": input_type},
        )

        # Start advancing in background
        task = asyncio.create_task(self._advance(run_id))
        self._active_tasks[run_id] = task

        return {"success": True, "run_id": run_id, "run": run}

    # ── State Machine ───────────────────────────────────────

    async def _advance(self, run_id: str):
        """Drive the run from current phase to completion or gate."""
        run = self.runs.get(run_id)
        if not run:
            return

        try:
            while run["status"] == "running":
                phase = run["current_phase"]

                if phase == PHASE_INTAKE:
                    await self._phase_intake(run)
                elif phase == PHASE_PLAN:
                    await self._phase_plan(run)
                    if run["phase_status"] == "awaiting_plan_approval":
                        return  # Wait for gate
                elif phase == PHASE_BUILD:
                    await self._phase_build(run)
                elif phase == PHASE_REVIEW:
                    await self._phase_review(run)
                elif phase == PHASE_ITERATE:
                    await self._phase_iterate(run)
                elif phase == PHASE_SHIP:
                    await self._phase_ship(run)
                    if run["phase_status"] == "awaiting_ship_approval":
                        return  # Wait for gate
                    if run["status"] == "completed":
                        return  # Done
                else:
                    run["status"] = "failed"
                    run["error"] = f"Unknown phase: {phase}"
                    self._save_run(run)
                    return

        except Exception as e:
            logger.error("Assembly run %s failed in phase %d: %s", run_id, run.get("current_phase", -1), e)
            run["status"] = "failed"
            run["error"] = str(e)[:500]
            self._log_phase(run, "error", str(e)[:500])
            self._save_run(run)
            await self._notify(f"Assembly [{run_id}] FAILED in phase {PHASE_NAMES.get(run.get('current_phase', -1), '?')}: {str(e)[:200]}")

    def _next_phase(self, run: dict):
        """Advance to the next phase."""
        run["current_phase"] += 1
        run["phase_status"] = "starting"
        run["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._save_run(run)

    def _log_phase(self, run: dict, event: str, detail: str = ""):
        """Append to the phase audit log."""
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "phase": run.get("current_phase", -1),
            "event": event,
            "detail": detail[:500],
        }
        run.setdefault("phase_log", []).append(entry)

    # ── Phase 0: Intake ─────────────────────────────────────

    async def _phase_intake(self, run: dict):
        """Evaluate idea and generate PRD if needed."""
        run["phase_status"] = "evaluating"
        self._log_phase(run, "intake_start")
        self._save_run(run)

        input_type = run["input_type"]
        input_text = run["input_text"]

        if input_type == "idea":
            # Evaluate the idea with PRDgent
            prd_text = await self._generate_prd(input_text)
            run["artifacts"]["prd_text"] = prd_text
            run["artifacts"]["evaluation"] = "generated"
            self._log_phase(run, "prd_generated", f"PRD generated ({len(prd_text)} chars)")

        elif input_type == "prd":
            # Validate the PRD
            validated = await self._validate_spec(input_text)
            run["artifacts"]["prd_text"] = input_text
            run["artifacts"]["evaluation"] = validated
            self._log_phase(run, "prd_validated")

        elif input_type == "spec":
            # Spec provided directly — skip to plan with spec as-is
            run["artifacts"]["prd_text"] = input_text
            run["artifacts"]["evaluation"] = "spec_provided"
            self._log_phase(run, "spec_provided")

        elif input_type == "task_id":
            # Load task from registry
            task = self._load_task(input_text)
            if not task:
                raise RuntimeError(f"Task {input_text} not found in registry")
            run["artifacts"]["prd_text"] = (
                f"# {task.get('title', 'Untitled')}\n\n{task.get('description', '')}"
            )
            run["artifacts"]["evaluation"] = "from_registry"
            run["input_ref"] = input_text
            self._log_phase(run, "task_loaded", task.get("title", ""))

        elif input_type == "project_id":
            # Load existing project PRD
            project_path = config.PROJECTS_DIR / input_text
            prd_path = project_path / "PRD.md"
            if prd_path.is_file():
                run["artifacts"]["prd_text"] = prd_path.read_text()
            else:
                raise RuntimeError(f"No PRD.md found at {prd_path}")
            run["artifacts"]["project_path"] = str(project_path)
            run["artifacts"]["project_slug"] = input_text
            run["artifacts"]["evaluation"] = "existing_project"
            self._log_phase(run, "project_loaded", input_text)

        else:
            raise RuntimeError(f"Unknown input_type: {input_type}")

        await self._notify(f"Assembly [{run['id']}] Phase 0 (Intake) complete — moving to Plan")
        self._next_phase(run)

    async def _generate_prd(self, idea: str) -> str:
        """Generate a PRD from an idea using PRDgent prompts.

        Uses NLM pre-research from organized RAG notebooks to ground the PRD
        with existing system knowledge, saving Claude tokens.
        """
        from claude_api import call_claude

        # NLM pre-research: gather context from organized RAG notebooks
        nlm_context = ""
        try:
            import sys
            sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
            from nlm import is_available, get_client, ask_rag

            if is_available():
                client = await get_client()
                async with client:
                    # Query technical reference for existing capabilities
                    tech_result = await ask_rag(
                        client,
                        f"What existing OPAI tools, APIs, or infrastructure could support this idea: {idea[:200]}",
                        topic_hint="technical api",
                    )
                    if tech_result and len(tech_result.get("answer", "")) > 100:
                        nlm_context += f"\n## Existing System Context\n{tech_result['answer']}\n"

                    # Query agent-ops for relevant patterns
                    ops_result = await ask_rag(
                        client,
                        f"What agent roles, squads, or conventions are relevant to: {idea[:200]}",
                        topic_hint="agent squad",
                    )
                    if ops_result and len(ops_result.get("answer", "")) > 100:
                        nlm_context += f"\n## Agent & Ops Context\n{ops_result['answer']}\n"

                if nlm_context:
                    logger.info("[Assembly] NLM pre-research added %d chars of context for PRD", len(nlm_context))
        except Exception as e:
            logger.debug("[Assembly] NLM pre-research skipped: %s", e)

        # Load PRDgent PRD generation prompt
        prd_prompt_file = config.SCRIPTS_DIR / "prompt_prdgent_prd.txt"
        system_prompt = ""
        if prd_prompt_file.is_file():
            system_prompt = prd_prompt_file.read_text()

        user_prompt = f"Generate a PRD for this idea:\n\n{idea}"
        if nlm_context:
            user_prompt += (
                f"\n\n---\n\n## Pre-Research Context (from OPAI knowledge base)\n"
                f"Use this context to ground the PRD in existing system capabilities:\n{nlm_context}"
            )

        result = await call_claude(
            user_prompt,
            system=system_prompt or "You are PRDgent. Generate a comprehensive Product Requirements Document.",
            model="claude-sonnet-4-6",
            max_tokens=8192,
            timeout=300,
        )
        return result["content"]

    async def _validate_spec(self, text: str) -> str:
        """Validate a PRD/spec using the validation prompt."""
        from claude_api import call_claude

        validate_prompt_file = config.SCRIPTS_DIR / "prompt_prdgent_validate.txt"
        system_prompt = ""
        if validate_prompt_file.is_file():
            system_prompt = validate_prompt_file.read_text()

        result = await call_claude(
            f"Validate this PRD:\n\n{text}",
            system=system_prompt or "Validate this PRD for completeness and clarity.",
            model="claude-sonnet-4-6",
            max_tokens=4096,
            timeout=180,
        )
        return result["content"][:2000]

    def _load_task(self, task_id: str) -> dict | None:
        """Load a task from the registry."""
        try:
            if config.REGISTRY_JSON.is_file():
                registry = json.loads(config.REGISTRY_JSON.read_text())
                tasks = registry.get("tasks", [])
                for t in tasks:
                    if t.get("id") == task_id:
                        return t
        except (json.JSONDecodeError, OSError):
            pass
        return None

    # ── Phase 1: Plan ───────────────────────────────────────

    async def _phase_plan(self, run: dict):
        """Generate SPEC.md, scaffold project, request approval."""
        if run["phase_status"] == "awaiting_plan_approval":
            return  # Already waiting

        run["phase_status"] = "planning"
        self._log_phase(run, "plan_start")
        self._save_run(run)

        prd_text = run["artifacts"].get("prd_text", "")

        # Generate project slug from idea/PRD
        slug = run["artifacts"].get("project_slug")
        if not slug:
            slug = self._generate_slug(prd_text)
            run["artifacts"]["project_slug"] = slug

        # Generate SPEC.md via AI
        spec_text = await self._generate_spec(prd_text, slug)

        # Scaffold project directory
        project_path = config.PROJECTS_DIR / slug
        project_path.mkdir(parents=True, exist_ok=True)

        # Write PRD.md
        prd_path = project_path / "PRD.md"
        prd_path.write_text(prd_text)

        # Write SPEC.md
        spec_path = project_path / "SPEC.md"
        spec_path.write_text(spec_text)

        # Write DEV.md from template
        dev_template = config.OPAI_ROOT / "Templates" / "DEV.template.md"
        if dev_template.is_file():
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            dev_content = dev_template.read_text()
            dev_content = dev_content.replace("{{project_name}}", slug)
            dev_content = dev_content.replace("{{project_slug}}", slug)
            dev_content = dev_content.replace("{{date}}", today)
            dev_content = dev_content.replace("{{prd_id}}", run["id"])
            (project_path / "DEV.md").write_text(dev_content)

        run["artifacts"]["project_path"] = str(project_path)
        run["artifacts"]["spec_path"] = str(spec_path)

        self._log_phase(run, "spec_generated", f"SPEC.md written to {spec_path}")

        # Request plan approval via Telegram
        run["phase_status"] = "awaiting_plan_approval"
        self._save_run(run)

        # Send approval request with buttons
        await self._notify_with_buttons(
            f"*Assembly [{run['id']}] — Plan Ready*\n\n"
            f"Project: `{slug}`\n"
            f"Spec: `{spec_path}`\n\n"
            f"Review the SPEC.md and approve to start building.",
            [
                [
                    {"text": "Approve Plan", "callback_data": f"asm:approve:{run['id']}"},
                    {"text": "Reject", "callback_data": f"asm:reject:{run['id']}"},
                ],
            ],
        )

    async def _generate_spec(self, prd_text: str, slug: str) -> str:
        """Generate SPEC.md from PRD using the assembly spec prompt.

        Uses NLM pre-research from Technical Reference notebook to ground the
        spec with real API endpoints, file paths, and infrastructure details.
        """
        from claude_api import call_claude

        # NLM pre-research: gather technical context for better specs
        nlm_context = ""
        try:
            import sys
            sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
            from nlm import is_available, get_client, ask_rag

            if is_available():
                client = await get_client()
                async with client:
                    # Query technical reference for relevant APIs and architecture
                    tech_result = await ask_rag(
                        client,
                        (f"What are the relevant API endpoints, file paths, services, "
                         f"and technical details for building: {prd_text[:300]}"),
                        topic_hint="technical api deploy",
                    )
                    if tech_result and len(tech_result.get("answer", "")) > 100:
                        nlm_context = tech_result["answer"]
                        logger.info("[Assembly] NLM pre-research added %d chars for SPEC", len(nlm_context))
        except Exception as e:
            logger.debug("[Assembly] NLM pre-research for spec skipped: %s", e)

        cfg = config.load_orchestrator_config().get("assembly", {})
        model = cfg.get("spec_generator_model", "sonnet")
        if model == "sonnet":
            model = "claude-sonnet-4-6"

        prompt_file = config.SCRIPTS_DIR / "prompt_assembly_spec.txt"
        system_prompt = ""
        if prompt_file.is_file():
            system_prompt = prompt_file.read_text()

        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        user_prompt = f"Project slug: {slug}\nDate: {today}\n\n## PRD\n\n{prd_text}"
        if nlm_context:
            user_prompt += (
                f"\n\n---\n\n## Technical Context (from OPAI knowledge base)\n"
                f"Use these real endpoints, file paths, and architecture details:\n\n{nlm_context}"
            )

        result = await call_claude(
            user_prompt,
            system=system_prompt,
            model=model,
            max_tokens=16384,
            timeout=600,
        )
        return result["content"]

    def _generate_slug(self, text: str) -> str:
        """Generate a project slug from text."""
        import re
        # Extract first meaningful line
        first_line = ""
        for line in text.split("\n"):
            line = line.strip().lstrip("#").strip()
            if line and len(line) > 3:
                first_line = line
                break

        if not first_line:
            first_line = text[:50]

        # Convert to slug
        slug = re.sub(r'[^a-z0-9\s-]', '', first_line.lower())
        slug = re.sub(r'[\s]+', '-', slug.strip())
        slug = slug[:40].rstrip('-')
        return slug or f"project-{int(time.time()) % 10000}"

    # ── Phase 2: Build ──────────────────────────────────────

    async def _phase_build(self, run: dict):
        """Dispatch build task via Fleet Coordinator."""
        run["phase_status"] = "building"
        self._log_phase(run, "build_start")
        self._save_run(run)

        slug = run["artifacts"]["project_slug"]
        project_path = run["artifacts"]["project_path"]

        # Create a task in the registry for the fleet to pick up
        task_id = f"asm-build-{run['id']}"
        task = {
            "id": task_id,
            "title": f"Build project: {slug}",
            "description": (
                f"Build the project at {project_path} according to its SPEC.md.\n"
                f"PRD.md and SPEC.md are already in the project directory.\n"
                f"Implement all Phase 1 (MVP) features from the spec."
            ),
            "priority": "high",
            "status": "approved",
            "source": "assembly",
            "assembly_run_id": run["id"],
            "routing": {"agentType": "project-lead"},
            "created_at": datetime.now(timezone.utc).isoformat(),
            "context": {
                "project_path": project_path,
                "project_slug": slug,
            },
        }

        self._write_task_to_registry(task)
        run["artifacts"]["build_dispatches"].append({
            "task_id": task_id,
            "dispatched_at": datetime.now(timezone.utc).isoformat(),
        })
        self._save_run(run)

        await self._notify(f"Assembly [{run['id']}] Phase 2 (Build) — task `{task_id}` dispatched to fleet")

        # Poll for completion
        completed = await self._poll_task_completion(task_id, run, timeout_minutes=30)

        if completed:
            self._log_phase(run, "build_complete", f"Build task {task_id} completed")
            self._next_phase(run)
        else:
            raise RuntimeError(f"Build task {task_id} timed out or failed")

    # ── Phase 3: Review ─────────────────────────────────────

    async def _phase_review(self, run: dict):
        """Dispatch review task via Fleet Coordinator."""
        run["phase_status"] = "reviewing"
        self._log_phase(run, "review_start")
        self._save_run(run)

        slug = run["artifacts"]["project_slug"]
        project_path = run["artifacts"]["project_path"]

        task_id = f"asm-review-{run['id']}-{run['artifacts']['fix_iterations']}"
        task = {
            "id": task_id,
            "title": f"Review project: {slug}",
            "description": (
                f"Review the project at {project_path}.\n"
                f"Check against SPEC.md for completeness.\n"
                f"Categorize findings as P0 (critical), P1 (major), or P2 (minor).\n"
                f"Output a JSON array of findings with: severity, category, description, file, line, suggestion."
            ),
            "priority": "high",
            "status": "approved",
            "source": "assembly",
            "assembly_run_id": run["id"],
            "routing": {"agentType": "project-reviewer"},
            "created_at": datetime.now(timezone.utc).isoformat(),
            "context": {
                "project_path": project_path,
                "project_slug": slug,
            },
        }

        self._write_task_to_registry(task)
        self._save_run(run)

        await self._notify(f"Assembly [{run['id']}] Phase 3 (Review) — dispatched reviewer")

        # Poll for completion
        completed = await self._poll_task_completion(task_id, run, timeout_minutes=15)

        if not completed:
            raise RuntimeError(f"Review task {task_id} timed out or failed")

        # Parse review results from completions
        findings = self._extract_review_findings(task_id)
        run["artifacts"]["review_results"].append({
            "iteration": run["artifacts"]["fix_iterations"],
            "findings": findings,
            "reviewed_at": datetime.now(timezone.utc).isoformat(),
        })
        self._save_run(run)

        # Check for P0/P1 findings
        critical_findings = [
            f for f in findings
            if f.get("severity") in ("P0", "P1")
        ]

        if critical_findings and run["artifacts"]["fix_iterations"] < run["config"]["max_review_iterations"]:
            self._log_phase(run, "review_findings", f"{len(critical_findings)} P0/P1 findings — entering fix cycle")
            self._next_phase(run)  # → Phase 4 (Iterate)
        else:
            if critical_findings:
                self._log_phase(run, "review_max_iterations", f"Max iterations reached with {len(critical_findings)} remaining findings")
            else:
                self._log_phase(run, "review_passed", "No P0/P1 findings")

            # Skip Phase 4, go to Phase 5 (Ship)
            run["current_phase"] = PHASE_SHIP
            run["phase_status"] = "starting"
            self._save_run(run)

    def _extract_review_findings(self, task_id: str) -> list[dict]:
        """Extract review findings from fleet completion data."""
        completions = self.fleet.state.get("recent_completions", [])
        for c in completions:
            if c.get("task_id") == task_id:
                # Try to parse findings from output summary
                summary = c.get("output_summary", "")
                try:
                    # Attempt JSON parse from the summary
                    import re
                    json_match = re.search(r'\[[\s\S]*\]', summary)
                    if json_match:
                        return json.loads(json_match.group())
                except (json.JSONDecodeError, ValueError):
                    pass

                # Check report directory for detailed output
                report_dir = c.get("report_dir", "")
                if report_dir:
                    review_file = Path(report_dir) / "review.json"
                    if review_file.is_file():
                        try:
                            return json.loads(review_file.read_text())
                        except (json.JSONDecodeError, OSError):
                            pass

        return []

    # ── Phase 4: Iterate ────────────────────────────────────

    async def _phase_iterate(self, run: dict):
        """Generate fix specs from review findings, dispatch fixes, re-review."""
        run["phase_status"] = "fixing"
        run["artifacts"]["fix_iterations"] += 1
        iteration = run["artifacts"]["fix_iterations"]
        self._log_phase(run, "iterate_start", f"Fix iteration {iteration}")
        self._save_run(run)

        # Get latest review findings
        latest_review = run["artifacts"]["review_results"][-1] if run["artifacts"]["review_results"] else {}
        findings = latest_review.get("findings", [])
        critical_findings = [f for f in findings if f.get("severity") in ("P0", "P1")]

        if not critical_findings:
            # No fixes needed, skip to ship
            run["current_phase"] = PHASE_SHIP
            run["phase_status"] = "starting"
            self._save_run(run)
            return

        # Generate fix specs via AI
        fix_specs = await self._generate_fix_specs(run, critical_findings)

        # Dispatch fix task
        slug = run["artifacts"]["project_slug"]
        project_path = run["artifacts"]["project_path"]
        task_id = f"asm-fix-{run['id']}-{iteration}"

        fix_description = json.dumps(fix_specs, indent=2) if isinstance(fix_specs, (dict, list)) else str(fix_specs)

        task = {
            "id": task_id,
            "title": f"Fix issues in {slug} (iteration {iteration})",
            "description": (
                f"Apply these fixes to the project at {project_path}:\n\n{fix_description}"
            ),
            "priority": "high",
            "status": "approved",
            "source": "assembly",
            "assembly_run_id": run["id"],
            "routing": {"agentType": "project-lead"},
            "created_at": datetime.now(timezone.utc).isoformat(),
            "context": {
                "project_path": project_path,
                "project_slug": slug,
                "fix_iteration": iteration,
            },
        }

        self._write_task_to_registry(task)
        self._save_run(run)

        await self._notify(
            f"Assembly [{run['id']}] Phase 4 (Iterate #{iteration}) — "
            f"fixing {len(critical_findings)} P0/P1 issues"
        )

        # Poll for fix completion
        completed = await self._poll_task_completion(task_id, run, timeout_minutes=30)

        if not completed:
            raise RuntimeError(f"Fix task {task_id} timed out or failed")

        self._log_phase(run, "fixes_applied", f"Iteration {iteration} fixes applied")

        # Go back to Review
        run["current_phase"] = PHASE_REVIEW
        run["phase_status"] = "starting"
        self._save_run(run)

    async def _generate_fix_specs(self, run: dict, findings: list[dict]) -> dict:
        """Generate fix specifications from review findings."""
        from claude_api import call_claude

        cfg = config.load_orchestrator_config().get("assembly", {})
        model = cfg.get("fix_generator_model", "sonnet")
        if model == "sonnet":
            model = "claude-sonnet-4-6"

        prompt_file = config.SCRIPTS_DIR / "prompt_assembly_fix.txt"
        system_prompt = ""
        if prompt_file.is_file():
            system_prompt = prompt_file.read_text()

        slug = run["artifacts"]["project_slug"]
        project_path = run["artifacts"]["project_path"]

        result = await call_claude(
            f"Project: {slug}\nProject path: {project_path}\n\n"
            f"Review findings:\n{json.dumps(findings, indent=2)}",
            system=system_prompt,
            model=model,
            max_tokens=8192,
            expect_json=True,
            timeout=300,
        )
        return result.get("parsed") or result["content"]

    # ── Phase 5: Ship ───────────────────────────────────────

    async def _phase_ship(self, run: dict):
        """Start service, take screenshots, generate delivery package."""
        if run["phase_status"] == "awaiting_ship_approval":
            return  # Already waiting

        run["phase_status"] = "shipping"
        self._log_phase(run, "ship_start")
        self._save_run(run)

        slug = run["artifacts"]["project_slug"]
        project_path = run["artifacts"]["project_path"]

        # Take screenshots via browser service if available
        screenshots = await self._capture_screenshots(run)
        run["artifacts"]["screenshots"] = screenshots

        # Generate delivery package
        delivery = await self._generate_delivery(run)
        run["artifacts"]["delivery_package"] = delivery

        # Write DELIVERY.md to project
        if project_path:
            delivery_path = Path(project_path) / "DELIVERY.md"
            delivery_path.write_text(delivery)
            self._log_phase(run, "delivery_written", str(delivery_path))

        self._save_run(run)

        # Check auto-ship
        if run["config"].get("auto_ship"):
            run["gates"]["ship_approved"] = True
            run["status"] = "completed"
            run["phase_status"] = "shipped"
            self._log_phase(run, "auto_shipped", "Auto-ship enabled — marking complete")
            self._save_run(run)

            await self._notify(
                f"Assembly [{run['id']}] COMPLETED (auto-shipped)\n\n"
                f"Project: `{slug}`\n"
                f"Path: `{project_path}`\n"
                f"Screenshots: {len(screenshots)}"
            )
            return

        # Request ship approval
        run["phase_status"] = "awaiting_ship_approval"
        self._save_run(run)

        review_summary = ""
        if run["artifacts"]["review_results"]:
            latest = run["artifacts"]["review_results"][-1]
            findings = latest.get("findings", [])
            review_summary = f"Review: {len(findings)} findings ({run['artifacts']['fix_iterations']} fix iterations)\n"

        await self._notify_with_buttons(
            f"*Assembly [{run['id']}] — Ready to Ship*\n\n"
            f"Project: `{slug}`\n"
            f"Path: `{project_path}`\n"
            f"{review_summary}"
            f"Screenshots: {len(screenshots)}\n\n"
            f"Approve to mark as complete.",
            [
                [
                    {"text": "Ship It", "callback_data": f"asm:ship:{run['id']}"},
                    {"text": "Abort", "callback_data": f"asm:abort:{run['id']}"},
                ],
            ],
        )

    async def _capture_screenshots(self, run: dict) -> list[str]:
        """Capture screenshots via the browser service (port 8107)."""
        screenshots = []
        project_path = run["artifacts"].get("project_path", "")

        cfg = config.load_orchestrator_config().get("assembly", {})
        timeout = cfg.get("screenshot_timeout_seconds", 30)

        # Check if browser service is available
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.get("http://127.0.0.1:8107/health")
                if resp.status_code != 200:
                    self._log_phase(run, "screenshot_skip", "Browser service not available")
                    return []
        except Exception:
            self._log_phase(run, "screenshot_skip", "Browser service unreachable")
            return []

        # Try to screenshot the project if it has a running service
        # This is best-effort — not all projects have a web UI
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    "http://127.0.0.1:8107/api/screenshot",
                    json={"url": f"http://127.0.0.1:8080", "format": "png"},
                )
                if resp.status_code == 200:
                    screenshot_dir = Path(project_path) / "screenshots"
                    screenshot_dir.mkdir(exist_ok=True)
                    screenshot_path = screenshot_dir / "main.png"
                    screenshot_path.write_bytes(resp.content)
                    screenshots.append(str(screenshot_path))
                    self._log_phase(run, "screenshot_captured", str(screenshot_path))
        except Exception as e:
            self._log_phase(run, "screenshot_error", str(e)[:200])

        return screenshots

    async def _generate_delivery(self, run: dict) -> str:
        """Generate the delivery package markdown."""
        from claude_api import call_claude

        cfg = config.load_orchestrator_config().get("assembly", {})
        model = cfg.get("delivery_packager_model", "sonnet")
        if model == "sonnet":
            model = "claude-sonnet-4-6"

        prompt_file = config.SCRIPTS_DIR / "prompt_assembly_delivery.txt"
        system_prompt = ""
        if prompt_file.is_file():
            system_prompt = prompt_file.read_text()

        slug = run["artifacts"]["project_slug"]
        project_path = run["artifacts"]["project_path"]
        prd_summary = (run["artifacts"].get("prd_text") or "")[:2000]
        review_results = run["artifacts"].get("review_results", [])
        screenshots = run["artifacts"].get("screenshots", [])
        fix_iterations = run["artifacts"].get("fix_iterations", 0)

        context = (
            f"Project: {slug}\n"
            f"Path: {project_path}\n"
            f"Created: {run.get('created_at', '')}\n"
            f"Fix iterations: {fix_iterations}\n"
            f"Screenshot count: {len(screenshots)}\n\n"
            f"## PRD Summary\n{prd_summary}\n\n"
            f"## Review Results\n{json.dumps(review_results, indent=2, default=str)[:3000]}"
        )

        result = await call_claude(
            context,
            system=system_prompt,
            model=model,
            max_tokens=8192,
            timeout=300,
        )
        return result["content"]

    # ── Gate Handling ────────────────────────────────────────

    def approve_gate(self, run_id: str, gate: str) -> dict:
        """Approve a gate (plan or ship)."""
        run = self.runs.get(run_id)
        if not run:
            return {"success": False, "error": "Run not found"}

        if gate == "plan":
            if run["phase_status"] != "awaiting_plan_approval":
                return {"success": False, "error": "Not waiting for plan approval"}
            run["gates"]["plan_approved"] = True
            run["phase_status"] = "approved"
            self._log_phase(run, "plan_approved")
            self._next_phase(run)  # → Phase 2 (Build)
            self._save_run(run)

            # Resume advancing
            task = asyncio.create_task(self._advance(run_id))
            self._active_tasks[run_id] = task

            log_audit(
                tier="execution", service="assembly",
                event="plan_approved", summary=f"Plan approved for {run_id}",
            )
            return {"success": True, "phase": run["current_phase"]}

        elif gate == "ship":
            if run["phase_status"] != "awaiting_ship_approval":
                return {"success": False, "error": "Not waiting for ship approval"}
            run["gates"]["ship_approved"] = True
            run["status"] = "completed"
            run["phase_status"] = "shipped"
            run["updated_at"] = datetime.now(timezone.utc).isoformat()
            self._log_phase(run, "ship_approved")
            self._save_run(run)

            log_audit(
                tier="execution", service="assembly",
                event="ship_approved", summary=f"Ship approved for {run_id}",
            )
            return {"success": True, "status": "completed"}

        return {"success": False, "error": f"Unknown gate: {gate}"}

    def reject_gate(self, run_id: str, gate: str) -> dict:
        """Reject a gate — abort the run."""
        run = self.runs.get(run_id)
        if not run:
            return {"success": False, "error": "Run not found"}

        run["status"] = "aborted"
        run["phase_status"] = f"{gate}_rejected"
        run["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._log_phase(run, f"{gate}_rejected")
        self._save_run(run)

        log_audit(
            tier="execution", service="assembly",
            event=f"{gate}_rejected", summary=f"{gate} rejected for {run_id}",
        )
        return {"success": True, "status": "aborted"}

    def abort_run(self, run_id: str) -> dict:
        """Abort a run."""
        run = self.runs.get(run_id)
        if not run:
            return {"success": False, "error": "Run not found"}

        if run["status"] in ("completed", "aborted"):
            return {"success": False, "error": f"Run already {run['status']}"}

        run["status"] = "aborted"
        run["phase_status"] = "aborted"
        run["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._log_phase(run, "aborted")
        self._save_run(run)

        # Cancel active task if running
        task = self._active_tasks.pop(run_id, None)
        if task and not task.done():
            task.cancel()

        log_audit(
            tier="execution", service="assembly",
            event="assembly_aborted", summary=f"Assembly {run_id} aborted",
        )
        return {"success": True, "status": "aborted"}

    # ── Resume (restart resilience) ─────────────────────────

    def resume_active_runs(self):
        """Resume any runs that were active when Engine restarted.

        Called from app.py lifespan. Only resumes runs that are
        actively running (not waiting on gates).
        """
        resumed = 0
        for run_id, run in self.runs.items():
            if run.get("status") != "running":
                continue
            if run.get("phase_status", "").startswith("awaiting_"):
                logger.info("Assembly %s waiting on gate — not resuming", run_id)
                continue

            logger.info("Resuming assembly run %s (phase=%d)", run_id, run.get("current_phase", -1))
            task = asyncio.create_task(self._advance(run_id))
            self._active_tasks[run_id] = task
            resumed += 1

        if resumed:
            logger.info("Resumed %d assembly run(s)", resumed)

    # ── Task Registry Helpers ───────────────────────────────

    def _write_task_to_registry(self, task: dict):
        """Write a task to the registry for fleet pickup."""
        try:
            if config.REGISTRY_JSON.is_file():
                registry = json.loads(config.REGISTRY_JSON.read_text())
            else:
                registry = {"tasks": []}

            tasks = registry.get("tasks", [])

            # Remove existing task with same ID if any
            tasks = [t for t in tasks if t.get("id") != task["id"]]
            tasks.append(task)

            registry["tasks"] = tasks
            config.REGISTRY_JSON.write_text(json.dumps(registry, indent=2, default=str))

        except (json.JSONDecodeError, OSError) as e:
            logger.error("Failed to write task to registry: %s", e)
            raise

    async def _poll_task_completion(
        self, task_id: str, run: dict, timeout_minutes: int = 30
    ) -> bool:
        """Poll fleet completions for a task. Returns True if completed."""
        deadline = time.time() + (timeout_minutes * 60)
        poll_interval = 30  # seconds

        while time.time() < deadline:
            if run["status"] != "running":
                return False  # Run was aborted

            # Check fleet completions
            completions = self.fleet.state.get("recent_completions", [])
            for c in completions:
                if c.get("task_id") == task_id:
                    status = c.get("status", "")
                    if status in ("completed", "review"):
                        return True
                    elif status == "failed":
                        logger.warning("Task %s failed in fleet", task_id)
                        return False

            # Check if task is still in registry (might have been processed)
            task = self._load_task(task_id)
            if task and task.get("status") == "completed":
                return True
            if task and task.get("status") == "failed":
                return False

            await asyncio.sleep(poll_interval)

        logger.warning("Task %s timed out after %d minutes", task_id, timeout_minutes)
        return False

    # ── Notifications ───────────────────────────────────────

    async def _notify(self, text: str):
        """Send a Telegram notification (best-effort)."""
        try:
            from background.notifier import send_telegram
            await send_telegram(text)
        except Exception as e:
            logger.warning("Assembly notification failed: %s", e)

    async def _notify_with_buttons(self, text: str, buttons: list):
        """Send a Telegram notification with inline keyboard buttons."""
        try:
            from background.notifier import send_telegram_with_buttons, _hitl_thread_id
            await send_telegram_with_buttons(
                text, buttons, parse_mode="Markdown", thread_id=_hitl_thread_id,
            )
        except Exception as e:
            logger.warning("Assembly button notification failed: %s", e)

    # ── Status / Stats ──────────────────────────────────────

    def get_runs(self, status: str | None = None, limit: int = 50) -> list[dict]:
        """Get runs, optionally filtered by status."""
        runs = sorted(
            self.runs.values(),
            key=lambda r: r.get("created_at", ""),
            reverse=True,
        )
        if status:
            runs = [r for r in runs if r.get("status") == status]
        return runs[:limit]

    def get_run(self, run_id: str) -> dict | None:
        return self.runs.get(run_id)

    def get_stats(self) -> dict:
        """Pipeline statistics."""
        all_runs = list(self.runs.values())
        return {
            "total_runs": len(all_runs),
            "running": sum(1 for r in all_runs if r.get("status") == "running"),
            "completed": sum(1 for r in all_runs if r.get("status") == "completed"),
            "failed": sum(1 for r in all_runs if r.get("status") == "failed"),
            "aborted": sum(1 for r in all_runs if r.get("status") == "aborted"),
            "paused": sum(
                1 for r in all_runs
                if r.get("status") == "running"
                and r.get("phase_status", "").startswith("awaiting_")
            ),
        }
