from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tournament_server.app import create_app

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)

SIMPLE_RANDOM_SCHEDULER_PLUGIN = (
    Path(__file__).parent.parent / "plugins" / "schedulers" / "simple_random"
)


@pytest.fixture()
def client(tmp_path) -> TestClient:
    db_path = str(tmp_path / "test.db")
    plugins_root = tmp_path / "plugins"

    games_target = plugins_root / "games" / "example-game"
    games_target.parent.mkdir(parents=True)
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, games_target)

    schedulers_target = plugins_root / "schedulers" / "simple_random"
    schedulers_target.parent.mkdir(parents=True)
    shutil.copytree(SIMPLE_RANDOM_SCHEDULER_PLUGIN, schedulers_target)

    app = create_app(db_path=db_path, plugins_root=str(plugins_root))
    return TestClient(app)
