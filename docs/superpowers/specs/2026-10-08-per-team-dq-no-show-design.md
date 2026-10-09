# Per-team DQ and no-show — design

Date: 2026-10-08
Status: approved in brainstorming, awaiting written-spec review

## 1. Purpose

Today a DQ or no-show is a flag on an alliance's whole score record
(`ScoreRecord.no_show`, `ScoreRecord.dq`). When an alliance has two or more
teams, one team's DQ zeroes its partner too. The competition rules are:

- **Practice and qualification, head-to-head and cooperative:** a DQ or
  no-show applies to **one team only**. The match is still played if a
  partner shows up. The flagged team gets nothing from the match; its
  partners keep the alliance's score and, in head-to-head, its win points.
- **Finals, head-to-head and cooperative:** one team's **DQ** DQs the whole
  alliance. A **no-show** removes only that team; the teams that showed up
  play on, and their score counts. If the alliance advances, the no-show
  team advances with it.

This spec moves the flags from the alliance to the team and applies those
rules everywhere a score is turned into a result.

## 2. Scope

In scope: storage, migration, the score-submission API, qualification
rankings (head-to-head and cooperative), cooperative mirroring, and finals
(single elimination, score chase, finals results).

Out of scope:

- **Any UI for setting the flags.** The admin app has no teamwork score
  entry yet. Per-team flag entry is added to the to-do list for the scorer
  app and the score-corrections work (alongside skills scoring).
- **Splitting points by team.** Scoresheets score whole alliances; a DQ'd
  team's actions are not removed from its alliance's score.
- The plugin contract. `rank_teams` input does not change, so the
  conformance tool does not change.
- `ScoreRecord.sitting` and `ScoreRecord.mirrored` keep their current
  meaning.

## 3. Data model

### 3.1 New table `score_record_teams`

| Column            | Type                                   |
|-------------------|----------------------------------------|
| `id`              | int, primary key                       |
| `score_record_id` | FK `score_records.id`, cascade delete  |
| `team_id`         | FK `teams.id`                          |
| `no_show`         | bool, not null, default false          |
| `dq`              | bool, not null, default false          |

Unique on `(score_record_id, team_id)`. The table holds **only flagged
teams**: a team with no row has no flags, and a row never has both flags
false.

The model is `ScoreRecordTeam` (`models/score_record_team.py`), with a
`ScoreRecord.teams` relationship (cascade `all, delete-orphan`).

### 3.2 `ScoreRecord`

`no_show` and `dq` are removed. Every other column stays.

### 3.3 Migration

One Alembic revision with `down_revision = "a7d5e2c8f1b4"`.

- **Upgrade:** create `score_record_teams`. For every score record with
  `no_show` or `dq` set, insert one row per team on its alliance (from
  `alliance_teams`), with the record's two flags. Then drop the two columns
  (SQLite batch mode).
- **Downgrade:** add the two columns back (not null, default false). Set
  each record's `no_show` if any of its team rows has `no_show`, and `dq`
  likewise. Drop the table.

## 4. API

### 4.1 `POST /api/matches/{match_id}/alliances/{alliance_id}/score`

The body replaces `no_show: bool` and `dq: bool` with:

```json
"teams": [{"team_id": 12, "no_show": false, "dq": true}]
```

- `teams` defaults to `[]`; each entry's `no_show` and `dq` default to false.
- An entry with both flags false is ignored (no row stored).
- Both flags true is accepted and stored. Where the rules differ (finals),
  DQ takes precedence.
- **422** when a `team_id` is not on this alliance, or when a team is
  listed more than once. Nothing is written.
- A submission replaces the record's whole flag set: an admin correction
  without `teams` clears the flags.
- Every existing rule is unchanged: scoresheet validation and `force`, a
  non-admin resubmitting a submitted score gets 409, a scorer may overwrite
  a mirrored copy once, and the cooperative overwrite guard.

### 4.2 Response (`ScoreRecordRead`)

`no_show` and `dq` are replaced by the same `teams` list (flagged teams
only, ordered by `team_id`). `computed_score` is the alliance's effective
score (section 5) for the match the record belongs to.

## 5. The rules, in one place

A new module `services/team_flags.py` owns every "does this flag zero the
score" decision. The five current `no_show or dq` checks
(`routers/scores.py`, `services/ranking.py`, `routers/finals.py`, and two
in `services/finals.py`) all call it instead.

