from __future__ import annotations

from pathlib import Path

_ENV_PY = '''
from alembic import context
from sqlalchemy import engine_from_config, pool

config = context.config


def run_migrations_online():
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
'''

_REV1 = '''
revision = "rev1"
down_revision = None

from alembic import op
import sqlalchemy as sa


def upgrade():
    op.create_table("widgets", sa.Column("id", sa.Integer, primary_key=True))


def downgrade():
    op.drop_table("widgets")
'''

_REV2 = '''
revision = "rev2"
down_revision = "rev1"

from alembic import op
import sqlalchemy as sa


def upgrade():
    op.add_column("widgets", sa.Column("name", sa.String(50)))


def downgrade():
    op.drop_column("widgets", "name")
'''


def build_isolated_two_revision_script_dir(tmp_path: Path) -> Path:
    """Builds a standalone, 2-revision Alembic script directory,
    independent of this project's real `_alembic/versions/`, so a test
    can construct a database that is genuinely one migration behind head
    without ever touching the real baseline migration. Revision "rev1"
    creates a `widgets` table; "rev2" (the head) adds a `name` column to
    it — enough to prove an upgrade actually ran.
    """
    script_dir = tmp_path / "isolated_alembic"
    versions_dir = script_dir / "versions"
    versions_dir.mkdir(parents=True)
    (script_dir / "env.py").write_text(_ENV_PY)
    (versions_dir / "rev1_initial.py").write_text(_REV1)
    (versions_dir / "rev2_add_column.py").write_text(_REV2)
    return script_dir
