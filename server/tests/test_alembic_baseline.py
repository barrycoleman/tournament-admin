from __future__ import annotations

import importlib.resources as resources

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect

from tournament_server import models  # noqa: F401  (registers all tables)
from tournament_server.db import Base, make_engine


def _config_for(db_path: str) -> Config:
    config = Config()
    config.set_main_option(
        "script_location", str(resources.files("tournament_server") / "_alembic")
    )
    config.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")
    return config


def test_baseline_migration_creates_every_current_table(tmp_path):
    db_path = str(tmp_path / "baseline_test.db")
    engine = make_engine(db_path)
    config = _config_for(db_path)

    command.upgrade(config, "head")

    inspector = inspect(engine)
    actual_tables = set(inspector.get_table_names()) - {"alembic_version"}
    expected_tables = set(Base.metadata.tables.keys())
    assert actual_tables == expected_tables
