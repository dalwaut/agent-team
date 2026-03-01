#!/usr/bin/env bash
# web-fetch-fallback.sh — Fetch web content when primary tools are blocked
# Uses multiple strategies: yt-dlp (YouTube), Gemini CLI, curl, Python requests
#
# Usage:
#   ./scripts/web-fetch-fallback.sh <url> [prompt]
#   ./scripts/web-fetch-fallback.sh "https://youtube.com/watch?v=xxx"
#   ./scripts/web-fetch-fallback.sh "https://reddit.com/r/..." "summarize this"
#   echo "url" | ./scripts/web-fetch-fallback.sh --stdin
#
# Strategies (tried in order):
#   YouTube URLs: transcript-api (direct) → transcript-api (SOCKS proxy) → yt-dlp (proxy) → BB VPS remote → Gemini CLI
#   Other URLs:   curl + html2text → BB VPS remote curl → Gemini CLI
#
# YouTube IP ban workaround:
#   ssh-copy-id dallas@100.113.66.23    # Set up NAS SSH key (one-time)
#   ./scripts/web-fetch-fallback.sh --tunnel   # Start SOCKS5 tunnel
#   ./scripts/web-fetch-fallback.sh --check    # Verify everything
#
# Install dependencies:
#   pip3 install yt-dlp youtube-transcript-api[socks]
#   npm install -g @anthropic-ai/gemini-cli  (or: npm install -g gemini-cli)
#   pip3 install html2text requests

set -euo pipefail

URL="${1:-}"
PROMPT="${2:-Extract all key information from this content.}"
TMPDIR="${TMPDIR:-/tmp}"
WORKDIR="$TMPDIR/web-fetch-$$"

# SSH SOCKS5 tunnel target — NAS at home (residential IP, not blocked by YouTube)
# Fallback: BB VPS (cloud IP, may still be blocked)
PROXY_HOST="${OPAI_PROXY_HOST:-100.113.66.23}"  # ds418 NAS via Tailscale
PROXY_USER="${OPAI_PROXY_USER:-dallas}"
PROXY_HOST_FALLBACK="${OPAI_PROXY_HOST_FB:-72.60.115.74}"  # BB VPS
PROXY_USER_FALLBACK="${OPAI_PROXY_USER_FB:-root}"
SOCKS_PORT="${OPAI_SOCKS_PORT:-1080}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[fetch]${NC} $*" >&2; }
warn() { echo -e "${YELLOW}[fetch]${NC} $*" >&2; }
err() { echo -e "${RED}[fetch]${NC} $*" >&2; }

cleanup() { rm -rf "$WORKDIR" 2>/dev/null; }
trap cleanup EXIT

usage() {
    echo "Usage: $0 <url> [prompt]"
    echo ""
    echo "Fetches web content using multiple fallback strategies."
    echo "Designed for when Claude Code's WebFetch or MCP tools are blocked."
    echo ""
    echo "Options:"
    echo "  --stdin     Read URL from stdin"
    echo "  --check     Check which tools are available"
    echo "  --install   Install recommended dependencies"
    exit 1
}

check_tools() {
    echo "Available tools:"
    for tool in yt-dlp gemini python3 curl html2text ssh; do
        if command -v "$tool" &>/dev/null; then
            echo -e "  ${GREEN}✓${NC} $tool ($(which $tool))"
        else
            echo -e "  ${RED}✗${NC} $tool"
        fi
    done
    echo ""
    echo "Python packages:"
    for pkg in youtube_transcript_api html2text requests; do
        if python3 -c "import $pkg" 2>/dev/null; then
            echo -e "  ${GREEN}✓${NC} $pkg"
        else
            echo -e "  ${RED}✗${NC} $pkg"
        fi
    done
    echo ""
    echo "SOCKS5 proxy tunnel (port $SOCKS_PORT):"
    if is_tunnel_active; then
        echo -e "  ${GREEN}✓${NC} Active on port $SOCKS_PORT"
    else
        echo -e "  ${YELLOW}○${NC} Not active — start with: $0 --tunnel"
    fi
    echo ""
    echo "Remote hosts (for SSH tunnel / remote exec):"
    if ssh -o ConnectTimeout=3 -o BatchMode=yes "$PROXY_USER@$PROXY_HOST" true 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} NAS $PROXY_USER@$PROXY_HOST (residential IP — preferred)"
    else
        echo -e "  ${RED}✗${NC} NAS $PROXY_USER@$PROXY_HOST (run: ssh-copy-id $PROXY_USER@$PROXY_HOST)"
    fi
    if ssh -o ConnectTimeout=3 -o BatchMode=yes "$PROXY_USER_FALLBACK@$PROXY_HOST_FALLBACK" true 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} VPS $PROXY_USER_FALLBACK@$PROXY_HOST_FALLBACK (cloud IP — fallback)"
    else
        echo -e "  ${RED}✗${NC} VPS $PROXY_USER_FALLBACK@$PROXY_HOST_FALLBACK"
    fi
    echo ""
    echo "Gemini CLI (fallback):"
    if command -v gemini &>/dev/null; then
        echo -e "  ${GREEN}✓${NC} gemini $(gemini --version 2>/dev/null)"
        if [[ -f "$HOME/.gemini/settings.json" ]]; then
            echo -e "  ${GREEN}✓${NC} Authenticated"
        else
            echo -e "  ${YELLOW}○${NC} Not authenticated — run: GEMINI_API_KEY=<key> gemini -p 'hello'"
        fi
    else
        echo -e "  ${RED}✗${NC} Not installed — npm install -g @google/gemini-cli"
    fi
}

