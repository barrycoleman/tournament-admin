# Finals & Elimination Brackets — Design Spec

Status: approved for planning
Date: 2026-08-31

**Revision note (2026-08-31, second pass):** §§2-3 and §5 (the contract
additions, shared alliance-formation foundation, and score-chase engine)
were implemented and merged as "Phase 6a" before this revision. This
revision covers "Phase 6b": the single-elimination engine (§4), plus three
additions found necessary once real usage surfaced gaps Phase 6a's own
final review caught — none of these were in the original scope, and none
apply to the already-shipped score-chase engine:

- §3 gains `BracketAlliance.unavailable`, consulted only by §4's walkover
  logic (score-chase already has a working "unavailable" story via the
  existing `no_show` scoring flag — see §5 — because a run's `Match`
  always exists by the time it's that alliance's turn; a single-elimination
  matchup several rounds deep may have no `Match` yet when a team
  withdraws, so it needs its own advance-marking mechanism).
- §6 gains `DELETE /api/finals/{id}` and
  `POST /api/finals/{id}/alliances/{alliance_id}/unavailable`.
- §6's `POST /api/finals/start` gains an upfront team-sufficiency check for
  `captain_pick` brackets (previously only the `N` captains were validated
  as available, not the additional `N` partners the bracket structurally
  needs) — this closes a gap that applies to a `captain_pick` bracket of
  either finals format, not just `single_elimination`.
- `wins_to_advance` becomes a **per-round** value instead of one flat
  value for the whole bracket (e.g. best-of-1 for every round except a
  best-of-3 final) — originally deferred in §1/§9, added now since the
  marginal cost is low while this phase is already building the
  series-decision logic that needs to consult it.

Phase 6a also left `wins_to_advance` accepted by `POST /api/finals/start`
but silently discarded (hardcoded to `1`) — score-chase never uses it,
and no implementation of `single_elimination` existed yet to consume it.
This revision makes it real: required and validated when the game's
`finals_format` is `single_elimination`, per the per-round shape below.

## 0. Project constraint

Nothing in this project's code, comments, documentation, file names, or
user-facing text may reference any real-world competition brand or product
name. All descriptions in this spec are written in neutral/generic terms for
that reason, even where they describe a specific closed-source reference
product's behavior.

## 1. Purpose & scope

This spec covers **Phase 6**: the finals stage of a division, built on the
`alliance_count`/`game_model` foundation from Phase 5. It defines two
genuinely different finals formats, since the two game families this
project supports need them:

- **Single elimination** — an adversarial (`head_to_head`) bracket tree:
  fixed 2-team alliances, best-of-`wins_to_advance` series per matchup,
  losers eliminated, one alliance left standing.
- **Score chase** — a sequential, non-adversarial (`cooperative_score`)
  format: fixed 2-team pairs run one at a time in ascending qualifying
  order (worst seed first, best seed last — so the top seed gets the last
  attempt at the standing record), each producing one score, final
  placement by score achieved. No bracket tree, no eliminations, no
  `wins_to_advance`.

Both formats share one thing structurally: forming a **persistent 2-team
pair** before the format-specific stage begins — a fixed alliance that
competes as a unit for the rest of the finals stage, formed once via
either a captain-pick process or automatic seed-based pairing. This is
true regardless of whether the underlying game's qualification stage uses
`teams_per_alliance = 1` (`cooperative_score`, per Phase 5's concrete
example) or `teams_per_alliance = 2` (`head_to_head`) — a finals pair is
always exactly 2 teams, a deliberate scope decision (not a general
N-team-alliance mechanism) since both game families examined so far use
pairs.

In scope:
- `match_format()` contract additions: `alliance_selection` and
  `finals_format`.
- Persistent finals-alliance formation: captain-pick or seed-pairing.
- The single-elimination bracket: seeding with byes, per-game series
  progression, walkovers for unavailable entrants.
- The score-chase sequence: run ordering, just-in-time run creation,
  final-score ranking.
- Field allocation for dynamically-created finals matches: a bracket runs
  on one fixed `FieldSet`, round-robining its fields as matches are
  created one at a time.
- Endpoints to start finals, run the captain-pick flow, and read bracket
  state.
