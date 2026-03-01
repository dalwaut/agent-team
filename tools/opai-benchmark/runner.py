#!/usr/bin/env python3
"""OPAI Benchmark Runner — TUI with animated progress.

Usage:
    python3 tools/opai-benchmark/runner.py                          # all scenarios, baseline
    python3 tools/opai-benchmark/runner.py --scenario teamhub-*     # glob match
    python3 tools/opai-benchmark/runner.py --config with-examples   # named config
    python3 tools/opai-benchmark/runner.py --list                   # list scenarios
    python3 tools/opai-benchmark/runner.py --runs 3                 # repeat each N times
    python3 tools/opai-benchmark/runner.py --quiet                  # no TUI, plain output
"""

import argparse
import asyncio
import fnmatch
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Allow running from repo root
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))

from harness import invoke_claude, score_tool_accuracy, score_param_accuracy, ScenarioConfig, estimate_tokens_from_cost

SCENARIOS_DIR = Path(__file__).parent / "scenarios"
CONFIGS_DIR = Path(__file__).parent / "configs"
RESULTS_DIR = Path(__file__).parent / "results"

# ── ANSI escape codes ────────────────────────────────────────────────────────
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"
RED = "\033[91m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
BLUE = "\033[94m"
MAGENTA = "\033[95m"
CYAN = "\033[96m"
WHITE = "\033[97m"
BG_BLUE = "\033[44m"
BG_GREEN = "\033[42m"
BG_RED = "\033[41m"
BG_YELLOW = "\033[43m"
CLEAR_LINE = "\033[2K"
CURSOR_UP = "\033[A"
HIDE_CURSOR = "\033[?25l"
SHOW_CURSOR = "\033[?25h"

# ── Playful elements ─────────────────────────────────────────────────────────
SPINNER_FRAMES = ["[    ]", "[=   ]", "[==  ]", "[=== ]", "[ ===]", "[  ==]", "[   =]", "[    ]"]
MUSIC_NOTES = ["", "", "", "", "", "", "", ""]
INSTRUMENTS = {
    "teamhub": ("Violin", ""),
    "prd": ("Cello", ""),
    "brain": ("Piano", ""),
    "email": ("Flute", ""),
    "discord": ("Trumpet", ""),
    "plain": ("Tuning Fork", ""),
    "default": ("Instrument", ""),
}

BANNER = f"""{CYAN}{BOLD}
    ___  ____  ___    ____
   / _ \\|  _ \\/ _ \\  |_ _|
  | | | | |_) | | | |  | |
  | |_| |  __/| |_| |  | |
   \\___/|_|    \\___/  |___|

  {MAGENTA}B E N C H M A R K   S U I T E{RESET}
  {DIM}Tuning the Orchestra{RESET}
"""

WARMUP_ART = f"""{YELLOW}
    ,-.
   / \\  `.  __..-,O    Musicians warming up...
  :   \\ --''_..-'.'
  |    . .-' `. '.
  :     .     .`.'
   \\     `.  /  ..
    \\      `.   ' .
     `,       `.   \\
    ,|,`.        `-.\\
   '.||  ``-....--.`
    |  |
    |__|
    /||\\
   //||\\\\
  // || \\\\{RESET}
"""

FINALE_PASS = f"""{GREEN}{BOLD}
   ___                       _
  | _ ) _ _ __ ___ _____ ___| |
  | _ \\| '_/ _` \\ V / _ \\___| |
  |___/|_| \\__,_|\\_/\\___/   |_|
{RESET}"""

FINALE_MIXED = f"""{YELLOW}{BOLD}
   _  _     _          ___
  | \\| |___| |_ ___ __| _ ) __ _ __| |
  | .` / _ \\  _|___| _ \\/ _` / _` |_|
  |_|\\_\\___/\\__|  |___/\\__,_\\__,_(_)
{RESET}"""


def get_term_width() -> int:
    return shutil.get_terminal_size((80, 24)).columns


def get_instrument(scenario_name: str) -> tuple:
    """Map scenario name to a musical instrument."""
    for key, val in INSTRUMENTS.items():
        if key in scenario_name.lower():
            return val
    return INSTRUMENTS["default"]


def progress_bar(current: int, total: int, width: int = 30, label: str = "") -> str:
    """Render a progress bar with percentage."""
    pct = current / total if total > 0 else 0
    filled = int(width * pct)
    bar = f"{GREEN}{'=' * filled}{DIM}{'-' * (width - filled)}{RESET}"
    note = MUSIC_NOTES[current % len(MUSIC_NOTES)]
    return f"  {note} [{bar}] {pct*100:5.1f}%  {DIM}{label}{RESET}"


