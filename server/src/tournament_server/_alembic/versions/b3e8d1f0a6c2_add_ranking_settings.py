"""add ranking_settings, converted from ranking_configurations

Revision ID: b3e8d1f0a6c2
Revises: f6b2d4c8e1a7
Create Date: 2026-10-06 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b3e8d1f0a6c2'
down_revision: Union[str, None] = 'f6b2d4c8e1a7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'ranking_settings',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('event_id', sa.Integer(), nullable=False),
        sa.Column('session_drop_mode', sa.String(length=20), nullable=False),
        sa.Column('session_drop_count', sa.Integer(), nullable=False),
        sa.Column('session_drop_no_show', sa.Boolean(), nullable=False),
        sa.Column('session_drop_dq', sa.Boolean(), nullable=False),
        sa.Column('season_keep_best', sa.Integer(), nullable=True),
        sa.Column('season_only_session_counted', sa.Boolean(), nullable=False),
        sa.Column('season_minimum', sa.Integer(), nullable=False),
        sa.Column('season_drop_no_show', sa.Boolean(), nullable=False),
        sa.Column('season_drop_dq', sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(['event_id'], ['events.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('event_id', name='uq_ranking_settings_event'),
    )

    # Carry each event's old configuration forward: the event-wide row wins,
    # otherwise the lowest-id per-division row. "exclude N" was a session
    # drop of the lowest N; "include N" kept the best N and zero-padded the
    # shortfall, which is season N with a minimum of N.
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT event_id, mode, count, allow_drop_no_show, allow_drop_dq "
            "FROM ranking_configurations ORDER BY (division_id IS NOT NULL), id"
        )
    ).fetchall()
    converted: set[int] = set()
    for row in rows:
        if row.event_id in converted:
            continue
        converted.add(row.event_id)
        values = {
            "event_id": row.event_id,
            "session_drop_mode": "tiered",
            "session_drop_count": 1,
            "session_drop_no_show": bool(row.allow_drop_no_show),
            "session_drop_dq": bool(row.allow_drop_dq),
            "season_keep_best": None,
            "season_only_session_counted": False,
            "season_minimum": 0,
            "season_drop_no_show": bool(row.allow_drop_no_show),
            "season_drop_dq": bool(row.allow_drop_dq),
        }
        if row.mode == "exclude":
            values["session_drop_mode"] = "lowest"
            values["session_drop_count"] = row.count
        elif row.mode == "include":
            values["season_keep_best"] = row.count
            values["season_minimum"] = row.count
        bind.execute(
            sa.text(
                "INSERT INTO ranking_settings (event_id, session_drop_mode, session_drop_count, "
                "session_drop_no_show, session_drop_dq, season_keep_best, "
                "season_only_session_counted, season_minimum, season_drop_no_show, season_drop_dq) "
                "VALUES (:event_id, :session_drop_mode, :session_drop_count, :session_drop_no_show, "
                ":session_drop_dq, :season_keep_best, :season_only_session_counted, :season_minimum, "
                ":season_drop_no_show, :season_drop_dq)"
            ),
            values,
        )


def downgrade() -> None:
    op.drop_table('ranking_settings')
