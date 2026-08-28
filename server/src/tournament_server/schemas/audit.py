from __future__ import annotations

import datetime as dt
import json
from typing import Any

from pydantic import BaseModel

from tournament_server.audit import AuditLog


class AuditLogRead(BaseModel):
    id: int
    timestamp: dt.datetime
    table_name: str
    row_pk: int | None
    action: str
    actor: str
    before: dict[str, Any] | None
    after: dict[str, Any] | None

    @classmethod
    def from_orm_obj(cls, obj: AuditLog) -> "AuditLogRead":
        return cls(
            id=obj.id,
            timestamp=obj.timestamp,
            table_name=obj.table_name,
            row_pk=obj.row_pk,
            action=obj.action,
            actor=obj.actor,
            before=json.loads(obj.before_json) if obj.before_json else None,
            after=json.loads(obj.after_json) if obj.after_json else None,
        )
