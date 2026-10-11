"""Runtime settings, read from the environment.

AUROHEAR_DATABASE_URL  SQLAlchemy URL. Default: a local SQLite file for development.
                       Production: PostgreSQL, e.g. postgresql+psycopg://user@host/db
"""

from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_DATABASE_URL = "sqlite:///./aurohear-dev.sqlite3"


@dataclass(frozen=True, slots=True)
class Settings:
    database_url: str


def get_settings() -> Settings:
    return Settings(database_url=os.environ.get("AUROHEAR_DATABASE_URL", DEFAULT_DATABASE_URL))
