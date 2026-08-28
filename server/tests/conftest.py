from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tournament_server.app import create_app


@pytest.fixture()
def client(tmp_path) -> TestClient:
    db_path = str(tmp_path / "test.db")
    app = create_app(db_path=db_path)
    return TestClient(app)
