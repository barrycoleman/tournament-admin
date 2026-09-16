from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class DirectoryListResponse(BaseModel):
    allowed_directories: list[str]


class AddDirectoryRequest(BaseModel):
    path: str


class TournamentFileEntry(BaseModel):
    filename: str
    path: str
    size_bytes: int
    modified_at: str


class TournamentListResponse(BaseModel):
    tournaments: list[TournamentFileEntry]


class CreateTournamentRequest(BaseModel):
    directory: str
    filename: str


class OpenTournamentRequest(BaseModel):
    path: str


class RestartingResponse(BaseModel):
    status: Literal["restarting"]
