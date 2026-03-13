"""OPAI Engine — Worker Mail System.

SQLite-backed inter-worker messaging with Team Hub mirroring.
Workers can send messages to each other, to groups (@all, @builders, @leads,
@coordinator), and receive inbox/thread views.

Mirror types (escalation, error, worker_done, new_task) are auto-posted as
comments on Team Hub items when teamhub_item_id is set.

Database: data/mail.db (WAL mode for concurrent reads).
"""

import asyncio
import json
import logging
import sqlite3
from pathlib import Path
from typing import Optional

import httpx

import config

logger = logging.getLogger("opai-engine.worker-mail")

MIRROR_TYPES = {"escalation", "error", "worker_done", "new_task"}


class WorkerMail:
    """SQLite-backed inter-worker mail system."""

    def __init__(self, db_path: Optional[Path] = None, worker_registry: Optional[dict] = None):
        self._db_path = db_path or config.MAIL_DB_PATH
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._worker_registry = worker_registry or {}
        self._pending_mirrors: list[dict] = []
        self._init_db()

    def _init_db(self):
        """Create tables if they don't exist."""
        conn = sqlite3.connect(str(self._db_path))
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS messages (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                from_worker     TEXT NOT NULL,
                to_worker       TEXT NOT NULL,
                type            TEXT NOT NULL,
                protocol        TEXT DEFAULT 'mail',
                subject         TEXT NOT NULL,
                body            TEXT DEFAULT '',
                thread_id       INTEGER,
                dispatch_id     TEXT,
                teamhub_item_id TEXT,
                read            INTEGER DEFAULT 0,
                created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_msg_to ON messages(to_worker, read);
            CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(thread_id);
            CREATE INDEX IF NOT EXISTS idx_msg_dispatch ON messages(dispatch_id);
        """)
        conn.close()
        logger.info("Worker mail DB initialized at %s", self._db_path)

    def set_worker_registry(self, workers: dict):
        """Update the worker registry reference (called after worker_manager.load())."""
        self._worker_registry = workers

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self._db_path))
        conn.row_factory = sqlite3.Row
        return conn

    # ── Group Resolution ────────────────────────────────────

    def _resolve_group(self, group: str) -> list[str]:
        """Resolve a group address to individual worker IDs."""
        if group == "@all":
            return list(self._worker_registry.keys())
        elif group == "@builders":
            return [
                wid for wid, w in self._worker_registry.items()
                if w.get("type") == "task" and not w.get("guardrails", {}).get("read_only", False)
            ]
        elif group == "@leads":
            return [
                wid for wid, w in self._worker_registry.items()
                if w.get("guardrails", {}).get("delegation_capable", False)
            ]
        elif group == "@coordinator":
            return ["@coordinator"]  # Special: fleet coordinator reads this directly
        return [group]

    # ── Core Operations ─────────────────────────────────────

    def send(
        self,
        from_worker: str,
        to_worker: str,
        type: str,
        subject: str,
        body: str = "",
        thread_id: Optional[int] = None,
        dispatch_id: Optional[str] = None,
        teamhub_item_id: Optional[str] = None,
    ) -> int:
        """Send a message. Returns the new message ID.

        If to_worker is a group (@all, @builders, etc.), one row per recipient.
        Returns the ID of the first inserted message.
        """
        recipients = self._resolve_group(to_worker)
        first_id = 0

        conn = self._conn()
        try:
            for recipient in recipients:
                cur = conn.execute(
                    """INSERT INTO messages
                       (from_worker, to_worker, type, subject, body, thread_id, dispatch_id, teamhub_item_id)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (from_worker, recipient, type, subject, body, thread_id, dispatch_id, teamhub_item_id),
                )
                if not first_id:
                    first_id = cur.lastrowid
            conn.commit()
        finally:
            conn.close()

        # Queue mirror if applicable
        if type in MIRROR_TYPES and teamhub_item_id:
            self._pending_mirrors.append({
                "teamhub_item_id": teamhub_item_id,
                "content": f"**[{type.upper()}]** from {from_worker}: {subject}\n\n{body[:500]}",
                "author": from_worker,
            })

        logger.debug(
            "Mail sent: %s -> %s [%s] '%s' (id=%d)",
            from_worker, to_worker, type, subject[:40], first_id,
        )
        return first_id

    def check_inbox(
        self,
        worker_id: str,
        unread_only: bool = True,
        types: Optional[list[str]] = None,
        limit: int = 50,
    ) -> list[dict]:
        """Check a worker's inbox. Returns list of message dicts."""
        conn = self._conn()
        try:
            query = "SELECT * FROM messages WHERE to_worker = ?"
            params: list = [worker_id]

            if unread_only:
                query += " AND read = 0"
            if types:
                placeholders = ",".join("?" for _ in types)
                query += f" AND type IN ({placeholders})"
                params.extend(types)

            query += " ORDER BY created_at DESC LIMIT ?"
            params.append(limit)

            rows = conn.execute(query, params).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    def read_message(self, msg_id: int) -> Optional[dict]:
        """Fetch a single message and mark it as read."""
        conn = self._conn()
        try:
            row = conn.execute("SELECT * FROM messages WHERE id = ?", (msg_id,)).fetchone()
            if not row:
                return None
            conn.execute("UPDATE messages SET read = 1 WHERE id = ?", (msg_id,))
            conn.commit()
            return dict(row)
        finally:
            conn.close()

    def reply(self, msg_id: int, from_worker: str, body: str) -> int:
        """Reply to a message. Inherits thread_id, type, subject from original."""
        conn = self._conn()
        try:
            original = conn.execute("SELECT * FROM messages WHERE id = ?", (msg_id,)).fetchone()
            if not original:
                raise ValueError(f"Message {msg_id} not found")

            # Thread ID is either the original's thread_id or the original's id
            thread = original["thread_id"] or original["id"]

            cur = conn.execute(
                """INSERT INTO messages
                   (from_worker, to_worker, type, subject, body, thread_id, dispatch_id, teamhub_item_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    from_worker, original["from_worker"], original["type"],
                    f"Re: {original['subject']}", body,
                    thread, original["dispatch_id"], original["teamhub_item_id"],
                ),
            )
            conn.commit()
            return cur.lastrowid
        finally:
            conn.close()

    def broadcast(
        self,
        from_worker: str,
        to_group: str,
        type: str,
        subject: str,
        body: str = "",
    ) -> int:
        """Broadcast to a group. Convenience wrapper around send()."""
        return self.send(from_worker, to_group, type, subject, body)

    def get_thread(self, thread_id: int) -> list[dict]:
        """Get all messages in a thread, ordered chronologically."""
        conn = self._conn()
        try:
            rows = conn.execute(
                """SELECT * FROM messages
                   WHERE id = ? OR thread_id = ?
                   ORDER BY created_at ASC""",
                (thread_id, thread_id),
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    def get_stats(self) -> dict:
        """Return message counts per worker and overall stats."""
        conn = self._conn()
        try:
            total = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
            unread = conn.execute("SELECT COUNT(*) FROM messages WHERE read = 0").fetchone()[0]

            per_worker = {}
            rows = conn.execute(
                "SELECT to_worker, COUNT(*) as cnt, SUM(CASE WHEN read=0 THEN 1 ELSE 0 END) as unread_cnt "
                "FROM messages GROUP BY to_worker"
            ).fetchall()
            for r in rows:
                per_worker[r["to_worker"]] = {"total": r["cnt"], "unread": r["unread_cnt"]}

            return {"total_messages": total, "total_unread": unread, "per_worker": per_worker}
        finally:
            conn.close()

    def cleanup_old(self, days: int = 30):
        """Delete messages older than N days. Called from heartbeat daily."""
        conn = self._conn()
        try:
            result = conn.execute(
                "DELETE FROM messages WHERE created_at < datetime('now', ?)",
                (f"-{days} days",),
            )
            conn.commit()
            deleted = result.rowcount
            if deleted:
                logger.info("Mail cleanup: removed %d messages older than %d days", deleted, days)
        finally:
            conn.close()

    # ── Team Hub Mirror ─────────────────────────────────────

    async def flush_mirrors(self):
        """Post pending mirror messages to Team Hub comments. Best-effort."""
        if not self._pending_mirrors:
            return

        mirrors = self._pending_mirrors[:]
        self._pending_mirrors.clear()

        for mirror in mirrors:
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    await client.post(
                        f"{config.TEAMHUB_INTERNAL}/add-comment",
                        params={
                            "item_id": mirror["teamhub_item_id"],
                            "content": mirror["content"],
                            "author_id": mirror["author"],
                        },
                    )
            except Exception as e:
                logger.debug("Mirror flush failed for %s: %s", mirror["teamhub_item_id"], e)
