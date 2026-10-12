from __future__ import annotations

from pathlib import Path

import pytest

from alembic import command
from auth_helpers import TEST_PASSWORD
from fastapi.testclient import TestClient
from migration_helpers import build_isolated_two_revision_script_dir
from sqlalchemy import create_engine, inspect, text

from tournament_server import migrations
from tournament_server.app import create_app
from tournament_server.auth import hash_password
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


def test_stamped_baseline_database_with_zero_divisions_self_heals_via_create_app(tmp_path):
    """A pre-Alembic database whose reflected schema already matches
    today's models gets silently stamped to head by ensure_schema_current
    -- the STAMPED_BASELINE path -- without ever running any migration's
    upgrade(). create_app()'s own startup self-heal step is what gives a
    zero-division event its "Division 1" on this path: it must do so even
    though no migration upgrade() ever ran for it."""
    db_path = str(tmp_path / "pre_alembic_no_divisions.db")
    engine = make_engine(db_path)
    init_db(engine)  # simulates a database created before this phase existed

    with engine.connect() as connection:
        connection.execute(
            text(
                "INSERT INTO events (id, name, created_at) "
                "VALUES (1, 'No Divisions Yet', '2026-01-01 00:00:00')"
            )
        )
        connection.commit()

    outcome = ensure_schema_current(engine, db_path)
    assert outcome == MigrationOutcome.STAMPED_BASELINE

    with engine.connect() as connection:
        division_count_before = connection.execute(
            text("SELECT COUNT(*) FROM divisions WHERE event_id = 1")
        ).scalar_one()
    assert division_count_before == 0

    create_app(db_path=db_path, plugins_root=str(tmp_path / "plugins"))

    with engine.connect() as connection:
        divisions_after = connection.execute(
            text("SELECT name FROM divisions WHERE event_id = 1")
        ).scalars().all()
    assert divisions_after == ["Division 1"]


def test_startup_self_heal_assigns_unassigned_teams_to_a_pre_existing_sole_division(tmp_path):
    """A database that hit the sole-division-teams-not-assigned bug before
    this fix existed has a real event, exactly one division, and one or
    more teams with a null division_id -- a state this project's own
    create_app() could produce before this task's own change existed.
    The startup self-heal must fix it on the next launch, the same way it
    already fixes a zero-division event."""
    db_path = str(tmp_path / "stale_unassigned_teams.db")
    engine = make_engine(db_path)
    init_db(engine)

    with engine.connect() as connection:
        connection.execute(
            text(
                "INSERT INTO events (id, name, created_at) "
                "VALUES (1, 'Regional Qualifier', '2026-01-01 00:00:00')"
            )
        )
        connection.execute(
            text("INSERT INTO divisions (id, event_id, name) VALUES (1, 1, 'Division 1')")
        )
        connection.execute(
            text(
                "INSERT INTO teams (id, event_id, number, name, division_id, tiebreaker_seed) "
                "VALUES (1, 1, '1234A', 'Robo Raiders', NULL, 0)"
            )
        )
        connection.commit()

    create_app(db_path=db_path, plugins_root=str(tmp_path / "plugins"))

    with engine.connect() as connection:
        division_id_after = connection.execute(
            text("SELECT division_id FROM teams WHERE id = 1")
        ).scalar_one()
    assert division_id_after == 1


def test_startup_self_heal_backfills_missing_role_credential(tmp_path):
    """A database created before `front_desk` existed has RoleCredential
    rows for the original six roles only -- the next launch must backfill
    a front_desk row, seeded from the admin row's own password (both the
    hash and the encrypted copy), without touching any existing row."""
    db_path = str(tmp_path / "missing_role_credential.db")
    engine = make_engine(db_path)
    init_db(engine)

    with engine.connect() as connection:
        connection.execute(
            text(
                "INSERT INTO events (id, name, created_at) "
                "VALUES (1, 'Regional Qualifier', '2026-01-01 00:00:00')"
            )
        )
        connection.execute(
            text("INSERT INTO divisions (id, event_id, name) VALUES (1, 1, 'Division 1')")
        )
        for role in ("admin", "scorer", "judge", "referee", "attendee", "display_device"):
            password_hash = f"hash-for-{role}"
            password_encrypted = f"encrypted-for-{role}" if role == "admin" else None
            connection.execute(
                text(
                    "INSERT INTO role_credentials (role, password_hash, password_encrypted) "
                    "VALUES (:role, :password_hash, :password_encrypted)"
                ),
                {"role": role, "password_hash": password_hash, "password_encrypted": password_encrypted},
            )
        connection.commit()

    create_app(db_path=db_path, plugins_root=str(tmp_path / "plugins"))

    with engine.connect() as connection:
        rows = connection.execute(
            text("SELECT role, password_hash, password_encrypted FROM role_credentials")
        ).all()
    by_role = {row.role: row for row in rows}
    assert set(by_role.keys()) == {
        "admin", "scorer", "judge", "referee", "attendee", "display_device", "front_desk",
    }
    assert by_role["front_desk"].password_hash == "hash-for-admin"
    assert by_role["front_desk"].password_encrypted == "encrypted-for-admin"
    # Pre-existing rows are untouched.
    assert by_role["scorer"].password_hash == "hash-for-scorer"

    # Idempotence: a second startup must not create a duplicate front_desk row.
    create_app(db_path=db_path, plugins_root=str(tmp_path / "plugins"))
    with engine.connect() as connection:
        front_desk_count = connection.execute(
            text("SELECT COUNT(*) FROM role_credentials WHERE role = 'front_desk'")
        ).scalar_one()
    assert front_desk_count == 1


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


