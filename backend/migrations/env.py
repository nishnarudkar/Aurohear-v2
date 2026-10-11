"""Alembic environment.

The database URL comes from AUROHEAR_DATABASE_URL (aurohear.config), or from
`config.attributes["connection"]` when a test passes a live connection in.
SQLite uses batch mode so ALTER-style migrations work there as on PostgreSQL.
"""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import Connection

from aurohear.config import get_settings
from aurohear.db import Base, make_engine

config = context.config
if config.config_file_name is not None and config.attributes.get("configure_logger", True):
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _configure(connection: Connection | None = None, url: str | None = None) -> None:
    is_sqlite = (connection.dialect.name if connection else (url or "")).startswith("sqlite")
    context.configure(
        connection=connection,
        url=url,
        target_metadata=target_metadata,
        render_as_batch=is_sqlite,
        compare_type=True,
        literal_binds=connection is None,
    )


def run_migrations_offline() -> None:
    _configure(url=get_settings().database_url)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connection = config.attributes.get("connection")
    if connection is not None:
        _configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()
        return
    engine = make_engine(get_settings().database_url)
    with engine.connect() as conn:
        _configure(connection=conn)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
