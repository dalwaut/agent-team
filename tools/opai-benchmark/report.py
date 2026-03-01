#!/usr/bin/env python3
"""OPAI Benchmark Report — compare before/after results.

Usage:
    python3 tools/opai-benchmark/report.py --compare baseline with-tool-examples
    python3 tools/opai-benchmark/report.py --latest                     # show most recent run
    python3 tools/opai-benchmark/report.py --list                       # list all runs
    python3 tools/opai-benchmark/report.py --history teamhub-create-task  # trend for one scenario
"""

import argparse
import json
import sys
from pathlib import Path

RESULTS_DIR = Path(__file__).parent / "results"


def list_runs():
    """List all benchmark runs."""
    files = sorted(RESULTS_DIR.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not files:
        print("No results found. Run the benchmark first:")
        print("  python3 tools/opai-benchmark/runner.py")
        return

    print(f"\nBenchmark runs ({len(files)}):")
    print(f"  {'Run ID':<45} {'Config':<20} {'Scenarios':>10} {'Time':>20}")
    print(f"  {'-'*45} {'-'*20} {'-'*10} {'-'*20}")
    for f in files:
        try:
            data = json.loads(f.read_text())
            print(
                f"  {data.get('run_id', f.stem):<45} "
                f"{data.get('config', '?'):<20} "
                f"{data.get('num_scenarios', 0):>10} "
                f"{data.get('timestamp', '?')[:19]:>20}"
            )
        except (json.JSONDecodeError, OSError):
            print(f"  {f.stem:<45} [corrupt]")


def load_run(config_name: str) -> dict:
    """Load the most recent run for a given config name."""
    files = sorted(RESULTS_DIR.glob(f"{config_name}_*.json"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not files:
        # Try exact filename match
        exact = RESULTS_DIR / f"{config_name}.json"
        if exact.exists():
            return json.loads(exact.read_text())
        print(f"  [ERROR] No run found for config: {config_name}")
        sys.exit(1)
    return json.loads(files[0].read_text())


def load_latest() -> dict:
    """Load the most recent run regardless of config."""
    files = sorted(RESULTS_DIR.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not files:
        print("No results found.")
        sys.exit(1)
    return json.loads(files[0].read_text())


def compare_runs(base_name: str, test_name: str):
    """Compare two benchmark runs side-by-side."""
    base = load_run(base_name)
    test = load_run(test_name)

    base_agg = base.get("aggregate", {}).get("by_scenario", {})
    test_agg = test.get("aggregate", {}).get("by_scenario", {})
    base_overall = base.get("aggregate", {}).get("overall", {})
    test_overall = test.get("aggregate", {}).get("overall", {})

    all_scenarios = sorted(set(list(base_agg.keys()) + list(test_agg.keys())))

    print(f"\n{'='*90}")
    print(f"  BENCHMARK COMPARISON: {base_name} vs {test_name}")
    print(f"{'='*90}")

    # Token comparison (effective = real if available, estimated from cost otherwise)
    any_estimated = False
    for name in all_scenarios:
        for agg in (base_agg, test_agg):
            s = agg.get(name, {})
            if s.get("avg_total_tokens", 0) == 0 and s.get("avg_effective_tokens", 0) > 0:
                any_estimated = True

    tok_label = "TOKEN USAGE (effective — real or ~estimated from cost)"
    print(f"\n  {tok_label}")
    print(f"  {'Scenario':<30} {base_name:>12} {test_name:>12} {'Change':>10} {'%':>8}")
    print(f"  {'-'*30} {'-'*12} {'-'*12} {'-'*10} {'-'*8}")

    for name in all_scenarios:
        b = base_agg.get(name, {}).get("avg_effective_tokens", 0) or base_agg.get(name, {}).get("avg_total_tokens", 0)
        t = test_agg.get(name, {}).get("avg_effective_tokens", 0) or test_agg.get(name, {}).get("avg_total_tokens", 0)
        delta = t - b
        pct = ((t - b) / b * 100) if b > 0 else 0
        indicator = _delta_indicator(delta, lower_is_better=True)
        b_est = "~" if base_agg.get(name, {}).get("avg_total_tokens", 0) == 0 and b > 0 else ""
        t_est = "~" if test_agg.get(name, {}).get("avg_total_tokens", 0) == 0 and t > 0 else ""
        print(f"  {name:<30} {b_est}{b:>11.0f} {t_est}{t:>11.0f} {delta:>+10.0f} {pct:>+7.1f}% {indicator}")

    b_tot = base_overall.get("avg_effective_tokens", 0) or base_overall.get("avg_total_tokens", 0)
    t_tot = test_overall.get("avg_effective_tokens", 0) or test_overall.get("avg_total_tokens", 0)
    d_tot = t_tot - b_tot
    p_tot = ((t_tot - b_tot) / b_tot * 100) if b_tot > 0 else 0
    print(f"  {'-'*30} {'-'*12} {'-'*12} {'-'*10} {'-'*8}")
    print(f"  {'OVERALL':<30} {b_tot:>12.0f} {t_tot:>12.0f} {d_tot:>+10.0f} {p_tot:>+7.1f}% {_delta_indicator(d_tot, True)}")
    if any_estimated:
        print(f"  (~ = estimated from cost at Sonnet $6/M blended rate)")

    # Response time comparison
    print(f"\n  RESPONSE TIME (avg ms)")
    print(f"  {'Scenario':<30} {base_name:>12} {test_name:>12} {'Change':>10} {'%':>8}")
    print(f"  {'-'*30} {'-'*12} {'-'*12} {'-'*10} {'-'*8}")

    for name in all_scenarios:
        b = base_agg.get(name, {}).get("avg_wall_time_ms", 0)
        t = test_agg.get(name, {}).get("avg_wall_time_ms", 0)
        delta = t - b
        pct = ((t - b) / b * 100) if b > 0 else 0
        print(f"  {name:<30} {b:>11.0f}ms {t:>11.0f}ms {delta:>+10.0f} {pct:>+7.1f}% {_delta_indicator(delta, True)}")

    # Tool accuracy comparison
    print(f"\n  TOOL ACCURACY (avg)")
    print(f"  {'Scenario':<30} {base_name:>12} {test_name:>12} {'Change':>10}")
    print(f"  {'-'*30} {'-'*12} {'-'*12} {'-'*10}")

    for name in all_scenarios:
        b = base_agg.get(name, {}).get("avg_tool_accuracy", 0)
        t = test_agg.get(name, {}).get("avg_tool_accuracy", 0)
        delta = t - b
        print(f"  {name:<30} {b*100:>11.1f}% {t*100:>11.1f}% {delta*100:>+9.1f}pp {_delta_indicator(-delta, True)}")

    # Cost comparison
    print(f"\n  COST (avg USD per invocation)")
    print(f"  {'Scenario':<30} {base_name:>12} {test_name:>12} {'Change':>10} {'%':>8}")
    print(f"  {'-'*30} {'-'*12} {'-'*12} {'-'*10} {'-'*8}")

    for name in all_scenarios:
        b = base_agg.get(name, {}).get("avg_cost_usd", 0)
        t = test_agg.get(name, {}).get("avg_cost_usd", 0)
        delta = t - b
        pct = ((t - b) / b * 100) if b > 0 else 0
        print(f"  {name:<30} ${b:>11.4f} ${t:>11.4f} {delta:>+10.4f} {pct:>+7.1f}% {_delta_indicator(delta, True)}")

    # Success rate comparison
    print(f"\n  SUCCESS RATE")
    print(f"  {'Scenario':<30} {base_name:>12} {test_name:>12}")
    print(f"  {'-'*30} {'-'*12} {'-'*12}")

    for name in all_scenarios:
        b = base_agg.get(name, {}).get("success_rate", 0)
        t = test_agg.get(name, {}).get("success_rate", 0)
        print(f"  {name:<30} {b*100:>11.0f}% {t*100:>11.0f}%")

    print(f"\n{'='*90}")

    # Summary verdict
    token_savings = -p_tot if p_tot < 0 else 0
    if token_savings > 0:
        print(f"\n  VERDICT: {test_name} saves {token_savings:.1f}% tokens vs {base_name}")
    elif p_tot > 0:
        print(f"\n  VERDICT: {test_name} uses {p_tot:.1f}% MORE tokens than {base_name}")
    else:
        print(f"\n  VERDICT: No significant token difference")
    print()


def show_latest():
    """Show the most recent run results."""
    data = load_latest()
    agg = data.get("aggregate", {})
    overall = agg.get("overall", {})
    by_scenario = agg.get("by_scenario", {})

    print(f"\n  Latest run: {data.get('run_id', '?')}")
    print(f"  Config:     {data.get('config', '?')}")
    print(f"  Time:       {data.get('timestamp', '?')[:19]}")
    print(f"  Scenarios:  {data.get('num_scenarios', 0)} x {data.get('num_runs', 1)} runs\n")

    print(f"  {'Scenario':<35} {'~Tokens':>8} {'Time':>8} {'Cost':>8} {'ToolAcc':>8} {'Pass':>6}")
    print(f"  {'-'*35} {'-'*8} {'-'*8} {'-'*8} {'-'*8} {'-'*6}")

    any_est = False
    for name, stats in by_scenario.items():
        eff = stats.get("avg_effective_tokens", 0) or stats.get("avg_total_tokens", 0)
        is_est = stats.get("avg_total_tokens", 0) == 0 and eff > 0
        if is_est:
            any_est = True
        tok_str = f"~{eff:.0f}" if is_est else f"{eff:.0f}"
        print(
            f"  {name:<35} "
            f"{tok_str:>8} "
            f"{stats['avg_wall_time_ms']:>7.0f}ms "
            f"${stats['avg_cost_usd']:>6.4f} "
            f"{stats['avg_tool_accuracy']*100:>7.1f}% "
            f"{stats['success_rate']*100:>5.0f}%"
        )

    o_eff = overall.get("avg_effective_tokens", 0) or overall.get("avg_total_tokens", 0)
    print(f"\n  Overall: ~{o_eff:.0f} tokens, "
          f"{overall.get('avg_wall_time_ms', 0):.0f}ms, "
          f"${overall.get('avg_cost_usd', 0):.4f}, "
          f"{overall.get('success_rate', 0)*100:.0f}% pass rate")
    if any_est:
        print(f"  (~ = estimated from cost at Sonnet $6/M blended rate)")
    print()


def show_history(scenario_name: str):
    """Show trend for a specific scenario across all runs."""
    files = sorted(RESULTS_DIR.glob("*.json"), key=lambda f: f.stat().st_mtime)
    if not files:
        print("No results found.")
        return

    print(f"\n  History for: {scenario_name}")
    print(f"  {'Run ID':<40} {'Config':<15} {'Tokens':>8} {'Time':>8} {'ToolAcc':>8} {'Pass':>6}")
    print(f"  {'-'*40} {'-'*15} {'-'*8} {'-'*8} {'-'*8} {'-'*6}")

    for f in files:
        try:
            data = json.loads(f.read_text())
            stats = data.get("aggregate", {}).get("by_scenario", {}).get(scenario_name)
            if stats:
                print(
                    f"  {data.get('run_id', f.stem):<40} "
                    f"{data.get('config', '?'):<15} "
                    f"{stats['avg_total_tokens']:>8.0f} "
                    f"{stats['avg_wall_time_ms']:>7.0f}ms "
                    f"{stats['avg_tool_accuracy']*100:>7.1f}% "
                    f"{stats['success_rate']*100:>5.0f}%"
                )
        except (json.JSONDecodeError, OSError):
            pass
    print()


def _delta_indicator(delta: float, lower_is_better: bool) -> str:
    """Return an indicator for the direction of change."""
    if abs(delta) < 0.01:
        return "~"
    if lower_is_better:
        return "+" if delta < 0 else "-"
    return "+" if delta > 0 else "-"


def main():
    parser = argparse.ArgumentParser(description="OPAI Benchmark Report")
    parser.add_argument("--compare", nargs=2, metavar=("BASE", "TEST"), help="Compare two config runs")
    parser.add_argument("--latest", action="store_true", help="Show most recent run")
    parser.add_argument("--list", action="store_true", help="List all runs")
    parser.add_argument("--history", metavar="SCENARIO", help="Show trend for one scenario")
    args = parser.parse_args()

    if args.compare:
        compare_runs(args.compare[0], args.compare[1])
    elif args.latest:
        show_latest()
    elif args.list:
        list_runs()
    elif args.history:
        show_history(args.history)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
