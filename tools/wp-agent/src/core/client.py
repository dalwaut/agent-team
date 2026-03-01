"""
WordPress REST API Client
Core HTTP client with authentication and request handling
"""

import os
import base64
import json
import time
from pathlib import Path
from typing import Any, Optional, Dict, List, Union
from dataclasses import dataclass
from urllib.parse import urljoin, urlencode
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

import yaml


@dataclass
class APIResponse:
    """Standardized API response wrapper"""
    success: bool
    status_code: int
    data: Any
    headers: Dict[str, str]
    error: Optional[str] = None

    def __repr__(self):
        if self.success:
            return f"APIResponse(success=True, status={self.status_code})"
        return f"APIResponse(success=False, status={self.status_code}, error={self.error})"


class WordPressClient:
    """
    WordPress REST API Client with authentication and retry logic
    """

    def __init__(self, config_path: Optional[str] = None):
        """
        Initialize client from config file

        Args:
            config_path: Path to config.yaml. If None, looks in default locations
        """
        self.config = self._load_config(config_path)
        self.base_url = self.config['site']['url'].rstrip('/')
        self.api_base = self.base_url + self.config['api'].get('base_path', '/wp-json')
        self.timeout = self.config['api'].get('timeout', 30)

        # Setup session with retry logic
        self.session = self._create_session()

        # Setup authentication
        self._setup_auth()

    def _load_config(self, config_path: Optional[str]) -> dict:
        """Load configuration from YAML file"""
        if config_path is None:
            # Look in default locations
            search_paths = [
                Path.cwd() / 'config.yaml',
                Path.cwd().parent / 'config.yaml',
                Path(__file__).parent.parent.parent / 'config.yaml',
            ]
            for path in search_paths:
                if path.exists():
                    config_path = str(path)
                    break
            else:
                raise FileNotFoundError("Could not find config.yaml in default locations")

        with open(config_path, 'r') as f:
            return yaml.safe_load(f)

    def _create_session(self) -> requests.Session:
        """Create requests session with retry strategy"""
        session = requests.Session()

        retry_strategy = Retry(
            total=self.config['api'].get('retry_attempts', 3),
            backoff_factor=1,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["HEAD", "GET", "PUT", "DELETE", "OPTIONS", "TRACE", "POST"]
        )

        adapter = HTTPAdapter(max_retries=retry_strategy)
        session.mount("http://", adapter)
        session.mount("https://", adapter)

        return session

    def _setup_auth(self):
        """Setup authentication headers"""
        username = self.config['auth']['username']

        # Try environment variable first, then config
        password = os.environ.get('WP_PASSWORD') or self.config['auth'].get('password', '')

        if not password:
            raise ValueError("Password not found. Set WP_PASSWORD environment variable or add to config")

        # Basic auth with base64 encoding
        credentials = f"{username}:{password}"
        encoded = base64.b64encode(credentials.encode()).decode()

        self.session.headers.update({
            'Authorization': f'Basic {encoded}',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        })

    def _build_url(self, endpoint: str, params: Optional[Dict] = None) -> str:
        """Build full URL with optional query parameters"""
        url = urljoin(self.api_base + '/', endpoint.lstrip('/'))
        if params:
            url += '?' + urlencode(params)
        return url

    def _handle_response(self, response: requests.Response) -> APIResponse:
        """Convert requests response to APIResponse"""
        try:
            data = response.json() if response.text else None
        except json.JSONDecodeError:
            data = response.text

        success = 200 <= response.status_code < 300
        error = None

        if not success and isinstance(data, dict):
            error = data.get('message') or data.get('error') or str(data)
        elif not success:
            error = f"HTTP {response.status_code}: {response.reason}"

        return APIResponse(
            success=success,
            status_code=response.status_code,
            data=data,
            headers=dict(response.headers),
            error=error
        )

    def get(self, endpoint: str, params: Optional[Dict] = None) -> APIResponse:
        """
        GET request to WordPress API

        Args:
            endpoint: API endpoint (e.g., '/wp/v2/posts')
            params: Optional query parameters
        """
        url = self._build_url(endpoint, params)
        try:
            response = self.session.get(url, timeout=self.timeout)
            return self._handle_response(response)
        except requests.RequestException as e:
            return APIResponse(
                success=False,
                status_code=0,
                data=None,
                headers={},
                error=str(e)
            )

    def post(self, endpoint: str, data: Optional[Dict] = None, files: Optional[Dict] = None) -> APIResponse:
        """
        POST request to WordPress API

        Args:
            endpoint: API endpoint
            data: Request body data
            files: Files to upload (for media)
        """
        url = self._build_url(endpoint)
        try:
            if files:
                # For file uploads, don't send JSON
                headers = {k: v for k, v in self.session.headers.items() if k != 'Content-Type'}
                response = self.session.post(url, data=data, files=files, headers=headers, timeout=self.timeout)
            else:
                response = self.session.post(url, json=data, timeout=self.timeout)
            return self._handle_response(response)
        except requests.RequestException as e:
            return APIResponse(
                success=False,
                status_code=0,
                data=None,
                headers={},
                error=str(e)
            )

    def put(self, endpoint: str, data: Optional[Dict] = None) -> APIResponse:
        """PUT request to WordPress API"""
        url = self._build_url(endpoint)
        try:
            response = self.session.put(url, json=data, timeout=self.timeout)
            return self._handle_response(response)
        except requests.RequestException as e:
            return APIResponse(
                success=False,
                status_code=0,
                data=None,
                headers={},
                error=str(e)
            )

    def patch(self, endpoint: str, data: Optional[Dict] = None) -> APIResponse:
        """PATCH request to WordPress API"""
        url = self._build_url(endpoint)
        try:
            response = self.session.patch(url, json=data, timeout=self.timeout)
            return self._handle_response(response)
        except requests.RequestException as e:
            return APIResponse(
                success=False,
                status_code=0,
                data=None,
                headers={},
                error=str(e)
            )

    def delete(self, endpoint: str, params: Optional[Dict] = None) -> APIResponse:
        """DELETE request to WordPress API"""
        url = self._build_url(endpoint, params)
        try:
            response = self.session.delete(url, timeout=self.timeout)
            return self._handle_response(response)
        except requests.RequestException as e:
            return APIResponse(
                success=False,
                status_code=0,
                data=None,
                headers={},
                error=str(e)
            )

    def discover_endpoints(self) -> APIResponse:
        """Discover all available API endpoints on the site"""
        return self.get('/')

    def test_connection(self) -> APIResponse:
        """Test API connection and authentication"""
        return self.get('/wp/v2/users/me')


# Singleton instance for convenience
_client: Optional[WordPressClient] = None

def get_client(config_path: Optional[str] = None) -> WordPressClient:
    """Get or create singleton client instance"""
    global _client
    if _client is None:
        _client = WordPressClient(config_path)
    return _client

def reset_client():
    """Reset singleton client (useful for testing or config changes)"""
    global _client
    _client = None
