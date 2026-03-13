"""SQLite state machine for migration tracking — enables resume-on-failure."""

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

from config import DB_PATH


class MigrationState:
    """Tracks jobs, account pairs, per-message status, and checkpoints."""

    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = db_path
        self._init_db()

    def _init_db(self):
        with self._conn() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    config TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    mode TEXT NOT NULL DEFAULT 'full',
                    created_at REAL NOT NULL,
                    started_at REAL,
                    completed_at REAL,
                    total_messages INTEGER DEFAULT 0,
                    migrated_messages INTEGER DEFAULT 0,
                    failed_messages INTEGER DEFAULT 0,
                    skipped_messages INTEGER DEFAULT 0,
                    error TEXT
                );

                CREATE TABLE IF NOT EXISTS account_pairs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL REFERENCES jobs(id),
                    source_email TEXT NOT NULL,
                    target_email TEXT NOT NULL,
                    folder_map TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    total_messages INTEGER DEFAULT 0,
                    migrated_messages INTEGER DEFAULT 0,
                    failed_messages INTEGER DEFAULT 0,
                    error TEXT,
                    UNIQUE(job_id, source_email)
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL,
                    pair_id INTEGER NOT NULL REFERENCES account_pairs(id),
                    source_folder TEXT NOT NULL,
                    source_uid INTEGER NOT NULL,
                    message_id TEXT,
                    subject TEXT,
                    date TEXT,
                    size INTEGER,
                    status TEXT NOT NULL DEFAULT 'pending',
                    target_folder TEXT,
                    target_uid INTEGER,
                    error TEXT,
                    migrated_at REAL,
                    UNIQUE(pair_id, source_folder, source_uid)
                );

                CREATE TABLE IF NOT EXISTS checkpoints (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    pair_id INTEGER NOT NULL REFERENCES account_pairs(id),
                    folder TEXT NOT NULL,
                    last_uid INTEGER NOT NULL DEFAULT 0,
                    total_in_folder INTEGER DEFAULT 0,
                    migrated_count INTEGER DEFAULT 0,
                    failed_count INTEGER DEFAULT 0,
                    updated_at REAL NOT NULL,
                    UNIQUE(pair_id, folder)
                );

                CREATE INDEX IF NOT EXISTS idx_messages_status
                    ON messages(pair_id, source_folder, status);
                CREATE INDEX IF NOT EXISTS idx_messages_msgid
                    ON messages(message_id);
            """)

    @contextmanager
    def _conn(self):
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    # ── Jobs ──

    def create_job(self, job_id: str, config: dict, mode: str = "full") -> dict:
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO jobs (id, config, mode, created_at) VALUES (?, ?, ?, ?)",
                (job_id, json.dumps(config), mode, time.time()),
            )
        return self.get_job(job_id)

    def get_job(self, job_id: str) -> Optional[dict]:
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            return dict(row) if row else None

    def update_job(self, job_id: str, **kwargs):
        allowed = {"status", "started_at", "completed_at", "total_messages",
                    "migrated_messages", "failed_messages", "skipped_messages", "error"}
        updates = {k: v for k, v in kwargs.items() if k in allowed}
        if not updates:
            return
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        with self._conn() as conn:
            conn.execute(
                f"UPDATE jobs SET {set_clause} WHERE id = ?",
                (*updates.values(), job_id),
            )

    def list_jobs(self) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT id, status, mode, total_messages, migrated_messages, "
                "failed_messages, created_at, completed_at FROM jobs ORDER BY created_at DESC"
            ).fetchall()
            return [dict(r) for r in rows]

    # ── Account Pairs ──

    def create_pair(self, job_id: str, source_email: str, target_email: str) -> int:
        with self._conn() as conn:
            cur = conn.execute(
                "INSERT INTO account_pairs (job_id, source_email, target_email) "
                "VALUES (?, ?, ?)",
                (job_id, source_email, target_email),
            )
            return cur.lastrowid

    def get_pairs(self, job_id: str) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM account_pairs WHERE job_id = ?", (job_id,)
            ).fetchall()
            return [dict(r) for r in rows]

    def update_pair(self, pair_id: int, **kwargs):
        allowed = {"folder_map", "status", "total_messages", "migrated_messages",
                    "failed_messages", "error"}
        updates = {k: v for k, v in kwargs.items() if k in allowed}
        if not updates:
            return
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        with self._conn() as conn:
            conn.execute(
                f"UPDATE account_pairs SET {set_clause} WHERE id = ?",
                (*updates.values(), pair_id),
            )

    # ── Messages ──

    def record_message(self, job_id: str, pair_id: int, source_folder: str,
                       source_uid: int, message_id: str = None,
                       subject: str = None, date: str = None,
                       size: int = None) -> int:
        with self._conn() as conn:
            cur = conn.execute(
                "INSERT OR IGNORE INTO messages "
                "(job_id, pair_id, source_folder, source_uid, message_id, subject, date, size) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (job_id, pair_id, source_folder, source_uid, message_id, subject, date, size),
            )
            return cur.lastrowid

    def update_message(self, pair_id: int, source_folder: str, source_uid: int, **kwargs):
        allowed = {"status", "target_folder", "target_uid", "error", "migrated_at", "message_id"}
        updates = {k: v for k, v in kwargs.items() if k in allowed}
        if not updates:
            return
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        with self._conn() as conn:
            conn.execute(
                f"UPDATE messages SET {set_clause} "
                f"WHERE pair_id = ? AND source_folder = ? AND source_uid = ?",
                (*updates.values(), pair_id, source_folder, source_uid),
            )

    def get_pending_messages(self, pair_id: int, folder: str,
                             since_uid: int = 0, limit: int = 50) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM messages WHERE pair_id = ? AND source_folder = ? "
                "AND status = 'pending' AND source_uid > ? ORDER BY source_uid LIMIT ?",
                (pair_id, folder, since_uid, limit),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_message_stats(self, pair_id: int) -> dict:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT "
                "  COUNT(*) as total, "
                "  SUM(CASE WHEN status='migrated' THEN 1 ELSE 0 END) as migrated, "
                "  SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed, "
                "  SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) as skipped, "
                "  SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending "
                "FROM messages WHERE pair_id = ?",
                (pair_id,),
            ).fetchone()
            return dict(row)

    def check_message_exists(self, pair_id: int, message_id: str) -> bool:
        """Check if a message with this Message-ID was already migrated."""
        if not message_id:
            return False
        with self._conn() as conn:
            row = conn.execute(
                "SELECT 1 FROM messages WHERE pair_id = ? AND message_id = ? "
                "AND status = 'migrated' LIMIT 1",
                (pair_id, message_id),
            ).fetchone()
            return row is not None

    # ── Checkpoints ──

    def get_checkpoint(self, pair_id: int, folder: str) -> Optional[dict]:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM checkpoints WHERE pair_id = ? AND folder = ?",
                (pair_id, folder),
            ).fetchone()
            return dict(row) if row else None

    def update_checkpoint(self, pair_id: int, folder: str, last_uid: int,
                          total_in_folder: int = None, migrated_count: int = None,
                          failed_count: int = None):
        with self._conn() as conn:
            existing = conn.execute(
                "SELECT id FROM checkpoints WHERE pair_id = ? AND folder = ?",
                (pair_id, folder),
            ).fetchone()
            if existing:
                sets = ["last_uid = ?", "updated_at = ?"]
                vals = [last_uid, time.time()]
                if total_in_folder is not None:
                    sets.append("total_in_folder = ?")
                    vals.append(total_in_folder)
                if migrated_count is not None:
                    sets.append("migrated_count = ?")
                    vals.append(migrated_count)
                if failed_count is not None:
                    sets.append("failed_count = ?")
                    vals.append(failed_count)
                vals.extend([pair_id, folder])
                conn.execute(
                    f"UPDATE checkpoints SET {', '.join(sets)} "
                    f"WHERE pair_id = ? AND folder = ?",
                    vals,
                )
            else:
                conn.execute(
                    "INSERT INTO checkpoints "
                    "(pair_id, folder, last_uid, total_in_folder, migrated_count, "
                    "failed_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (pair_id, folder, last_uid, total_in_folder or 0,
                     migrated_count or 0, failed_count or 0, time.time()),
                )

    def get_folder_stats(self, pair_id: int) -> list[dict]:
        """Get checkpoint stats for all folders in a pair."""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM checkpoints WHERE pair_id = ? ORDER BY folder",
                (pair_id,),
            ).fetchall()
            return [dict(r) for r in rows]
