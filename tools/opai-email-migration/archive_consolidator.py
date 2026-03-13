"""Multi-account consolidation — migrates N source accounts into 1 target with prefixed folders."""

import logging
import time

from config import load_env_credential
from state import MigrationState
from imap_source import IMAPSource
from imap_target import IMAPTarget
from folder_mapper import FolderMapper
from migration_engine import MigrationEngine

log = logging.getLogger("opai-email-migration.archive")


class ArchiveConsolidator:
    """Wraps MigrationEngine to consolidate multiple source accounts
    into a single target account with Archive/{email}/ folder prefixes."""

    def __init__(self, state: MigrationState, config: dict,
                 dry_run: bool = False):
        self.state = state
        self.config = config
        self.dry_run = dry_run
        self.job_id = config["job_id"]

    def run(self) -> dict:
        """Consolidate all source accounts into the target archive account."""
        src_cfg = self.config["source"]
        tgt_cfg = self.config["target"]
        opts = self.config.get("options", {})

        # Single target account for archive
        tgt_acct = tgt_cfg["accounts"][0]
        tgt_password = load_env_credential(tgt_acct["password_env"])

        total_stats = {"migrated": 0, "failed": 0, "skipped": 0, "total": 0}

        for src_acct in src_cfg["accounts"]:
            log.info(f"Archiving: {src_acct['email']} → {tgt_acct['email']}")

            # Create or get pair
            pairs = self.state.get_pairs(self.job_id)
            pair = next((p for p in pairs if p["source_email"] == src_acct["email"]), None)
            if pair:
                pair_id = pair["id"]
                if pair["status"] == "completed":
                    log.info(f"  Already archived, skipping")
                    continue
            else:
                pair_id = self.state.create_pair(
                    self.job_id, src_acct["email"], tgt_acct["email"]
                )

            src_password = load_env_credential(src_acct["password_env"])

            # Build prefix from template
            prefix_template = opts.get("folder_prefix", "Archive/{source_email}")
            archive_prefix = prefix_template.replace("{source_email}", src_acct["email"])

            source = IMAPSource(
                host=src_cfg["host"],
                email_addr=src_acct["email"],
                password=src_password,
                port=src_cfg.get("port", 993),
                oauth2=(src_cfg.get("auth") == "oauth2"),
                provider=src_cfg["provider"],
            )
            target = IMAPTarget(
                host=tgt_cfg["host"],
                email_addr=tgt_acct["email"],
                password=tgt_password,
                port=tgt_cfg.get("port", 993),
                provider=tgt_cfg["provider"],
            )

            mapper = FolderMapper(
                source_provider=src_cfg["provider"],
                target_provider=tgt_cfg["provider"],
                skip_folders=opts.get("skip_folders"),
                archive_prefix=archive_prefix,
            )

            engine = MigrationEngine(
                state=self.state, source=source, target=target,
                folder_mapper=mapper, job_id=self.job_id, pair_id=pair_id,
                batch_size=opts.get("batch_size", 100),
                dry_run=self.dry_run,
            )

            try:
                source.connect()
                target.connect()
                pair_stats = engine.run()
                for k in total_stats:
                    total_stats[k] += pair_stats.get(k, 0)
            except Exception as e:
                log.error(f"Archive failed for {src_acct['email']}: {e}")
                self.state.update_pair(pair_id, status="failed", error=str(e)[:500])
            finally:
                source.disconnect()
                target.disconnect()

        return total_stats
