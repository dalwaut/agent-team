"""OPAI Engine — WebSocket endpoints for live streaming.

Migrated from opai-monitor/routes_ws.py with unified imports.
"""

import asyncio
import json
import time
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

import config
from services import collectors
from services import log_reader
from services import session_collector

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

    try:
        history = log_reader.get_recent_logs(50)
        if history:
            await ws.send_json({"type": "history", "entries": history})
    except Exception:
        pass

    try:
        journal_task = asyncio.create_task(_stream_journal(ws))
        file_task = asyncio.create_task(_stream_files(ws))

        while True:
            try:
                msg = await asyncio.wait_for(ws.receive_text(), timeout=1.0)
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
    """Stream Claude usage stats every 10 seconds."""
    await ws.accept()
    try:
        while True:
            data = session_collector.get_live_usage()
            await ws.send_json(data)
            await asyncio.sleep(config.WS_CLAUDE_INTERVAL)
    except (WebSocketDisconnect, Exception):
        pass


@router.websocket("/ws/workers")
async def ws_workers(ws: WebSocket):
    """Stream worker status every 5 seconds."""
    await ws.accept()
    try:
        # Import here to avoid circular imports
        from background.worker_manager import WorkerManager
        # Access the shared instance via the routes module
        from routes.workers import _manager
        while True:
            if _manager:
                data = _manager.get_status()
                await ws.send_json({"workers": data, "count": len(data)})
            await asyncio.sleep(5)
    except (WebSocketDisconnect, Exception):
        pass
