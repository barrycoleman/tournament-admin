# Live Scoring, Skills Fields and Skills Control — Design

**Status:** approved design, not yet planned.

**Builds on:** skills challenges (`2026-10-08-skills-challenges-design.md`), per-team DQ/no-show (`2026-10-08-per-team-dq-no-show-design.md`), device pairing (`2026-10-13-device-pairing-design.md`), display groups (`2026-10-15-display-groups-design.md`), the realtime design (`2026-09-11-realtime-websockets-design.md`) and the core architecture spec's §6 (the deferred live-score preview, which this replaces).

**Leads to:** the scorer app (the tablet shell: picking a field or a match, binding from the tablet, moving on to the next match), referee violations and the score reveal flow. Each reuses the drafts, events and scoring page built here.

## 1. Problem

A score exists only once it is submitted, all at once, through the API. Nobody can score a match while it is played, displays can't show a running score, and two referees can't share one match. Skills attempts have no field, timer or display at all, and the admin app has no teamwork score entry or correction screen.

## 2. How an event scores

- **Teamwork, one scorer per field.** Scorer A stays on Field 1 and scores every match there; scorer B does the same on Field 2. Two referees may also split one match, each scoring one alliance, or both editing the same sheet.
- **Teamwork, scorers alternating.** Two scorers, three fields: Q1 on Field 1 is scorer A, Q2 on Field 2 is scorer B, Q3 on Field 3 is scorer A again. A scorer picks each match instead of following a field.
- **Who runs the clock.** An admin on Match Control, or the field scorers and referees from their tablets; control passes between them freely.
- **Skills, small event.** One or two skills fields, each with a scorer who picks the team and type, starts the timer, scores, confirms with the team and submits. A field TV shows the timer, the live score and, after the timer, a breakdown the team checks against.
- **Skills, large event.** 20 skills fields in two rows of 10, each row a skills field set with 5 TVs that show only the row's timer. Ten teams load into row A, the row's timer starts for all ten fields at once, and each field's scorer scores and submits without touching the timer; row B loads meanwhile. A late team's field can run on its own timer.

## 3. Goals

- Every change a scorer makes is saved on the server as a draft. Drafts never count toward rankings, completion, finals or any check; only Submit makes a score official.
- Several devices edit one match's drafts at once and stay in step; a clash on one item resolves predictably and visibly; one Submit sends every device to "Saved".
- Displays show a live total while the clock runs, under per-session switches: on for practice and qualification, off for finals by default.
- Scorer tablets and the admin can run a match's clock: Start, Pause/Resume, Reset and End.
- Skills fields run timed runs, on a shared field-set timer or a field's own timer, with field and field-set TVs.
- The admin app can score, review and correct teamwork matches, score skills runs, and run skills timers from Skills Control.

### Non-goals

- The scorer app's tablet shell (its own spec). The server endpoints it needs, including bindings, are built here.
- Locking an alliance or a sheet to one device.
- Referee violations, the score reveal flow ("show to teams", "send to results") and queueing.
- Skills timer sounds on field TVs.

## 4. Data model

The baseline migration is edited in place.

### 4.1 Changes to existing tables

- **`field_sets.purpose`**: `teamwork` (default) or `skills`. The schedule generator, finals, Match Control and the audience In Match switch use teamwork sets only. Skills sets still get audience and field display groups. The purpose can change only while the set has no matches (to skills) or no runs (to teamwork); otherwise 409.
- **`sessions.live_scores_qualification`** (bool, default true; covers practice and qualification) and **`sessions.live_scores_finals`** (bool, default false). Skills have no finals and follow `live_scores_qualification`.
- **`skills_attempts.field_id`**: nullable, no FK (fields can be deleted; the attempt stays). Set when an attempt comes from a run.
- **Game plugin contract:** each `skills_types()` entry gains `run_seconds` (positive integer). The conformance tool requires it; the sample plugin gives 60 for both types.

### 4.2 `score_drafts`

One row per alliance with a draft: `id`, `match_id`, `alliance_id` (unique), `data_json` (scoresheet items), `teams_json` (`[{team_id, no_show, dq}]`, flagged teams only), `item_meta_json` (`{item: {device_name, at}}`; team flags use the item keys `team:<id>:no_show` and `team:<id>:dq`), `version` (int, starts at 1, +1 per change), `updated_at`.

Cooperative games (`game_model == "cooperative_score"`) keep one shared draft per match, stored on the match's first alliance (lowest alliance id); Submit mirrors it as today.

### 4.3 `skills_set_timers`

One row per skills field set: `field_set_id` (unique), `skills_type`, `phase` (`ready` / `running` / `ended`), `deadline`, `paused`, `remaining_seconds_at_pause`. Created with the set. `skills_type` defaults to the game's first skills type and then to the type last used.

### 4.4 `skills_runs`

