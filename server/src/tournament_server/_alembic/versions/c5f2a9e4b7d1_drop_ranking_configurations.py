"""drop ranking_configurations (replaced by ranking_settings)

Revision ID: c5f2a9e4b7d1
Revises: b3e8d1f0a6c2
Create Date: 2026-10-06 12:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c5f2a9e4b7d1'
down_revision: Union[str, None] = 'b3e8d1f0a6c2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_table('ranking_configurations')


def downgrade() -> None:
    op.create_table('ranking_configurations',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('event_id', sa.Integer(), nullable=False),
    sa.Column('division_id', sa.Integer(), nullable=True),
    sa.Column('mode', sa.String(length=20), nullable=False),
    sa.Column('count', sa.Integer(), nullable=False),
    sa.Column('allow_drop_no_show', sa.Boolean(), nullable=False),
    sa.Column('allow_drop_dq', sa.Boolean(), nullable=False),
    sa.ForeignKeyConstraint(['division_id'], ['divisions.id'], ),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('event_id', 'division_id', name='uq_ranking_config_event_division')
    )
