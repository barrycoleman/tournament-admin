# Multi-Round Scheduling Design

## Context and motivation

This project's schedule-generation subsystem (`POST /api/schedule`, `services/schedule_timing.py`, `services/ranking.py`, `services/finals.py`) was built around a single-day, single-round-type model: one `TournamentSession` has exactly one `session_date`, one `POST /api/schedule` call generates matches for exactly one `(session, division, round_type)` combination against `time_blocks` that all share that session's one date, and there is no built-in concept of sequencing multiple round types (practice, then qualification) within one continuous set of field time.

Real tournaments this project targets don't fit that model:

- Many tournaments run over two or more calendar days for the same division's qualification rounds (e.g. Saturday morning practice + Saturday/Sunday qualification, finals on Sunday afternoon).
- An organizer plans "1 practice match per team, then 6 qualification matches per team" as one combined decision, not two separately time-boxed activities — they do not want to manually compute what clock time practice will finish at before they can decide when qualification starts.
- Practice matches must always be scheduled before qualification matches for the same division, but must not count toward standings.
- Match numbering needs to be human-legible and round-type-aware (`P1`..`P24`, `Q1`..`Q132`), and finals matches need their own scheme (`F1`..`F10` for the matchup/run, `F1-1`/`F1-2`/`F1-3` for the games within a best-of-N single-elimination series; `score_chase` finals just get sequential `F1`..`F10` with no per-game suffix, ordered worst-seed-first).
- Organizers iterate on time-block lengths and match counts to find an acceptable cycle time *before* committing to a real schedule, and want to do that without generating (and then having to clear) a real schedule each time they adjust a number.

This spec covers four related backend changes, built in dependency order. It is backend-only — no frontend UI is built as part of this spec (the Sessions + Fields + Schedule-generation admin UI is a separate, later spec that builds against the API shape this one produces).

None of this spec covers: cross-division finals (a distinct, already-deferred idea — see the `cross-division-finals-deferred` memory), or partial schedule regeneration that preserves already-scored matches when a checked-in team turns out to be wrong (also explicitly deferred — see the `partial-schedule-regen-preserving-scores-deferred` memory). Both are noted as future work, not built here.

## Global Constraints

- Never reference any real-world competition brand or product name anywhere.
- Every backend change ships with pytest unit/integration tests against a real FastAPI `TestClient` and a real temp-file SQLite database in the same change — never mocked at the HTTP boundary.
- Existing single-day, single-round-type callers of `POST /api/schedule` must keep working unchanged (backward compatible request/response shape) — this project has no frontend caller of these endpoints yet, but the E2E-tested backend contract itself must not regress for any test or future caller using the simple single-round-type form.
- No schema change in this spec may destroy existing data. Every model change ships with a real Alembic migration in the same commit as the model change, per this project's existing migration discipline (`server/CLAUDE.md`'s "Database migrations" section).

---

## Phase 1: Practice matches never count toward rankings

**Why first:** smallest, fully isolated, no dependency on anything else in this spec. Fixes a gap `server/CLAUDE.md` already documents as pre-existing and unaddressed.

`services/ranking.py`'s `recompute_rankings` and `recompute_event_rankings` both query completed matches for ranking purposes, currently excluding only finals matches (`Match.finals_bracket_id.is_(None)`). Add `Match.round_type != "practice"` to both queries, alongside the existing finals exclusion. `round_type` is plugin-declared free text (a game plugin's `match_format()["round_types"]` is not a fixed enum), but `"practice"` is already a value the core system treats specially by convention (every shipped game plugin fixture declares it, and this is the value organizers are expected to use for practice rounds) — this fix hardcodes exactly that one literal, matching the existing hardcoding of `"cooperative_score"`/`"head_to_head"` as known `game_model` literals elsewhere in the same file.

No API shape change. No migration.

---

## Phase 2: Multi-day time blocks

**Why second:** foundational for Phase 4 (combined generation needs multi-day blocks to be meaningful), and independently useful on its own (a schedule spanning two days for one round type already benefits from this).

### Data model changes

