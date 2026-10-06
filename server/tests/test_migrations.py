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
    upgrade(), including the data-only backfill migration
    (d47c8e21f9a3) that would otherwise give a zero-division event its
    "Division 1". create_app()'s own startup self-heal step is the actual
    backstop for this path: it must give this event a division even
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


def test_backfill_migration_computes_matchup_number_from_round_and_position(tmp_path):
    """Regression test for a Critical finding on the bracket_matchups
    matchup_number migration (c9d34b7a1f02): it originally added the
    column as nullable with no backfill for pre-existing rows, reasoning
    that an already-decided bracket has no retroactive numbering *need*
    -- true on its own, but routers/matches.py's _to_match_read feeds a
    null matchup_number straight into match_label(), which raises
    ValueError for any single_elimination series game lacking one,
    500ing the *entire* GET /api/matches list for that session (since
    _to_match_read runs once per match in the list).

    This builds a throwaway database at the pre-this-revision baseline,
    inserts bracket_matchups rows directly via raw SQL -- out of
    (round_number, position) order, to prove the backfill sorts rather
    than relying on insertion order -- then runs the real upgrade to
    head and asserts matchup_number was backfilled correctly: a running
    counter per bracket_id, ordered (round_number, position) ascending,
    matching services/finals.py's generate_bracket.
    """
    db_path = str(tmp_path / "pre_existing_matchups.db")
    config = _make_alembic_config(db_path)
    command.upgrade(config, "a2c6f19e4d80")  # baseline, before this task's migration

    raw_engine = create_engine(f"sqlite:///{db_path}")
    with raw_engine.connect() as connection:
        # Bracket 1: a 4-alliance bracket (2 round-1 matchups, 1 round-2
        # final) -- inserted out of (round_number, position) order.
        connection.execute(
            text(
                "INSERT INTO bracket_matchups (id, bracket_id, round_number, position) "
                "VALUES (1, 1, 2, 0)"
            )
        )
        connection.execute(
            text(
                "INSERT INTO bracket_matchups (id, bracket_id, round_number, position) "
                "VALUES (2, 1, 1, 1)"
            )
        )
        connection.execute(
            text(
                "INSERT INTO bracket_matchups (id, bracket_id, round_number, position) "
                "VALUES (3, 1, 1, 0)"
            )
        )
        # Bracket 2: a separate, 2-alliance bracket -- its own counter
        # must restart at 1, not continue bracket 1's.
        connection.execute(
            text(
                "INSERT INTO bracket_matchups (id, bracket_id, round_number, position) "
                "VALUES (4, 2, 1, 0)"
            )
        )
        connection.commit()
    raw_engine.dispose()

    engine = make_engine(db_path)
    outcome = ensure_schema_current(engine, db_path)

    assert outcome == MigrationOutcome.UPGRADED

    with engine.connect() as connection:
        rows = connection.execute(
            text("SELECT id, matchup_number FROM bracket_matchups ORDER BY id")
        ).all()
    matchup_number_by_id = {r.id: r.matchup_number for r in rows}
    # Bracket 1: round 1 position 0 -> 1, round 1 position 1 -> 2,
    # round 2 position 0 -> 3 (round ascending, then position ascending).
    assert matchup_number_by_id[3] == 1  # round 1, position 0
    assert matchup_number_by_id[2] == 2  # round 1, position 1
    assert matchup_number_by_id[1] == 3  # round 2, position 0
    # Bracket 2's own counter restarts at 1.
    assert matchup_number_by_id[4] == 1


