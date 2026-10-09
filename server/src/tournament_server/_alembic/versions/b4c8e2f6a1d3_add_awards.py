"""add awards: awards, award_winners, sessions.awards_finalized_at

Revision ID: b4c8e2f6a1d3
Revises: e9c3f7a1b5d2
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import tournament_server.db

revision: str = 'b4c8e2f6a1d3'
down_revision: Union[str, None] = 'e9c3f7a1b5d2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'awards',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('session_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('description', sa.String(length=2000), nullable=True),
        sa.Column('position', sa.Integer(), nullable=False),
        sa.Column('scope', sa.String(length=20), nullable=False),
        sa.Column('division_ids', sa.JSON(), nullable=False),
        sa.Column('kind', sa.String(length=20), nullable=False),
        sa.Column('source', sa.String(length=30), nullable=True),
        sa.Column('skills_type', sa.String(length=50), nullable=True),
        sa.Column('basis', sa.String(length=20), nullable=True),
        sa.Column('placement', sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_table(
        'award_winners',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('award_id', sa.Integer(), nullable=False),
        sa.Column('division_id', sa.Integer(), nullable=True),
        sa.Column('team_id', sa.Integer(), nullable=False),
        sa.Column('origin', sa.String(length=20), nullable=False),
        sa.Column('override_reason', sa.String(length=500), nullable=True),
        sa.Column('presented', sa.Boolean(), nullable=False),
        sa.Column('recorded_at', tournament_server.db.UTCDateTime(), nullable=False),
        sa.Column('recorded_by', sa.String(length=200), nullable=False),
        sa.ForeignKeyConstraint(['award_id'], ['awards.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['division_id'], ['divisions.id'], ),
        sa.ForeignKeyConstraint(['team_id'], ['teams.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('award_id', 'division_id', 'team_id', name='uq_award_winner'),
    )
    with op.batch_alter_table('sessions') as batch_op:
        batch_op.add_column(sa.Column('awards_finalized_at', tournament_server.db.UTCDateTime(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('sessions') as batch_op:
        batch_op.drop_column('awards_finalized_at')
    op.drop_table('award_winners')
    op.drop_table('awards')
