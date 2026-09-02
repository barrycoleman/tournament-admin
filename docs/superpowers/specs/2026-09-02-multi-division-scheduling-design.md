# Multi-Division Scheduling — Design Spec

Status: approved for planning
Date: 2026-09-02

## 0. Project constraint

Nothing in this project's code, comments, documentation, file names, or
user-facing text may reference any real-world competition brand or product
name. All descriptions in this spec are written in neutral/generic terms for
that reason, even where they describe a specific closed-source reference
product's behavior.

## 1. Purpose & scope

`docs/superpowers/specs/2026-08-29-qualification-and-practice-scheduling-design.md`
(Phase 4) built `POST /api/schedule` around a single, session-wide pool of
`FieldSet`s: every generation call considers *every* FieldSet in the
session, with no way to restrict a call to a subset. This is safe for a
session with one Division (or none at all), but breaks the moment a
session has two Divisions that need to run concurrently on separate
physical fields: each Division's `POST /api/schedule` call independently
round-robins across the *same* full field pool and restarts `time_slot`
numbering at 0, so two Divisions scheduled in the same session collide on
both fields and real-world time — even though `Team.division_id` already
keeps their rosters correctly separate.

This phase closes that gap with the smallest change that removes the
collision: FieldSets become assignable to a Division, and schedule
generation only ever draws from the FieldSets assigned to the Division
being scheduled (or, for the no-division case, only from unassigned
FieldSets). Investigation during design confirmed the blast radius is
narrow — `Team.division_id` already scopes rosters correctly, and
`time_slot` numbering, round-robin field assignment within a FieldSet, and
`time_blocks`/cycle-time resolution (`2026-09-01-time-based-scheduling-design.md`)
all already operate correctly *within* one generation call. The only gap
is that the FieldSet/Field lookup itself was blind to which Division a
call was for.

In scope:
- `FieldSet.division_id: int | None` — assigns a FieldSet exclusively to
  one Division, or leaves it unassigned.
- `POST /api/field-sets` accepting an optional `division_id` at creation.
- A new `PATCH /api/field-sets/{field_set_id}` to set or clear a FieldSet's
  division assignment after creation.
- `POST /api/schedule`'s FieldSet/Field resolution becoming
  division-aware.

Explicitly out of scope / deferred (see §5):
- Renaming a FieldSet, or any other field beyond `division_id`, via PATCH.
- Any runtime detection of a FieldSet being "claimed" by another
  division's in-progress or already-generated schedule, beyond what the
  exclusive single-`division_id` assignment already prevents structurally.
- Any change to `time_slot` numbering, round-robin field assignment, or
  `time_blocks`/cycle-time resolution — all already correct once the
  FieldSet pool itself is correctly scoped.
- A session-wide or cross-division shared time budget — each Division's
  `POST /api/schedule` call keeps resolving its own `time_blocks`
  independently, exactly as today.

## 2. Data model

- **`FieldSet`** gains `division_id: int | None` (FK to `divisions.id`,
  nullable, default `None`). `None` means "unassigned" — usable only when
  generating a schedule for `division_id: None` (today's no-division
  behavior, unchanged). A non-null value means "exclusively this
  Division's" — no other Division's schedule generation will ever consider
  it. This is a single nullable FK, not a many-to-many relationship,
  mirroring `Team.division_id`'s existing precedent (a Team belongs to at
  most one Division) — a FieldSet can structurally never belong to two
  Divisions at once, so the exclusivity this phase requires is enforced by
  the schema itself, with no additional runtime conflict-checking needed.

This is a schema change (new nullable column on `field_sets`) on top of
every prior phase's own changes — same situation as always: no real
deployed event data exists yet, so a pre-this-phase database is recreated
(delete the `.db` file), not migrated.

## 3. Endpoint changes

- **`POST /api/field-sets`** — request body gains `division_id: int | None
  = None`. If given, validates it references a real `Division` (404
  otherwise, matching the existing validate-or-404 pattern used elsewhere
  for FK inputs).
