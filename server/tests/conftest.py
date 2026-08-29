from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tournament_server.app import create_app

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)


@pytest.fixture()
def client(tmp_path) -> TestClient:
    db_path = str(tmp_path / "test.db")
    plugins_root = tmp_path / "plugins"
    target = plugins_root / "games" / "example-game"
    target.parent.mkdir(parents=True)
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, target)

    app = create_app(db_path=db_path, plugins_root=str(plugins_root))
    return TestClient(app)
