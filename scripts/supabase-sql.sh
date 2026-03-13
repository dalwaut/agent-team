#!/usr/bin/env bash
# OPAI Supabase SQL Runner
#
# Execute SQL (including DDL) against the OPAI Supabase database
# via the Supabase Management API (uses Personal Access Token).
#
# Usage:
#   ./scripts/supabase-sql.sh "SELECT * FROM profiles LIMIT 5"
#   ./scripts/supabase-sql.sh --file config/supabase-migrations/006_sandbox_fields.sql
#   ./scripts/supabase-sql.sh --migrate 006
#   ./scripts/supabase-sql.sh --list-tables
#   ./scripts/supabase-sql.sh --describe profiles

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPAI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${OPAI_ROOT}/tools/opai-engine/.env"
MIGRATIONS_DIR="${OPAI_ROOT}/config/supabase-migrations"

# ── Load config ──────────────────────────────────────────────

if [[ -f "$ENV_FILE" ]]; then
    SUPABASE_URL=$(grep '^SUPABASE_URL=' "$ENV_FILE" | cut -d= -f2-)
fi
SUPABASE_URL="${SUPABASE_URL:-}"

# Extract project ref from URL
PROJECT_REF=$(echo "$SUPABASE_URL" | sed -E 's|https://([^.]+)\.supabase\.co.*|\1|')

# Supabase Management API (uses PAT, not service key)
SUPABASE_PAT="sbp_629281793f3b60c4b84d8327a5cbfe524e4518f2"
API_BASE="https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query"

# ── Colors ────────────────────────────────────────────────────

GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ── Preflight ─────────────────────────────────────────────────

if [[ -z "$PROJECT_REF" ]]; then
    echo -e "${RED}ERROR: Could not determine project ref from SUPABASE_URL${NC}" >&2
    echo "  Check ${ENV_FILE}" >&2
    exit 1
fi

if ! command -v jq &>/dev/null; then
    echo -e "${YELLOW}jq not found. Installing...${NC}"
    sudo apt-get update -qq && sudo apt-get install -y -qq jq
fi

# ── Core SQL executor ────────────────────────────────────────

run_sql() {
    local sql="$1"
    local response http_code body

    response=$(curl -s -w "\n%{http_code}" \
        "$API_BASE" \
        -H "Authorization: Bearer ${SUPABASE_PAT}" \
        -H "Content-Type: application/json" \
        -d "$(jq -n --arg q "$sql" '{query: $q}')" \
        2>/dev/null)

    http_code=$(echo "$response" | tail -1)
    body=$(echo "$response" | sed '$d')

    if [[ "$http_code" =~ ^2 ]]; then
        # Pretty-print if it looks like JSON array of objects
        if echo "$body" | jq -e 'type == "array"' &>/dev/null; then
            local count
            count=$(echo "$body" | jq 'length')
            if [[ "$count" -eq 0 ]]; then
                echo -e "${GREEN}OK — 0 rows${NC}"
            else
                echo "$body" | jq -r '
                    (.[0] | keys_unsorted) as $cols |
                    ($cols | join("\t")),
                    ($cols | map("---") | join("\t")),
                    (.[] | [.[$cols[]]] | map(tostring) | join("\t"))
                ' 2>/dev/null | column -t -s $'\t' || echo "$body" | jq '.'
                echo -e "\n${GREEN}(${count} rows)${NC}"
            fi
        else
            echo "$body" | jq '.' 2>/dev/null || echo "$body"
            echo -e "${GREEN}OK${NC}"
        fi
        return 0
    else
        echo -e "${RED}HTTP ${http_code}${NC}" >&2
        echo "$body" | jq '.' 2>/dev/null || echo "$body" >&2
        return 1
    fi
}

run_sql_file() {
    local file="$1"
    local sql
    sql=$(cat "$file")
    run_sql "$sql"
}

# ── Convenience commands ─────────────────────────────────────

list_tables() {
    run_sql "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;"
}

describe_table() {
    local table="$1"
    run_sql "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' ORDER BY ordinal_position;"
}

run_migration() {
    local migration_num="$1"
    local migration_file

    migration_file=$(ls "${MIGRATIONS_DIR}/${migration_num}"*.sql 2>/dev/null | head -1)

    if [[ -z "$migration_file" ]]; then
        echo -e "${RED}ERROR: Migration file not found for: ${migration_num}${NC}" >&2
        echo "Available migrations:" >&2
        ls "${MIGRATIONS_DIR}/"*.sql 2>/dev/null | while read f; do echo "  $(basename "$f")"; done
        exit 1
    fi

    echo -e "${CYAN}Running migration: $(basename "$migration_file")${NC}"
    echo "---"
    cat "$migration_file"
    echo "---"
    echo ""

    run_sql_file "$migration_file"
    local rc=$?

    if [[ $rc -eq 0 ]]; then
        echo -e "${GREEN}Migration applied successfully${NC}"
    else
        echo -e "${RED}Migration failed${NC}"
    fi
    return $rc
}

# ── Main ─────────────────────────────────────────────────────

case "${1:-}" in
    --file|-f)
        [[ -z "${2:-}" ]] && { echo "Usage: supabase-sql.sh --file <path.sql>" >&2; exit 1; }
        echo -e "${CYAN}Running: $(basename "$2")${NC}"
        run_sql_file "$2"
        ;;
    --migrate|-m)
        if [[ -z "${2:-}" ]]; then
            echo "Usage: supabase-sql.sh --migrate <number>" >&2
            echo "" >&2
            echo "Available migrations:" >&2
            ls "${MIGRATIONS_DIR}/"*.sql 2>/dev/null | while read f; do echo "  $(basename "$f")"; done
            exit 1
        fi
        run_migration "$2"
        ;;
    --list-tables|--tables)
        list_tables
        ;;
    --describe|-d)
        [[ -z "${2:-}" ]] && { echo "Usage: supabase-sql.sh --describe <table>" >&2; exit 1; }
        describe_table "$2"
        ;;
    --help|-h|"")
        echo "OPAI Supabase SQL Runner"
        echo ""
        echo "Usage:"
        echo "  supabase-sql.sh \"SQL statement\"              Run inline SQL"
        echo "  supabase-sql.sh --file <path.sql>             Run SQL file"
        echo "  supabase-sql.sh --migrate <number>            Run numbered migration"
        echo "  supabase-sql.sh --list-tables                 List public tables"
        echo "  supabase-sql.sh --describe <table>            Describe table columns"
        echo ""
        echo "Project: ${PROJECT_REF}"
        echo "API: Supabase Management API (PAT)"
        ;;
    *)
        run_sql "$1"
        ;;
esac
