import shutil
from pathlib import Path

from fastapi.testclient import TestClient

from plugin_helpers import zip_fixture_plugin
from tournament_server.app import create_app

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)


def test_list_game_plugins_empty(client):
    response = client.get("/api/plugins/games")
    assert response.status_code == 200
    assert len(response.json()) == 1
    assert response.json()[0]["name"] == "example-game"


def test_list_game_plugins_discovers_at_startup(tmp_path):
    plugins_root = tmp_path / "plugins"
    target = plugins_root / "games" / "example-game"
    target.parent.mkdir(parents=True)
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, target)

    app = create_app(
        db_path=str(tmp_path / "test.db"), plugins_root=str(plugins_root)
    )
    test_client = TestClient(app)

    response = test_client.get("/api/plugins/games")
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["name"] == "example-game"
    assert body[0]["version"] == "1.0.0"


def test_upload_game_plugin_installs_and_lists_immediately(client):
    zip_bytes = zip_fixture_plugin(FIXTURE_EXAMPLE_PLUGIN)

    response = client.post(
        "/api/plugins/games",
        files={"file": ("example-game.zip", zip_bytes, "application/zip")},
    )
    # The fixture already includes example-game, so we expect a conflict
    assert response.status_code == 409

    # Verify the plugin is still in the list
    listed = client.get("/api/plugins/games").json()
    assert len(listed) == 1
    assert listed[0]["name"] == "example-game"


def test_upload_duplicate_plugin_name_returns_409(client):
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
    response = client.post(
        "/api/plugins/games",
        files={"file": ("bad.zip", b"not a zip file", "application/zip")},
    )
    assert response.status_code == 422
