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
actually reads it. `services/ranking.py`'s `recompute_rankings` also
assumes every match is adversarial (compare alliance A's score to alliance
B's, award win/tie/loss points). That comparison-based ranking model is
wrong for an entire family of games this system needs to support:
**cooperative-scoring games**, where two alliances share one field and
produce one combined result with no winner — ranking is by average score,
not by beating anyone.

Building this family correctly requires:

- A new game-plugin-declared `game_model` (`"head_to_head"` or
  `"cooperative_score"`) that `recompute_rankings` branches on.
- Wiring the already-declared `alliance_count` through the places that
  currently hardcode 2, so the contract's own field is no longer dead data.
- A way for a `cooperative_score` match's two alliances to share one
  scoresheet, while still letting each alliance's `no_show`/`dq`/`sitting`
  status apply independently.
- A ranking-configuration system (drop-lowest / keep-highest-N, with
  zero-padding and cross-session aggregation) that only makes sense for
  `cooperative_score` — `head_to_head` has no concept of dropping a match.

In scope:
- `match_format()` contract addition: `game_model`.
- `alliance_count` wired through `POST /api/matches`, the scheduler-plugin
  contract (`generate_schedule`), both shipped scheduler plugins
  (`simple_random`, `balanced`), and `POST /api/schedule`'s structural
  validation — even though both concrete game models in this phase declare
  `alliance_count = 2`, this removes a hardcoded magic number and makes the
  contract's already-declared field meaningful for any future game that
  needs a different count.
- Shared-scoresheet mirroring for `cooperative_score` matches, with
  independent per-alliance `no_show`/`dq`/`sitting`.
- `recompute_rankings`'s `cooperative_score` branch: average-score ranking,
  no opponent comparison, per-alliance effective-score crediting.
- `rank_teams()` contract clarification: a `cooperative_score` plugin's
  `rank_teams()` receives a different `team_results` shape than a
  `head_to_head` plugin's.
- `RankingConfiguration`: organizer-configurable exclude-lowest-N /
  include-highest-N ranking, with zero-padding for included-but-unplayed
  matches, and toggles for whether `no_show`/`dq` matches are drop-eligible.
- Cross-session (event-wide / league) ranking aggregation — `cooperative_score`
  only, since `head_to_head` has no equivalent concept.
- `Ranking` model additions: `average_score`, `matches_played`, and
  `session_id` becoming nullable (`NULL` = event-wide).
- Conformance tool updates for all of the above, plus a new
  `cooperative_score` fixture plugin for end-to-end test coverage.

Explicitly out of scope / deferred:
- Elimination brackets and the score-chase finals format — this is the
  foundation phase they depend on; the finals/brackets feature itself is
  Phase 6, built once this phase is merged.
- Any alliance count other than 2 — nothing currently requires a different
  count for either game family in scope here; the wiring in §3 is
  written generically, but the two fixture plugins built in this phase
  both declare `alliance_count = 2`.
- Per-team-distinct scoresheet values (recording a genuinely different
  value per team within one alliance) — the alliance still produces one
  combined, shared score regardless of `game_model`; which physical
  robot is on which side is a matter of which alliance (`station`) it's
  on, not something the data model needs to track within an alliance.
- Any UI. This spec defines the plugin contract and REST behavior only.

## 2. `match_format()` contract addition: `game_model`

A game plugin's `match_format()` must now include a `game_model` key,
alongside the existing `alliance_count`, `teams_per_alliance`,
`autonomous_seconds`, `driver_seconds`, `round_types`:

- `"head_to_head"` — the existing model, unchanged: a match has
  `alliance_count` (conventionally 2) alliances, each producing its own
  score via `calculate_score()`, compared against each other to award
  win/tie/loss points.
- `"cooperative_score"` — a match also has `alliance_count` (conventionally
  2) alliances, but they aren't adversarial: the two alliances share one
  combined outcome (§4), there's no win/tie/loss, and qualification ranking
  is by average score (§6/§8) rather than by beating an opponent.

This is a required key with no default — consistent with this project's
existing "every declared key must be present, no silent defaults"
philosophy for the scoresheet-schema fields established in Phase 2.
`tests/fixtures/plugins/games/example-game/plugin.py` (the existing
head-to-head reference fixture) gets `"game_model": "head_to_head"` added
to its `match_format()` return value — no other change to that fixture,
since `head_to_head` behavior is unchanged everywhere.

## 3. Wiring `alliance_count` through match creation and scheduling

Three places currently hardcode "exactly 2 alliances"; all three read
`alliance_count` from the event's game plugin's `match_format()` instead,
even though both game models shipped in this phase happen to use 2:

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
  alliances per generated match instead of a hardcoded two — no behavior
  change for either shipped fixture plugin in this phase, since both
  declare `alliance_count = 2`, but the algorithms no longer assume it.
- **`POST /api/schedule`'s structural validation**
  (`_validate_generated_schedule` in `routers/schedule.py`): checks
  `len(alliances) == alliance_count` (fetched the same way `generate_schedule`
  already fetches `teams_per_alliance` from the event's game plugin, in
  Phase 4) instead of the hardcoded `!= 2`.

## 4. Shared scoresheets for `cooperative_score` matches

A `cooperative_score` match's two alliances share one physical outcome —
one scoresheet — even though the data model still has two `Alliance` rows
(`"red"`, `"blue"`, exactly as `head_to_head` already has). Rather than
changing `ScoreRecord`'s per-alliance shape or the scoring endpoint's URL,
submitting a score to *either* alliance via the existing
`POST /api/matches/{id}/alliances/{id}/score` endpoint (unchanged shape)
now **mirrors the raw scoresheet data** (`data_json`, `plugin_name`,
`plugin_version`) onto the match's other alliance(s), for
`cooperative_score` matches only. Both alliances end up holding identical
scoresheet data, and the existing "match is completed once every alliance
has a `ScoreRecord`" logic keeps working completely unchanged — a
`cooperative_score` match typically completes after just one submission,
since mirroring immediately creates a matching record for the other side.

**What does *not* get mirrored: `no_show`, `dq`, `sitting`.** These stay
exactly what they already are — independent per-alliance flags on
`ScoreRecord`, submitted directly to whichever alliance they apply to,
using the exact same zeroing rule that already exists for `head_to_head`
(`0` if that alliance's own `no_show` or `dq` is set, else
`calculate_score()` of the shared data; `sitting` never zeroes anything,
in either `game_model` — it's informational only, for a future field-
control system to know not to expect an electronic connection from that
position). Concretely:

- **A post-match disqualification**: an admin submits a second score
  update directly to the DQ'd alliance with `dq: true` (same shared data —
  the DQ is a ruling, not a scoring dispute). That alliance's own effective
  score becomes `0`; the match still counts toward its `matches_played`.
  The other alliance's own record and effective score are untouched.
