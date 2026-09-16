from tournament_server.picker_app import create_picker_app
from fastapi.testclient import TestClient


def test_health_endpoint(tmp_path):
    app = create_picker_app(tmp_path / "server-config.json")
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_picker_routes_are_mounted(tmp_path):
    app = create_picker_app(tmp_path / "server-config.json")
    with TestClient(app) as client:
        response = client.get("/api/picker/directories")
    assert response.status_code == 200
    assert response.json() == {"allowed_directories": []}


def test_serves_the_admin_static_build(tmp_path):
    static_dir = tmp_path / "dist"
    static_dir.mkdir()
    (static_dir / "index.html").write_text("<html>admin ui</html>")

    app = create_picker_app(tmp_path / "server-config.json", static_dir=str(static_dir))
    with TestClient(app) as client:
        response = client.get("/")

    assert response.status_code == 200
    assert "admin ui" in response.text


def test_switch_router_is_not_mounted_on_the_picker_app(tmp_path):
    app = create_picker_app(tmp_path / "server-config.json")
    with TestClient(app) as client:
        response = client.post("/api/picker/switch")
    assert response.status_code == 404
