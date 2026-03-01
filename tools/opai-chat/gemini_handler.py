"""Gemini 2.5 Flash handler for text chat and audio transcription."""

import base64
import json
from typing import AsyncGenerator, List, Dict, Optional
import httpx
import config

GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models"
GEMINI_MODEL = "gemini-2.5-flash"


def _get_api_key() -> str:
    """Get Gemini API key, raise if missing."""
    key = config.GEMINI_API_KEY
    if not key:
        raise ValueError("GEMINI_API_KEY not configured")
    return key


def _build_chat_contents(
    message: str,
    conversation_history: Optional[List[Dict[str, str]]] = None,
) -> list:
    """Build Gemini contents array from conversation history."""
    contents = []
    if conversation_history:
        for msg in conversation_history:
            role = "user" if msg.get("role") == "user" else "model"
            contents.append({
                "role": role,
                "parts": [{"text": msg["content"]}],
            })
    contents.append({
        "role": "user",
        "parts": [{"text": message}],
    })
    return contents


async def stream_gemini_response(
    message: str,
    conversation_history: Optional[List[Dict[str, str]]] = None,
) -> AsyncGenerator[str, None]:
    """Stream a text response from Gemini 2.5 Flash.

    Yields text chunks as they arrive.
    """
    api_key = _get_api_key()
    url = f"{GEMINI_API_URL}/{GEMINI_MODEL}:streamGenerateContent?alt=sse&key={api_key}"

    contents = _build_chat_contents(message, conversation_history)
    payload = {
        "contents": contents,
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": 4096,
        },
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        async with client.stream("POST", url, json=payload) as response:
            if response.status_code != 200:
                body = await response.aread()
                raise ValueError(f"Gemini API error {response.status_code}: {body.decode()}")

            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data_str = line[6:]
                if data_str.strip() == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                    candidates = data.get("candidates", [])
                    if candidates:
                        parts = candidates[0].get("content", {}).get("parts", [])
                        for part in parts:
                            text = part.get("text", "")
                            if text:
                                yield text
                except json.JSONDecodeError:
                    continue


async def transcribe_audio(audio_bytes: bytes, mime_type: str = "audio/webm") -> str:
    """Transcribe audio using Gemini 2.5 Flash.

    Args:
        audio_bytes: Raw audio file bytes
        mime_type: MIME type of the audio (audio/webm, audio/wav, etc.)

    Returns:
        Transcribed text string
    """
    api_key = _get_api_key()
    url = f"{GEMINI_API_URL}/{GEMINI_MODEL}:generateContent?key={api_key}"

    audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")

    payload = {
        "contents": [{
            "role": "user",
            "parts": [
                {
                    "inlineData": {
                        "mimeType": mime_type,
                        "data": audio_b64,
                    }
                },
                {
                    "text": "Transcribe this audio exactly as spoken. Return only the transcription, no commentary.",
                },
            ],
        }],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 2048,
        },
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, json=payload)
        if resp.status_code != 200:
            raise ValueError(f"Gemini transcription error {resp.status_code}: {resp.text}")

        data = resp.json()
        candidates = data.get("candidates", [])
        if not candidates:
            raise ValueError("Gemini returned no transcription candidates")

        parts = candidates[0].get("content", {}).get("parts", [])
        return "".join(part.get("text", "") for part in parts).strip()
