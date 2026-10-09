"""per-team DQ and no-show: score_record_teams replaces score_records.no_show/dq

Revision ID: e9c3f7a1b5d2
Revises: a7d5e2c8f1b4
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'e9c3f7a1b5d2'
down_revision: Union[str, None] = 'a7d5e2c8f1b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    # Read the flags first: the batch rebuild below must run before
    # score_record_teams (ON DELETE CASCADE) holds any rows.
    flagged = bind.execute(
        sa.text(
            "SELECT DISTINCT sr.id, at.team_id, sr.no_show, sr.dq FROM score_records sr "
            "JOIN alliance_teams at ON at.alliance_id = sr.alliance_id "
            "WHERE sr.no_show OR sr.dq ORDER BY sr.id, at.team_id"
        )
    ).all()
    with op.batch_alter_table('score_records') as batch_op:
        batch_op.drop_column('no_show')
        batch_op.drop_column('dq')
    score_record_teams = op.create_table(
        'score_record_teams',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('score_record_id', sa.Integer(), nullable=False),
        sa.Column('team_id', sa.Integer(), nullable=False),
        sa.Column('no_show', sa.Boolean(), nullable=False),
        sa.Column('dq', sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(['score_record_id'], ['score_records.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['team_id'], ['teams.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('score_record_id', 'team_id', name='uq_score_record_team'),
    )
    if flagged:
        op.bulk_insert(
            score_record_teams,
            [
                {"score_record_id": row[0], "team_id": row[1], "no_show": bool(row[2]), "dq": bool(row[3])}
                for row in flagged
            ],
        )


def downgrade() -> None:
    op.add_column(
        'score_records',
        sa.Column('no_show', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        'score_records',
        sa.Column('dq', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.execute(
        "UPDATE score_records SET no_show = 1 WHERE id IN "
        "(SELECT score_record_id FROM score_record_teams WHERE no_show)"
    )
    op.execute(
        "UPDATE score_records SET dq = 1 WHERE id IN "
        "(SELECT score_record_id FROM score_record_teams WHERE dq)"
    )
    op.drop_table('score_record_teams')