- **A no-show**: the missing alliance's `ScoreRecord` is submitted with
  `no_show: true`; its effective score is `0` but the match still counts
  toward its `matches_played`. The alliance that *did* play keeps
  whatever real score they achieved.
- **Sitting**: no special handling needed — already behaves this way for
  `head_to_head` today, and the same logic applies unchanged for
  `cooperative_score`.

Mirroring only ever touches an alliance's `data_json`/`plugin_name`/
`plugin_version` fields; a `no_show`/`dq`/`sitting` flag already set on a
`ScoreRecord`, whether by an earlier mirrored write or a direct one, is
never overwritten by a later mirror from the other alliance.

## 5. `recompute_rankings` branches on `game_model`

`services/ranking.py`'s `recompute_rankings(db, plugin, session_id,
division_id)` gains a `game_model` branch, read from
`plugin.module.match_format()["game_model"]`:

- **`head_to_head`**: exactly the existing algorithm, byte-for-byte
  unchanged — win/tie/loss points (2/1/0) from comparing two alliances'
  scores, strength of schedule from summed opponent win-points.
- **`cooperative_score`**: a new algorithm, with no opponent comparison at
  all. For every completed match in scope, each alliance is processed
  *independently* (not "one shared value for the whole match" — a DQ'd or
  no-show alliance can diverge from its partner alliance, per §4): that
  alliance's effective score (`0` if its own `no_show`/`dq` is set, else
  `calculate_score()` of its — possibly mirrored — data) is credited to
  every team in that alliance, accumulating a running total score and a
  count of matches played per team. In the normal case both alliances in
  a match hold identical mirrored data and credit the same score to both
  sides' teams; a DQ'd alliance's teams get `0` for that match while the
  other alliance's teams keep their real score, exactly matching "the
  match still counts toward their average, but they score no points."
  A team's average score is `total ÷ count`, subject to the exclude/include
  configuration in §7.

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
tool (§9) checks it accordingly.

## 6. `Ranking` model additions

`models/ranking.py`'s `Ranking` gains:
- `average_score: float`, default `0.0`.
- `matches_played: int`, default `0` — always the count of *real* completed
  matches, never inflated by the zero-padding described in §7.
- `session_id` changes from a required FK to a **nullable** FK, where
  `NULL` means "aggregated across every session in the event" (§8). This
  follows the exact pattern already established for `Ranking.division_id`'s
  nullability, including its already-documented limitation: the unique
  constraint (`session_id, division_id, team_id`) doesn't fully protect
  the `NULL` case under SQL's standard "NULL is never equal to NULL"
  semantics, so upserts continue to go through an explicit app-level
  lookup (as they already do for the `NULL`-division case) rather than
  relying on the database constraint alone.

Both new fields are populated by the `cooperative_score` branch of
`recompute_rankings` (used for that branch's actual rank ordering) and
left at their defaults for `head_to_head` rows (harmless, unused by that
branch). `GET /api/rankings` (`schemas/ranking.py`'s `RankingRead`)
exposes both fields unconditionally, and `session_id` becomes `int | None`
in the response schema too.

## 7. `RankingConfiguration`: exclude/include ranking rules

A new model, `RankingConfiguration`: `id, event_id, division_id (nullable),
mode ("exclude" | "include"), count, allow_drop_no_show (bool, default
false), allow_drop_dq (bool, default false)`. One per `(event, division)`,
admin-configurable, and consulted only when that division's game plugin
declares `game_model = "cooperative_score"` — `head_to_head` ranking never
looks at it.

The same configuration and algorithm apply uniformly wherever a
`cooperative_score` ranking is computed — a single session's own standings
(§5) and the cross-session/event-wide standings (§8) both consult the
*same* `RankingConfiguration` row for that `(event, division)`, applied
independently to whichever set of completed matches is in scope for that
computation. It's the organizer's responsibility to pick a `count`
appropriate to their event's structure (a small count for a single-session
one-day event, a larger count for a multi-session league) — the system
does not attempt to detect or apply different counts for the two scopes
automatically.

**Exclude mode**: sort a team's completed matches in scope ascending by
effective score; drop the lowest `count` matches that are **drop-eligible**
(a `no_show` match is only droppable if `allow_drop_no_show` is set; a `dq`
match only if `allow_drop_dq` is set — a non-drop-eligible bad match stays
counted regardless of how low it scores). If fewer eligible matches exist
than `count`, drop as many as are eligible and stop there. Average =
remaining sum ÷ remaining count.

**Include mode**: sort a team's completed matches in scope descending by
effective score; keep the top `count`. If a team has fewer than `count`
real matches, pad the shortfall with synthetic zero-score entries — not
real `ScoreRecord` rows, computed only at ranking-calculation time — so
every team's average is always over exactly `count` matches. Average =
kept sum ÷ `count`. This is what makes the cross-session league case work:
a team that only attended 3 of a 6-event league (18 real matches) against
a league-wide `count` of 24 automatically gets 6 zero-score matches folded
into its average, without any of those being real rows anywhere.

A suggested default `count` is computed by core-server logic (not
declared by the game plugin — this is an admin-facing convenience, not a
game rule) from the total number of qualification matches in scope, using
these tiers: 4–7 matches → 1; 8–11 → 2; 12–15 → 3; 16+ → 4. This is only a
suggestion offered when an organizer sets up `RankingConfiguration` for a
division — they can always enter a different `count` directly, and nothing
enforces the tiers afterward.

## 8. Cross-session (event-wide / league) ranking

A new function, `recompute_event_rankings(db, plugin, event_id,
division_id)`, computes a `Ranking` row with `session_id = NULL` for every
team, aggregating across **every session in the event** — not just one.
It applies the exact same `cooperative_score` per-alliance effective-score
crediting as `recompute_rankings` (§5), and the same `RankingConfiguration`
exclude/include logic (§7), just over the union of completed matches from
every session in the event instead of one session's matches.

This function is called *in addition to* the existing session-scoped
`recompute_rankings`, whenever a `cooperative_score` match's score is
submitted — never for `head_to_head`, which has no cross-session ranking
concept at all, per its own comparison-based model not needing one.

`GET /api/rankings` gains a way to request the event-wide view instead of
a specific session's: a new `event_wide: bool = False` query parameter.
When `true`, `session_id` is ignored entirely (no `get_session_id`
resolution) and the query returns the `Ranking` rows where `session_id IS
NULL` for the given `division_id`.

## 9. Conformance tooling updates

- `_check_match_format` (in `plugin_registry/conformance.py`) adds
  `"game_model"` to its required-keys set, and checks its value is one of
  `{"head_to_head", "cooperative_score"}` — the same pattern already used
  for validating `data_type`/`widget`/`scope` against fixed value sets in
  `_check_scoresheet_schema`.
- `_check_rank_teams` needs the plugin's declared `game_model` to know
  which sample `team_results` shape to build (the two shapes from §5).
  This requires `_run_game_checks` to capture `match_format()`'s actual
  return value once (not just the `CheckResult` from `_check_match_format`)
  and thread `game_model` through to the `rank_teams()` check — an
  implementation detail the plan will spell out exactly, not a new
  conformance-tool behavior beyond "pick the right sample shape."
- A new fixture plugin, `tests/fixtures/plugins/games/cooperative-game/`
  (name chosen to be self-describing without implying any specific
  real-world game), declaring `alliance_count: 2`, a small
  `teams_per_alliance`, `game_model: "cooperative_score"`, with a
  `calculate_score()` / `validate()` / `rank_teams()` implementation
  exercising the `cooperative_score` path end-to-end, mirroring how
  `example-game` exercises `head_to_head` today. This is what the
  conformance, `create_match`, scheduling, scoring-mirroring, and ranking
  tests in the implementation plan actually run against.

## 10. Testing

- Existing `head_to_head` test coverage (Phase 2-4's full suite) must pass
  unchanged — every change in this spec is additive or newly-branched for
  `cooperative_score`, not a behavior change for the existing
  `example-game` path.
- New tests: `create_match` rejects an alliance count that doesn't match
  the event's game plugin's declared `alliance_count`; submitting a score
  to one alliance of a `cooperative_score` match mirrors the data (not the
  flags) onto the other alliance and completes the match; a post-hoc `dq`
  submitted to one alliance zeroes only that alliance's effective score
  while the other alliance's stands; `recompute_rankings`'s
  `cooperative_score` branch produces the correct average-score ranking
  for a hand-computed multi-match scenario including a DQ and a no-show
  (mirroring Phase 3's hand-verified `head_to_head` ranking test);
  `RankingConfiguration`'s exclude mode correctly skips a protected
  (non-drop-eligible) bad match; include mode correctly zero-pads a team
  with fewer real matches than `count`; `recompute_event_rankings`
  aggregates correctly across multiple sessions in one event; conformance
  checks correctly validate (and reject malformed) `game_model`
  declarations and branch `_check_rank_teams`'s sample shape correctly.

## 11. Deferred / open items

- **Elimination brackets and the score-chase finals format** — Phase 6,
  built on this corrected foundation. The design discussion that surfaced
  this phase's scope (captain-pick vs. seed-pairing alliance formation,
  the single-elimination bracket tree, the score-chase sequential format,
  `FinalsBracket`/`BracketAlliance`/`BracketMatchup`/`FinalsResult`, and
  the higher-seeded-alliance-gets-red convention for both finals formats)
  is preserved for that phase's own spec, not repeated here.
- **Alliance counts other than 2** — no current game family needs this;
  the wiring in §3 is generic, but nothing exercises a different count in
  this phase.
- **Per-team-distinct scoresheet values** — confirmed not needed; see §1.
- **A per-session `RankingConfiguration` distinct from the event-wide
  one** — this phase deliberately uses one configuration per
  `(event, division)` for both scopes (§7); a future need for genuinely
  different exclude/include rules at the single-session level versus the
  league level would be a real design change, not assumed here.
