from __future__ import annotations

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext

from tournament_server import models  # noqa: F401  (registers all tables)
from tournament_server.db import Base, init_db, make_engine
from tournament_server.migrations import ensure_schema_current


def test_migrations_produce_a_schema_identical_to_the_current_models(tmp_path):
    db_path = str(tmp_path / "drift_check.db")
    engine = make_engine(db_path)

    ensure_schema_current(engine, db_path)  # applies the real, checked-in migrations

    with engine.connect() as connection:
        context = MigrationContext.configure(connection)
        diff = compare_metadata(context, Base.metadata)

    assert diff == [], (
        "The checked-in migrations produce a schema that differs from "
        "the current SQLAlchemy models. Generate and commit a new "
        f"migration for the following changes: {diff}"
    )


def _devices_sql(engine) -> str:
    with engine.connect() as connection:
        return connection.exec_driver_sql(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'devices'"
        ).scalar_one()


def test_device_ids_are_never_reused_in_a_migrated_database(tmp_path):
    # compare_metadata ignores AUTOINCREMENT, so check it directly: without it
    # a deleted device's id goes to the next device paired, and the deleted
    # device's unexpired access token would speak for the new one.
    db_path = str(tmp_path / "migrated.db")
    engine = make_engine(db_path)
    ensure_schema_current(engine, db_path)
    assert "AUTOINCREMENT" in _devices_sql(engine)


def test_device_ids_are_never_reused_in_a_created_database(tmp_path):
    engine = make_engine(str(tmp_path / "created.db"))
    init_db(engine)
    assert "AUTOINCREMENT" in _devices_sql(engine)
