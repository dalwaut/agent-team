"""Folder hierarchy discovery, mapping between providers, and creation."""

import logging
from typing import Optional

log = logging.getLogger("opai-email-migration.folder_mapper")

# Provider-specific folder name mappings
PROVIDER_MAPS = {
    ("m365", "hostinger"): {
        "Inbox": "INBOX",
        "Sent Items": "Sent",
        "Drafts": "Drafts",
        "Deleted Items": "Trash",
        "Junk Email": "Junk",
        "Archive": "Archive",
        "Outbox": None,  # skip
        "Conversation History": None,  # skip
        "Sync Issues": None,  # skip
    },
    ("m365", "generic"): {
        "Sent Items": "Sent",
        "Deleted Items": "Trash",
        "Junk Email": "Junk",
    },
    ("gmail", "hostinger"): {
        "[Gmail]/All Mail": None,  # skip — messages already in labeled folders
        "[Gmail]/Starred": None,   # flag-based, not folder-based
        "[Gmail]/Important": None,
        "[Gmail]/Sent Mail": "Sent",
        "[Gmail]/Drafts": "Drafts",
        "[Gmail]/Spam": "Junk",
        "[Gmail]/Trash": "Trash",
    },
    ("generic", "generic"): {},
}

# Folders that should never be migrated
ALWAYS_SKIP = {
    "Outbox",
    "Conversation History",
    "Sync Issues",
    "Sync Issues/Conflicts",
    "Sync Issues/Local Failures",
    "Sync Issues/Server Failures",
}


class FolderMapper:
    """Maps source folders to target folders with provider awareness."""

    def __init__(self, source_provider: str, target_provider: str,
                 custom_map: Optional[dict] = None,
                 skip_folders: Optional[list] = None,
                 archive_prefix: Optional[str] = None):
        self.source_provider = source_provider
        self.target_provider = target_provider
        self.custom_map = custom_map or {}
        self.skip_folders = set(skip_folders or []) | ALWAYS_SKIP
        self.archive_prefix = archive_prefix  # e.g., "Archive/user@domain.com"

        # Load provider map
        key = (source_provider, target_provider)
        self.provider_map = PROVIDER_MAPS.get(key, PROVIDER_MAPS.get(
            (source_provider, "generic"), {}
        ))

    def map_folder(self, source_folder: str) -> Optional[str]:
        """Map a source folder name to target folder name.
        Returns None if folder should be skipped."""
        # Check skip list
        if source_folder in self.skip_folders:
            log.debug(f"Skipping folder: {source_folder}")
            return None

        # Custom map takes priority
        if source_folder in self.custom_map:
            mapped = self.custom_map[source_folder]
            if mapped is None:
                log.debug(f"Custom skip: {source_folder}")
                return None
            target = mapped
        # Then provider map
        elif source_folder in self.provider_map:
            mapped = self.provider_map[source_folder]
            if mapped is None:
                log.debug(f"Provider skip: {source_folder}")
                return None
            target = mapped
        else:
            # Pass through as-is
            target = source_folder

        # Apply archive prefix if set
        if self.archive_prefix:
            target = f"{self.archive_prefix}/{target}"

        return target

    def map_all_folders(self, source_folders: list[str]) -> dict[str, str]:
        """Map all source folders, returning {source: target} dict.
        Skipped folders are excluded."""
        result = {}
        for folder in source_folders:
            target = self.map_folder(folder)
            if target is not None:
                result[folder] = target
        return result

    def get_delimiter(self, provider: str) -> str:
        """Get the folder hierarchy delimiter for a provider."""
        delimiters = {
            "m365": "/",
            "gmail": "/",
            "hostinger": ".",
            "generic": "/",
        }
        return delimiters.get(provider, "/")

    def convert_hierarchy(self, folder: str, source_delim: str, target_delim: str) -> str:
        """Convert folder hierarchy delimiters."""
        if source_delim == target_delim:
            return folder
        return folder.replace(source_delim, target_delim)