def test_backfill_migration_adds_a_default_division_for_event_with_none(tmp_path):
    """An event created before this migration existed could have zero
    divisions (nothing seeded one at event-creation time back then).
    Upgrading such a database must give it one, but must NOT touch an
    event that already has divisions of its own."""
    db_path = str(tmp_path / "pre_existing_events.db")
    config = _make_alembic_config(db_path)
    command.upgrade(config, "b7e4a19f6c32")  # baseline, before this task's migration

    raw_engine = create_engine(f"sqlite:///{db_path}")
    with raw_engine.connect() as connection:
        connection.execute(
            text(
                "INSERT INTO events (id, name, created_at) "
                "VALUES (1, 'No Divisions Yet', '2026-01-01 00:00:00')"
            )
        )
        connection.execute(
            text(
                "INSERT INTO events (id, name, created_at) "
                "VALUES (2, 'Already Has One', '2026-01-01 00:00:00')"
            )
        )
        connection.execute(
            text("INSERT INTO divisions (id, event_id, name) VALUES (1, 2, 'Existing Division')")
        )
        connection.commit()
    raw_engine.dispose()

    engine = make_engine(db_path)
    outcome = ensure_schema_current(engine, db_path)

    assert outcome == MigrationOutcome.UPGRADED

    with engine.connect() as connection:
        event_1_divisions = connection.execute(
            text("SELECT name FROM divisions WHERE event_id = 1")
        ).scalars().all()
        event_2_divisions = connection.execute(
            text("SELECT name FROM divisions WHERE event_id = 2")
        ).scalars().all()

    assert event_1_divisions == ["Division 1"]
    assert event_2_divisions == ["Existing Division"]  # untouched -- already had one


def test_playing_windows_upgrade_keeps_existing_schedule_generations(tmp_path):
    """The schedule planner's migrations (e5a1c3b9d2f4 adds
    session_playing_windows, f6b2d4c8e1a7 adds a nullable
    schedule_generations.cycle_time_seconds) must upgrade a database that
    already holds a generated schedule: the generation and its matches
    survive with a null cycle time, the windows table exists (empty), and
    GET /api/schedule/rounds still reports the round."""
    db_path = str(tmp_path / "pre_existing_generations.db")
    config = _make_alembic_config(db_path)
    command.upgrade(config, "c9d34b7a1f02")  # baseline, before the planner's migrations

    raw_engine = create_engine(f"sqlite:///{db_path}")
    with raw_engine.connect() as connection:
        connection.execute(
            text(
                "INSERT INTO events (id, name, active_session_id, created_at) "
                "VALUES (1, 'Regional Qualifier', 1, '2026-01-01 00:00:00')"
            )
        )
        connection.execute(
            text(
                "INSERT INTO sessions (id, event_id, label, session_date, timezone) "
                "VALUES (1, 1, 'Saturday', '2026-11-07', 'America/Los_Angeles')"
            )
        )
        connection.execute(
            text(
                "INSERT INTO schedule_generations (id, session_id, division_id, round_type, "
                "scheduler_plugin_name, scheduler_plugin_version, target_matches_per_team, "
                "generated_at, time_blocks_json) VALUES (1, 1, NULL, 'qualification', "
                "'simple_random', '1.0.0', 4, '2026-11-01 12:00:00', NULL)"
            )
        )
        for number, start in ((1, "2026-11-07 17:00:00"), (2, "2026-11-07 17:05:00")):
            connection.execute(
                text(
                    "INSERT INTO matches (session_id, division_id, round_type, match_number, "
                    "schedule_generation_id, scheduled_time, status, phase, paused) "
                    "VALUES (1, NULL, 'qualification', :number, 1, :start, 'scheduled', "
                    "'not_started', 0)"
                ),
                {"number": number, "start": start},
            )
        connection.execute(
            text("INSERT INTO role_credentials (role, password_hash) VALUES ('admin', :hash)"),
            {"hash": hash_password(TEST_PASSWORD)},
        )
        connection.commit()
    raw_engine.dispose()

    engine = make_engine(db_path)
    assert ensure_schema_current(engine, db_path) == MigrationOutcome.UPGRADED

    inspector = inspect(engine)
    assert "session_playing_windows" in inspector.get_table_names()
    with engine.connect() as connection:
        generation = connection.execute(
            text("SELECT id, target_matches_per_team, cycle_time_seconds FROM schedule_generations")
        ).one()
        window_count = connection.execute(
            text("SELECT COUNT(*) FROM session_playing_windows")
        ).scalar_one()
    assert (generation.id, generation.target_matches_per_team) == (1, 4)
    assert generation.cycle_time_seconds is None
    assert window_count == 0

    app = create_app(db_path=db_path, plugins_root=str(tmp_path / "plugins"))
    with TestClient(app) as client:
        login = client.post("/api/auth/login", json={"role": "admin", "password": TEST_PASSWORD})
        assert login.status_code == 200, login.text
        client.headers["Authorization"] = f"Bearer {login.json()['access_token']}"
        response = client.get("/api/schedule/rounds", params={"session_id": 1})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["session_last_cycle_time_seconds"] is None
    assert len(body["rounds"]) == 1
    round_ = body["rounds"][0]
    assert round_["round_type"] == "qualification"
    assert round_["target_matches_per_team"] == 4
    assert round_["cycle_time_seconds"] is None
    assert round_["match_count"] == 2
    assert round_["locked"] is False
    assert round_["outside_playing_windows"] is False


