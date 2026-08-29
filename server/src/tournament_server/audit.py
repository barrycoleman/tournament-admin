from __future__ import annotations

import contextlib
import contextvars
import datetime as dt
import json
from typing import Any

from sqlalchemy import Integer, String, Text, event, insert
from sqlalchemy.orm import Mapped, Mapper, mapped_column
from sqlalchemy.orm.attributes import get_history

from tournament_server.db import Base, UTCDateTime, utc_now

current_actor: contextvars.ContextVar[str] = contextvars.ContextVar(
    "current_actor", default="system"
)


@contextlib.contextmanager
def actor_scope(name: str):
    token = current_actor.set(name)
    try:
        yield
    finally:
        current_actor.reset(token)


# Guards against ever recursively auditing the audit table itself. In
# practice audit rows are only ever written via the raw `connection.execute`
# calls below (never through `session.add(AuditLog(...))`), so this can't
# currently trigger — it's cheap insurance against a future change that
# adds an ORM-level write to this table.
_EXCLUDED_TABLES = {"audit_log"}


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    timestamp: Mapped[dt.datetime] = mapped_column(
        UTCDateTime, default=utc_now
    )
    table_name: Mapped[str] = mapped_column(String(100))
    row_pk: Mapped[int | None] = mapped_column(Integer, default=None)
    action: Mapped[str] = mapped_column(String(20))
    actor: Mapped[str] = mapped_column(String(200))
    before_json: Mapped[str | None] = mapped_column(Text, default=None)
    after_json: Mapped[str | None] = mapped_column(Text, default=None)


def _to_jsonable(value: Any) -> Any:
    if isinstance(value, (dt.datetime, dt.date)):
        return value.isoformat()
    return value


def _serialize_all_columns(target: Any, mapper: Mapper) -> dict[str, Any]:
    return {
        col.key: _to_jsonable(getattr(target, col.key)) for col in mapper.columns
    }


def _write_audit_row(
    connection: Any,
    table_name: str,
    row_pk: int | None,
    action: str,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
) -> None:
    connection.execute(
        insert(AuditLog.__table__).values(
            timestamp=utc_now(),
            table_name=table_name,
            row_pk=row_pk,
            action=action,
            actor=current_actor.get(),
            before_json=json.dumps(before, default=str) if before is not None else None,
            after_json=json.dumps(after, default=str) if after is not None else None,
        )
    )


def _after_insert(mapper: Mapper, connection: Any, target: Any) -> None:
    if mapper.local_table.name in _EXCLUDED_TABLES:
        return
    pk = mapper.primary_key_from_instance(target)[0]
    after = _serialize_all_columns(target, mapper)
    _write_audit_row(connection, mapper.local_table.name, pk, "insert", None, after)


def _after_update(mapper: Mapper, connection: Any, target: Any) -> None:
    if mapper.local_table.name in _EXCLUDED_TABLES:
        return
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    for col in mapper.columns:
        history = get_history(target, col.key)
        if not history.has_changes():
            continue
        if history.deleted:
            before[col.key] = _to_jsonable(history.deleted[0])
        if history.added:
            after[col.key] = _to_jsonable(history.added[0])
    if not before and not after:
        return
    pk = mapper.primary_key_from_instance(target)[0]
    _write_audit_row(connection, mapper.local_table.name, pk, "update", before, after)


def _after_delete(mapper: Mapper, connection: Any, target: Any) -> None:
    if mapper.local_table.name in _EXCLUDED_TABLES:
        return
    pk = mapper.primary_key_from_instance(target)[0]
    before = _serialize_all_columns(target, mapper)
    _write_audit_row(connection, mapper.local_table.name, pk, "delete", before, None)


def register_audit_hooks() -> None:
    event.listen(Base, "after_insert", _after_insert, propagate=True)
    event.listen(Base, "after_update", _after_update, propagate=True)
    event.listen(Base, "after_delete", _after_delete, propagate=True)


register_audit_hooks()
