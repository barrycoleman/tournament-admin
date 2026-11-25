from __future__ import annotations


def pick_partners(client, bracket: dict, headers: dict | None = None):
    """Forms every alliance of a partner-picking bracket through invite and
    accept, and returns the last accept's response.

    Each captain invites the team `alliances_target` places below the first
    captain still to pick (with 4 alliances from 8 teams: 1+5, 2+6, 3+7,
    4+8), the same pairs the old strict captain-order picking produced, so
    tests written against those seeds keep their meaning."""
    bracket_id = bracket["id"]
    body = bracket
    response = None
    while body["status"] == "selecting_alliances":
        selection = body["selection"]
        index = selection["alliances_target"] - selection["alliances_formed"] - 1
        partner = selection["invitable_team_ids"][index]
        invited = client.post(
            f"/api/finals/{bracket_id}/selection/invite",
            json={"team_id": partner},
            headers=headers,
        )
        assert invited.status_code == 200, invited.text
        response = client.post(
            f"/api/finals/{bracket_id}/selection/accept",
            json={"team_id": partner},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        body = response.json()
    return response
