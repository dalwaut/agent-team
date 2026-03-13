"""OPAI Supabase Local MCP Server.

Vault-backed multi-project Supabase Management API access. Replaces the
Anthropic-hosted Supabase MCP (OAuth-locked to WautersEdge org) with a local
server that can hit ANY Supabase project by resolving PATs from the vault.

Credential flow:
  tool call (project="bb2") → resolve alias via projects.json
    → get vault_pat_key + project_ref
    → _load_vault() → store.get_secret(vault_pat_key)
    → cache PAT in memory (1hr TTL)
    → POST https://api.supabase.com/v1/projects/{ref}/database/query

Tools:
  - supabase_execute_sql:    Run any SQL (SELECT, INSERT, DDL)
  - supabase_list_tables:    List tables in a schema with row counts
  - supabase_describe_table: Column details, types, constraints
  - supabase_apply_migration: Execute DDL + log migration name
  - supabase_list_projects:  Show all configured project aliases
  - supabase_get_project_info: Project status/health from Management API
  - supabase_list_migrations: Applied migrations with timestamps
  - supabase_get_logs:       Recent logs by service type
"""

import json
import importlib
import sys
import time
import threading
from pathlib import Path

import httpx
from mcp.server.fastmcp import FastMCP

# ── Constants ────────────────────────────────────────────

PROJECTS_FILE = Path(__file__).resolve().parent / "projects.json"
MANAGEMENT_API = "https://api.supabase.com/v1"
PAT_CACHE_TTL = 3600  # 1 hour

# ── PAT Cache (thread-safe, per vault key) ───────────────

_pat_lock = threading.Lock()
_pat_cache: dict[str, tuple[str, float]] = {}  # {vault_key: (pat, expires_at)}


def _load_vault():
    """Import vault store dynamically (same pattern as google_auth.py).

    Swaps sys.modules to avoid config collisions when the calling process
    already has a different 'config' module loaded.
    """
    vault_path = str(Path(__file__).resolve().parent.parent.parent / "tools" / "opai-vault")
    if vault_path not in sys.path:
        sys.path.insert(0, vault_path)

    prev_config = sys.modules.pop("config", None)
    prev_store = sys.modules.pop("store", None)
    try:
        import store
        importlib.reload(store)
        return store.get_secret
    finally:
        sys.modules.pop("config", None)
        sys.modules.pop("store", None)
        if prev_config is not None:
            sys.modules["config"] = prev_config
        if prev_store is not None:
            sys.modules["store"] = prev_store


def _get_pat(vault_pat_key: str) -> str:
    """Get a Supabase PAT from vault with 1-hour in-memory cache."""
    with _pat_lock:
        if vault_pat_key in _pat_cache:
            pat, expires_at = _pat_cache[vault_pat_key]
            if time.time() < expires_at:
                return pat

    get_secret = _load_vault()
    pat = get_secret(vault_pat_key)
    if not pat:
        raise RuntimeError(
            f"Supabase PAT not found in vault (key: {vault_pat_key}). "
            f"Store it with: python3 tools/opai-vault/scripts/import-env.py "
            f"--credential {vault_pat_key} --value 'sbp_...'"
        )
    pat = pat.strip()

    with _pat_lock:
        _pat_cache[vault_pat_key] = (pat, time.time() + PAT_CACHE_TTL)

    return pat


# ── Project Resolver ─────────────────────────────────────

def _load_projects() -> dict:
    """Load projects.json config."""
    with open(PROJECTS_FILE) as f:
        return json.load(f)


def _resolve_project(project: str = "") -> tuple[str, str]:
    """Resolve a project alias to (project_ref, vault_pat_key).

    Returns:
        Tuple of (project_ref, vault_pat_key).
    """
    config = _load_projects()
    alias = project.strip() if project else config.get("default_project", "")

    if not alias:
        raise ValueError("No project alias provided and no default_project configured.")

    projects = config.get("projects", {})
    if alias not in projects:
        available = ", ".join(projects.keys())
        raise ValueError(f"Unknown project alias '{alias}'. Available: {available}")

    entry = projects[alias]
    return entry["project_ref"], entry["vault_pat_key"]


# ── API Client ───────────────────────────────────────────

