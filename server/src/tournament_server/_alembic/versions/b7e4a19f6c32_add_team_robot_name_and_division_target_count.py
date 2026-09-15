"""add team robot_name, division target_team_count, team number uniqueness

Revision ID: b7e4a19f6c32
Revises: 9ee2761f45b6
Create Date: 2026-09-15 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7e4a19f6c32'
down_revision: Union[str, None] = '9ee2761f45b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Both new columns are nullable, so no server_default is needed --
    # SQLite allows ADD COLUMN with no default on a populated table as
    # long as it's nullable (unlike the NOT NULL case documented in the
    # previous migration).
    op.add_column('teams', sa.Column('robot_name', sa.String(length=200), nullable=True))
    op.add_column('divisions', sa.Column('target_team_count', sa.Integer(), nullable=True))
    # SQLite can't add a table constraint via a plain ALTER TABLE -- it
    # requires rebuilding the table, which batch_alter_table handles.
    # NOTE: this will fail on any pre-existing install that already has
    # two teams sharing a number within the same event -- matches this
    # project's established migration-safety posture (see server/CLAUDE.md's
    # "Known, deliberate gaps" section): the pre-migration backup
    # ensure_schema_current() takes is the recovery path, not an
    # automated dedup.
    with op.batch_alter_table('teams') as batch_op:
        batch_op.create_unique_constraint('uq_teams_event_number', ['event_id', 'number'])


def downgrade() -> None:
    with op.batch_alter_table('teams') as batch_op:
        batch_op.drop_constraint('uq_teams_event_number', type_='unique')
    op.drop_column('divisions', 'target_team_count')
    op.drop_column('teams', 'robot_name')
