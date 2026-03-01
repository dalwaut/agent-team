"""Marq — Fastlane CLI wrapper (iOS binary upload and code signing).

All metadata operations go through the Apple API, NOT Fastlane.
Fastlane is used only for:
1. Binary upload (IPA → App Store Connect)
2. Certificate/provisioning profile management (match)

Subprocess with 10-min timeout, structured result parsing.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from pathlib import Path

log = logging.getLogger("marq.fastlane")

# Default timeout for fastlane commands (10 minutes)
DEFAULT_TIMEOUT = 600


class FastlaneWrapper:
    """Fastlane CLI wrapper for iOS binary uploads and code signing.

    Fastlane must be installed: `gem install fastlane` or `brew install fastlane`
    """

    def __init__(self):
        self._fastlane_path: str | None = None

    def _find_fastlane(self) -> str:
        """Find fastlane binary path."""
        if self._fastlane_path:
            return self._fastlane_path

        path = shutil.which("fastlane")
        if path:
            self._fastlane_path = path
            return path

        # Common Homebrew locations
        for candidate in [
            "/usr/local/bin/fastlane",
            "/opt/homebrew/bin/fastlane",
            os.path.expanduser("~/.gem/bin/fastlane"),
        ]:
            if os.path.isfile(candidate):
                self._fastlane_path = candidate
                return candidate

        raise FileNotFoundError(
            "Fastlane not found. Install with: gem install fastlane"
        )

    async def _run(
        self,
        args: list[str],
        env: dict | None = None,
        timeout: int = DEFAULT_TIMEOUT,
        cwd: str | None = None,
    ) -> dict:
        """Run a fastlane command and return structured result.

        Returns:
            {
                "success": bool,
                "exit_code": int,
                "stdout": str,
                "stderr": str,
                "error": str | None,
            }
        """
        fastlane = self._find_fastlane()
        cmd = [fastlane] + args

        run_env = {**os.environ, **(env or {})}
        # Disable interactive prompts
        run_env["FASTLANE_SKIP_UPDATE_CHECK"] = "1"
        run_env["FASTLANE_HIDE_CHANGELOG"] = "1"
        run_env["FASTLANE_DISABLE_ANIMATION"] = "1"

        log.info("Running: fastlane %s (timeout=%ds)", " ".join(args[:3]), timeout)

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=run_env,
                cwd=cwd,
            )

            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )

            stdout_str = stdout.decode("utf-8", errors="replace")
            stderr_str = stderr.decode("utf-8", errors="replace")

            success = proc.returncode == 0
            if not success:
                log.warning(
                    "Fastlane exited with code %d: %s",
                    proc.returncode,
                    stderr_str[:500],
                )

            return {
                "success": success,
                "exit_code": proc.returncode,
                "stdout": stdout_str,
                "stderr": stderr_str,
                "error": None if success else f"Exit code {proc.returncode}",
            }

        except asyncio.TimeoutError:
            log.error("Fastlane timed out after %ds", timeout)
            try:
                proc.kill()
            except Exception:
                pass
            return {
                "success": False,
                "exit_code": -1,
                "stdout": "",
                "stderr": "",
                "error": f"Timeout after {timeout}s",
            }
        except FileNotFoundError:
            return {
                "success": False,
                "exit_code": -1,
                "stdout": "",
                "stderr": "",
                "error": "Fastlane binary not found",
            }

    # ── Deliver (IPA upload) ──────────────────────────────────

    async def deliver(
        self,
        ipa_path: str,
        username: str | None = None,
        app_identifier: str | None = None,
        team_id: str | None = None,
        skip_metadata: bool = True,
        skip_screenshots: bool = True,
        force: bool = True,
        submit_for_review: bool = False,
    ) -> dict:
        """Upload IPA to App Store Connect via fastlane deliver.

        Args:
            ipa_path: Path to .ipa file
            username: Apple ID (or use FASTLANE_USER env)
            app_identifier: Bundle ID (or use PRODUCE_APP_IDENTIFIER env)
            team_id: Team ID (or use FASTLANE_ITC_TEAM_ID env)
            skip_metadata: Don't upload metadata (we use API instead)
            skip_screenshots: Don't upload screenshots (we use API instead)
            force: Skip HTML preview
            submit_for_review: Auto-submit after upload

        Returns:
            {success, exit_code, stdout, stderr, error}
        """
        if not Path(ipa_path).is_file():
            return {
                "success": False,
                "exit_code": -1,
                "stdout": "",
                "stderr": "",
                "error": f"IPA file not found: {ipa_path}",
            }

        args = ["deliver"]
        args.extend(["--ipa", ipa_path])

        if skip_metadata:
            args.append("--skip_metadata")
        if skip_screenshots:
            args.append("--skip_screenshots")
        if force:
            args.append("--force")
        if submit_for_review:
            args.append("--submit_for_review")

        env = {}
        if username:
            env["FASTLANE_USER"] = username
        if app_identifier:
            env["PRODUCE_APP_IDENTIFIER"] = app_identifier
        if team_id:
            env["FASTLANE_ITC_TEAM_ID"] = team_id

        return await self._run(args, env=env, timeout=DEFAULT_TIMEOUT)

    # ── Pilot (TestFlight upload) ─────────────────────────────

    async def pilot_upload(
        self,
        ipa_path: str,
        username: str | None = None,
        app_identifier: str | None = None,
        changelog: str | None = None,
        skip_waiting: bool = True,
    ) -> dict:
        """Upload IPA to TestFlight via fastlane pilot.

        Args:
            ipa_path: Path to .ipa file
            changelog: What to test text
            skip_waiting: Don't wait for processing
        """
        if not Path(ipa_path).is_file():
            return {
                "success": False,
                "exit_code": -1,
                "stdout": "",
                "stderr": "",
                "error": f"IPA file not found: {ipa_path}",
            }

        args = ["pilot", "upload"]
        args.extend(["--ipa", ipa_path])

        if changelog:
            args.extend(["--changelog", changelog])
        if skip_waiting:
            args.append("--skip_waiting_for_build_processing")

        env = {}
        if username:
            env["FASTLANE_USER"] = username
        if app_identifier:
            env["PRODUCE_APP_IDENTIFIER"] = app_identifier

        return await self._run(args, env=env, timeout=DEFAULT_TIMEOUT)

    # ── Match (code signing) ──────────────────────────────────

    async def match(
        self,
        match_type: str = "appstore",
        app_identifier: str | None = None,
        git_url: str | None = None,
        team_id: str | None = None,
        readonly: bool = True,
    ) -> dict:
        """Manage certificates and provisioning profiles via fastlane match.

        Args:
            match_type: development, adhoc, appstore, enterprise
            app_identifier: Bundle ID
            git_url: Git repo for certificate storage
            team_id: Apple Developer Team ID
            readonly: Only fetch, don't create new certs

        Returns:
            {success, exit_code, stdout, stderr, error}
        """
        args = ["match", match_type]

        if readonly:
            args.append("--readonly")
        if app_identifier:
            args.extend(["--app_identifier", app_identifier])
        if git_url:
            args.extend(["--git_url", git_url])

        env = {}
        if team_id:
            env["FASTLANE_TEAM_ID"] = team_id

        return await self._run(args, env=env, timeout=300)

    # ── Status check ──────────────────────────────────────────

    async def check_installed(self) -> dict:
        """Check if fastlane is installed and get version info."""
        try:
            result = await self._run(["--version"], timeout=15)
            if result["success"]:
                version = result["stdout"].strip().split("\n")[-1].strip()
                return {
                    "installed": True,
                    "version": version,
                    "path": self._find_fastlane(),
                }
        except FileNotFoundError:
            pass
        return {"installed": False, "version": None, "path": None}
