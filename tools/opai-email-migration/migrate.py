#!/usr/bin/env python3
"""Email Migration Tool — CLI entry point and Engine worker bridge.

Usage:
  python3 migrate.py --job jobs/config.json [--dry-run] [--resume]
  python3 migrate.py --status <job_id>
  python3 migrate.py --verify <job_id>
  python3 migrate.py --dns-guide <source_provider> <target_provider> <domain>
  python3 migrate.py --list-jobs

Engine worker mode:
  Called via Engine's worker_manager with --engine-task flag.
"""

import argparse
import json
import sys
import time
from pathlib import Path

# Add parent for shared imports
sys.path.insert(0, str(Path(__file__).parent))

from config import setup_logging, load_env_credential, JOBS_DIR
from state import MigrationState


def main():
    parser = argparse.ArgumentParser(description="OPAI Email Migration Tool")
    parser.add_argument("--job", type=str, help="Path to job config JSON file")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be migrated")
    parser.add_argument("--resume", action="store_true", help="Resume a previously started job")
    parser.add_argument("--status", type=str, metavar="JOB_ID", help="Check job status")
    parser.add_argument("--verify", type=str, metavar="JOB_ID", help="Run post-migration verification")
    parser.add_argument("--dns-guide", nargs=3, metavar=("SRC", "TGT", "DOMAIN"),
                        help="Generate DNS cutover guide")
    parser.add_argument("--list-jobs", action="store_true", help="List all migration jobs")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose logging")
    parser.add_argument("--engine-task", type=str, help="Engine worker task JSON (internal)")

    args = parser.parse_args()
    log = setup_logging(args.verbose)

    state = MigrationState()

    if args.list_jobs:
        return cmd_list_jobs(state)

    if args.status:
        return cmd_status(state, args.status)

    if args.verify:
        return cmd_verify(state, args.verify)

    if args.dns_guide:
        return cmd_dns_guide(*args.dns_guide)

    if args.engine_task:
        return cmd_engine_task(state, args.engine_task)

    if args.job:
        return cmd_migrate(state, args.job, dry_run=args.dry_run, resume=args.resume)

    parser.print_help()
    return 1


def cmd_migrate(state: MigrationState, job_path: str,
                dry_run: bool = False, resume: bool = False) -> int:
    """Run a migration from a job config file."""
    from imap_source import IMAPSource
    from imap_target import IMAPTarget
    from folder_mapper import FolderMapper
    from migration_engine import MigrationEngine

    log = setup_logging()

    # Load job config
    job_file = Path(job_path)
    if not job_file.is_absolute():
        job_file = JOBS_DIR / job_file
    if not job_file.exists():
        log.error(f"Job config not found: {job_file}")
        return 1

    with open(job_file) as f:
        config = json.load(f)

    job_id = config.get("job_id")
    if not job_id:
        log.error("Job config missing 'job_id'")
        return 1

    mode = config.get("options", {}).get("mode", "full")
    src_cfg = config["source"]
    tgt_cfg = config["target"]
    opts = config.get("options", {})

    # Check for resume
    existing_job = state.get_job(job_id)
    if existing_job:
        if resume:
            log.info(f"Resuming job {job_id} (status: {existing_job['status']})")
        elif existing_job["status"] in ("completed", "completed_with_errors"):
            log.info(f"Job {job_id} already completed. Use --resume to re-run.")
            return 0
        else:
            log.info(f"Job {job_id} exists (status: {existing_job['status']}). Resuming.")
    else:
        state.create_job(job_id, config, mode=mode)
        log.info(f"Created new job: {job_id}")

    # HITL gate: start_migration
    if not dry_run:
        print("\n" + "=" * 60)
        print("MIGRATION APPROVAL REQUIRED")
        print("=" * 60)
        print(f"Job ID: {job_id}")
        print(f"Mode: {mode}")
        print(f"Source: {src_cfg['provider']} ({src_cfg['host']})")
        print(f"Target: {tgt_cfg['provider']} ({tgt_cfg['host']})")
        print(f"Accounts: {len(src_cfg['accounts'])}")
        for i, acct in enumerate(src_cfg["accounts"]):
            tgt_acct = tgt_cfg["accounts"][i] if i < len(tgt_cfg["accounts"]) else tgt_cfg["accounts"][0]
            print(f"  {acct['email']} → {tgt_acct['email']}")
        print("=" * 60)
        approval = input("\nProceed with migration? (yes/no): ").strip().lower()
        if approval != "yes":
            log.info("Migration cancelled by user")
            return 0

    state.update_job(job_id, status="running", started_at=time.time())

    # Process each account pair
    total_stats = {"migrated": 0, "failed": 0, "skipped": 0, "total": 0}
    success = True

    for i, src_acct in enumerate(src_cfg["accounts"]):
        # Determine target account
        if mode == "archive":
            tgt_acct = tgt_cfg["accounts"][0]  # All archive to one account
        else:
            tgt_acct = tgt_cfg["accounts"][i] if i < len(tgt_cfg["accounts"]) else tgt_cfg["accounts"][-1]

        # Create or get pair
        pairs = state.get_pairs(job_id)
        pair = next((p for p in pairs if p["source_email"] == src_acct["email"]), None)
        if pair:
            pair_id = pair["id"]
            if pair["status"] == "completed" and not resume:
                log.info(f"Pair already completed: {src_acct['email']}, skipping")
                continue
        else:
            pair_id = state.create_pair(job_id, src_acct["email"], tgt_acct["email"])

        # Load credentials
        src_password = load_env_credential(src_acct["password_env"])
        tgt_password = load_env_credential(tgt_acct["password_env"])

        # Build connectors
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

        # Build folder mapper
        archive_prefix = None
        if mode == "archive":
            prefix_template = opts.get("folder_prefix", "Archive/{source_email}")
            archive_prefix = prefix_template.replace("{source_email}", src_acct["email"])

        mapper = FolderMapper(
            source_provider=src_cfg["provider"],
            target_provider=tgt_cfg["provider"],
            custom_map=opts.get("custom_folder_map"),
            skip_folders=opts.get("skip_folders"),
            archive_prefix=archive_prefix,
        )

        # Run migration
        engine = MigrationEngine(
            state=state, source=source, target=target,
            folder_mapper=mapper, job_id=job_id, pair_id=pair_id,
            batch_size=opts.get("batch_size", 50),
            dry_run=dry_run,
        )

        try:
            source.connect()
            target.connect()
            pair_stats = engine.run()
            for k in total_stats:
                total_stats[k] += pair_stats.get(k, 0)
        except Exception as e:
            log.error(f"Migration failed for {src_acct['email']}: {e}")
            state.update_pair(pair_id, status="failed", error=str(e)[:500])
            success = False
        finally:
            source.disconnect()
            target.disconnect()

    # Update job final status
    state.update_job(
        job_id,
        status="completed" if success else "completed_with_errors",
        completed_at=time.time(),
        total_messages=total_stats["total"],
        migrated_messages=total_stats["migrated"],
        failed_messages=total_stats["failed"],
        skipped_messages=total_stats["skipped"],
    )

    _print_final_summary(job_id, total_stats, success)

    # Auto-verify if requested
    if opts.get("verify_after") and not dry_run and success:
        log.info("Running post-migration verification...")
        cmd_verify(state, job_id)

    return 0 if success else 1


