from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as


def _two_sessions(client) -> tuple[int, int]:
    client.post("/api/event", json={"name": "Regional Qualifier"})
    source = client.post("/api/sessions", json={"label": "Saturday"}).json()["id"]
    target = client.post("/api/sessions", json={"label": "Sunday"}).json()["id"]
    return source, target


def _layout(client, session_id: int) -> list[tuple[str, int | None, list[str]]]:
    field_sets = client.get("/api/field-sets", params={"session_id": session_id}).json()
    fields = client.get("/api/fields", params={"session_id": session_id}).json()
    return sorted(
        (
            fs["name"],
            fs["division_id"],
            sorted(f["name"] for f in fields if f["field_set_id"] == fs["id"]),
        )
        for fs in field_sets
    )


def test_copy_fields_recreates_sets_fields_and_divisions(client):
    source, target = _two_sessions(client)
    division_id = client.get("/api/divisions").json()[0]["id"]
    red = client.post(
        "/api/field-sets", json={"session_id": source, "name": "Red", "division_id": division_id}
    ).json()["id"]
    blue = client.post("/api/field-sets", json={"session_id": source, "name": "Blue"}).json()["id"]
    for name, set_id in (("Field 1", red), ("Field 2", red), ("Field 3", blue)):
        client.post("/api/fields", json={"session_id": source, "name": name, "field_set_id": set_id})

    response = client.post(
        f"/api/sessions/{target}/copy-fields", json={"source_session_id": source}
    )

    assert response.status_code == 201, response.text
    assert sorted(fs["name"] for fs in response.json()) == ["Blue", "Red"]
    assert all(fs["session_id"] == target for fs in response.json())
    assert _layout(client, target) == [
        ("Blue", None, ["Field 3"]),
        ("Red", division_id, ["Field 1", "Field 2"]),
    ]
    # The source keeps its own, distinct rows.
    assert _layout(client, source) == _layout(client, target)
    source_ids = {fs["id"] for fs in client.get("/api/field-sets", params={"session_id": source}).json()}
    assert source_ids.isdisjoint(fs["id"] for fs in response.json())


def test_copy_fields_refuses_a_session_that_already_has_fields(client):
    source, target = _two_sessions(client)
    client.post("/api/fields", json={"session_id": source, "name": "Field 1"})
    client.post("/api/fields", json={"session_id": target, "name": "Existing"})

    response = client.post(
        f"/api/sessions/{target}/copy-fields", json={"source_session_id": source}
    )

    assert response.status_code == 409
    assert _layout(client, target) == [("Main Fields", None, ["Existing"])]


def test_copy_fields_from_a_session_without_fields_is_422(client):
    source, target = _two_sessions(client)
    response = client.post(
        f"/api/sessions/{target}/copy-fields", json={"source_session_id": source}
    )
    assert response.status_code == 422


def test_copy_fields_from_itself_is_422(client):
    source, _ = _two_sessions(client)
    client.post("/api/fields", json={"session_id": source, "name": "Field 1"})
    response = client.post(
        f"/api/sessions/{source}/copy-fields", json={"source_session_id": source}
    )
    assert response.status_code == 422


def test_copy_fields_unknown_sessions_are_404(client):
    source, target = _two_sessions(client)
    assert client.post(
        "/api/sessions/999/copy-fields", json={"source_session_id": source}
    ).status_code == 404
    assert client.post(
        f"/api/sessions/{target}/copy-fields", json={"source_session_id": 999}
    ).status_code == 404


def test_copy_fields_is_admin_only(client):
    source, target = _two_sessions(client)
    client.post("/api/fields", json={"session_id": source, "name": "Field 1"})
    raw = TestClient(client.app)
    token = login_as(raw, "scorer")

    response = raw.post(
        f"/api/sessions/{target}/copy-fields",
        json={"source_session_id": source},
        headers=bearer(token),
    )

    assert response.status_code == 403
