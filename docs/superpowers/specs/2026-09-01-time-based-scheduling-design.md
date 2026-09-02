# Time-Based Scheduling — Design Spec

Status: approved for planning
Date: 2026-09-01

## 0. Project constraint

Nothing in this project's code, comments, documentation, file names, or
user-facing text may reference any real-world competition brand or product
name. All descriptions in this spec are written in neutral/generic terms for
that reason, even where they describe a specific closed-source reference
product's behavior.

## 1. Purpose & scope

Phase 4 (`docs/superpowers/specs/2026-08-29-qualification-and-practice-scheduling-design.md`)
built schedule generation entirely on an abstract `time_slot` index — a
synchronized round counter with no real-world time attached to it at all.
`Match.scheduled_time` exists as a column but nothing has ever populated
it. This phase closes that gap: an organizer specifies windows of time the
fields are actually available (with an optional pace override per window),
`POST /api/schedule` computes whatever cycle times are missing, and every
generated match gets a real UTC timestamp — needed for printed schedules,
"upcoming matches" displays, and field displays that show whether the
match on screen is running ahead or behind pace.

The organizer-facing framing is deliberately the reverse of how the
closed-source reference tool works: that tool has the organizer pick a
cycle time per block and forward-computes total capacity from it. This
project instead lets the organizer say how many matches per team they
want and how much time they have, and computes the pace backward from
that — a specific, direct complaint about the reference tool's workflow.

In scope:
- `TournamentSession.timezone`, alongside the existing `session_date`.
- `POST /api/schedule`'s new `time_blocks` and `warn_below_multiplier`
  request fields, and the cycle-time-resolution algorithm that turns them
  (plus the plugin's returned `time_slot` structure) into a real
  `scheduled_time` on every created `Match`.
- The implicit single-block default when `time_blocks` is omitted
  entirely, so "N matches per team, starting now" still works with zero
  new configuration.
- The tightness warning, returned in the response, not blocking generation.

Explicitly out of scope / deferred (see §6):
- Per-block-independent cycle time was originally floated as a v2 idea and
  folded into v1's design once its actual shape (pinned vs. computed vs.
  open-ended blocks) became clear during design — see §3. What's still
  deferred is anything beyond that: no UI, no persisted/reusable "time
  block template" resource (blocks are request-scoped, not their own
  CRUD'd model), and no smart handling of a schedule regenerated after a
  previous one already assigned real times (same destructive
  `DELETE`-then-`POST` model Phase 4 already established).
- Field-display device behavior (a Raspberry Pi syncing its own clock from
  the server it's connected to, so it displays correctly even if physically
  relocated to a different timezone) — a real requirement raised during
  this phase's brainstorm, but it's about a client device's own behavior,
  not this project's server API, and belongs with whatever future phase
  builds real field-display/device endpoints (`CLAUDE.md` already notes
  device/admission handling is designed but unbuilt). This spec only
  guarantees the precondition that future phase will need: every
  `scheduled_time` is stored in UTC, ready for any client to convert to
  its own local display time.
- Any UI. This spec defines core-server logic and REST behavior only.

## 2. Data model

- **`TournamentSession`** gains `timezone: str | None` (an IANA zone name,
  e.g. `"America/Los_Angeles"`) alongside the existing `session_date: date
  | None`. Both are required together — a session can't do time-block
  scheduling with only one of the two set. Placed on `TournamentSession`
  rather than `Event` since `session_date` already lives there (a
  multi-day event could in principle have sessions in different zones,
  though nothing in this phase requires that to actually happen).
- No new table. `time_blocks` is a request-scoped input to
  `POST /api/schedule`, not a persisted, reusable resource — resending the
  same blocks on a future regeneration is the organizer's job, matching
  Phase 4's existing "regeneration is destructive, start over" model
  (§7 of that spec).
- `Match.scheduled_time` (already exists, `UTCDateTime`, currently always
  `NULL`) gets populated by this phase whenever a `time_blocks`-driven
  generation runs — no schema change needed there.

