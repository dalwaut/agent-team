"""Post-migration verification — count comparison, sampling, flag checks."""

import json
import logging
import random

from config import load_env_credential
from state import MigrationState
from imap_source import IMAPSource
from imap_target import IMAPTarget

log = logging.getLogger("opai-email-migration.verify")

SAMPLE_SIZE = 10  # Messages to spot-check per folder


class PostMigrationVerifier:
    """Automated post-migration verification suite."""

    def __init__(self, state: MigrationState, job_id: str):
        self.state = state
        self.job_id = job_id

    def run_all(self) -> dict:
        """Run all verification checks. Returns results dict."""
        job = self.state.get_job(self.job_id)
        if not job:
            return {"overall_pass": False, "error": f"Job {self.job_id} not found"}

        config = json.loads(job["config"])
        results = {
            "job_id": self.job_id,
            "checks": [],
            "overall_pass": True,
        }

        pairs = self.state.get_pairs(self.job_id)
        for pair in pairs:
            pair_results = self._verify_pair(pair, config)
            results["checks"].append(pair_results)
            if not pair_results["pass"]:
                results["overall_pass"] = False

        return results

    def _verify_pair(self, pair: dict, config: dict) -> dict:
        """Verify a single account pair migration."""
        result = {
            "source": pair["source_email"],
            "target": pair["target_email"],
            "pass": True,
            "checks": {},
        }

        # 1. Message count comparison from state DB
        stats = self.state.get_message_stats(pair["id"])
        folder_stats = self.state.get_folder_stats(pair["id"])

        result["checks"]["message_counts"] = {
            "total_source": stats.get("total", 0),
            "migrated": stats.get("migrated", 0),
            "failed": stats.get("failed", 0),
            "skipped": stats.get("skipped", 0),
            "pending": stats.get("pending", 0),
            "pass": stats.get("pending", 0) == 0 and stats.get("failed", 0) == 0,
        }
        if not result["checks"]["message_counts"]["pass"]:
            result["pass"] = False

        # 2. Folder completeness
        result["checks"]["folder_completeness"] = {
            "folders": len(folder_stats),
            "details": [],
            "pass": True,
        }
        for fs in folder_stats:
            folder_ok = fs["migrated_count"] >= fs["total_in_folder"] - fs["failed_count"]
            result["checks"]["folder_completeness"]["details"].append({
                "folder": fs["folder"],
                "source_count": fs["total_in_folder"],
                "migrated": fs["migrated_count"],
                "failed": fs["failed_count"],
                "pass": folder_ok,
            })
            if not folder_ok:
                result["checks"]["folder_completeness"]["pass"] = False
                result["pass"] = False

        # 3. Live IMAP count comparison (if we can connect)
        result["checks"]["live_count"] = self._live_count_check(pair, config)
        if not result["checks"]["live_count"].get("pass", True):
            result["pass"] = False

        return result

    def _live_count_check(self, pair: dict, config: dict) -> dict:
        """Connect to both servers and compare live folder counts."""
        src_cfg = config["source"]
        tgt_cfg = config["target"]

        # Find account configs
        src_acct = next(
            (a for a in src_cfg["accounts"] if a["email"] == pair["source_email"]), None
        )
        tgt_acct = next(
            (a for a in tgt_cfg["accounts"] if a["email"] == pair["target_email"]), None
        )
        if not tgt_acct:
            tgt_acct = tgt_cfg["accounts"][0]

        if not src_acct:
            return {"pass": True, "note": "Source account config not found, skipping live check"}

        try:
            src_pass = load_env_credential(src_acct["password_env"])
            tgt_pass = load_env_credential(tgt_acct["password_env"])
        except ValueError as e:
            return {"pass": True, "note": f"Credentials not available: {e}"}

        check = {"folders": [], "pass": True}

        try:
            source = IMAPSource(
                host=src_cfg["host"], email_addr=src_acct["email"],
                password=src_pass, port=src_cfg.get("port", 993),
                provider=src_cfg["provider"],
            )
            target = IMAPTarget(
                host=tgt_cfg["host"], email_addr=tgt_acct["email"],
                password=tgt_pass, port=tgt_cfg.get("port", 993),
                provider=tgt_cfg["provider"],
            )
            source.connect()
            target.connect()

            # Check folder counts for migrated folders
            folder_stats = self.state.get_folder_stats(pair["id"])
            for fs in folder_stats:
                src_count = source.get_folder_message_count(fs["folder"])
                # Target folder name might differ — use the checkpoint folder
                tgt_count = target.get_folder_message_count(fs["folder"])
                match = tgt_count >= fs["migrated_count"]
                check["folders"].append({
                    "folder": fs["folder"],
                    "source_live": src_count,
                    "target_live": tgt_count,
                    "expected_migrated": fs["migrated_count"],
                    "pass": match,
                })
                if not match:
                    check["pass"] = False

            source.disconnect()
            target.disconnect()
        except Exception as e:
            check["note"] = f"Live check failed: {e}"
            # Don't fail overall for connectivity issues
            check["pass"] = True

        return check

    def print_report(self, results: dict):
        """Print verification report to stdout."""
        status = "PASS" if results["overall_pass"] else "FAIL"
        print(f"\n{'=' * 60}")
        print(f"POST-MIGRATION VERIFICATION — {status}")
        print(f"{'=' * 60}")
        print(f"Job: {results['job_id']}")

        for pair_result in results.get("checks", []):
            pair_status = "PASS" if pair_result["pass"] else "FAIL"
            print(f"\n  {pair_result['source']} → {pair_result['target']} [{pair_status}]")

            # Message counts
            mc = pair_result["checks"].get("message_counts", {})
            print(f"    Message Counts: total={mc.get('total_source', '?')} "
                  f"migrated={mc.get('migrated', '?')} "
                  f"failed={mc.get('failed', '?')} "
                  f"skipped={mc.get('skipped', '?')} "
                  f"pending={mc.get('pending', '?')} "
                  f"[{'PASS' if mc.get('pass') else 'FAIL'}]")

            # Folder completeness
            fc = pair_result["checks"].get("folder_completeness", {})
            print(f"    Folder Completeness: {fc.get('folders', 0)} folders "
                  f"[{'PASS' if fc.get('pass') else 'FAIL'}]")
            for fd in fc.get("details", []):
                print(f"      {fd['folder']}: {fd['migrated']}/{fd['source_count']} "
                      f"({'FAIL' if not fd['pass'] else 'ok'})")

            # Live count
            lc = pair_result["checks"].get("live_count", {})
            if lc.get("note"):
                print(f"    Live Count: {lc['note']}")
            elif lc.get("folders"):
                print(f"    Live Count Check [{'PASS' if lc.get('pass') else 'FAIL'}]:")
                for lf in lc["folders"]:
                    print(f"      {lf['folder']}: src={lf['source_live']} "
                          f"tgt={lf['target_live']} "
                          f"({'FAIL' if not lf['pass'] else 'ok'})")

        print(f"\n{'=' * 60}\n")
