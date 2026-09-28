"""add schedule_generations time_blocks_json

Revision ID: a2c6f19e4d80
Revises: f3a91c6e5b7d
Create Date: 2026-09-28 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a2c6f19e4d80'
down_revision: Union[str, None] = 'f3a91c6e5b7d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable: pre-existing ScheduleGeneration rows have no stored blocks
    # to backfill from -- the new per-(session, division) overlap check
    # (a later phase of this same feature) simply has nothing to compare
    # against for those rows, which is correct: a schedule generated
    # before this column existed never went through block-based
    # cross-generation validation in the first place.
    op.add_column(
        'schedule_generations', sa.Column('time_blocks_json', sa.Text(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column('schedule_generations', 'time_blocks_json')
