"""OPAI Bot Space — Per-bot connectivity test runners.

Each function attempts a live connection with the provided (unsaved) config
and returns a result dict: {success: bool, message: str, preview: dict|None}.
Tests run in-process with a 15-second timeout — no credits charged, no persistence.
"""

import asyncio
import imaplib
import json
import socket
from typing import Optional


# ── Email Bot Test ─────────────────────────────────────────────────────────────

async def test_email_bot(config: dict) -> dict:
    """
    Verify IMAP credentials and fetch 1 unseen email for preview.

    Config fields: imap_host, imap_port, imap_user, imap_pass
    """
    host = config.get("imap_host", "").strip()
    port = int(config.get("imap_port", 993))
    user = config.get("imap_user", "").strip()
    password = config.get("imap_pass", "").strip()

    if not host or not user or not password:
        return {
            "success": False,
            "message": "Missing required fields: IMAP host, email address, and app password are all required.",
            "preview": None,
        }

    loop = asyncio.get_event_loop()
    try:
        result = await asyncio.wait_for(
            loop.run_in_executor(None, _imap_test, host, port, user, password),
            timeout=13.0,
        )
        return result
    except asyncio.TimeoutError:
        return {
            "success": False,
            "message": f"Connection timed out connecting to {host}:{port}. Check that IMAP is enabled and the host/port are correct.",
            "preview": None,
        }
    except Exception as exc:
        return {
            "success": False,
            "message": f"Unexpected error: {exc}",
            "preview": None,
        }


def _imap_test(host: str, port: int, user: str, password: str) -> dict:
    """Blocking IMAP test — run in executor to avoid blocking the event loop."""
    try:
        mail = imaplib.IMAP4_SSL(host, port, timeout=10)
    except socket.gaierror:
        return {
            "success": False,
            "message": f"Could not resolve host '{host}'. Double-check the IMAP server address.",
            "preview": None,
        }
    except ConnectionRefusedError:
        return {
            "success": False,
            "message": f"Connection refused to {host}:{port}. Verify the IMAP port (usually 993 for SSL).",
            "preview": None,
        }
    except Exception as exc:
        return {
            "success": False,
            "message": f"Connection error: {exc}",
            "preview": None,
        }

    try:
        mail.login(user, password)
    except imaplib.IMAP4.error as exc:
        return {
            "success": False,
            "message": f"Authentication failed: {exc}. Check your email address and App Password.",
            "preview": None,
        }

    try:
        mail.select("INBOX")
        _status, data = mail.search(None, "UNSEEN")
        uids = data[0].split() if data[0] else []

        preview = None
        if uids:
            # Fetch the first unseen email headers only
            uid = uids[0]
            _typ, msg_data = mail.fetch(uid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
            raw_headers = msg_data[0][1].decode("utf-8", errors="replace") if msg_data and msg_data[0] else ""

            # Parse out basic fields
            sender = _parse_header(raw_headers, "From")
            subject = _parse_header(raw_headers, "Subject")
            date = _parse_header(raw_headers, "Date")

            preview = {
                "from": sender or "(unknown sender)",
                "subject": subject or "(no subject)",
                "date": date or "",
                "total_unseen": len(uids),
                "classification": "inbox — requires full run to classify",
            }

        mail.logout()

        if preview:
            return {
                "success": True,
                "message": f"Connected successfully. Found {len(uids)} unseen email(s). Showing first message below.",
                "preview": preview,
            }
        else:
            return {
                "success": True,
                "message": "Connected successfully. Inbox is empty (no unseen emails right now — that's fine!).",
                "preview": None,
            }

    except Exception as exc:
        try:
            mail.logout()
        except Exception:
            pass
        return {
            "success": False,
            "message": f"Error reading inbox: {exc}",
            "preview": None,
        }


def _parse_header(raw: str, field: str) -> str:
    """Extract a single header value from raw header block."""
    prefix = f"{field}: "
    for line in raw.splitlines():
        if line.startswith(prefix):
            return line[len(prefix):].strip()
    return ""


# ── Forum Bot Test ─────────────────────────────────────────────────────────────

async def test_forum_bot(config: dict) -> dict:
    """Verify forum bot connectivity — check Supabase forum connection."""
    import httpx
    import os

    supabase_url = os.getenv("SUPABASE_URL", "")
    service_key = os.getenv("SUPABASE_SERVICE_KEY", "")

    if not supabase_url or not service_key:
        return {
            "success": False,
            "message": "Server misconfiguration: Supabase credentials not set.",
            "preview": None,
        }

    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.get(
                f"{supabase_url}/rest/v1/forum_posts?select=id&limit=1",
                headers={
                    "apikey": service_key,
                    "Authorization": f"Bearer {service_key}",
                },
            )
            if resp.status_code == 200:
                return {
                    "success": True,
                    "message": "Forum bot connection verified. Supabase forum table is accessible.",
                    "preview": {"forum_posts_reachable": True},
                }
            else:
                return {
                    "success": False,
                    "message": f"Forum DB check failed: HTTP {resp.status_code}",
                    "preview": None,
                }
    except Exception as exc:
        return {
            "success": False,
            "message": f"Could not reach Supabase: {exc}",
            "preview": None,
        }


# ── Dispatch Table ─────────────────────────────────────────────────────────────

TESTERS = {
    "email-agent-user": test_email_bot,
    "forum-bot": test_forum_bot,
}


async def run_test(slug: str, bot_config: dict) -> dict:
    """Run the appropriate test function for the given bot slug."""
    tester = TESTERS.get(slug)
    if not tester:
        return {
            "success": False,
            "message": f"No test runner available for bot '{slug}'.",
            "preview": None,
        }
    return await tester(bot_config)
