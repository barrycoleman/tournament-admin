"""add skills challenges: skills_settings, skills_attempts, sessions.skills_attempts, score_records.mirrored

Revision ID: a7d5e2c8f1b4
Revises: d8e4b2a6c9f3
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import tournament_server.db

revision: str = 'a7d5e2c8f1b4'
down_revision: Union[str, None] = 'd8e4b2a6c9f3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'skills_settings',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('event_id', sa.Integer(), nullable=False),
        sa.Column('enabled', sa.Boolean(), nullable=False),
        sa.Column('attempts', sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(['event_id'], ['events.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('event_id', name='uq_skills_settings_event'),
    )
    op.create_table(
        'skills_attempts',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('session_id', sa.Integer(), nullable=False),
        sa.Column('team_id', sa.Integer(), nullable=False),
        sa.Column('skills_type', sa.String(length=50), nullable=False),
        sa.Column('data_json', sa.Text(), nullable=False),
        sa.Column('score', sa.Integer(), nullable=False),
        sa.Column('plugin_name', sa.String(length=200), nullable=False),
        sa.Column('plugin_version', sa.String(length=50), nullable=False),
        sa.Column('recorded_at', tournament_server.db.UTCDateTime(), nullable=False),
        sa.Column('updated_at', tournament_server.db.UTCDateTime(), nullable=False),
        sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ),
        sa.ForeignKeyConstraint(['team_id'], ['teams.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_skills_attempts_session_team_type',
        'skills_attempts',
        ['session_id', 'team_id', 'skills_type'],
        unique=False,
    )
    op.add_column('sessions', sa.Column('skills_attempts', sa.JSON(), nullable=True))
    # NOT NULL on a table that may already have rows needs a server_default
    # so existing score records read as not mirrored.
    op.add_column(
        'score_records',
        sa.Column('mirrored', sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    with op.batch_alter_table('score_records') as batch_op:
        batch_op.drop_column('mirrored')
    op.drop_column('sessions', 'skills_attempts')
    op.drop_index('ix_skills_attempts_session_team_type', table_name='skills_attempts')
    op.drop_table('skills_attempts')
    op.drop_table('skills_settings')