def status_icon(result: dict) -> str:
    """Get a status icon for a completed scenario."""
    if result["metrics"].get("is_error"):
        return f"{RED}X{RESET}"
    if result["scoring"]["success"]:
        return f"{GREEN}*{RESET}"
    return f"{YELLOW}~{RESET}"


def format_tokens(n: int) -> str:
    if n >= 1000:
        return f"{n/1000:.1f}K"
    return str(n)


def format_time(ms: int) -> str:
    if ms >= 1000:
        return f"{ms/1000:.1f}s"
    return f"{ms}ms"


def format_cost(usd: float) -> str:
    if usd == 0:
        return "--"
    if usd < 0.001:
        return f"${usd:.5f}"
    return f"${usd:.4f}"


# ── TUI state ────────────────────────────────────────────────────────────────

class BenchmarkTUI:
    """Terminal UI for benchmark progress."""

    def __init__(self, scenarios: list, config_name: str, num_runs: int, quiet: bool = False):
        self.scenarios = scenarios
        self.config_name = config_name
        self.num_runs = num_runs
        self.quiet = quiet
        self.total_tasks = len(scenarios) * num_runs
        self.completed = 0
        self.results = []
        self.current_scenario = ""
        self.start_time = 0
        self.spinner_idx = 0

    def print_banner(self):
        if self.quiet:
            return
        print(BANNER)
        w = get_term_width()
        print(f"  {DIM}{'=' * min(w - 4, 60)}{RESET}")
        print(f"  {BOLD}Config:{RESET}    {CYAN}{self.config_name}{RESET}")
        print(f"  {BOLD}Scenarios:{RESET} {len(self.scenarios)}")
        print(f"  {BOLD}Runs each:{RESET} {self.num_runs}")
        print(f"  {BOLD}Total:{RESET}     {self.total_tasks} invocations")
        print(f"  {DIM}{'=' * min(w - 4, 60)}{RESET}")
        print()

    def print_warmup(self):
        if self.quiet:
            return
        print(WARMUP_ART)
        time.sleep(0.3)

    def start_scenario(self, name: str, run_idx: int):
        self.current_scenario = name
        inst_name, inst_icon = get_instrument(name)
        if self.quiet:
            print(f"  [{self.completed + 1}/{self.total_tasks}] {name} (run {run_idx + 1})...", end=" ", flush=True)
        else:
            spinner = SPINNER_FRAMES[self.spinner_idx % len(SPINNER_FRAMES)]
            self.spinner_idx += 1
            elapsed = time.monotonic() - self.start_time if self.start_time else 0
            print(f"\r{CLEAR_LINE}", end="")
            print(f"  {CYAN}{inst_icon} {inst_name}{RESET} performing: {BOLD}{name}{RESET} (run {run_idx + 1})")
            print(progress_bar(self.completed, self.total_tasks, label=f"{elapsed:.0f}s elapsed"), flush=True)

    def finish_scenario(self, result: dict):
        self.completed += 1
        self.results.append(result)
        icon = status_icon(result)
        name = result["scenario"]
        m = result["metrics"]
        tok = format_tokens(m["total_tokens"])
        wall = format_time(m["wall_time_ms"])

        if self.quiet:
            status = "PASS" if result["scoring"]["success"] else ("ERROR" if m["is_error"] else "FAIL")
            print(f"{status} ({wall}, {tok} tok)")
        else:
            # Overwrite the progress bar line
            print(f"\r{CURSOR_UP}{CLEAR_LINE}", end="")
            print(f"\r{CURSOR_UP}{CLEAR_LINE}", end="")
            status_text = f"{GREEN}PASS{RESET}" if result["scoring"]["success"] else (f"{RED}ERROR{RESET}" if m["is_error"] else f"{YELLOW}FAIL{RESET}")
            print(f"  {icon} {name:<35} {status_text}  {DIM}{tok} tok | {wall}{RESET}")
            # New progress bar
            elapsed = time.monotonic() - self.start_time
            remaining = (elapsed / self.completed * (self.total_tasks - self.completed)) if self.completed > 0 else 0
            label = f"{elapsed:.0f}s elapsed, ~{remaining:.0f}s remaining"
            print(progress_bar(self.completed, self.total_tasks, label=label), flush=True)

    def print_results_table(self, aggregate: dict):
        by_scenario = aggregate.get("by_scenario", {})
        overall = aggregate.get("overall", {})
        w = min(get_term_width(), 100)

        print()
        print(f"  {BOLD}{BG_BLUE}{WHITE} RESULTS SCOREBOARD {RESET}")
        print(f"  {DIM}{'=' * (w - 4)}{RESET}")
        print(
            f"  {BOLD}{'Scenario':<30} {'~Tokens':>8} {'Time':>7} "
            f"{'Cost':>9} {'Tools':>7} {'Pass':>6}{RESET}"
        )
        print(f"  {DIM}{'-' * 30} {'-' * 8} {'-' * 7} {'-' * 9} {'-' * 7} {'-' * 6}{RESET}")

        for name, stats in by_scenario.items():
            eff = int(stats.get("avg_effective_tokens", 0))
            tok_str = format_tokens(eff)
            # Mark estimated tokens with ~ prefix
            is_estimated = stats.get("avg_total_tokens", 0) == 0 and eff > 0
            tok_display = f"~{tok_str}" if is_estimated else tok_str
            wall = format_time(int(stats["avg_wall_time_ms"]))
            cost = format_cost(stats["avg_cost_usd"])
            tool_pct = f"{stats['avg_tool_accuracy'] * 100:.0f}%"
            pass_pct = f"{stats['success_rate'] * 100:.0f}%"

            pass_color = GREEN if stats["success_rate"] == 1.0 else (YELLOW if stats["success_rate"] > 0 else RED)
            print(
                f"  {name:<30} {tok_display:>8} {wall:>7} "
                f"{cost:>9} {tool_pct:>7} {pass_color}{pass_pct:>6}{RESET}"
            )

        print(f"  {DIM}{'-' * 30} {'-' * 8} {'-' * 7} {'-' * 9} {'-' * 7} {'-' * 6}{RESET}")

        o_eff = int(overall.get("avg_effective_tokens", 0))
        o_tok_str = format_tokens(o_eff)
        o_is_est = overall.get("avg_total_tokens", 0) == 0 and o_eff > 0
        o_tok_display = f"~{o_tok_str}" if o_is_est else o_tok_str
        o_wall = format_time(int(overall.get("avg_wall_time_ms", 0)))
        o_cost = format_cost(overall.get("avg_cost_usd", 0))
        o_tool = f"{overall.get('avg_tool_accuracy', 0) * 100:.0f}%"
        o_pass = f"{overall.get('success_rate', 0) * 100:.0f}%"
        print(
            f"  {BOLD}{'OVERALL':<30} {o_tok_display:>8} {o_wall:>7} "
            f"{o_cost:>9} {o_tool:>7} {o_pass:>6}{RESET}"
        )
        print(f"  {DIM}{'=' * (w - 4)}{RESET}")
        if o_is_est:
            print(f"  {DIM}~ = estimated from cost (Sonnet $6/M blended){RESET}")

    def print_finale(self, aggregate: dict):
        if self.quiet:
            return
        overall = aggregate.get("overall", {})
        rate = overall.get("success_rate", 0)
        elapsed = time.monotonic() - self.start_time

        print()
        if rate == 1.0:
            print(FINALE_PASS)
            print(f"  {GREEN}All scenarios passed!{RESET}")
        elif rate > 0:
            print(FINALE_MIXED)
            print(f"  {YELLOW}Some scenarios need attention.{RESET}")
        else:
            print(f"\n  {RED}{BOLD}All scenarios failed.{RESET}")

        print(f"  {DIM}Completed in {elapsed:.1f}s{RESET}")
        print()


