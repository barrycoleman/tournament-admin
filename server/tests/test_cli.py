import subprocess
import sys
from pathlib import Path

from tournament_server.cli import main

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)
FIXTURE_BROKEN_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "broken-plugin"
)

FIXTURE_COOPERATIVE_GAME_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "cooperative-game"
)


def test_test_plugin_command_exits_zero_on_good_plugin(capsys):
    exit_code = main(["test-plugin", str(FIXTURE_EXAMPLE_PLUGIN)])
    assert exit_code == 0
    captured = capsys.readouterr()
    assert "All checks passed" in captured.out


def test_test_plugin_command_exits_nonzero_on_broken_plugin(capsys):
    exit_code = main(["test-plugin", str(FIXTURE_BROKEN_PLUGIN)])
    assert exit_code == 1
    captured = capsys.readouterr()
    assert "FAIL" in captured.out


def test_test_plugin_command_exits_zero_on_cooperative_game(capsys):
    exit_code = main(["test-plugin", str(FIXTURE_COOPERATIVE_GAME_PLUGIN)])
    assert exit_code == 0
    captured = capsys.readouterr()
    assert "All checks passed" in captured.out


def test_migrate_command_reports_fresh_install(tmp_path, capsys):
    db_path = str(tmp_path / "fresh.db")

    exit_code = main(["migrate", "--db-path", db_path])

    assert exit_code == 0
    captured = capsys.readouterr()
    assert "created fresh" in captured.out


def test_migrate_command_reports_schema_mismatch(tmp_path, capsys):
    from tournament_server.db import Base, make_engine

    db_path = str(tmp_path / "old.db")
    engine = make_engine(db_path)
    tables_to_create = [
        t for name, t in Base.metadata.tables.items() if name != "scoring_devices"
    ]
    Base.metadata.create_all(engine, tables=tables_to_create)

    exit_code = main(["migrate", "--db-path", db_path])

    assert exit_code == 1
    captured = capsys.readouterr()
    assert "ERROR" in captured.out


def test_migrate_command_reports_stamped_baseline(tmp_path, capsys):
    from tournament_server.db import Base, make_engine

    db_path = str(tmp_path / "pre_alembic.db")
    engine = make_engine(db_path)
    Base.metadata.create_all(engine)

    exit_code = main(["migrate", "--db-path", db_path])

    assert exit_code == 0
    captured = capsys.readouterr()
    assert "stamped as up to date" in captured.out


def test_migrate_command_reports_already_current(tmp_path, capsys):
    db_path = str(tmp_path / "current.db")

    main(["migrate", "--db-path", db_path])
    exit_code = main(["migrate", "--db-path", db_path])

    assert exit_code == 0
    captured = capsys.readouterr()
    assert "already up to date" in captured.out


def test_migrate_command_reports_upgraded(tmp_path, capsys, monkeypatch):
    from alembic import command
    from migration_helpers import build_isolated_two_revision_script_dir

    from tournament_server import migrations
    from tournament_server.db import make_engine
    from tournament_server.migrations import _make_alembic_config

    script_dir = build_isolated_two_revision_script_dir(tmp_path)
    monkeypatch.setattr(migrations, "_script_location", lambda: str(script_dir))

    db_path = str(tmp_path / "behind.db")
    make_engine(db_path)
    config = _make_alembic_config(db_path)
    command.upgrade(config, "rev1")

    exit_code = main(["migrate", "--db-path", db_path])

    assert exit_code == 0
    captured = capsys.readouterr()
    assert "pre-migration backup was created" in captured.out


def test_migrate_command_reports_a_clean_error_with_no_path_resolvable(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("TOURNAMENT_DB_PATH", raising=False)
    monkeypatch.setenv("TOURNAMENT_CONFIG_PATH", str(tmp_path / "server-config.json"))

    exit_code = main(["migrate"])

    assert exit_code == 1
    captured = capsys.readouterr()
    assert "ERROR" in captured.out


def test_migrate_command_works_in_a_fresh_process(tmp_path):
    """Regression test: a real `tm migrate` invocation has no prior
    import of tournament_server.models/audit, unlike every other test in
    this suite (conftest.py imports tournament_server.app at collection
    time, which populates Base.metadata as a side effect and would mask
    this bug). This test runs `tm migrate` in a genuinely fresh
    subprocess to prove it doesn't depend on that side effect.
    """
    from tournament_server.db import Base, make_engine

    db_path = str(tmp_path / "pre_alembic.db")
    engine = make_engine(db_path)
    Base.metadata.create_all(engine)

    result = subprocess.run(
        [sys.executable, "-m", "tournament_server.cli", "migrate", "--db-path", db_path],
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "stamped as up to date" in result.stdout
