"""Marq — Google Play Developer API v3 connector.

Auth: OAuth2 service account (JSON key file).
Edits workflow: Create edit → make changes → commit (atomic).

Key concepts:
- All listing changes happen inside an "edit" (transaction)
- create_edit() → make changes → commit_edit() to publish
- First APK/AAB must be uploaded manually via Play Console
- Reviews API is separate (no edit needed)
"""

from __future__ import annotations

import json
import logging
import time
from typing import Optional

import httpx

log = logging.getLogger("marq.google")

API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications"
SCOPES = ["https://www.googleapis.com/auth/androidpublisher"]
TOKEN_URI = "https://oauth2.googleapis.com/token"


class GooglePlayConnector:
    """Google Play Developer API v3 client.

    Usage:
        creds = json.load(open("service-account.json"))
        gp = GooglePlayConnector(creds)
        app = await gp.get_app("com.example.app")
    """

    def __init__(self, service_account_json: dict):
        self.sa = service_account_json
        self._token: str = ""
        self._token_expires: float = 0

    # ── Auth ──────────────────────────────────────────────────

    async def _get_token(self) -> str:
        """Get OAuth2 access token using service account JWT."""
        if self._token and time.time() < self._token_expires - 60:
            return self._token

        import jwt  # PyJWT

        now = int(time.time())
        payload = {
            "iss": self.sa["client_email"],
            "scope": " ".join(SCOPES),
            "aud": TOKEN_URI,
            "iat": now,
            "exp": now + 3600,
        }
        assertion = jwt.encode(payload, self.sa["private_key"], algorithm="RS256")

        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(TOKEN_URI, data={
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": assertion,
            })
            r.raise_for_status()
            data = r.json()

        self._token = data["access_token"]
        self._token_expires = now + data.get("expires_in", 3600)
        log.info("Google OAuth2 token acquired (expires in %ds)", data.get("expires_in", 3600))
        return self._token

    async def _headers(self) -> dict:
        token = await self._get_token()
        return {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

    async def _get(self, url: str) -> dict:
        headers = await self._headers()
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.get(url, headers=headers)
            if r.status_code == 404:
                return {}
            r.raise_for_status()
            return r.json()

    async def _post(self, url: str, data: dict | None = None) -> dict:
        headers = await self._headers()
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(url, headers=headers, json=data)
            r.raise_for_status()
            return r.json()

    async def _put(self, url: str, data: dict) -> dict:
        headers = await self._headers()
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.put(url, headers=headers, json=data)
            r.raise_for_status()
            return r.json()

    async def _delete(self, url: str) -> None:
        headers = await self._headers()
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.delete(url, headers=headers)
            r.raise_for_status()

    # ── App Info ──────────────────────────────────────────────

    async def get_app(self, package_name: str) -> dict:
        """Get app details. Returns empty dict if not found.

        Note: There's no direct "get app" endpoint. We use edits/list
        to verify the app exists and is accessible.
        """
        try:
            # Try to create an edit — if it works, the app exists
            edit = await self.create_edit(package_name)
            if edit.get("id"):
                # Delete the edit we just created (don't leave dangling edits)
                await self.delete_edit(package_name, edit["id"])
                return {"package_name": package_name, "accessible": True}
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                return {}
            raise
        return {}

    # ── Edits (transactions) ──────────────────────────────────

    async def create_edit(self, package_name: str) -> dict:
        """Create a new edit. Returns {id, expiryTimeSeconds}.

        An edit is an atomic transaction — changes aren't visible until committed.
        """
        url = f"{API_BASE}/{package_name}/edits"
        return await self._post(url)

    async def delete_edit(self, package_name: str, edit_id: str) -> None:
        """Delete/discard an uncommitted edit."""
        url = f"{API_BASE}/{package_name}/edits/{edit_id}"
        await self._delete(url)

    async def commit_edit(self, package_name: str, edit_id: str) -> dict:
        """Commit an edit (publish all changes atomically)."""
        url = f"{API_BASE}/{package_name}/edits/{edit_id}:commit"
        return await self._post(url)

    async def validate_edit(self, package_name: str, edit_id: str) -> dict:
        """Validate an edit without committing."""
        url = f"{API_BASE}/{package_name}/edits/{edit_id}:validate"
        return await self._post(url)

    # ── Listings (store metadata) ─────────────────────────────

    async def get_listing(self, package_name: str, edit_id: str, language: str = "en-US") -> dict:
        """Get store listing for a specific language within an edit."""
        url = f"{API_BASE}/{package_name}/edits/{edit_id}/listings/{language}"
        return await self._get(url)

    async def get_all_listings(self, package_name: str, edit_id: str) -> list:
        """Get all store listings within an edit."""
        url = f"{API_BASE}/{package_name}/edits/{edit_id}/listings"
        result = await self._get(url)
        return result.get("listings", [])

    async def update_listing(
        self,
        package_name: str,
        edit_id: str,
        language: str = "en-US",
        title: str | None = None,
        short_description: str | None = None,
        full_description: str | None = None,
    ) -> dict:
        """Update store listing within an edit.

        Args:
            package_name: Android package name
            edit_id: Active edit ID
            language: BCP-47 language code (default: en-US)
            title: App title (max 50 chars)
            short_description: Short description (max 80 chars)
            full_description: Full description (max 4000 chars)
        """
        url = f"{API_BASE}/{package_name}/edits/{edit_id}/listings/{language}"
        listing = {"language": language}
        if title is not None:
            listing["title"] = title[:50]
        if short_description is not None:
            listing["shortDescription"] = short_description[:80]
        if full_description is not None:
            listing["fullDescription"] = full_description[:4000]
        return await self._put(url, listing)

    # ── Tracks (release management) ───────────────────────────

    async def get_track(self, package_name: str, edit_id: str, track: str = "production") -> dict:
        """Get track info (production, beta, alpha, internal).

        Returns release info including versionCodes, status, etc.
        """
        url = f"{API_BASE}/{package_name}/edits/{edit_id}/tracks/{track}"
        return await self._get(url)

    async def get_track_status(self, package_name: str, track: str = "production") -> dict:
        """Get current track release status (creates temp edit).

        Convenience method that handles edit lifecycle.
        """
        edit = await self.create_edit(package_name)
        try:
            result = await self.get_track(package_name, edit["id"], track)
            return result
        finally:
            try:
                await self.delete_edit(package_name, edit["id"])
            except Exception:
                pass

    async def update_track(
        self,
        package_name: str,
        edit_id: str,
        track: str = "production",
        releases: list[dict] | None = None,
    ) -> dict:
        """Update a track's releases within an edit.

        Each release dict should have: {versionCodes, status, releaseNotes, ...}
        Status: draft, inProgress, halted, completed
        """
        url = f"{API_BASE}/{package_name}/edits/{edit_id}/tracks/{track}"
        data = {"track": track}
        if releases:
            data["releases"] = releases
        return await self._put(url, data)

    # ── Bundles (AAB upload) ──────────────────────────────────

    async def upload_bundle(self, package_name: str, edit_id: str, bundle_path: str) -> dict:
        """Upload an AAB (Android App Bundle) within an edit.

        Args:
            package_name: Android package name
            edit_id: Active edit ID
            bundle_path: Local path to .aab file

        Returns:
            {versionCode, sha1, sha256} on success
        """
        import os
        url = f"https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/{package_name}/edits/{edit_id}/bundles"
        token = await self._get_token()

        file_size = os.path.getsize(bundle_path)
        log.info("Uploading AAB %s (%d MB)", bundle_path, file_size // (1024 * 1024))

        async with httpx.AsyncClient(timeout=600) as c:
            with open(bundle_path, "rb") as f:
                r = await c.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/octet-stream",
                    },
                    content=f.read(),
                )
            r.raise_for_status()
            result = r.json()

        log.info("Bundle uploaded: versionCode=%s", result.get("versionCode"))
        return result

    # ── APKs (legacy upload) ──────────────────────────────────

    async def upload_apk(self, package_name: str, edit_id: str, apk_path: str) -> dict:
        """Upload an APK within an edit (legacy — prefer AAB)."""
        import os
        url = f"https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/{package_name}/edits/{edit_id}/apks"
        token = await self._get_token()

        async with httpx.AsyncClient(timeout=600) as c:
            with open(apk_path, "rb") as f:
                r = await c.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/octet-stream",
                    },
                    content=f.read(),
                )
            r.raise_for_status()
            return r.json()

    # ── Reviews ───────────────────────────────────────────────

    async def list_reviews(self, package_name: str, max_results: int = 50) -> list:
        """List recent reviews for an app.

        Note: Reviews API is separate from Edits (no edit needed).
        """
        url = f"{API_BASE}/{package_name}/reviews"
        params = {"maxResults": max_results}
        headers = await self._headers()
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.get(url, headers=headers, params=params)
            r.raise_for_status()
            data = r.json()
        return data.get("reviews", [])

    async def get_review(self, package_name: str, review_id: str) -> dict:
        """Get a single review."""
        url = f"{API_BASE}/{package_name}/reviews/{review_id}"
        return await self._get(url)

    async def reply_to_review(self, package_name: str, review_id: str, text: str) -> dict:
        """Reply to a review.

        Args:
            text: Reply text (max 350 chars for Google Play)

        Note: Google limits to ~2000 replies/day.
        """
        if len(text) > 350:
            log.warning("Review reply truncated from %d to 350 chars", len(text))
            text = text[:347] + "..."

        url = f"{API_BASE}/{package_name}/reviews/{review_id}:reply"
        return await self._post(url, {"replyText": text})

    # ── High-level convenience methods ────────────────────────

    async def push_metadata(
        self,
        package_name: str,
        metadata: dict,
        language: str = "en-US",
    ) -> dict:
        """High-level: push metadata to Google Play (create edit → update → commit).

        Args:
            metadata: Dict with title, short_description, full_description
            language: BCP-47 language code

        Returns:
            {edit_id, listing, committed: True/False, error: str|None}
        """
        edit = await self.create_edit(package_name)
        edit_id = edit["id"]

        try:
            listing = await self.update_listing(
                package_name,
                edit_id,
                language=language,
                title=metadata.get("app_name") or metadata.get("title"),
                short_description=metadata.get("short_description"),
                full_description=metadata.get("full_description"),
            )

            # Validate before committing
            validation = await self.validate_edit(package_name, edit_id)

            commit = await self.commit_edit(package_name, edit_id)
            return {
                "edit_id": edit_id,
                "listing": listing,
                "committed": True,
                "error": None,
            }
        except Exception as e:
            # Try to discard the edit on failure
            try:
                await self.delete_edit(package_name, edit_id)
            except Exception:
                pass
            return {"edit_id": edit_id, "committed": False, "error": str(e)}

    async def submit_release(
        self,
        package_name: str,
        bundle_path: str,
        track: str = "production",
        release_notes: str = "",
        language: str = "en-US",
        status: str = "completed",
    ) -> dict:
        """High-level: upload bundle and submit to a track.

        Args:
            bundle_path: Path to .aab file
            track: Target track (production, beta, alpha, internal)
            release_notes: Release notes text
            language: Language for release notes
            status: Release status (draft, completed, halted)

        Returns:
            {edit_id, version_code, track, committed, error}
        """
        edit = await self.create_edit(package_name)
        edit_id = edit["id"]

        try:
            # Upload bundle
            bundle_result = await self.upload_bundle(package_name, edit_id, bundle_path)
            version_code = bundle_result.get("versionCode")

            if not version_code:
                raise ValueError("Bundle upload returned no versionCode")

            # Set up release on track
            release = {
                "versionCodes": [str(version_code)],
                "status": status,
            }
            if release_notes:
                release["releaseNotes"] = [
                    {"language": language, "text": release_notes}
                ]

            await self.update_track(package_name, edit_id, track, releases=[release])

            # Commit
            await self.commit_edit(package_name, edit_id)

            return {
                "edit_id": edit_id,
                "version_code": version_code,
                "track": track,
                "committed": True,
                "error": None,
            }
        except Exception as e:
            try:
                await self.delete_edit(package_name, edit_id)
            except Exception:
                pass
            return {"edit_id": edit_id, "committed": False, "error": str(e)}

    async def check_first_upload(self, package_name: str) -> bool:
        """Check if this app has ever had a binary uploaded.

        First upload MUST be done manually via Play Console.
        Returns True if first upload is needed (no existing version codes).
        """
        try:
            status = await self.get_track_status(package_name)
            releases = status.get("releases", [])
            for release in releases:
                if release.get("versionCodes"):
                    return False  # Has existing uploads
            return True  # No version codes found
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                return True
            raise
