"""Marq — Apple App Store Connect API v3 connector.

Auth: JWT from P8 key (ES256, 20-min expiry).
Docs: https://developer.apple.com/documentation/appstoreconnectapi

Key concepts:
- JWT generated per-request (20-min expiry)
- All responses are JSON:API format ({data, links, meta})
- Version lifecycle: PREPARE_FOR_SUBMISSION → WAITING_FOR_REVIEW → IN_REVIEW → ...
- Screenshots uploaded via asset delivery (reserve → upload → commit)
"""

from __future__ import annotations

import logging
import time
from typing import Optional

import httpx
import jwt  # PyJWT

log = logging.getLogger("marq.apple")

API_BASE = "https://api.appstoreconnect.apple.com/v1"


class AppleConnector:
    """App Store Connect API v3 client.

    Usage:
        apple = AppleConnector(
            issuer_id="your-issuer-id",
            key_id="YOUR_KEY_ID",
            private_key=open("AuthKey_XXXX.p8").read(),
        )
        app = await apple.get_app("123456789")
    """

    def __init__(self, issuer_id: str, key_id: str, private_key: str):
        self.issuer_id = issuer_id
        self.key_id = key_id
        self.private_key = private_key
        self._token: str = ""
        self._token_expires: float = 0

    # ── Auth ──────────────────────────────────────────────────

    def _generate_token(self) -> str:
        """Generate a JWT for App Store Connect API.

        Token structure:
        - Header: alg=ES256, kid=key_id, typ=JWT
        - Payload: iss=issuer_id, iat=now, exp=now+20min, aud=appstoreconnect-v1
        """
        now = int(time.time())
        payload = {
            "iss": self.issuer_id,
            "iat": now,
            "exp": now + 1200,  # 20 minutes
            "aud": "appstoreconnect-v1",
        }
        token = jwt.encode(
            payload,
            self.private_key,
            algorithm="ES256",
            headers={"kid": self.key_id},
        )
        self._token = token
        self._token_expires = now + 1200
        return token

    def _get_token(self) -> str:
        """Get a valid JWT, generating a new one if expired."""
        if self._token and time.time() < self._token_expires - 60:
            return self._token
        return self._generate_token()

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._get_token()}",
            "Content-Type": "application/json",
        }

    async def _get(self, url: str, params: dict | None = None) -> dict:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.get(url, headers=self._headers(), params=params)
            if r.status_code == 404:
                return {}
            r.raise_for_status()
            return r.json()

    async def _post(self, url: str, data: dict) -> dict:
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(url, headers=self._headers(), json=data)
            r.raise_for_status()
            return r.json()

    async def _patch(self, url: str, data: dict) -> dict:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.patch(url, headers=self._headers(), json=data)
            r.raise_for_status()
            return r.json()

    async def _delete(self, url: str) -> None:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.delete(url, headers=self._headers())
            r.raise_for_status()

    # ── Helper: extract JSON:API data ─────────────────────────

    @staticmethod
    def _extract(response: dict) -> dict | list:
        """Extract data from JSON:API response."""
        data = response.get("data")
        if isinstance(data, list):
            return [{"id": item["id"], **item.get("attributes", {})} for item in data]
        if isinstance(data, dict):
            return {"id": data["id"], **data.get("attributes", {})}
        return response

    # ── Apps ──────────────────────────────────────────────────

    async def get_app(self, app_id: str) -> dict:
        """Get app details from App Store Connect."""
        url = f"{API_BASE}/apps/{app_id}"
        result = await self._get(url)
        return self._extract(result) if result else {}

    async def list_apps(self) -> list:
        """List all apps in the developer account."""
        url = f"{API_BASE}/apps"
        result = await self._get(url, params={"limit": 200})
        return self._extract(result) if result else []

    # ── App Versions ──────────────────────────────────────────

    async def list_versions(self, app_id: str, platform: str = "IOS") -> list:
        """List app store versions for an app.

        Args:
            app_id: App Store Connect app ID
            platform: IOS or MAC_OS
        """
        url = f"{API_BASE}/apps/{app_id}/appStoreVersions"
        params = {
            "filter[platform]": platform,
            "sort": "-versionString",
            "limit": 10,
        }
        result = await self._get(url, params)
        return self._extract(result) if result else []

    async def get_version(self, version_id: str) -> dict:
        """Get a specific app store version."""
        url = f"{API_BASE}/appStoreVersions/{version_id}"
        result = await self._get(url)
        return self._extract(result) if result else {}

    async def create_version(
        self,
        app_id: str,
        version_string: str,
        platform: str = "IOS",
    ) -> dict:
        """Create a new app store version.

        Args:
            app_id: App Store Connect app ID
            version_string: Version number (e.g., "1.2.0")
            platform: IOS or MAC_OS
        """
        url = f"{API_BASE}/appStoreVersions"
        data = {
            "data": {
                "type": "appStoreVersions",
                "attributes": {
                    "versionString": version_string,
                    "platform": platform,
                },
                "relationships": {
                    "app": {
                        "data": {"type": "apps", "id": app_id}
                    }
                },
            }
        }
        result = await self._post(url, data)
        return self._extract(result)

    # ── Version Localizations (metadata per locale) ───────────

    async def list_localizations(self, version_id: str) -> list:
        """List all localizations for a version."""
        url = f"{API_BASE}/appStoreVersions/{version_id}/appStoreVersionLocalizations"
        result = await self._get(url)
        return self._extract(result) if result else []

    async def update_localization(
        self,
        localization_id: str,
        description: str | None = None,
        keywords: str | None = None,
        whats_new: str | None = None,
        promotional_text: str | None = None,
        marketing_url: str | None = None,
        support_url: str | None = None,
    ) -> dict:
        """Update a version localization (store listing metadata).

        Args:
            localization_id: Localization resource ID
            description: Full description (max 4000 chars)
            keywords: Keywords string (max 100 chars, comma-separated)
            whats_new: Release notes / What's New
            promotional_text: Promotional text (can be updated without new version)
            marketing_url: Marketing URL
            support_url: Support URL
        """
        attributes = {}
        if description is not None:
            attributes["description"] = description[:4000]
        if keywords is not None:
            attributes["keywords"] = keywords[:100]
        if whats_new is not None:
            attributes["whatsNew"] = whats_new
        if promotional_text is not None:
            attributes["promotionalText"] = promotional_text
        if marketing_url is not None:
            attributes["marketingUrl"] = marketing_url
        if support_url is not None:
            attributes["supportUrl"] = support_url

        if not attributes:
            return {}

        url = f"{API_BASE}/appStoreVersionLocalizations/{localization_id}"
        data = {
            "data": {
                "type": "appStoreVersionLocalizations",
                "id": localization_id,
                "attributes": attributes,
            }
        }
        result = await self._patch(url, data)
        return self._extract(result)

    async def create_localization(
        self,
        version_id: str,
        locale: str,
        description: str = "",
        keywords: str = "",
        whats_new: str = "",
    ) -> dict:
        """Create a new localization for a version."""
        url = f"{API_BASE}/appStoreVersionLocalizations"
        data = {
            "data": {
                "type": "appStoreVersionLocalizations",
                "attributes": {
                    "locale": locale,
                    "description": description[:4000],
                    "keywords": keywords[:100],
                    "whatsNew": whats_new,
                },
                "relationships": {
                    "appStoreVersion": {
                        "data": {"type": "appStoreVersions", "id": version_id}
                    }
                },
            }
        }
        result = await self._post(url, data)
        return self._extract(result)

    # ── App Info & Localizations (name, subtitle, etc.) ───────

    async def get_app_info(self, app_id: str) -> dict:
        """Get app info (includes primary locale, category, etc.)."""
        url = f"{API_BASE}/apps/{app_id}/appInfos"
        result = await self._get(url)
        data = self._extract(result) if result else []
        return data[0] if isinstance(data, list) and data else {}

    async def list_app_info_localizations(self, app_info_id: str) -> list:
        """List app info localizations (name, subtitle, privacy policy URL)."""
        url = f"{API_BASE}/appInfos/{app_info_id}/appInfoLocalizations"
        result = await self._get(url)
        return self._extract(result) if result else []

    async def update_app_info_localization(
        self,
        localization_id: str,
        name: str | None = None,
        subtitle: str | None = None,
        privacy_policy_url: str | None = None,
    ) -> dict:
        """Update app info localization (name, subtitle).

        Note: name max 30 chars, subtitle max 30 chars.
        """
        attributes = {}
        if name is not None:
            attributes["name"] = name[:30]
        if subtitle is not None:
            attributes["subtitle"] = subtitle[:30]
        if privacy_policy_url is not None:
            attributes["privacyPolicyUrl"] = privacy_policy_url

        if not attributes:
            return {}

        url = f"{API_BASE}/appInfoLocalizations/{localization_id}"
        data = {
            "data": {
                "type": "appInfoLocalizations",
                "id": localization_id,
                "attributes": attributes,
            }
        }
        result = await self._patch(url, data)
        return self._extract(result)

    # ── Screenshots ───────────────────────────────────────────

    async def list_screenshot_sets(self, localization_id: str) -> list:
        """List screenshot sets for a localization."""
        url = f"{API_BASE}/appStoreVersionLocalizations/{localization_id}/appScreenshotSets"
        result = await self._get(url)
        return self._extract(result) if result else []

    async def create_screenshot_set(
        self,
        localization_id: str,
        display_type: str,
    ) -> dict:
        """Create a screenshot set for a display type.

        display_type: APP_IPHONE_67, APP_IPHONE_65, APP_IPAD_PRO_129, etc.
        """
        url = f"{API_BASE}/appScreenshotSets"
        data = {
            "data": {
                "type": "appScreenshotSets",
                "attributes": {
                    "screenshotDisplayType": display_type,
                },
                "relationships": {
                    "appStoreVersionLocalization": {
                        "data": {"type": "appStoreVersionLocalizations", "id": localization_id}
                    }
                },
            }
        }
        result = await self._post(url, data)
        return self._extract(result)

    async def upload_screenshot(
        self,
        screenshot_set_id: str,
        filename: str,
        file_size: int,
    ) -> dict:
        """Reserve a screenshot upload slot.

        After reserving, upload the actual image data to the returned upload URL,
        then commit the asset.

        Returns:
            {id, uploadOperations: [{method, url, length, offset, requestHeaders}]}
        """
        url = f"{API_BASE}/appScreenshots"
        data = {
            "data": {
                "type": "appScreenshots",
                "attributes": {
                    "fileName": filename,
                    "fileSize": file_size,
                },
                "relationships": {
                    "appScreenshotSet": {
                        "data": {"type": "appScreenshotSets", "id": screenshot_set_id}
                    }
                },
            }
        }
        result = await self._post(url, data)
        return result  # Return raw for upload operations

    async def commit_screenshot(self, screenshot_id: str, source_checksum: str) -> dict:
        """Commit a screenshot after upload is complete."""
        url = f"{API_BASE}/appScreenshots/{screenshot_id}"
        data = {
            "data": {
                "type": "appScreenshots",
                "id": screenshot_id,
                "attributes": {
                    "uploaded": True,
                    "sourceFileChecksum": source_checksum,
                },
            }
        }
        return await self._patch(url, data)

    # ── Submission ────────────────────────────────────────────

    async def submit_for_review(self, version_id: str) -> dict:
        """Submit a version for App Review.

        The version must be in PREPARE_FOR_SUBMISSION state.
        """
        url = f"{API_BASE}/appStoreVersionSubmissions"
        data = {
            "data": {
                "type": "appStoreVersionSubmissions",
                "relationships": {
                    "appStoreVersion": {
                        "data": {"type": "appStoreVersions", "id": version_id}
                    }
                },
            }
        }
        result = await self._post(url, data)
        return self._extract(result)

    async def get_review_status(self, version_id: str) -> dict:
        """Get the current review status of a version.

        Returns version with appStoreState field:
        PREPARE_FOR_SUBMISSION, WAITING_FOR_REVIEW, IN_REVIEW,
        PENDING_DEVELOPER_RELEASE, READY_FOR_SALE, REJECTED, etc.
        """
        return await self.get_version(version_id)

    # ── Reviews (Customer Reviews API) ────────────────────────

    async def list_customer_reviews(self, app_id: str, limit: int = 50, sort: str = "-createdDate") -> list:
        """List customer reviews for an app.

        Args:
            app_id: App Store Connect app ID
            limit: Max results (1-200)
            sort: Sort field (createdDate, rating, -createdDate, -rating)
        """
        url = f"{API_BASE}/apps/{app_id}/customerReviews"
        result = await self._get(url, params={"limit": limit, "sort": sort})
        return self._extract(result) if result else []

    async def reply_to_review(self, review_id: str, response_body: str) -> dict:
        """Reply to a customer review.

        Creates or updates the developer response.
        """
        url = f"{API_BASE}/customerReviewResponses"
        data = {
            "data": {
                "type": "customerReviewResponses",
                "attributes": {
                    "responseBody": response_body,
                },
                "relationships": {
                    "review": {
                        "data": {"type": "customerReviews", "id": review_id}
                    }
                },
            }
        }
        result = await self._post(url, data)
        return self._extract(result)

    # ── High-level convenience methods ────────────────────────

    async def update_metadata(
        self,
        app_id: str,
        version_string: str,
        metadata: dict,
        locale: str = "en-US",
    ) -> dict:
        """High-level: update store listing metadata for a version.

        Args:
            app_id: App Store Connect app ID
            version_string: Version to update (creates if needed)
            metadata: Dict with name, subtitle, description, keywords, whats_new
            locale: Target locale

        Returns:
            {version_id, localization_id, updated_fields, error}
        """
        try:
            # Find or create version
            versions = await self.list_versions(app_id)
            version = None
            for v in versions:
                if v.get("versionString") == version_string:
                    version = v
                    break

            if not version:
                version = await self.create_version(app_id, version_string)

            version_id = version["id"]

            # Find or create localization
            localizations = await self.list_localizations(version_id)
            loc = None
            for l in localizations:
                if l.get("locale") == locale:
                    loc = l
                    break

            updated = []

            if loc:
                # Update existing localization
                await self.update_localization(
                    loc["id"],
                    description=metadata.get("full_description"),
                    keywords=metadata.get("keywords"),
                    whats_new=metadata.get("whats_new"),
                )
                updated.append("localization")
            else:
                await self.create_localization(
                    version_id,
                    locale=locale,
                    description=metadata.get("full_description", ""),
                    keywords=metadata.get("keywords", ""),
                    whats_new=metadata.get("whats_new", ""),
                )
                updated.append("localization_created")

            # Update app info (name, subtitle) via app info localizations
            if metadata.get("app_name") or metadata.get("subtitle"):
                app_info = await self.get_app_info(app_id)
                if app_info:
                    info_locs = await self.list_app_info_localizations(app_info["id"])
                    for il in info_locs:
                        if il.get("locale") == locale:
                            await self.update_app_info_localization(
                                il["id"],
                                name=metadata.get("app_name"),
                                subtitle=metadata.get("subtitle"),
                            )
                            updated.append("app_info")
                            break

            return {
                "version_id": version_id,
                "updated_fields": updated,
                "error": None,
            }
        except Exception as e:
            return {"error": str(e)}

    # ── Status mapping ────────────────────────────────────────

    APPLE_TO_MARQ_STATUS = {
        "PREPARE_FOR_SUBMISSION": "preparing",
        "WAITING_FOR_REVIEW": "submitted",
        "IN_REVIEW": "in_review",
        "PENDING_DEVELOPER_RELEASE": "approved",
        "READY_FOR_SALE": "released",
        "REJECTED": "rejected",
        "DEVELOPER_REJECTED": "preparing",
        "DEVELOPER_REMOVED_FROM_SALE": "suspended",
        "REMOVED_FROM_SALE": "removed",
        "METADATA_REJECTED": "rejected",
        "INVALID_BINARY": "pre_check_failed",
    }

    @classmethod
    def map_status(cls, apple_state: str) -> str:
        """Map Apple's appStoreState to Marq submission status."""
        return cls.APPLE_TO_MARQ_STATUS.get(apple_state, "unknown")
