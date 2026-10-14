from pathlib import Path

from fastapi.testclient import TestClient

from tournament_server.app import create_app


def _make_static_dir(tmp_path: Path) -> Path:
    static_dir = tmp_path / "dist"
    (static_dir / "assets").mkdir(parents=True)
    (static_dir / "index.html").write_text("<html>admin ui</html>")
    (static_dir / "assets" / "app.js").write_text("console.log('app');")
    return static_dir


def test_serves_index_html_at_root(tmp_path):
    static_dir = _make_static_dir(tmp_path)
    app = create_app(
        db_path=str(tmp_path / "test.db"),
        plugins_root=str(tmp_path / "plugins"),
        static_dir=str(static_dir),
    )
    with TestClient(app) as client:
        response = client.get("/")
    assert response.status_code == 200
    assert "admin ui" in response.text


def test_serves_index_html_for_a_client_side_route(tmp_path):
    static_dir = _make_static_dir(tmp_path)
    app = create_app(
        db_path=str(tmp_path / "test.db"),
        plugins_root=str(tmp_path / "plugins"),
        static_dir=str(static_dir),
    )
    with TestClient(app) as client:
        response = client.get("/events/new")
    assert response.status_code == 200
    assert "admin ui" in response.text


def test_serves_static_assets(tmp_path):
    static_dir = _make_static_dir(tmp_path)
    app = create_app(
        db_path=str(tmp_path / "test.db"),
        plugins_root=str(tmp_path / "plugins"),
        static_dir=str(static_dir),
    )
    with TestClient(app) as client:
        response = client.get("/assets/app.js")
    assert response.status_code == 200
    assert "console.log" in response.text


def test_unknown_api_path_still_404s_instead_of_serving_index_html(tmp_path):
    static_dir = _make_static_dir(tmp_path)
    app = create_app(
        db_path=str(tmp_path / "test.db"),
        plugins_root=str(tmp_path / "plugins"),
        static_dir=str(static_dir),
    )
    with TestClient(app) as client:
        response = client.get("/api/this-route-does-not-exist")
    assert response.status_code == 404
    assert "admin ui" not in response.text


def test_health_still_works_with_static_dir(tmp_path):
    # The SPA catch-all route must stay registered *after* /health, or it
    # would shadow it and swallow the health check.
    static_dir = _make_static_dir(tmp_path)
    app = create_app(
        db_path=str(tmp_path / "test.db"),
        plugins_root=str(tmp_path / "plugins"),
        static_dir=str(static_dir),
    )
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_static_dir_without_assets_subdir_still_starts(tmp_path):
    # A partial/custom build may ship dist/index.html with no assets/;
    # mounting StaticFiles on it would raise and crash startup.
    static_dir = tmp_path / "dist"
    static_dir.mkdir()
    (static_dir / "index.html").write_text("<html>admin ui</html>")
    app = create_app(
        db_path=str(tmp_path / "test.db"),
        plugins_root=str(tmp_path / "plugins"),
        static_dir=str(static_dir),
    )
    with TestClient(app) as client:
        health = client.get("/health")
        root = client.get("/")
    assert health.status_code == 200
    assert root.status_code == 200
    assert "admin ui" in root.text


def test_missing_static_dir_leaves_the_app_working(tmp_path):
    app = create_app(
        db_path=str(tmp_path / "test.db"),
        plugins_root=str(tmp_path / "plugins"),
        static_dir=str(tmp_path / "does-not-exist"),
    )
    with TestClient(app) as client:
        health = client.get("/health")
        root = client.get("/")
    assert health.status_code == 200
    assert root.status_code == 404


def _device_dist(tmp_path):
    dist = tmp_path / "device-dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>device app</html>")
    (dist / "assets" / "app.js").write_text("console.log('device')")
    return dist


def _admin_dist(tmp_path):
    dist = tmp_path / "admin-dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>admin app</html>")
    return dist


def _device_app(tmp_path, device=True):
    return create_app(
        db_path=str(tmp_path / "e.db"),
        plugins_root=str(tmp_path / "plugins"),
        static_dir=str(_admin_dist(tmp_path)),
        device_static_dir=str(_device_dist(tmp_path)) if device else str(tmp_path / "missing"),
        config_path=tmp_path / "server-config.json",
    )


def test_pair_redirects_to_the_device_app(tmp_path):
    client = TestClient(_device_app(tmp_path))
    response = client.get("/pair", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "/device/"


def test_device_routes_serve_the_device_app_and_fall_back_to_its_index(tmp_path):
    client = TestClient(_device_app(tmp_path))
    assert "device app" in client.get("/device/").text
    assert "device app" in client.get("/device/anything/deep").text
    assert "console.log('device')" in client.get("/device/assets/app.js").text


def test_the_admin_fallback_is_unchanged(tmp_path):
    client = TestClient(_device_app(tmp_path))
    assert "admin app" in client.get("/devices").text
    assert "admin app" in client.get("/teams").text


def test_without_a_device_build_device_paths_are_404_not_the_admin_app(tmp_path):
    client = TestClient(_device_app(tmp_path, device=False))
    assert client.get("/device/").status_code == 404
    assert client.get("/device").status_code == 404
    assert client.get("/pair", follow_redirects=False).status_code == 307