This is a schema change (new nullable column on `sessions`) on top of
every prior phase's own schema changes — same situation as always: no
real deployed event data exists yet, so a pre-this-phase database is
recreated (delete the `.db` file), not migrated.

## 3. The `TimeBlock` shape and cycle-time resolution

A `time_blocks` entry is `{start_time: "HH:MM", end_time: "HH:MM" | null,
cycle_time: int | null}` (`cycle_time` in seconds). `start_time`/`end_time`
are times-of-day, interpreted on the session's `session_date` in the
session's `timezone`.

Per-block validity:
- `cycle_time: null` ("calculate it for me") requires `end_time` to be
  set — there must be a fixed window to divide by.
- `end_time: null` (open-ended — "just keep going") requires `cycle_time`
  to be set — an unbounded block needs a known pace, since nothing else
  determines when to stop consuming it. At most one block may be
  open-ended, and if present it must be the last block in chronological
  (`start_time`) order — nothing can follow an unbounded block.
- Both set: the block independently accounts for a fixed capacity —
  `floor((end_time - start_time) in seconds / cycle_time)` `time_slot`s.
- Both `null` is invalid for an explicit block (422) — that combination
  only ever occurs via the whole-`time_blocks`-omitted default below, not
  as something an organizer writes directly.

**Resolving a full `time_blocks` list**, once the scheduler plugin has
returned its match list (this happens *after* the plugin call — the
plugin still only ever returns `time_slot`/`field_set_id`/`alliances`,
completely unaware that real time exists; nothing about the plugin
contract changes):

1. `total_time_slots_needed` = the number of *distinct* `time_slot` values
   in the plugin's returned matches (not the raw match count — multiple
   matches can share one `time_slot` when several `FieldSet`s run
   concurrently, and they all represent the same point in real time).
2. Sum the fixed capacity of every block that has both `end_time` and
   `cycle_time` set. Call this `fixed_capacity`.
3. **If an open-ended block is present**: every *other* block in the list
   must be fully pinned (both `end_time` and `cycle_time` set) — a
   "calculate for me" block cannot coexist with an open-ended one, since
   both would need a determinate share of the same remaining `time_slot`s
   to resolve their own cycle time, and neither can be computed before
   the other (422, naming both conflicting blocks, if this is violated).
   The open-ended block then absorbs `remaining = total_time_slots_needed
   - fixed_capacity` at its own given `cycle_time`; if `remaining` is
   negative, 422 (the pinned blocks alone already exceed the target).
4. **If no open-ended block is present**: `remaining = total_time_slots_
   needed - fixed_capacity`. If `remaining` is negative, or there are no
   "calculate for me" blocks and `remaining != 0`, 422 — the organizer's
   blocks don't add up to the target and something needs adjusting
   (naming the mismatch amount in the error). Otherwise, every "calculate
   for me" block (`cycle_time: null`) splits `remaining` in proportion to
   its own duration relative to the total duration of all "calculate for
   me" blocks — which, worked through, means they all end up with the
   *same* computed cycle time (a block-scoped generalization of a single
   uniform pace, not a whole-schedule one). If there's exactly one such
   block, it simply gets `remaining` `time_slot`s.
5. Walk every block in chronological order, assigning each successive
   `time_slot` (in the order the plugin returned them) a UTC `scheduled_
   time` — that block's UTC start instant plus the cumulative cycle-time
   offset of `time_slot`s already placed within it. Every `Match` sharing
   a `time_slot` gets the identical `scheduled_time`.