- **`PATCH /api/field-sets/{field_set_id}`** (new) — request body
  `{division_id: int | None}`. The key is required, so the caller always
  states the intended value explicitly: an id to assign, or `null` to
  clear back to unassigned. Validates the FieldSet exists (404) and, if
  `division_id` is non-null, that it references a real `Division` (404).
  Returns the updated `FieldSetRead`. Reassigning a FieldSet's division
  never touches already-created `Match` rows — it only affects which
  FieldSets future `POST /api/schedule` calls will consider — so no
  blocking check against "this FieldSet already has matches" is needed.
- **`FieldSetRead`** gains `division_id: int | None` in its response
  shape, so a caller (or any future UI) can see the current assignment.
- **`POST /api/schedule`** — its FieldSet/Field resolution changes from
  "every FieldSet in the session" to:
  - When `payload.division_id` is given: only FieldSets in the session
    with `division_id == payload.division_id`.
  - When `payload.division_id` is `None`: only FieldSets in the session
    with `division_id IS NULL`.

  Everything downstream of that resolved FieldSet/Field list —
  round-robin physical field assignment within a set, `time_slot`
  numbering (already unique per `session, division, round_type`),
  `time_blocks`/cycle-time resolution, and the existing structural
  validation of the plugin's returned schedule — is unchanged. The
  existing "Session has no FieldSets configured" 422 fires the same way
  when the division-scoped (or unassigned-scoped) FieldSet list comes back
  empty, with a division-aware detail message so the organizer knows
  *which* division has no fields assigned yet.

  `DELETE /api/schedule` needs no change: it is already scoped by
  `(session_id, division_id, round_type)`, so clearing one Division's
  schedule already only ever touches that Division's matches.

## 4. Testing

- `POST /api/field-sets` with and without `division_id`; rejects an
  unknown `division_id` (404).
- `PATCH /api/field-sets/{id}`: sets a division, clears it back to
  `null`, rejects an unknown FieldSet id (404) and an unknown division id
  (404).
- A two-Division session, each Division with its own dedicated FieldSet:
  generating Division A's schedule never returns or uses any of Division
  B's fields, and both Divisions' schedules can be generated (and later
  cleared via `DELETE`) independently with no field or `time_slot`
  collision between them.
- A Division with no FieldSet assigned yet: `POST /api/schedule` returns
  422 naming that division.
- A no-division `POST /api/schedule` call only ever considers unassigned
  FieldSets, even when other, division-assigned FieldSets exist in the
  same session.
- Full regression: every existing single-division/no-division
  `test_schedule.py` and `test_field_sets.py`/`test_fields.py` test keeps
  passing unchanged, since nothing they set up ever sets `division_id` on
  a FieldSet, so all of their FieldSets remain "unassigned" and fully
  visible to their `division_id: None` schedule calls exactly as before.

## 5. Deferred / open items

- Renaming a FieldSet, or updating any field besides `division_id`, via
  PATCH — not requested; adding it would be scope beyond fixing the
  collision bug.
- Blocking or warning on reassigning a FieldSet's division while it
  already has matches/schedule generations tied to it through its
  `Field`s — reassignment only changes which *future*
  `POST /api/schedule` calls will consider that FieldSet; it doesn't
  mutate any existing `Match` row, so there's no data-integrity hazard to
  guard against.
- Any cross-division conflict detection beyond the exclusive
  single-`division_id` assignment itself (e.g. actively warning if an
  organizer somehow ends up with two Divisions both drawing from
  unassigned FieldSets because neither was ever assigned) — the schema
  already makes true double-assignment structurally impossible, and once
  an organizer assigns FieldSets per Division as this phase intends, there
  is nothing left to collide.
- A session-wide or event-wide shared time budget / unified `time_slot`
  numbering space across Divisions — each Division's schedule generation
  keeps resolving its own `time_blocks` and its own `time_slot` numbering
  independently, exactly as today; concurrent Divisions on separate
  FieldSets are expected to legitimately overlap in real-world
  `scheduled_time`, which is the correct behavior for fields running in
  parallel.
