from __future__ import annotations

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext

from tournament_server import models  # noqa: F401  (registers all tables)
from tournament_server.db import Base, make_engine
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
