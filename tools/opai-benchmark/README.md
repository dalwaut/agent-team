# OPAI Benchmark Harness

Measures Claude CLI invocation performance across OPAI services before and after configuration changes (tool use examples, tool search, MCP tuning, etc.).

## Quick Start

```bash
# Run all scenarios with current (baseline) config
python3 tools/opai-benchmark/runner.py

# Run a specific scenario
python3 tools/opai-benchmark/runner.py --scenario teamhub-create-task

# Run with a named config profile
python3 tools/opai-benchmark/runner.py --config with-tool-examples

# Compare two runs
python3 tools/opai-benchmark/report.py --compare baseline with-tool-examples

# List available scenarios
python3 tools/opai-benchmark/runner.py --list
```

## Directory Structure

```
tools/opai-benchmark/
  runner.py          # Execute scenarios, collect metrics
  report.py          # Compare runs, generate reports
  harness.py         # Core: Claude CLI invocation + metric capture
  scenarios/         # JSON test scenario definitions
  configs/           # Named configuration profiles
  results/           # Timestamped run results (gitignored)
```

## Metrics Captured

- **input_tokens** / **output_tokens** / **total_tokens**
- **cache_read_tokens** / **cache_creation_tokens**
- **cost_usd** (from Claude CLI JSON output)
- **wall_time_ms** (end-to-end)
- **num_turns** (API round-trips)
- **tools_called** (list of tool names invoked)
- **tool_accuracy** (expected vs actual tools)
- **param_accuracy** (expected vs actual parameters)
- **success** (did the scenario pass its criteria)
