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

BALANCED_SCHEDULER_PLUGIN = (
    Path(__file__).parent.parent / "plugins" / "schedulers" / "balanced"
)

COOPERATIVE_GAME_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "cooperative-game"
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

    balanced_target = plugins_root / "schedulers" / "balanced"
    balanced_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(BALANCED_SCHEDULER_PLUGIN, balanced_target)

    app = create_app(db_path=db_path, plugins_root=str(plugins_root))
    return TestClient(app)


@pytest.fixture()
def cooperative_client(tmp_path) -> TestClient:
    db_path = str(tmp_path / "test.db")
    plugins_root = tmp_path / "plugins"

    games_target = plugins_root / "games" / "cooperative-game"
    games_target.parent.mkdir(parents=True)
    shutil.copytree(COOPERATIVE_GAME_PLUGIN, games_target)

    schedulers_target = plugins_root / "schedulers" / "simple_random"
    schedulers_target.parent.mkdir(parents=True)
    shutil.copytree(SIMPLE_RANDOM_SCHEDULER_PLUGIN, schedulers_target)

    balanced_target = plugins_root / "schedulers" / "balanced"
    balanced_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(BALANCED_SCHEDULER_PLUGIN, balanced_target)

    app = create_app(db_path=db_path, plugins_root=str(plugins_root))
    return TestClient(app)