**Omitting `time_blocks` entirely**: synthesizes one implicit block —
`start_time` = five minutes from `utc_now()` (converted into the session's
`timezone` for internal consistency, though the exact zone is moot for an
open-ended block with no `end_time`), `end_time: null`, `cycle_time =
round(match_duration_seconds * warn_below_multiplier)` — a pace that is,
by construction, never tight enough to trigger this phase's own warning.
This requires no `session_date`/`timezone` to be set at all (there's no
real calendar window being carved up, just "starting soon, go at this
safe pace") — the 422 requiring both fields only applies when the
organizer supplies explicit `time_blocks`.

`match_duration_seconds` is always `autonomous_seconds + driver_seconds`
from the event's game plugin's `match_format()` — the actual on-field
time, not the interval between matches.

## 4. Endpoint changes

`POST /api/schedule`'s request body gains, alongside every existing field
(unchanged):
- `time_blocks: list[TimeBlock] | None` (default `None` → the implicit
  single-block default from §3).
- `warn_below_multiplier: float` (default `1.5`) — how far above raw match
  duration a cycle time needs to be before it's considered comfortable.

Validation order: existing checks (session/division/plugin/round_type/
409-if-matches-exist) run first, unchanged. Then, if `time_blocks` is
non-`None`: validate each block's shape (§3's per-block rules), validate
`session_date`/`timezone` are both set (422 naming whichever is missing),
validate blocks are non-overlapping and given in `start_time`-ascending
order (422 otherwise). The scheduler plugin call itself is unchanged —
`time_blocks` is never passed into `generate_schedule()`. After the plugin
returns and the existing structural validation (`_validate_generated_
schedule`) passes, resolve cycle times and assign `scheduled_time` per
§3's algorithm, 422 if resolution fails (the "doesn't add up" case).

`ScheduleGenerateResponse` gains:
- `resolved_time_blocks: list[{start_time, end_time, cycle_time_seconds}]`
  — every block (including the implicit default, and every "calculate for
  me"/open-ended block) with its actual cycle time filled in, so the
  organizer can see what pace they ended up with even when they didn't
  specify it directly.
- `cycle_time_warning: str | None` — set when any resolved block's cycle
  time is below `match_duration_seconds * warn_below_multiplier`, naming
  which block(s) and by how much. A warning never blocks the response —
  the schedule is still created.

`DELETE /api/schedule` is unchanged — clearing a schedule already deletes
the `Match` rows, `scheduled_time` included; no new cleanup needed.

## 5. Testing

- The worked example from this phase's brainstorm: two blocks, the first
  pinned (`cycle_time` given, `end_time` given), the second "calculate for
  me" (`cycle_time: null`) — verify the second block's resolved cycle time
  matches hand-computed arithmetic exactly.
- The implicit no-`time_blocks` default: verify it requires no
  `session_date`/`timezone`, assigns an open-ended pace derived from
  `match_duration_seconds * warn_below_multiplier`, and never triggers its
  own warning.
- An open-ended block combined with one or more closed blocks earlier in
  the day — verify it absorbs exactly the remaining `time_slot`s.
- The 422 "doesn't add up" case: every block fully pinned, sum mismatched
  against the target.
- The 422 missing-`session_date`-or-`timezone` case when `time_blocks` is
  explicitly given.
- The warning firing (a pinned or computed cycle time below the
  multiplier threshold) and not firing (comfortably above it), including
  the organizer-supplied `warn_below_multiplier` override changing the
  outcome for the same generated schedule.
- Multiple concurrent `FieldSet`s: matches sharing one `time_slot` all get
  the identical `scheduled_time`, and cycle-time capacity math is done in
  `time_slot`s, not raw match count.
- `scheduled_time` genuinely stored as UTC regardless of the session's
  `timezone` (a session in `"America/New_York"` and one in
  `"America/Los_Angeles"` for the same wall-clock `start_time` produce
  different UTC instants).

## 6. Deferred / open items

- Per-block cycle time beyond the pinned/computed/open-ended shape in §3
  (e.g. a cycle time that itself varies continuously through a block) —
  not requested, not built.
- A persisted, reusable "time block template" so an organizer doesn't have
  to retype the same blocks across sessions or after a regeneration — YAGNI
  for now, matching Phase 4's existing destructive-regeneration model.
- Field-display device time-sync behavior (§1) — a real future requirement,
  explicitly not this phase's server-side responsibility beyond storing
  every timestamp in UTC.
- Any smarter handling of a schedule regenerated mid-event that tries to
  preserve already-played matches' real times — the same gap Phase 4
  already deferred generally, not reopened here.
