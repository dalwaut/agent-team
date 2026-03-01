"""Scheduler — reads/writes orchestrator.json schedules."""

import json
from pathlib import Path
from typing import Optional

import config

# Cron presets for the human-readable builder
CRON_PRESETS = {
    "every_5_min": {"cron": "*/5 * * * *", "label": "Every 5 minutes"},
    "every_15_min": {"cron": "*/15 * * * *", "label": "Every 15 minutes"},
    "every_30_min": {"cron": "*/30 * * * *", "label": "Every 30 minutes"},
    "hourly": {"cron": "0 * * * *", "label": "Every hour"},
    "daily_9am": {"cron": "0 9 * * *", "label": "Daily at 9:00 AM"},
    "daily_6pm": {"cron": "0 18 * * *", "label": "Daily at 6:00 PM"},
    "weekdays_9am": {"cron": "0 9 * * 1-5", "label": "Weekdays at 9:00 AM"},
    "monday_9am": {"cron": "0 9 * * 1", "label": "Every Monday at 9:00 AM"},
    "friday_5pm": {"cron": "0 17 * * 5", "label": "Every Friday at 5:00 PM"},
}


def _read_config() -> dict:
    """Read orchestrator.json."""
    if not config.ORCHESTRATOR_CONFIG.is_file():
        return {"schedules": {}}
    with open(config.ORCHESTRATOR_CONFIG, "r", encoding="utf-8") as f:
        return json.load(f)


def _write_config(data: dict):
    """Write orchestrator.json."""
    with open(config.ORCHESTRATOR_CONFIG, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def _describe_cron(expr: str) -> str:
    """Convert cron expression to human-readable description."""
    parts = expr.split()
    if len(parts) != 5:
        return expr

    minute, hour, dom, month, dow = parts

    # Check presets first
    for preset in CRON_PRESETS.values():
        if preset["cron"] == expr:
            return preset["label"]

    # Build description
    if minute.startswith("*/"):
        return f"Every {minute[2:]} minutes"
    if hour.startswith("*/"):
        return f"Every {hour[2:]} hours"

    time_str = ""
    if hour != "*" and minute != "*":
        h = int(hour) if hour.isdigit() else 0
        m = int(minute) if minute.isdigit() else 0
        ampm = "AM" if h < 12 else "PM"
        h12 = h if h <= 12 else h - 12
        if h12 == 0:
            h12 = 12
        time_str = f"{h12}:{m:02d} {ampm}"

    day_str = ""
    days_map = {
        "0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday",
        "4": "Thursday", "5": "Friday", "6": "Saturday", "7": "Sunday",
    }
    if dow != "*":
        if "-" in dow:
            start, end = dow.split("-", 1)
            day_str = f"{days_map.get(start, start)}-{days_map.get(end, end)}"
        elif dow in days_map:
            day_str = f"Every {days_map[dow]}"
        else:
            day_str = f"Day {dow}"

    if time_str and day_str:
        return f"{day_str} at {time_str}"
    if time_str:
        return f"Daily at {time_str}"
    return expr


def list_schedules() -> list[dict]:
    """List all schedules with human-readable descriptions."""
    cfg = _read_config()
    schedules = []
    for name, cron in cfg.get("schedules", {}).items():
        schedules.append({
            "name": name,
            "cron": cron,
            "description": _describe_cron(cron),
        })
    return schedules


def get_schedule(name: str) -> Optional[dict]:
    """Get a specific schedule."""
    cfg = _read_config()
    cron = cfg.get("schedules", {}).get(name)
    if cron is None:
        return None
    return {
        "name": name,
        "cron": cron,
        "description": _describe_cron(cron),
    }


def update_schedule(name: str, cron: str) -> Optional[dict]:
    """Update a schedule's cron expression."""
    cfg = _read_config()
    if name not in cfg.get("schedules", {}):
        return None

    # Validate cron format (basic check)
    parts = cron.strip().split()
    if len(parts) != 5:
        raise ValueError("Cron expression must have 5 parts: minute hour day month weekday")

    cfg["schedules"][name] = cron.strip()
    _write_config(cfg)
    return get_schedule(name)


def create_schedule(name: str, cron: str) -> dict:
    """Create a new schedule."""
    cfg = _read_config()
    if name in cfg.get("schedules", {}):
        raise ValueError(f"Schedule '{name}' already exists")

    parts = cron.strip().split()
    if len(parts) != 5:
        raise ValueError("Cron expression must have 5 parts: minute hour day month weekday")

    if "schedules" not in cfg:
        cfg["schedules"] = {}
    cfg["schedules"][name] = cron.strip()
    _write_config(cfg)
    return get_schedule(name)


def delete_schedule(name: str) -> bool:
    """Delete a schedule."""
    cfg = _read_config()
    if name not in cfg.get("schedules", {}):
        return False
    del cfg["schedules"][name]
    _write_config(cfg)
    return True


def get_presets() -> list[dict]:
    """Return available cron presets."""
    return [{"id": k, **v} for k, v in CRON_PRESETS.items()]
