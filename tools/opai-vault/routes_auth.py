"""OPAI Vault — Web UI auth routes.

PIN login, WebAuthn register/login, session management, UI secret endpoints.
All endpoints prefixed with /vault/api/auth/ or /vault/api/ui/.
"""

import base64
from typing import Optional

from fastapi import APIRouter, Request, Response, HTTPException
from pydantic import BaseModel

import config
import auth_store
import session
import store
import audit

try:
    from webauthn import (
        generate_registration_options,
        verify_registration_response,
        generate_authentication_options,
        verify_authentication_response,
        options_to_json,
    )
    from webauthn.helpers.structs import (
        AuthenticatorAttachment,
        AuthenticatorSelectionCriteria,
        ResidentKeyRequirement,
        UserVerificationRequirement,
        PublicKeyCredentialDescriptor,
        AuthenticatorTransport,
    )
    from webauthn.helpers import bytes_to_base64url, base64url_to_bytes
    WEBAUTHN_AVAILABLE = True
except ImportError:
    WEBAUTHN_AVAILABLE = False


router = APIRouter()

# Transient challenge store (in-memory, keyed by session or IP)
_challenges: dict[str, bytes] = {}


# ── Helpers ──────────────────────────────────────────────

def _get_session(request: Request) -> Optional[dict]:
    token = request.cookies.get(session.COOKIE_NAME)
    if not token:
        return None
    return session.validate_token(token)


def _require_session(request: Request) -> dict:
    s = _get_session(request)
    if not s:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return s


def _set_session_cookie(response: Response) -> str:
    token, jti = session.create_token()
    params = session.cookie_params()
    response.set_cookie(value=token, **params)
    return token


def _refresh_session_cookie(request: Request, response: Response):
    token = request.cookies.get(session.COOKIE_NAME)
    if token:
        new_token = session.refresh_token(token)
        if new_token:
            params = session.cookie_params()
            response.set_cookie(value=new_token, **params)


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


# ── Auth Status ──────────────────────────────────────────

@router.post("/vault/api/auth/status")
async def auth_status(request: Request):
    s = _get_session(request)
    return {
        "age_key_present": auth_store.is_age_key_present(),
        "pin_configured": auth_store.is_pin_configured(),
        "webauthn_configured": auth_store.is_webauthn_configured(),
        "webauthn_available": WEBAUTHN_AVAILABLE,
        "session_valid": s is not None,
    }


# ── PIN Setup ───────────────────────────────────────────

class PinSetupRequest(BaseModel):
    pin: str
    current_pin: Optional[str] = None

@router.post("/vault/api/auth/pin/setup")
async def pin_setup(body: PinSetupRequest, request: Request, response: Response):
    if not auth_store.is_age_key_present():
        raise HTTPException(status_code=403, detail="Age key not present on this machine")

    pin = body.pin
    if not pin.isdigit() or len(pin) < 4 or len(pin) > 6:
        raise HTTPException(status_code=400, detail="PIN must be 4-6 digits")

    if auth_store.is_pin_configured():
        if not body.current_pin or not auth_store.verify_pin(body.current_pin):
            raise HTTPException(status_code=403, detail="Current PIN required to change PIN")

    auth_store.set_pin(pin)
    auth_store.reset_failed_attempts()
    _set_session_cookie(response)

    audit.log_access(
        action="pin_setup",
        target="vault_ui",
        caller="web_ui",
        caller_ip=_client_ip(request),
    )
    return {"status": "ok"}


# ── PIN Verify ──────────────────────────────────────────

class PinVerifyRequest(BaseModel):
    pin: str

@router.post("/vault/api/auth/pin/verify")
async def pin_verify(body: PinVerifyRequest, request: Request, response: Response):
    if not auth_store.is_age_key_present():
        raise HTTPException(status_code=403, detail="Age key not present on this machine")

    locked, remaining = auth_store.is_locked_out()
    if locked:
        audit.log_access(
            action="pin_verify",
            target="vault_ui",
            caller="web_ui",
            caller_ip=_client_ip(request),
            success=False,
            detail=f"locked_out:{remaining}s",
        )
        raise HTTPException(status_code=429, detail=f"Too many attempts. Wait {remaining}s.")

    if not auth_store.verify_pin(body.pin):
        auth_store.record_failed_attempt()
        locked, remaining = auth_store.is_locked_out()
        audit.log_access(
            action="pin_verify",
            target="vault_ui",
            caller="web_ui",
            caller_ip=_client_ip(request),
            success=False,
            detail="wrong_pin",
        )
        detail = "Invalid PIN"
        if locked:
            detail = f"Too many attempts. Locked for {remaining}s."
        raise HTTPException(status_code=401, detail=detail)

    auth_store.reset_failed_attempts()
    _set_session_cookie(response)

    audit.log_access(
        action="pin_verify",
        target="vault_ui",
        caller="web_ui",
        caller_ip=_client_ip(request),
    )
    return {"status": "ok"}


# ── Lock ────────────────────────────────────────────────