async def _api_request(
    method: str,
    path: str,
    project_ref: str,
    vault_pat_key: str,
    json_body: dict = None,
) -> dict | list | str:
    """Make an authenticated request to the Supabase Management API."""
    pat = _get_pat(vault_pat_key)
    url = f"{MANAGEMENT_API}/projects/{project_ref}{path}"
    headers = {
        "Authorization": f"Bearer {pat}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.request(method, url, headers=headers, json=json_body)

    if resp.status_code >= 400:
        try:
            err = resp.json()
        except Exception:
            err = resp.text
        raise RuntimeError(f"Supabase API error ({resp.status_code}): {err}")

    # Some endpoints return empty body on success
    if not resp.text.strip():
        return {"status": "ok"}

    return resp.json()


async def _run_sql(query: str, project: str = "") -> dict | list:
    """Execute SQL via Management API."""
    ref, pat_key = _resolve_project(project)
    return await _api_request("POST", "/database/query", ref, pat_key, {"query": query})


# ── Result Formatting ────────────────────────────────────

def _format_table(rows: list[dict]) -> str:
    """Format a list of dicts as an aligned text table."""
    if not rows:
        return "(0 rows)"

    cols = list(rows[0].keys())

    # Calculate column widths
    widths = {c: len(c) for c in cols}
    for row in rows:
        for c in cols:
            widths[c] = max(widths[c], len(str(row.get(c, ""))))

    # Header
    header = "  ".join(c.ljust(widths[c]) for c in cols)
    separator = "  ".join("-" * widths[c] for c in cols)

    # Rows
    lines = [header, separator]
    for row in rows:
        line = "  ".join(str(row.get(c, "")).ljust(widths[c]) for c in cols)
        lines.append(line)

    lines.append(f"\n({len(rows)} rows)")
    return "\n".join(lines)


def _format_result(data) -> str:
    """Format API response for display."""
    if isinstance(data, list):
        if not data:
            return "OK — 0 rows"
        if isinstance(data[0], dict):
            return _format_table(data)
        return json.dumps(data, indent=2)
    if isinstance(data, dict):
        return json.dumps(data, indent=2)
    return str(data)


# ── MCP Server ───────────────────────────────────────────

mcp = FastMCP("opai-supabase-local")


@mcp.tool()
async def supabase_execute_sql(query: str, project: str = "") -> str:
    """Run any SQL query (SELECT, INSERT, UPDATE, DELETE, DDL) against a Supabase project.

    Args:
        query: SQL query to execute.
        project: Project alias (e.g. "opai", "bb2"). Empty = default project.

    Returns:
        Query results as a formatted table, or status message.
    """
    try:
        result = await _run_sql(query, project)
        return _format_result(result)
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
async def supabase_list_tables(schema: str = "public", project: str = "") -> str:
    """List all tables in a schema with row count estimates.

    Args:
        schema: Database schema to list (default: "public").
        project: Project alias. Empty = default project.

    Returns:
        Table of table names with estimated row counts.
    """
    sql = f"""
        SELECT
            t.tablename AS table_name,
            COALESCE(s.n_live_tup, 0) AS estimated_rows
        FROM pg_tables t
        LEFT JOIN pg_stat_user_tables s
            ON s.schemaname = t.schemaname AND s.relname = t.tablename
        WHERE t.schemaname = '{schema}'
        ORDER BY t.tablename;
    """
    try:
        result = await _run_sql(sql, project)
        return _format_result(result)
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
async def supabase_describe_table(table: str, schema: str = "public", project: str = "") -> str:
    """Get column details, types, and constraints for a table.

    Args:
        table: Table name to describe.
        schema: Database schema (default: "public").
        project: Project alias. Empty = default project.

    Returns:
        Column details including name, type, nullable, default, and constraints.
    """
    sql = f"""
        SELECT
            c.column_name,
            c.data_type,
            c.is_nullable,
            c.column_default,
            CASE WHEN pk.column_name IS NOT NULL THEN 'PK' ELSE '' END AS pk
        FROM information_schema.columns c
        LEFT JOIN (
            SELECT ku.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage ku
                ON tc.constraint_name = ku.constraint_name
            WHERE tc.table_schema = '{schema}'
                AND tc.table_name = '{table}'
                AND tc.constraint_type = 'PRIMARY KEY'
        ) pk ON pk.column_name = c.column_name
        WHERE c.table_schema = '{schema}' AND c.table_name = '{table}'
        ORDER BY c.ordinal_position;
    """
    try:
        result = await _run_sql(sql, project)
        if isinstance(result, list) and not result:
            return f"Table '{schema}.{table}' not found or has no columns."
        return _format_result(result)
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
async def supabase_apply_migration(name: str, query: str, project: str = "") -> str:
    """Execute a DDL migration and log it.

    Args:
        name: Migration name (e.g. "add_user_roles"). Used for logging.
        query: DDL SQL to execute.
        project: Project alias. Empty = default project.

    Returns:
        Migration result and confirmation.
    """
    try:
        result = await _run_sql(query, project)
        output = _format_result(result)
        return f"Migration '{name}' applied successfully.\n\n{output}"
    except Exception as e:
        return f"Migration '{name}' failed: {e}"


@mcp.tool()
async def supabase_list_projects() -> str:
    """Show all configured Supabase project aliases with their refs.

    Returns:
        Table of project aliases, display names, and project refs.
    """
    config = _load_projects()
    default = config.get("default_project", "")
    projects = config.get("projects", {})

    rows = []
    for alias, info in projects.items():
        rows.append({
            "alias": alias,
            "display_name": info.get("display_name", ""),
            "project_ref": info["project_ref"],
            "default": "*" if alias == default else "",
        })

    return _format_table(rows)


@mcp.tool()
async def supabase_get_project_info(project: str = "") -> str:
    """Get project status, region, and health from the Supabase Management API.

    Args:
        project: Project alias. Empty = default project.

    Returns:
        Project details including name, region, status, and database info.
    """
    try:
        ref, pat_key = _resolve_project(project)
        pat = _get_pat(pat_key)
        url = f"{MANAGEMENT_API}/projects/{ref}"
        headers = {"Authorization": f"Bearer {pat}"}

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, headers=headers)

        if resp.status_code >= 400:
            return f"Error ({resp.status_code}): {resp.text}"

        info = resp.json()
        parts = [
            f"Name:     {info.get('name', '?')}",
            f"Ref:      {info.get('id', ref)}",
            f"Region:   {info.get('region', '?')}",
            f"Status:   {info.get('status', '?')}",
            f"Org:      {info.get('organization_id', '?')}",
            f"Created:  {info.get('created_at', '?')}",
        ]
        db = info.get("database", {})
        if db:
            parts.append(f"DB Host:  {db.get('host', '?')}")
            parts.append(f"DB Ver:   {db.get('version', '?')}")

        return "\n".join(parts)
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
async def supabase_list_migrations(project: str = "") -> str:
    """List applied database migrations with timestamps.

    Args:
        project: Project alias. Empty = default project.

    Returns:
        Table of applied migrations.
    """
    sql = """
        SELECT version, name,
               statements_applied AS stmts,
               inserted_at
        FROM supabase_migrations.schema_migrations
        ORDER BY version;
    """
    try:
        result = await _run_sql(sql, project)
        return _format_result(result)
    except Exception as e:
        # Table may not exist if no migrations have been applied via CLI
        if "does not exist" in str(e):
            return "No migration tracking table found. Migrations may be managed externally."
        return f"Error: {e}"