# ── Core logic ────────────────────────────────────────────────────────────────

def load_scenarios(pattern: str = "*") -> list:
    scenarios = []
    for f in sorted(SCENARIOS_DIR.glob("*.json")):
        if fnmatch.fnmatch(f.stem, pattern):
            try:
                data = json.loads(f.read_text())
                data["_file"] = f.name
                scenarios.append(data)
            except (json.JSONDecodeError, OSError) as e:
                print(f"  [WARN] Skipping {f.name}: {e}")
    return scenarios


def load_config(name: str) -> dict:
    if name == "baseline":
        return {}
    path = CONFIGS_DIR / f"{name}.json"
    if not path.exists():
        print(f"  [ERROR] Config not found: {path}")
        sys.exit(1)
    return json.loads(path.read_text())


def build_scenario_config(scenario: dict, config_overrides: dict) -> ScenarioConfig:
    prompt = scenario.get("prompt", scenario.get("input", ""))
    model = config_overrides.get("model") or scenario.get("model")
    max_turns = config_overrides.get("max_turns", scenario.get("max_turns", 5))
    system_prompt = config_overrides.get("system_prompt") or scenario.get("system_prompt")
    timeout = scenario.get("timeout", 120)
    cwd = scenario.get("cwd", "/workspace/synced/opai")
    mcp = scenario.get("mcp_config")
    if config_overrides.get("mcp_config"):
        mcp = config_overrides["mcp_config"]
    allowed = config_overrides.get("allowed_tools") or scenario.get("allowed_tools")

    return ScenarioConfig(
        prompt=prompt,
        model=model,
        max_turns=max_turns,
        system_prompt=system_prompt,
        mcp_config=mcp,
        allowed_tools=allowed,
        timeout=timeout,
        cwd=cwd,
    )


