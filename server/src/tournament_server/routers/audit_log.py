from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.audit import AuditLog
from tournament_server.deps import get_db
from tournament_server.schemas.audit import AuditLogRead

router = APIRouter(prefix="/api/audit-log", tags=["audit-log"])


@router.get("", response_model=list[AuditLogRead])
def list_audit_log(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
) -> list[AuditLogRead]:
    rows = (
        db.execute(
            select(AuditLog).order_by(AuditLog.id).limit(limit).offset(offset)
        )
        .scalars()
        .all()
    )
    return [AuditLogRead.from_orm_obj(row) for row in rows]