- Integration with the existing score-submission endpoint.

Explicitly out of scope / deferred:
- **Double elimination** — single elimination only. A loser's-bracket
  format is a materially bigger problem (this was the reason Phase 6 was
  split out from Phase 5's original brainstorm in the first place) and
  isn't needed by either game family currently in scope.
- **Captain decline/backout** during the pick process — captains pick in
  strict seed order with no mechanism to decline a pick and cede the slot,
  a real feature of some real events that's out of scope here.
- **Multi-division finals collisions within one session** — the same class
  of gap already documented as a known, deliberate limitation for
  qualification scheduling (Phase 4's spec/CLAUDE.md); not solved here
  either.
- **Per-round `wins_to_advance` in a `score_chase` bracket** — meaningless
  there (no series, no rounds in that sense) and stays that way; the
  per-round shape (§3, §4) is `single_elimination`-only. (Per-round
  variation *within* `single_elimination` is no longer deferred — see §3.)
- **WebSocket broadcast** of newly-created matches — the master spec's
  real-time design (§6) explicitly calls out "a freshly generated
  elimination match appears instantly" as a WebSocket concern; this phase
  builds the server-side trigger (a match is created the instant it's
  determined), ready for a future WebSocket layer to broadcast, but
  doesn't build WebSockets themselves.
- Any UI. This spec defines core-server logic and REST behavior only.

## 2. `match_format()` contract additions

Two new required keys, alongside the existing `alliance_count`,
`teams_per_alliance`, `game_model`, `autonomous_seconds`, `driver_seconds`,
`round_types`:

- `alliance_selection: "captain_pick" | "seed_pairing"` — how a finals
  pair forms. `captain_pick`: the top-`N` seeds become captains in strict
  seed order, each picking one partner from the remaining eligible teams.
  `seed_pairing`: pairs auto-form from adjacent seeds (1+2, 3+4, ...), no
  selection step at all.
- `finals_format: "single_elimination" | "score_chase"` — which
  format this game's finals use. Independent of `alliance_selection` in
  the contract (a game could in principle combine either value with
  either format), even though in practice each concrete game family
  examined so far pairs one specific combination.

Both are required, no default — consistent with this project's "every
declared key must be present" conformance philosophy. `example-game`
(`head_to_head`) declares `alliance_selection: "captain_pick"`,
`finals_format: "single_elimination"`. The `cooperative-game` fixture
(`cooperative_score`) declares `alliance_selection: "seed_pairing"`,
`finals_format: "score_chase"`.

## 3. Shared data model: forming a persistent finals pair

- **`FinalsBracket`** — `id, session_id, division_id, field_set_id, format
  ("single_elimination" | "score_chase"), bracket_size (N), wins_to_advance
  (meaningful only for "single_elimination"; ignored for "score_chase"),
  status ("selecting_alliances" | "in_progress" | "complete")`. One row
  per division per finals run. `wins_to_advance` is stored as a JSON-
  encoded list of ints, one entry per round (`total_rounds =
  log2(next_power_of_2(bracket_size))`), the same JSON-as-text pattern
  `ScoreRecord.data_json` already uses elsewhere in this codebase — index
  0 is round 1, the last index is the final round. `POST /api/finals/start`
  (§6) accepts either a single int (expanded server-side into a uniform
  list of the right length) or an explicit list of exactly `total_rounds`
  entries — e.g. `[1, 1, 1, 2]` for a 4-round bracket where every round is
  best-of-1 except a best-of-3 final. `field_set_id` is fixed for the
  bracket's
  entire lifetime — a finals bracket runs as one sequence on one set of
  fields, unlike qualification scheduling, which deliberately spreads
  across multiple *concurrently*-running field sets (§9's cross-division
  collision caveat is the qualification-side version of the same
  "concurrent field sets" idea; a finals bracket sidesteps it by using
  exactly one).
- **`BracketAlliance`** — `id, bracket_id, seed (1..N), unavailable (bool,
  default false)`. A persistent finals pair, distinct from the existing
  per-match `Alliance` model (which stays exactly as-is — a finals
  *game*/*run* still creates real `Alliance`/`AllianceTeam` rows the same
  way a qualification match does, snapshotting the `BracketAlliance`'s
  current team roster at the moment each game/run is generated).
  `unavailable` is consulted only by §4's single-elimination walkover
  logic — a whole-pair flag (not per-team), since a finals pair competes
  as one inseparable unit everywhere else in this design; if one team of
  a pair can't compete, the pair forfeits as a unit, not with one team
  playing alone.
- **`BracketAllianceTeam`** — `id, bracket_alliance_id, team_id`. Always
  exactly 2 rows per `BracketAlliance` once formation completes (captain +
  partner, or the two seed-paired teams).

**Starting a bracket**: an admin picks `session_id, division_id,
bracket_size (N)`, and — only when `format == "single_elimination"` —
`wins_to_advance`. The top `N` seeds come from that division's current
qualification `Ranking` (the ordinary, already-existing session-scoped or
event-wide ranking, whichever the organizer's event structure uses).

`field_set_id` is picked the same way Phase 4's `POST /api/fields` already
auto-defaults: omit it and the session's one existing `FieldSet` is used
automatically; if the session has more than one `FieldSet`, it must be
specified explicitly (422 if omitted and ambiguous). Unlike qualification
scheduling, a finals bracket never auto-creates a default `FieldSet` on
your behalf — by the time finals start, the session's fields are already
set up from running qualification matches on them.

- If `alliance_selection == "seed_pairing"`: all `N` `BracketAlliance` rows
  form immediately from adjacent seed pairs (1+2, 3+4, ...; this needs
  `2N` ranked teams total, but `N` itself has no parity requirement — an
  odd `N` is perfectly valid, e.g. 3 alliances from 6 teams), and the
  bracket moves straight to `"in_progress"`.
- If `alliance_selection == "captain_pick"`: only the `N` captain
  placeholders exist at first (one `BracketAlliance` per captain, with
  only the captain's own `BracketAllianceTeam` row); the bracket stays in
  `"selecting_alliances"` until every captain has picked a partner, in
  strict seed order — the next pick is always the lowest-seeded captain
  who hasn't picked yet, and a captain may only pick from teams not
  already on any `BracketAlliance` in this bracket. Once the last pick
  completes, the bracket moves to `"in_progress"`.

A `BracketAlliance`'s own seed for `single_elimination`'s tree-seeding
math (§4) or `score_chase`'s run order (§5) is the **better** (lowest
qualification-rank-numbered) seed among its two teams — the captain's
seed for `captain_pick`, or the lower of the two paired seeds for
`seed_pairing`.

**Field assignment**: both formats create `Match` rows one at a time as
the bracket/sequence progresses (§4, §5), rather than in a single batch
the way qualification scheduling does — but the assignment mechanism is
the same one Phase 4 already uses, just invoked once per match instead of
once per batch: the bracket tracks a running "next field index" into its
`field_set_id`'s `Field` rows (ordered by `id`, matching Phase 4's
existing convention), and each newly-created match gets the next field in
that rotation, wrapping back to the first field once every field in the
set has been used once. A `FinalsBracket` with only one `Field` in its
`field_set_id` simply reuses that one field for every match, which is
correct and expected for a small event.

## 4. Single-elimination bracket

Standard single-elimination seeding: `N` `BracketAlliance` entrants are
placed into a tree sized to the next power of two, with top seeds
receiving byes in round 1 if `N` isn't already a power of two, so round 2
onward is always a clean bracket. `BracketMatchup` (`id, bracket_id,
round_number, position, alliance_a_id (nullable), alliance_b_id
(nullable), winner_alliance_id (nullable)`) represents one bracket-tree
cell; which matchup feeds which is computed from `round_number`/`position`
arithmetic (a matchup at `(round, position)` feeds the winner into
`(round + 1, position // 2)`), not stored as an explicit pointer.

**Seeding-with-byes construction**: entrants are assigned to tree
positions via the standard recursive bracket-seeding order — `order(1) =
[1]`; `order(2k)` is built by taking each seed `s` in `order(k)` in turn
and emitting `s` followed by `capacity + 1 - s` (`capacity` = the final
bracket size). For a capacity-8 bracket this produces `[1, 8, 4, 5, 2, 7,
3, 6]`, i.e. round-1 pairs `1v8, 4v5, 2v7, 3v6` — the standard seeding
every bracket sport uses, so the best seeds face the weakest opposition
first. A seed number beyond `N` (there is no entrant) is a bye. All
`BracketMatchup` rows for every round are created upfront with whichever
sides are already known from this placement; any round-1 matchup with one
real entrant and one bye resolves immediately (`winner_alliance_id` set to
the real entrant, zero games played), and that resolution cascades forward
through the tree — a matchup whose newly-known side is itself a
just-resolved bye is resolved the same way, repeated until no further
byes cascade — before any real `Match` is created for anything.

**Game-by-game series progression**: rather than creating an entire
best-of-`wins_to_advance` series upfront, only the next needed game is
created:

- The moment both sides of a `BracketMatchup` are known (either from
  initial seeding/bye resolution, or from an earlier matchup's winner
  being placed here) — and neither side is currently `unavailable` (see
  below) — its first game is created immediately — a real `Match`
  (`round_type: "elimination"`, `bracket_matchup_id` set) with two
  `Alliance` rows snapshotting each `BracketAlliance`'s current team
  roster.
- After each game's scores are recorded, count that matchup's decided
  games so far: a **tied** game's alliance scores don't count toward
  either side's series win count (the series simply continues — an extra
  game beyond the theoretical minimum is generated the same way any other
  game is, no special-casing needed). Once one side reaches that
  matchup's `round_number`'s entry in the bracket's per-round
  `wins_to_advance` list (§3) — e.g. a matchup in the final round needs
  more wins than one in round 1 of a bracket configured `[1, 1, 1, 2]` —
  the matchup is decided: `winner_alliance_id` is set, and that alliance
  is placed into the next round's matchup — whose first game is then
  created immediately if its other side is already known too (and not
  itself `unavailable`).
- The bracket's final matchup (the one whose winner feeds no further
  matchup, i.e. the highest `round_number`) being decided moves the whole
  `FinalsBracket` to `"complete"`.

**Walkovers**: `POST /api/finals/{id}/alliances/{alliance_id}/unavailable`
(only valid while the bracket is `"in_progress"`) sets
`BracketAlliance.unavailable = true` and immediately re-checks that
alliance's current matchup, however far the bracket has progressed:

- If the matchup's opponent side is already known (whether or not a game
  has already been played in this series — a mid-series withdrawal
  forfeits the remainder of the series the same as one that never
  started), the matchup is decided in the opponent's favor right away,
  with no further games, and the winner is placed into the next round
  exactly as an ordinary decision would be. If the current game in that
  series already exists as a `Match` but hasn't been scored yet, it's
  left as-is (`status` stays whatever it was) rather than deleted or
  force-completed — it simply becomes an inert, unscored artifact of a
  matchup that resolved before it was played, the same way a bye leaves
  no `Match` at all for the round it skipped.
- If the matchup's opponent side isn't known yet (this alliance is
  waiting on an earlier round to finish), nothing resolves immediately —
  the flag is simply set, and is checked at the moment this matchup would
  otherwise get its first game created (the "both sides known" check
  above also checks `unavailable`); if the alliance is still marked
  unavailable at that point, the matchup resolves as a walkover then
  instead of a game being created.
- Marking the *opponent* of an already-decided matchup unavailable has no
  effect (the matchup is already decided; there is nothing left to walk
  over). Marking an alliance unavailable that has already lost a matchup
  is a no-op for the same reason — it's already out of the bracket.

## 5. Score-chase sequence

No bracket tree, no matchups, no `wins_to_advance`. The `N`
`BracketAlliance` entrants run **one at a time**, in order from the
**worst** qualifying seed to the **best** (so the top seed gets the last
attempt at beating the current record — the framing that motivated this
whole format). Each run is a single, real `Match` (`round_type:
"elimination"`, `finals_bracket_id` set, no `bracket_matchup_id`) with
**one** `Alliance` row containing both of the pair's teams (the pair
competes as one unit — there's no opponent to mirror against, unlike a
qualification `cooperative_score` match's two separate alliances; a
finals score-chase run bypasses the public `POST /api/matches` endpoint
entirely, created directly by this phase's finals service, the same way
Phase 4's scheduler already bypasses that endpoint's validation for
qualification matches).

- The first alliance's run (worst seed) is created the moment the bracket
  enters `"in_progress"`.
- Once a run's score is recorded, the **next** alliance's run (in seed
  order) is created immediately — matching the "reveal the next one just
  as it's about to happen" principle, even though the run order itself
  never depends on any result.
- Once every alliance has run, the `FinalsBracket` moves to `"complete"`.

**Final standings**: a new `FinalsResult` model (`id, finals_bracket_id,
bracket_alliance_id, score, rank`) — not the existing head-to-head
`Ranking` table, which has no meaning here (no opponent, no win/tie/loss).
Recomputed after every run completes (so partial standings are visible
live as the sequence progresses): rank all alliances that have completed
their run by score, descending; ties broken by the alliance's own bracket
seed (lower seed number wins the tie, the same "trust the earlier-earned
seed" principle used elsewhere in this project, e.g. `tiebreaker_seed`).
An alliance/team marked `unavailable` before its run gets a recorded score
of `0` and is still included in `FinalsResult` (it "ran" a zero, it isn't
simply skipped) — this reuses the qualification score-submission
endpoint's existing `no_show` flag rather than inventing a separate
concept.

## 6. Endpoints

- **`POST /api/finals/start`** — `{session_id, division_id, bracket_size,
  wins_to_advance, field_set_id}` (`wins_to_advance` required only for
  `single_elimination`, per the game's declared `finals_format`; ignored
  otherwise. Accepts either a single int ≥1, expanded server-side into a
  uniform per-round list, or an explicit list of ints each ≥1 whose length
  must exactly equal `total_rounds = log2(next_power_of_2(bracket_size))`
  — 422, naming the expected length, if the list is the wrong size.
  `field_set_id` optional, auto-defaulting to the session's sole
  `FieldSet` — 422 if omitted and the session has more than one).
  Validates the division has at least `bracket_size` ranked teams,
  creates the `FinalsBracket`, and either forms all `BracketAlliance` rows
  immediately (`seed_pairing`) or creates just the captain placeholders
  (`captain_pick`). For `captain_pick`, additionally validates at least
  `2 × bracket_size` teams are checked into the session (via
  `SessionParticipation.checked_in`, scoped to the division the same way
  the qualification-scheduling team pool already is) — `bracket_size`
  captains plus `bracket_size` more teams to be picked as partners — 422
  if fewer, since a `captain_pick` bracket that can't structurally be
  filled would otherwise sit in `"selecting_alliances"` forever.
- **`POST /api/finals/{bracket_id}/pick`** — `{captain_bracket_alliance_id,
  partner_team_id}` (`captain_pick` only). Validates it's that captain's
  turn (the lowest-seeded `BracketAlliance` in this bracket that doesn't
  yet have a partner) and that `partner_team_id` isn't already on any
  `BracketAlliance` in this bracket. Once every captain has picked,
  triggers bracket generation (§4) or the first score-chase run (§5).
- **`GET /api/finals/{bracket_id}`** — current state: `format, status,
  bracket_size`, `wins_to_advance` (always returned as the full per-round
  list, even when the bracket was started with a single-int shorthand),
  the `BracketAlliance` list (with team rosters, seeds, and
  `unavailable`), and either the `BracketMatchup` tree (with each
  matchup's current alliances/winner) or the score-chase run order with
  completed scores/current `FinalsResult` standings, depending on
  `format`.
- **`POST /api/finals/{bracket_id}/alliances/{alliance_id}/unavailable`**
  — `single_elimination` only, only while the bracket is `"in_progress"`.
  See §4's Walkovers subsection for the full resolution behavior.
- **`DELETE /api/finals/{bracket_id}`** — 409 if `status == "complete"`
  (a finished bracket's results are the record of what happened —
  redoing one is a deliberate new `POST /api/finals/start`, not a
  delete-and-retry). Otherwise cascades: the `FinalsBracket` itself, its
  `BracketAlliance`/`BracketAllianceTeam` rows, its `BracketMatchup` rows
  (`single_elimination`) or `FinalsResult` rows (`score_chase`), and every
  `Match`/`Alliance`/`AllianceTeam`/`ScoreRecord` this bracket created —
  mirroring the cascading-delete scope `DELETE /api/schedule` already uses
  for a qualification round.

## 7. Integration with score submission

The existing `POST /api/matches/{id}/alliances/{id}/score` endpoint
(unchanged shape) gains one new branch: when the scored match belongs to
a finals bracket (`Match.bracket_matchup_id` or `Match.finals_bracket_id`
is set), the post-score logic calls finals-progression handling (matchup
decision + next-matchup game creation, or `FinalsResult` recompute + next
run creation) **instead of** the existing qualification-style
`recompute_rankings`/`recompute_event_rankings` calls — a finals match was
never part of a scheduler-generated qualification/practice round to begin
with, so qualification ranking logic doesn't apply to it at all.

## 8. Testing

- New fixture coverage: `example-game` (already `head_to_head`) exercises
  `single_elimination` with `captain_pick`; `cooperative-game` (already
  `cooperative_score`) exercises `score_chase` with `seed_pairing`.
- Field assignment: a bracket with 2+ fields in its `field_set_id` round-
  robins across them correctly as matches are created one at a time; a
  bracket on a single-field `FieldSet` reuses that one field for every
  match; `POST /api/finals/start` auto-defaults `field_set_id` correctly
  when the session has exactly one, and 422s when it has more than one
  and none was specified.
- Single-elimination: seeding math with and without byes, including a bye
  cascading through two consecutive rounds; a tied game not counting
  toward either side's series win; the next matchup's first game
  appearing the instant both its sides are known (not before); a
  hand-computed full small bracket (e.g. 4 or 8 entrants) traced
  end-to-end.
- Per-round `wins_to_advance`: a single-int start expands to a uniform
  per-round list; an explicit list of the correct length is honored
  per-round (e.g. `[1, 1, 1, 2]` — an early-round matchup decides after
  one win, the final needs two); a list of the wrong length 422s naming
  the expected length.
- Walkovers: an unavailable alliance whose opponent is already known
  resolves immediately, including mid-series (after at least one game has
  already been played); an unavailable alliance whose opponent isn't
  known yet resolves the moment that opponent is determined; marking an
  already-decided matchup's participants unavailable is a no-op.
- Score-chase: run order is strictly worst-seed-first; the next run isn't
  created until the previous one's score is submitted; `FinalsResult`
  ranking and its seed-based tiebreak; an `unavailable` entrant recorded
  as a zero-score run, not skipped (this is score-chase's pre-existing
  `no_show`-based mechanism, unrelated to the new `BracketAlliance
  .unavailable` field, which single-elimination alone consults).
- Captain-pick: turn enforcement (rejecting an out-of-turn pick), rejecting
  a partner already claimed by another alliance, the bracket only leaving
  `"selecting_alliances"` once every captain has picked, and the new
  upfront `2 × bracket_size` checked-in-team sufficiency check (422 when
  short, for both finals formats).
- Seed-pairing: correct adjacent-pair formation, including an odd
  `bracket_size` (e.g. 3 alliances from 6 ranked teams) — `N` has no
  parity requirement, only the underlying `2N` ranked-team count does.
- `DELETE /api/finals/{id}`: full cascade verified (no orphaned `Match`/
  `Alliance`/`BracketMatchup`/`FinalsResult` rows survive), and the 409
  when `status == "complete"`.

## 9. Deferred / open items

- Double elimination, captain decline/backout, multi-division
  same-session collisions, and WebSocket broadcast — see §1. (Per-round
  `wins_to_advance` for `single_elimination` is no longer deferred — see
  §3/§4/§6.)
- Per-team (rather than whole-`BracketAlliance`) unavailability — a pair
  competes and forfeits as one unit throughout this design; a pair with
  only one team able to play isn't modeled.
- **Awards** (master spec §3's `Award` model — name, type, session/division
  scope, recipient) aren't touched by this phase; a finals bracket's
  results are queryable (`GET /api/finals/{id}`, `FinalsResult`) but
  nothing here automatically creates an `Award` record from them.
- **`InspectionRecord`-driven eligibility** (a team that hasn't passed
  inspection shouldn't be seedable into finals) isn't checked here —
  `POST /api/finals/start` trusts the qualification `Ranking` as-is.
