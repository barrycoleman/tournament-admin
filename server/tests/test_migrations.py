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


def test_type_mismatched_pre_alembic_database_is_refused(tmp_path):
    """A database whose reflected schema has matching table/column NAMES
    but an incompatible column TYPE must still be refused. The old
    name-only comparison would have wrongly stamped this as current;
    compare_metadata (via Alembic's own autogenerate diff) catches the
    type drift.
    """
    db_path = str(tmp_path / "type_mismatch.db")
    engine = make_engine(db_path)

    tables_except_teams = [
        t for name, t in Base.metadata.tables.items() if name != "teams"
    ]
    Base.metadata.create_all(engine, tables=tables_except_teams)

    with engine.connect() as connection:
        # Same table/column names as the real `teams` model, but `number`
        # is INTEGER here where the model declares String(20) — a type
        # drift that a name-only comparison can't see.
        connection.exec_driver_sql(
            """
            CREATE TABLE teams (
                id INTEGER NOT NULL PRIMARY KEY,
                event_id INTEGER NOT NULL,
                division_id INTEGER,
                number INTEGER NOT NULL,
                name VARCHAR(200) NOT NULL,
                organization VARCHAR(200),
                city VARCHAR(200),
                state VARCHAR(100),
                country VARCHAR(100),
                tiebreaker_seed INTEGER NOT NULL,
                FOREIGN KEY(event_id) REFERENCES events (id),
                FOREIGN KEY(division_id) REFERENCES divisions (id)
            )
            """
        )
        connection.commit()

    raised = False
    try:
        ensure_schema_current(engine, db_path)
    except SchemaMismatchError:
        raised = True
    assert raised, (
        "expected SchemaMismatchError for a table matching by name but "
        "with an incompatible column type"
    )


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
