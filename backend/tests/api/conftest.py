"""API test fixtures. Every test database is built by running the real Alembic
migrations (not `create_all`), so the suite also verifies the migration."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from aurohear.api.app import create_app
from aurohear.db import make_engine

BACKEND_DIR = Path(__file__).resolve().parents[2]


def alembic_config() -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    cfg.attributes["configure_logger"] = False  # keep pytest's log capture intact
    return cfg


def migrated_engine(url: str = "sqlite://") -> Engine:
    engine = make_engine(url, in_memory_shared=url == "sqlite://")
    cfg = alembic_config()
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, "head")
    return engine


@pytest.fixture
def engine() -> Iterator[Engine]:
    e = migrated_engine()
    yield e
    e.dispose()


@pytest.fixture
def client(engine: Engine) -> Iterator[TestClient]:
    with TestClient(create_app(engine)) as c:
        yield c
