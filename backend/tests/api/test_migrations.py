"""Alembic migration checks (CONFERENCE_UPGRADE_STRATEGY §4: migration check in CI)."""

from __future__ import annotations

import io
from contextlib import redirect_stdout
from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from sqlalchemy import inspect

from aurohear.db import Base, make_engine
from conftest import alembic_config

TABLES = {"sessions", "trials", "threshold_results", "quality_metrics", "feedback", "nlp_insights"}


def test_upgrade_head_matches_orm_models_exactly(tmp_path: Path) -> None:
    """No drift: the migrated schema is what the ORM expects (autogenerate finds nothing)."""
    engine = make_engine(f"sqlite:///{tmp_path / 'm.sqlite3'}")
    cfg = alembic_config()
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, "head")
    with engine.connect() as conn:
        ctx = MigrationContext.configure(conn, opts={"compare_type": True, "render_as_batch": True})
        diff = compare_metadata(ctx, Base.metadata)
    assert diff == []
    assert TABLES <= set(inspect(engine).get_table_names())


def test_downgrade_base_removes_everything(tmp_path: Path) -> None:
    engine = make_engine(f"sqlite:///{tmp_path / 'm.sqlite3'}")
    cfg = alembic_config()
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, "head")
        command.downgrade(cfg, "base")
    assert set(inspect(engine).get_table_names()) <= {"alembic_version"}


def test_constraints_render_for_postgresql(monkeypatch: pytest.MonkeyPatch) -> None:
    """Offline SQL generation for the production dialect — catches non-portable CHECKs."""
    monkeypatch.setenv("AUROHEAR_DATABASE_URL", "postgresql://user@localhost/aurohear")
    buf = io.StringIO()
    with redirect_stdout(buf):
        command.upgrade(alembic_config(), "head", sql=True)
    sql = buf.getvalue()
    for table in TABLES:
        assert f"CREATE TABLE {table}" in sql
    assert "CONSTRAINT ck_trials_response_consistency CHECK" in sql
    assert "CONSTRAINT ck_threshold_results_hughson_westlake_criterion CHECK" in sql
    assert "UUID" in sql and "TIMESTAMP WITH TIME ZONE" in sql
