"""Source IMAP connector — reads from M365/Gmail/generic IMAP servers."""

import email
import email.utils
import logging
import time
from typing import Optional

import imapclient

from config import DEFAULT_IMAP_PORT, IMAP_TIMEOUT, MAX_RETRIES, RETRY_BACKOFF

log = logging.getLogger("opai-email-migration.source")


class IMAPSource:
    """Read-only IMAP connection to source mailbox."""

    def __init__(self, host: str, email_addr: str, password: str,
                 port: int = DEFAULT_IMAP_PORT, oauth2: bool = False,
                 provider: str = "generic"):
        self.host = host
        self.email_addr = email_addr
        self.password = password
        self.port = port
        self.oauth2 = oauth2
        self.provider = provider
        self.client: Optional[imapclient.IMAPClient] = None

    def connect(self):
        """Connect and authenticate to source IMAP server."""
        log.info(f"Connecting to source: {self.host}:{self.port} as {self.email_addr}")
        self.client = imapclient.IMAPClient(
            self.host, port=self.port, ssl=True, timeout=IMAP_TIMEOUT
        )
        if self.oauth2:
            self._oauth2_login()
        else:
            self.client.login(self.email_addr, self.password)
        log.info(f"Source connected: {self.email_addr}")

    def _oauth2_login(self):
        """Authenticate via OAuth2 XOAUTH2 SASL mechanism."""
        try:
            import msal
        except ImportError:
            raise ImportError("msal package required for OAuth2. pip install msal")

        # For M365, password field contains the client secret or refresh token
        # The actual OAuth2 flow depends on the tenant config
        auth_string = f"user={self.email_addr}\x01auth=Bearer {self.password}\x01\x01"
        self.client.oauth2_login(self.email_addr, auth_string)

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
        log.warning("Reconnecting to source...")
        self.disconnect()
        time.sleep(2)
        self.connect()

    def _ensure_connected(self):
        """Verify connection is alive, reconnect if needed."""
        if not self.client:
            self.connect()
            return
        try:
            self.client.noop()
        except Exception:
            self.reconnect()

    def list_folders(self) -> list[dict]:
        """Discover all folders with hierarchy info.
        Returns list of {name, delimiter, flags}."""
        self._ensure_connected()
        raw_folders = self.client.list_folders()
        folders = []
        for flags, delimiter, name in raw_folders:
            # Decode delimiter
            if isinstance(delimiter, bytes):
                delimiter = delimiter.decode()
            folders.append({
                "name": name,
                "delimiter": delimiter,
                "flags": [f.decode() if isinstance(f, bytes) else str(f) for f in flags],
            })
        log.info(f"Source has {len(folders)} folders")
        return folders

    def get_folder_message_count(self, folder: str) -> int:
        """Get total message count in a folder."""
        self._ensure_connected()
        info = self.client.select_folder(folder, readonly=True)
        count = info.get(b"EXISTS", 0)
        return count

    def get_folder_uids(self, folder: str) -> list[int]:
        """Get all message UIDs in a folder, sorted ascending."""
        self._ensure_connected()
        self.client.select_folder(folder, readonly=True)
        uids = self.client.search(["ALL"])
        return sorted(uids)

    def fetch_messages_batch(self, folder: str, since_uid: int = 0,
                             batch_size: int = 50) -> list[dict]:
        """Fetch message metadata in batches using UID-based pagination.
        Returns list of {uid, message_id, subject, date, size, flags}."""
        self._ensure_connected()
        self.client.select_folder(folder, readonly=True)

        # Get UIDs > since_uid
        if since_uid > 0:
            uids = self.client.search([f"UID {since_uid + 1}:*"])
            # Filter out since_uid itself (IMAP range is inclusive)
            uids = [u for u in uids if u > since_uid]
        else:
            uids = self.client.search(["ALL"])

        uids = sorted(uids)[:batch_size]
        if not uids:
            return []

        # Fetch envelope data (lightweight)
        data = self.client.fetch(uids, ["ENVELOPE", "RFC822.SIZE", "FLAGS"])
        messages = []
        for uid, msg_data in data.items():
            envelope = msg_data.get(b"ENVELOPE")
            if not envelope:
                continue
            messages.append({
                "uid": uid,
                "message_id": envelope.message_id.decode() if envelope.message_id else None,
                "subject": _decode_envelope_subject(envelope.subject),
                "date": str(envelope.date) if envelope.date else None,
                "size": msg_data.get(b"RFC822.SIZE", 0),
                "flags": [f.decode() if isinstance(f, bytes) else str(f)
                          for f in msg_data.get(b"FLAGS", [])],
            })
        return messages

    def fetch_message_full(self, folder: str, uid: int) -> Optional[dict]:
        """Fetch complete RFC822 message for append to target.
        Returns {uid, raw_bytes, flags, date} or None."""
        self._ensure_connected()
        self.client.select_folder(folder, readonly=True)

        for attempt in range(MAX_RETRIES):
            try:
                data = self.client.fetch([uid], ["RFC822", "FLAGS", "INTERNALDATE"])
                if uid not in data:
                    log.warning(f"UID {uid} not found in {folder}")
                    return None
                msg_data = data[uid]
                return {
                    "uid": uid,
                    "raw_bytes": msg_data[b"RFC822"],
                    "flags": [f.decode() if isinstance(f, bytes) else str(f)
                              for f in msg_data.get(b"FLAGS", [])],
                    "date": msg_data.get(b"INTERNALDATE"),
                }
            except Exception as e:
                if attempt < MAX_RETRIES - 1:
                    wait = RETRY_BACKOFF[attempt]
                    log.warning(f"Fetch UID {uid} failed (attempt {attempt + 1}): {e}. "
                                f"Retrying in {wait}s...")
                    time.sleep(wait)
                    self.reconnect()
                    self.client.select_folder(folder, readonly=True)
                else:
                    log.error(f"Failed to fetch UID {uid} after {MAX_RETRIES} attempts: {e}")
                    return None

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *args):
        self.disconnect()


def _decode_envelope_subject(raw_subject) -> str:
    """Decode IMAP envelope subject bytes to string."""
    if raw_subject is None:
        return "(no subject)"
    if isinstance(raw_subject, bytes):
        try:
            # Try to decode MIME encoded words
            decoded_parts = email.header.decode_header(raw_subject.decode("utf-8", errors="replace"))
            parts = []
            for part, charset in decoded_parts:
                if isinstance(part, bytes):
                    parts.append(part.decode(charset or "utf-8", errors="replace"))
                else:
                    parts.append(part)
            return "".join(parts)
        except Exception:
            return raw_subject.decode("utf-8", errors="replace")
    return str(raw_subject)
