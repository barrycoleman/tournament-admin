from __future__ import annotations

import datetime as dt

from pydantic import BaseModel


class BackupEntryRead(BaseModel):
    filename: str
    created_at: dt.datetime
    reason: str
    size_bytes: int


class BackupErrorRead(BaseModel):
    message: str
    at: dt.datetime


class BackupsRead(BaseModel):
    folder: str
    folder_is_default: bool
    last_backup_at: dt.datetime | None
    last_error: BackupErrorRead | None
    backups: list[BackupEntryRead]


class BackupFolderUpdate(BaseModel):
    folder: str | None