- `TimeBlock` (schema, in `schemas/schedule.py`) gains a required `date: dt.date` field. Every block now states its own calendar date explicitly — no more inheriting one shared date from the session.
- `TournamentSession.session_date` (model + schema) stops being load-bearing for time-block resolution. It becomes a display-only "nominal date" — kept, not removed (no destructive migration, and it remains useful for sorting/labeling sessions in a list), but `POST /api/schedule` no longer reads it to resolve `time_blocks`, and no longer requires it to be set before `time_blocks` are used (today's `session_obj.session_date is None or session_obj.timezone is None` 422 check is removed for the `time_blocks`-given path — `timezone` is still required whenever `time_blocks` are given, since wall-clock times still need a real IANA zone to convert to UTC; `session_date` is not).
- New: `ScheduleGeneration` gains a `time_blocks_json: str` column (JSON-encoded list of `{date, start_time, end_time, cycle_time}`, mirroring the resolved input) — this is what Phase 2's own overlap-checking (below) and Phase 4's slot allocation compare against for previously-generated batches in the same `(session, division)`.

### `schedule_timing.py` changes

Every function that currently orders/compares blocks by bare `start_time` string must instead order/compare by `(date, start_time)` tuples:

- `_block_duration_seconds` stays as-is for computing a *single* block's own duration (still just time-of-day arithmetic within that one block's one day — a block still cannot span midnight, unchanged from today).
- `validate_blocks_ordered_and_non_overlapping` changes its ordering/overlap check from comparing `start_time`/`end_time` strings directly to comparing `(date, start_time)` and `(date, end_time)` tuples. Two blocks on different dates trivially don't overlap regardless of their time-of-day values; two blocks on the same date use the existing time-of-day comparison.
- `assign_scheduled_times` no longer takes a single `session_date: dt.date` parameter. Each `ResolvedBlock` carries its own `date` (threaded through from the input `TimeBlock`), and the function combines each block's own date with its own `start_time` when computing that block's `block_start_utc`.
- `implicit_default_time_block` (the "no time_blocks given" path) is unchanged — it already computes a single block starting from `utc_now()`, which is inherently single-moment and does not need per-block dating.

### Per-division time-block overlap enforcement

Confirmed scope (explicitly discussed and confirmed): non-overlap is enforced **per `(session, division)`**, not globally across a session. Two different divisions with disjoint field-sets are expected and allowed to run at literally the same clock time (e.g. Division 1 on Saturday, Division 2 on Sunday, or even genuinely simultaneously if the venue has enough fields) — this is the existing, deliberate multi-division design (`docs/superpowers/specs/2026-09-02-multi-division-scheduling-design.md`) and this spec does not change it.

When `POST /api/schedule` is given `time_blocks`, before generating anything:

1. Validate the *new* request's own blocks are internally ordered and non-overlapping (existing `validate_blocks_ordered_and_non_overlapping`, now date-aware).
2. Load every other `ScheduleGeneration` row for the same `(session_id, division_id)` (matching the existing division-scoping convention: `division_id IS NULL` for a no-division generation, `division_id == X` otherwise) and decode its stored `time_blocks_json`, skipping any row where it's `NULL` (a pre-Phase-2 generation with nothing recorded to check against — see Migration below).
3. Check the new blocks against the *union* of all previously-stored blocks for that `(session, division)` using the same date-aware overlap logic. Any overlap is a 422 with a message naming the conflicting block and which prior generation it collides with.

This means a session/division's cumulative set of time blocks across every generation call it has ever made (that hasn't since been cleared via `DELETE /api/schedule`, which must also delete that generation's row and therefore its stored blocks) never overlaps itself, while different divisions remain fully independent.

### Migration

New Alembic migration: add `time_blocks_json` to `schedule_generations` (nullable, since pre-existing rows have no stored blocks — the overlap check simply has nothing to compare against for those, which is correct: a schedule generated before this phase shipped never went through block-based validation in the first place, so there's nothing retroactively unsafe about it having no data here). No change to `TournamentSession.session_date`'s column itself (kept, nullable, unchanged type).

---

## Phase 3: Match numbering and labeling

**Why third:** independent of Phases 2 and 4's mechanics, but naturally sequenced after them since Phase 4 changes how `match_number` is assigned per phase (see Phase 4's own numbering note).

A computed `label: str` field is added to `MatchRead` (computed at response-serialization time, not stored), branching on the match's own already-existing fields — no new "kind" field needed: a match with `finals_bracket_id is None` uses the round-type prefix map below; a match with `finals_bracket_id` set and `bracket_matchup_id` set is a `single_elimination` game; a match with `finals_bracket_id` set and `bracket_alliance_id` set instead (no `bracket_matchup_id`) is a `score_chase` run. These three cases are already mutually exclusive and exhaustive for every match this project creates today.

### Practice / qualification / other non-finals round types

Built from a small prefix map:

```python
ROUND_TYPE_LABEL_PREFIX = {"practice": "P", "qualification": "Q"}

def match_label(round_type: str, match_number: int) -> str:
    prefix = ROUND_TYPE_LABEL_PREFIX.get(round_type, round_type[:1].upper())
    return f"{prefix}{match_number}"
```

