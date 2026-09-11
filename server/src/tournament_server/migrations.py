from __future__ import annotations

import datetime as dt
import shutil
from enum import Enum
from importlib import resources

from alembic import command
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import inspect
from sqlalchemy.engine import Engine

from tournament_server.db import Base


class SchemaMismatchError(RuntimeError):
    """Raised when a database's schema doesn't match any known migration
    state — pre-Alembic and not identical to the current baseline schema."""


class MigrationOutcome(Enum):
    ALREADY_CURRENT = "already_current"
    FRESH_INSTALL = "fresh_install"
    STAMPED_BASELINE = "stamped_baseline"
    UPGRADED = "upgraded"


def _script_location() -> str:
    # Resolved via importlib.resources so this works identically whether
    # running from a source checkout or a future frozen executable.
    return str(resources.files("tournament_server") / "_alembic")


def _make_alembic_config(db_path: str) -> Config:
    config = Config()
    config.set_main_option("script_location", _script_location())
    config.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")
    return config


def _has_any_tables(engine: Engine) -> bool:
    return bool(inspect(engine).get_table_names())


def _reflected_schema_matches_models(engine: Engine) -> bool:
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    expected_tables = set(Base.metadata.tables.keys())
    if existing_tables != expected_tables:
        return False
    for table_name, table in Base.metadata.tables.items():
        existing_columns = {col["name"] for col in inspector.get_columns(table_name)}
        expected_columns = {col.name for col in table.columns}
        if existing_columns != expected_columns:
            return False
    return True


def _backup_path(db_path: str, now: dt.datetime) -> str:
    timestamp = now.strftime("%Y%m%d-%H%M%S")
    return f"{db_path}.pre-migration-{timestamp}.bak"


def _backup_database(engine: Engine, db_path: str) -> None:
    # Checkpoint WAL into the main file first so the copy is a complete,
    # self-consistent snapshot (this project's engines run in WAL mode —
    # see db.py's make_engine — so the main .db file alone can otherwise
    # be missing not-yet-checkpointed writes).
    with engine.connect() as connection:
        connection.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)")
    shutil.copyfile(db_path, _backup_path(db_path, dt.datetime.now(dt.UTC)))


def ensure_schema_current(engine: Engine, db_path: str) -> MigrationOutcome:
    config = _make_alembic_config(db_path)
    script = ScriptDirectory.from_config(config)
    head_revision = script.get_current_head()

    with engine.connect() as connection:
        context = MigrationContext.configure(connection)
        current_heads = context.get_current_heads()

    if not current_heads:
        if not _has_any_tables(engine):
            command.upgrade(config, "head")
            return MigrationOutcome.FRESH_INSTALL
        if _reflected_schema_matches_models(engine):
            command.stamp(config, "head")
            return MigrationOutcome.STAMPED_BASELINE
        raise SchemaMismatchError(
            f"{db_path}'s schema doesn't match any known version "
            "(pre-Alembic, and doesn't match the current baseline schema). "
            "No migration path exists for this file. If it holds no data "
            "you need, delete it and restart to create a fresh one."
        )

    if current_heads == (head_revision,):
        return MigrationOutcome.ALREADY_CURRENT

    _backup_database(engine, db_path)
    command.upgrade(config, "head")
    return MigrationOutcome.UPGRADED
