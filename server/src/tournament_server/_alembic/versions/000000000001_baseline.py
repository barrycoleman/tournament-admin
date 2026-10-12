"""baseline

The whole schema in one migration. Until the first release this file is
edited in place whenever a model changes (regenerate it rather than adding a
new revision); `tests/test_alembic_drift.py` fails if it falls out of step
with the models. From the first release on, schema changes add new
revisions after this one.

Revision ID: 000000000001
Revises:
Create Date: 2026-10-12 16:11:13.762301

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import tournament_server.db


# revision identifiers, used by Alembic.
revision: str = '000000000001'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('audit_log',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('timestamp', tournament_server.db.UTCDateTime(), nullable=False),
    sa.Column('table_name', sa.String(length=100), nullable=False),
    sa.Column('row_pk', sa.Integer(), nullable=True),
    sa.Column('action', sa.String(length=20), nullable=False),
    sa.Column('actor', sa.String(length=200), nullable=False),
    sa.Column('before_json', sa.Text(), nullable=True),
    sa.Column('after_json', sa.Text(), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('auth_sessions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('role', sa.String(length=20), nullable=False),
    sa.Column('refresh_token_hash', sa.String(length=200), nullable=False),
    sa.Column('issued_at', tournament_server.db.UTCDateTime(), nullable=False),
    sa.Column('expires_at', tournament_server.db.UTCDateTime(), nullable=False),
    sa.Column('revoked_at', tournament_server.db.UTCDateTime(), nullable=True),
    sa.Column('label', sa.String(length=200), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('refresh_token_hash')
    )
    op.create_table('events',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('active_session_id', sa.Integer(), nullable=True),
    sa.Column('game_plugin_name', sa.String(length=200), nullable=True),
    sa.Column('created_at', tournament_server.db.UTCDateTime(), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('password_encryption_keys',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('key', sa.String(length=200), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('role_credentials',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('role', sa.String(length=20), nullable=False),
    sa.Column('password_hash', sa.String(length=200), nullable=False),
    sa.Column('password_encrypted', sa.String(length=500), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('role')
    )
    op.create_table('scoring_devices',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('friendly_name', sa.String(length=100), nullable=False),
    sa.Column('device_token_hash', sa.String(length=200), nullable=False),
    sa.Column('registered_at', tournament_server.db.UTCDateTime(), nullable=False),
    sa.Column('admitted_at', tournament_server.db.UTCDateTime(), nullable=True),
    sa.Column('admitted_by', sa.String(length=200), nullable=True),
    sa.Column('last_seen_at', tournament_server.db.UTCDateTime(), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('device_token_hash'),
    sa.UniqueConstraint('friendly_name')
    )
    op.create_table('signing_keys',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('key', sa.String(length=200), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('divisions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('event_id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('target_team_count', sa.Integer(), nullable=True),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('ranking_settings',
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
    sa.UniqueConstraint('event_id', name='uq_ranking_settings_event')
    )
    op.create_table('sessions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('event_id', sa.Integer(), nullable=False),
    sa.Column('label', sa.String(length=200), nullable=False),
    sa.Column('session_date', sa.Date(), nullable=True),
    sa.Column('timezone', sa.String(length=100), nullable=True),
    sa.Column('qualification_finalized_at', tournament_server.db.UTCDateTime(), nullable=True),
    sa.Column('qualification_drops', sa.JSON(), nullable=True),
    sa.Column('skills_attempts', sa.JSON(), nullable=True),
    sa.Column('awards_finalized_at', tournament_server.db.UTCDateTime(), nullable=True),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('skills_settings',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('event_id', sa.Integer(), nullable=False),
    sa.Column('enabled', sa.Boolean(), nullable=False),
    sa.Column('attempts', sa.JSON(), nullable=False),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('event_id', name='uq_skills_settings_event')
    )
    op.create_table('awards',
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
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('field_sets',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('session_id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('division_id', sa.Integer(), nullable=True),
    sa.ForeignKeyConstraint(['division_id'], ['divisions.id'], ),
    sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('schedule_generations',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('session_id', sa.Integer(), nullable=False),
    sa.Column('division_id', sa.Integer(), nullable=True),
    sa.Column('round_type', sa.String(length=20), nullable=False),
    sa.Column('scheduler_plugin_name', sa.String(length=200), nullable=False),
    sa.Column('scheduler_plugin_version', sa.String(length=50), nullable=False),
    sa.Column('target_matches_per_team', sa.Integer(), nullable=False),
    sa.Column('generated_at', tournament_server.db.UTCDateTime(), nullable=False),
    sa.Column('time_blocks_json', sa.Text(), nullable=True),
    sa.Column('cycle_time_seconds', sa.Integer(), nullable=True),
    sa.ForeignKeyConstraint(['division_id'], ['divisions.id'], ),
    sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('session_playing_windows',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('session_id', sa.Integer(), nullable=False),
    sa.Column('date', sa.Date(), nullable=False),
    sa.Column('start_time', sa.String(length=5), nullable=False),
    sa.Column('end_time', sa.String(length=5), nullable=False),
    sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('teams',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('event_id', sa.Integer(), nullable=False),
    sa.Column('division_id', sa.Integer(), nullable=True),
    sa.Column('number', sa.String(length=20), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('robot_name', sa.String(length=200), nullable=True),
    sa.Column('organization', sa.String(length=200), nullable=True),
    sa.Column('city', sa.String(length=200), nullable=True),
    sa.Column('state', sa.String(length=100), nullable=True),
    sa.Column('country', sa.String(length=100), nullable=True),
    sa.Column('tiebreaker_seed', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['division_id'], ['divisions.id'], ),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('event_id', 'number', name='uq_teams_event_number')
    )
    op.create_table('award_winners',
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
    sa.UniqueConstraint('award_id', 'division_id', 'team_id', name='uq_award_winner')
    )
    op.create_table('fields',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('field_set_id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.ForeignKeyConstraint(['field_set_id'], ['field_sets.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('finals_brackets',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('session_id', sa.Integer(), nullable=False),
    sa.Column('division_id', sa.Integer(), nullable=True),
    sa.Column('field_set_id', sa.Integer(), nullable=False),
    sa.Column('format', sa.String(length=20), nullable=False),
    sa.Column('bracket_size', sa.Integer(), nullable=False),
    sa.Column('wins_to_advance', sa.String(), nullable=False),
    sa.Column('status', sa.String(length=30), nullable=False),
    sa.Column('next_field_index', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['division_id'], ['divisions.id'], ),
    sa.ForeignKeyConstraint(['field_set_id'], ['field_sets.id'], ),
    sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('rankings',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('session_id', sa.Integer(), nullable=True),
    sa.Column('division_id', sa.Integer(), nullable=True),
    sa.Column('team_id', sa.Integer(), nullable=False),
    sa.Column('win_points', sa.Integer(), nullable=False),
    sa.Column('strength_of_schedule', sa.Float(), nullable=False),
    sa.Column('average_score', sa.Float(), nullable=False),
    sa.Column('matches_played', sa.Integer(), nullable=False),
    sa.Column('rank', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['division_id'], ['divisions.id'], ),
    sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ),
    sa.ForeignKeyConstraint(['team_id'], ['teams.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('session_id', 'division_id', 'team_id', name='uq_ranking_session_division_team')
    )
    op.create_table('session_participation',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('session_id', sa.Integer(), nullable=False),
    sa.Column('team_id', sa.Integer(), nullable=False),
    sa.Column('checked_in', sa.Boolean(), nullable=False),
    sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ),
    sa.ForeignKeyConstraint(['team_id'], ['teams.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('session_id', 'team_id', name='uq_session_participation_session_team')
    )
    op.create_table('skills_attempts',
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
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_skills_attempts_session_team_type', 'skills_attempts', ['session_id', 'team_id', 'skills_type'], unique=False)
    op.create_table('bracket_alliances',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('bracket_id', sa.Integer(), nullable=False),
    sa.Column('seed', sa.Integer(), nullable=False),
    sa.Column('unavailable', sa.Boolean(), nullable=False),
    sa.ForeignKeyConstraint(['bracket_id'], ['finals_brackets.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('bracket_alliance_teams',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('bracket_alliance_id', sa.Integer(), nullable=False),
    sa.Column('team_id', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['bracket_alliance_id'], ['bracket_alliances.id'], ),
    sa.ForeignKeyConstraint(['team_id'], ['teams.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('bracket_matchups',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('bracket_id', sa.Integer(), nullable=False),
    sa.Column('round_number', sa.Integer(), nullable=False),
    sa.Column('position', sa.Integer(), nullable=False),
    sa.Column('matchup_number', sa.Integer(), nullable=True),
    sa.Column('alliance_a_id', sa.Integer(), nullable=True),
    sa.Column('alliance_b_id', sa.Integer(), nullable=True),
    sa.Column('winner_alliance_id', sa.Integer(), nullable=True),
    sa.ForeignKeyConstraint(['alliance_a_id'], ['bracket_alliances.id'], ),
    sa.ForeignKeyConstraint(['alliance_b_id'], ['bracket_alliances.id'], ),
    sa.ForeignKeyConstraint(['bracket_id'], ['finals_brackets.id'], ),
    sa.ForeignKeyConstraint(['winner_alliance_id'], ['bracket_alliances.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('finals_results',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('finals_bracket_id', sa.Integer(), nullable=False),
    sa.Column('bracket_alliance_id', sa.Integer(), nullable=False),
    sa.Column('score', sa.Integer(), nullable=False),
    sa.Column('rank', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['bracket_alliance_id'], ['bracket_alliances.id'], ),
    sa.ForeignKeyConstraint(['finals_bracket_id'], ['finals_brackets.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('finals_bracket_id', 'bracket_alliance_id', name='uq_finals_result_bracket_alliance')
    )
    op.create_table('matches',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('session_id', sa.Integer(), nullable=False),
    sa.Column('division_id', sa.Integer(), nullable=True),
    sa.Column('round_type', sa.String(length=20), nullable=False),
    sa.Column('match_number', sa.Integer(), nullable=False),
    sa.Column('field_id', sa.Integer(), nullable=True),
    sa.Column('time_slot', sa.Integer(), nullable=True),
    sa.Column('schedule_generation_id', sa.Integer(), nullable=True),
    sa.Column('finals_bracket_id', sa.Integer(), nullable=True),
    sa.Column('bracket_alliance_id', sa.Integer(), nullable=True),
    sa.Column('bracket_matchup_id', sa.Integer(), nullable=True),
    sa.Column('scheduled_time', tournament_server.db.UTCDateTime(), nullable=True),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('phase', sa.String(length=20), nullable=False),
    sa.Column('phase_deadline', tournament_server.db.UTCDateTime(), nullable=True),
    sa.Column('paused', sa.Boolean(), nullable=False),
    sa.Column('remaining_seconds_at_pause', sa.Float(), nullable=True),
    sa.ForeignKeyConstraint(['bracket_alliance_id'], ['bracket_alliances.id'], ),
    sa.ForeignKeyConstraint(['bracket_matchup_id'], ['bracket_matchups.id'], ),
    sa.ForeignKeyConstraint(['division_id'], ['divisions.id'], ),
    sa.ForeignKeyConstraint(['field_id'], ['fields.id'], ),
    sa.ForeignKeyConstraint(['finals_bracket_id'], ['finals_brackets.id'], ),
    sa.ForeignKeyConstraint(['schedule_generation_id'], ['schedule_generations.id'], ),
    sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('alliances',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('match_id', sa.Integer(), nullable=False),
    sa.Column('station', sa.String(length=20), nullable=False),
    sa.ForeignKeyConstraint(['match_id'], ['matches.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('alliance_teams',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('alliance_id', sa.Integer(), nullable=False),
    sa.Column('team_id', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['alliance_id'], ['alliances.id'], ),
    sa.ForeignKeyConstraint(['team_id'], ['teams.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('score_records',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('alliance_id', sa.Integer(), nullable=False),
    sa.Column('plugin_name', sa.String(length=200), nullable=False),
    sa.Column('plugin_version', sa.String(length=50), nullable=False),
    sa.Column('data_json', sa.Text(), nullable=False),
    sa.Column('sitting', sa.Boolean(), nullable=False),
    sa.Column('mirrored', sa.Boolean(), nullable=False),
    sa.Column('submitted_by_device', sa.String(length=200), nullable=True),
    sa.Column('submitted_at', tournament_server.db.UTCDateTime(), nullable=False),
    sa.Column('saved_at', tournament_server.db.UTCDateTime(), nullable=True),
    sa.ForeignKeyConstraint(['alliance_id'], ['alliances.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('alliance_id', name='uq_score_record_alliance')
    )
    op.create_table('score_record_teams',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('score_record_id', sa.Integer(), nullable=False),
    sa.Column('team_id', sa.Integer(), nullable=False),
    sa.Column('no_show', sa.Boolean(), nullable=False),
    sa.Column('dq', sa.Boolean(), nullable=False),
    sa.ForeignKeyConstraint(['score_record_id'], ['score_records.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['team_id'], ['teams.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('score_record_id', 'team_id', name='uq_score_record_team')
    )


def downgrade() -> None:
    op.drop_table('score_record_teams')
    op.drop_table('score_records')
    op.drop_table('alliance_teams')
    op.drop_table('alliances')
    op.drop_table('matches')
    op.drop_table('finals_results')
    op.drop_table('bracket_matchups')
    op.drop_table('bracket_alliance_teams')
    op.drop_table('bracket_alliances')
    op.drop_index('ix_skills_attempts_session_team_type', table_name='skills_attempts')
    op.drop_table('skills_attempts')
    op.drop_table('session_participation')
    op.drop_table('rankings')
    op.drop_table('finals_brackets')
    op.drop_table('fields')
    op.drop_table('award_winners')
    op.drop_table('teams')
    op.drop_table('session_playing_windows')
    op.drop_table('schedule_generations')
    op.drop_table('field_sets')
    op.drop_table('awards')
    op.drop_table('skills_settings')
    op.drop_table('sessions')
    op.drop_table('ranking_settings')
    op.drop_table('divisions')
    op.drop_table('signing_keys')
    op.drop_table('scoring_devices')
    op.drop_table('role_credentials')
    op.drop_table('password_encryption_keys')
    op.drop_table('events')
    op.drop_table('auth_sessions')
    op.drop_table('audit_log')
