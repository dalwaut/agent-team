"""Standalone Chat scope authorization — bypasses InstalledAppFlow entirely."""

import http.server
import json
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from google_auth import _get_client_config

ALL_SCOPES = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/chat.messages.readonly",
    "https://www.googleapis.com/auth/chat.messages.create",
]

config = _get_client_config()
if "installed" in config:
    creds = config["installed"]
elif "web" in config:
    creds = config["web"]
else:
    creds = config

client_id = creds["client_id"]
client_secret = creds["client_secret"]
token_uri = creds.get("token_uri", "https://oauth2.googleapis.com/token")
auth_uri = creds.get("auth_uri", "https://accounts.google.com/o/oauth2/auth")
redirect_uris = creds.get("redirect_uris", ["http://localhost"])

# Google allows any localhost port for installed app OAuth clients
redirect_uri = "http://localhost:8888"

print(f"Client ID: {client_id[:30]}...")
print(f"Redirect URI: {redirect_uri}")
print(f"Scopes: {len(ALL_SCOPES)}")
print()

# Build auth URL
params = {
    "client_id": client_id,
    "redirect_uri": redirect_uri,
    "response_type": "code",
    "scope": " ".join(ALL_SCOPES),
    "access_type": "offline",
    "prompt": "consent",
    "login_hint": "agent@paradisewebfl.com",
}

auth_url = f"{auth_uri}?{urllib.parse.urlencode(params)}"
print("Opening browser for Chat scope authorization...")
print(f"URL: {auth_url[:100]}...")
print()

import webbrowser
webbrowser.open(auth_url)

# Start local server to catch the redirect
authorization_code = None

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        global authorization_code
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)

        if "error" in qs:
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            error = qs["error"][0]
            self.wfile.write(f"<h2>Error: {error}</h2><p>{qs.get('error_description', [''])[0]}</p>".encode())
            print(f"\nERROR from Google: {error} — {qs.get('error_description', [''])[0]}")
            authorization_code = "ERROR"
            return

        if "code" in qs:
            authorization_code = qs["code"][0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h2>Authorization successful!</h2><p>You can close this tab.</p>")
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(f"<h2>Unexpected response</h2><pre>{self.path}</pre>".encode())
        authorization_code = "ERROR"

    def log_message(self, format, *args):
        pass  # Suppress access logs

port = 8888

server = http.server.HTTPServer(("localhost", port), Handler)
print(f"Waiting for authorization response on port {port}...")
while authorization_code is None:
    server.handle_request()
server.server_close()

if authorization_code == "ERROR":
    print("\nAuthorization failed. See error above.")
    sys.exit(1)

print(f"\nGot authorization code: {authorization_code[:20]}...")

# Exchange code for tokens
import urllib.request

token_data = urllib.parse.urlencode({
    "code": authorization_code,
    "client_id": client_id,
    "client_secret": client_secret,
    "redirect_uri": redirect_uri,
    "grant_type": "authorization_code",
}).encode()

req = urllib.request.Request(token_uri, data=token_data)
try:
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print(f"\nToken exchange FAILED ({e.code}): {body}")
    sys.exit(1)

access_token = result.get("access_token", "")
refresh_token = result.get("refresh_token", "")
scope = result.get("scope", "")

print(f"\n=== Token Exchange Successful ===")
print(f"Access token: {access_token[:20]}...")
print(f"Refresh token: {refresh_token}")
print(f"\nGranted scopes:")
for s in sorted(scope.split()):
    tag = " ← CHAT" if "chat" in s else ""
    print(f"  {s}{tag}")

chat_granted = [s for s in scope.split() if "chat" in s]
print(f"\nChat scopes granted: {len(chat_granted)}/3")

if refresh_token:
    print(f"\n=== Store this refresh token in vault ===")
    print(f"python3 tools/opai-vault/scripts/import-env.py \\")
    print(f"  --credential google-workspace-refresh-token --value '{refresh_token}'")
else:
    print("\nWARNING: No refresh token returned (may need prompt=consent)")
