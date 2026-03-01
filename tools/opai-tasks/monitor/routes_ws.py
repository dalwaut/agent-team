"""OPAI Monitor — WebSocket endpoints for live streaming."""

import asyncio
import json
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import collectors
from . import log_reader
from . import session_collector
from . import config

router = APIRouter()


@router.websocket("/ws/stats")
async def ws_stats(ws: WebSocket):
    """Stream system stats every 2 seconds."""
    await ws.accept()
    try:
        while True:
            data = collectors.get_system_stats()
            await ws.send_json(data)
            await asyncio.sleep(config.WS_STATS_INTERVAL)
    except (WebSocketDisconnect, Exception):
        pass


@router.websocket("/ws/agents")
async def ws_agents(ws: WebSocket):
    """Stream running agent list every 3 seconds."""
    await ws.accept()
    try:
        while True:
            data = collectors.get_running_agents()
            await ws.send_json({"agents": data, "count": len(data)})
            await asyncio.sleep(config.WS_AGENTS_INTERVAL)
    except (WebSocketDisconnect, Exception):
        pass


@router.websocket("/ws/logs")
async def ws_logs(ws: WebSocket):
    """Stream live log entries from files and journalctl."""
    await ws.accept()

    # Send recent history first
    try:
        history = log_reader.get_recent_logs(50)
        if history:
            await ws.send_json({"type": "history", "entries": history})
    except Exception:
        pass

    # Then stream new entries
    try:
        journal_task = asyncio.create_task(_stream_journal(ws))
        file_task = asyncio.create_task(_stream_files(ws))

        # Also listen for client messages (filters, etc.)
        while True:
            try:
                msg = await asyncio.wait_for(ws.receive_text(), timeout=1.0)
                # Client can send filter commands
                data = json.loads(msg)
                if data.get("type") == "ping":
                    await ws.send_json({"type": "pong"})
            except asyncio.TimeoutError:
                continue
            except (json.JSONDecodeError, WebSocketDisconnect):
                break
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        journal_task.cancel()
        file_task.cancel()


async def _stream_journal(ws: WebSocket):
    """Background task: stream journalctl to WebSocket."""
    try:
        async for entry in log_reader.stream_journalctl():
            await ws.send_json({"type": "log", "entry": entry})
    except Exception:
        pass


async def _stream_files(ws: WebSocket):
    """Background task: tail log files and send new lines."""
    try:
        while True:
            for log_path in config.LOG_SOURCES:
                entries = await log_reader.tail_file(log_path, log_path.stem)
                for entry in entries:
                    await ws.send_json({"type": "log", "entry": entry})
            await asyncio.sleep(config.WS_LOGS_INTERVAL)
    except Exception:
        pass


@router.websocket("/ws/claude")
async def ws_claude(ws: WebSocket):
    """Stream Claude usage stats every 5 seconds (live polling data)."""
    await ws.accept()
    try:
        while True:
            data = session_collector.get_live_usage()
            await ws.send_json(data)
            await asyncio.sleep(config.WS_CLAUDE_INTERVAL)
    except (WebSocketDisconnect, Exception):
        pass
