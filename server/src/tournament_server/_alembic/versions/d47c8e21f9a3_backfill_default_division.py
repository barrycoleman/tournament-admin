"""backfill a default division for any event with none

Revision ID: d47c8e21f9a3
Revises: b7e4a19f6c32
Create Date: 2026-09-17 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd47c8e21f9a3'
down_revision: Union[str, None] = 'b7e4a19f6c32'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # A pure data migration, not a schema change -- every tournament from
    # here on always has at least one division (routers/event.py seeds one
    # at creation; routers/divisions.py refuses to delete the last one),
    # but an event created before that shipped could still have zero.
    # Give any such event a "Division 1" so the invariant genuinely holds
    # for every tournament, not just ones created after this landed.
    connection = op.get_bind()
    event_ids_without_a_division = connection.execute(
        sa.text(
            "SELECT events.id FROM events "
            "LEFT JOIN divisions ON divisions.event_id = events.id "
            "WHERE divisions.id IS NULL"
        )
    ).scalars().all()
    for event_id in event_ids_without_a_division:
        connection.execute(
            sa.text(
                "INSERT INTO divisions (event_id, name, target_team_count) "
                "VALUES (:event_id, 'Division 1', NULL)"
            ),
            {"event_id": event_id},
        )


def downgrade() -> None:
    # Deliberately a no-op: a backfilled "Division 1" is indistinguishable
    # from one an admin created or renamed by hand afterward, and teams
    # may already be assigned to it by the time anyone downgrades -- there
    # is no safe, unambiguous way to reverse this. Downgrading past this
    # revision leaves any backfilled divisions in place.
    pass
