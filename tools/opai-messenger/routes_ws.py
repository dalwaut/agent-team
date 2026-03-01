"""OPAI Messenger - WebSocket routes for presence and typing."""

import asyncio
import json
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from auth import authenticate_websocket
from presence import tracker

router = APIRouter()

# All connected WebSocket clients: user_id -> set of WebSocket
_connections: dict[str, set[WebSocket]] = {}


async def _broadcast(message: dict, exclude_user: str = ""):
    """Send a message to all connected clients."""
    data = json.dumps(message)
    disconnected = []
    for uid, sockets in _connections.items():
        if uid == exclude_user:
            continue
        dead = []
        for ws in sockets:
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            sockets.discard(ws)
        if not sockets:
            disconnected.append(uid)
    for uid in disconnected:
        _connections.pop(uid, None)
        tracker.user_disconnected(uid)


async def _broadcast_to_channel(channel_id: str, message: dict, exclude_user: str = ""):
    """Send a message to all connected clients (presence is global, so we broadcast to all)."""
    await _broadcast(message, exclude_user)


async def _send_presence_update():
    """Broadcast current online users to everyone."""
    await _broadcast({
        "type": "presence_update",
        "online_users": tracker.get_online_users(),
    })


@router.websocket("/ws/messenger")
async def messenger_ws(websocket: WebSocket):
    await websocket.accept()

    try:
        user = await authenticate_websocket(websocket)
    except Exception:
        return

    user_id = user.id

    # Register connection
    if user_id not in _connections:
        _connections[user_id] = set()
    _connections[user_id].add(websocket)
    tracker.user_connected(user_id, user.display_name)

    # Send connected confirmation
    await websocket.send_text(json.dumps({
        "type": "connected",
        "user": {"id": user_id, "display_name": user.display_name, "email": user.email},
        "online_users": tracker.get_online_users(),
    }))

    # Broadcast presence update
    await _send_presence_update()

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type")

            if msg_type == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))

            elif msg_type == "typing":
                channel_id = data.get("channel_id")
                if channel_id:
                    tracker.set_typing(channel_id, user_id)
                    await _broadcast({
                        "type": "user_typing",
                        "channel_id": channel_id,
                        "user_id": user_id,
                        "display_name": user.display_name,
                    }, exclude_user=user_id)

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        # Cleanup
        if user_id in _connections:
            _connections[user_id].discard(websocket)
            if not _connections[user_id]:
                del _connections[user_id]
                tracker.user_disconnected(user_id)
                await _send_presence_update()
