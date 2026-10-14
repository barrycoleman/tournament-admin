from __future__ import annotations

from fastapi import Depends, HTTPException

from tournament_server.auth import Caller, get_caller
from tournament_server.services.devices import SCORING_ROLES


def require_paired_scoring_device(caller: Caller = Depends(get_caller)) -> str | None:
    """Scores and skills attempts come from a paired scorer or referee device,
    or from an admin (who needs no device). Returns the device's name for
    attribution, or None for an admin."""
    if caller.role == "admin":
        return None
    if caller.role not in SCORING_ROLES:
        raise HTTPException(status_code=403, detail="This role cannot perform this operation")
    if caller.device_id is None:
        raise HTTPException(status_code=403, detail="Only a paired device can submit scores.")
    return caller.device_name