@mcp.tool()
async def supabase_get_logs(service: str = "postgres", project: str = "") -> str:
    """Get recent logs for a Supabase service.

    Args:
        service: Service type — "postgres", "auth", "storage", "realtime", "edge-function", "api".
        project: Project alias. Empty = default project.

    Returns:
        Recent log entries for the specified service.
    """
    valid_services = {"postgres", "auth", "storage", "realtime", "edge-function", "api"}
    if service not in valid_services:
        return f"Invalid service '{service}'. Valid: {', '.join(sorted(valid_services))}"

    try:
        ref, pat_key = _resolve_project(project)
        pat = _get_pat(pat_key)

        # Analytics endpoint for logs
        url = f"{MANAGEMENT_API}/projects/{ref}/analytics/endpoints/logs.all"
        headers = {"Authorization": f"Bearer {pat}"}
        params = {
            "iso_timestamp_start": "",  # API defaults to recent
        }

        # Map to Supabase log source collections
        source_map = {
            "postgres": "postgres_logs",
            "auth": "gotrue_logs",
            "storage": "storage_logs",
            "realtime": "realtime_logs",
            "edge-function": "function_edge_logs",
            "api": "postgrest_logs",
        }

        sql = f"""
            SELECT timestamp, event_message
            FROM {source_map[service]}
            ORDER BY timestamp DESC
            LIMIT 50
        """

        # Use the analytics query endpoint
        analytics_url = f"{MANAGEMENT_API}/projects/{ref}/analytics/endpoints/logs.all"
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                analytics_url,
                headers=headers,
                params={"sql": sql, "iso_timestamp_start": ""},
            )

        if resp.status_code >= 400:
            # Fallback: try the simpler query approach
            return f"Logs API returned {resp.status_code}. Try: supabase_execute_sql with a direct pg_stat query instead."

        data = resp.json()
        result = data.get("result", data)
        if isinstance(result, list) and result:
            return _format_result(result)
        return f"No recent {service} logs found."
    except Exception as e:
        return f"Error fetching logs: {e}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
