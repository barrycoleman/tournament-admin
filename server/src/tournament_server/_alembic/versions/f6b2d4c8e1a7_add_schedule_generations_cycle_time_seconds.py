"""add schedule_generations cycle_time_seconds

Revision ID: f6b2d4c8e1a7
Revises: e5a1c3b9d2f4
Create Date: 2026-10-03 13:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f6b2d4c8e1a7'
down_revision: Union[str, None] = 'e5a1c3b9d2f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable: earlier generations used per-block cycle times, so there is
    # no single value to backfill. The Schedule tab falls back to a default.
    op.add_column(
        'schedule_generations', sa.Column('cycle_time_seconds', sa.Integer(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column('schedule_generations', 'cycle_time_seconds')