@pytest.mark.parametrize(
    "configurations, expected",
    [
        (
            [(1, None, "exclude", 2, 1, 0)],
            {"session_drop_mode": "lowest", "session_drop_count": 2,
             "session_drop_no_show": 1, "session_drop_dq": 0,
             "season_keep_best": None, "season_minimum": 0,
             "season_drop_no_show": 1, "season_drop_dq": 0},
        ),
        (
            [(1, None, "include", 5, 0, 1)],
            {"session_drop_mode": "tiered", "session_drop_count": 1,
             "session_drop_no_show": 0, "session_drop_dq": 1,
             "season_keep_best": 5, "season_minimum": 5,
             "season_drop_no_show": 0, "season_drop_dq": 1},
        ),
        (
            [(1, 1, "exclude", 1, 0, 0)],
            {"session_drop_mode": "lowest", "session_drop_count": 1,
             "session_drop_no_show": 0, "session_drop_dq": 0,
             "season_keep_best": None, "season_minimum": 0,
             "season_drop_no_show": 0, "season_drop_dq": 0},
        ),
        (
            # The event-wide row wins over a lower-id per-division row.
            [(1, 1, "include", 3, 0, 0), (2, None, "exclude", 1, 0, 0)],
            {"session_drop_mode": "lowest", "session_drop_count": 1,
             "session_drop_no_show": 0, "session_drop_dq": 0,
             "season_keep_best": None, "season_minimum": 0,
             "season_drop_no_show": 0, "season_drop_dq": 0},
        ),
        ([], None),
    ],
)
def test_ranking_configuration_converts_to_ranking_settings(tmp_path, configurations, expected):
    db_path = str(tmp_path / "ranking_configuration.db")
    config = _make_alembic_config(db_path)
    command.upgrade(config, "f6b2d4c8e1a7")  # the revision before ranking_settings

    raw_engine = create_engine(f"sqlite:///{db_path}")
    with raw_engine.connect() as connection:
        connection.execute(
            text("INSERT INTO events (id, name, created_at) VALUES (1, 'League', '2026-01-01 00:00:00')")
        )
        connection.execute(text("INSERT INTO divisions (id, event_id, name) VALUES (1, 1, 'Rookie')"))
        for row_id, division_id, mode, count, no_show, dq in configurations:
            connection.execute(
                text(
                    "INSERT INTO ranking_configurations (id, event_id, division_id, mode, count, "
                    "allow_drop_no_show, allow_drop_dq) VALUES (:id, 1, :division_id, :mode, :count, "
                    ":no_show, :dq)"
                ),
                {"id": row_id, "division_id": division_id, "mode": mode, "count": count,
                 "no_show": no_show, "dq": dq},
            )
        connection.commit()
    raw_engine.dispose()

    engine = make_engine(db_path)
    assert ensure_schema_current(engine, db_path) == MigrationOutcome.UPGRADED
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT session_drop_mode, session_drop_count, session_drop_no_show, session_drop_dq, "
                "season_keep_best, season_minimum, season_drop_no_show, season_drop_dq, "
                "season_only_session_counted FROM ranking_settings WHERE event_id = 1"
            )
        ).mappings().all()
    if expected is None:
        assert rows == []
    else:
        assert len(rows) == 1
        assert dict(rows[0]) == {**expected, "season_only_session_counted": 0}
    assert "ranking_configurations" not in inspect(engine).get_table_names()