Any round type outside the two well-known ones falls back to its own first letter, uppercased — this keeps the system correct for a plugin that declares an unusual `round_types` list without needing this map to enumerate every possible value. No change to how `match_number` itself is assigned for these round types — it already restarts at 1 per generation call, which is what "P1..P24" and "Q1..Q132" need.

### Finals: `single_elimination`

- `BracketMatchup` gains a `matchup_number: Mapped[int]` column, assigned sequentially in `generate_bracket`'s existing double loop over `(round_number, position)` (that loop already creates every matchup for the whole bracket upfront, in round-then-position order — round 1's matchups get the first numbers, through to the single final-round matchup getting the last). This requires no restructuring of `generate_bracket`, only a running counter added to its existing loop.
- `_create_matchup_game`'s `match_number` assignment changes from counting every `Match` row with the same `finals_bracket_id` (today: bracket-wide) to counting only `Match` rows with the same `bracket_matchup_id` (matchup-scoped) — giving `1, 2, 3` within one best-of-3 matchup, restarting at `1` for the next matchup.
- Label for a finals-bracket match with a `bracket_matchup_id`: `f"F{matchup.matchup_number}-{match.match_number}"`.

### Finals: `score_chase`

No backend change. `create_score_chase_run`'s existing `match_number` (bracket-wide, sequential, assigned worst-seed-first per the existing `start_score_chase`/advancement logic) already produces exactly the numbering wanted: `F1` is the worst-ranked entrant's run, through `F10` (or however many entrants) being the best-ranked entrant's run, confirmed explicitly by the user. Label for a finals-bracket match with no `bracket_matchup_id` (i.e. a score_chase run, identified by having a `bracket_alliance_id` instead): `f"F{match.match_number}"` — no suffix.

### Migration

New Alembic migration: add `matchup_number` to `bracket_matchups` (nullable for pre-existing rows — an already-decided finals bracket from before this phase shipped has no retroactive numbering need, since it's already complete).

---

## Phase 4: Combined multi-round-type schedule generation

**Why last:** depends on Phase 2 (multi-day blocks) to be meaningful for a real 2-day qualification schedule, and its persisted `ScheduleGeneration` rows use Phase 2's `time_blocks_json` column and Phase 3's numbering (each phase's matches still get their own per-generation-call `match_number` restart, unchanged).

### Request shape

`ScheduleGenerateRequest` gains an optional `phases: list[SchedulePhase] | None = None`, where:

```python
class SchedulePhase(BaseModel):
    round_type: str
    target_matches_per_team: int
```

`phases` is mutually exclusive with the existing singular `round_type` + `target_matches_per_team` fields — a request must supply exactly one of (`round_type` and `target_matches_per_team`) or (`phases`), not both, not neither. This keeps today's single-round-type callers (and every existing test) working unchanged, while adding the combined path as an alternative shape on the same endpoint rather than a parallel endpoint, since the two paths share nearly all of their logic (field-set resolution, team eligibility, time-block resolution, validation-before-persist). `phases` must have at least one entry; a single-entry `phases` list is allowed and behaves identically to the singular-field shape, just returning its result via `phase_results` (a one-element list) instead of the flat `match_count` — this is a deliberate, harmless overlap, not a case worth forbidding.

### Slot allocation across phases

For each phase, in the order given: compute that phase's own required time-slot count exactly as today (call the scheduler plugin with that phase's own team/target-matches inputs, count the distinct `time_slot` values in its output). Sum every phase's count for the `total_time_slots_needed` passed into `resolve_block_cycle_times`. After the blocks are resolved into a single chronological sequence of concrete slot times (unchanged mechanism from today, just multi-day-aware per Phase 2), assign the first phase's own slot count to its matches, then the next phase's slot count to its matches from where the first phase left off, and so on — guaranteeing every earlier phase's matches land at earlier `scheduled_time`s than every later phase's, with no manual clock-time input required from the organizer to achieve that ordering.

### Validation

Before persisting anything: every phase's `(session_id, division_id, round_type)` combination must have zero existing matches (today's existing 409 check, run once per phase) — if any phase would conflict, the whole request is rejected with a 409 identifying which phase, and nothing is generated for any phase. This is the same all-or-nothing discipline as the rest of this project's write paths.

### Persistence

