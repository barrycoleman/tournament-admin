def test_set_and_get_ranking_configuration(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post(
        "/api/ranking-configuration",
        json={"mode": "exclude", "count": 1},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["mode"] == "exclude"
    assert body["count"] == 1
    assert body["division_id"] is None

    get_response = client.get("/api/ranking-configuration")
    assert get_response.status_code == 200
    assert get_response.json()["count"] == 1


def test_get_ranking_configuration_404_when_unset(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.get("/api/ranking-configuration")
    assert response.status_code == 404


def test_set_ranking_configuration_rejects_invalid_mode(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/ranking-configuration",
        json={"mode": "not-a-real-mode", "count": 1},
    )
    assert response.status_code == 422


def test_set_ranking_configuration_upserts(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/ranking-configuration", json={"mode": "exclude", "count": 1})
    response = client.post(
        "/api/ranking-configuration", json={"mode": "include", "count": 5}
    )
    assert response.status_code == 201
    assert response.json()["mode"] == "include"
    assert response.json()["count"] == 5

    listed = client.get("/api/ranking-configuration").json()
    assert listed["mode"] == "include"
    assert listed["count"] == 5
