"""add bracket_matchups matchup_number

Revision ID: c9d34b7a1f02
Revises: a2c6f19e4d80
Create Date: 2026-09-28 09:05:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c9d34b7a1f02'
down_revision: Union[str, None] = 'a2c6f19e4d80'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable: an already-decided finals bracket from before this column
    # existed has no retroactive numbering need, since it's already
    # complete.
    op.add_column(
        'bracket_matchups', sa.Column('matchup_number', sa.Integer(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column('bracket_matchups', 'matchup_number')
