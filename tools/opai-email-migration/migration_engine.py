"""Core migration loop — batch fetch, dedup, append, checkpoint."""

import logging
import time
from typing import Optional, Callable

from config import DEFAULT_BATCH_SIZE, NOTIFY_EVERY_N_BATCHES
from state import MigrationState
from imap_source import IMAPSource
from imap_target import IMAPTarget
from folder_mapper import FolderMapper

log = logging.getLogger("opai-email-migration.engine")


class MigrationEngine:
    """Orchestrates the per-folder migration loop with checkpointing."""

    def __init__(self, state: MigrationState, source: IMAPSource, target: IMAPTarget,
                 folder_mapper: FolderMapper, job_id: str, pair_id: int,
                 batch_size: int = DEFAULT_BATCH_SIZE,
                 dry_run: bool = False,
                 on_progress: Optional[Callable] = None,
                 cancel_flag: Optional[Callable] = None):
        self.state = state
        self.source = source
        self.target = target
        self.mapper = folder_mapper
        self.job_id = job_id
        self.pair_id = pair_id
        self.batch_size = batch_size
        self.dry_run = dry_run
        self.on_progress = on_progress  # callback(migrated, total, folder)
        self.cancel_flag = cancel_flag or (lambda: False)

        self.stats = {"migrated": 0, "failed": 0, "skipped": 0, "total": 0}

    def run(self) -> dict:
        """Execute full migration for one account pair.
        Returns final stats dict."""
        log.info(f"Starting migration for pair {self.pair_id}")
        self.state.update_pair(self.pair_id, status="running")

        # Discover source folders
        source_folders = self.source.list_folders()
        folder_names = [f["name"] for f in source_folders]
        log.info(f"Source folders: {folder_names}")

        # Map to target folders
        folder_map = self.mapper.map_all_folders(folder_names)
        self.state.update_pair(self.pair_id, folder_map=str(folder_map))
        log.info(f"Folder mapping: {folder_map}")

        if not folder_map:
            log.warning("No folders to migrate after mapping")
            self.state.update_pair(self.pair_id, status="completed")
            return self.stats

        # Count total messages
        total = 0
        for src_folder in folder_map:
            count = self.source.get_folder_message_count(src_folder)
            total += count
            log.info(f"  {src_folder}: {count} messages")
        self.stats["total"] = total
        self.state.update_pair(self.pair_id, total_messages=total)

        if self.dry_run:
            log.info(f"DRY RUN — would migrate {total} messages across "
                     f"{len(folder_map)} folders")
            self._print_dry_run_summary(folder_map)
            return self.stats

        # Migrate each folder
        for src_folder, tgt_folder in folder_map.items():
            if self.cancel_flag():
                log.warning("Migration cancelled by user")
                self.state.update_pair(self.pair_id, status="cancelled")
                break

            self._migrate_folder(src_folder, tgt_folder)

        # Final status
        final_stats = self.state.get_message_stats(self.pair_id)
        self.stats.update(final_stats)

        if self.stats.get("failed", 0) > 0:
            self.state.update_pair(
                self.pair_id, status="completed_with_errors",
                migrated_messages=self.stats["migrated"],
                failed_messages=self.stats["failed"],
            )
        else:
            self.state.update_pair(
                self.pair_id, status="completed",
                migrated_messages=self.stats["migrated"],
                failed_messages=0,
            )

        log.info(f"Migration complete for pair {self.pair_id}: {self.stats}")
        return self.stats

    def _migrate_folder(self, src_folder: str, tgt_folder: str):
        """Migrate all messages from one source folder to target folder."""
        log.info(f"Migrating: {src_folder} → {tgt_folder}")

        # Create target folder
        self.target.create_folder(tgt_folder)

        # Check for existing checkpoint (resume support)
        checkpoint = self.state.get_checkpoint(self.pair_id, src_folder)
        last_uid = checkpoint["last_uid"] if checkpoint else 0
        if last_uid > 0:
            log.info(f"  Resuming from UID {last_uid}")

        # Get total messages for progress
        folder_total = self.source.get_folder_message_count(src_folder)
        batch_count = 0

        while True:
            if self.cancel_flag():
                break

            # Fetch next batch of metadata
            batch = self.source.fetch_messages_batch(
                src_folder, since_uid=last_uid, batch_size=self.batch_size
            )
            if not batch:
                break

            batch_count += 1

            for msg_meta in batch:
                if self.cancel_flag():
                    break

                uid = msg_meta["uid"]
                message_id = msg_meta.get("message_id")

                # Record in state DB
                self.state.record_message(
                    self.job_id, self.pair_id, src_folder, uid,
                    message_id=message_id,
                    subject=msg_meta.get("subject", "")[:200],
                    date=msg_meta.get("date"),
                    size=msg_meta.get("size"),
                )

                # Dedup check — skip if already migrated
                if self.state.check_message_exists(self.pair_id, message_id):
                    self.state.update_message(
                        self.pair_id, src_folder, uid, status="skipped"
                    )
                    self.stats["skipped"] += 1
                    last_uid = uid
                    continue

                # Fetch full message
                full_msg = self.source.fetch_message_full(src_folder, uid)
                if not full_msg:
                    self.state.update_message(
                        self.pair_id, src_folder, uid,
                        status="failed", error="Failed to fetch from source",
                    )
                    self.stats["failed"] += 1
                    last_uid = uid
                    continue

                # Append to target
                try:
                    target_uid = self.target.append_message(
                        tgt_folder,
                        full_msg["raw_bytes"],
                        flags=full_msg.get("flags"),
                        msg_date=full_msg.get("date"),
                    )
                    self.state.update_message(
                        self.pair_id, src_folder, uid,
                        status="migrated",
                        target_folder=tgt_folder,
                        target_uid=target_uid,
                        message_id=message_id,
                        migrated_at=time.time(),
                    )
                    self.stats["migrated"] += 1
                except Exception as e:
                    self.state.update_message(
                        self.pair_id, src_folder, uid,
                        status="failed", error=str(e)[:500],
                    )
                    self.stats["failed"] += 1
                    log.error(f"  Failed UID {uid}: {e}")

                last_uid = uid

            # Update checkpoint after each batch
            self.state.update_checkpoint(
                self.pair_id, src_folder, last_uid,
                total_in_folder=folder_total,
                migrated_count=self.stats["migrated"],
                failed_count=self.stats["failed"],
            )

            # Progress notification
            if batch_count % NOTIFY_EVERY_N_BATCHES == 0 and self.on_progress:
                self.on_progress(self.stats["migrated"], self.stats["total"], src_folder)

            log.info(f"  Batch {batch_count}: {len(batch)} processed, "
                     f"running total: {self.stats['migrated']} migrated, "
                     f"{self.stats['failed']} failed")

        log.info(f"  Folder done: {src_folder} "
                 f"({self.stats['migrated']} migrated, {self.stats['failed']} failed)")

    def _print_dry_run_summary(self, folder_map: dict):
        """Print a summary of what would be migrated."""
        print("\n=== DRY RUN SUMMARY ===")
        print(f"Job: {self.job_id}")
        print(f"Source: {self.source.email_addr} @ {self.source.host}")
        print(f"Target: {self.target.email_addr} @ {self.target.host}")
        print(f"\nFolders to migrate ({len(folder_map)}):")
        for src, tgt in folder_map.items():
            count = self.source.get_folder_message_count(src)
            print(f"  {src} → {tgt}  ({count} messages)")
        print(f"\nTotal messages: {self.stats['total']}")
        print("======================\n")
