from __future__ import annotations

from pathlib import Path

from alembic import command
from migration_helpers import build_isolated_two_revision_script_dir
from sqlalchemy import create_engine, inspect, text

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


def test_upgrade_over_pre_existing_match_row_succeeds(tmp_path):
    """Regression test for a Critical finding on the match live-timing
    migration (9ee2761f45b6): it originally added `phase`/`paused` as
    NOT NULL with no `server_default`, which SQLite refuses for
    `ALTER TABLE ... ADD COLUMN` on a table that already has rows. Any
    self-hosted install with even one existing match row would have
    failed to start after upgrading past that change.

    This builds a throwaway database at the pre-this-task baseline
    revision, inserts a row into `matches` directly via raw SQL
    (bypassing the ORM/model entirely, matching how a real pre-existing
    installation's table would look before these columns existed), then
    runs the real upgrade to head via `ensure_schema_current` -- the
    exact call it makes in its UPGRADED branch -- and asserts it
    succeeds and backfills sane values onto the pre-existing row.
    """
    db_path = str(tmp_path / "pre_existing_match.db")
    config = _make_alembic_config(db_path)
    command.upgrade(config, "0c4b59d7dfca")  # baseline, before this task's migration

    # Insert directly via SQL, bypassing the ORM/model entirely, using a
    # bare connection with no FK enforcement pragma -- exactly how a real
    # pre-existing installation's `matches` table would look before this
    # task's columns existed.
    raw_engine = create_engine(f"sqlite:///{db_path}")
    with raw_engine.connect() as connection:
        connection.execute(
            text(
                "INSERT INTO matches (session_id, round_type, match_number, status) "
                "VALUES (1, 'qualification', 1, 'scheduled')"
            )
        )
        connection.commit()
    raw_engine.dispose()

    engine = make_engine(db_path)
    outcome = ensure_schema_current(engine, db_path)

    assert outcome == MigrationOutcome.UPGRADED

    with engine.connect() as connection:
        row = connection.execute(
            text("SELECT phase, paused FROM matches WHERE session_id = 1")
        ).one()
    assert row.phase == "not_started"
    assert bool(row.paused) is False


def test_upgrade_over_pre_existing_team_rows_succeeds(tmp_path):
    """The team/division migration (b7e4a19f6c32) doesn't just ADD COLUMN:
    it also adds a table-level unique constraint, which SQLite can only do
    by rebuilding the whole `teams` table via `batch_alter_table`. A table
    rebuild is exactly where existing rows get lost and where foreign keys
    silently disappear, so this exercises it against a populated table --
    an event, a division, and two teams (one of them referencing the
    division) inserted at the pre-this-task baseline revision.
    """
    db_path = str(tmp_path / "pre_existing_teams.db")
    config = _make_alembic_config(db_path)
    command.upgrade(config, "9ee2761f45b6")  # baseline, before this task's migration

    raw_engine = create_engine(f"sqlite:///{db_path}")
    with raw_engine.connect() as connection:
        connection.execute(
            text(
                "INSERT INTO events (id, name, created_at) "
                "VALUES (1, 'Regional Qualifier', '2026-01-01 00:00:00')"
            )
        )
        connection.execute(
            text("INSERT INTO divisions (id, event_id, name) VALUES (1, 1, 'Elementary')")
        )
        connection.execute(
            text(
                "INSERT INTO teams (id, event_id, division_id, number, name, tiebreaker_seed) "
                "VALUES (1, 1, 1, '1234A', 'Robo Raiders', 10)"
            )
        )
        connection.execute(
            text(
                "INSERT INTO teams (id, event_id, division_id, number, name, tiebreaker_seed) "
                "VALUES (2, 1, NULL, '5678B', 'Circuit Breakers', 20)"
            )
        )
        connection.commit()
    raw_engine.dispose()

    engine = make_engine(db_path)
    outcome = ensure_schema_current(engine, db_path)

    assert outcome == MigrationOutcome.UPGRADED

    with engine.connect() as connection:
        rows = connection.execute(
            text("SELECT id, number, robot_name FROM teams ORDER BY id")
        ).all()
    assert [(r.id, r.number) for r in rows] == [(1, "1234A"), (2, "5678B")]
    assert all(r.robot_name is None for r in rows)

    inspector = inspect(engine)
    unique_constraint_names = {
        constraint["name"] for constraint in inspector.get_unique_constraints("teams")
    }
    assert "uq_teams_event_number" in unique_constraint_names

    referred_tables = {fk["referred_table"] for fk in inspector.get_foreign_keys("teams")}
    assert {"events", "divisions"} <= referred_tables
