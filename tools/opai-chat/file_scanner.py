"""OPAI Chat — Malicious file content scanner.

Scans uploaded text files for prompt injection, encoded execution,
and credential exfiltration patterns. Uploaded files are DATA only —
they must never be treated as instructions or prompts.
"""

import re

# Prompt injection patterns — attempts to hijack AI behavior
_PROMPT_INJECTION_PATTERNS = [
    r"ignore\s+(all\s+)?previous\s+instructions",
    r"ignore\s+(all\s+)?prior\s+instructions",
    r"ignore\s+(all\s+)?above\s+instructions",
    r"disregard\s+(all\s+)?previous",
    r"forget\s+(all\s+)?(your|previous)\s+(instructions|rules|guidelines)",
    r"you\s+are\s+now\s+(DAN|a\s+new\s+AI|unrestricted|jailbroken)",
    r"DAN\s+mode\s+(enabled|activated|on)",
    r"act\s+as\s+if\s+you\s+have\s+no\s+(restrictions|rules|guidelines)",
    r"pretend\s+(you\s+are|to\s+be)\s+(a\s+)?(unrestricted|unfiltered|evil)",
    r"do\s+anything\s+now",
    r"override\s+(your|all|system)\s+(instructions|rules|safety)",
    r"system\s*:\s*you\s+are",
    r"\[system\]\s*:",
    r"<\|?system\|?>",
    r"SYSTEM\s+PREFACE",
    r"---\s*USER\s+MESSAGE\s+FOLLOWS\s*---",
]

# Executable content patterns in non-code files
_EXEC_PATTERNS = [
    r"<script[\s>]",
    r"javascript\s*:",
    r"on(load|error|click|mouseover)\s*=",
    r"eval\s*\(",
    r"exec\s*\(",
    r"subprocess\.\w+\(",
    r"os\.system\s*\(",
    r"__import__\s*\(",
    r"powershell\s+-\w*(enc|command|exec)",
    r"cmd\s*/[ck]\s+",
    r"\\x[0-9a-fA-F]{2}.*\\x[0-9a-fA-F]{2}",  # hex-encoded sequences
    r"base64\.\w*decode",
]

# Credential exfiltration patterns
_EXFIL_PATTERNS = [
    r"(SUPABASE|ANTHROPIC|OPENAI|AWS|STRIPE|GITHUB)_(SECRET|KEY|TOKEN|PASSWORD)",
    r"curl\s+.*(-d|--data).*token",
    r"wget\s+.*token",
    r"fetch\s*\(\s*['\"]https?://.*token",
    r"send\s+(me|to)\s+(your|the)\s+(api\s+)?key",
    r"(exfiltrate|steal|extract)\s+(the\s+)?(credentials|keys|tokens|secrets)",
    r"what\s+is\s+(your|the)\s+(api\s+)?key",
]

# Compile all patterns for performance
_INJECTION_RE = [re.compile(p, re.IGNORECASE) for p in _PROMPT_INJECTION_PATTERNS]
_EXEC_RE = [re.compile(p, re.IGNORECASE) for p in _EXEC_PATTERNS]
_EXFIL_RE = [re.compile(p, re.IGNORECASE) for p in _EXFIL_PATTERNS]

# File extensions that should NOT contain executable patterns
_TEXT_ONLY_EXTENSIONS = {".txt", ".md", ".csv", ".log", ".json", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf"}

# File extensions where code patterns are expected (skip exec scan)
_CODE_EXTENSIONS = {".py", ".js", ".ts", ".jsx", ".tsx", ".sh", ".bash", ".html", ".css", ".sql", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h"}


def scan_for_malicious(content_bytes: bytes, filename: str) -> tuple[bool, str]:
    """Scan file content for malicious patterns.

    Args:
        content_bytes: Raw file content
        filename: Original filename (used to determine file type)

    Returns:
        (is_malicious, reason) — True + reason string if malicious detected
    """
    try:
        text = content_bytes.decode("utf-8", errors="ignore")
    except Exception:
        return False, ""

    if not text.strip():
        return False, ""

    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    # Always check for prompt injection — this is the primary threat
    for pattern in _INJECTION_RE:
        match = pattern.search(text)
        if match:
            return True, f"Prompt injection detected: '{match.group()[:80]}'"

    # Always check for credential exfiltration
    for pattern in _EXFIL_RE:
        match = pattern.search(text)
        if match:
            return True, f"Credential exfiltration attempt: '{match.group()[:80]}'"

    # Check executable content only in text-only files (not code files)
    if ext in _TEXT_ONLY_EXTENSIONS:
        for pattern in _EXEC_RE:
            match = pattern.search(text)
            if match:
                return True, f"Executable content in text file: '{match.group()[:80]}'"

    return False, ""
