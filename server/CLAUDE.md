# Server-specific instructions

This is the core tournament server: FastAPI + SQLAlchemy 2.0 + SQLite,
one process and one database file per event. The full architecture is in
`../docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md`;
the root `../CLAUDE.md` has the project-wide constraints (no brand names,
mandatory testing policy) that apply here too.

## Local development

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/ -v
python -m tournament_server.main   # runs the dev server, LAN-reachable on port 8000 (or the next free port)
```

## Layout

- `models/` — one SQLAlchemy model per file, one table each.
- `schemas/` — Pydantic request/response schemas, one file per resource,
  matching the `models/` file it serves.
- `routers/` — one FastAPI `APIRouter` per resource.
- `audit.py` — the only place that knows how audit logging works. It
  hooks in generically via SQLAlchemy mapper events
  (`after_insert`/`after_update`/`after_delete` on `Base`, with
  `propagate=True`), so a new model defined anywhere automatically gets
  audited — nothing needs to call into `audit.py` by hand.
- `db.py` — the SQLAlchemy `Base`, engine/session-factory helpers, and
  `init_db()`. Every model module does `from tournament_server.db import Base`.

## Plugin system

A plugin is a folder — `plugins/<games-or-schedulers>/<name>/` —
containing `manifest.json` (`name`, `version`, `kind`, `display_name`) and
`plugin.py`. Two plugin kinds exist, sharing one generic registry
(`plugin_registry/loader.py`'s `PluginKind`, `load_plugin`,
`discover_plugins`): a **game** plugin (`kind: "game"`, folder
`plugins/games/<name>/`) must define seven module-level functions —
`match_format`, `scoresheet_schema`, `calculate_score`, `validate`,
`rank_teams`, `skills_scoresheet_schema`, `calculate_skills_score` (see
`GAME_PLUGIN_KIND` for the authoritative list, and
`tests/fixtures/plugins/games/example-game/plugin.py` for a complete
working example); a **scheduler** plugin (`kind: "scheduler"`, folder
`plugins/schedulers/<name>/`) must define one — `generate_schedule` (see
`SCHEDULER_PLUGIN_KIND`, and `plugins/schedulers/simple_random/plugin.py`
for a complete working example).

The server scans both `<plugins_root>/games/*/` and
`<plugins_root>/schedulers/*/` at startup (`plugin_registry/discovery.py`)
and also accepts new plugins of either kind at runtime — `POST
/api/plugins/games` and `POST /api/plugins/schedulers` (each takes a zip
with `manifest.json` and `plugin.py` at its root — no wrapping folder). A
newly installed plugin is registered immediately; no restart is needed.
Startup discovery skips a broken plugin folder with a warning rather than
crashing; a zip upload that fails to install is rejected outright with a
409 (name already taken) or 422 (malformed).

Before distributing a plugin, its author should run
`tm test-plugin <path-to-plugin-folder>`, which checks the plugin's
contract and exits non-zero on any failure. It works for either plugin
kind, auto-detected from the plugin's manifest `kind` field: a game
plugin is checked for required functions present, schema shapes valid,
scoring functions deterministic and int-returning, and `rank_teams`
producing a clean 1..N ranking; a scheduler plugin is checked against the
`SCHEDULER_PLUGIN_KIND` contract (`generate_schedule` present and
returning a valid schedule shape). This conformance tool does not yet
check for anything beyond the contract itself (no checksums, no
capability scanning — that hardening is a separate, later phase per the
design spec's §9).

The plugin folder root is configurable via the `TOURNAMENT_PLUGINS_ROOT`
environment variable (default `./plugins`, resolved relative to wherever
the process was launched — a known packaging-phase gap, see the design
spec's §10). The registry holds at most one active version per plugin
`name`; installing a zip whose `name` is already installed is rejected
(409), and there is currently no uninstall/replace endpoint — swapping
or removing an installed plugin is a manual filesystem operation on the
plugins directory today.

Every key in a `scoresheet_schema()`/`skills_scoresheet_schema()` field
dict must be *present*, even when its value is `None` — e.g. a
non-enum field still needs `"options": None`, not an omitted `options`
key. This is what the conformance tool and the loader both check for;
see `tests/fixtures/plugins/games/example-game/plugin.py` for the
pattern every field in that fixture follows.

## Teams & divisions

A Team's `number` is unique within its event — a real
`uq_teams_event_number` constraint on `(event_id, number)`, not just an
application-level check. Every write path that can violate it (`POST
/api/teams`, `PATCH /api/teams/{id}`, and the bulk upsert below) wraps its
`db.commit()` in a `try/except IntegrityError` that rolls back and raises
a `409 Team number already in use`, so a duplicate number is never a raw
`500` — including when two concurrent requests both pass their
pre-commit lookup and only one can actually commit.

`POST /api/teams/bulk` is the roster-editing endpoint the admin UI's grid
saves through, and its contract is deliberately per-row: it always returns
`200`, with one result entry per submitted row (`created`, `updated`, or
`error` plus a message) — one bad row never fails the others, and the good
rows are still committed. It upserts by team **number**, not by id, so a
row whose number already exists updates that team instead of creating a
second one (`number`/`name` are stripped of surrounding whitespace before
both the lookup and the write, so a pasted `"1234A "` matches the existing
`"1234A"`). A row's `division` is matched to an existing division by name,
case-insensitively; an unknown name is that row's error, not a request
failure. A row can instead set `assign_random_division: true` to have the
server pick a division for it.

`services/team_assignment.balanced_assign` is the single implementation
behind every random assignment — the bulk endpoint's per-row
`assign_random_division`, and both scopes of the randomize endpoint. It is
not round-robin: it shuffles the teams *and* the divisions, then walks the
teams in that order assigning each to whichever division currently has the
fewest teams, counting as it goes. Starting from an already-lopsided
roster it therefore fills the small divisions first and converges sizes to
within one of each other, and the division shuffle makes ties break
randomly rather than always favoring the first-listed division.

`POST /api/divisions/randomize` takes a `scope`: `"unassigned"` only
touches teams whose `division_id` is null, leaving every existing
placement alone (what the "randomly assign unassigned teams" button
calls); `"all"` reassigns every team in the event from scratch, ignoring
where they currently are (what the admin UI offers after a division is
added or deleted).

## Match & scoring

An Event selects exactly one game plugin via `POST /api/event/game-plugin`
— immutable once set. A Match has Alliances (created together via `POST
/api/matches`), with the count determined by the game plugin's declared
`alliance_count` (both shipped game plugins currently declare 2). Each
alliance holds one or more Teams through the `alliance_teams` join table.
`POST /api/matches/{id}/alliances/{id}/score` runs the event's plugin's
`validate()` (blocking on violations unless `force: true` is passed) and
stores the raw scoresheet as JSON — an alliance's actual score is always
*derived* via `calculate_score()`, never stored redundantly, so it can never
go stale relative to the plugin's logic. A Match becomes `"completed"` once
every Alliance has a saved `ScoreRecord`, which triggers a ranking recompute
for its session/division.

Win-point allocation (2/1/0 for win/tie/loss) and strength-of-schedule
(sum of opponents' current win points) are computed by the core server,
not the plugin — see `services/ranking.py`. The plugin's `rank_teams()`
only receives those pre-computed numbers plus each team's
`tiebreaker_seed` and handles the final sort/tiebreak. This is narrower
than the design spec's §5.1 prose ("win-point allocation" as something
`rank_teams` does), but matches the plugin interface actually built and
tested in Phase 2 — see that phase's plan for the reasoning.

A game plugin declares `game_model` in `match_format()`: `head_to_head`
(everything above — adversarial alliances, win/tie/loss ranking) or
`cooperative_score` (alliances share one combined outcome, no winner,
ranking is by average score — see the next section). `alliance_count`
(also declared in `match_format()`) is read everywhere a match's alliance
count matters — `POST /api/matches`, the scheduler-plugin contract, and
`POST /api/schedule`'s structural validation — instead of being hardcoded,
even though both game models shipped so far declare `alliance_count: 2`.

Every list/read endpoint that's scoped to a session (`GET /api/matches`,
`GET /api/rankings`) takes an explicit `session_id` query parameter,
defaulting to `Event.active_session_id` via the shared
`deps.get_session_id` dependency when omitted.

No-show/DQ handling: an alliance's effective score is `0` wherever it
matters (the score-submission response, ranking computation) when its
`ScoreRecord.no_show` or `.dq` is set — this zeroing is core-server logic,
never passed into the plugin's `calculate_score()`.

## Cooperative scoring

A `cooperative_score` match's alliances aren't adversarial — they share
one physical outcome. Submitting a score to either alliance via the
existing scoring endpoint mirrors the raw scoresheet data (not the
`no_show`/`dq`/`sitting` flags) onto the match's other alliance, so both
end up scored identically unless one is independently marked `no_show` or
`dq` afterward (a post-hoc DQ ruling is just a second submission directly
to that one alliance with `dq: true` — see `routers/scores.py`'s
`submit_score`).

Qualification ranking for `cooperative_score` is average score, not
win/tie/loss — each alliance in a completed match is credited
independently to its own member teams (so a DQ'd alliance's teams get `0`
for that match while the other alliance's teams keep their real score).
`Ranking.average_score`/`matches_played` hold this; `win_points`/
`strength_of_schedule` stay at their defaults and are meaningless for this
game model. A game plugin's `rank_teams()` receives a different
`team_results` shape depending on its declared `game_model` — see
`services/ranking.py`'s `_compute_cooperative_score_team_results`.

`RankingConfiguration` (`POST`/`GET /api/ranking-configuration`, one per
event/division) lets an organizer exclude a team's lowest N matches or
keep only their highest N (zero-padding the shortfall if they played
fewer than N), with separate toggles for whether `no_show`/`dq` matches
are eligible to be excluded. It's consulted only for `cooperative_score`
ranking — `head_to_head` has no concept of dropping a match.
`services/ranking.py`'s `suggest_exclusion_count(total_matches)` computes
the spec's tiered default suggestion for that exclusion count, but it's a
pure function that no endpoint calls yet — a future UI or endpoint would
need to invoke it explicitly rather than assuming the server already
applies it as a default.

`GET /api/rankings?event_wide=true` returns standings aggregated across
every session in the event (a `Ranking` row with `session_id: null`),
recomputed alongside the normal per-session ranking whenever a
`cooperative_score` score is submitted or a schedule is cleared. This is
what makes a multi-session league's overall standings work; `head_to_head`
never populates this (`recompute_event_rankings` no-ops for it).

## Finals

A game plugin declares `alliance_selection` (`captain_pick` or
`seed_pairing`) and `finals_format` (`single_elimination` or
`score_chase`) in `match_format()`. A finals pair is always exactly 2
teams, persistent for the whole finals stage, regardless of the game's
qualification-stage `teams_per_alliance` — formed once via `POST
/api/finals/start` (immediately, for `seed_pairing`) or via a sequence of
`POST /api/finals/{id}/pick` calls in strict seed order (for
`captain_pick`).

`single_elimination` brackets use `BracketMatchup` (`id, bracket_id,
round_number, position, alliance_a_id, alliance_b_id, winner_alliance_id`)
for the tree — which matchup feeds which is computed from
`round_number`/`position` arithmetic (`(round, position)` feeds into
`(round + 1, position // 2)`), never stored as an explicit pointer.
Seeding uses the standard recursive tournament-bracket order
(`services/finals.py`'s `_seed_order`), with byes going to the top seeds
when `bracket_size` isn't a power of two — byes only ever occur in round
1 (a property guaranteed by `bracket_capacity` always picking the
smallest power of two `>= bracket_size`), so bracket generation resolves
them with a single forward pass into round 2, not a repeated cascade.

A matchup's first game is created the instant both its sides are known
(from seeding, a bye, or an earlier matchup's winner) — `submit_score`
detects `Match.finals_bracket_id` (same as `score_chase`) and dispatches
to `services/finals.py`'s `advance_single_elimination` based on the
bracket's `format`, which counts a
series' decided games (a tie counts toward neither side) against that
round's `wins_to_advance` and creates another game, decides the matchup,
or does nothing if the last completed game wasn't the last one currently
in flight (the same score-correction safety `advance_score_chase` already
has for score-chase). `wins_to_advance` is a per-round list (`POST
/api/finals/start` accepts a single int, expanded uniformly, or an
explicit list whose length must exactly match the bracket's round count)
— e.g. `[1, 1, 1, 2]` for a bracket where every round is single-game
except a best-of-3 final.

`POST /api/finals/{id}/alliances/{alliance_id}/unavailable`
(`single_elimination` only, bracket must be `"in_progress"`) marks a
`BracketAlliance.unavailable` and resolves an immediate walkover if its
current matchup's opponent is already known (mid-series or not);
otherwise the flag is simply checked later, at the moment that matchup
would otherwise get its first game.

`DELETE /api/finals/{id}` cascades the bracket and everything it created
(alliances, matchups or results, matches/alliances/scores) — 409 once the
bracket is `"complete"`, matching `DELETE /api/schedule`'s existing
cascade-delete pattern for qualification rounds.

Starting a `captain_pick` bracket (either format) additionally requires
`2 * bracket_size` teams checked into the session
(`SessionParticipation.checked_in`) — enough for both the captains and
the partners they'll pick — using the same eligible-team-pool query
`routers/schedule.py`'s `generate_schedule` already builds.

A `score_chase` bracket runs its `BracketAlliance` entrants one at a time,
worst seed to best, each as a single solo `Match` (one `Alliance`
containing both of the pair's teams — there's no opponent, unlike a
qualification `cooperative_score` match's two separate mirrored
alliances). The next run is created automatically the moment the current
one's score is submitted (`routers/scores.py`'s `submit_score` detects
`Match.finals_bracket_id` and calls `services/finals.py`'s
`advance_score_chase` instead of touching qualification rankings at all).
Final standings live in `FinalsResult` (score descending, ties broken by
the alliance's own bracket seed) — not the qualification `Ranking` table,
which has no meaning for a format with no opponent.

A finals bracket runs on exactly one `FieldSet` for its entire lifetime
(chosen at `POST /api/finals/start`, auto-defaulting when the session has
only one) — each dynamically-created run round-robins across that set's
fields via `FinalsBracket.next_field_index`, the same algorithm
`routers/schedule.py` uses for qualification, just applied one match at a
time instead of one batch at a time.

**Known, deliberate gap**: `recompute_rankings`/`recompute_event_rankings`
now exclude finals matches (`Match.finals_bracket_id IS NOT NULL`) from
qualification ranking — but they still don't exclude `practice`-round
matches, a pre-existing gap from an earlier phase this plan didn't
introduce and doesn't fix.

## Scheduling

Every Field belongs to exactly one FieldSet (`field_set_id` is required,
never nullable). FieldSets in the same session run concurrently; fields
within one FieldSet process matches sequentially — only one match is ever
active per FieldSet at a time. `POST /api/fields` auto-creates a default
`"Main Fields"` FieldSet when a session has none yet, and requires an
explicit `field_set_id` once a session has more than one (ambiguous
otherwise).

`POST /api/schedule` generates a full practice/qualification schedule for
one `(session_id, division_id, round_type)` combination in a single call,
via a scheduler plugin's `generate_schedule()`. It 409s if matches already
exist for that combination — regenerating requires an explicit
`DELETE /api/schedule` first, which deletes only that combination's
Matches (and their Alliances/AllianceTeams/ScoreRecords) and then
recomputes that division's `Ranking` rows from whatever completed matches
remain — including ones from other, untouched `round_type`s — rather than
leaving them either stale or wiped (a scoped fix for the general
stale-ranking-row cleanup gap noted under Match & scoring above — this
action makes that gap immediately visible, so it's addressed here
specifically). The scheduler plugin
decides who plays whom and which FieldSet/time_slot each match runs in; the
core server assigns `match_number` and the literal `field_id` afterward
(round-robin within each match's FieldSet) — see `services/scheduling.py`
for the cross-session pairing-history query the plugin receives, and
`routers/schedule.py`'s `_validate_generated_schedule` for the structural
checks (correct alliance shape, no team double-booked within a
`time_slot`) applied to whatever the plugin returns, before anything is
persisted — the same validate-before-persist discipline used for score
submission.

Two scheduler plugins ship in this repo, at `plugins/schedulers/`:
`simple_random` (random, no optimization) and `balanced` (avoids repeat
partner/opponent pairings and same-organization pairings using pairing
history from every session in the event, falling back to minimizing the
worst repeat count once every unique pairing is exhausted). Both are real
plugins, not core code — a custom generator can replace either by
following the same `generate_schedule` contract.

Elimination brackets are a separate, later phase — no plugin contract for
bracket progression exists yet.

## Time-based scheduling

`POST /api/schedule` assigns every generated `Match` a real UTC
`scheduled_time`, computed from `time_blocks` — a list of `{start_time,
end_time, cycle_time}` windows (`services/schedule_timing.py`). Each
`start_time`/`end_time` must be a zero-padded `"HH:MM"` string (enforced by
the request schema); blocks must be given in ascending `start_time` order
with no two windows overlapping (422 otherwise). Each block is
independently pinned (`end_time` + `cycle_time` both given, a fixed match
capacity), "calculate for me" (`cycle_time: null`, needs `end_time` to
divide by), or open-ended (`end_time: null`, needs `cycle_time`, must be
the last block, and cannot coexist with a "calculate for me" block — see
`resolve_block_cycle_times`'s validation for why). Multiple "calculate for
me" blocks are apportioned capacity by duration via
`_apportion_time_slots`'s largest-remainder method, which yields the same
computed cycle time across blocks when durations divide the remaining
slots into exact integer proportions; when they don't, integer rounding
can leave blocks with slightly different (but each individually correct)
cycle times.

Cycle time governs the interval between distinct `time_slot`s, not raw
matches — several matches can share one `time_slot` when multiple
`FieldSet`s run concurrently, and they all get the identical
`scheduled_time`.

Omitting `time_blocks` entirely synthesizes one implicit open-ended block
starting five minutes from `utc_now()`, at a cycle time derived from the
game plugin's `autonomous_seconds + driver_seconds` times
`warn_below_multiplier` (default `1.5`) — comfortably above the warning
threshold in the typical case, though rounding at an exact `.5` boundary
can in rare cases still trigger it. This requires no
`session_date`/`timezone` on the session at all; using real `time_blocks`
does, since there's a real calendar window to resolve times against
(`TournamentSession.timezone`, an IANA zone name, alongside the existing
`session_date`).

`ScheduleGenerateResponse.cycle_time_warning` fires when any resolved
block's cycle time is below `match_duration_seconds *
warn_below_multiplier` — informational only, never blocks generation.

All `time_blocks` are resolved against a single `session_date` — a block
can't span midnight (an `end_time` earlier than its own `start_time` is
rejected as invalid, not treated as spilling into the next day). A block
whose `start_time` falls in a DST spring-forward gap or fall-back overlap
in the session's `timezone` resolves via Python's default (`fold=0`)
rather than raising — not expected to matter for tournament scheduling,
but worth knowing if a session ever spans a DST transition.

## Multi-division scheduling

A `FieldSet` can be assigned exclusively to one `Division` via
`division_id` (set on `POST /api/field-sets`, or changed later via
`PATCH /api/field-sets/{id}` — the request body's `division_id` key is
required, so the caller always states the intended value: an id to
assign, or `null` to clear). `POST /api/schedule` only ever draws its
FieldSets/Fields from this assignment: a division-scoped generation
(`division_id` given) only considers that division's own FieldSets; a
no-division generation (`division_id` omitted) only considers unassigned
FieldSets. This is what lets two Divisions in the same Session each
generate their own schedule without colliding on physical fields — each
division's `time_slot` numbering is independent, and overlapping
`time_slot` values across divisions are correct and expected once their
fields are disjoint (that's parallel fields working as designed, not a
collision). `time_blocks`/cycle-time resolution needed no changes either,
since it was already scoped per generation call; only the FieldSet lookup
itself was blind to which division a call was for.

A FieldSet's single nullable `division_id` makes true double-assignment
structurally impossible — reassigning it after the fact only affects
which *future* generation call will consider that FieldSet, never any
already-created `Match`. `POST /api/finals/start` enforces the same
guarantee as `POST /api/schedule`: an explicit `field_set_id` must have
the exact same `division_id` as the request (including `null` matching
`null` for a no-division bracket), and its own auto-select path (when no
`field_set_id` is given) is filtered by division the same way.

## Scoring device admission

A `ScoringDevice` (`POST /api/devices/register` — no auth required,
matching `POST /api/auth/login`'s bootstrap-endpoint status) self-registers
and gets a persistent, human-friendly random name (`shifty-squirrel`-style,
adjective-animal) plus a browser-storable `device_token`; it starts
`pending`. An admin reviews `GET /api/devices` and calls
`POST /api/devices/{id}/admit` (or `.../revoke` to un-admit). This is a
distinct, additional layer on top of role-based auth (see
`docs/superpowers/specs/2026-09-03-real-authentication-design.md`), not a
replacement for it: role auth gates *whether a caller can act at all*;
device admission gates *whether score-writes count as coming from a
trusted, admin-vetted device* and attributes them to a real name instead
of the spoofable `X-Actor-Name` header.

Admission has no stored status enum — `admitted_at is not None AND (now -
last_seen_at) < idle_timeout` is computed at every point of use (list,
enforcement), mirroring `AuthSession`'s existing lazy-expiry pattern; no
background job sweeps expired admissions. `last_seen_at` is kept current
by a request-level middleware (`app.py`) that touches it on any
*successful* request carrying a valid `X-Device-Token`, not just scoring
ones — so the idle-timeout (`TOURNAMENT_DEVICE_IDLE_TIMEOUT_MINUTES`,
default 60) reflects real device activity. Making the touch conditional
on success alone isn't enough, though: `require_admitted_device` only
gates the one scoring endpoint, so an ordinary successful `GET` would
otherwise silently revive an already-idle device with no admin action —
`touch_device_activity` (`device_auth.py`) additionally refuses to
refresh `last_seen_at` for a device that is admitted but currently *not*
within its idle window, so "idle" stays a true one-way gate only an
explicit `admit` (which also refreshes `last_seen_at`) can reopen.
`admit`/`revoke` each write an explicit `AuditLog` entry too (curated,
not the generic per-column hook — `scoring_devices` stays excluded from
that so `device_token_hash` never leaks into the log), since revoking
would otherwise erase the only record a device was ever admitted.

`require_admitted_device` (`device_auth.py`) is applied only to
`POST /api/matches/{id}/alliances/{id}/score`, in addition to the existing
`require_scorer_or_referee` role gate. `admin` bypasses only the
*rejection*, never the *lookup*: a present, currently-admitted device
token still attributes `ScoreRecord.submitted_by_device` to the real
device name even for an admin caller, but an admin is never blocked by a
missing/invalid/un-admitted one — every other role is. Every caller that
never sends `X-Device-Token` (including all pre-device-phase tests) keeps
falling back to today's `audit.current_actor.get()`-based attribution,
unchanged.

`Device`/Pi-display admission (the master spec's other, separate device
concept — admin-driven, for unattended kiosk displays) is not built —
still a distinct, later phase. The WebSocket "active-session" push
mechanism it needs now exists (see *Real-time channels and live match
control* below), so a Pi client is the only remaining prerequisite. See
`docs/superpowers/specs/2026-09-08-scoring-device-admission-design.md`.

## Real-time channels and live match control

See
`docs/superpowers/specs/2026-09-11-realtime-websockets-design.md`.
Two WebSocket channels push state to clients; everything a client *does*
still goes through REST, and the socket only ever carries "this changed"
events. A client that just connected (or reconnected) refetches current
state via the existing REST endpoints — `MatchRead` already carries the
live-timing fields, so `GET /api/matches?session_id=...` is a complete
bootstrap and there is no bespoke snapshot message type.

```
GET /ws/active-session?token=<jwt>       — any authenticated role
GET /ws/session/{session_id}?token=<jwt> — admin only
```

Both are **receive-only**: the server never inspects an inbound frame,
it just drains them until the client disconnects (`routers/websockets.py`
uses the raw `receive()`, not `receive_text()`, so a binary frame is
tolerated identically rather than raising `KeyError`). Auth is the same
access token `POST /api/auth/login` issues, passed as a **query
parameter** — a browser's native `WebSocket` API cannot set custom
handshake headers, so there is no alternative. **Known, accepted
tradeoff**: that token therefore appears in standard access logs, proxy
logs and browser history in a way a bearer header would not. Not
something this phase tries to fix; a future phase wanting to close it
would need a short-lived single-use ticket endpoint.

`GET /api/time-sync` (no auth, like `/health` and
`POST /api/devices/register`) returns `{"server_time": "<ISO-8601 UTC>"}`
so a client can measure its own clock offset and render a countdown
against absolute deadlines rather than trusting its local clock.

### Event catalog

Envelope is always `{"event": "<type>", "data": {...}}`. These names and
payload keys are the wire contract the Admin UI, scorer/tablet and Pi
display code against, so `tests/test_match_control_endpoints.py` and
`tests/test_broadcast_wiring.py` assert every one of them over a real
`TestClient` WebSocket connection — a typo in a name or key must fail a
test, not ship silently.

Match-control events (payload carries the live state directly, so a
client never needs a REST round-trip to render a countdown tick):

- `match_phase_changed` — `{match_id, phase, phase_deadline}`. Every
  phase transition, manual or automatic, including into `ended`.
- `match_paused` — `{match_id, phase, remaining_seconds_at_pause}`.
- `match_resumed` — `{match_id, phase, phase_deadline}`.
- `match_reset` — `{match_id, phase}` (`not_started` or
  `awaiting_driver`; `phase_deadline` is implicitly null in both).

Structural events (thin — identifying info only; the client refetches
the real data from the existing REST resource, keeping one source of
truth for that richer shape):

- `score_saved` — `{match_id, alliance_id}`.
- `new_match_created` — `{match_id, session_id, division_id, field_id}`.
  Fired for schedule generation *and* for matches a finals bracket
  creates as a side effect (`realtime.broadcast_new_finals_matches`,
  which diffs the bracket's match ids before/after at each of its 4 call
  sites in `routers/finals.py`/`routers/scores.py`).
- `ranking_updated` — `{session_id, division_id, event_wide}`; when
  `event_wide` is true, `session_id` is null, matching the event-wide
  `Ranking` row's own null `session_id`.
- `active_session_changed` — `{active_session_id}`.

Routing: `realtime.broadcast_for_session` always sends on
`session:<id>`, and additionally on `active-session` when that session
*is* `Event.active_session_id` at the moment of the call. Two events
never follow that rule: `active_session_changed` is active-session-only
(it's that channel's own meaning changing), and an **event-wide**
`ranking_updated` is likewise active-session-only — it isn't scoped to
any one session, so it goes out via `broadcast_active_session` directly
and an admin watching only a `session:<id>` channel will never see it.

### Sync-to-async bridge

Every router stays a plain sync `def` (FastAPI's implicit threadpool) —
this phase deliberately did not introduce a mix of styles. Since sending
over a WebSocket is async, `realtime.broadcast_*` bridges with
`asyncio.run_coroutine_threadsafe(coro, loop)` against a loop reference
captured in `create_app()`'s **lifespan** hook, never at `create_app()`
construction time (that runs as plain sync code before Uvicorn's loop
exists). A router therefore just gains one extra plain function call.

The practical consequence for tests: a bare, never-entered `TestClient`
never runs lifespan, so `app.state.realtime.event_loop` stays `None` and
every broadcast silently no-ops. At least one `TestClient` per test must
be entered (`with TestClient(app) as client:`). *Receiving* is not
similarly constrained — Starlette's `WebSocketTestSession` moves frames
through a thread-safe `queue.Queue`, so a connection opened on a second,
even un-entered, client still receives fine.

### Phase state machine and the timer registry

`match_control.py` holds the machine:
`countdown_autonomous → autonomous → awaiting_driver → countdown_driver
→ driver → ended`, entered at `not_started`. A game plugin declaring
`autonomous_seconds == 0` skips straight to `countdown_driver` on
`start`. `COUNTDOWN_SECONDS` is a fixed 3s constant (not
plugin-configurable — no need identified). Six endpoints on the existing
`matches` router drive it, all `require_scorer_or_referee`:
`POST /api/matches/{id}/start`, `.../start-driver`, `.../pause`,
`.../resume`, `.../end`, `.../reset`. `reset` takes
`{"scope": "section" | "full"}` as a `Literal`, so a typo is a 422
rather than silently falling through to the more destructive full reset.

Timed phases auto-advance via `_auto_advance_match`
(`routers/matches.py`), scheduled onto the same captured loop and tracked
per `match_id` in `app.state.match_timers.futures`. Three things make
that registry safe rather than merely best-effort:

- **Deadline identity.** The coroutine captures the `phase_deadline` it
  is sleeping toward *before* sleeping, and re-checks it (alongside
  `paused`) after waking. Anything that changes a match's phase out from
  under a sleeping timer — reset, end, pause/resume, or a duplicate
  transition another timer already applied — also changes or clears
  `phase_deadline`, so every stale or duplicate timer becomes a no-op
  whether or not cancellation fired in time. This is what closes the
  narrow schedule/cancel race where `cancel_auto_advance` pops an
  already-completed future just before that future installs a fresh,
  un-cancelled one.
- **Replacement cancels.** `schedule_auto_advance` cancels whatever
  future it is about to overwrite, and terminal paths in
  `_auto_advance_match` pop their own entry, so the dict doesn't grow
  for matches that simply ran to completion.
- **Nothing fails silently.** The `concurrent.futures.Future` gets a
  done-callback that logs any non-cancellation exception (stdlib
  `logging`, module logger) — nothing else ever calls `.result()` on it,
  so without that a crash in the background coroutine would freeze the
  match in place with no log and no trace. The lookups that could
  plausibly crash it (missing `Event`, cleared/swapped game plugin) are
  guarded with a warning and a clean early return, mirroring
  `_recover_in_flight_matches`.

`_auto_advance_match` opens its DB session, reads what it needs, and
**closes it before sleeping**, then opens a fresh one after waking. A
driver period can run 100+ seconds; holding a `Session` open across that
happens to work on SQLite's default autocommit mode (a bare `SELECT`
takes no lock) but isn't something to depend on.

**Startup recovery** (`app.py`'s `_recover_in_flight_matches`, awaited
inside the lifespan hook so the loop already exists): any match not in
`not_started`/`ended` and not `paused` either gets its auto-advance
rescheduled with only the *remaining* time (deadline still ahead) or is
transitioned once immediately and broadcast (deadline already passed
while the server was down). Deliberately **one** step, not a cascade
through however many phases elapsed, and there is no "the server was
down too long, just end it" threshold — both are spec-level judgment
calls left open.

**Migration note.** `_alembic/versions/9ee2761f45b6_*` adds the four
`Match` columns. `phase` and `paused` are NOT NULL, and SQLite refuses
`ALTER TABLE ... ADD COLUMN ... NOT NULL` without a default, so both
carry a `server_default`. That `server_default` is deliberately left in
place rather than dropped afterward: dropping it on SQLite means
`batch_alter_table` (copy and recreate the whole table), which is more
risk than it's worth, and the model's Python-side `default=` governs
every ORM insert regardless of what the column's DDL default says.

## Database migrations

Real Alembic migrations exist as of this phase (see
`docs/superpowers/specs/2026-09-10-database-migrations-design.md`). A
single baseline migration
(`src/tournament_server/_alembic/versions/`) captures the full schema
exactly as it existed the moment this phase landed — no attempt was made
to reconstruct migrations for any earlier schema shape, since no real
deployed event data has ever existed against one (every prior phase's own
"known gaps" note said the same thing: delete the `.db` file and let
`create_all()` rebuild it). From this point on, every schema change ships
as a real migration in the same commit as the model change that needs it.

`ensure_schema_current` (`migrations.py`) runs automatically on every
`create_app()` call — the real server at startup, and every test fixture
alike, since they share this one entry point. A brand-new database gets
migrated from scratch; an existing pre-Alembic database whose reflected
schema exactly matches today's models gets silently stamped at the
baseline revision (no `CREATE TABLE` re-run against tables that already
exist); a database that's genuinely behind head gets an automatic,
WAL-checkpointed, timestamped backup
(`<db_path>.pre-migration-<timestamp>.bak`) before `alembic upgrade head`
runs; and a pre-Alembic database that doesn't match anything known
refuses to start, with the same "delete the file and let it rebuild"
instruction this project has already given twice. `tm migrate` is the
same check, runnable by hand (useful for scripting or an operator who
wants to migrate before switching versions without starting the server).

Alembic is invoked entirely through its Python API (`alembic.command`),
never by shelling out to an `alembic` binary, and migration
scripts/config are addressed via `importlib.resources` rather than a
path built relative to `__file__` — both deliberate choices so this
works unchanged once PyInstaller packaging (a separate, later phase)
exists, without needing rework then. `tests/test_alembic_drift.py` is
the guard against migrations and models silently diverging: it asserts
that applying only the checked-in migrations produces a schema
byte-for-byte identical (via Alembic's own autogenerate-diff machinery)
to what `Base.metadata` declares — this is what fails, loudly, if a
future phase changes a model without also writing the matching
migration.

## Network binding and discoverability

`python -m tournament_server.main` binds to `0.0.0.0` (all interfaces,
including loopback), not `127.0.0.1` — required by this project's own
LAN-connected-device architecture (scorer tablets, Pi displays), which
loopback-only binding directly contradicted. `TOURNAMENT_HOST`/
`TOURNAMENT_PORT` env vars override the defaults (`Settings.host`/
`Settings.port`, `settings.py`). If the configured port is taken,
`network.py`'s `find_free_port` probes the next 10 ports in sequence
before giving up with a clear `ERROR: no free port in <range> on <host>`
(printed to stderr, non-zero exit) — no raw socket traceback. The actual
bound port (after probing) is threaded into `create_app(port=...)` so
`app.state.port` always reflects reality, never the configured default
alone.

`GET /api/server-info` (admin-only) reports `{"port", "addresses"}` —
`addresses` is this machine's own non-loopback, non-link-local IPv4
addresses (`network.py`'s `enumerate_lan_addresses`, via `psutil`'s
`net_if_addrs()`), with common virtual/container/VPN adapters (`docker*`,
`br-*`, `veth*`, `tun*`, `tap*`, `vmnet*`, `virbr*`, `utun*`, `ppp*`,
`vboxnet*`, `zt*`) filtered out by interface name — a plain
loopback/link-local IP-range filter isn't enough, since a Docker bridge
or an active VPN tunnel both present as ordinary private-range IPv4
addresses that plain range-filtering can't tell apart from the real
venue LAN interface (verified against this project's own dev machine,
which has both). `psutil` was picked over a stdlib-only approach
(hostname-based lookup) specifically because the stdlib approach fails
outright on the common Debian/Ubuntu default of mapping the hostname to
`127.0.1.1` in `/etc/hosts` — not a rare edge case. This is what a future
admin UI uses to show its own LAN-reachable address(es)/port (e.g. as a
QR code) so other devices on the venue network can find it — filtering
is still best-effort and can occasionally miss or include the wrong
interface on an unusual setup.

## Serving the admin UI

`create_app()` serves the built admin UI (`frontend/apps/admin/dist/`,
built separately via `npm run build` — see `frontend/CLAUDE.md`) as
static assets from the same process and port as the API, with an
SPA-fallback route for client-side routing. This is entirely additive
and gated: if the resolved static directory doesn't exist,
`create_app()` mounts nothing extra and behaves exactly as before (no
frontend built yet is the normal state for a fresh checkout, and every
existing test relies on this no-op path still working).

Resolution order: `static_dir` passed to `create_app()`, else
`TOURNAMENT_STATIC_DIR` env var (`Settings.static_dir`), else the
computed default `frontend/apps/admin/dist` (relative to the repo root,
computed from `app.py`'s own path — see `_DEFAULT_STATIC_DIR`). The
`/assets` `StaticFiles` mount only registers if an `assets/` subdirectory
is also present (a `dist/` with only `index.html`, e.g. a partial or
custom build, degrades to "no static JS/CSS served" rather than crashing
the whole server at startup — `StaticFiles.__init__` raises if its
directory argument doesn't exist).

**Registration order matters and is not optional:** the SPA catch-all
(`GET /{full_path:path}`) is registered strictly *after* every other
route, including `/health` — Starlette matches routes in registration
order, not by specificity, so a catch-all registered earlier would
shadow `/health` and any other literal route registered after it. (An
earlier draft of this feature's plan incorrectly assumed FastAPI
prioritizes literal routes over path-converter catch-alls regardless of
order; it doesn't. `test_health_still_works_with_static_dir` in
`test_static_ui.py` pins this.) The catch-all handler also explicitly
404s on any path starting with `api/` or `ws/`, or equal to `health`, as
defense-in-depth — this does not by itself make ordering safe, it only
protects a direct call against this route if something is ever inserted
between it and the routes it must not shadow.

Because `frontend/apps/admin/dist/` may already exist in a working
checkout (from a prior `npm run build`), a plain `create_app()` call with
no explicit override can serve the real built UI even in contexts (like
a quick local test or REPL session) where that isn't expected — there is
no dedicated CI pipeline yet that pins a clean, no-`dist` checkout state.

## Tournament picker

Before any database is chosen, the process doesn't know which `.db` file
to open — that's what the picker layer (`picker_config.py`,
`picker_app.py`, `routers/picker.py`) resolves. Its own small config file
(`PickerConfig`: `allowed_directories`, `last_opened_path`) lives at
`resolve_config_path()` — `TOURNAMENT_CONFIG_PATH` env var if set, else
`~/.tournament-admin/server-config.json` — and is distinct from, and
resolved independently of, the actual tournament database path.

`main.py`'s `_startup()` calls `resolve_active_db_path()` to decide which
app to build: **explicit argument** (a CLI flag, not used by the normal
`python -m tournament_server.main` entry point) wins first, then the
**legacy `TOURNAMENT_DB_PATH` env var**, then the picker config's
`last_opened_path`. That env var predates the picker feature (it's how
every earlier phase — and `playwright.config.ts`'s shared E2E backend —
pins a fixed temp-file database) and deliberately keeps top precedence
over the picker for backward compatibility: a deployment that already
sets `TOURNAMENT_DB_PATH` keeps working unchanged and never sees the
picker at all, even after an admin uses "Switch Tournament" (that action
clears `last_opened_path`, but if `TOURNAMENT_DB_PATH` is still set in
the environment, the next restart resolves right back to it — the env
var, not the picker config, is what actually needs to be unset to make
the picker "stick"). If `resolve_active_db_path()` returns `None`
(nothing resolves), `_startup()` builds the **picker app**
(`create_picker_app()`, only `/api/picker/*` mounted, no event/game
routes) instead of the normal app.

Every picker endpoint that takes a client-supplied path
(`POST /api/picker/create`, `POST /api/picker/open`,
`GET /api/picker/tournaments`) is checked against
`is_path_allowed()` before touching the filesystem — the actual
path-traversal guard, not just a display convenience. It resolves the
candidate path (symlinks followed, `..` normalized) and requires it to
*equal or be nested inside* one of `allowed_directories`'s own resolved
entries; a path that only looks like a prefix textually (e.g.
`/data/tournaments-evil` against an allowed `/data/tournaments`) does not
pass, since containment is checked via `Path.parents`, not string
prefixing. `POST /api/picker/directories` (adding a brand-new top-level
directory — the USB-drive case) deliberately does *not* run this check
against existing entries; it's establishing a new allowed root, not
validating a path against ones already established.

Every action that changes which database the *next* boot should use
(`create`, `open`, and the normal app's `POST /api/picker/switch`) ends
the same way: write the new `last_opened_path` (or, for `switch`, clear
it to `None`) to the picker config, then schedule
`_delayed_restart()` as a `BackgroundTask` and return `202`. That
function only runs after Starlette has already handed the response back
to the client (a `BackgroundTask` starts after the response is sent,
never before) — `os.execve(sys.executable, [sys.executable, *sys.argv],
os.environ.copy())` replaces the running process's image in place, same
PID, same open listening socket, which is what lets the *next* process
boot straight back into `_startup()`'s resolution logic above and land
on whichever app (picker or normal) the just-written config now implies.
There's a short `asyncio.sleep(0.25)` before the `execve` call purely to
give the response time to actually flush to the client first. The admin
UI's `useRestartPoll` (`frontend/CLAUDE.md`) is the client-side half of
riding out this gap.

## Known, deliberate gaps in this phase

- Real authentication now exists — see
  `docs/superpowers/specs/2026-09-03-real-authentication-design.md`. Six
  roles (`admin`, `scorer`, `judge`, `referee`, `attendee`,
  `display_device`) share one password per event until the Admin
  differentiates them; every endpoint requires a bearer JWT via
  `tournament_server.auth.require_role(...)`, with `admin` always
  passing regardless of what a given endpoint's allowed-roles list says.
  The plugin-install endpoints (`POST /api/plugins/games` and
  `POST /api/plugins/schedulers`) are gated `admin`-only like every other
  write in the `plugins` router — but note this is still a
  code-execution primitive available to any admin, not a sandboxed
  install; that hardening (checksums, capability scanning) is still a
  separate, later phase per the design spec's §9. `Device`/
  `ScoringDevice` admission — an *additional* per-device admission layer
  on top of a role's session — remains a distinct, unbuilt future phase
  (design spec §7).
- A Team belongs to at most one Division (nullable `division_id`), not a
  many-to-many relationship, as a deliberate YAGNI simplification — see
  the plan's Global Constraints for why.
- In a single-division event every team keeps `division_id = NULL`
  forever: the admin UI hides the division column, the division filter and
  the assignment controls entirely when only one division exists, so
  nothing ever writes that division's id onto a team. Nothing today cares,
  but a future scheduling sub-project will have to decide whether a null
  `division_id` means "the event's only division" or is a data gap to
  backfill — don't assume the former silently.
- No automated cleanup of `.pre-migration-*.bak` backup files — they
  accumulate; an operator deletes old ones manually. `alembic downgrade`
  is not a supported, tested rollback path — the pre-migration backup is
  the recovery mechanism for a bad migration, not a scripted downgrade.

## Testing

Most tests use the `client` fixture from `conftest.py`, which builds a
fresh `FastAPI` app against a fresh temp-file SQLite database (and an
isolated temp `plugins_root`) per test — never a shared or mocked
database. The fixture also pre-seeds the `example-game` game plugin and the
`simple_random`/`balanced` scheduler plugins into that `plugins_root`
before the app starts, so all three are discoverable at startup like real
installed plugins — tests that need a *different* starting registry state
(e.g. an empty one, or one containing a specific other plugin) should
build their own `create_app()`/`TestClient` instance directly rather than
relying on `client`, the way `test_list_game_plugins_discovers_at_startup`
in `test_plugins_router.py` already does. Follow the `client` pattern for
anything else exercising the HTTP API: real calls through `TestClient`,
real temporary files underneath.

The `client`/`cooperative_client`/`captain_pick_client` fixtures are an
`_AutoAuthTestClient` (see `conftest.py`): on a `POST /api/event` call, if
the request body has no `password`, it silently injects a fixed test
password before sending — which is what lets every pre-existing test
that predates real authentication keep calling `client.post("/api/event",
json={"name": ...})` unchanged. The moment that call succeeds (201), the
fixture transparently logs in as `admin` and pins `Authorization: Bearer
<token>` on that client instance for every request after that — so every
test using these fixtures is implicitly acting as Admin from event
creation onward, with no explicit login call visible in the test body. A
test that needs a different role, no token at all, or to exercise the
bootstrap/login flow itself should not rely on this fixture — build a raw
`TestClient` instead and use `tests/auth_helpers.py`'s `login_as`/`bearer`
helpers to authenticate as whatever role the test actually needs.

`GET /health` is intentionally the only HTTP endpoint with no auth
dependency at all (it's defined directly in `app.py`, not through a
router, and returns only a static status) and is deliberately absent
from the design spec's authorization table — a benign exception, not a
gap.

The `plugin_registry` subpackage also has plain unit tests (e.g.
`test_plugin_manifest.py`, `test_plugin_loader.py`,
`test_plugin_conformance.py`) that call its functions directly against
fixture plugin folders in `tests/fixtures/plugins/games/`, with no
`client`/`TestClient` involved — appropriate for logic that doesn't
touch the HTTP layer at all.