# --- SOCKS5 tunnel management ---
is_tunnel_active() {
    # Check if something is listening on the SOCKS port
    ss -tlnp 2>/dev/null | grep -q ":${SOCKS_PORT} " 2>/dev/null
}

_try_tunnel() {
    local user="$1" host="$2"
    ssh -D "$SOCKS_PORT" -q -N -f \
        -o ConnectTimeout=10 \
        -o ServerAliveInterval=30 \
        -o ServerAliveCountMax=3 \
        -o ExitOnForwardFailure=yes \
        -o BatchMode=yes \
        "$user@$host" 2>/dev/null
    sleep 0.5
    is_tunnel_active
}

start_tunnel() {
    if is_tunnel_active; then
        log "SOCKS5 tunnel already active on port $SOCKS_PORT"
        return 0
    fi

    # Try NAS first (residential IP — not blocked by YouTube)
    log "Trying NAS tunnel via $PROXY_USER@$PROXY_HOST..."
    if _try_tunnel "$PROXY_USER" "$PROXY_HOST"; then
        log "Tunnel active via NAS (residential IP) on port $SOCKS_PORT"
        return 0
    fi

    # Fall back to BB VPS (cloud IP — may still be blocked)
    warn "NAS unreachable, trying BB VPS via $PROXY_USER_FALLBACK@$PROXY_HOST_FALLBACK..."
    if _try_tunnel "$PROXY_USER_FALLBACK" "$PROXY_HOST_FALLBACK"; then
        log "Tunnel active via BB VPS on port $SOCKS_PORT"
        return 0
    fi

    err "Failed to start tunnel. Set up SSH key to NAS:"
    err "  ssh-copy-id $PROXY_USER@$PROXY_HOST"
    return 1
}

stop_tunnel() {
    local pids
    pids=$(ps aux | grep "ssh.*-D.*$SOCKS_PORT" | grep -v grep | awk '{print $2}')
    if [[ -n "$pids" ]]; then
        echo "$pids" | xargs kill 2>/dev/null
        log "Tunnel stopped"
    else
        log "No tunnel found"
    fi
}

install_deps() {
    log "Installing Python dependencies..."
    pip3 install --quiet yt-dlp youtube-transcript-api html2text requests 2>/dev/null || true

    if ! command -v gemini &>/dev/null; then
        warn "Gemini CLI not installed. Install manually:"
        warn "  npm install -g @anthropic-ai/gemini-cli"
        warn "  Then run: gemini  (to authenticate with Google account)"
    fi
}

# Detect URL type
is_youtube() {
    [[ "$1" =~ (youtube\.com|youtu\.be) ]]
}

# Strategy 1: yt-dlp for YouTube subtitles (via proxy if available)
try_ytdlp() {
    local url="$1"
    local use_proxy="${2:-false}"
    if ! command -v yt-dlp &>/dev/null; then
        return 1
    fi

    log "Trying yt-dlp subtitle extraction${use_proxy:+ (via proxy)}..."
    mkdir -p "$WORKDIR"
    rm -f "$WORKDIR"/subs* 2>/dev/null

    local proxy_args=()
    if [[ "$use_proxy" == "true" ]] && is_tunnel_active; then
        proxy_args=(--proxy "socks5://127.0.0.1:$SOCKS_PORT")
        log "Using SOCKS5 proxy on port $SOCKS_PORT"
    fi

    # Try auto-generated English subs first, then manual
    if yt-dlp --skip-download --write-auto-sub --sub-lang en \
        --sub-format vtt --convert-subs srt \
        "${proxy_args[@]}" \
        -o "$WORKDIR/subs" "$url" 2>/dev/null; then

        local subfile=$(ls "$WORKDIR"/subs*.srt 2>/dev/null | head -1)
        if [[ -n "$subfile" && -s "$subfile" ]]; then
            # Strip SRT formatting, output clean text
            sed '/^[0-9]*$/d; /^[0-9][0-9]:[0-9][0-9]/d; /^$/d; s/<[^>]*>//g' "$subfile" | \
                awk '!seen[$0]++' | tr '\n' ' ' | sed 's/  */ /g'
            return 0
        fi
    fi

    return 1
}