At most one row per skills field: `id`, `field_id` (unique), `field_set_id`, `session_id`, `team_id`, `skills_type`, `data_json`, `item_meta_json`, `version`, `follows_set` (bool, default true), the run's own timer (`phase`, `deadline`, `paused`, `remaining_seconds_at_pause`, used when `follows_set` is false), `created_by_device`, `created_at`.

- A run that follows the set has the set's `skills_type`, and its timer is the set's.
- The first field-level timer action sets `follows_set = false`; from then only that field's controls move it, and it may have any skills type (its length is that type's `run_seconds`).
- Submit writes a `skills_attempts` row (with `field_id`) and deletes the run; Discard deletes it. The field's next run follows the set again.

### 4.5 `scorer_bindings`

`id`, `session_id`, `device_id`, `field_id`; unique on (`session_id`, `device_id`). Optional: an unbound scorer picks each match or skills field.

### 4.6 Audit and deletion

`score_drafts`, `skills_runs`, `skills_set_timers` and `scorer_bindings` are left out of the audit log (like `devices`), so counter presses don't flood it. Submitted scores and attempts are audited as today.

Deleting a match, schedule, field, field set, team or session removes its drafts, runs, set timers and bindings (in `services/deletion.py` and the routers that delete fields and sets). Marking a match not played deletes its drafts.

## 5. Teamwork drafts

### 5.1 Endpoints

- **`GET /api/matches/{id}/draft`** → `{match_id, submitted: bool, alliances: [{alliance_id, data, teams, item_meta, version, score}]}`. An alliance with no draft appears with `data: {}`, `version: 0`. `score` is the plugin's `calculate_score` on the draft (0 if it can't be calculated yet), with team flags applied as for an official score.
- **`PATCH /api/matches/{id}/alliances/{aid}/draft`**, body `{changes: {item: value}, teams?: [{team_id, no_show, dq}]}` (`extra=forbid`). Only changed items are sent.
  - Each item is checked alone against the plugin scoresheet: the name exists for that scope, the type matches, the value is within min/max. Any bad item → 422 `{violations}`, nothing applied.
  - `teams` entries must be on that alliance (as `_validated_flags`); each listed team's flags replace that team's stored flags.
  - Accepted items overwrite the stored ones (last write wins per item, by server write order), `item_meta` records the caller's device name (or "Admin") and the time, `version` goes up by one, and the merged draft is returned.
  - 409 "already submitted" if the match has official scores for every alliance; 409 if the match is `not_played`.
  - For cooperative games the PATCH may name either alliance; it writes the shared draft.
- **`POST /api/matches/{id}/submit`**, body `{force?: bool}`.
  - Runs in one transaction and locks the match row first, so a later PATCH or Submit sees it submitted (409 "already submitted").
  - Every alliance needs a draft, else 409 naming the missing alliance.
  - The plugin's `validate` runs per alliance; problems → 422 `{violations: [{alliance_id, messages}]}` unless `force`.
  - Writes the official `score_records` through the same service as `POST …/score` (extracted from `routers/scores.py`): cooperative mirroring, per-team flags, match completion, clearing the queued override, finals advancing, rankings.
  - Deletes the drafts and broadcasts (§8).
- **`POST …/score`** stays as the admin correction path and keeps refusing a scorer when a score exists.
- **Reset:** `POST /api/matches/{id}/reset` with the whole-match scope also deletes the match's drafts. The section scope keeps them.

Callers: a paired scorer or referee device (`require_scorer_or_referee` + `require_paired_scoring_device`) or an admin. The match clock endpoints (`start`, `start-driver`, `pause`, `resume`, `end`, `reset`) already allow these roles and are used unchanged, start guard included.

### 5.2 Score so far

The draft's score uses the plugin's `calculate_score`. A draft that makes `calculate_score` raise (e.g. a required item still missing) has score 0 for display; the server logs nothing for this and never stores it.

## 6. Skills fields and runs

### 6.1 Endpoints

All under a skills field (`/api/fields/{id}/…`) or set (`/api/field-sets/{id}/…`); a teamwork field or set → 409.