```python
def flagged_team_ids(record: ScoreRecord) -> set[int]
    # team ids with either flag

def alliance_out(record: ScoreRecord, team_ids: list[int], *, finals: bool) -> bool
    # finals=False: every team in team_ids is flagged
    # finals=True:  any team is DQ'd, or every team is a no-show
    #               (a team with both flags counts as DQ'd)

def effective_score(plugin, record: ScoreRecord, team_ids: list[int], *, finals: bool) -> int
    # 0 if alliance_out, else plugin.module.calculate_score(data)
```

`team_ids` is the alliance's teams from `alliance_teams`. A match is a
finals match when `Match.finals_bracket_id` is set.

### 5.1 Head-to-head qualification and practice (`_head_to_head_stats`)

- **Winner:** each alliance's score is `effective_score(..., finals=False)`.
  Win, loss and tie are decided from those scores as today.
- **Win points:** each **unflagged** team on a side gets that side's points
  (2 win, 1 tie, 0 loss). A **flagged** team gets 0 from the match but is
  still entered in the rankings, so a team flagged in its only match is
  listed with 0 win points.
- **Strength of schedule:** an unflagged team adds the season-wide win-point
  totals of every opponent in the match, flagged opponents included. A
  flagged team adds nothing from that match.

Worked example: Red (Teams 1, 2) scores 40, Blue (Teams 3, 4) scores 30,
Team 2 is DQ'd. Red wins. Team 1 gets 2 win points, Team 2 gets 0, Teams 3
and 4 get 0. Team 1's strength of schedule adds Team 3's and Team 4's
totals; Team 2's adds nothing; Team 3's and Team 4's each add Team 1's and
Team 2's totals. If Teams 1 and 2 were both flagged, Red would score 0 and
Blue would win.

### 5.2 Cooperative qualification and practice (`_cooperative_records`)

Each team gets its own `MatchRecord`:

- A flagged team: `score=0`, with that team's own `no_show`/`dq`. The
  existing session and season drop rules then apply to that team alone.
- An unflagged team: the alliance's `effective_score(..., finals=False)`
  with both flags false.

With one team per alliance (the bundled cooperative game) the result is
the same as today.

### 5.3 Cooperative mirroring (`routers/scores.py`)

- A submission mirrors its scoresheet to the match's other alliances unless
  **every** team on the submitting alliance is flagged.
- A mirrored copy is written with no team flags.
- `_overwrites_a_submitted_partner` skips a partner record whose teams are
  all flagged (its data never counts), as it skips DQ and no-show partners
  today.

### 5.4 Finals

Single elimination (`advance_single_elimination`), score chase
(`recompute_finals_results`) and the finals runs listing
(`routers/finals.py`) use `effective_score(..., finals=True)`. A DQ on any
team zeroes the alliance; a no-show team is carried along unless every team
is a no-show. Advancement, walkovers and `unavailable` are unchanged.

### 5.5 Match completion

Unchanged: a match is complete when every alliance has a score record. A
fully flagged alliance still submits a record.

## 6. Testing

pytest, against a real app and a temp-file SQLite database:

- **Migration:** upgrading a database with flagged records on two-team
  alliances writes one row per team with the right flags and drops the
  columns; downgrade restores the alliance-level flags.
- **API:** per-team flags round-trip; 422 for a team not on the alliance and
  for a duplicate team, with nothing written; an all-false entry is not
  stored; an admin correction replaces the flag set; a scorer resubmitting
  still gets 409.
- **`team_flags`:** each `alliance_out` case — qualification with some and
  with all teams flagged; finals with one DQ, with one no-show, with every
  team a no-show, and with a team carrying both flags.
- **Head-to-head ranking:** the worked example; a fully flagged alliance
  losing to a lower scoresheet; a tie with one flagged team; strength of
  schedule for flagged and unflagged teams; a team flagged in its only
  match is listed with 0.
- **Cooperative:** a two-teams-per-alliance fixture where one team is DQ'd —
  the partner's average uses the full score; a drop rule drops only the
  flagged team's match; mirroring is skipped only when the whole alliance
  is flagged; the overwrite guard skips a fully flagged partner.
- **Finals:** single elimination — one DQ zeroes the alliance and loses the
  game; one no-show still wins and advances. Score chase — a DQ'd run
  scores 0; a run with one no-show of two teams keeps its score.
- Every existing test that used `no_show=`/`dq=` is updated to `teams=[…]`,
  and the full suite passes.

Frontend: no code changes. Ranking values can shift, so the Playwright
suite is run once (backend-only changes that alter values the frontend
reads still get one E2E run).

## 7. Docs and follow-ups

- `server/CLAUDE.md`: replace the alliance-level DQ/no-show notes with the
  per-team rules and the `team_flags` module.
- Scorer app and score-corrections to-do: score entry must let the user set
  DQ and no-show for each team on the alliance.
