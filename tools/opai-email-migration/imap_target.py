"""Target IMAP connector — writes to Hostinger/generic IMAP servers."""

import logging
import time
from typing import Optional

import imapclient

from config import DEFAULT_IMAP_PORT, IMAP_TIMEOUT, MAX_RETRIES, RETRY_BACKOFF

log = logging.getLogger("opai-email-migration.target")

# Standard IMAP flags to preserve
STANDARD_FLAGS = {b"\\Seen", b"\\Answered", b"\\Flagged", b"\\Draft", b"\\Deleted"}


class IMAPTarget:
    """IMAP connection to target mailbox with write operations."""

    def __init__(self, host: str, email_addr: str, password: str,
                 port: int = DEFAULT_IMAP_PORT, provider: str = "generic"):
        self.host = host
        self.email_addr = email_addr
        self.password = password
        self.port = port
        self.provider = provider
        self.client: Optional[imapclient.IMAPClient] = None
        self._created_folders: set[str] = set()

    def connect(self):
        """Connect and authenticate to target IMAP server."""
        log.info(f"Connecting to target: {self.host}:{self.port} as {self.email_addr}")
        self.client = imapclient.IMAPClient(
            self.host, port=self.port, ssl=True, timeout=IMAP_TIMEOUT
        )
        self.client.login(self.email_addr, self.password)
        log.info(f"Target connected: {self.email_addr}")

    def disconnect(self):
        """Close connection safely."""
        if self.client:
            try:
                self.client.logout()
            except Exception:
                pass
            self.client = None

    def reconnect(self):
        """Reconnect after a connection drop."""
        log.warning("Reconnecting to target...")
        self.disconnect()
        time.sleep(2)
        self.connect()

    def _ensure_connected(self):
        if not self.client:
            self.connect()
            return
        try:
            self.client.noop()
        except Exception:
            self.reconnect()

    def list_folders(self) -> list[str]:
        """List all existing folders on target."""
        self._ensure_connected()
        raw = self.client.list_folders()
        return [name for _, _, name in raw]

    def create_folder(self, folder_path: str) -> bool:
        """Create folder (and parent hierarchy) if it doesn't exist.
        Returns True if created, False if already existed."""
        if folder_path in self._created_folders:
            return False

        self._ensure_connected()
        existing = set(self.list_folders())

        if folder_path in existing:
            self._created_folders.add(folder_path)
            return False

        # Create parent hierarchy
        delimiter = self._get_delimiter()
        parts = folder_path.split(delimiter)
        for i in range(1, len(parts) + 1):
            partial = delimiter.join(parts[:i])
            if partial not in existing and partial not in self._created_folders:
                try:
                    self.client.create_folder(partial)
                    log.info(f"Created folder: {partial}")
                    self._created_folders.add(partial)
                except Exception as e:
                    # Might already exist due to race or implicit creation
                    if "ALREADYEXISTS" in str(e).upper() or "EXISTS" in str(e).upper():
                        self._created_folders.add(partial)
                    else:
                        raise

        self._created_folders.add(folder_path)
        return True

    def _get_delimiter(self) -> str:
        """Detect folder delimiter from server."""
        try:
            folders = self.client.list_folders()
            if folders:
                delim = folders[0][1]
                if isinstance(delim, bytes):
                    delim = delim.decode()
                return delim
        except Exception:
            pass
        # Fallback per provider
        return "." if self.provider == "hostinger" else "/"

    def append_message(self, folder: str, raw_bytes: bytes,
                       flags: list = None, msg_date=None) -> Optional[int]:
        """Append a raw RFC822 message to target folder.
        Returns the new UID or None on failure."""
        self._ensure_connected()

        # Filter to standard flags only
        clean_flags = []
        if flags:
            for f in flags:
                fb = f.encode() if isinstance(f, str) else f
                if fb in STANDARD_FLAGS:
                    clean_flags.append(fb)

        for attempt in range(MAX_RETRIES):
            try:
                result = self.client.append(
                    folder, raw_bytes,
                    flags=clean_flags if clean_flags else None,
                    msg_time=msg_date,
                )
                # imapclient returns APPENDUID response if supported
                if isinstance(result, bytes):
                    # Parse APPENDUID from response
                    resp = result.decode("utf-8", errors="replace")
                    if "APPENDUID" in resp:
                        parts = resp.split()
                        for i, p in enumerate(parts):
                            if p == "APPENDUID" and i + 2 < len(parts):
                                try:
                                    return int(parts[i + 2].rstrip("]").rstrip(")"))
                                except ValueError:
                                    pass
                return None  # Success but no UID available
            except Exception as e:
                if attempt < MAX_RETRIES - 1:
                    wait = RETRY_BACKOFF[attempt]
                    log.warning(f"Append failed (attempt {attempt + 1}): {e}. "
                                f"Retrying in {wait}s...")
                    time.sleep(wait)
                    self.reconnect()
                else:
                    log.error(f"Append failed after {MAX_RETRIES} attempts: {e}")
                    raise

    def check_message_exists(self, folder: str, message_id: str) -> bool:
        """Check if a message with given Message-ID exists in target folder."""
        if not message_id:
            return False
        self._ensure_connected()
        try:
            self.client.select_folder(folder, readonly=True)
            # Search by Message-ID header
            uids = self.client.search([f'HEADER Message-ID "{message_id}"'])
            return len(uids) > 0
        except Exception as e:
            log.debug(f"Message-ID check failed for {message_id}: {e}")
            return False

    def get_folder_message_count(self, folder: str) -> int:
        """Get message count in a target folder."""
        self._ensure_connected()
        try:
            info = self.client.select_folder(folder, readonly=True)
            return info.get(b"EXISTS", 0)
        except Exception:
            return 0

    def get_quota(self) -> Optional[dict]:
        """Get mailbox quota info if supported."""
        self._ensure_connected()
        try:
            quota = self.client.get_quota()
            if quota:
                return {"used": quota[0], "total": quota[1]}
        except Exception:
            pass
        return None

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *args):
        self.disconnect()