async def run_scenario(scenario: dict, config_overrides: dict, run_index: int = 0) -> dict:
    name = scenario.get("name", scenario.get("_file", "unknown"))
    cfg = build_scenario_config(scenario, config_overrides)
    metrics = await invoke_claude(cfg)

    expected_tools = scenario.get("expected_tools", [])
    actual_tool_names = [t["name"] if isinstance(t, dict) else t for t in metrics.tools_called]
    tool_acc = score_tool_accuracy(expected_tools, metrics.tools_called)

    param_acc = 1.0
    expected_params = scenario.get("expected_params", {})
    if expected_params and expected_tools:
        param_acc = score_param_accuracy(expected_params, metrics.tools_called, expected_tools[0])

    success = not metrics.is_error
    criteria_check = scenario.get("success_check", {})

    if criteria_check:
        if "response_contains" in criteria_check:
            for term in criteria_check["response_contains"]:
                if term.lower() not in metrics.response_text.lower():
                    success = False
                    break
        if "min_tool_accuracy" in criteria_check:
            if tool_acc < criteria_check["min_tool_accuracy"]:
                success = False
        if "max_tokens" in criteria_check:
            if metrics.total_tokens > criteria_check["max_tokens"]:
                success = False

    return {
        "scenario": name,
        "run_index": run_index,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "metrics": metrics.to_dict(),
        "scoring": {
            "tool_accuracy": round(tool_acc, 3),
            "param_accuracy": round(param_acc, 3),
            "success": success,
            "tools_expected": expected_tools,
            "tools_actual": actual_tool_names,
        },
        "response_preview": metrics.response_text[:500],
    }


def _compute_aggregate(results: list) -> dict:
    if not results:
        return {}

    by_scenario = {}
    for r in results:
        name = r["scenario"]
        if name not in by_scenario:
            by_scenario[name] = []
        by_scenario[name].append(r)

    scenario_stats = {}
    for name, runs in by_scenario.items():
        metrics_list = [r["metrics"] for r in runs]
        scores_list = [r["scoring"] for r in runs]

        # effective_tokens: real if available, estimated otherwise
        eff_tokens = [
            m["total_tokens"] if m["total_tokens"] > 0 else m.get("estimated_tokens", 0)
            for m in metrics_list
        ]

        scenario_stats[name] = {
            "avg_total_tokens": _avg([m["total_tokens"] for m in metrics_list]),
            "avg_estimated_tokens": _avg([m.get("estimated_tokens", 0) for m in metrics_list]),
            "avg_effective_tokens": _avg(eff_tokens),
            "avg_input_tokens": _avg([m["input_tokens"] for m in metrics_list]),
            "avg_output_tokens": _avg([m["output_tokens"] for m in metrics_list]),
            "avg_wall_time_ms": _avg([m["wall_time_ms"] for m in metrics_list]),
            "avg_cost_usd": _avg([m["cost_usd"] for m in metrics_list]),
            "avg_num_turns": _avg([m["num_turns"] for m in metrics_list]),
            "avg_tool_accuracy": _avg([s["tool_accuracy"] for s in scores_list]),
            "avg_param_accuracy": _avg([s["param_accuracy"] for s in scores_list]),
            "success_rate": sum(1 for s in scores_list if s["success"]) / len(scores_list),
            "num_runs": len(runs),
        }

    all_metrics = [r["metrics"] for r in results]
    all_scores = [r["scoring"] for r in results]
    all_eff = [
        m["total_tokens"] if m["total_tokens"] > 0 else m.get("estimated_tokens", 0)
        for m in all_metrics
    ]

    return {
        "overall": {
            "avg_total_tokens": _avg([m["total_tokens"] for m in all_metrics]),
            "avg_estimated_tokens": _avg([m.get("estimated_tokens", 0) for m in all_metrics]),
            "avg_effective_tokens": _avg(all_eff),
            "avg_wall_time_ms": _avg([m["wall_time_ms"] for m in all_metrics]),
            "avg_cost_usd": _avg([m["cost_usd"] for m in all_metrics]),
            "avg_tool_accuracy": _avg([s["tool_accuracy"] for s in all_scores]),
            "success_rate": sum(1 for s in all_scores if s["success"]) / len(all_scores),
            "total_scenarios": len(results),
        },
        "by_scenario": scenario_stats,
    }


