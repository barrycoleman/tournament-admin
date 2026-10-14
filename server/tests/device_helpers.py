from __future__ import annotations

from fastapi.testclient import TestClient


def paired_device(admin_client, role: str = "scorer", name: str | None = None) -> dict:
    """Pairs a new device as `admin_client` (an admin) and signs it in.
    Returns its id, name, device token, access token and ready-made headers."""
    raw = TestClient(admin_client.app)
    pending = raw.post("/api/pairing").json()
    body = {"code": pending["code"], "role": role}
    body["name"] = name if name is not None else f"{role}-{pending['code']}"
    paired = admin_client.post("/api/devices/pair", json=body)
    assert paired.status_code == 201, paired.text
    polled = raw.get(f"/api/pairing/{pending['id']}", headers={"X-Pairing-Key": pending["poll_key"]}).json()
    assert polled["status"] == "paired"
    signed_in = raw.post("/api/auth/device", json={"device_token": polled["device_token"]})
    assert signed_in.status_code == 200, signed_in.text
    access = signed_in.json()["access_token"]
    return {
        "id": paired.json()["id"],
        "name": paired.json()["name"],
        "device_token": polled["device_token"],
        "access_token": access,
        "headers": {"Authorization": f"Bearer {access}"},
    }
