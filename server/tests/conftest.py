from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tournament_server.app import create_app


@pytest.fixture()
def client(tmp_path) -> TestClient:
    db_path = str(tmp_path / "test.db")
    plugins_root = str(tmp_path / "plugins")
    app = create_app(db_path=db_path, plugins_root=plugins_root)
    return TestClient(app)
