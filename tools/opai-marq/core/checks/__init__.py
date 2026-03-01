"""Marq — Pre-submission checks package.

Importing this package registers all 31 checks with the checker framework.
"""

from core.checks import legal
from core.checks import design
from core.checks import metadata
from core.checks import technical
from core.checks import safety