@router.post("/vault/api/auth/lock")
async def lock(request: Request, response: Response):
    token = request.cookies.get(session.COOKIE_NAME)
    if token:
        session.revoke_token(token)
    response.delete_cookie(
        key=session.COOKIE_NAME,
        path="/vault/",
        secure=True,
        httponly=True,
        samesite="strict",
    )
    audit.log_access(
        action="lock",
        target="vault_ui",
        caller="web_ui",
        caller_ip=_client_ip(request),
    )
    return {"status": "locked"}


# ── WebAuthn Registration ──────────────────────────────

@router.post("/vault/api/auth/webauthn/register/options")
async def webauthn_register_options(request: Request):
    if not WEBAUTHN_AVAILABLE:
        raise HTTPException(status_code=501, detail="WebAuthn not available (py_webauthn not installed)")
    _require_session(request)

    existing_creds = auth_store.get_webauthn_credentials()
    exclude = []
    for c in existing_creds:
        exclude.append(PublicKeyCredentialDescriptor(id=base64url_to_bytes(c["id"])))

    options = generate_registration_options(
        rp_id=_get_rp_id(request),
        rp_name=config.VAULT_RP_NAME,
        user_id=b"vault-admin",
        user_name="vault-admin",
        user_display_name="Vault Admin",
        authenticator_selection=AuthenticatorSelectionCriteria(
            authenticator_attachment=AuthenticatorAttachment.CROSS_PLATFORM,
            resident_key=ResidentKeyRequirement.DISCOURAGED,
        ),
        exclude_credentials=exclude,
    )

    challenge_key = _client_ip(request)
    _challenges[challenge_key] = options.challenge

    return Response(
        content=options_to_json(options),
        media_type="application/json",
    )


class WebAuthnRegisterVerifyRequest(BaseModel):
    credential: dict

@router.post("/vault/api/auth/webauthn/register/verify")
async def webauthn_register_verify(body: WebAuthnRegisterVerifyRequest, request: Request):
    if not WEBAUTHN_AVAILABLE:
        raise HTTPException(status_code=501, detail="WebAuthn not available")
    _require_session(request)

    challenge_key = _client_ip(request)
    expected_challenge = _challenges.pop(challenge_key, None)
    if not expected_challenge:
        raise HTTPException(status_code=400, detail="No registration challenge found")

    try:
        from webauthn.helpers import parse_registration_credential_json
        import json
        cred_json = json.dumps(body.credential)
        credential = parse_registration_credential_json(cred_json)

        verification = verify_registration_response(
            credential=credential,
            expected_challenge=expected_challenge,
            expected_rp_id=_get_rp_id(request),
            expected_origin=_get_expected_origin(request),
        )

        auth_store.add_webauthn_credential({
            "id": bytes_to_base64url(verification.credential_id),
            "public_key": bytes_to_base64url(verification.credential_public_key),
            "sign_count": verification.sign_count,
        })

        audit.log_access(
            action="webauthn_register",
            target="vault_ui",
            caller="web_ui",
            caller_ip=_client_ip(request),
        )
        return {"status": "ok", "credential_id": bytes_to_base64url(verification.credential_id)}

    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Registration failed: {str(e)}")


# ── WebAuthn Login ─────────────────────────────────────

@router.post("/vault/api/auth/webauthn/login/options")
async def webauthn_login_options(request: Request):
    if not WEBAUTHN_AVAILABLE:
        raise HTTPException(status_code=501, detail="WebAuthn not available")

    existing_creds = auth_store.get_webauthn_credentials()
    if not existing_creds:
        raise HTTPException(status_code=404, detail="No security keys registered")

    allow_credentials = []
    for c in existing_creds:
        allow_credentials.append(
            PublicKeyCredentialDescriptor(
                id=base64url_to_bytes(c["id"]),
                transports=[AuthenticatorTransport.USB, AuthenticatorTransport.NFC],
            )
        )

    options = generate_authentication_options(
        rp_id=_get_rp_id(request),
        allow_credentials=allow_credentials,
        user_verification=UserVerificationRequirement.PREFERRED,
    )

    challenge_key = _client_ip(request)
    _challenges[challenge_key] = options.challenge

    return Response(
        content=options_to_json(options),
        media_type="application/json",
    )


class WebAuthnLoginVerifyRequest(BaseModel):
    credential: dict

