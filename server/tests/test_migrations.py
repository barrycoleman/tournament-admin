from __future__ import annotations

from pathlib import Path

from alembic import command
from migration_helpers import build_isolated_two_revision_script_dir
from sqlalchemy import inspect

from tournament_server import migrations
from tournament_server.db import Base, init_db, make_engine
from tournament_server.migrations import (
    MigrationOutcome,
    SchemaMismatchError,
    _make_alembic_config,
    ensure_schema_current,
)


def test_fresh_empty_database_gets_migrated_from_scratch(tmp_path):
    db_path = str(tmp_path / "fresh.db")
    engine = make_engine(db_path)

    outcome = ensure_schema_current(engine, db_path)

    assert outcome == MigrationOutcome.FRESH_INSTALL
    inspector = inspect(engine)
    actual_tables = set(inspector.get_table_names()) - {"alembic_version"}
    assert actual_tables == set(Base.metadata.tables.keys())


def test_matching_pre_alembic_database_gets_stamped(tmp_path):
    db_path = str(tmp_path / "pre_alembic.db")
    engine = make_engine(db_path)
    init_db(engine)  # simulates a database created before this phase existed

    outcome = ensure_schema_current(engine, db_path)

    assert outcome == MigrationOutcome.STAMPED_BASELINE
    inspector = inspect(engine)
    assert "alembic_version" in inspector.get_table_names()


def test_mismatched_pre_alembic_database_is_refused(tmp_path):
    db_path = str(tmp_path / "old.db")
    engine = make_engine(db_path)
    # Simulate a genuinely old schema: create every table EXCEPT one, so
    # the reflected shape can never match today's models.
    tables_to_create = [
        t for name, t in Base.metadata.tables.items() if name != "scoring_devices"
    ]
    Base.metadata.create_all(engine, tables=tables_to_create)

    raised = False
    try:
        ensure_schema_current(engine, db_path)
    except SchemaMismatchError as exc:
        raised = True
        assert db_path in str(exc)
    assert raised, "expected SchemaMismatchError"


def test_database_already_at_head_does_nothing(tmp_path):
    db_path = str(tmp_path / "current.db")
    engine = make_engine(db_path)

    ensure_schema_current(engine, db_path)  # fresh install -> now at head
    outcome = ensure_schema_current(engine, db_path)  # second call

    assert outcome == MigrationOutcome.ALREADY_CURRENT
    assert list(Path(tmp_path).glob("current.db.pre-migration-*.bak")) == []


def test_database_behind_head_gets_backed_up_and_upgraded(tmp_path, monkeypatch):
    script_dir = build_isolated_two_revision_script_dir(tmp_path)
    monkeypatch.setattr(migrations, "_script_location", lambda: str(script_dir))

    db_path = str(tmp_path / "behind.db")
    engine = make_engine(db_path)

    # Apply only rev1, leaving this database one migration behind head.
    config = _make_alembic_config(db_path)
    command.upgrade(config, "rev1")

    outcome = ensure_schema_current(engine, db_path)

    assert outcome == MigrationOutcome.UPGRADED
    backups = list(Path(tmp_path).glob("behind.db.pre-migration-*.bak"))
    assert len(backups) == 1

    inspector = inspect(engine)
    columns = {col["name"] for col in inspector.get_columns("widgets")}
    assert columns == {"id", "name"}
