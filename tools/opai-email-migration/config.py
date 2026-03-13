"""Configuration, logging, and path constants for email migration."""

import logging
import os
from pathlib import Path

# Paths
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
JOBS_DIR = BASE_DIR / "jobs"
DB_PATH = DATA_DIR / "migration.db"

# Ensure runtime dirs exist
DATA_DIR.mkdir(exist_ok=True)

# IMAP defaults
DEFAULT_BATCH_SIZE = 50
DEFAULT_IMAP_PORT = 993
IMAP_TIMEOUT = 60  # seconds
MAX_RETRIES = 3
RETRY_BACKOFF = [5, 15, 45]  # seconds between retries

# Progress notification interval
NOTIFY_EVERY_N_BATCHES = 10

# Logging
LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
LOG_FILE = DATA_DIR / "migration.log"


def setup_logging(verbose: bool = False) -> logging.Logger:
    """Configure logging for the migration tool."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format=LOG_FORMAT,
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(LOG_FILE),
        ],
    )
    return logging.getLogger("opai-email-migration")


def load_env_credential(env_var: str) -> str:
    """Load a credential from environment variable."""
    val = os.environ.get(env_var)
    if not val:
        raise ValueError(f"Environment variable '{env_var}' not set. "
                         f"Use vault-env.sh or export it manually.")
    return val
