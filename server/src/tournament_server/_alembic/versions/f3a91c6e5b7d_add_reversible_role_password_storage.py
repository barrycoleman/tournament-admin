"""add reversible role password storage

Revision ID: f3a91c6e5b7d
Revises: d47c8e21f9a3
Create Date: 2026-09-17 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f3a91c6e5b7d'
down_revision: Union[str, None] = 'd47c8e21f9a3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable, no server_default needed -- an existing credential's
    # password was set before this column existed, so there is nothing to
    # backfill into it (a one-way password_hash can't be decrypted back
    # into plaintext); it stays null until that role's password is next
    # changed.
    op.add_column(
        'role_credentials', sa.Column('password_encrypted', sa.String(length=500), nullable=True)
    )
    op.create_table(
        'password_encryption_keys',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('key', sa.String(length=200), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    op.drop_table('password_encryption_keys')
    op.drop_column('role_credentials', 'password_encrypted')
