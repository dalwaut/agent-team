"""OPAI Marketplace — n8n user provisioning via SSH.

Creates user accounts in n8n's SQLite database on the Hostinger VPS
by executing sqlite3 commands over SSH (paramiko).
"""

import secrets
import uuid
from datetime import datetime, timezone

import httpx
import config


def _generate_password() -> str:
    """Generate a random 16-character URL-safe password."""
    return secrets.token_urlsafe(16)


def _hash_password(password: str) -> str:
    """Hash password with bcrypt (n8n's expected format)."""
    import bcrypt
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(10)).decode()


def _ssh_exec(command: str) -> tuple[bool, str]:
    """Execute a command on the n8n VPS via SSH. Returns (success, output)."""
    import paramiko

    if not config.N8N_SSH_HOST or not config.N8N_SSH_PASSWORD:
        return False, "N8N_SSH_HOST or N8N_SSH_PASSWORD not configured"

    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            config.N8N_SSH_HOST,
            username=config.N8N_SSH_USER,
            password=config.N8N_SSH_PASSWORD,
            timeout=15,
        )
        stdin, stdout, stderr = ssh.exec_command(command, timeout=10)
        out = stdout.read().decode().strip()
        err = stderr.read().decode().strip()
        ssh.close()

        if err and "error" in err.lower():
            return False, err
        return True, out
    except Exception as e:
        return False, str(e)


def list_n8n_users() -> tuple[bool, list[dict]]:
    """List all users from n8n's SQLite database via SSH.

    Returns (success, users_list) where each user is:
        {id, email, first_name, disabled, created_at}
    """
    db = config.N8N_SQLITE_PATH
    cmd = (
        f'sqlite3 -separator "|" {db} '
        '"SELECT id, email, firstName, disabled, createdAt FROM user ORDER BY email;"'
    )
    ok, output = _ssh_exec(cmd)
    if not ok:
        return False, []

    users = []
    for line in output.strip().split("\n"):
        if not line.strip():
            continue
        parts = line.split("|")
        if len(parts) < 5:
            continue
        users.append({
            "id": parts[0],
            "email": parts[1],
            "first_name": parts[2],
            "disabled": parts[3] in ("1", "true", "True"),
            "created_at": parts[4],
        })
    return True, users


async def _get_user_profile(user_id: str) -> dict | None:
    """Fetch user profile from OPAI Supabase."""
    headers = {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{config.SUPABASE_URL}/rest/v1/profiles",
            headers=headers,
            params={
                "id": f"eq.{user_id}",
                "select": "id,display_name,n8n_provisioned,n8n_username",
            },
        )
        if resp.status_code >= 400:
            return None
        rows = resp.json()
        return rows[0] if rows else None


async def _get_user_email(user_id: str) -> str | None:
    """Fetch user email from Supabase auth.users via admin API."""
    headers = {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{config.SUPABASE_URL}/auth/v1/admin/users/{user_id}",
            headers=headers,
        )
        if resp.status_code >= 400:
            return None
        data = resp.json()
        return data.get("email")


def _insert_n8n_user(email: str, first_name: str, hashed_pw: str) -> tuple[bool, str]:
    """Insert user into n8n's SQLite database via SSH.

    n8n user table schema:
        id (varchar PK), email (varchar UNIQUE), firstName (varchar),
        lastName (varchar), password (varchar), roleSlug (varchar, default 'global:member'),
        disabled (boolean, default FALSE), createdAt, updatedAt
    """
    user_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.000")

    # Escape single quotes in values
    email_esc = email.replace("'", "''")
    name_esc = first_name.replace("'", "''")
    pw_esc = hashed_pw.replace("'", "''")

    sql = (
        f"INSERT OR IGNORE INTO \"user\" "
        f"(id, email, \"firstName\", \"lastName\", password, "
        f"\"personalizationAnswers\", settings, \"createdAt\", \"updatedAt\", "
        f"disabled, \"mfaEnabled\", \"roleSlug\") "
        f"VALUES ('{user_id}', '{email_esc}', '{name_esc}', '', '{pw_esc}', "
        f"'{{}}', '{{}}', '{now}', '{now}', 0, 0, 'global:member');"
    )

    db = config.N8N_SQLITE_PATH
    cmd = f'sqlite3 {db} "{sql}"'
    ok, output = _ssh_exec(cmd)
    if not ok:
        return False, output

    # Verify the insert
    verify_cmd = f"sqlite3 {db} \"SELECT id FROM user WHERE email='{email_esc}';\""
    ok2, verify_out = _ssh_exec(verify_cmd)
    if ok2 and verify_out:
        return True, verify_out
    return False, "Insert appeared to succeed but user not found in DB"


async def _update_opai_profile(user_id: str, email: str) -> bool:
    """Mark user as n8n-provisioned (or unlinked if email is empty) in OPAI Supabase."""
    headers = {
        "apikey": config.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }
    if email:
        payload = {
            "n8n_provisioned": True,
            "n8n_username": email,
            "n8n_provisioned_at": datetime.now(timezone.utc).isoformat(),
        }
    else:
        payload = {
            "n8n_provisioned": False,
            "n8n_username": None,
            "n8n_provisioned_at": None,
        }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            f"{config.SUPABASE_URL}/rest/v1/profiles",
            headers=headers,
            params={"id": f"eq.{user_id}"},
            json=payload,
        )
        return resp.status_code < 400


async def provision_user(user_id: str) -> dict:
    """Provision an n8n account for an OPAI user.

    Returns dict with success status and one-time password on success.
    """
    if not config.N8N_SSH_HOST:
        return {"success": False, "error": "n8n VPS SSH not configured"}

    # Get user profile
    profile = await _get_user_profile(user_id)
    if not profile:
        return {"success": False, "error": "User not found"}

    if profile.get("n8n_provisioned"):
        return {
            "success": False,
            "error": "User already has an n8n account",
            "username": profile.get("n8n_username"),
        }

    # Get email from auth
    email = await _get_user_email(user_id)
    if not email:
        return {"success": False, "error": "Could not retrieve user email"}

    display_name = profile.get("display_name", email.split("@")[0])
    first_name = display_name.split()[0] if display_name else email.split("@")[0]

    # Generate credentials
    password = _generate_password()
    hashed = _hash_password(password)

    # Insert into n8n database via SSH
    ok, detail = _insert_n8n_user(email, first_name, hashed)
    if not ok:
        return {"success": False, "error": f"Failed to create n8n user: {detail}"}

    # Update OPAI profile
    await _update_opai_profile(user_id, email)

    return {
        "success": True,
        "username": email,
        "password": password,  # One-time display only
        "n8n_url": "https://n8n.boutabyte.com",
        "message": "n8n account created. Share these credentials with the user.",
    }
