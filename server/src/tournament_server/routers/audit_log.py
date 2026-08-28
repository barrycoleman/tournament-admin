from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.audit import AuditLog
from tournament_server.deps import get_db
from tournament_server.schemas.audit import AuditLogRead

router = APIRouter(prefix="/api/audit-log", tags=["audit-log"])


@router.get("", response_model=list[AuditLogRead])
def list_audit_log(db: Session = Depends(get_db)) -> list[AuditLogRead]:
    rows = db.execute(select(AuditLog).order_by(AuditLog.id)).scalars().all()
    return [AuditLogRead.from_orm_obj(row) for row in rows]
