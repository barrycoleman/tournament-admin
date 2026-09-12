from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from auth_helpers import TEST_PASSWORD
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

CAPTAIN_PICK_GAME_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "captain-pick-game"
)


class _AutoAuthTestClient(TestClient):
    def request(self, method, url, *args, **kwargs):
        if method.upper() == "POST" and url == "/api/event":
            json_body = kwargs.get("json")
            if json_body is not None and "password" not in json_body:
                kwargs["json"] = {**json_body, "password": TEST_PASSWORD}
            response = super().request(method, url, *args, **kwargs)
            if response.status_code == 201:
                login = super().request(
                    "POST",
                    "/api/auth/login",
                    json={"role": "admin", "password": TEST_PASSWORD},
                )
                token = login.json()["access_token"]
                self.headers["Authorization"] = f"Bearer {token}"
            return response
        return super().request(method, url, *args, **kwargs)


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
    with _AutoAuthTestClient(app) as test_client:
        yield test_client


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
    with _AutoAuthTestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def captain_pick_client(tmp_path) -> TestClient:
    db_path = str(tmp_path / "test.db")
    plugins_root = tmp_path / "plugins"

    games_target = plugins_root / "games" / "captain-pick-game"
    games_target.parent.mkdir(parents=True)
    shutil.copytree(CAPTAIN_PICK_GAME_PLUGIN, games_target)

    schedulers_target = plugins_root / "schedulers" / "simple_random"
    schedulers_target.parent.mkdir(parents=True)
    shutil.copytree(SIMPLE_RANDOM_SCHEDULER_PLUGIN, schedulers_target)

    balanced_target = plugins_root / "schedulers" / "balanced"
    balanced_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(BALANCED_SCHEDULER_PLUGIN, balanced_target)

    app = create_app(db_path=db_path, plugins_root=str(plugins_root))
    with _AutoAuthTestClient(app) as test_client:
        yield test_client
