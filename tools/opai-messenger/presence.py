"""OPAI Messenger - In-memory presence and typing tracker."""

import time
from dataclasses import dataclass, field


@dataclass
class UserPresence:
    user_id: str
    display_name: str
    connected_at: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)


class PresenceTracker:
    """Track online users and typing indicators."""

    def __init__(self):
        # user_id -> UserPresence
        self._online: dict[str, UserPresence] = {}
        # (channel_id, user_id) -> timestamp
        self._typing: dict[tuple[str, str], float] = {}
        self.TYPING_TIMEOUT = 3.0  # seconds

    def user_connected(self, user_id: str, display_name: str):
        self._online[user_id] = UserPresence(user_id=user_id, display_name=display_name)

    def user_disconnected(self, user_id: str):
        self._online.pop(user_id, None)
        # Clean up typing for this user
        keys_to_remove = [k for k in self._typing if k[1] == user_id]
        for k in keys_to_remove:
            del self._typing[k]

    def set_typing(self, channel_id: str, user_id: str):
        self._typing[(channel_id, user_id)] = time.time()

    def get_typing(self, channel_id: str, exclude_user: str = "") -> list[dict]:
        """Get users currently typing in a channel."""
        now = time.time()
        result = []
        expired = []
        for (cid, uid), ts in self._typing.items():
            if cid != channel_id:
                continue
            if uid == exclude_user:
                continue
            if now - ts > self.TYPING_TIMEOUT:
                expired.append((cid, uid))
                continue
            user = self._online.get(uid)
            if user:
                result.append({"user_id": uid, "display_name": user.display_name})
        for k in expired:
            del self._typing[k]
        return result

    def get_online_users(self) -> list[dict]:
        return [
            {"user_id": p.user_id, "display_name": p.display_name}
            for p in self._online.values()
        ]

    def is_online(self, user_id: str) -> bool:
        return user_id in self._online


# Global singleton
tracker = PresenceTracker()
