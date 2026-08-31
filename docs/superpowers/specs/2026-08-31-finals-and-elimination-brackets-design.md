# Finals & Elimination Brackets — Design Spec

Status: approved for planning
Date: 2026-08-31

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
- **Per-round `wins_to_advance` variation** (e.g. best-of-1 early rounds,
  best-of-3 finals) — one `wins_to_advance` value for the whole bracket.
- **Multi-division finals collisions within one session** — the same class
  of gap already documented as a known, deliberate limitation for
  qualification scheduling (Phase 4's spec/CLAUDE.md); not solved here
  either.
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

- **`FinalsBracket`** — `id, session_id, division_id, format
  ("single_elimination" | "score_chase"), bracket_size (N), wins_to_advance
  (meaningful only for "single_elimination"; ignored for "score_chase"),
  status ("selecting_alliances" | "in_progress" | "complete")`. One row
  per division per finals run.
- **`BracketAlliance`** — `id, bracket_id, seed (1..N)`. A persistent
  finals pair, distinct from the existing per-match `Alliance` model
  (which stays exactly as-is — a finals *game*/*run* still creates real
  `Alliance`/`AllianceTeam` rows the same way a qualification match does,
  snapshotting the `BracketAlliance`'s current team roster at the moment
  each game/run is generated).
- **`BracketAllianceTeam`** — `id, bracket_alliance_id, team_id`. Always
  exactly 2 rows per `BracketAlliance` once formation completes (captain +
  partner, or the two seed-paired teams).

**Starting a bracket**: an admin picks `session_id, division_id,
bracket_size (N)`, and — only when `format == "single_elimination"` —
`wins_to_advance`. The top `N` seeds come from that division's current
qualification `Ranking` (the ordinary, already-existing session-scoped or
event-wide ranking, whichever the organizer's event structure uses).

- If `alliance_selection == "seed_pairing"`: all `N` `BracketAlliance` rows
  form immediately from adjacent seed pairs (1+2, 3+4, ...; `N` must be
  even), and the bracket moves straight to `"in_progress"`.
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

**Game-by-game series progression**: rather than creating an entire
best-of-`wins_to_advance` series upfront, only the next needed game is
created:

- The moment both sides of a `BracketMatchup` are known (either from
  initial seeding, or from an earlier matchup's winner being placed here),
  its first game is created immediately — a real `Match` (`round_type:
  "elimination"`, `bracket_matchup_id` set) with two `Alliance` rows
  snapshotting each `BracketAlliance`'s current team roster.
- After each game's scores are recorded, count that matchup's decided
  games so far: a **tied** game's alliance scores don't count toward
  either side's series win count (the series simply continues — an extra
  game beyond the theoretical minimum is generated the same way any other
  game is, no special-casing needed). Once one side reaches
  `wins_to_advance` wins, the matchup is decided: `winner_alliance_id` is
  set, and that alliance is placed into the next round's matchup — whose
  first game is then created immediately if its other side is already
  known too.
- A `BracketAlliance` (or one of its teams) marked `unavailable` causes an
  automatic walkover: its matchup is decided in the opponent's favor with
  zero games played, and the opponent advances immediately.
- The bracket's final matchup (the one with no `feeds_into` target, i.e.
  the highest `round_number`) being decided moves the whole
  `FinalsBracket` to `"complete"`.

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
  wins_to_advance}` (`wins_to_advance` required only for
  `single_elimination`, per the game's declared `finals_format`; ignored
  otherwise). Validates the division has at least `bracket_size` ranked
  teams, creates the `FinalsBracket`, and either forms all
  `BracketAlliance` rows immediately (`seed_pairing`) or creates just the
  captain placeholders (`captain_pick`).
- **`POST /api/finals/{bracket_id}/pick`** — `{captain_bracket_alliance_id,
  partner_team_id}` (`captain_pick` only). Validates it's that captain's
  turn (the lowest-seeded `BracketAlliance` in this bracket that doesn't
  yet have a partner) and that `partner_team_id` isn't already on any
  `BracketAlliance` in this bracket. Once every captain has picked,
  triggers bracket generation (§4) or the first score-chase run (§5).
- **`GET /api/finals/{bracket_id}`** — current state: `format, status,
  bracket_size, wins_to_advance`, the `BracketAlliance` list (with team
  rosters and seeds), and either the `BracketMatchup` tree (with each
  matchup's current alliances/winner) or the score-chase run order with
  completed scores/current `FinalsResult` standings, depending on
  `format`.

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
- Single-elimination: seeding math with and without byes; a tied game not
  counting toward either side's series win; a walkover for an unavailable
  entrant; the next matchup's first game appearing the instant both its
  sides are known (not before); a hand-computed full small bracket (e.g.
  4 or 8 entrants) traced end-to-end.
- Score-chase: run order is strictly worst-seed-first; the next run isn't
  created until the previous one's score is submitted; `FinalsResult`
  ranking and its seed-based tiebreak; an `unavailable` entrant recorded
  as a zero-score run, not skipped.
- Captain-pick: turn enforcement (rejecting an out-of-turn pick), rejecting
  a partner already claimed by another alliance, the bracket only leaving
  `"selecting_alliances"` once every captain has picked.
- Seed-pairing: correct adjacent-pair formation, and the 422 case for an
  odd `bracket_size`.

## 9. Deferred / open items

- Double elimination, captain decline/backout, per-round
  `wins_to_advance`, multi-division same-session collisions, and WebSocket
  broadcast — see §1.
- **Awards** (master spec §3's `Award` model — name, type, session/division
  scope, recipient) aren't touched by this phase; a finals bracket's
  results are queryable (`GET /api/finals/{id}`, `FinalsResult`) but
  nothing here automatically creates an `Award` record from them.
- **`InspectionRecord`-driven eligibility** (a team that hasn't passed
  inspection shouldn't be seedable into finals) isn't checked here —
  `POST /api/finals/start` trusts the qualification `Ranking` as-is.
