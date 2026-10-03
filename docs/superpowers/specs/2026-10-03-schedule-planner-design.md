# Schedule Planner Design

## Context and motivation

The Schedule tab (`docs/superpowers/specs/2026-10-01-fields-schedule-ui-design.md`) exposes `POST /api/schedule` almost one-to-one. It has a scheduler-plugin picker, "phases", a timing-mode radio ("fit matches into time blocks" or "fixed cycle time"), a list of time blocks, and separate Preview and Generate buttons. Using it for real exposed several problems:

- **It asks the inverse question.** Organisers start from "N matches per team" and want to know when the round will finish. The default mode instead asks for an end time and stretches the cycle time to fill it.
- **The result is hidden behind Preview.** The preview reports time blocks (date, start, end, cycle, slots) rather than what an organiser cares about: how many matches, when each round starts and ends, and whether it fits. Any change makes the preview stale.
- **Lunch can't be modelled reliably.** A break is two time blocks with a gap. With a fixed cycle time, `resolve_block_cycle_times` requires every bounded block to be filled completely. A round that would finish before lunch is rejected with "Fixed time blocks already account for N matches, more than needed".
- **Adding or changing a round is guesswork.** Every new generate defaults to 09:00. The organiser has to work out where the previous round ended, and only learns they were wrong from an overlap error after submitting. Changing one round's match count means clearing and regenerating it by hand.
- **Scope and status crowd out the task.** A small division dropdown, then readiness, rounds, the form, and finally the preview at the bottom. It's easy to generate for the wrong division.

**Intended outcome:**
- An organiser defines a session's playing times once.
- For each division, they list rounds as "round type, matches per team, cycle time".
- A live summary shows exactly when each round runs across the session's days and whether everything fits.
- They can edit a round (more matches per team, a shorter cycle) and apply it, with the server rebuilding that round and the rounds after it.

**Decisions made during design (user-confirmed):**

- **Approach A, a one-page live planner,** chosen over a step-by-step wizard and over a drag-and-drop timeline editor. The page uses **layout B**: a timeline of the whole session across the top, with the rounds table below.
- Organisers usually start from **matches per team**. The finish time is the output, not an input.
- **Playing windows are set once per session and shared by every division.** A session may span several days and several windows per day. Matches flow through the windows in order: e.g. Q1–Q50 in Saturday morning, Q51–Q100 in Saturday afternoon, Q101–Q150 on Sunday.
- **Breaks are fixed clock times.** They are simply the gaps between playing windows; there is no separate "break" concept.
- **Each game plugin may declare a default cycle time.** The system uses it as a starting point, and the organiser can always override it.
- **Divisions are tabs** across the top of the Schedule tab, each showing its checked-in team count.
- **Every round row stays editable** until it, or a round after it, has a scored match. Edits are a draft until applied. Applying rebuilds the changed round and every round after it.
- **When a plan doesn't fit, both fixes are offered:** a shorter cycle time that fits, or extending the last playing window.
- Clearing a round with scored matches keeps the existing typed-confirmation dialog.

## Global Constraints

- Never reference any real-world competition brand or product name anywhere.
- Every backend change ships with pytest unit and integration tests against a real FastAPI `TestClient` and a real temp-file SQLite database, in the same change as the code.
- Every frontend change ships with Vitest component tests and Playwright E2E coverage of its user-facing flows, with no mocking at the HTTP/WebSocket boundary in E2E.
- Changing the plugin interface means updating the conformance tool (`tm test-plugin`, `plugin_registry/conformance.py`) in the same change.
- Schema changes go through the project's migration mechanism (`docs/superpowers/specs/2026-09-10-database-migrations-design.md`) and never destroy existing data.
- Every user-facing string goes through `t(...)` in both the `en` and `zh` `admin.json` files.
- Match times always render in the session's timezone (`src/matchTime.ts`).

---

## Section 1: Concepts

**Playing window.** A date, start time and end time (HH:MM, session-local) during which matches may be played. A session has zero or more, which never overlap and are kept sorted. Every window has an end time; open-ended blocks are dropped.

**Round.** All of one division's matches of one round type (`practice` or `qualification`) in one session. A round is built from three numbers: round type, matches per team, and cycle time in seconds. It records those so the table can show and edit them.

**Plan.** A division's ordered list of rounds. Order is chronological: a round starts after the previous round in that division ends.