One `ScheduleGeneration` row per phase (same shape as today, `time_blocks_json` populated with that phase's slice of the resolved blocks — meaning both phases' rows reference blocks from the same original request, which is fine for Phase 2's overlap-checking since a generation's own blocks never conflict with itself). One `Match` row per generated match per phase, `match_number` restarting at 1 within each phase (unchanged from today's per-generation-call restart — Phase 3's label computation already handles this correctly per phase, since each phase's own round_type picks its own prefix).

### Response shape

`ScheduleGenerateResponse` gains a `phase_results: list[PhaseResult] | None` (populated when the request used `phases`; `None` for the singular-request-shape path, which keeps returning its existing flat `match_count`):

```python
class PhaseResult(BaseModel):
    round_type: str
    schedule_generation_id: int
    match_count: int
```

`resolved_time_blocks` and `cycle_time_warning` stay as top-level fields either way — they describe the whole request's block resolution, not any one phase.

### `DELETE /api/schedule`

Unchanged — still clears one `(session, division, round_type)` at a time. Confirmed accepted limitation (explicitly discussed): regenerating just one phase of a combined schedule without also regenerating the other can leave the untouched phase's matches at slot times that no longer line up with the regenerated phase's new slot count. Not solved in this spec; an organizer who needs to change one phase's match count is expected to clear and regenerate every phase of that combined batch together.

### Preview / dry-run

`ScheduleGenerateRequest` gains `dry_run: bool = False`. When `true`: run the scheduler plugin(s) and the full block/cycle-time resolution exactly as a real request would, computing and returning the same response shape (`resolved_time_blocks`, `cycle_time_warning`, `phase_results` or `match_count`) — but skip every persistence step (no `ScheduleGeneration` row, no `Match` rows, no commit). This lets an organizer iterate on time-block lengths and match-count targets against their real roster and field setup, seeing accurate cycle-time feedback, without generating (and then having to clear) a real schedule for each attempt. Applies to both the singular-request-shape and the `phases`-shape paths.

---

## Testing strategy

Every phase ships with pytest unit/integration tests against a real `TestClient` and real temp-file SQLite, per this project's existing policy — no phase is considered done without them, in the same commit as its code:

- **Phase 1:** a completed practice match must not appear in either `recompute_rankings`'s or `recompute_event_rankings`'s output; a completed qualification match in the same session/division must still be counted. Existing ranking tests that don't involve practice matches are unaffected.
- **Phase 2:** `schedule_timing.py`'s existing ~197 lines of unit tests need auditing and updating for the new `date`-aware comparison (every existing test's blocks need an explicit `date` field now); new tests for cross-date non-overlap (two blocks, different dates, same time-of-day, must not raise) and same-date overlap (unchanged from today, still raises); new integration tests for the per-`(session, division)` overlap check (a second generation call's blocks conflicting with a first, stored generation's blocks → 422; the same conflict against a *different* division's blocks → succeeds). `test_schedule.py`'s existing ~985 lines need auditing for any test that omits `date` from its `time_blocks` payloads.
- **Phase 3:** unit tests for the `match_label` prefix-map function directly (known round types, an unknown round type's fallback); integration tests confirming a generated schedule's matches carry the right `label` in `GET /api/matches`; finals tests confirming `matchup_number` is assigned correctly across a full bracket generation (round 1 gets the lowest numbers, the final gets the highest) and that a best-of-3 single_elimination series' three games get `match_number` 1, 2, 3 scoped to that one matchup (not bracket-wide); a score_chase bracket's runs confirmed to already produce the right sequential numbering (this is a pre-existing behavior — the test pins it, it doesn't change code).
- **Phase 4:** integration tests for the `phases`-shape request (two phases, confirm phase 1's matches all have earlier `scheduled_time`s than phase 2's); the mutual-exclusivity validation (both `round_type` and `phases` given → 422; neither given → 422); the all-or-nothing conflict check (one phase already has matches → 409, and the *other* phase's matches are confirmed not created either); `dry_run: true` confirmed to produce a correct response with zero `Match`/`ScheduleGeneration` rows created, and confirmed idempotent (calling it twice produces the same response both times, no state accumulated); the existing singular-request-shape path re-tested end-to-end to confirm it is unaffected by any of this phase's changes.

## Out of scope (explicitly deferred, not built in this spec)

- Cross-division finals (a combined bracket spanning multiple divisions) — see the `cross-division-finals-deferred` memory.
- Partial schedule regeneration that preserves already-scored matches when a checked-in team turns out to be wrong (removing/fixing a team's eligibility mid-tournament and only regenerating the not-yet-played remainder) — see the `partial-schedule-regen-preserving-scores-deferred` memory. Noted by the user as a strongly-wanted future nice-to-have, explicitly not needed for this spec.
- A hard runtime gate preventing a qualification match from being *started* while practice matches remain incomplete (confirmed explicitly: this spec only guarantees *scheduling order*, not a live match-control enforcement rule).
- The Sessions + Fields + Schedule-generation admin UI itself — a separate, later spec, built against the API shape this spec produces.
