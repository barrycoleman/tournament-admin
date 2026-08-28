def test_create_and_list_divisions(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post("/api/divisions", json={"name": "Elementary"})
    assert response.status_code == 201
    division_id = response.json()["id"]

    list_response = client.get("/api/divisions")
    assert list_response.status_code == 200
    assert list_response.json()[0]["id"] == division_id
    assert list_response.json()[0]["name"] == "Elementary"


def test_create_division_requires_event(client):
    response = client.post("/api/divisions", json={"name": "Elementary"})
    assert response.status_code == 404