**Flow-through placement.** Given a starting instant, a cycle time `c`, a match length `m` (the plugin's autonomous plus driver seconds) and the session's windows:
- Time slots are placed one after another, `c` apart.
- A slot may start at time `t` only if `t + m` is no later than its window's end. Otherwise it moves to the start of the next window, and spacing restarts from there.
- A slot is one time index from the scheduler plugin; every match sharing that index runs at the same time on different fields.
- Placement fails when slots remain after the last window.

**Starting point.** The first slot of a division's plan:
- If the division has kept matches (matches not being rebuilt) in this session: the first instant at or after the end of its last kept match (that match's start plus `m`), rounded up to a whole minute, then moved into a window if it falls in a gap.
- Otherwise: the start of the session's first window.

**Locked round.** A round is locked if it has any scored match, or if any later round in the same division is locked. Only unlocked rounds can be edited or rebuilt. Locked rounds' matches never move.

**Elimination is not a planner round.** Elimination matches are created by the finals flow when a bracket is seeded (`services/finals.py`), not by `POST /api/schedule`. The planner offers only the round types the game plugin lists, minus `elimination`. Giving finals a time slot is out of scope.

---

## Section 2: Server changes

### 2.1 Playing windows

New table `session_playing_windows`, added by migration:
- `id`
- `session_id` (foreign key to `sessions`, cascade delete)
- `date` (`Date`)
- `start_time` (`String(5)`, HH:MM)
- `end_time` (`String(5)`, HH:MM)

Endpoints, both admin only:

- `GET /api/sessions/{id}/playing-windows` returns the windows sorted by `(date, start_time)`.
- `PUT /api/sessions/{id}/playing-windows` with body `{"windows": [{"date", "start_time", "end_time"}, ...]}` replaces them all at once. It returns 422 if:
  - the session has no timezone
  - any window has `end_time <= start_time` (windows don't cross midnight; a late session is two windows)
  - any two windows overlap
  - there are more than 50 windows

  It broadcasts nothing, matching `DELETE /api/schedule`. The frontend invalidates its own query.

Changing windows never moves existing matches.

### 2.2 `match_format()` gains `default_cycle_time_seconds`

`match_format()` may return an optional integer `default_cycle_time_seconds`. `GET /api/event/match-format` passes it through, as `null` when absent.

The conformance tool fails a plugin whose value is not an integer, or is less than `autonomous_seconds + driver_seconds`. The sample cooperative game declares 300 (a 60-second match plus reset).

### 2.3 `POST /api/schedule` (new request shape)

```json
{
  "session_id": 1,
  "division_id": 2,
  "scheduler_plugin_name": "balanced",
  "rounds": [
    {"round_type": "practice", "target_matches_per_team": 2, "cycle_time_seconds": 420},
    {"round_type": "qualification", "target_matches_per_team": 8, "cycle_time_seconds": 410}
  ],
  "excluded_team_ids": [],
  "dry_run": true
}
```

`time_blocks`, `phases`, the singular `round_type`/`target_matches_per_team` fields, and `warn_below_multiplier` are removed. The implicit "start five minutes from now, in UTC" path is removed too: a session must have a timezone and at least one playing window, or the server returns 422. The admin UI is the only client and nothing has been released, so there is no compatibility shim. Existing tests that relied on the implicit path move to a shared fixture that sets up playing windows.

**Rules:**

1. `rounds` is ordered and non-empty, with each round type at most once. Every round type must be in `match_format()["round_types"]` and must not be `elimination`. Each `cycle_time_seconds` must be at least the match length.
2. **Replacing rounds.** A listed round type that already has matches in the session and division is replaced. The server rejects the request (422, naming the round) if:
   - any replaced round is locked
   - a round of this division that comes after the earliest listed round is not itself listed. A plan is rebuilt from the first changed round to the end, so later rounds can't be left behind or overtaken.
3. **Starting point** as in Section 1, where "kept matches" are this division's matches whose round types are not listed.
4. **Generation.** Each listed round runs through the scheduler plugin in order. Pairing history excludes the rounds being replaced and includes each newly generated round, as `_fold_generated_into_pairing_history` does today.
5. **Placement.** Each round's slots are placed by flow-through, starting where the previous listed round ended (the previous round's last slot start plus `m`, rounded up to a whole minute). Each round uses its own cycle time.
6. **Overlap safety net.** The existing per-(session, division) check against other live generations stays. It now sees only generations that aren't being replaced, including rows saved under the old format. Under normal use it can't fire, because the starting point already follows the division's kept matches.
7. **Atomicity.** Deleting the replaced rounds' matches and generations, then creating the new ones, happens in one transaction. Any failure leaves the previous schedule unchanged.
8. **Doesn't fit.** If placement fails, a dry run returns `fits: false` with the details below, and a real request returns 422 with the same message and creates nothing.

**Response** (dry run and real):

```json
{
  "fits": false,
  "rounds": [
    {"round_type": "practice", "schedule_generation_id": null, "match_count": 12,
     "slot_count": 12, "first_start": "2026-11-07T17:00:00Z", "last_end": "2026-11-07T18:19:00Z"},
    {"round_type": "qualification", "schedule_generation_id": null, "match_count": 48,
     "slot_count": 48, "first_start": "2026-11-07T18:26:00Z", "last_end": null}
  ],
  "overflow": {
    "unplaced_slot_count": 3,
    "over_by_seconds": 960,
    "suggested_cycle_time_seconds": 410,
    "suggested_last_window_end": "15:16"
  }
}
```

- `first_start` and `last_end` are UTC. `last_end` is `null` for a round that doesn't fully fit.
- `overflow` is `null` when the plan fits.
- `over_by_seconds` is how far the last slot's end would run past the last window's end, if that window were extended to fit it.
- `suggested_cycle_time_seconds` is the longest whole-second cycle time for the **last listed round** at which everything fits, keeping the other rounds' cycle times. It is `null` if even the match length doesn't fit.
- `suggested_last_window_end` is the earliest whole-minute HH:MM end time for the last window at which everything fits. It is `null` if that would pass 23:59.

### 2.4 What a generation records

`ScheduleGeneration` gains a `cycle_time_seconds` integer column (nullable, so existing rows remain valid), added by migration.

New rows store `time_blocks_json` as the windows the round actually occupies:
- one entry per playing window it uses
- each with that window's date, start and end, the session timezone, and `occupied_from`/`occupied_until`

The existing overlap code reads this unchanged. Rows saved under the old format keep working as they do today.

`target_matches_per_team` is already stored. The rounds table reads both values from the generation through a new read-only `GET /api/schedule/rounds?session_id=&division_id=`. That endpoint returns, per round in chronological order:
- the round type
- matches per team and cycle time
- the match count and scored count
- the first start and last end
- `locked`

### 2.5 Default cycle time

The UI picks a new round's default cycle time from, in order:
1. the previous row in the table
2. the cycle time of this session's most recently created generation, in any division
3. the plugin's `default_cycle_time_seconds`
4. the match length plus 120 seconds, rounded up to a whole minute

`GET /api/schedule/rounds` also returns `session_last_cycle_time_seconds` to support the second step.

---

## Section 3: Schedule tab layout and behaviour

From top to bottom:

1. **Readiness strip.** The existing compact blocker list, shown only when something blocks. It gains a blocker, "This session has no playing times", whose link opens the Playing times editor.
2. **Division tabs.** One tab per division, with an accessible tab list labelled e.g. "Division 1 · 24 teams" (checked-in teams). It scrolls sideways when there are many. A single-division event shows no tabs.
3. **Playing times panel.**
   - **Collapsed:** a one-line summary, e.g. "Sat 09:00–12:00, 13:00–17:00 · Sun 09:00–15:00", and an Edit button.
   - **Expanded:** rows of date, start and end, plus Add, Remove and Save.
   - **Timeline:** one bar per window, with gaps labelled by length or "overnight" between days. Coloured segments show each round: solid for scheduled matches, faded for the draft, red for overflow.
   - **After a window edit:** if existing matches now fall outside the windows, the panel says which rounds are affected. Unlocked rounds are marked "needs rebuild" in the table. Locked rounds get a warning only.
4. **Rounds table.** Columns: Round · Matches per team · Cycle time (minutes : seconds) · Matches · When · action.
   - **Scheduled rounds** show their stored values, editable unless locked. Locked rows show "🔒 N scored" and only offer **Clear…**.
   - **Changed rows** are marked "changed", with their inputs highlighted and the old value shown ("was 6").
   - **New rows** ("+ Add round") offer the round types not already in the table, and offer **Remove**.
   - **The When column** shows the dry run's first start and last end in session-local time, with the day when it differs from the first window's day ("Sat 10:26 → Sun 15:16").
   - **Totals:** under the table, total matches and the plan's finish time.
5. **Fit status.**
   - "✓ Fits", with the free time left in the last used day.
   - Or a warning: "Over by 16 min — 3 Qualification matches don't fit before Sun 15:00." with buttons **Use cycle time 6:50** (sets the last listed round's cycle time) and **Extend Sunday to 15:16** (saves the last window's new end).
   - Either button triggers a new dry run.
6. **Actions.**
   - **Generate** when only new rows exist; **Apply changes** when any scheduled row changed.
   - **Discard changes** resets the draft.
   - The primary button is disabled while the plan doesn't fit, while a dry run is in flight or stale, or while something blocks readiness.
   - A note beside it says what Apply will rebuild ("Rebuilds Practice and Qualification").
7. **More options** (collapsed): the scheduler plugin picker.

**Live summary.**
- The draft is sent as a dry run 400 ms after the last edit. Only the latest response is shown; earlier in-flight requests are ignored.
- While a request is in flight the previous result stays, dimmed.
- A dry-run error, such as a scheduler plugin failure, is shown in place of the fit status.

**What Apply sends.** The changed rows, every row after the first changed row, and new rows, in table order. That matches rule 2 of Section 2.3.

**Concurrency.**
- `["matches", sessionId]` and the rounds query stay live via the session WebSocket, as today.
- When they refresh mid-edit, the draft is kept. If a row being edited has become locked, it drops out of the draft with a message.
- If Apply fails, the server's 422 is shown and nothing changes.

**Leaving with unapplied changes.** A router blocker and `beforeunload` ask for confirmation.

**Removed:** the timing-mode radio and the "fit matches into a window" mode, the time-blocks editor, `PreviewPanel`, the separate Preview button, and Move up/Move down. Order is chronological and set by when a row was added.

---

## Section 4: Error handling summary

| Situation | Where it's caught | What the user sees |
|---|---|---|
| No timezone or no playing windows | Readiness, then a 422 | Blocker with a link to fix it |
| Plan doesn't fit | Dry run (`fits: false`), then a 422 on a real request | Over-by warning with two one-click fixes; primary button disabled |
| Round now locked | Rounds query refresh, then a 422 | Row drops from the draft with a message |
| Later round not included in a rebuild | Can't happen from the UI, which always sends the tail; server 422 | Server message |
| Scheduler plugin raises | Dry run | Plugin's message in place of the fit status |
| Overlap with a pre-change generation | Server 422 (safety net) | The existing overlap message |
| Overlapping or reversed playing windows | Editor validation, then a 422 | Inline field error |

---

## Section 5: Testing

**Server (pytest).**
- Playing windows: CRUD, validation (reversed, overlapping, no timezone, too many), cascade on session delete, and the migration on a database with existing generations.
- Flow-through placement:
  - across a lunch gap and across days
  - the "match must finish before the window closes" rule, at the boundary
  - multiple fields per slot
  - starting point after kept matches, including one that ends in a gap
- Overflow: `over_by_seconds`, the suggested cycle time (including `null` when even the match length doesn't fit), and the suggested window end (including `null` past 23:59).
- Rebuild:
  - replacing a round plus later rounds
  - rejection when a later round is omitted
  - rejection when a replaced round is locked
  - atomic rollback when the scheduler plugin fails mid-way
  - pairing history excludes replaced rounds
- The old-format overlap check still applies to existing rows.
- `GET /api/schedule/rounds`: values, order, `locked`, and `session_last_cycle_time_seconds`.
- Conformance: `default_cycle_time_seconds` missing (passes), below the match length (fails), not an integer (fails). The sample game passes.

**Frontend (Vitest).**
- Draft logic: change detection, the "tail" sent on Apply, and the default cycle-time order.
- Rounds table states: scheduled, changed, new, locked.
- Fit status rendering and both one-click fixes.
- Division tabs: names, counts, keyboard navigation.
- Playing-times editor validation.
- Dry-run debounce and keeping only the latest response.

**Playwright (`z_sessionSchedule.spec.ts`).**
- Set playing times, then generate Practice and Qualification across lunch and two days; check the Matches tab times.
- Edit Qualification's matches per team until it overflows, use the suggested cycle time, apply, and check the new match count.
- Use "Extend" instead.
- Score one Practice match: Practice is locked, Qualification is still editable.
- Clear… on a scored round requires typing its name.
- Switch division tabs: each tab shows its own plan.

---

## Out of scope

- Giving finals or elimination matches a time slot.
- Rebuilding a round while keeping its scored matches (already recorded as deferred).
- Per-division playing windows. Windows are per session by decision.
- Drag-and-drop timeline editing.
- Windows that cross midnight.
