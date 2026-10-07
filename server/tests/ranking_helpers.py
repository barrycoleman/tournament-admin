DEFAULT_SETTINGS = {
    "session_drop_mode": "tiered",
    "session_drop_count": 1,
    "session_drop_no_show": False,
    "session_drop_dq": False,
    "season_keep_best": None,
    "season_only_session_counted": False,
    "season_minimum": 0,
    "season_drop_no_show": False,
    "season_drop_dq": False,
}


def finalize_qualification(client, session_id: int) -> dict:
    """Finalize a session's qualification with the suggested drops (tests that start finals need this)."""
    preview = client.get(f"/api/sessions/{session_id}/qualification/finalize-preview").json()
    drops = {str(row["played"]): row["suggested"] for row in preview["rows"]}
    response = client.post(f"/api/sessions/{session_id}/qualification/finalize", json={"drops": drops})
    assert response.status_code == 200, response.text
    return response.json()
