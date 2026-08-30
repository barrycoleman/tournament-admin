# Alliance Count & Game Model Foundation — Design Spec

Status: approved for planning
Date: 2026-08-30

## 0. Project constraint

Nothing in this project's code, comments, documentation, file names, or
user-facing text may reference any real-world competition brand or product
name. All descriptions in this spec are written in neutral/generic terms for
that reason, even where they describe a specific closed-source reference
product's behavior.

## 1. Purpose & scope

This spec covers **Phase 5**: correcting a real gap discovered while
brainstorming Phase 6 (finals/elimination brackets). The game-plugin
contract (master spec §5.1, built in Phase 2/3) already declares
`alliance_count` in `match_format()` — but nothing in the shipped code
actually reads it. `POST /api/matches` hardcodes "exactly 2 alliances",
Phase 4's scheduler-plugin contract and both shipped scheduler plugins
always build exactly 2 alliances per generated match, and
`services/ranking.py`'s `recompute_rankings` assumes exactly 2 alliances
per match and computes rankings by comparing one alliance's score against
the other's (win/tie/loss points, strength of schedule).

That comparison-based ranking model is wrong for an entire family of games
this system needs to support: **cooperative-scoring games**, where a match
has a single alliance (no opponent at all) producing one shared score, and
qualification ranking is by average score, not by beating anyone. Building
this family's matches and rankings correctly requires two things this spec
adds:

- Wiring the already-declared `alliance_count` through match creation,
  scheduling, and structural validation, instead of hardcoding 2.
- A new game-plugin-declared `game_model` (`"head_to_head"` or
  `"cooperative_score"`) that `recompute_rankings` branches on, since the
  two families need genuinely different ranking algorithms, not just a
  different alliance count.

In scope:
- `match_format()` contract addition: `game_model`.
- `alliance_count` wired through `POST /api/matches`, the scheduler-plugin
  contract (`generate_schedule`), both shipped scheduler plugins
  (`simple_random`, `balanced`), and `POST /api/schedule`'s structural
  validation.
- `recompute_rankings`'s `cooperative_score` branch: average-score ranking,
  no opponent comparison.
- `rank_teams()` contract clarification: a `cooperative_score` plugin's
  `rank_teams()` receives a different `team_results` shape than a
  `head_to_head` plugin's.
- `Ranking` model additions: `average_score`, `matches_played`.
- `AllianceTeam.position`: a reliable, explicit team order within an
  alliance, for games whose rules assign roles/game-elements by team
  position regardless of `game_model` or `alliance_count`.
- Conformance tool updates for all of the above, plus a new
  `cooperative_score` fixture plugin for end-to-end test coverage.

Explicitly out of scope / deferred:
- Elimination brackets and the score-chase finals format — this is the
  foundation phase they depend on; the finals/brackets feature itself is
  Phase 6, built once this phase is merged.
- Any alliance count other than 1 or 2 — nothing currently requires 3+
  team alliances or 3+ alliance matches, and generalizing the scheduler
  algorithms' station-naming and cost functions to arbitrary alliance
  counts beyond what's needed now would be speculative.
- Any UI. This spec defines the plugin contract and REST behavior only.

## 2. `match_format()` contract addition: `game_model`

A game plugin's `match_format()` must now include a `game_model` key,
alongside the existing `alliance_count`, `teams_per_alliance`,
`autonomous_seconds`, `driver_seconds`, `round_types`:

- `"head_to_head"` — the existing model, unchanged: a match has exactly
  `alliance_count` (conventionally 2) alliances, each producing its own
  score via `calculate_score()`, compared against each other to award
  win/tie/loss points.
- `"cooperative_score"` — a match has exactly `alliance_count`
  (conventionally 1) alliance, `teams_per_alliance` teams cooperating on
  one shared scoresheet, no opponent, no win/tie/loss — just a score,
  credited equally to every team in that alliance, ranked by average score
  across a team's completed matches.

This is a required key with no default — consistent with this project's
existing "every declared key must be present, no silent defaults"
philosophy for the scoresheet-schema fields established in Phase 2.
`tests/fixtures/plugins/games/example-game/plugin.py` (the existing
head-to-head reference fixture) gets `"game_model": "head_to_head"` added
to its `match_format()` return value — no other change to that fixture,
since `head_to_head` behavior is unchanged everywhere.

## 3. Wiring `alliance_count` through match creation and scheduling

Three places currently hardcode "exactly 2 alliances"; all three read
`alliance_count` from the event's game plugin's `match_format()` instead:

- **`POST /api/matches`** (`routers/matches.py`'s `create_match`): the
  check `len(payload.alliances) != 2` becomes `len(payload.alliances) !=
  alliance_count`, where `alliance_count` comes from
  `get_game_plugin_for_event(request, db).module.match_format()
  ["alliance_count"]`. This requires an event to have a game plugin
  selected before manual match creation succeeds — already effectively
  true in practice (an event without a selected game plugin can't
  meaningfully record scores either), but this makes it an explicit,
  checked precondition for match creation too, not just scoring.
- **The scheduler-plugin contract** (`generate_schedule`, from Phase 4):
  gains one more parameter, `alliance_count: int`, alongside the existing
  `teams_per_alliance`. Both shipped scheduler plugins
  (`plugins/schedulers/simple_random/plugin.py`,
  `plugins/schedulers/balanced/plugin.py`) build `alliance_count`-many
  alliances per generated match instead of the hardcoded two
  (`("red", "blue")`). For `alliance_count == 1`, a "match" is simply one
  group of `teams_per_alliance` teams assigned a single alliance labeled
  `"solo"`, with no opposing alliance and (for `balanced`) no
  opponent-count term in its cost function — only the partner-count and
  same-organization terms still apply, since there's still a partner to
  avoid repeating even without an opponent. For `alliance_count == 2`,
  behavior is unchanged from what Phase 4 shipped (`("red", "blue")`
  stations).
- **`POST /api/schedule`'s structural validation**
  (`_validate_generated_schedule` in `routers/schedule.py`): checks
  `len(alliances) == alliance_count` (fetched the same way `generate_schedule`
  already fetches `teams_per_alliance` from the event's game plugin, in
  Phase 4) instead of the hardcoded `!= 2`. The station-name check relaxes
  from a hardcoded `{"red", "blue"}` to "every station name in the match is
  a non-empty string, and station names are distinct within one match" —
  this covers both the existing 2-alliance `{"red", "blue"}` case and a
  1-alliance `{"solo"}` case without hardcoding either literal set.

## 4. Team order within an alliance: `AllianceTeam.position`

Some games (both `head_to_head` and `cooperative_score`) assign game
elements by which physical robot occupies which role — e.g. "the first
team listed interacts with the red-colored elements, the second with
blue" — even when there's no opposing alliance to make the match itself
adversarial (a `cooperative_score` alliance's two teams still need a
reliable, known order for this purpose). The score itself stays a single
shared alliance-level number (confirmed not to need per-team-distinct
storage) — only the *order* of teams within one alliance needs to be
reliable, and today it isn't: `AllianceTeam` has no ordering column, and
reads (`_to_match_read`'s `team_ids` list) have no `ORDER BY`, relying on
SQLite's incidental insertion-order behavior rather than an explicit,
documented guarantee.

`AllianceTeam` gains a `position: int` column (0-indexed), set from the
submitted `team_ids` list's order at creation time — both in `create_match`
(the manual path) and in `POST /api/schedule`'s persistence step (the
scheduler-generated path, using the order the scheduler plugin returned
each alliance's `team_ids` in). Every read that reconstructs a
`team_ids` list (`_to_match_read`, and any future consumer) queries
`ORDER BY position` instead of relying on incidental ordering. A game
plugin whose rules care about team order (via `scoresheet_schema()`'s
existing per-field `"scope"`, or simply by convention in its own
`calculate_score()`/UI expectations) can now rely on `team_ids[0]` always
being "the first team" and `team_ids[1]` "the second," reliably, for any
alliance regardless of `game_model` or `alliance_count`.

## 5. `recompute_rankings` branches on `game_model`

`services/ranking.py`'s `recompute_rankings(db, plugin, session_id,
division_id)` gains a `game_model` branch, read from
`plugin.module.match_format()["game_model"]`:

- **`head_to_head`**: exactly the existing algorithm, byte-for-byte
  unchanged — win/tie/loss points (2/1/0) from comparing two alliances'
  scores, strength of schedule from summed opponent win-points, skip any
  match that doesn't have exactly 2 alliances. A `head_to_head` game will
  only ever produce 2-alliance matches (since `alliance_count=2` is what
  such a plugin declares and everything in §3 now enforces), so this skip
  condition remains a defensive check, not a live branch.
- **`cooperative_score`**: a new algorithm. For every completed match in
  the `(session_id, division_id)` scope (regardless of `alliance_count`,
  though in practice always 1 for this branch), compute that match's
  single alliance's score via `calculate_score()` (or `0` if `no_show`/`dq`
  is set, same zeroing rule as `head_to_head`), and credit it to every team
  in that alliance — accumulating, per team, a running total score and a
  count of matches played. A team's average score is `total ÷ count`.

Both branches still call the game plugin's own `rank_teams()` for the
final sort/tiebreak step — but the `team_results` list passed to it has a
**different shape per `game_model`**, since `win_points`/
`strength_of_schedule` don't mean anything for a game with no opponent:

- `head_to_head`: `{"team_id", "win_points", "strength_of_schedule",
  "tiebreaker_seed"}` — unchanged from Phase 3.
- `cooperative_score`: `{"team_id", "average_score", "matches_played",
  "tiebreaker_seed"}`.

A game plugin's `rank_teams()` is written by its author to match whichever
shape corresponds to the `game_model` that same plugin declares — this is
a real, necessary contract branch, not a cosmetic one, and the conformance
tool (§6) checks it accordingly.

## 6. `Ranking` model additions

`models/ranking.py`'s `Ranking` gains two new columns:
- `average_score: float`, default `0.0`.
- `matches_played: int`, default `0`.

Both are populated by the `cooperative_score` branch of `recompute_rankings`
(used for that branch's actual rank ordering) and left at their defaults
for `head_to_head` rows (harmless, unused by that branch — not worth a
separate table or a nullable-columns special case for two extra fields).
`GET /api/rankings` (`schemas/ranking.py`'s `RankingRead`) exposes both
fields unconditionally; a `head_to_head` event's rankings just show `0.0`/
`0` for them, which is accurate (those numbers genuinely don't apply).

## 7. Conformance tooling updates

- `_check_match_format` (in `plugin_registry/conformance.py`) adds
  `"game_model"` to its required-keys set, and checks its value is one of
  `{"head_to_head", "cooperative_score"}` — the same pattern already used
  for validating `data_type`/`widget`/`scope` against fixed value sets in
  `_check_scoresheet_schema`.
- `_check_rank_teams` needs the plugin's declared `game_model` to know
  which sample `team_results` shape to build (the two shapes from §4).
  This requires `_run_game_checks` to capture `match_format()`'s actual
  return value once (not just the `CheckResult` from `_check_match_format`)
  and thread `game_model` through to the `rank_teams()` check — an
  implementation detail the plan will spell out exactly, not a new
  conformance-tool behavior beyond "pick the right sample shape."
- A new fixture plugin, `tests/fixtures/plugins/games/cooperative-game/`
  (name chosen to be self-describing without implying any specific
  real-world game), declaring `alliance_count: 1`, `teams_per_alliance: 2`
  (or another small number — the plan picks a concrete value),
  `game_model: "cooperative_score"`, with a `calculate_score()` /
  `validate()` / `rank_teams()` implementation exercising the
  `cooperative_score` path end-to-end, mirroring how `example-game`
  exercises `head_to_head` today. This is what the conformance,
  `create_match`, scheduling, and ranking tests in the implementation plan
  actually run against.

## 8. Testing

- Existing `head_to_head` test coverage (Phase 2-4's full suite) must pass
  unchanged — `alliance_count` wiring and the `game_model` branch are
  additive, not behavior changes, for the existing `example-game` path.
- New tests: `create_match` rejects an alliance count that doesn't match
  the event's game plugin's declared `alliance_count`; a scheduler plugin
  generates 1-alliance ("solo") matches correctly for a
  `cooperative_score`-declaring event, and `POST /api/schedule`'s
  structural validation accepts them; `recompute_rankings`'s
  `cooperative_score` branch produces the correct average-score ranking
  for a hand-computed multi-match scenario (mirroring Phase 3's
  hand-verified `head_to_head` ranking test); conformance checks correctly
  validate (and reject malformed) `game_model` declarations and branch
  `_check_rank_teams`'s sample shape correctly; a match's `team_ids` list
  round-trips in submitted order (`AllianceTeam.position`) through both
  the manual `create_match` path and the scheduler-generated path.

## 9. Deferred / open items

- **Elimination brackets and the score-chase finals format** — Phase 6,
  built on this corrected foundation. The design discussion that surfaced
  this phase's scope (captain-pick vs. seed-pairing alliance formation,
  the single-elimination bracket tree, the score-chase sequential format,
  `FinalsBracket`/`BracketAlliance`/`BracketMatchup`/`FinalsResult`) is
  preserved for that phase's own spec, not repeated here.
- **Alliance counts other than 1 or 2** — no current game family needs
  this; generalizing further is speculative until a real need appears.
- **Per-team-distinct scoresheet values** (a `"scope": "team"` field
  storing a genuinely different value per team within one alliance, rather
  than one shared alliance-level number) — confirmed not needed for the
  red/blue-per-robot game rules that prompted this question; the alliance
  still produces one combined score, and `AllianceTeam.position` (§4) is
  sufficient. Revisit if a future game genuinely needs per-team-distinct
  stored values, which would be a real change to the scoresheet data
  format, not just an ordering fix.
- **`balanced`'s cost function for `alliance_count == 1`** drops the
  opponent-count term entirely (there's no opponent) but keeps the
  partner-count and same-organization terms — this is a real behavior
  change to an already-shipped plugin, not a new one, and the
  implementation plan's tests need to cover it explicitly rather than
  relying on the existing `alliance_count == 2` tests to catch a
  regression they can't see.