def _avg(values: list) -> float:
    return round(sum(values) / len(values), 3) if values else 0


async def run_all(
    scenario_pattern: str,
    config_name: str,
    num_runs: int,
    dry_run: bool = False,
    quiet: bool = False,
) -> dict:
    scenarios = load_scenarios(scenario_pattern)
    if not scenarios:
        print(f"No scenarios matching '{scenario_pattern}' in {SCENARIOS_DIR}")
        return {}

    config_overrides = load_config(config_name)
    tui = BenchmarkTUI(scenarios, config_name, num_runs, quiet)

    tui.print_banner()

    if dry_run:
        for s in scenarios:
            inst_name, inst_icon = get_instrument(s.get("name", ""))
            print(f"  {DIM}{inst_icon}{RESET} {s.get('name', s.get('_file'))}: {DIM}{s.get('prompt', '')[:70]}...{RESET}")
        return {}

    if not quiet:
        tui.print_warmup()
        print(f"  {BOLD}Performance begins...{RESET}\n")
        # Reserve 2 lines for status + progress
        print()
        print()

    tui.start_time = time.monotonic()

    all_results = []
    for scenario in scenarios:
        for i in range(num_runs):
            tui.start_scenario(scenario.get("name", scenario.get("_file", "?")), i)
            result = await run_scenario(scenario, config_overrides, i)
            tui.finish_scenario(result)
            all_results.append(result)

    # Clear the progress bar line after all done
    if not quiet:
        print(f"\r{CLEAR_LINE}", end="")

    # Build run summary
    run_id = f"{config_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    agg = _compute_aggregate(all_results)
    summary = {
        "run_id": run_id,
        "config": config_name,
        "config_overrides": config_overrides,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "num_scenarios": len(scenarios),
        "num_runs": num_runs,
        "results": all_results,
        "aggregate": agg,
    }

    # Save results
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = RESULTS_DIR / f"{run_id}.json"
    out_path.write_text(json.dumps(summary, indent=2))

    # Print scoreboard
    tui.print_results_table(agg)
    tui.print_finale(agg)

    print(f"  {DIM}Results saved: {out_path}{RESET}\n")

    return summary


def list_scenarios():
    scenarios = load_scenarios("*")
    if not scenarios:
        print("No scenarios found. Add .json files to tools/opai-benchmark/scenarios/")
        return
    print(f"\n  {BOLD}Available Scenarios{RESET} ({len(scenarios)}):\n")
    for s in scenarios:
        name = s.get("name", s.get("_file", "?"))
        desc = s.get("description", "")
        inst_name, inst_icon = get_instrument(name)
        model = s.get("model", "default")
        print(f"  {inst_icon} {BOLD}{name:<35}{RESET} {DIM}{desc[:45]}{RESET}")
    print()


def main():
    parser = argparse.ArgumentParser(description="OPAI Benchmark Suite — Tuning the Orchestra")
    parser.add_argument("--scenario", default="*", help="Scenario name/glob pattern")
    parser.add_argument("--config", default="baseline", help="Config profile name")
    parser.add_argument("--runs", type=int, default=1, help="Number of runs per scenario")
    parser.add_argument("--list", action="store_true", help="List available scenarios")
    parser.add_argument("--dry-run", action="store_true", help="Show what would run")
    parser.add_argument("--quiet", action="store_true", help="No TUI, plain output")
    args = parser.parse_args()

    if args.list:
        list_scenarios()
        return

    try:
        if not args.quiet:
            print(HIDE_CURSOR, end="", flush=True)
        asyncio.run(run_all(args.scenario, args.config, args.runs, args.dry_run, args.quiet))
    except KeyboardInterrupt:
        print(f"\n\n  {YELLOW}Interrupted.{RESET}")
    finally:
        print(SHOW_CURSOR, end="", flush=True)


if __name__ == "__main__":
    main()
