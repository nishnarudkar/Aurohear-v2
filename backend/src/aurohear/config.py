"""Runtime settings, read from the environment.

AUROHEAR_DATABASE_URL  SQLAlchemy URL. Default: a local SQLite file for development.
                       Production: PostgreSQL, e.g. postgresql+psycopg://user@host/db
"""

from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_DATABASE_URL = "sqlite:///./aurohear-dev.sqlite3"
DEFAULT_CORS_ORIGINS: tuple[str, ...] = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
)


@dataclass(frozen=True, slots=True)
class Settings:
    database_url: str
    cors_origins: tuple[str, ...] = DEFAULT_CORS_ORIGINS
    #: Bearer token for admin-only endpoints (NLP insights). Unset → those endpoints are disabled.
    admin_token: str | None = None


def get_settings() -> Settings:
    db_url = os.environ.get("AUROHEAR_DATABASE_URL", DEFAULT_DATABASE_URL)
    raw_cors = os.environ.get("AUROHEAR_CORS_ORIGINS")
    if raw_cors:
        cors_origins = tuple(o.strip() for o in raw_cors.split(",") if o.strip())
    else:
        cors_origins = DEFAULT_CORS_ORIGINS
    return Settings(
        database_url=db_url,
        cors_origins=cors_origins,
        admin_token=os.environ.get("AUROHEAR_ADMIN_TOKEN") or None,
    )