@router.post("/vault/api/auth/webauthn/login/verify")
async def webauthn_login_verify(body: WebAuthnLoginVerifyRequest, request: Request, response: Response):
    if not WEBAUTHN_AVAILABLE:
        raise HTTPException(status_code=501, detail="WebAuthn not available")

    challenge_key = _client_ip(request)
    expected_challenge = _challenges.pop(challenge_key, None)
    if not expected_challenge:
        raise HTTPException(status_code=400, detail="No login challenge found")

    existing_creds = auth_store.get_webauthn_credentials()

    try:
        from webauthn.helpers import parse_authentication_credential_json
        import json
        cred_json = json.dumps(body.credential)
        credential = parse_authentication_credential_json(cred_json)

        # Find matching credential
        matched = None
        for c in existing_creds:
            if base64url_to_bytes(c["id"]) == credential.raw_id:
                matched = c
                break

        if not matched:
            raise HTTPException(status_code=401, detail="Unknown credential")

        verification = verify_authentication_response(
            credential=credential,
            expected_challenge=expected_challenge,
            expected_rp_id=_get_rp_id(request),
            expected_origin=_get_expected_origin(request),
            credential_public_key=base64url_to_bytes(matched["public_key"]),
            credential_current_sign_count=matched.get("sign_count", 0),
        )

        # Update sign count
        matched["sign_count"] = verification.new_sign_count
        data = auth_store._load()
        for i, c in enumerate(data.get("webauthn_credentials", [])):
            if c["id"] == matched["id"]:
                data["webauthn_credentials"][i] = matched
                break
        auth_store._save(data)

        _set_session_cookie(response)

        audit.log_access(
            action="webauthn_login",
            target="vault_ui",
            caller="web_ui",
            caller_ip=_client_ip(request),
        )
        return {"status": "ok"}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Authentication failed: {str(e)}")


def _get_rp_id(request: Request) -> str:
    """Derive RP ID from request host (strip port)."""
    host = request.headers.get("host", config.VAULT_RP_ID)
    return host.split(":")[0]


def _get_expected_origin(request: Request) -> str:
    host = request.headers.get("host", "localhost")
    scheme = request.headers.get("x-forwarded-proto", "https")
    return f"{scheme}://{host}"


# ── UI Secret Endpoints (vault session auth) ─────────────

@router.get("/vault/api/ui/secrets")
async def ui_list_secrets(request: Request, response: Response):
    _require_session(request)
    _refresh_session_cookie(request, response)

    secrets_data = store.list_secrets(include_values=False)
    stats = store.get_stats()

    audit.log_access(
        action="ui_list",
        target="all",
        caller="web_ui",
        caller_ip=_client_ip(request),
    )
    return {"secrets": secrets_data, "stats": stats}


class AddSecretRequest(BaseModel):
    name: str
    value: str
    section: Optional[str] = "credentials"
    service: Optional[str] = None

@router.post("/vault/api/ui/secrets/add")
async def ui_add_secret(body: AddSecretRequest, request: Request, response: Response):
    _require_session(request)
    _refresh_session_cookie(request, response)

    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Secret name is required")
    if not body.value:
        raise HTTPException(status_code=400, detail="Secret value is required")

    if body.service:
        store.set_secret(name, body.value, service=body.service)
    else:
        section = body.section if body.section in ("shared", "credentials") else "credentials"
        store.set_secret(name, body.value, section=section)

    audit.log_access(
        action="add_secret",
        target=name,
        caller="web_ui",
        caller_ip=_client_ip(request),
        detail=f"section={body.section or 'credentials'}" + (f", service={body.service}" if body.service else ""),
    )
    return {"status": "ok"}


class DeleteSecretRequest(BaseModel):
    name: str
    section: Optional[str] = "credentials"
    service: Optional[str] = None

@router.post("/vault/api/ui/secrets/delete")
async def ui_delete_secret(body: DeleteSecretRequest, request: Request, response: Response):
    _require_session(request)
    _refresh_session_cookie(request, response)

    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Secret name is required")

    if body.service:
        deleted = store.delete_secret(name, service=body.service)
    else:
        section = body.section if body.section in ("shared", "credentials") else "credentials"
        deleted = store.delete_secret(name, section=section)

    if not deleted:
        raise HTTPException(status_code=404, detail=f"Secret '{name}' not found")

    audit.log_access(
        action="delete_secret",
        target=name,
        caller="web_ui",
        caller_ip=_client_ip(request),
        detail=f"section={body.section or 'credentials'}" + (f", service={body.service}" if body.service else ""),
    )
    return {"status": "ok"}


class RevealRequest(BaseModel):
    name: str
    section: Optional[str] = None
    service: Optional[str] = None

@router.post("/vault/api/ui/reveal")
async def ui_reveal_secret(body: RevealRequest, request: Request, response: Response):
    _require_session(request)
    _refresh_session_cookie(request, response)

    # Look up the secret value
    if body.service:
        all_data = store.load_secrets()
        svc_secrets = all_data.get("services", {}).get(body.service, {})
        value = svc_secrets.get(body.name)
        if value is not None:
            value = str(value)
    elif body.section:
        value = store.get_secret(body.name, section=body.section)
    else:
        value = store.get_secret(body.name)

    if value is None:
        raise HTTPException(status_code=404, detail=f"Secret '{body.name}' not found")

    audit.log_access(
        action="reveal_secret",
        target=body.name,
        caller="web_ui",
        caller_ip=_client_ip(request),
        detail=f"section={body.section or 'auto'}" + (f", service={body.service}" if body.service else ""),
    )
    return {"value": value}