def cmd_status(state: MigrationState, job_id: str) -> int:
    """Show status of a migration job."""
    job = state.get_job(job_id)
    if not job:
        print(f"Job not found: {job_id}")
        return 1

    print(f"\n{'=' * 50}")
    print(f"Job: {job_id}")
    print(f"Status: {job['status']}")
    print(f"Mode: {job['mode']}")
    print(f"Total: {job['total_messages']}  Migrated: {job['migrated_messages']}  "
          f"Failed: {job['failed_messages']}  Skipped: {job['skipped_messages']}")

    if job["error"]:
        print(f"Error: {job['error']}")

    pairs = state.get_pairs(job_id)
    for pair in pairs:
        print(f"\n  {pair['source_email']} → {pair['target_email']}")
        print(f"    Status: {pair['status']}  "
              f"Migrated: {pair['migrated_messages']}/{pair['total_messages']}  "
              f"Failed: {pair['failed_messages']}")

        folder_stats = state.get_folder_stats(pair["id"])
        for fs in folder_stats:
            print(f"      {fs['folder']}: {fs['migrated_count']}/{fs['total_in_folder']} "
                  f"(last UID: {fs['last_uid']})")

    print(f"{'=' * 50}\n")
    return 0


def cmd_list_jobs(state: MigrationState) -> int:
    """List all migration jobs."""
    jobs = state.list_jobs()
    if not jobs:
        print("No migration jobs found.")
        return 0

    print(f"\n{'ID':<35} {'Status':<25} {'Mode':<10} {'Migrated':<10} {'Failed':<8}")
    print("-" * 90)
    for job in jobs:
        print(f"{job['id']:<35} {job['status']:<25} {job['mode']:<10} "
              f"{job['migrated_messages']:<10} {job['failed_messages']:<8}")
    print()
    return 0


def cmd_verify(state: MigrationState, job_id: str) -> int:
    """Run post-migration verification."""
    try:
        from verify import PostMigrationVerifier
        verifier = PostMigrationVerifier(state, job_id)
        results = verifier.run_all()
        verifier.print_report(results)
        return 0 if results["overall_pass"] else 1
    except ImportError:
        print("Verification module not available. Build Phase 2 first.")
        return 1


def cmd_dns_guide(source_provider: str, target_provider: str, domain: str) -> int:
    """Generate DNS cutover guide."""
    try:
        from dns_guide import DNSGuideGenerator
        guide = DNSGuideGenerator(source_provider, target_provider, domain)
        print(guide.generate())
        return 0
    except ImportError:
        print("DNS guide module not available. Build Phase 2 first.")
        return 1


def cmd_engine_task(state: MigrationState, task_json: str) -> int:
    """Handle a task dispatched from Engine worker_manager."""
    task = json.loads(task_json)
    action = task.get("action", "migrate")

    if action == "migrate":
        job_path = task.get("job_config")
        if not job_path:
            print("ERROR: Engine task missing 'job_config'")
            return 1
        return cmd_migrate(state, job_path, dry_run=task.get("dry_run", False))

    elif action == "status":
        return cmd_status(state, task["job_id"])

    elif action == "verify":
        return cmd_verify(state, task["job_id"])

    elif action == "dns_guide":
        return cmd_dns_guide(task["source_provider"], task["target_provider"], task["domain"])

    else:
        print(f"Unknown engine action: {action}")
        return 1


def _print_final_summary(job_id: str, stats: dict, success: bool):
    status = "COMPLETED" if success else "COMPLETED WITH ERRORS"
    print(f"\n{'=' * 50}")
    print(f"MIGRATION {status}")
    print(f"{'=' * 50}")
    print(f"Job: {job_id}")
    print(f"Total messages: {stats['total']}")
    print(f"Migrated:       {stats['migrated']}")
    print(f"Failed:         {stats['failed']}")
    print(f"Skipped (dedup):{stats['skipped']}")
    print(f"{'=' * 50}\n")


if __name__ == "__main__":
    sys.exit(main() or 0)