- **`POST /api/fields/{id}/skills-run`**, body `{team_id, skills_type?}` → the run. Checks: skills enabled, the team checked in for the session, attempts of that type left (counting submitted attempts), no run on the field. `skills_type` defaults to the set's; a type other than the set's is allowed only with `follows_set: false` in the body (the run starts on its own timer).
- **`GET /api/field-sets/{id}/skills`** → `{timer, fields: [{field_id, name, run?}]}` for Skills Control, the scoring page and displays.
- **`PATCH /api/fields/{id}/skills-run/draft`**, body `{changes}`: merged like teamwork drafts against `skills_scoresheet_schema(type)`.
- **`POST /api/fields/{id}/skills-run/{start|pause|resume|end|reset}`**: the field's own timer. The first one sets `follows_set = false`. Start sets `deadline = now + run_seconds`.
- **`POST /api/field-sets/{id}/skills-timer/{start|pause|resume|end|reset}`**: the set timer; acts on every run following the set at once. Start is refused if no run follows the set.
- **`PUT /api/field-sets/{id}/skills-timer`**, body `{skills_type}`: refused (409) while any run on the set exists.
- **`POST /api/fields/{id}/skills-run/submit`**: re-checks the attempt limit inside the transaction (409 if two fields used a team's last attempt), runs `scoresheet_violations` (422 unless `force`), writes the attempt with `field_id` through the existing skills service, deletes the run, broadcasts.
- **`DELETE /api/fields/{id}/skills-run`**: discards; no attempt used.

Timer phases end on the server clock: a running timer past its deadline reads as `ended` (computed on read, as match phases are). Callers: a paired scorer or referee device or an admin, for any skills field or set.

### 6.2 Bindings

- **`GET /api/devices/me/binding`** → `{field_id} | null` for the active session.
- **`PUT /api/devices/me/binding`**, body `{field_id}`: the field must be in the active session; replaces any binding. Scorer or referee devices only.
- **`DELETE /api/devices/me/binding`**, and **`DELETE /api/devices/{id}/binding`** (admin).
- Device reads (`GET /api/devices`) include `binding: {field_id, field_name} | null`.

## 7. Live scores on displays

- The server decides; displays draw what they receive.
- **Teamwork:** live totals are sent only while the match's clock is running (any running phase, paused included; not `not_started` or `ended`) and the session's switch for the match's round is on (`live_scores_finals` for finals matches, else `live_scores_qualification`).
- **Skills:** live totals are sent while the run's timer runs and `live_scores_qualification` is on. After the timer ends, the field's breakdown (each item's label and value, and the total) is sent regardless of the switch, until submit or discard.
- **`GET /api/displays/live-scores?field_set_id=`** returns the same thing for start-up and reconnect: `{matches: [{match_id, alliances: [{alliance_id, score}]}], skills: [{field_id, score?, breakdown?}]}`, empty when nothing may be shown. `display_device` may call it.
- Flipping a switch broadcasts at once: totals stop, or start with the next change.

## 8. Live events

Realtime registers each active-session socket with its caller's role so events can go to some roles only (`broadcast_active_session(app, event, data, roles=…)`).

| Event | Payload | Sent to |
|---|---|---|
| `score_draft_changed` | the full draft for one alliance, with `version`, `item_meta`, `score` | admin, scorer, referee |
| `match_submitted` | `{match_id}` | all |
| `live_score` | `{match_id, alliances: [{alliance_id, score}]}` or `{field_id, score?, breakdown?}`, or `{match_id, cleared: true}` / `{field_id, cleared: true}` | display_device, admin |
| `skills_run_changed` | `{field_set_id, field_id?}` (run created, timer moved, draft changed, submitted, discarded) | admin, scorer, referee, display_device |
| `scorer_binding_changed` | `{device_id}` | admin and that device |

`score_saved`, `skills_changed`, `match_phase_changed`, `match_reset`, `devices_changed` and `field_set_changed` still fire as today. A device applies `score_draft_changed` only when its `version` is newer than the one it holds.

## 9. Shared scoring page

`frontend/packages/shared/src/scoring/` holds the live scoring page used by the admin app now and the scorer app later. It is built on `ScoresheetForm`.

- Teamwork: one column (or tab on narrow screens) per alliance, with per-team No-show and DQ toggles and the score so far. Skills: the team, type, timer and one sheet.
- Each change is sent at once as a PATCH of that item. Changes not yet acknowledged are queued in order; while any are queued and the connection is down, a banner reads "Offline, changes not saved yet". On reconnect the queue is sent, then the draft is fetched again.
- Incoming `score_draft_changed` with a newer version replaces the sheet; items whose `item_meta` device differs from this device and changed flash for 2 s with "Changed by <device>".
- Clock controls for the match's field: Start (Start driver after the first part of a two-part match), Pause/Resume, Reset timer (on a two-part match it asks: Reset current segment / Reset entire match timer; the whole-match reset warns that drafts are cleared) and End. Skills: the field's own timer and the set's timer.
- Submit shows the plugin's problems per alliance with "Submit anyway". After any Submit (this device or another, via `match_submitted`), the page shows "Saved" with the official score. A skills run has Submit and Discard.
- A 409 "already submitted" from a PATCH switches to "Saved"; a match that disappears (deleted, not played) shows "This match is no longer available".

## 10. Admin app

- **Match Control:** "Score" on the current match opens the scoring page; a "Hide live scores" / "Show live scores" toggle flips the session switch for the current match's round. "Waiting for score" clears on `match_submitted`.
- **Matches page** (`/sessions/:id/matches`, `SessionMatchesRoute`): "Score" on unsubmitted matches; submitted ones open read-only with "Correct score", which edits through `POST …/score` (any session; rankings recompute).
- **Skills Control** (`/skills-control`, next to Match Control): one card per skills field set in the active session, with its type (changeable while no run exists), the set timer and Start / Pause-Resume / Reset / End, and a row per field: team and type, following the set or running alone (with its countdown), state (no run / ready / running / ended / submitted), and Score, Discard and field-timer controls. "Start run" on an empty row picks a checked-in team with attempts left. With no skills sets, the page points to the Fields page.
- **Fields page** (`/sessions/:id/fields`)**:** a purpose for each field set, with teamwork and skills sets in separate sections.
- **Sessions page:** the session form gains the two live-score switches.
- **Devices page:** the Group column shows a scorer's binding ("Scoring · Field 2") with Clear.
- **Skills page:** unchanged entry and correction; attempts show their field when they have one.

## 11. Displays

- **Teamwork In Match** (audience and field): each alliance's live total under its colour band, with a small "Live" tag, while `live_score` says so. Totals disappear when the clock ends; the field TV goes to "Match over" and the audience holds at 0:00 until the official score.
- **Skills field TV** (field group on a skills field): no run → field name and "Skills · Waiting for the next team"; run created → team number and name, type, full run time; running → countdown and the live total when allowed; ended → "Run over" with the breakdown filling in as the scorer enters items; submitted → the final score until the next run.
- **Skills field-set TV** (audience group of a skills set): the set name, the type and the set countdown, never scores. No In Match switch.
- The display-groups `currentMatchForField` and screens ignore skills sets for teamwork content.

## 12. Errors and edge cases

- Offline tablets: §9's queue; on reconnect the server's copy wins for items another device changed meanwhile.
- PATCH or Submit after Submit: 409, the device shows "Saved". Two Submits at once: the second gets 409.
- Match marked not played or deleted mid-draft: its drafts are deleted and `score_draft_changed` is not sent again; scoring pages learn it from the existing match events (or a 404/409 on their next PATCH) and show "no longer available".
- A live-score switch flipped mid-match: takes effect at once.
- Skills: no run for a team not checked in or out of attempts; the limit is re-checked on submit; discard uses nothing; a set's type can't change while runs exist.
- Purpose changes: refused while the set has matches (to skills) or runs (to teamwork).
- A binding to a deleted field is cleared and the device is told (`scorer_binding_changed`). Bindings belong to a session, so when another session becomes active a device simply has none there (the existing `active_session_changed` event tells it to re-read); it asks to pick again (scorer-app spec).
- A plugin without `run_seconds` fails the conformance tool; at runtime the server refuses to start a skills timer for that type (409) rather than guessing.

## 13. Testing

### Server (pytest)

- Draft PATCH: per-item merge, last write wins on one item, `item_meta` device and time, `version`, per-item validation (unknown item, wrong type, out of range), team flags on the alliance only, 409 after submit and for not played.
- Cooperative shared draft and mirroring on submit.
- Submit: all-or-nothing, refused with a missing alliance, plugin violations per alliance and `force`, completion, rankings, finals advancing, drafts deleted; concurrent submit gets 409.
- Reset: whole-match clears drafts, section keeps them.
- Live scores: by round type, clock phase and both switches; finals never send totals to displays by default; the `GET /api/displays/live-scores` endpoint agrees with the events; role-filtered broadcast reaches only the listed roles.
- Skills: run creation checks, the set timer moving every following run, a field going alone and its own type, set type change refused with runs, submit re-checking the limit, discard, breakdown after the timer regardless of the switch, `field_id` on the attempt.
- Bindings: set, replace, clear (device and admin), cleared on field delete.
- Purpose changes and scheduling/finals ignoring skills sets.
- Roles for every endpoint; deletion cascades; drafts and runs not audited.
- The conformance tool's `run_seconds` check and the sample plugin.

### Vitest

- Shared scoring page: sending changes, merging an incoming newer version, the flash, the offline queue and banner, Submit with violations and "Submit anyway", "Saved" on another device's submit, the two reset choices, a skills run's Submit and Discard.
- Skills Control, the Match Control score and hide-live controls, the Fields purpose sections, the session switches, the Devices binding.
- Displays: live totals and the Live tag, totals clearing at the end, the skills field TV states and breakdown, the skills set TV.

### Playwright

- Two browser contexts scoring one match: both edit, a clash shows the flash on the other device, one Submit sends both to "Saved".
- The audience In Match screen shows the live total and drops it when time ends; a finals match shows no total by default.
- A skills set timer starting two fields at once, a third field running alone, and the field TV breakdown after the timer.
- An admin correcting a score in an earlier session.
- A scoring page going offline (network blocked) and catching up when it returns.