# Strategy 2: youtube-transcript-api (direct, then via SOCKS proxy)
try_yt_transcript_api() {
    local url="$1"
    local use_proxy="${2:-false}"
    if ! python3 -c "import youtube_transcript_api" 2>/dev/null; then
        return 1
    fi

    log "Trying youtube-transcript-api${use_proxy:+ (via proxy)}..."

    # Extract video ID
    local vid_id
    vid_id=$(python3 -c "
import re, sys
url = '$url'
patterns = [
    r'(?:v=|/v/|youtu\.be/)([a-zA-Z0-9_-]{11})',
    r'(?:embed|shorts)/([a-zA-Z0-9_-]{11})',
]
for p in patterns:
    m = re.search(p, url)
    if m:
        print(m.group(1))
        sys.exit(0)
sys.exit(1)
" 2>/dev/null) || return 1

    local proxy_arg=""
    if [[ "$use_proxy" == "true" ]]; then
        proxy_arg="socks5h://127.0.0.1:$SOCKS_PORT"
    fi

    python3 -c "
from youtube_transcript_api import YouTubeTranscriptApi
try:
    proxy_url = '$proxy_arg'
    if proxy_url:
        from youtube_transcript_api.proxies import GenericProxyConfig
        proxy = GenericProxyConfig(http_url=proxy_url, https_url=proxy_url)
        api = YouTubeTranscriptApi(proxy_config=proxy)
    else:
        api = YouTubeTranscriptApi()
    transcript = api.fetch(video_id='$vid_id', languages=['en'])
    text = ' '.join([entry.text for entry in transcript.snippets])
    print(text)
except Exception as e:
    import sys
    print(f'Error: {e}', file=sys.stderr)
    sys.exit(1)
" 2>/dev/null
}

# Strategy 3: Gemini CLI (Google's model — can access YouTube natively)
try_gemini() {
    local url="$1"
    local prompt="$2"

    if ! command -v gemini &>/dev/null; then
        return 1
    fi

    # Check if Gemini is authenticated
    if [[ -z "${GEMINI_API_KEY:-}" ]] && [[ ! -f "$HOME/.gemini/settings.json" ]]; then
        warn "Gemini CLI not authenticated — set GEMINI_API_KEY or run: gemini (interactive login)"
        return 1
    fi

    log "Trying Gemini CLI..."
    gemini -p "Fetch the content from this URL and $prompt: $url" 2>/dev/null
}

# Strategy 4: Remote fetch via SSH (NAS first, then BB VPS)
try_remote_yt_transcript() {
    local url="$1"

    # Extract video ID locally
    local vid_id
    vid_id=$(python3 -c "
import re, sys
url = '$url'
patterns = [
    r'(?:v=|/v/|youtu\.be/)([a-zA-Z0-9_-]{11})',
    r'(?:embed|shorts)/([a-zA-Z0-9_-]{11})',
]
for p in patterns:
    m = re.search(p, url)
    if m:
        print(m.group(1))
        sys.exit(0)
sys.exit(1)
" 2>/dev/null) || return 1

    local cmd="python3 -c \"
from youtube_transcript_api import YouTubeTranscriptApi
api = YouTubeTranscriptApi()
t = api.fetch(video_id='$vid_id', languages=['en'])
print(' '.join([s.text for s in t.snippets]))
\""

    # Try NAS first (residential IP)
    if ssh -o ConnectTimeout=3 -o BatchMode=yes "$PROXY_USER@$PROXY_HOST" true 2>/dev/null; then
        log "Trying NAS remote transcript fetch (residential IP)..."
        local result
        result=$(ssh -o ConnectTimeout=15 "$PROXY_USER@$PROXY_HOST" "$cmd" 2>/dev/null) && {
            echo "$result"
            return 0
        }
    fi

    # Fall back to BB VPS
    if ssh -o ConnectTimeout=3 -o BatchMode=yes "$PROXY_USER_FALLBACK@$PROXY_HOST_FALLBACK" true 2>/dev/null; then
        log "Trying BB VPS remote transcript fetch..."
        ssh -o ConnectTimeout=15 "$PROXY_USER_FALLBACK@$PROXY_HOST_FALLBACK" "$cmd" 2>/dev/null
        return $?
    fi

    return 1
}

# Strategy 5: Remote curl (NAS first, then BB VPS — for non-YouTube URLs)
try_remote_curl() {
    local url="$1"
    local remote_user="" remote_host=""

    # Find a reachable remote host
    if ssh -o ConnectTimeout=3 -o BatchMode=yes "$PROXY_USER@$PROXY_HOST" true 2>/dev/null; then
        remote_user="$PROXY_USER"; remote_host="$PROXY_HOST"
    elif ssh -o ConnectTimeout=3 -o BatchMode=yes "$PROXY_USER_FALLBACK@$PROXY_HOST_FALLBACK" true 2>/dev/null; then
        remote_user="$PROXY_USER_FALLBACK"; remote_host="$PROXY_HOST_FALLBACK"
    else
        return 1
    fi

    log "Trying remote curl via $remote_user@$remote_host..."

    ssh -o ConnectTimeout=10 "$remote_user@$remote_host" \
        "curl -sL --max-time 15 -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' '$url'" 2>/dev/null | \
    if python3 -c "import html2text" 2>/dev/null; then
        python3 -c "
import sys, html2text
h = html2text.HTML2Text()
h.ignore_links = False
h.ignore_images = True
h.body_width = 0
print(h.handle(sys.stdin.read()))
" 2>/dev/null
    else
        sed 's/<[^>]*>//g; s/&nbsp;/ /g; s/&amp;/\&/g; s/&lt;/</g; s/&gt;/>/g' | \
            tr '\n' ' ' | sed 's/  */ /g'
    fi
}

# Strategy 6: curl + html2text
try_curl() {
    local url="$1"

    log "Trying curl + html2text..."
    local html
    html=$(curl -sL --max-time 15 \
        -H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" \
        "$url" 2>/dev/null) || return 1

    if [[ -z "$html" ]]; then
        return 1
    fi

    # Try python html2text first, then basic sed strip
    if python3 -c "import html2text" 2>/dev/null; then
        echo "$html" | python3 -c "
import sys, html2text
h = html2text.HTML2Text()
h.ignore_links = False
h.ignore_images = True
h.body_width = 0
print(h.handle(sys.stdin.read()))
" 2>/dev/null
    else
        # Crude HTML strip
        echo "$html" | sed 's/<[^>]*>//g; s/&nbsp;/ /g; s/&amp;/\&/g; s/&lt;/</g; s/&gt;/>/g' | \
            tr '\n' ' ' | sed 's/  */ /g'
    fi
}

# --- Main ---

case "${1:-}" in
    --check) check_tools; exit 0 ;;
    --install) install_deps; exit 0 ;;
    --tunnel) start_tunnel; exit $? ;;
    --tunnel-stop) stop_tunnel; exit 0 ;;
    --stdin) read -r URL ;;
    --help|-h|"") usage ;;