def test_database_stamped_at_a_revision_that_no_longer_exists_but_matching_is_restamped(tmp_path):
    """Before the first release the migrations are squashed into one baseline, so a
    database made by an older build can carry a revision id that no longer exists.
    If its tables still match the models it keeps its data and moves to head."""
    db_path = str(tmp_path / "squashed.db")
    engine = make_engine(db_path)
    init_db(engine)
    with engine.connect() as connection:
        connection.exec_driver_sql("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        connection.exec_driver_sql("INSERT INTO alembic_version VALUES ('0ld5ca1e0001')")
        connection.commit()

    outcome = ensure_schema_current(engine, db_path)

    assert outcome == MigrationOutcome.STAMPED_BASELINE
    with engine.connect() as connection:
        head = migrations.ScriptDirectory.from_config(_make_alembic_config(db_path)).get_current_head()
        assert connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar_one() == head


def test_database_stamped_at_a_revision_that_no_longer_exists_and_differs_is_refused(tmp_path):
    db_path = str(tmp_path / "older_build.db")
    engine = make_engine(db_path)
    Base.metadata.create_all(
        engine, tables=[t for name, t in Base.metadata.tables.items() if name != "awards"]
    )
    with engine.connect() as connection:
        connection.exec_driver_sql("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        connection.exec_driver_sql("INSERT INTO alembic_version VALUES ('0ld5ca1e0001')")
        connection.commit()

    with pytest.raises(SchemaMismatchError) as raised:
        ensure_schema_current(engine, db_path)
    assert db_path in str(raised.value)
    assert "older build" in str(raised.value)


def test_database_at_head_whose_tables_differ_is_refused(tmp_path):
    """Until the first release the baseline is edited in place, so a file stamped at
    head can still predate a model change. It is refused rather than opened."""
    db_path = str(tmp_path / "edited_baseline.db")
    engine = make_engine(db_path)
    ensure_schema_current(engine, db_path)
    with engine.connect() as connection:
        connection.exec_driver_sql("DROP TABLE awards")
        connection.commit()

    with pytest.raises(SchemaMismatchError) as raised:
        ensure_schema_current(engine, db_path)
    assert "older build" in str(raised.value)


def test_upgrade_recomputes_rankings_once_at_startup(tmp_path, monkeypatch):
    """Migrations never touch stored ranking rows, so create_app rebuilds the
    rankings once after an upgrade."""
    import json
    import shutil

    from sqlalchemy.orm import Session as OrmSession

    from tournament_server.models import (
        Alliance, AllianceTeam, Event, Match, RoleCredential, ScoreRecord, Team, TournamentSession,
    )

    db_path = str(tmp_path / "upgrade_rankings.db")
    engine = make_engine(db_path)
    ensure_schema_current(engine, db_path)
    # Team 1 scores 3 * 5 = 15; team 2 scores 3 * 1 + 10 = 13 (see the example plugin).
    sheets = {"red": {"high_balls": 5, "auto_winner": "tie"}, "blue": {"high_balls": 1, "auto_winner": "red"}}
    with OrmSession(engine) as db:
        db.add(Event(id=1, name="League", active_session_id=1, game_plugin_name="example-game"))
        db.flush()
        db.add(TournamentSession(id=1, event_id=1, label="Saturday", timezone="America/Los_Angeles"))
        db.flush()
        for team_id in (1, 2):
            db.add(Team(id=team_id, event_id=1, number=str(100 + team_id), name=f"Team {team_id}",
                        tiebreaker_seed=team_id))
        db.add(Match(id=1, session_id=1, round_type="qualification", match_number=1, status="completed"))
        db.flush()
        for alliance_id, station in ((1, "red"), (2, "blue")):
            db.add(Alliance(id=alliance_id, match_id=1, station=station))
            db.flush()
            db.add(AllianceTeam(alliance_id=alliance_id, team_id=alliance_id))
            db.add(ScoreRecord(alliance_id=alliance_id, plugin_name="example-game", plugin_version="1.0.0",
                               data_json=json.dumps(sheets[station])))
        db.add(RoleCredential(role="admin", password_hash=hash_password(TEST_PASSWORD)))
        db.commit()
        assert db.execute(text("SELECT COUNT(*) FROM rankings")).scalar_one() == 0
    engine.dispose()

    from conftest import FIXTURE_EXAMPLE_PLUGIN
    from tournament_server import app as app_module

    plugins_root = tmp_path / "plugins"
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, plugins_root / "games" / "example-game")
    monkeypatch.setattr(app_module, "ensure_schema_current", lambda engine, path: MigrationOutcome.UPGRADED)

    app = create_app(db_path=db_path, plugins_root=str(plugins_root))
    with TestClient(app) as client:
        login = client.post("/api/auth/login", json={"role": "admin", "password": TEST_PASSWORD})
        assert login.status_code == 200, login.text
        client.headers["Authorization"] = f"Bearer {login.json()['access_token']}"
        response = client.get("/api/rankings", params={"event_wide": "true"})
    assert response.status_code == 200, response.text
    assert [(row["team_id"], row["rank"]) for row in response.json()] == [(1, 1), (2, 2)]
