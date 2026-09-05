import shutil
from pathlib import Path

from fastapi.testclient import TestClient

from auth_helpers import TEST_PASSWORD, bearer, login_as
from plugin_helpers import zip_fixture_plugin
from tournament_server.app import create_app

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)
FIXTURE_SECOND_GAME_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "second-game"
)


def test_list_game_plugins_shows_preseeded_plugin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.get("/api/plugins/games")
    assert response.status_code == 200
    assert len(response.json()) == 1
    assert response.json()[0]["name"] == "example-game"


def test_list_game_plugins_403s_for_non_admin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    scorer_token = login_as(raw, "scorer")

    response = raw.get("/api/plugins/games", headers=bearer(scorer_token))
    assert response.status_code == 403


def test_list_game_plugins_discovers_at_startup(tmp_path):
    plugins_root = tmp_path / "plugins"
    target = plugins_root / "games" / "example-game"
    target.parent.mkdir(parents=True)
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, target)

    app = create_app(
        db_path=str(tmp_path / "test.db"), plugins_root=str(plugins_root)
    )
    test_client = TestClient(app)
    test_client.post(
        "/api/event", json={"name": "Regional Qualifier", "password": TEST_PASSWORD}
    )
    token = login_as(test_client, "admin")

    response = test_client.get(
        "/api/plugins/games", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["name"] == "example-game"
    assert body[0]["version"] == "1.0.0"


def test_upload_game_plugin_installs_and_lists_immediately(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    zip_bytes = zip_fixture_plugin(FIXTURE_SECOND_GAME_PLUGIN)

    response = client.post(
        "/api/plugins/games",
        files={"file": ("second-game.zip", zip_bytes, "application/zip")},
    )
    assert response.status_code == 201
    assert response.json()["name"] == "second-game"

    listed = client.get("/api/plugins/games").json()
    names = {p["name"] for p in listed}
    assert "second-game" in names
    assert "example-game" in names  # the pre-seeded one is still there too


def test_upload_duplicate_plugin_name_returns_409(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    zip_bytes = zip_fixture_plugin(FIXTURE_EXAMPLE_PLUGIN)
    client.post(
        "/api/plugins/games",
        files={"file": ("example-game.zip", zip_bytes, "application/zip")},
    )

    response = client.post(
        "/api/plugins/games",
        files={"file": ("example-game.zip", zip_bytes, "application/zip")},
    )
    assert response.status_code == 409


def test_upload_malformed_zip_returns_422(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/plugins/games",
        files={"file": ("bad.zip", b"not a zip file", "application/zip")},
    )
    assert response.status_code == 422
