"""add session qualification finalize columns

Revision ID: d8e4b2a6c9f3
Revises: c5f2a9e4b7d1
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import tournament_server.db

revision: str = 'd8e4b2a6c9f3'
down_revision: Union[str, None] = 'c5f2a9e4b7d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('sessions', sa.Column('qualification_finalized_at', tournament_server.db.UTCDateTime(), nullable=True))
    op.add_column('sessions', sa.Column('qualification_drops', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('sessions', 'qualification_drops')
    op.drop_column('sessions', 'qualification_finalized_at')