esac

if [[ -z "$URL" ]]; then
    err "No URL provided"
    usage
fi

log "Fetching: $URL"

if is_youtube "$URL"; then
    # YouTube: try direct → SOCKS proxy → BB VPS remote → Gemini
    log "Detected YouTube URL"

    # 1. Direct (may work if IP not blocked)
    content=$(try_yt_transcript_api "$URL" 2>/dev/null) && {
        log "Success via youtube-transcript-api (direct)"
        echo "$content"
        exit 0
    }

    # 2. Via SOCKS5 proxy (auto-start tunnel if SSH key is set up)
    if ! is_tunnel_active; then
        start_tunnel 2>/dev/null || true
    fi
    if is_tunnel_active; then
        content=$(try_yt_transcript_api "$URL" "true" 2>/dev/null) && {
            log "Success via youtube-transcript-api (proxy)"
            echo "$content"
            exit 0
        }

        content=$(try_ytdlp "$URL" "true" 2>/dev/null) && {
            log "Success via yt-dlp (proxy)"
            echo "$content"
            exit 0
        }
    fi

    # 3. Remote execution (NAS residential IP first, then BB VPS)
    content=$(try_remote_yt_transcript "$URL" 2>/dev/null) && {
        log "Success via remote transcript"
        echo "$content"
        exit 0
    }

    # 4. Gemini CLI (Google's model can access YouTube natively)
    content=$(try_gemini "$URL" "$PROMPT" 2>/dev/null) && {
        log "Success via Gemini CLI"
        echo "$content"
        exit 0
    }

    err "All YouTube strategies failed."
    err "Fix: Set up SSH key to NAS (residential IP) and start tunnel:"
    err "  ssh-copy-id $PROXY_USER@$PROXY_HOST"
    err "  $0 --tunnel"
    exit 1
else
    # General URL: try local curl, then BB VPS, then Gemini
    content=$(try_curl "$URL" 2>/dev/null) && {
        log "Success via curl"
        echo "$content"
        exit 0
    }

    content=$(try_remote_curl "$URL" 2>/dev/null) && {
        log "Success via remote curl"
        echo "$content"
        exit 0
    }

    content=$(try_gemini "$URL" "$PROMPT" 2>/dev/null) && {
        log "Success via Gemini CLI"
        echo "$content"
        exit 0
    }

    err "All fetch strategies failed. Install deps: $0 --install"
    exit 1
fi
