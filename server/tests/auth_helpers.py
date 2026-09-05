from __future__ import annotations

from fastapi.testclient import TestClient

TEST_PASSWORD = "test-password"


def login_as(raw_client: TestClient, role: str, password: str = TEST_PASSWORD) -> str:
    response = raw_client.post(
        "/api/auth/login", json={"role": role, "password": password}
    )
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
