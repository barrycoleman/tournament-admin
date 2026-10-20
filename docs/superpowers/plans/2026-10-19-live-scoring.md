# Live Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scorers and admins score teamwork matches and skills runs live: every change is a server-side draft merged item by item across devices, one Submit makes it official, displays show live totals under per-session switches, skills field sets run shared or per-field timers, and the admin app gains live scoring, correction and Skills Control.

**Architecture:** Drafts live in their own tables (`score_drafts`, `skills_runs`), so every reader that treats "a score record exists" as "scored" stays unchanged; Submit turns drafts into official rows through the same service the existing score endpoint uses (extracted first). A `live_scores` service decides what displays may see and pushes totals as `live_score` events over a role-filtered broadcast; displays draw what they receive. The shared package gets a draft-sync hook and a live scoring page that the admin app uses now and the scorer app will reuse.

**Tech Stack:** FastAPI, SQLAlchemy, SQLite, Alembic baseline edited in place, pytest; React 19, TypeScript, Vite, TanStack Query 5, react-i18next, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-19-live-scoring-design.md`

## Global Constraints

- Never reference any real-world competition brand or product name anywhere: code, comments, tests, commit messages, docs, UI text.
- Until the first release the schema changes by editing `server/src/tournament_server/_alembic/versions/000000000001_baseline.py` in place; never add a revision. `tests/test_alembic_drift.py` must stay green.
- Every backend change ships with pytest in the same task; every UI change ships with Vitest in the same task; Playwright covers the golden paths in Task 18.
- Every user-facing string goes through i18n, in English and Chinese (`frontend/apps/admin/src/i18n/{en,zh}/admin.json`, `frontend/apps/device/src/i18n/{en,zh}/device.json`; shared components take a `t` function as `ScoresheetForm` does).
- Exact values from the spec: `field_sets.purpose` is `teamwork` (default) or `skills`; `sessions.live_scores_qualification` default `true`, `sessions.live_scores_finals` default `false`; skills run phases `ready` / `running` / `ended`; the sample plugin's `run_seconds` is `60` for both skills types; a changed item flashes for 2 s; team flag item keys are `team:<id>:no_show` and `team:<id>:dq`; the cooperative shared draft lives on the match's lowest alliance id.
- Live phases (a teamwork match's clock "is running" for live totals): `countdown_autonomous`, `autonomous`, `awaiting_driver`, `countdown_driver`, `driver`, paused or not. Not live: `not_started`, `ended`.
- Live events, exactly: `score_draft_changed` (admin, scorer, referee), `match_submitted {match_id}` (all), `live_score` (display_device, admin), `skills_run_changed {field_set_id, field_id?}` (admin, scorer, referee, display_device), `scorer_binding_changed {device_id}` (admin and that device). Existing events keep firing.
- Error details, exactly: `SCORE_ALREADY_SUBMITTED_DETAIL` (existing, "This score has already been submitted; ask an admin to correct it.") for PATCH/Submit after submit; `"Alliance {id} has no draft score."` for Submit with a missing draft; `"This is not a skills field."` / `"This is not a skills field set."` / `"This is a skills field set."` for purpose mismatches.
- Work in the main checkout on branch `live-scoring`. No worktrees. Commit only the files your task names. Do not push.
- Do not open a running server's tournament database with sqlite.
- Commit messages are plain sentences describing the change, ending with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commands: server tests `cd server && .venv/bin/pytest -q <paths>`; plugin conformance `cd server && .venv/bin/tm test-plugin plugins/games/sample_cooperative`; shared `cd frontend/packages/shared && npx vitest run <paths>`; device `cd frontend/apps/device && npx vitest run <paths>` and `npx tsc -b`; admin `cd frontend/apps/admin && npx vitest run <paths>` and `npx tsc -b`; E2E `cd frontend/apps/admin && npx playwright test tests/e2e/liveScoring.spec.ts` (ports 8143 / 5204 / 5205).

## Review Focus

1. **Two tablets editing different items of one match at the same moment.** Neither change may be lost; the merged draft holds both — Task 6 `test_concurrent_patches_never_lose_a_change`; two Submits at once write one score — Task 8 `test_two_submits_at_once_write_one_score`.
2. **A split-scored match submitted before the other alliance is touched.** Submit is refused naming that alliance, and only the explicit "Use the default score" button fills it — Task 8 (missing-draft 409) and Task 12/13 (409 → button → PATCH → submit).
3. **A tablet that drops off the network mid-match.** Changes queue in order, one in flight, and are sent then refetched on reconnect — Task 12 "keeps changes queued while offline, then sends them and refetches on reconnect"; Task 18 offline E2E.
4. **Finals scores leaking to TVs or non-scoring sockets.** Totals go only to display_device and admin, never by default in finals — Task 4 `test_a_role_filtered_broadcast_reaches_only_the_listed_roles` / `test_admin_is_never_implied`; Task 7 finals tests; Task 18 finals E2E.
5. **Two skills fields racing a team's last attempt.** Exactly one submit succeeds and the other run stays in place — Task 10 `test_submit_rechecks_the_attempt_limit`.

---

## File map

**Server (`server/src/tournament_server/`)**
- `models/scoring_draft.py` (new): `ScoreDraft`, `SkillsSetTimer`, `SkillsRun`, `ScorerBinding`.
- `models/field_set.py` (`purpose`), `models/session.py` (two switches), `models/skills.py` (`SkillsAttempt.field_id`), `models/__init__.py`, the baseline migration, `audit.py` (exclusions).
- `services/score_submission.py` (new): the official-score write extracted from `routers/scores.py`.
- `services/drafts.py` (new): item validation, merge, draft reads, cooperative shared draft, deletion helpers.
- `services/live_scores.py` (new): visibility rules, payloads, broadcasting.
- `services/skills_runs.py` (new): runs, set timers, field timers, submit and discard.
- `services/scorer_bindings.py` (new).
- `routers/drafts.py` (new): `/api/matches/{id}/draft`, `/alliances/{aid}/draft`, `/submit`.
- `routers/skills_runs.py` (new): `/api/fields/{id}/skills-run…`, `/api/field-sets/{id}/skills…`.
- `routers/bindings.py` (new): `/api/devices/me/binding`, `/api/devices/{id}/binding`.
- `routers/displays.py`: `GET /api/displays/live-scores`.
- `routers/field_sets.py`, `routers/fields.py`, `routers/sessions.py`, `routers/matches.py`, `routers/scores.py`, `routers/schedule.py`, `routers/finals.py`, `routers/devices.py`, `routers/websockets.py`, `realtime.py`, `services/deletion.py`, `services/skills.py`, `services/scheduling.py`, `services/displays.py`, `app.py`, schemas.
- `plugins/games/sample_cooperative/plugin.py`, the conformance tool (`tm test-plugin`).

**Shared (`frontend/packages/shared/src/scoring/`)**: `types.ts`, `api.ts`, `mergeDraft.ts`, `useLiveDraft.ts`, `LiveScoringPage.tsx`, `ClockControls.tsx`, `SkillsRunPanel.tsx`, `index.ts`.

**Admin app (`frontend/apps/admin/src/`)**: `routes/MatchScoringRoute.tsx`, `routes/SkillsControlRoute.tsx`, `skillsControl/*`, `routes/MatchControlRoute.tsx`, `routes/SessionMatchesRoute.tsx`, `routes/SessionFieldsRoute.tsx`, `routes/SessionsRoute.tsx`, `routes/DevicesRoute.tsx`, `routes/SessionSkillsRoute.tsx`, `components/AppShell.tsx`, `router.tsx`, i18n.

**Device app (`frontend/apps/device/src/display/`)**: `useLiveScores.ts`, `components/InMatchView.tsx`, `components/AllianceBands.tsx`, `SkillsFieldDisplay.tsx`, `SkillsSetDisplay.tsx`, `FieldDisplay.tsx`, `GroupView.tsx`, `events.ts`, `api.ts`, i18n.

**E2E**: `frontend/apps/admin/tests/e2e/liveScoring.spec.ts`.

---

## Task list and interfaces

These blocks bind every task. Names, signatures, routes and payloads below are exact; tasks may add private helpers but not rename these. Where a task's "Plan note:" adapts a block to the real code (for example the reset scope is `section` / `full`, the field-set queries live in `routers/schedule.py` and `routers/finals.py`, `ensure_set_timer` returns `None` for a teamwork set), the task text wins.

#### Interfaces for Task 1: Tables, columns and audit exclusions
Files: `models/scoring_draft.py` (new), `models/field_set.py`, `models/session.py`, `models/skills.py`, `models/__init__.py`, baseline migration, `audit.py`. Test: `server/tests/test_scoring_tables.py`.
- Produces `FieldSet.purpose: str` (`"teamwork"` default, `server_default="teamwork"`), constants in `models/field_set.py`: `TEAMWORK = "teamwork"`, `SKILLS = "skills"`.
- Produces `Session.live_scores_qualification: bool = True`, `Session.live_scores_finals: bool = False` (server defaults `1` / `0`).
- Produces `SkillsAttempt.field_id: int | None` (no FK).
- Produces `ScoreDraft(id, match_id FK matches ondelete CASCADE, alliance_id FK alliances ondelete CASCADE unique, data_json: str default "{}", teams_json: str default "[]", item_meta_json: str default "{}", version: int default 0, updated_at: datetime)`; table `score_drafts`.
- Produces `SkillsSetTimer(id, field_set_id FK field_sets ondelete CASCADE unique, skills_type: str | None, phase: str default "ready", deadline: datetime | None, paused: bool default False, remaining_seconds_at_pause: int | None)`; table `skills_set_timers`.
- Produces `SkillsRun(id, field_id FK fields ondelete CASCADE unique, field_set_id: int, session_id: int, team_id FK teams ondelete CASCADE, skills_type: str, data_json, item_meta_json, version: int default 0, follows_set: bool default True, phase: str default "ready", deadline, paused, remaining_seconds_at_pause, created_by_device: str | None, created_at)`; table `skills_runs`.
- Produces `ScorerBinding(id, session_id FK sessions ondelete CASCADE, device_id FK devices ondelete CASCADE, field_id FK fields ondelete CASCADE)`, unique (`session_id`, `device_id`); table `scorer_bindings`.
- `audit.py` excludes `score_drafts`, `skills_set_timers`, `skills_runs`, `scorer_bindings`.

#### Interfaces for Task 2: Field-set purpose and session switches through the API
Files: `schemas/field_set.py`, `routers/field_sets.py`, `schemas/session.py`, `routers/sessions.py`, `services/scheduling.py` / `routers/schedule.py`, `routers/finals.py` / `services/finals.py`, `routers/matches.py` (start guard / Match Control reads), `services/displays.py` (audience In Match switch), `services/skills_runs.py` (only `ensure_set_timer`). Tests: `server/tests/test_field_set_purpose.py`, `server/tests/test_session_live_switches.py`.
- `FieldSetCreate` / `FieldSetUpdate` gain `purpose`; `FieldSetRead.purpose`. Changing to `skills` while the set has any match → 409 `"This field set has matches."`; to `teamwork` while it has any `skills_runs` → 409 `"This field set has skills runs."`.
- `SessionRead` / session update gain `live_scores_qualification`, `live_scores_finals`. A change to either broadcasts via `live_scores.on_switches_changed(app, db, session_id)` (Task 7 provides it; Task 2 calls a no-op stub defined in `services/live_scores.py` with that exact signature, which Task 7 fills in).
- Schedule generation, finals creation and Match Control's field-group reads use `purpose == "teamwork"` sets only; creating a match on a skills field → 409 `"This is a skills field set."`; the audience In Match switch never fires for skills sets.
- Produces `services/skills_runs.ensure_set_timer(db, field_set) -> SkillsSetTimer` (creates the row for a skills set; deletes it when the set becomes teamwork). Called on create and purpose change.

#### Interfaces for Task 3: `run_seconds` in the plugin contract
Files: `plugins/games/sample_cooperative/plugin.py`, the conformance checks (find with `grep -rn "skills_types" server/src/tournament_server/plugin*` / the `tm test-plugin` implementation), `services/skills.py` (`plugin_types`), `routers/skills.py` (types listing), core spec §5.1 line for `skills_types()`. Tests: `server/tests/test_plugin_conformance.py`, `server/tests/test_sample_cooperative_plugin.py`, `server/tests/test_skills_settings.py`.
- Each `skills_types()` entry is `{"key", "label", "run_seconds"}`; conformance fails when `run_seconds` is missing, not an int, or ≤ 0.
- Produces `services/skills.run_seconds(plugin, skills_type) -> int | None` (None when the plugin omits it; callers refuse with 409 `"This skills type has no run length."`).
- The skills types API response gains `run_seconds`.

#### Interfaces for Task 4: Role-filtered live broadcasts
Files: `realtime.py`, `routers/websockets.py`. Test: `server/tests/test_realtime_roles.py`.
- `register_active_session(app, websocket, role: str)` records the role (existing callers pass `caller.role`).
- Produces `broadcast_active_session(app, event, data, roles: tuple[str, ...] | None = None)`; `None` = everyone (today's behaviour). `"admin"` is never implied: pass it explicitly.
- Produces `send_to_devices_and_admins(app, device_ids: list[int], event, data)` for `scorer_binding_changed`.

#### Interfaces for Task 5: Extract the official score write
Files: `services/score_submission.py` (new), `routers/scores.py`. Test: existing `server/tests/test_scores.py`, `test_cooperative_scoring.py`, `test_per_team_flags_*.py` stay green unchanged; new `server/tests/test_score_submission_service.py`.
- Produces `class ScoreRefused(Exception): status_code: int; detail: object`.
- Produces `write_alliance_score(db, plugin, match, alliance, *, data: dict, teams: list[TeamFlags], sitting: bool, force: bool, submitted_by: str | None, is_admin: bool) -> tuple[ScoreRecord, int, bool]` — validates, computes, writes (and mirrors for cooperative), commits; returns `(record, computed_score, mirrored_to_partners)`. Raises `ScoreRefused` for every 409/422 the route raises today, with the same details.
- Produces `after_scores_written(app, db, plugin, match, alliance_ids: list[int]) -> None` — broadcasts `score_saved` per alliance, completes the match, clears queued overrides, advances finals or recomputes rankings (exactly today's tail).
- `submit_score` route becomes a thin wrapper over these two; behaviour identical.

#### Interfaces for Task 6: Teamwork drafts: read and merge
Files: `services/drafts.py` (new), `schemas/draft.py` (new), `routers/drafts.py` (new), `app.py`. Test: `server/tests/test_drafts.py`.
- Schemas: `DraftPatch(changes: dict[str, Any] = {}, teams: list[TeamFlags] | None = None)` (`extra=forbid`); `AllianceDraftRead(alliance_id, data: dict, teams: list[TeamFlags], item_meta: dict[str, ItemMeta], version: int, score: int)`; `ItemMeta(device_name: str, at: datetime)`; `MatchDraftRead(match_id, submitted: bool, alliances: list[AllianceDraftRead])`.
- `services/drafts.py` produces: `draft_alliance_id(db, plugin, match, alliance_id) -> int` (cooperative → lowest alliance id of the match); `item_violations(schema: list[dict], changes: dict, *, scope: str, team_ids: list[int]) -> list[str]` (unknown name, wrong type, outside min/max, option not allowed); `apply_patch(db, plugin, match, alliance, patch: DraftPatch, device_name: str) -> ScoreDraft` (commits; raises `ScoreRefused`); `read_match_draft(db, plugin, match) -> MatchDraftRead`; `draft_score(plugin, draft: ScoreDraft, team_ids, finals: bool) -> int` (0 when `calculate_score` raises); `is_submitted(db, match) -> bool` (every alliance has a `ScoreRecord`); `delete_match_drafts(db, match_ids: list[int]) -> None` (no commit).
- Routes: `GET /api/matches/{id}/draft` (any scoring role, admin, and referee) → `MatchDraftRead`; `PATCH /api/matches/{id}/alliances/{aid}/draft` → `AllianceDraftRead` (dependencies `require_scorer_or_referee` + `require_paired_scoring_device`; device name or `"Admin"` as `device_name`). 409 `SCORE_ALREADY_SUBMITTED_DETAIL` once submitted; 409 `qualification.NOT_PLAYED_SCORE_DETAIL` for not played; 422 `{"violations": [...]}` for bad items; 404 for unknown match/alliance.
- After each PATCH: `broadcast_active_session(app, "score_draft_changed", AllianceDraftRead + {"match_id"}, roles=("admin", "scorer", "referee"))` and `live_scores.on_draft_changed(app, db, match)` (Task 7; stub until then).

#### Interfaces for Task 7: Live scores for teamwork matches
Files: `services/live_scores.py`, `routers/displays.py`, `routers/matches.py` (call sites), `routers/sessions.py` (already calls `on_switches_changed`). Test: `server/tests/test_live_scores.py`.
- Produces `LIVE_PHASES = frozenset({...})` (Global Constraints list); `match_live_allowed(db, match) -> bool`; `match_payload(db, plugin, match) -> dict` (`{"match_id", "alliances": [{"alliance_id", "score"}]}`); `on_draft_changed(app, db, match)`; `on_match_phase_changed(app, db, match)` (sends totals when the match becomes live and allowed, `{"match_id", "cleared": True}` when it stops being live); `on_switches_changed(app, db, session_id)` (re-evaluates every live match of the session); `live_snapshot(db, plugin, field_set_id) -> dict` (`{"matches": [...], "skills": [...]}`; skills part from Task 10's `skills_live_payloads`, empty until then).
- Every `match_phase_changed` and `match_reset` broadcast in `routers/matches.py` (and the auto-advance task) is followed by `on_match_phase_changed`.
- `GET /api/displays/live-scores?field_set_id=` (any role incl. `display_device`) → `live_snapshot`.
- `live_score` goes out with `roles=("display_device", "admin")`.

#### Interfaces for Task 8: Submit, reset and draft cleanup
Files: `routers/drafts.py`, `services/drafts.py`, `routers/matches.py` (reset whole-match, not-played), `services/deletion.py`, `routers/schedule.py` (DELETE schedule), `routers/qualification.py` or wherever not-played is set. Test: `server/tests/test_draft_submit.py`.
- `POST /api/matches/{id}/submit` body `SubmitRequest(force: bool = False)` → `MatchDraftRead` with `submitted: true`. Locks with `db.execute(select(Match).where(Match.id == id).with_for_update())` plus a re-check of `is_submitted` inside the transaction (SQLite serialises writers; the re-check is what makes the second Submit 409). Missing draft → 409 `"Alliance {id} has no draft score."`; plugin violations → 422 `{"violations": [{"alliance_id", "messages"}]}` unless `force`. Writes via `write_alliance_score` per alliance (cooperative: once, on the shared alliance), deletes drafts, commits, then `after_scores_written`, `broadcast_active_session(app, "match_submitted", {"match_id"})` and `live_scores.on_match_phase_changed`.
- Whole-match reset deletes drafts and broadcasts `score_draft_changed` with empty drafts (`version: 0`); section reset keeps them.
- Marking not played and every match deletion path call `delete_match_drafts`.

#### Interfaces for Task 9: Skills runs: create, draft, discard, read
Files: `services/skills_runs.py`, `schemas/skills_run.py` (new), `routers/skills_runs.py` (new), `app.py`. Test: `server/tests/test_skills_runs.py`.
- Schemas: `SkillsRunCreate(team_id: int, skills_type: str | None = None, follows_set: bool = True)`; `SkillsRunRead(id, field_id, field_set_id, team_id, team_number: str, team_name: str, skills_type, data, item_meta, version, score: int, follows_set, phase, deadline, paused, remaining_seconds)`; `SkillsSetTimerRead(field_set_id, skills_type, phase, deadline, paused, remaining_seconds, run_seconds: int | None)`; `SkillsSetRead(timer: SkillsSetTimerRead, fields: list[{field_id, name, run: SkillsRunRead | None}])`.
- Produces `create_run(db, plugin, field, payload, device_name) -> SkillsRun`; `patch_run(db, plugin, field, changes: dict, device_name) -> SkillsRun`; `discard_run(db, field) -> None`; `read_set(db, plugin, field_set) -> SkillsSetRead`; `effective_timer(run, set_timer) -> tuple[phase, deadline, paused, remaining]` (the set's when `follows_set`); `notify(app, field_set_id, field_id=None)` (broadcasts `skills_run_changed` to admin, scorer, referee, display_device and calls `live_scores.on_skills_changed`).
- Routes: `POST /api/fields/{id}/skills-run`, `PATCH /api/fields/{id}/skills-run/draft` (`DraftPatch` without `teams`), `DELETE /api/fields/{id}/skills-run`, `GET /api/field-sets/{id}/skills`. Teamwork field/set → 409 `"This is not a skills field."` / `"This is not a skills field set."`. Create checks: skills enabled, team checked in, attempts left for that type, no run on the field (409 `"This field already has a run."`), type differs from set's only with `follows_set: false`.

#### Interfaces for Task 10: Skills timers, submit and skills live scores
Files: `services/skills_runs.py`, `routers/skills_runs.py`, `services/live_scores.py`. Test: `server/tests/test_skills_timers.py`.
- Routes: `POST /api/fields/{id}/skills-run/{start|pause|resume|end|reset}`, `POST /api/field-sets/{id}/skills-timer/{start|pause|resume|end|reset}`, `PUT /api/field-sets/{id}/skills-timer` body `{skills_type}`, `POST /api/fields/{id}/skills-run/submit` body `SubmitRequest`.
- Field timer actions set `follows_set = False` (copying the set's current timer state first). Set Start refused (409 `"No run is following this field set."`) when no run follows; a set Start sets `deadline = now + run_seconds` on the set timer; phases past the deadline read as `ended` (computed in `effective_timer`). Type change while any run exists → 409 `"Finish or discard this set's runs first."`.
- Submit re-checks the attempt limit inside the transaction, validates with `skills_rules.scoresheet_violations` (422 unless `force`), writes the attempt through the existing skills service with `field_id`, deletes the run, broadcasts `skills_changed` (existing) and `skills_run_changed`.
- `live_scores` produces `skills_live_payloads(db, plugin, field_set_id) -> list[dict]` (`{"field_id", "score"}` while running and allowed; `{"field_id", "breakdown": [{"label", "value"}], "score"}` once ended until submit/discard) and `on_skills_changed(app, db, field_set_id)`.

#### Interfaces for Task 11: Scorer bindings
Files: `services/scorer_bindings.py` (new), `routers/bindings.py` (new), `routers/devices.py`, `schemas/device.py`, `routers/fields.py` / `services/deletion.py` (clear on delete), `app.py`. Test: `server/tests/test_scorer_bindings.py`.
- `GET/PUT/DELETE /api/devices/me/binding` (scorer/referee devices; PUT body `{field_id}`, field must be in the active session → else 422 `"Pick a field in the active session."`), `DELETE /api/devices/{id}/binding` (admin).
- `DeviceRead.binding: {field_id, field_name} | None` for the active session.
- Every change broadcasts `scorer_binding_changed {device_id}` via `send_to_devices_and_admins`.

#### Interfaces for Task 12: Shared draft sync
Files: `frontend/packages/shared/src/scoring/{types.ts,api.ts,mergeDraft.ts,useLiveDraft.ts,index.ts}`, `src/index.ts`. Test: `frontend/packages/shared/tests/scoring.test.ts(x)`.
- Types mirror Tasks 6, 9, 10 (`AllianceDraft`, `MatchDraft`, `ItemMeta`, `SkillsRun`, `SkillsSet`, `SkillsSetTimer`).
- `mergeIncoming(local: AllianceDraft, incoming: AllianceDraft, pending: Record<string, unknown>) -> AllianceDraft` (newer version wins; still-pending local items stay on top).
- `changedByOthers(prev, next, myDevice) -> string[]` (item keys to flash).
- `useLiveDraft({ matchId, myDeviceName, socketEvents })` → `{ draft, setItem(allianceId, key, value), setTeamFlag(allianceId, teamId, flag, value), pending, offline, flashing: Record<string, string>, submit(force?), submitted, violations, gone }`. Sends PATCHes in order, one in flight; queues while offline; on reconnect flushes then refetches.
- `useSkillsRun({ fieldId, … })` with the same shape for one run.

#### Interfaces for Task 13: Shared live scoring page
Files: `frontend/packages/shared/src/scoring/{LiveScoringPage.tsx,ClockControls.tsx,SkillsRunPanel.tsx}`. Test: `frontend/packages/shared/tests/LiveScoringPage.test.tsx`.
- `LiveScoringPage({ matchId, t, myDeviceName, match, alliances, schema, matchFormat })`: one column per alliance (tabs under 720 px), team flag toggles, score so far, flash "Changed by <device>", offline banner, Submit / Submit anyway, Saved view, gone view.
- `ClockControls({ match, matchFormat, t, onAction })`: Start / Start driver, Pause/Resume, Reset timer (two-part: "Reset current segment" → scope `section`, "Reset entire match timer" → scope `full`, with the drafts-cleared warning), End.
- `SkillsRunPanel({ fieldId, t, … })`: team, type, field and set timer controls, sheet, Submit, Discard.

#### Interfaces for Task 14: Admin scoring, correction and Match Control controls
Files: `routes/MatchScoringRoute.tsx` (new, `/sessions/:sessionId/matches/:matchId/score`), `routes/SessionMatchesRoute.tsx`, `routes/MatchControlRoute.tsx`, `router.tsx`, i18n. Tests: `tests/unit/MatchScoringRoute.test.tsx`, existing Match Control / Matches tests extended.
- Unsubmitted match → `LiveScoringPage`. Submitted → read-only scores with "Correct score", which posts `POST /api/matches/{id}/alliances/{aid}/score` per alliance (any session).
- Match Control: "Score" on the current match; "Hide live scores" / "Show live scores" toggles the session switch for the current match's round; "Waiting for score" clears on `match_submitted`.

#### Interfaces for Task 15: Skills Control
Files: `routes/SkillsControlRoute.tsx` (new, `/skills-control`), `skillsControl/*`, `components/AppShell.tsx`, `router.tsx`, i18n. Test: `tests/unit/SkillsControlRoute.test.tsx`.
- One card per skills set of the active session: type select (disabled while any run exists), set countdown and controls, a row per field (team, type, follows set / alone with its countdown, state, Score → `SkillsRunPanel` in a modal or sub-route, Discard, field timer controls, "Start run" picking a checked-in team with attempts left). Empty state links to the Fields page. Refreshes on `skills_run_changed`.

#### Interfaces for Task 16: Admin settings surfaces
Files: `routes/SessionFieldsRoute.tsx`, `routes/SessionsRoute.tsx`, `routes/DevicesRoute.tsx`, `routes/SessionSkillsRoute.tsx` (+ its components), i18n. Tests: their unit tests extended.
- Fields: purpose select per set; teamwork and skills sets in separate sections; shows the server's 409 messages.
- Sessions: the two switches in the session form.
- Devices: Group column shows "Scoring · <field>" for a binding, with Clear (`DELETE /api/devices/{id}/binding`).
- Skills page: attempts show their field name when `field_id` is set.

#### Interfaces for Task 17: Displays: live totals and skills TVs
Files: device `display/useLiveScores.ts` (new), `display/components/InMatchView.tsx`, `display/components/AllianceBands.tsx`, `display/SkillsFieldDisplay.tsx` (new), `display/SkillsSetDisplay.tsx` (new), `display/FieldDisplay.tsx` / `display/GroupView.tsx` (route skills groups), `display/events.ts`, `display/api.ts`, i18n, `styles/display.css`. Tests: `tests/unit/liveScores.test.tsx`, `tests/unit/skillsDisplays.test.tsx`.
- `useLiveScores(fieldSetId)` fetches `GET /api/displays/live-scores` once and applies `live_score` events (`cleared` removes).
- In Match: each alliance's total under its band with a "Live" tag while present.
- Skills field TV states per spec §11; skills set TV: set name, type, set countdown, no scores.

#### Interfaces for Task 18: End-to-end tests
Files: `frontend/apps/admin/tests/e2e/liveScoring.spec.ts` (ports 8143 / 5204 / 5205). Golden paths per spec §13 Playwright list.

#### Interfaces for Task 19: Documentation
Files: `server/CLAUDE.md` (drafts, live scores, skills runs, bindings, events), `frontend/CLAUDE.md` (scoring page, Skills Control, E2E ports), `PRODUCT.md`, core spec §6 and §10 lines, the live-scoring spec status line.

---

### Task 1: Tables, columns and audit exclusions

**Files:**
- Create: `server/src/tournament_server/models/scoring_draft.py`
- Modify: `server/src/tournament_server/models/field_set.py`, `models/session.py`, `models/skills.py`, `models/__init__.py`
- Modify: `server/src/tournament_server/_alembic/versions/000000000001_baseline.py` (the `sessions`, `field_sets` and `skills_attempts` blocks, four new tables, `downgrade()`)
- Modify: `server/src/tournament_server/audit.py` (`_EXCLUDED_TABLES`, lines 26-56)
- Test: `server/tests/test_scoring_tables.py`

**Interfaces:**
- Produces (`models/field_set.py`): `TEAMWORK = "teamwork"`, `SKILLS = "skills"`, `FieldSet.purpose: str` (`default=TEAMWORK`, `server_default="teamwork"`).
- Produces (`models/session.py`): `TournamentSession.live_scores_qualification: bool` (default `True`, server default `1`), `TournamentSession.live_scores_finals: bool` (default `False`, server default `0`).
- Produces (`models/skills.py`): `SkillsAttempt.field_id: int | None` (plain integer, no FK).
- Produces (`models/scoring_draft.py`):
  - `ScoreDraft(id, match_id FK matches ondelete CASCADE, alliance_id FK alliances ondelete CASCADE unique, data_json: str = "{}", teams_json: str = "[]", item_meta_json: str = "{}", version: int = 0, updated_at: datetime)`; table `score_drafts`.
  - `SkillsSetTimer(id, field_set_id FK field_sets ondelete CASCADE unique, skills_type: str | None, phase: str = "ready", deadline: datetime | None, paused: bool = False, remaining_seconds_at_pause: int | None)`; table `skills_set_timers`.
  - `SkillsRun(id, field_id FK fields ondelete CASCADE unique, field_set_id: int, session_id: int, team_id FK teams ondelete CASCADE, skills_type: str, data_json: str = "{}", item_meta_json: str = "{}", version: int = 0, follows_set: bool = True, phase: str = "ready", deadline, paused: bool = False, remaining_seconds_at_pause: int | None, created_by_device: str | None, created_at: datetime)`; table `skills_runs`.
  - `ScorerBinding(id, session_id FK sessions ondelete CASCADE, device_id FK devices ondelete CASCADE, field_id FK fields ondelete CASCADE)`, unique (`session_id`, `device_id`); table `scorer_bindings`.
- Produces (`audit.py`): `score_drafts`, `skills_set_timers`, `skills_runs`, `scorer_bindings` in `_EXCLUDED_TABLES`.

The database runs with `PRAGMA foreign_keys=ON` (`db.make_engine`), so the `ON DELETE CASCADE` keys remove drafts, runs, timers and bindings whenever the existing delete paths delete a match's alliances (`services/deletion.delete_matches`), a field, a field set, a team, a session or a device. No delete helper changes in this task.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_scoring_tables.py`:

```python
"""The live-scoring tables: defaults, unique keys, cascades and the audit
exclusions (live scoring design section 4)."""
from __future__ import annotations

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from device_helpers import paired_device
from display_helpers import add_field_set, add_match, add_teams, setup_event
from tournament_server.audit import AuditLog
from tournament_server.models.field_set import SKILLS, TEAMWORK, FieldSet
from tournament_server.models.match import Match
from tournament_server.models.scoring_draft import ScoreDraft, ScorerBinding, SkillsRun, SkillsSetTimer
from tournament_server.models.session import TournamentSession
from tournament_server.models.skills import SkillsAttempt
from tournament_server.services.deletion import delete_matches

LIVE_TABLES = ("score_drafts", "skills_set_timers", "skills_runs", "scorer_bindings")


def _skills_rows(client) -> dict:
    """A set with two fields, a timer on the set, a run and a binding on its first field."""
    session_id = setup_event(client)
    skills_set = add_field_set(client, session_id, name="Skills", fields=("Skills 1", "Skills 2"))
    team_id = add_teams(client, count=1)[0]
    device = paired_device(client, role="scorer")
    with client.app.state.session_factory() as db:
        db.add(SkillsSetTimer(field_set_id=skills_set["id"]))
        db.add(
            SkillsRun(
                field_id=skills_set["field_ids"][0],
                field_set_id=skills_set["id"],
                session_id=session_id,
                team_id=team_id,
                skills_type="driver",
            )
        )
        db.add(ScorerBinding(session_id=session_id, device_id=device["id"], field_id=skills_set["field_ids"][0]))
        db.commit()
    return {"session_id": session_id, "set": skills_set, "team_id": team_id, "device": device}


def _count(client, model) -> int:
    with client.app.state.session_factory() as db:
        return len(db.execute(select(model)).scalars().all())


def test_field_sets_are_teamwork_and_sessions_show_qualification_scores_by_default(client):
    session_id = setup_event(client)
    field_set = add_field_set(client, session_id)
    assert (TEAMWORK, SKILLS) == ("teamwork", "skills")
    with client.app.state.session_factory() as db:
        assert db.get(FieldSet, field_set["id"]).purpose == "teamwork"
        session_obj = db.get(TournamentSession, session_id)
        assert session_obj.live_scores_qualification is True
        assert session_obj.live_scores_finals is False


def test_the_database_fills_the_new_defaults_for_rows_written_without_them(client):
    session_id = setup_event(client)
    with client.app.state.session_factory() as db:
        event_id = db.get(TournamentSession, session_id).event_id
        db.execute(text("INSERT INTO sessions (event_id, label) VALUES (:event_id, 'Raw')"), {"event_id": event_id})
        db.execute(
            text("INSERT INTO field_sets (session_id, name) VALUES (:session_id, 'Raw Set')"),
            {"session_id": session_id},
        )
        db.commit()
        switches = db.execute(
            text("SELECT live_scores_qualification, live_scores_finals FROM sessions WHERE label = 'Raw'")
        ).one()
        assert tuple(switches) == (1, 0)
        purpose = db.execute(text("SELECT purpose FROM field_sets WHERE name = 'Raw Set'")).scalar_one()
        assert purpose == "teamwork"


def test_a_score_draft_starts_empty_and_an_alliance_has_at_most_one(client):
    session_id = setup_event(client)
    match = add_match(client, session_id, None, 1, add_teams(client))
    red_id = match["alliances"][0]["id"]
    with client.app.state.session_factory() as db:
        draft = ScoreDraft(match_id=match["id"], alliance_id=red_id)
        db.add(draft)
        db.commit()
        db.refresh(draft)
        assert (draft.data_json, draft.teams_json, draft.item_meta_json, draft.version) == ("{}", "[]", "{}", 0)
        assert draft.updated_at is not None
        db.add(ScoreDraft(match_id=match["id"], alliance_id=red_id))
        with pytest.raises(IntegrityError):
            db.commit()


def test_skills_timers_and_runs_start_ready(client):
    _skills_rows(client)
    with client.app.state.session_factory() as db:
        timer = db.execute(select(SkillsSetTimer)).scalar_one()
        assert (timer.skills_type, timer.phase, timer.deadline, timer.paused, timer.remaining_seconds_at_pause) == (
            None, "ready", None, False, None,
        )
        run = db.execute(select(SkillsRun)).scalar_one()
        assert (
            run.data_json, run.item_meta_json, run.version, run.follows_set,
            run.phase, run.deadline, run.paused, run.remaining_seconds_at_pause, run.created_by_device,
        ) == ("{}", "{}", 0, True, "ready", None, False, None, None)
        assert run.created_at is not None


def test_one_timer_per_set_one_run_per_field_and_one_binding_per_device_and_session(client):
    rows = _skills_rows(client)
    duplicates = [
        SkillsSetTimer(field_set_id=rows["set"]["id"]),
        SkillsRun(
            field_id=rows["set"]["field_ids"][0], field_set_id=rows["set"]["id"],
            session_id=rows["session_id"], team_id=rows["team_id"], skills_type="driver",
        ),
        ScorerBinding(session_id=rows["session_id"], device_id=rows["device"]["id"], field_id=rows["set"]["field_ids"][1]),
    ]
    for duplicate in duplicates:
        with client.app.state.session_factory() as db:
            db.add(duplicate)
            with pytest.raises(IntegrityError):
                db.commit()


def test_deleting_a_field_removes_its_run_and_bindings_but_not_the_set_timer(client):
    rows = _skills_rows(client)
    assert client.delete(f"/api/fields/{rows['set']['field_ids'][0]}").status_code == 204
    assert _count(client, SkillsRun) == 0
    assert _count(client, ScorerBinding) == 0
    assert _count(client, SkillsSetTimer) == 1


def test_deleting_a_field_set_removes_its_timer_and_runs(client):
    rows = _skills_rows(client)
    assert client.delete(f"/api/field-sets/{rows['set']['id']}").status_code == 204
    assert _count(client, SkillsSetTimer) == 0
    assert _count(client, SkillsRun) == 0


def test_deleting_a_device_removes_its_binding(client):
    rows = _skills_rows(client)
    assert client.delete(f"/api/devices/{rows['device']['id']}").status_code == 204
    assert _count(client, ScorerBinding) == 0


def test_deleting_a_match_removes_its_drafts(client):
    session_id = setup_event(client)
    match = add_match(client, session_id, None, 1, add_teams(client))
    with client.app.state.session_factory() as db:
        for alliance in match["alliances"]:
            db.add(ScoreDraft(match_id=match["id"], alliance_id=alliance["id"]))
        db.commit()
    with client.app.state.session_factory() as db:
        delete_matches(db, [db.get(Match, match["id"])])
        db.commit()
    assert _count(client, ScoreDraft) == 0


def test_a_skills_attempt_keeps_its_field_id_after_the_field_is_deleted(client):
    rows = _skills_rows(client)
    field_id = rows["set"]["field_ids"][1]
    with client.app.state.session_factory() as db:
        attempt = SkillsAttempt(
            session_id=rows["session_id"], team_id=rows["team_id"], skills_type="driver", data_json="{}",
            score=0, plugin_name="example-game", plugin_version="1.0.0", field_id=field_id,
        )
        db.add(attempt)
        db.commit()
        attempt_id = attempt.id
    assert client.delete(f"/api/fields/{field_id}").status_code == 204
    with client.app.state.session_factory() as db:
        assert db.get(SkillsAttempt, attempt_id).field_id == field_id


def test_live_scoring_rows_are_never_audited(client):
    rows = _skills_rows(client)
    match = add_match(client, rows["session_id"], None, 1, add_teams(client, start=201))
    with client.app.state.session_factory() as db:
        db.add(ScoreDraft(match_id=match["id"], alliance_id=match["alliances"][0]["id"]))
        run = db.execute(select(SkillsRun)).scalar_one()
        run.version += 1
        db.commit()
        db.delete(db.execute(select(ScorerBinding)).scalar_one())
        db.commit()
        audited = db.execute(select(AuditLog.table_name).where(AuditLog.table_name.in_(LIVE_TABLES))).all()
        assert audited == []
        # The generic hook still audits everything else.
        assert db.execute(select(AuditLog.id).where(AuditLog.table_name == "field_sets")).first() is not None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/pytest -q tests/test_scoring_tables.py`
Expected: collection error, `ImportError: cannot import name 'SKILLS' from 'tournament_server.models.field_set'`.

- [ ] **Step 3: Add the models**

Replace `server/src/tournament_server/models/field_set.py` with:

```python
from __future__ import annotations

import datetime as dt

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime

# A field set's purpose (live scoring design §4.1): teamwork sets run
# matches; skills sets run skills runs and are ignored by scheduling,
# finals, Match Control and the audience In Match switch.
TEAMWORK = "teamwork"
SKILLS = "skills"


class FieldSet(Base):
    __tablename__ = "field_sets"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    name: Mapped[str] = mapped_column(String(200))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    # The match an admin queued out of schedule order (display groups design
    # §6.1). A plain integer like Event.active_session_id, not a foreign key:
    # matches already point at field sets through fields, and SQLite can't
    # add the reverse key afterwards. services/deletion.delete_matches clears it.
    queued_match_id: Mapped[int | None] = mapped_column(Integer, default=None)
    # A running time-out ends here; an expired deadline is simply ignored.
    timeout_deadline: Mapped[dt.datetime | None] = mapped_column(UTCDateTime, default=None)
    purpose: Mapped[str] = mapped_column(String(20), default=TEAMWORK, server_default=TEAMWORK)
```

In `server/src/tournament_server/models/session.py` change the import line `from sqlalchemy import Date, ForeignKey, JSON, String` to `from sqlalchemy import Boolean, Date, ForeignKey, JSON, String, text` and add at the end of `TournamentSession`, after `awards_finalized_at`:

```python
    # Whether displays get live totals (live scoring design §7): practice and
    # qualification matches and skills runs follow the first, finals the second.
    live_scores_qualification: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("1"))
    live_scores_finals: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("0"))
```

In `server/src/tournament_server/models/skills.py`, at the end of `SkillsAttempt` after `updated_at`, add:

```python
    # The skills field the run was scored on, when it came from a live run.
    # A plain integer, not a foreign key: a field can be deleted and the
    # attempt stays.
    field_id: Mapped[int | None] = mapped_column(Integer, default=None)
```

Create `server/src/tournament_server/models/scoring_draft.py`:

```python
"""Live scoring's working rows (live scoring design §4): draft scores,
skills field-set timers, skills runs and scorer bindings. None of them is
audited (audit._EXCLUDED_TABLES). Their foreign keys cascade on delete, so
deleting a match's alliances, a field, a field set, a team, a session or a
device takes them along without any helper."""
from __future__ import annotations

import datetime as dt

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime, utc_now


class ScoreDraft(Base):
    """One alliance's unsubmitted scoresheet. A cooperative game keeps one
    shared draft per match, on the match's lowest alliance id."""

    __tablename__ = "score_drafts"
    __table_args__ = (UniqueConstraint("alliance_id", name="uq_score_draft_alliance"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    match_id: Mapped[int] = mapped_column(ForeignKey("matches.id", ondelete="CASCADE"))
    alliance_id: Mapped[int] = mapped_column(ForeignKey("alliances.id", ondelete="CASCADE"))
    # Scoresheet items, item -> value.
    data_json: Mapped[str] = mapped_column(Text, default="{}")
    # Flagged teams only: [{team_id, no_show, dq}].
    teams_json: Mapped[str] = mapped_column(Text, default="[]")
    # item -> {device_name, at}; team flags use team:<id>:no_show / team:<id>:dq.
    item_meta_json: Mapped[str] = mapped_column(Text, default="{}")
    # 0 until the first change, then +1 per accepted PATCH.
    version: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)


class SkillsSetTimer(Base):
    """The shared timer of one skills field set; every run that follows the
    set uses it."""

    __tablename__ = "skills_set_timers"
    __table_args__ = (UniqueConstraint("field_set_id", name="uq_skills_set_timer_field_set"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    field_set_id: Mapped[int] = mapped_column(ForeignKey("field_sets.id", ondelete="CASCADE"))
    # Null until first set; readers fall back to the game's first skills type.
    skills_type: Mapped[str | None] = mapped_column(String(50), default=None)
    # ready / running / ended; a running timer past its deadline reads as ended.
    phase: Mapped[str] = mapped_column(String(20), default="ready")
    deadline: Mapped[dt.datetime | None] = mapped_column(UTCDateTime, default=None)
    paused: Mapped[bool] = mapped_column(Boolean, default=False)
    remaining_seconds_at_pause: Mapped[int | None] = mapped_column(Integer, default=None)


class SkillsRun(Base):
    """The run in progress on one skills field: at most one per field.
    Submit turns it into a skills_attempts row; Discard deletes it."""

    __tablename__ = "skills_runs"
    __table_args__ = (UniqueConstraint("field_id", name="uq_skills_run_field"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    field_id: Mapped[int] = mapped_column(ForeignKey("fields.id", ondelete="CASCADE"))
    # Plain integers: the field already ties the run to its set and session.
    field_set_id: Mapped[int] = mapped_column(Integer)
    session_id: Mapped[int] = mapped_column(Integer)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"))
    skills_type: Mapped[str] = mapped_column(String(50))
    data_json: Mapped[str] = mapped_column(Text, default="{}")
    item_meta_json: Mapped[str] = mapped_column(Text, default="{}")
    version: Mapped[int] = mapped_column(Integer, default=0)
    # True while the run uses the set's timer; the first field-level timer
    # action sets it false and the run's own timer columns take over.
    follows_set: Mapped[bool] = mapped_column(Boolean, default=True)
    phase: Mapped[str] = mapped_column(String(20), default="ready")
    deadline: Mapped[dt.datetime | None] = mapped_column(UTCDateTime, default=None)
    paused: Mapped[bool] = mapped_column(Boolean, default=False)
    remaining_seconds_at_pause: Mapped[int | None] = mapped_column(Integer, default=None)
    created_by_device: Mapped[str | None] = mapped_column(String(200), default=None)
    created_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)


class ScorerBinding(Base):
    """The field a scorer or referee device follows in one session (optional)."""

    __tablename__ = "scorer_bindings"
    __table_args__ = (UniqueConstraint("session_id", "device_id", name="uq_scorer_binding_session_device"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"))
    field_id: Mapped[int] = mapped_column(ForeignKey("fields.id", ondelete="CASCADE"))
```

In `models/__init__.py` add `from tournament_server.models.scoring_draft import ScoreDraft, ScorerBinding, SkillsRun, SkillsSetTimer` after the `score_record_team` import, and add `"ScoreDraft",` and `"ScorerBinding",` after `"ScoreRecordTeam",` and `"SkillsRun",` and `"SkillsSetTimer",` after `"SkillsAttempt",` in `__all__`.

- [ ] **Step 4: Edit the baseline migration in place**

In `000000000001_baseline.py`:

In the `op.create_table('sessions', ...)` block, after `sa.Column('awards_finalized_at', tournament_server.db.UTCDateTime(), nullable=True),` add:

```python
    sa.Column('live_scores_qualification', sa.Boolean(), server_default=sa.text('1'), nullable=False),
    sa.Column('live_scores_finals', sa.Boolean(), server_default=sa.text('0'), nullable=False),
```

In the `op.create_table('field_sets', ...)` block, after `sa.Column('timeout_deadline', tournament_server.db.UTCDateTime(), nullable=True),` add:

```python
    sa.Column('purpose', sa.String(length=20), server_default='teamwork', nullable=False),
```

In the `op.create_table('skills_attempts', ...)` block, after `sa.Column('updated_at', tournament_server.db.UTCDateTime(), nullable=False),` add:

```python
    sa.Column('field_id', sa.Integer(), nullable=True),
```

Directly after the `op.create_table('display_assignments', ...)` block (before `op.create_table('finals_brackets', ...)`), add:

```python
    op.create_table('scorer_bindings',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('session_id', sa.Integer(), nullable=False),
    sa.Column('device_id', sa.Integer(), nullable=False),
    sa.Column('field_id', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['device_id'], ['devices.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['field_id'], ['fields.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('session_id', 'device_id', name='uq_scorer_binding_session_device')
    )
    op.create_table('skills_runs',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('field_id', sa.Integer(), nullable=False),
    sa.Column('field_set_id', sa.Integer(), nullable=False),
    sa.Column('session_id', sa.Integer(), nullable=False),
    sa.Column('team_id', sa.Integer(), nullable=False),
    sa.Column('skills_type', sa.String(length=50), nullable=False),
    sa.Column('data_json', sa.Text(), nullable=False),
    sa.Column('item_meta_json', sa.Text(), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('follows_set', sa.Boolean(), nullable=False),
    sa.Column('phase', sa.String(length=20), nullable=False),
    sa.Column('deadline', tournament_server.db.UTCDateTime(), nullable=True),
    sa.Column('paused', sa.Boolean(), nullable=False),
    sa.Column('remaining_seconds_at_pause', sa.Integer(), nullable=True),
    sa.Column('created_by_device', sa.String(length=200), nullable=True),
    sa.Column('created_at', tournament_server.db.UTCDateTime(), nullable=False),
    sa.ForeignKeyConstraint(['field_id'], ['fields.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['team_id'], ['teams.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('field_id', name='uq_skills_run_field')
    )
    op.create_table('skills_set_timers',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('field_set_id', sa.Integer(), nullable=False),
    sa.Column('skills_type', sa.String(length=50), nullable=True),
    sa.Column('phase', sa.String(length=20), nullable=False),
    sa.Column('deadline', tournament_server.db.UTCDateTime(), nullable=True),
    sa.Column('paused', sa.Boolean(), nullable=False),
    sa.Column('remaining_seconds_at_pause', sa.Integer(), nullable=True),
    sa.ForeignKeyConstraint(['field_set_id'], ['field_sets.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('field_set_id', name='uq_skills_set_timer_field_set')
    )
```

At the end of `upgrade()`, after the `op.create_table('score_record_teams', ...)` block, add:

```python
    op.create_table('score_drafts',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('match_id', sa.Integer(), nullable=False),
    sa.Column('alliance_id', sa.Integer(), nullable=False),
    sa.Column('data_json', sa.Text(), nullable=False),
    sa.Column('teams_json', sa.Text(), nullable=False),
    sa.Column('item_meta_json', sa.Text(), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('updated_at', tournament_server.db.UTCDateTime(), nullable=False),
    sa.ForeignKeyConstraint(['alliance_id'], ['alliances.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['match_id'], ['matches.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('alliance_id', name='uq_score_draft_alliance')
    )
```

At the top of `downgrade()`, before `op.drop_table('display_assignments')`, add:

```python
    op.drop_table('score_drafts')
    op.drop_table('skills_set_timers')
    op.drop_table('skills_runs')
    op.drop_table('scorer_bindings')
```

- [ ] **Step 5: Exclude the new tables from the audit log**

In `server/src/tournament_server/audit.py`, add a paragraph to the comment above `_EXCLUDED_TABLES` (after the "- \"role_credentials\", ..." bullet, before `_EXCLUDED_TABLES = {`):

```python
# - "score_drafts", "skills_set_timers", "skills_runs" and
#   "scorer_bindings" are live scoring's working rows (live scoring design
#   §4.6): a scorer's every counter press writes one, so auditing them would
#   flood the log. The submitted score records and skills attempts they turn
#   into are audited as usual.
```

and change the set to:

```python
_EXCLUDED_TABLES = {
    "audit_log",
    "role_credentials",
    "auth_sessions",
    "signing_keys",
    "password_encryption_keys",
    "devices",
    "score_drafts",
    "skills_set_timers",
    "skills_runs",
    "scorer_bindings",
}
```

- [ ] **Step 6: Run the tests**

Run: `cd server && .venv/bin/pytest -q tests/test_scoring_tables.py tests/test_alembic_drift.py tests/test_alembic_baseline.py tests/test_migrations.py tests/test_audit.py tests/test_audit_log.py`
Expected: all pass.

- [ ] **Step 7: Run the whole server suite**

Run: `cd server && .venv/bin/pytest -q -p no:cacheprovider`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add server/src/tournament_server/models/scoring_draft.py server/src/tournament_server/models/field_set.py \
  server/src/tournament_server/models/session.py server/src/tournament_server/models/skills.py \
  server/src/tournament_server/models/__init__.py server/src/tournament_server/_alembic/versions/000000000001_baseline.py \
  server/src/tournament_server/audit.py server/tests/test_scoring_tables.py
git commit -m "Add the live scoring tables: score drafts, skills set timers, skills runs and scorer bindings, all cascading on delete and left out of the audit log, plus a purpose for field sets, two live-score switches for sessions and a field id on skills attempts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Field-set purpose and session switches through the API

**Files:**
- Modify: `server/src/tournament_server/schemas/field_set.py`, `server/src/tournament_server/routers/field_sets.py` (`create_field_set`, `update_field_set`)
- Modify: `server/src/tournament_server/schemas/session.py`, `server/src/tournament_server/routers/sessions.py` (`create_session`, `update_session`, `copy_fields`)
- Modify: `server/src/tournament_server/routers/schedule.py` (the `field_set_query` in `generate_schedule`, around line 434)
- Modify: `server/src/tournament_server/routers/finals.py` (the field-set pick in `POST /api/finals/start`, lines 207-244)
- Modify: `server/src/tournament_server/routers/matches.py` (`create_match`, `start_match`)
- Modify: `server/src/tournament_server/services/displays.py` (`on_match_started`)
- Create: `server/src/tournament_server/services/skills_runs.py`, `server/src/tournament_server/services/live_scores.py`
- Test: `server/tests/test_field_set_purpose.py`, `server/tests/test_session_live_switches.py`

**Interfaces:**
- Consumes (Task 1): `FieldSet.purpose`, `TEAMWORK`, `SKILLS`, `TournamentSession.live_scores_qualification` / `live_scores_finals`, `SkillsSetTimer`, `SkillsRun`.
- Produces (schemas): `FieldSetCreate.purpose: Literal["teamwork", "skills"] = "teamwork"`, `FieldSetUpdate.purpose: Literal["teamwork", "skills"] | None = None` (explicit null → 422 `"purpose cannot be null"`), `FieldSetRead.purpose: str`. `SessionCreate` / `SessionUpdate` / `SessionRead` gain `live_scores_qualification: bool` and `live_scores_finals: bool` (create defaults `True` / `False`; update fields optional, explicit null → 422 `"<name> cannot be null"`).
- Produces (`PATCH /api/field-sets/{id}`): purpose change to `skills` while the set has a match (or a finals bracket) → 409 `"This field set has matches."`; to `teamwork` while it has a skills run → 409 `"This field set has skills runs."`. A purpose change broadcasts `field_set_changed {field_set_id}`.
- Produces (`services/skills_runs.py`): `SKILLS_SET_DETAIL = "This is a skills field set."`; `ensure_set_timer(db, field_set) -> SkillsSetTimer | None` (creates the timer for a skills set, deletes it for a teamwork set, returns the timer or None; no commit). Called by create, purpose change and copy-fields.
- Produces (`services/live_scores.py`): no-op stubs with the final signatures, filled by Tasks 7 and 10: `on_switches_changed(app, db, session_id) -> None`, `on_draft_changed(app, db, match) -> None`, `on_match_phase_changed(app, db, match) -> None`, `on_skills_changed(app, db, field_set_id) -> None`.
- `PATCH /api/sessions/{id}` calls `live_scores.on_switches_changed(request.app, db, session_id)` after commit when either switch's value actually changed.
- Teamwork-only selection, at every place that picks field sets for matches:
  - `routers/schedule.py` `generate_schedule`: `field_set_query` gains `FieldSet.purpose == TEAMWORK`.
  - `routers/finals.py` `start_finals`: the auto-select query gains `FieldSet.purpose == TEAMWORK`; an explicit skills `field_set_id` → 409 `SKILLS_SET_DETAIL`.
  - `routers/matches.py` `create_match`: a `field_id` on a skills set → 409 `SKILLS_SET_DETAIL`.
  - `routers/matches.py` `start_match` (the start guard): a match whose field is on a skills set → 409 `SKILLS_SET_DETAIL`, checked before the one-running-match guard.
  - `services/displays.on_match_started` (the audience In Match switch): returns `[]` and changes nothing for a skills set.

Plan note: the skeleton lists `services/scheduling.py` and `services/finals.py`, but the field-set queries live in `routers/schedule.py` and `routers/finals.py` (`services/scheduling.py` only builds pairing history; `services/finals.py` only takes the bracket's already-chosen set). Match Control has no server-side field-group read: the admin's `matchControl/useMatchControl.ts` reads `GET /api/field-sets`, so `FieldSetRead.purpose` is what lets Task 14 show teamwork sets only. `ensure_set_timer` returns `SkillsSetTimer | None` (None for a teamwork set) rather than always a timer. The timer's `skills_type` stays null here (no plugin in reach); Tasks 9 and 10 fall back to the game's first type when it is null. A set used by a finals bracket also counts as "has matches", since its runs are created later on that set. `copy_fields` also copies `purpose`.

- [ ] **Step 1: Write the failing field-set tests**

Create `server/tests/test_field_set_purpose.py`:

```python
"""Field-set purpose (live scoring design §4.1): skills sets get a timer,
purpose changes are guarded, and scheduling, finals, match creation, the
start guard and the audience In Match switch use teamwork sets only."""
from __future__ import annotations

from sqlalchemy import select

from display_helpers import BASE_TIME, add_field_set, add_match, add_teams, admin_token, groups, setup_event
from ranking_helpers import finalize_qualification
from schedule_helpers import schedule, set_playing_windows
from skills_helpers import next_event
from tournament_server.models.field_set import FieldSet
from tournament_server.models.match import Match
from tournament_server.models.scoring_draft import SkillsRun, SkillsSetTimer
from tournament_server.services import displays

SKILLS_SET = "This is a skills field set."


def _skills_set(client, session_id: int, name: str = "Skills", fields=("Skills 1", "Skills 2")) -> dict:
    created = client.post("/api/field-sets", json={"session_id": session_id, "name": name, "purpose": "skills"})
    assert created.status_code == 201, created.text
    assert created.json()["purpose"] == "skills"
    field_ids = []
    for field_name in fields:
        field = client.post(
            "/api/fields", json={"session_id": session_id, "field_set_id": created.json()["id"], "name": field_name}
        )
        assert field.status_code == 201, field.text
        field_ids.append(field.json()["id"])
    return {"id": created.json()["id"], "field_ids": field_ids}


def _timer_set_ids(client) -> list[int]:
    with client.app.state.session_factory() as db:
        return [t.field_set_id for t in db.execute(select(SkillsSetTimer).order_by(SkillsSetTimer.id)).scalars().all()]


def _purpose(client, field_set_id: int) -> str:
    with client.app.state.session_factory() as db:
        return db.get(FieldSet, field_set_id).purpose


def test_a_set_is_teamwork_unless_created_for_skills_and_a_skills_set_gets_a_timer(client):
    session_id = setup_event(client)
    add_field_set(client, session_id)
    skills = _skills_set(client, session_id)
    listed = client.get("/api/field-sets", params={"session_id": session_id}).json()
    assert [(fs["name"], fs["purpose"]) for fs in listed] == [("Main Fields", "teamwork"), ("Skills", "skills")]
    assert _timer_set_ids(client) == [skills["id"]]


def test_an_unknown_or_null_purpose_is_refused(client):
    session_id = setup_event(client)
    main = add_field_set(client, session_id)
    bad = client.post("/api/field-sets", json={"session_id": session_id, "name": "Odd", "purpose": "practice"})
    assert bad.status_code == 422
    cleared = client.patch(f"/api/field-sets/{main['id']}", json={"purpose": None})
    assert cleared.status_code == 422
    assert cleared.json()["detail"] == "purpose cannot be null"


def test_changing_the_purpose_creates_and_removes_the_set_timer(client):
    session_id = setup_event(client)
    main = add_field_set(client, session_id)
    to_skills = client.patch(f"/api/field-sets/{main['id']}", json={"purpose": "skills"})
    assert to_skills.status_code == 200, to_skills.text
    assert to_skills.json()["purpose"] == "skills"
    assert _timer_set_ids(client) == [main["id"]]
    to_teamwork = client.patch(f"/api/field-sets/{main['id']}", json={"purpose": "teamwork"})
    assert to_teamwork.status_code == 200, to_teamwork.text
    assert _timer_set_ids(client) == []


def test_a_set_with_matches_cannot_become_a_skills_set(client):
    session_id = setup_event(client)
    main = add_field_set(client, session_id)
    add_match(client, session_id, main["field_ids"][0], 1, add_teams(client))
    refused = client.patch(f"/api/field-sets/{main['id']}", json={"purpose": "skills"})
    assert refused.status_code == 409
    assert refused.json()["detail"] == "This field set has matches."
    assert _purpose(client, main["id"]) == "teamwork"
    assert _timer_set_ids(client) == []


def test_a_set_with_skills_runs_cannot_become_teamwork(client):
    session_id = setup_event(client)
    skills = _skills_set(client, session_id)
    team_id = add_teams(client, count=1)[0]
    with client.app.state.session_factory() as db:
        db.add(
            SkillsRun(
                field_id=skills["field_ids"][0], field_set_id=skills["id"],
                session_id=session_id, team_id=team_id, skills_type="driver",
            )
        )
        db.commit()
    refused = client.patch(f"/api/field-sets/{skills['id']}", json={"purpose": "teamwork"})
    assert refused.status_code == 409
    assert refused.json()["detail"] == "This field set has skills runs."
    assert _purpose(client, skills["id"]) == "skills"
    assert _timer_set_ids(client) == [skills["id"]]


def test_a_purpose_change_announces_the_field_set(client):
    session_id = setup_event(client)
    main = add_field_set(client, session_id)
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        client.patch(f"/api/field-sets/{main['id']}", json={"purpose": "skills"})
        assert next_event(socket, "field_set_changed")["data"] == {"field_set_id": main["id"]}


def test_copying_fields_keeps_each_sets_purpose(client):
    session_id = setup_event(client)
    add_field_set(client, session_id)
    _skills_set(client, session_id)
    other = client.post("/api/sessions", json={"label": "Sunday"}).json()["id"]
    copied = client.post(f"/api/sessions/{other}/copy-fields", json={"source_session_id": session_id})
    assert copied.status_code == 201, copied.text
    assert [(fs["name"], fs["purpose"]) for fs in copied.json()] == [("Main Fields", "teamwork"), ("Skills", "skills")]
    copied_skills_id = copied.json()[1]["id"]
    assert copied_skills_id in _timer_set_ids(client)


def test_schedule_generation_uses_teamwork_sets_only(client):
    session_id = setup_event(client)
    main = add_field_set(client, session_id)
    skills = _skills_set(client, session_id)
    for team_id in add_teams(client, count=8):
        joined = client.post(f"/api/sessions/{session_id}/participants", json={"team_id": team_id, "checked_in": True})
        assert joined.status_code == 201, joined.text
    set_playing_windows(client, session_id)
    response = schedule(client, session_id, [("qualification", 2)])
    assert response.status_code == 201, response.text
    field_ids = {m["field_id"] for m in client.get("/api/matches", params={"session_id": session_id}).json()}
    assert field_ids and field_ids <= set(main["field_ids"])
    assert not field_ids & set(skills["field_ids"])


def test_a_session_with_only_skills_sets_cannot_be_scheduled(client):
    session_id = setup_event(client)
    _skills_set(client, session_id)
    for team_id in add_teams(client, count=8):
        client.post(f"/api/sessions/{session_id}/participants", json={"team_id": team_id, "checked_in": True})
    set_playing_windows(client, session_id)
    response = schedule(client, session_id, [("qualification", 2)])
    assert response.status_code == 422
    assert response.json()["detail"] == "Session has no unassigned FieldSets configured"


def _ranked_cooperative_session(client) -> tuple[int, int]:
    """A cooperative-game session with a finalized qualification of four
    ranked teams; returns (session id, teamwork field set id)."""
    session_id = setup_event(client, game="cooperative-game")
    main = add_field_set(client, session_id, fields=("Field 1",))
    team_ids = add_teams(client, count=4)
    for index, team_id in enumerate(team_ids):
        match = client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": 1000 + index,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [team_id]},
                    {"station": "blue", "team_ids": [team_id]},
                ],
            },
        ).json()
        client.post(
            f"/api/matches/{match['id']}/alliances/{match['alliances'][0]['id']}/score",
            json={"data": {"objects_scored": (4 - index) * 10}},
        )
    finalize_qualification(client, session_id)
    return session_id, main["id"]


def test_finals_pick_the_teamwork_set_when_a_skills_set_exists(cooperative_client):
    client = cooperative_client
    session_id, main_id = _ranked_cooperative_session(client)
    _skills_set(client, session_id)
    started = client.post("/api/finals/start", json={"session_id": session_id, "bracket_size": 2})
    assert started.status_code == 201, started.text
    assert started.json()["field_set_id"] == main_id


def test_finals_refuse_an_explicit_skills_set(cooperative_client):
    client = cooperative_client
    session_id, _ = _ranked_cooperative_session(client)
    skills = _skills_set(client, session_id)
    refused = client.post(
        "/api/finals/start", json={"session_id": session_id, "bracket_size": 2, "field_set_id": skills["id"]}
    )
    assert refused.status_code == 409
    assert refused.json()["detail"] == SKILLS_SET


def test_a_match_on_a_skills_set_cannot_be_created_or_started(client):
    session_id = setup_event(client)
    main = add_field_set(client, session_id)
    team_ids = add_teams(client)
    match = add_match(client, session_id, main["field_ids"][0], 1, team_ids)
    skills = _skills_set(client, session_id)
    created = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 2,
            "field_id": skills["field_ids"][0],
            "scheduled_time": BASE_TIME.isoformat(),
            "alliances": [
                {"station": "red", "team_ids": team_ids[:2]},
                {"station": "blue", "team_ids": team_ids[2:4]},
            ],
        },
    )
    assert created.status_code == 409
    assert created.json()["detail"] == SKILLS_SET
    # A set turned to skills behind the API's back: the start guard still refuses.
    with client.app.state.session_factory() as db:
        db.get(FieldSet, main["id"]).purpose = "skills"
        db.commit()
    refused = client.post(f"/api/matches/{match['id']}/start")
    assert refused.status_code == 409
    assert refused.json()["detail"] == SKILLS_SET
    with client.app.state.session_factory() as db:
        assert db.get(Match, match["id"]).phase == "not_started"


def test_the_audience_in_match_switch_never_fires_for_a_skills_set(client):
    session_id = setup_event(client)
    skills = _skills_set(client, session_id)
    with client.app.state.session_factory() as db:
        assert displays.on_match_started(db, skills["id"]) == []
        db.commit()
    assert groups(client, kind="audience", field_set_id=skills["id"])[0].screen == "logo"
```

- [ ] **Step 2: Write the failing session-switch tests**

Create `server/tests/test_session_live_switches.py`:

```python
"""The two live-score switches on a session (live scoring design §4.1, §7)."""
from __future__ import annotations

import inspect

from tournament_server.services import live_scores


def _event(client) -> None:
    client.post("/api/event", json={"name": "Switch Event"})


def test_a_new_session_shows_qualification_scores_and_hides_finals_scores(client):
    _event(client)
    created = client.post("/api/sessions", json={"label": "Saturday"})
    assert created.status_code == 201
    assert (created.json()["live_scores_qualification"], created.json()["live_scores_finals"]) == (True, False)
    listed = client.get("/api/sessions").json()[0]
    assert (listed["live_scores_qualification"], listed["live_scores_finals"]) == (True, False)


def test_a_session_can_be_created_with_its_switches(client):
    _event(client)
    created = client.post(
        "/api/sessions", json={"label": "Sunday", "live_scores_qualification": False, "live_scores_finals": True}
    ).json()
    assert (created["live_scores_qualification"], created["live_scores_finals"]) == (False, True)


def test_the_switches_are_updated_alone_and_never_nulled(client):
    _event(client)
    session_id = client.post("/api/sessions", json={"label": "Saturday"}).json()["id"]
    updated = client.patch(f"/api/sessions/{session_id}", json={"live_scores_finals": True})
    assert updated.status_code == 200
    assert (updated.json()["live_scores_qualification"], updated.json()["live_scores_finals"]) == (True, True)
    assert updated.json()["label"] == "Saturday"
    refused = client.patch(f"/api/sessions/{session_id}", json={"live_scores_qualification": None})
    assert refused.status_code == 422
    assert refused.json()["detail"] == "live_scores_qualification cannot be null"


def test_only_a_real_switch_change_re_evaluates_live_scores(client, monkeypatch):
    calls = []
    monkeypatch.setattr(live_scores, "on_switches_changed", lambda app, db, session_id: calls.append(session_id))
    _event(client)
    session_id = client.post("/api/sessions", json={"label": "Saturday"}).json()["id"]
    client.patch(f"/api/sessions/{session_id}", json={"label": "Renamed"})
    client.patch(f"/api/sessions/{session_id}", json={"live_scores_qualification": True})
    assert calls == []
    client.patch(f"/api/sessions/{session_id}", json={"live_scores_finals": True})
    client.patch(f"/api/sessions/{session_id}", json={"live_scores_qualification": False, "live_scores_finals": True})
    assert calls == [session_id, session_id]


def test_the_live_scores_hooks_exist_with_their_final_signatures():
    expected = {
        "on_switches_changed": ["app", "db", "session_id"],
        "on_draft_changed": ["app", "db", "match"],
        "on_match_phase_changed": ["app", "db", "match"],
        "on_skills_changed": ["app", "db", "field_set_id"],
    }
    # Signatures only: Tasks 7 and 10 replace the no-op bodies, and this test
    # keeps running after them.
    for name, params in expected.items():
        assert list(inspect.signature(getattr(live_scores, name)).parameters) == params
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && .venv/bin/pytest -q tests/test_field_set_purpose.py tests/test_session_live_switches.py`
Expected: `test_session_live_switches.py` errors at collection with `ImportError: cannot import name 'live_scores' from 'tournament_server.services'`; `test_field_set_purpose.py` tests fail (the create response has no `purpose`, `KeyError: 'purpose'`, and the guards answer 201/200).

- [ ] **Step 4: Add the live-scores stub and the set-timer helper**

Create `server/src/tournament_server/services/live_scores.py`:

```python
"""What displays may see of scores in progress, and pushing it to them
(live scoring design §7). Tasks 7 and 10 fill these in; until then every
hook is a no-op with its final signature, so callers can be wired now."""
from __future__ import annotations

from typing import Any


def on_switches_changed(app: Any, db: Any, session_id: int) -> None:
    """A session's live-score switch changed: re-evaluate its live matches."""
    return None


def on_draft_changed(app: Any, db: Any, match: Any) -> None:
    """A teamwork draft changed: push the match's live totals if allowed."""
    return None


def on_match_phase_changed(app: Any, db: Any, match: Any) -> None:
    """A match's clock moved: start or clear its live totals."""
    return None


def on_skills_changed(app: Any, db: Any, field_set_id: int) -> None:
    """A skills run or timer on this set changed: push its live scores."""
    return None
```

Create `server/src/tournament_server/services/skills_runs.py`:

```python
"""Skills runs and skills field-set timers (live scoring design §4.3, §4.4,
§6). Task 2 adds only the set timer's lifecycle. Nothing here commits."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.field_set import SKILLS, FieldSet
from tournament_server.models.scoring_draft import SkillsSetTimer

SKILLS_SET_DETAIL = "This is a skills field set."


def ensure_set_timer(db: Session, field_set: FieldSet) -> SkillsSetTimer | None:
    """A skills set has exactly one timer row and a teamwork set none: this
    creates or deletes the row to match the set's purpose and returns the
    timer (None for a teamwork set). The timer's skills type stays null
    until it is chosen; readers fall back to the game's first type."""
    timer = db.execute(
        select(SkillsSetTimer).where(SkillsSetTimer.field_set_id == field_set.id)
    ).scalars().first()
    if field_set.purpose == SKILLS:
        if timer is None:
            timer = SkillsSetTimer(field_set_id=field_set.id)
            db.add(timer)
            db.flush()
        return timer
    if timer is not None:
        db.delete(timer)
        db.flush()
    return None
```

- [ ] **Step 5: Field-set schemas and routes**

Replace the three classes at the top of `server/src/tournament_server/schemas/field_set.py` (`FieldSetCreate`, `FieldSetUpdate`, `FieldSetRead`) and its imports with:

```python
from __future__ import annotations

import datetime as dt
from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic import Field as PydanticField

FieldSetPurpose = Literal["teamwork", "skills"]


class FieldSetCreate(BaseModel):
    session_id: int
    name: str
    division_id: int | None = None
    purpose: FieldSetPurpose = "teamwork"


class FieldSetUpdate(BaseModel):
    name: str | None = None
    division_id: int | None = None
    purpose: FieldSetPurpose | None = None


class FieldSetRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    session_id: int
    name: str
    division_id: int | None
    purpose: str = "teamwork"
    queued_match_id: int | None = None
    timeout_deadline: dt.datetime | None = None
```

(`QueuedMatchWrite` and `TimeoutWrite` stay as they are.)

In `server/src/tournament_server/routers/field_sets.py`:

- change `from tournament_server.models.field_set import FieldSet` to `from tournament_server.models.field_set import SKILLS, FieldSet`;
- add `from tournament_server.models.scoring_draft import SkillsRun`;
- change `from tournament_server.services import displays, qualification` to `from tournament_server.services import displays, qualification, skills_runs`;
- add, after `router = APIRouter(...)`:

```python
FIELD_SET_HAS_MATCHES_DETAIL = "This field set has matches."
FIELD_SET_HAS_RUNS_DETAIL = "This field set has skills runs."


def _check_purpose_change(db: Session, field_set: FieldSet, purpose: str) -> None:
    """A set becomes a skills set only with no matches (or finals bracket,
    whose runs would land on it), and a teamwork set only with no runs."""
    if purpose == field_set.purpose:
        return
    if purpose == SKILLS:
        field_ids = displays.field_ids_for_set(db, field_set.id)
        has_match = bool(field_ids) and db.execute(
            select(Match.id).where(Match.field_id.in_(field_ids)).limit(1)
        ).first() is not None
        has_bracket = db.execute(
            select(FinalsBracket.id).where(FinalsBracket.field_set_id == field_set.id).limit(1)
        ).first() is not None
        if has_match or has_bracket:
            raise HTTPException(status_code=409, detail=FIELD_SET_HAS_MATCHES_DETAIL)
        return
    has_run = db.execute(
        select(SkillsRun.id).where(SkillsRun.field_set_id == field_set.id).limit(1)
    ).first() is not None
    if has_run:
        raise HTTPException(status_code=409, detail=FIELD_SET_HAS_RUNS_DETAIL)
```

- in `create_field_set`, change the constructor and the lines after `db.flush()`:

```python
    field_set = FieldSet(
        session_id=payload.session_id,
        name=payload.name,
        division_id=payload.division_id,
        purpose=payload.purpose,
    )
    db.add(field_set)
    db.flush()
    displays.ensure_audience_group(db, field_set)
    skills_runs.ensure_set_timer(db, field_set)
    db.commit()
```

- replace `update_field_set` with:

```python
@router.patch("/{field_set_id}", response_model=FieldSetRead)
def update_field_set(
    field_set_id: int,
    payload: FieldSetUpdate,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> FieldSet:
    field_set = db.get(FieldSet, field_set_id)
    if field_set is None:
        raise HTTPException(status_code=404, detail="FieldSet not found")
    updates = payload.model_dump(exclude_unset=True)
    if "name" in updates:
        name = (updates["name"] or "").strip()
        if not name:
            raise HTTPException(status_code=422, detail="name must not be empty")
        field_set.name = name
    if "division_id" in updates:
        division_id = updates["division_id"]
        if division_id is not None and db.get(Division, division_id) is None:
            raise HTTPException(status_code=404, detail="Division not found")
        field_set.division_id = division_id
    purpose_changed = False
    if "purpose" in updates:
        if updates["purpose"] is None:
            raise HTTPException(status_code=422, detail="purpose cannot be null")
        _check_purpose_change(db, field_set, updates["purpose"])
        purpose_changed = updates["purpose"] != field_set.purpose
        field_set.purpose = updates["purpose"]
        skills_runs.ensure_set_timer(db, field_set)
    db.commit()
    db.refresh(field_set)
    if purpose_changed:
        displays.notify_field_set_changed(request.app, field_set_id)
    return field_set
```

- [ ] **Step 6: Session schemas and routes**

Replace `SessionCreate`, `SessionUpdate` and `SessionRead` in `server/src/tournament_server/schemas/session.py` with:

```python
class SessionCreate(BaseModel):
    label: str
    session_date: dt.date | None = None
    timezone: str | None = None
    live_scores_qualification: bool = True
    live_scores_finals: bool = False


class SessionUpdate(BaseModel):
    label: str | None = None
    session_date: dt.date | None = None
    timezone: str | None = None
    live_scores_qualification: bool | None = None
    live_scores_finals: bool | None = None


class SessionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_id: int
    label: str
    session_date: dt.date | None
    timezone: str | None
    # Whether any match in the session has a score; a scored session can't
    # be deleted.
    has_scored_matches: bool = False
    # When qualification was finalized, and each played count's drops; both
    # null while qualification is open.
    qualification_finalized_at: dt.datetime | None = None
    qualification_drops: dict[str, int] | None = None
    # Whether displays get live totals: practice, qualification and skills
    # follow the first; finals the second (live scoring design §7).
    live_scores_qualification: bool = True
    live_scores_finals: bool = False
```

In `server/src/tournament_server/routers/sessions.py`:

- change `from tournament_server.services import displays` to `from tournament_server.services import displays, live_scores, skills_runs`;
- add after `router = APIRouter(...)`: `LIVE_SCORE_SWITCHES = ("live_scores_qualification", "live_scores_finals")`;
- in `create_session`, pass the switches to the constructor:

```python
    session_obj = TournamentSession(
        event_id=event.id,
        label=payload.label,
        session_date=payload.session_date,
        timezone=payload.timezone,
        live_scores_qualification=payload.live_scores_qualification,
        live_scores_finals=payload.live_scores_finals,
    )
```

- replace `update_session` with:

```python
@router.patch("/{session_id}", response_model=SessionRead)
def update_session(
    session_id: int,
    payload: SessionUpdate,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> SessionRead:
    session_obj = db.get(TournamentSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    updates = payload.model_dump(exclude_unset=True)
    if "label" in updates and updates["label"] is None:
        raise HTTPException(status_code=422, detail="label cannot be null")
    for key in LIVE_SCORE_SWITCHES:
        if key in updates and updates[key] is None:
            raise HTTPException(status_code=422, detail=f"{key} cannot be null")
    if "timezone" in updates and updates["timezone"] is not None:
        try:
            ZoneInfo(updates["timezone"])
        except (ZoneInfoNotFoundError, ValueError):
            raise HTTPException(
                status_code=422, detail=f"Unknown timezone: {updates['timezone']!r}"
            )
    switches_changed = any(
        key in updates and updates[key] != getattr(session_obj, key) for key in LIVE_SCORE_SWITCHES
    )
    for key, value in updates.items():
        setattr(session_obj, key, value)
    db.commit()
    db.refresh(session_obj)
    if switches_changed:
        live_scores.on_switches_changed(request.app, db, session_obj.id)
    return _to_read(session_obj, session_has_scores(db, session_obj.id))
```

- in `copy_fields`, copy the purpose and give a copied skills set its timer:

```python
    for source_set in source_sets:
        copy = FieldSet(
            session_id=session_id,
            name=source_set.name,
            division_id=source_set.division_id,
            purpose=source_set.purpose,
        )
        db.add(copy)
        db.flush()
        displays.ensure_audience_group(db, copy)
        skills_runs.ensure_set_timer(db, copy)
        for field in db.execute(
            select(Field).where(Field.field_set_id == source_set.id).order_by(Field.id)
        ).scalars().all():
            field_copy = Field(field_set_id=copy.id, name=field.name)
            db.add(field_copy)
            db.flush()
            displays.ensure_field_group(db, field_copy)
        copies.append(copy)
```

- [ ] **Step 7: Teamwork sets only for scheduling, finals, match creation, the start guard and the In Match switch**

`server/src/tournament_server/routers/schedule.py`: change `from tournament_server.models.field_set import FieldSet` to `from tournament_server.models.field_set import TEAMWORK, FieldSet` and the first line of the field-set query in `generate_schedule` from

```python
    field_set_query = select(FieldSet).where(FieldSet.session_id == payload.session_id)
```

to

```python
    # Skills sets never get scheduled matches (live scoring design §4.1).
    field_set_query = select(FieldSet).where(
        FieldSet.session_id == payload.session_id, FieldSet.purpose == TEAMWORK
    )
```

`server/src/tournament_server/routers/finals.py`: change `from tournament_server.models.field_set import FieldSet` to `from tournament_server.models.field_set import SKILLS, TEAMWORK, FieldSet`, add `from tournament_server.services.skills_runs import SKILLS_SET_DETAIL`, and in the field-set pick of the start route change

```python
        existing_sets_query = select(FieldSet).where(
            FieldSet.session_id == payload.session_id
        )
```

to

```python
        existing_sets_query = select(FieldSet).where(
            FieldSet.session_id == payload.session_id, FieldSet.purpose == TEAMWORK
        )
```

and in the explicit branch, after the `if field_set is None or field_set.session_id != payload.session_id:` 404 and before the division check, add:

```python
        if field_set.purpose == SKILLS:
            raise HTTPException(status_code=409, detail=SKILLS_SET_DETAIL)
```

`server/src/tournament_server/routers/matches.py`: add `from tournament_server.models.field_set import SKILLS, FieldSet` and `from tournament_server.services.skills_runs import SKILLS_SET_DETAIL`. In `create_match`, replace

```python
    if payload.field_id is not None and db.get(Field, payload.field_id) is None:
        raise HTTPException(status_code=404, detail="Field not found")
```

with

```python
    if payload.field_id is not None:
        field = db.get(Field, payload.field_id)
        if field is None:
            raise HTTPException(status_code=404, detail="Field not found")
        if db.get(FieldSet, field.field_set_id).purpose == SKILLS:
            raise HTTPException(status_code=409, detail=SKILLS_SET_DETAIL)
```

In `start_match`, replace

```python
    field_set_id = displays.field_set_id_for_field(db, match.field_id)
    if field_set_id is not None and displays.running_match(db, field_set_id, exclude_id=match.id) is not None:
        raise HTTPException(status_code=409, detail="Another match is running on this field group.")
```

with

```python
    field_set_id = displays.field_set_id_for_field(db, match.field_id)
    if field_set_id is not None and db.get(FieldSet, field_set_id).purpose == SKILLS:
        raise HTTPException(status_code=409, detail=SKILLS_SET_DETAIL)
    if field_set_id is not None and displays.running_match(db, field_set_id, exclude_id=match.id) is not None:
        raise HTTPException(status_code=409, detail="Another match is running on this field group.")
```

`server/src/tournament_server/services/displays.py`: change `from tournament_server.models.field_set import FieldSet` to `from tournament_server.models.field_set import SKILLS, FieldSet` and replace `on_match_started` with:

```python
def on_match_started(db: Session, field_set_id: int) -> list[int]:
    """A match on this field set just started (spec section 6.3): its audience
    groups move to In Match, keeping their settings, and its override and
    time-out are cleared. Returns the ids of the audience groups it switched.
    A skills set has no In Match screen (live scoring design §11): nothing
    changes and nothing is returned."""
    field_set = db.get(FieldSet, field_set_id)
    if field_set is not None and field_set.purpose == SKILLS:
        return []
    switched = []
    for group in db.execute(
        select(DisplayGroup).where(DisplayGroup.kind == AUDIENCE, DisplayGroup.field_set_id == field_set_id)
    ).scalars().all():
        if group.screen != "in_match":
            group.screen = "in_match"
            switched.append(group.id)
    if field_set is not None:
        field_set.queued_match_id = None
        field_set.timeout_deadline = None
    db.flush()
    return switched
```

- [ ] **Step 8: Run the tests**

Run: `cd server && .venv/bin/pytest -q tests/test_field_set_purpose.py tests/test_session_live_switches.py tests/test_field_sets.py tests/test_fields.py tests/test_sessions.py tests/test_session_copy_fields.py tests/test_schedule.py tests/test_finals.py tests/test_matches.py tests/test_match_control_displays.py tests/test_match_control_endpoints.py tests/test_display_groups.py`
Expected: all pass.

- [ ] **Step 9: Run the whole server suite**

Run: `cd server && .venv/bin/pytest -q -p no:cacheprovider`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add server/src/tournament_server/schemas/field_set.py server/src/tournament_server/routers/field_sets.py \
  server/src/tournament_server/schemas/session.py server/src/tournament_server/routers/sessions.py \
  server/src/tournament_server/routers/schedule.py server/src/tournament_server/routers/finals.py \
  server/src/tournament_server/routers/matches.py server/src/tournament_server/services/displays.py \
  server/src/tournament_server/services/skills_runs.py server/src/tournament_server/services/live_scores.py \
  server/tests/test_field_set_purpose.py server/tests/test_session_live_switches.py
git commit -m "Expose field set purpose and the session live-score switches through the API: skills sets get a timer, purpose changes are refused while a set has matches or runs, scheduling, finals, match creation, the start guard and the audience In Match switch use teamwork sets only, and a switch change calls the live scores hook.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `run_seconds` in the plugin contract

**Files:**
- Modify: `server/src/tournament_server/plugin_registry/conformance.py` (`_check_skills_types`, lines 309-327)
- Modify: `server/plugins/games/sample_cooperative/plugin.py` (`skills_types`, line 87)
- Modify (fixtures, so they keep passing conformance): `server/tests/fixtures/plugins/games/{example-game,cooperative-game,captain-pick-game,fast-timer-game,no-autonomous-game,broken-plugin}/plugin.py` (`skills_types`)
- Modify: `server/src/tournament_server/services/skills.py` (`plugin_types`, new `run_seconds`), `server/src/tournament_server/schemas/skills.py` (`SkillsTypeRead`)
- Modify: `docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md` (§5.1, line 227-228)
- Test: `server/tests/test_plugin_conformance.py`, `server/tests/test_sample_cooperative_plugin.py`, `server/tests/test_skills_settings.py`

**Interfaces:**
- Produces (contract): each `skills_types()` entry is exactly `{"key", "label", "run_seconds"}`; `run_seconds` is a positive `int` (a `bool` is refused). Conformance fails the `skills_types() shape` check otherwise.
- Produces (`services/skills.py`): `NO_RUN_SECONDS_DETAIL = "This skills type has no run length."`; `run_seconds(plugin, skills_type) -> int | None` (None when there is no plugin, the type is unknown, or the plugin omits or mangles `run_seconds`; callers refuse with 409 `NO_RUN_SECONDS_DETAIL`). `plugin_types(plugin)` entries gain `"run_seconds"` (int or None).
- Produces (API): `SkillsTypeRead.run_seconds: int | None`, so `GET /api/skills/settings` `types[]` and `GET /api/sessions/{id}/skills` `types[]` carry it.

Plan note: the test fixture game plugins also need `run_seconds`, or `test_example_plugin_passes_all_checks` and `test_cooperative_game_passes_conformance` fail; they are added to this task's files. `server/CLAUDE.md`'s skills-types sentence is updated in Task 19 with the rest of the docs.

- [ ] **Step 1: Write the failing tests**

In `server/tests/test_plugin_conformance.py`, replace everything from `_GOOD_SKILLS = '''` through the end of `test_bad_skills_types_fail` (lines 486-559) with:

```python
_GOOD_TYPES = (
    '[{"key": "autonomous", "label": "Autonomous", "run_seconds": 60},'
    ' {"key": "driver", "label": "Driver", "run_seconds": 45}]'
)

_GOOD_SKILLS = f'''
def skills_types():
    return {_GOOD_TYPES}


def skills_scoresheet_schema(skills_type):
    return [_field("x", "team")]


def calculate_skills_score(skills_type, scoresheet):
    return int(scoresheet.get("x", 0))
'''


def _write_skills_plugin(tmp_path, skills_code: str):
    (tmp_path / "manifest.json").write_text(
        json.dumps(
            {"name": "skills-variant", "version": "1.0.0", "kind": "game", "display_name": "Skills Variant"}
        )
    )
    (tmp_path / "plugin.py").write_text(_SKILLS_BASE + skills_code)
    return tmp_path


def _named(report, name):
    return next(c for c in report.checks if c.name == name)


def test_valid_skills_types_pass_with_a_check_per_type(tmp_path):
    report = run_conformance_checks(_write_skills_plugin(tmp_path, _GOOD_SKILLS))
    assert report.passed, [c for c in report.checks if not c.passed]
    names = [c.name for c in report.checks]
    assert "skills_types() shape" in names
    for key in ("autonomous", "driver"):
        assert f"skills_scoresheet_schema({key!r}) shape" in names
        assert f"calculate_skills_score({key!r}) determinism" in names


def test_an_empty_type_list_passes_and_skips_per_type_checks(tmp_path):
    code = _GOOD_SKILLS.replace(_GOOD_TYPES, "[]").replace('return [_field("x", "team")]', "return []")
    report = run_conformance_checks(_write_skills_plugin(tmp_path, code))
    assert report.passed, [c for c in report.checks if not c.passed]
    assert not any(c.name.startswith("skills_scoresheet_schema(") for c in report.checks)
    assert not any(c.name.startswith("calculate_skills_score(") for c in report.checks)


@pytest.mark.parametrize(
    ("types_literal", "message"),
    [
        (
            '[{"key": "driver", "label": "Driver", "run_seconds": 60},'
            ' {"key": "driver", "label": "Again", "run_seconds": 60}]',
            "duplicate",
        ),
        ('[{"key": "Driver", "label": "Driver", "run_seconds": 60}]', "must match"),
        ('[{"key": "driver-1", "label": "Driver", "run_seconds": 60}]', "must match"),
        ('[{"key": 5, "label": "Driver", "run_seconds": 60}]', "must match"),
        ('[{"key": "overall", "label": "Overall", "run_seconds": 60}]', "reserved"),
        ('[{"key": "driver", "label": "  ", "run_seconds": 60}]', "non-empty label"),
        ('[{"key": "driver", "label": 7, "run_seconds": 60}]', "non-empty label"),
        ('[{"key": "driver"}]', "exactly"),
        ('[{"key": "driver", "label": "Driver", "run_seconds": 60, "icon": None}]', "exactly"),
        ('["driver"]', "exactly"),
        ('{"key": "driver", "label": "Driver", "run_seconds": 60}', "must return a list"),
        # run_seconds: required, a positive whole number of seconds.
        ('[{"key": "driver", "label": "Driver"}]', "run_seconds"),
        ('[{"key": "driver", "label": "Driver", "run_seconds": 0}]', "positive whole number"),
        ('[{"key": "driver", "label": "Driver", "run_seconds": -5}]', "positive whole number"),
        ('[{"key": "driver", "label": "Driver", "run_seconds": 60.0}]', "positive whole number"),
        ('[{"key": "driver", "label": "Driver", "run_seconds": True}]', "positive whole number"),
        ('[{"key": "driver", "label": "Driver", "run_seconds": "60"}]', "positive whole number"),
        ('[{"key": "driver", "label": "Driver", "run_seconds": None}]', "positive whole number"),
    ],
)
def test_bad_skills_types_fail(tmp_path, types_literal, message):
    code = _GOOD_SKILLS.replace(_GOOD_TYPES, types_literal)
    report = run_conformance_checks(_write_skills_plugin(tmp_path, code))
    check = _named(report, "skills_types() shape")
    assert not check.passed
    assert message in check.message
    assert not report.passed
```

(`test_an_invalid_schema_for_one_type_fails_only_that_type` and `test_non_int_skills_scoring_fails` below it stay unchanged; they build on `_GOOD_SKILLS`.)

In `server/tests/test_sample_cooperative_plugin.py`, change the expectation in `test_skills_types_are_autonomous_then_driver_scored_as_entered` to:

```python
    assert module.skills_types() == [
        {"key": "autonomous", "label": "Autonomous", "run_seconds": 60},
        {"key": "driver", "label": "Driver", "run_seconds": 60},
    ]
```

In `server/tests/test_skills_settings.py`, change line 8 to

```python
TYPES = [
    {"key": "autonomous", "label": "Autonomous", "run_seconds": 60},
    {"key": "driver", "label": "Driver", "run_seconds": 60},
]
```

and append:

```python
def _plugin_with_types(types):
    from types import SimpleNamespace

    return SimpleNamespace(module=SimpleNamespace(skills_types=lambda: types))


def test_run_seconds_reads_the_plugin_and_gives_none_for_anything_unusable():
    from tournament_server.services import skills

    plugin = _plugin_with_types(
        [
            {"key": "driver", "label": "Driver", "run_seconds": 60},
            {"key": "autonomous", "label": "Autonomous"},
            {"key": "flag", "label": "Flag", "run_seconds": True},
            {"key": "zero", "label": "Zero", "run_seconds": 0},
        ]
    )
    assert skills.run_seconds(plugin, "driver") == 60
    assert skills.run_seconds(plugin, "autonomous") is None
    assert skills.run_seconds(plugin, "flag") is None
    assert skills.run_seconds(plugin, "zero") is None
    assert skills.run_seconds(plugin, "unknown") is None
    assert skills.run_seconds(None, "driver") is None
    assert skills.NO_RUN_SECONDS_DETAIL == "This skills type has no run length."
    assert [t["run_seconds"] for t in skills.plugin_types(plugin)] == [60, None, None, None]


def test_the_session_skills_read_carries_each_types_run_length(client):
    create_event(client)
    session_id = create_session(client)
    types = client.get(f"/api/sessions/{session_id}/skills").json()["types"]
    assert [(t["key"], t["run_seconds"], t["allowed"]) for t in types] == [("autonomous", 60, 3), ("driver", 60, 3)]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/pytest -q tests/test_plugin_conformance.py tests/test_sample_cooperative_plugin.py tests/test_skills_settings.py`
Expected: failures: `test_valid_skills_types_pass_with_a_check_per_type` (the conformance tool refuses the extra `run_seconds` key with "exactly"), the new `run_seconds` parametrized cases (pass today), the sample plugin's type list, `TYPES` comparisons (no `run_seconds` in the API) and `AttributeError: module 'tournament_server.services.skills' has no attribute 'run_seconds'`.

- [ ] **Step 3: Require `run_seconds` in the conformance tool**

In `server/src/tournament_server/plugin_registry/conformance.py`, add near the other constants (after `RESERVED_SKILLS_KEYS`):

```python
_SKILLS_TYPE_KEYS = {"key", "label", "run_seconds"}
```

and replace `_check_skills_types` with:

```python
def _check_skills_types(module: Any) -> CheckResult:
    name = "skills_types() shape"
    types = module.skills_types()
    if not isinstance(types, list):
        return CheckResult(name, False, "must return a list")
    seen: set[str] = set()
    for item in types:
        if not isinstance(item, dict) or set(item) != _SKILLS_TYPE_KEYS:
            return CheckResult(
                name, False, "each type must be a dict with exactly 'key', 'label' and 'run_seconds'"
            )
        key, label, run_seconds = item["key"], item["label"], item["run_seconds"]
        if not isinstance(key, str) or not _SKILLS_KEY_PATTERN.fullmatch(key):
            return CheckResult(name, False, f"type key {key!r} must match ^[a-z0-9_]+$")
        if key in RESERVED_SKILLS_KEYS:
            return CheckResult(name, False, f"type key {key!r} is reserved")
        if key in seen:
            return CheckResult(name, False, f"duplicate type key {key!r}")
        seen.add(key)
        if not isinstance(label, str) or not label.strip():
            return CheckResult(name, False, f"type {key!r} needs a non-empty label")
        # The run's timer length (live scoring design §4.1); a bool is an int
        # to Python but never a length.
        if isinstance(run_seconds, bool) or not isinstance(run_seconds, int) or run_seconds <= 0:
            return CheckResult(
                name, False, f"type {key!r} run_seconds must be a positive whole number of seconds, got {run_seconds!r}"
            )
    return CheckResult(name, True)
```

- [ ] **Step 4: Give every shipped and fixture plugin its run lengths**

`server/plugins/games/sample_cooperative/plugin.py`: replace `skills_types` with

```python
def skills_types() -> list[dict[str, Any]]:
    # run_seconds is each run's timer length on a skills field.
    return [
        {"key": "autonomous", "label": "Autonomous", "run_seconds": 60},
        {"key": "driver", "label": "Driver", "run_seconds": 60},
    ]
```

`server/tests/fixtures/plugins/games/example-game/plugin.py`: replace `skills_types` with

```python
def skills_types() -> list[dict[str, Any]]:
    return [
        {"key": "autonomous", "label": "Autonomous", "run_seconds": 60},
        {"key": "driver", "label": "Driver", "run_seconds": 60},
    ]
```

In each of `cooperative-game`, `captain-pick-game`, `fast-timer-game`, `no-autonomous-game` and `broken-plugin` (`server/tests/fixtures/plugins/games/<name>/plugin.py`), replace

```python
def skills_types() -> list[dict[str, str]]:
    return [{"key": "driver", "label": "Driver"}]
```

with

```python
def skills_types() -> list[dict[str, Any]]:
    return [{"key": "driver", "label": "Driver", "run_seconds": 60}]
```

(`second-game` returns `[]` and stays unchanged. Each of these files already imports `Any`.)

- [ ] **Step 5: Read run lengths in the skills service and API**

In `server/src/tournament_server/services/skills.py`, change `from typing import Iterable` to `from typing import Any, Iterable`, add after `ADMIN_ONLY_DETAIL`:

```python
NO_RUN_SECONDS_DETAIL = "This skills type has no run length."


def _usable_run_seconds(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value
```

and replace `plugin_types` with:

```python
def plugin_types(plugin: LoadedPlugin | None) -> list[dict[str, Any]]:
    """The game's skills types in priority order, each with its run length
    (None when the plugin doesn't give a usable one); [] without a plugin."""
    if plugin is None:
        return []
    return [
        {"key": item["key"], "label": item["label"], "run_seconds": _usable_run_seconds(item.get("run_seconds"))}
        for item in plugin.module.skills_types()
    ]


def run_seconds(plugin: LoadedPlugin | None, skills_type: str) -> int | None:
    """One skills type's run length in seconds, or None when there is no
    plugin, no such type, or no usable length; a caller that needs it
    refuses with 409 NO_RUN_SECONDS_DETAIL rather than guessing."""
    for item in plugin_types(plugin):
        if item["key"] == skills_type:
            return item["run_seconds"]
    return None
```

In `server/src/tournament_server/schemas/skills.py` replace `SkillsTypeRead` with:

```python
class SkillsTypeRead(BaseModel):
    key: str
    label: str
    # The run's timer length; null for a plugin that doesn't declare one.
    run_seconds: int | None = None
```

- [ ] **Step 6: Note the contract in the core spec**

In `docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md` §5.1, replace

```
  *As built: both take the skills type key, and a required
  `skills_types()` lists the types in tie-break priority order.*
```

with

```
  *As built: both take the skills type key, and a required
  `skills_types()` lists the types in tie-break priority order, each as
  `{key, label, run_seconds}` (`run_seconds`, a positive integer, is a
  skills run's timer length on a skills field).*
```

- [ ] **Step 7: Run the tests**

Run: `cd server && .venv/bin/pytest -q tests/test_plugin_conformance.py tests/test_sample_cooperative_plugin.py tests/test_skills_settings.py tests/test_skills_attempts.py tests/test_game_plugin_change.py tests/test_plugin_zip_install.py tests/test_cli.py`
Expected: all pass.

Run: `cd server && .venv/bin/tm test-plugin plugins/games/sample_cooperative`
Expected: every check passes, exit status 0.

- [ ] **Step 8: Run the whole server suite**

Run: `cd server && .venv/bin/pytest -q -p no:cacheprovider`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add server/src/tournament_server/plugin_registry/conformance.py server/plugins/games/sample_cooperative/plugin.py \
  server/tests/fixtures/plugins/games/example-game/plugin.py server/tests/fixtures/plugins/games/cooperative-game/plugin.py \
  server/tests/fixtures/plugins/games/captain-pick-game/plugin.py server/tests/fixtures/plugins/games/fast-timer-game/plugin.py \
  server/tests/fixtures/plugins/games/no-autonomous-game/plugin.py server/tests/fixtures/plugins/games/broken-plugin/plugin.py \
  server/src/tournament_server/services/skills.py server/src/tournament_server/schemas/skills.py \
  docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md \
  server/tests/test_plugin_conformance.py server/tests/test_sample_cooperative_plugin.py server/tests/test_skills_settings.py
git commit -m "Add run_seconds to each skills type in the game plugin contract: the conformance tool requires a positive whole number, the sample game and the test games give 60, and the skills service and types API report it, with None for a plugin that leaves it out.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Role-filtered live broadcasts

**Files:**
- Modify: `server/src/tournament_server/realtime.py` (`ConnectionRegistry`, `register_active_session`, `unregister_active_session`, `_send_to_all`, `broadcast_active_session`; new `send_to_devices_and_admins`)
- Modify: `server/src/tournament_server/routers/websockets.py` (`active_session_channel`, line 57)
- Modify: `server/tests/test_realtime.py` (its eight `register_active_session` calls pass a role)
- Test: `server/tests/test_realtime_roles.py`

**Interfaces:**
- Produces: `ConnectionRegistry.active_roles: dict[WebSocket, str]`.
- Produces: `register_active_session(app, websocket, role: str) -> None` (the active-session socket route passes `caller.role`, which for a device comes from its row); `unregister_active_session` also forgets the role.
- Produces: `broadcast_active_session(app, event, data, roles: tuple[str, ...] | None = None) -> None`; `None` sends to every active-session socket (today's behaviour, so every existing caller is unchanged); a tuple sends only to sockets whose role is in it. `"admin"` is never implied.
- Produces: `send_to_devices_and_admins(app, device_ids: list[int], event, data) -> None`: every admin socket on the active-session channel plus every socket of the listed devices, each once.

Plan note: `register_active_session`'s `role` is required as the skeleton says, so the existing unit tests in `tests/test_realtime.py` (which register fake sockets with two arguments) gain an `"admin"` argument; their assertions are unchanged.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_realtime_roles.py`:

```python
"""Role-filtered broadcasts on the active-session channel and the
devices-plus-admins send (live scoring design §8)."""
from __future__ import annotations

import asyncio
import threading
import time

import pytest
from fastapi.testclient import TestClient

from auth_helpers import login_as
from device_helpers import paired_device
from display_helpers import admin_token, setup_event
from skills_helpers import next_event
from tournament_server import realtime

ROLES = ("admin", "scorer", "referee", "display_device", "attendee")


class _FakeWebSocket:
    def __init__(self) -> None:
        self.received: list[dict] = []
        self.closed = False

    async def send_json(self, message: dict) -> None:
        if self.closed:
            raise RuntimeError("closed")
        self.received.append(message)


class _FakeApp:
    def __init__(self) -> None:
        self.state = type("State", (), {})()


@pytest.fixture()
def app():
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    fake = _FakeApp()
    realtime.init_realtime_state(fake)
    realtime.set_event_loop(fake, loop)
    yield fake
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=5)
    loop.close()


def _wait_for(predicate, timeout=2.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def _events(ws: _FakeWebSocket) -> list[str]:
    return [message["event"] for message in ws.received]


def _register_every_role(app) -> dict[str, _FakeWebSocket]:
    sockets = {role: _FakeWebSocket() for role in ROLES}
    for role, ws in sockets.items():
        realtime.register_active_session(app, ws, role)
    return sockets


def _then_marker(app, sockets) -> None:
    """An unfiltered marker after the event under test: once every socket has
    it, every earlier send has landed too (one loop, in order)."""
    realtime.broadcast_active_session(app, "marker", {})
    assert _wait_for(lambda: all(_events(ws)[-1:] == ["marker"] for ws in sockets.values()))


def test_a_role_filtered_broadcast_reaches_only_the_listed_roles(app):
    sockets = _register_every_role(app)
    realtime.broadcast_active_session(app, "live_score", {"match_id": 1}, roles=("display_device", "admin"))
    _then_marker(app, sockets)
    assert {role: _events(ws) for role, ws in sockets.items()} == {
        "admin": ["live_score", "marker"],
        "scorer": ["marker"],
        "referee": ["marker"],
        "display_device": ["live_score", "marker"],
        "attendee": ["marker"],
    }
    assert sockets["admin"].received[0]["data"] == {"match_id": 1}


def test_admin_is_never_implied(app):
    sockets = _register_every_role(app)
    realtime.broadcast_active_session(app, "score_draft_changed", {}, roles=("scorer", "referee"))
    _then_marker(app, sockets)
    assert _events(sockets["admin"]) == ["marker"]
    assert _events(sockets["scorer"]) == ["score_draft_changed", "marker"]


def test_without_roles_everyone_still_gets_the_broadcast(app):
    sockets = _register_every_role(app)
    realtime.broadcast_active_session(app, "match_submitted", {"match_id": 3})
    assert _wait_for(lambda: all(_events(ws) == ["match_submitted"] for ws in sockets.values()))


def test_unregistering_forgets_the_role(app):
    ws = _FakeWebSocket()
    realtime.register_active_session(app, ws, "scorer")
    assert app.state.realtime.active_roles[ws] == "scorer"
    realtime.unregister_active_session(app, ws)
    assert ws not in app.state.realtime.active_roles
    assert ws not in app.state.realtime.active_session


def test_a_dead_socket_is_dropped_with_its_role(app):
    dead, alive = _FakeWebSocket(), _FakeWebSocket()
    dead.closed = True
    realtime.register_active_session(app, dead, "display_device")
    realtime.register_active_session(app, alive, "display_device")
    realtime.broadcast_active_session(app, "live_score", {}, roles=("display_device",))
    assert _wait_for(lambda: alive.received and dead not in app.state.realtime.active_roles)
    assert dead not in app.state.realtime.active_session


def test_send_to_devices_and_admins_reaches_admins_and_the_listed_devices_once(app):
    sockets = _register_every_role(app)
    target, other = _FakeWebSocket(), _FakeWebSocket()
    for device_id, ws in ((7, target), (8, other)):
        realtime.register_active_session(app, ws, "scorer")
        realtime.register_device_socket(app, device_id, ws)
    realtime.send_to_devices_and_admins(app, [7], "scorer_binding_changed", {"device_id": 7})
    _then_marker(app, {**sockets, "target": target, "other": other})
    assert _events(sockets["admin"]) == ["scorer_binding_changed", "marker"]
    assert _events(target) == ["scorer_binding_changed", "marker"]
    for name in ("scorer", "referee", "display_device", "attendee"):
        assert _events(sockets[name]) == ["marker"]
    assert _events(other) == ["marker"]


def _events_until_marker(socket) -> list[str]:
    names = []
    while not names or names[-1] != "marker":
        names.append(socket.receive_json()["event"])
    return names


def test_real_sockets_are_registered_with_their_callers_role_and_filtered(client):
    setup_event(client)
    display = paired_device(client, role="display_device")
    scorer_token = login_as(TestClient(client.app), "scorer")
    with (
        client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as admin_ws,
        client.websocket_connect(f"/ws/active-session?token={scorer_token}") as scorer_ws,
        client.websocket_connect(f"/ws/active-session?token={display['access_token']}") as display_ws,
    ):
        registry = client.app.state.realtime
        assert _wait_for(lambda: len(registry.active_roles) == 3)
        assert sorted(registry.active_roles.values()) == ["admin", "display_device", "scorer"]
        realtime.broadcast_active_session(client.app, "live_score", {"match_id": 1}, roles=("display_device",))
        realtime.broadcast_active_session(client.app, "marker", {})
        assert next_event(display_ws, "live_score")["data"] == {"match_id": 1}
        assert "live_score" not in _events_until_marker(admin_ws)
        assert "live_score" not in _events_until_marker(scorer_ws)
    assert _wait_for(lambda: not registry.active_roles)


def test_a_binding_change_reaches_the_device_and_admins_over_real_sockets(client):
    setup_event(client)
    bound = paired_device(client, role="scorer", name="Field 1 Tablet")
    other = paired_device(client, role="scorer", name="Field 2 Tablet")
    with (
        client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as admin_ws,
        client.websocket_connect(f"/ws/active-session?token={bound['access_token']}") as bound_ws,
        client.websocket_connect(f"/ws/active-session?token={other['access_token']}") as other_ws,
    ):
        assert _wait_for(lambda: len(client.app.state.realtime.active_roles) == 3)
        realtime.send_to_devices_and_admins(client.app, [bound["id"]], "scorer_binding_changed", {"device_id": bound["id"]})
        realtime.broadcast_active_session(client.app, "marker", {})
        assert next_event(admin_ws, "scorer_binding_changed")["data"] == {"device_id": bound["id"]}
        assert next_event(bound_ws, "scorer_binding_changed")["data"] == {"device_id": bound["id"]}
        assert "scorer_binding_changed" not in _events_until_marker(other_ws)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/pytest -q tests/test_realtime_roles.py`
Expected: failures with `TypeError: register_active_session() takes 2 positional arguments but 3 were given` and `AttributeError: ... 'ConnectionRegistry' object has no attribute 'active_roles'` / `module 'tournament_server.realtime' has no attribute 'send_to_devices_and_admins'`.

- [ ] **Step 3: Record each socket's role and filter by it**

In `server/src/tournament_server/realtime.py`:

- in `ConnectionRegistry.__init__`, after `self.active_session: set[WebSocket] = set()` add:

```python
        # The caller's role for each active-session socket, so a broadcast
        # can go to some roles only (live scoring design §8).
        self.active_roles: dict[WebSocket, str] = {}
```

- replace `register_active_session` and `unregister_active_session` with:

```python
def register_active_session(app: "FastAPI", websocket: WebSocket, role: str) -> None:
    app.state.realtime.active_session.add(websocket)
    app.state.realtime.active_roles[websocket] = role


def unregister_active_session(app: "FastAPI", websocket: WebSocket) -> None:
    app.state.realtime.active_session.discard(websocket)
    app.state.realtime.active_roles.pop(websocket, None)
```

- replace `_send_to_all` and `broadcast_active_session` with:

```python
async def _send_to_all(
    subscribers: set[WebSocket], event: str, data: dict, targets: list[WebSocket] | None = None
) -> None:
    """Sends to `targets` (every subscriber when None) and drops any socket
    that fails from `subscribers`."""
    message = {"event": event, "data": data}
    dead: list[WebSocket] = []
    for ws in list(subscribers) if targets is None else targets:
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        subscribers.discard(ws)


def broadcast_active_session(
    app: "FastAPI", event: str, data: dict, roles: tuple[str, ...] | None = None
) -> None:
    """Sends on the active-session channel: to every socket, or with `roles`
    only to sockets whose caller has one of them. "admin" is never implied;
    list it when admins should get the event."""
    registry = app.state.realtime
    if registry.event_loop is None or not registry.active_session:
        return

    # The registry is mutated on the event-loop thread, so the targets are picked there too.
    async def _send() -> None:
        targets = [
            ws for ws in list(registry.active_session)
            if roles is None or registry.active_roles.get(ws) in roles
        ]
        await _send_to_all(registry.active_session, event, data, targets)
        for ws in [ws for ws in registry.active_roles if ws not in registry.active_session]:
            del registry.active_roles[ws]

    asyncio.run_coroutine_threadsafe(_send(), registry.event_loop)
```

- append after `send_to_device`:

```python
def send_to_devices_and_admins(app: "FastAPI", device_ids: list[int], event: str, data: dict) -> None:
    """Sends to every admin on the active-session channel and to the listed
    devices' sockets, each socket once (scorer_binding_changed)."""
    registry = app.state.realtime
    if registry.event_loop is None:
        return

    async def _send() -> None:
        sockets = {ws for ws in registry.active_session if registry.active_roles.get(ws) == "admin"}
        for device_id in device_ids:
            sockets |= registry.by_device.get(device_id, set())
        if sockets:
            await _send_to_all(sockets, event, data)

    asyncio.run_coroutine_threadsafe(_send(), registry.event_loop)
```

In `server/src/tournament_server/routers/websockets.py` `active_session_channel`, change

```python
    realtime.register_active_session(websocket.app, websocket)
```

to

```python
    realtime.register_active_session(websocket.app, websocket, caller.role)
```

- [ ] **Step 4: Pass a role in the existing realtime unit tests**

Run: `cd server && sed -i 's/realtime.register_active_session(app, \([a-z_0-9]*\))/realtime.register_active_session(app, \1, "admin")/' tests/test_realtime.py && grep -c 'register_active_session(app, [a-z_0-9]*, "admin")' tests/test_realtime.py`
Expected: `8`.

- [ ] **Step 5: Run the tests**

Run: `cd server && .venv/bin/pytest -q tests/test_realtime_roles.py tests/test_realtime.py tests/test_websockets_router.py tests/test_device_sockets.py tests/test_broadcast_wiring.py tests/test_match_control_endpoints.py`
Expected: all pass.

- [ ] **Step 6: Run the whole server suite**

Run: `cd server && .venv/bin/pytest -q -p no:cacheprovider`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/tournament_server/realtime.py server/src/tournament_server/routers/websockets.py \
  server/tests/test_realtime.py server/tests/test_realtime_roles.py
git commit -m "Record each active-session socket's role so a broadcast can go to some roles only, and add a send to admins plus chosen devices; existing broadcasts still reach everyone.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Extract the official score write

**Files:**
- Create: `server/src/tournament_server/services/score_submission.py`
- Modify: `server/src/tournament_server/routers/scores.py` (all of it below `list_scores`: `SCORE_ALREADY_SUBMITTED_DETAIL`, `_validated_flags`, `_overwrites_a_submitted_partner`, `submit_score`)
- Test: `server/tests/test_score_submission_service.py` (new); `server/tests/test_scores.py`, `test_cooperative_scoring.py`, `test_per_team_flags_api.py`, `test_per_team_flags_finals.py`, `test_per_team_flags_ranking.py` stay unchanged and must pass.

**Interfaces:**
- Produces (`services/score_submission.py`):
  - `SCORE_ALREADY_SUBMITTED_DETAIL = "This score has already been submitted; ask an admin to correct it."` (moved here; `routers/scores.py` imports it, so `from tournament_server.routers.scores import SCORE_ALREADY_SUBMITTED_DETAIL` keeps working).
  - `class ScoreRefused(Exception)` with `status_code: int` and `detail: object`.
  - `validated_flags(entries: list[TeamFlags], alliance_team_ids: list[int]) -> list[TeamFlags]` (raises `ScoreRefused(422, "Team {id} is not on this alliance." | "Team {id} is listed more than once.")`); Task 6 reuses it for draft team flags.
  - `write_alliance_score(db, plugin, match, alliance, *, data: dict, teams: list[TeamFlags], sitting: bool, force: bool, submitted_by: str | None, is_admin: bool) -> tuple[ScoreRecord, int, bool]`: checks (not played 409, already submitted 409 for a non-admin, team flags 422, plugin `validate` error 422, violations 422 `{"violations": [...]}` unless `force`, `calculate_score` error 422, non-admin overwrite of a submitted cooperative partner 409), writes the record and the cooperative mirror, commits once, and returns `(record, computed_score, mirrored_to_partners)`.
  - `after_scores_written(app, db, plugin, match, alliance_ids: list[int]) -> None`: broadcasts `score_saved {match_id, alliance_id}` for each listed alliance, marks the match completed when every alliance has a record (clearing a queued override and announcing `field_set_changed`), then advances finals (with `new_match_created` for new games) or recomputes the session and season rankings.
- `submit_score` is a thin wrapper: 404s, plugin lookup, `submitted_by`, `write_alliance_score` (mapping `ScoreRefused` to `HTTPException`), `after_scores_written(request.app, db, plugin, match, [alliance_id])`. Responses, status codes and details are unchanged.

Plan note: today the route commits the record, broadcasts `score_saved`, then commits the mirror. The service writes both in one commit (an atomic write is what the Submit in Task 8 needs) and `score_saved` follows it; no test observes the old interleaving, and every event still goes out in the same order relative to `ranking_updated` and `new_match_created`.

- [ ] **Step 1: Write the failing service tests**

Create `server/tests/test_score_submission_service.py`:

```python
"""services/score_submission: the official score write behind
POST /api/matches/{id}/alliances/{id}/score and the live-scoring Submit."""
from __future__ import annotations

import pytest
from sqlalchemy import select

from display_helpers import add_match, add_teams, admin_token, setup_event
from skills_helpers import next_event
from tournament_server.models.alliance import Alliance
from tournament_server.models.match import Match
from tournament_server.models.ranking import Ranking
from tournament_server.models.score_record import ScoreRecord
from tournament_server.schemas.score_record import TeamFlags
from tournament_server.services import qualification
from tournament_server.services.score_submission import (
    SCORE_ALREADY_SUBMITTED_DETAIL,
    ScoreRefused,
    after_scores_written,
    write_alliance_score,
)

SHEET = {"high_balls": 3, "low_balls": 1, "parked": False, "auto_winner": "tie"}


def _match(client, game: str = "example-game") -> dict:
    session_id = setup_event(client, game=game)
    match = add_match(client, session_id, None, 1, add_teams(client))
    return {**match, "session_id": session_id}


def _write(client, match: dict, index: int, *, game="example-game", data=SHEET, teams=(), force=False, is_admin=True):
    plugin = client.app.state.game_plugins[game]
    with client.app.state.session_factory() as db:
        match_row = db.get(Match, match["id"])
        alliance = db.get(Alliance, match["alliances"][index]["id"])
        record, score, mirrored = write_alliance_score(
            db, plugin, match_row, alliance, data=data, teams=list(teams), sitting=False,
            force=force, submitted_by="Field 1 Tablet", is_admin=is_admin,
        )
        return {"alliance_id": record.alliance_id, "by": record.submitted_by_device,
                "mirrored_record": record.mirrored, "score": score, "mirrored": mirrored}


def _refused(client, match, index, **kwargs) -> ScoreRefused:
    with pytest.raises(ScoreRefused) as refused:
        _write(client, match, index, **kwargs)
    return refused.value


def _records(client) -> list[ScoreRecord]:
    with client.app.state.session_factory() as db:
        return list(db.execute(select(ScoreRecord).order_by(ScoreRecord.alliance_id)).scalars().all())


def test_a_write_saves_the_record_and_leaves_completion_to_after_scores_written(client):
    match = _match(client)
    written = _write(client, match, 0)
    assert written == {"alliance_id": match["alliances"][0]["id"], "by": "Field 1 Tablet",
                       "mirrored_record": False, "score": 10, "mirrored": False}
    _write(client, match, 1)
    with client.app.state.session_factory() as db:
        assert db.get(Match, match["id"]).status == "scheduled"
        assert db.execute(select(Ranking)).first() is None


def test_after_scores_written_completes_the_match_and_ranks_it(client):
    match = _match(client)
    _write(client, match, 0)
    _write(client, match, 1)
    plugin = client.app.state.game_plugins["example-game"]
    with client.app.state.session_factory() as db:
        match_row = db.get(Match, match["id"])
        after_scores_written(client.app, db, plugin, match_row, [a["id"] for a in match["alliances"]])
    with client.app.state.session_factory() as db:
        assert db.get(Match, match["id"]).status == "completed"
        session_rows = db.execute(select(Ranking).where(Ranking.session_id == match["session_id"])).scalars().all()
        assert len(session_rows) == 4


def test_after_scores_written_announces_each_listed_alliance(client):
    match = _match(client)
    _write(client, match, 0)
    _write(client, match, 1)
    plugin = client.app.state.game_plugins["example-game"]
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        with client.app.state.session_factory() as db:
            after_scores_written(client.app, db, plugin, db.get(Match, match["id"]), [a["id"] for a in match["alliances"]])
        announced = [next_event(socket, "score_saved")["data"] for _ in match["alliances"]]
    assert announced == [{"match_id": match["id"], "alliance_id": a["id"]} for a in match["alliances"]]


def test_only_an_admin_overwrites_a_submitted_score(client):
    match = _match(client)
    _write(client, match, 0)
    refused = _refused(client, match, 0, is_admin=False)
    assert (refused.status_code, refused.detail) == (409, SCORE_ALREADY_SUBMITTED_DETAIL)
    corrected = _write(client, match, 0, data={**SHEET, "high_balls": 5})
    assert corrected["score"] == 16


def test_plugin_violations_refuse_the_write_unless_forced(client):
    match = _match(client)
    over = {"high_balls": 25, "low_balls": 0, "auto_winner": "tie"}
    refused = _refused(client, match, 0, data=over)
    assert (refused.status_code, refused.detail) == (422, {"violations": ["high_balls cannot exceed 20"]})
    assert _records(client) == []
    assert _write(client, match, 0, data=over, force=True)["score"] == 75


def test_team_flags_must_name_teams_on_the_alliance(client):
    match = _match(client)
    blue_team = match["alliances"][1]["team_ids"][0]
    refused = _refused(client, match, 0, teams=[TeamFlags(team_id=blue_team, dq=True)])
    assert (refused.status_code, refused.detail) == (422, f"Team {blue_team} is not on this alliance.")


def test_a_not_played_match_is_refused(client):
    match = _match(client)
    with client.app.state.session_factory() as db:
        db.get(Match, match["id"]).status = qualification.NOT_PLAYED
        db.commit()
    refused = _refused(client, match, 0)
    assert (refused.status_code, refused.detail) == (409, qualification.NOT_PLAYED_SCORE_DETAIL)


def test_a_cooperative_write_mirrors_onto_the_partner_in_the_same_commit(cooperative_client):
    client = cooperative_client
    match = _match(client, game="cooperative-game")
    written = _write(client, match, 0, game="cooperative-game", data={"objects_scored": 10})
    assert (written["score"], written["mirrored"]) == (20, True)
    red, blue = _records(client)
    assert (red.mirrored, blue.mirrored) == (False, True)
    assert blue.data_json == red.data_json


def test_a_fully_flagged_cooperative_alliance_scores_zero_and_does_not_mirror(cooperative_client):
    client = cooperative_client
    match = _match(client, game="cooperative-game")
    flags = [TeamFlags(team_id=team_id, no_show=True) for team_id in match["alliances"][0]["team_ids"]]
    written = _write(client, match, 0, game="cooperative-game", data={"objects_scored": 10}, teams=flags)
    assert (written["score"], written["mirrored"]) == (0, False)
    assert [r.alliance_id for r in _records(client)] == [match["alliances"][0]["id"]]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/pytest -q tests/test_score_submission_service.py`
Expected: collection error, `ModuleNotFoundError: No module named 'tournament_server.services.score_submission'`.

- [ ] **Step 3: Write the service**

Create `server/src/tournament_server/services/score_submission.py`:

```python
"""The official score write: validate, compute, store (mirroring a
cooperative score), and everything that follows a saved score. Shared by
POST /api/matches/{id}/alliances/{id}/score and the live-scoring Submit."""
from __future__ import annotations

import json
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.db import utc_now
from tournament_server.deps import get_the_event
from tournament_server.models.alliance import Alliance
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.match import Match
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.score_record_team import ScoreRecordTeam
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.realtime import broadcast_for_session, broadcast_new_finals_matches
from tournament_server.schemas.score_record import TeamFlags
from tournament_server.services import displays, qualification, team_flags
from tournament_server.services.finals import advance_score_chase, advance_single_elimination
from tournament_server.services.ranking import recompute_event_rankings, recompute_rankings

if TYPE_CHECKING:
    from fastapi import FastAPI

SCORE_ALREADY_SUBMITTED_DETAIL = "This score has already been submitted; ask an admin to correct it."


class ScoreRefused(Exception):
    """A score the server won't write; the route turns it into an HTTP error."""

    def __init__(self, status_code: int, detail: object) -> None:
        super().__init__(str(detail))
        self.status_code = status_code
        self.detail = detail


def validated_flags(entries: list[TeamFlags], alliance_team_ids: list[int]) -> list[TeamFlags]:
    """The flagged entries, ordered by team; 422 for a team not on the
    alliance or listed twice."""
    seen: set[int] = set()
    for entry in entries:
        if entry.team_id not in alliance_team_ids:
            raise ScoreRefused(422, f"Team {entry.team_id} is not on this alliance.")
        if entry.team_id in seen:
            raise ScoreRefused(422, f"Team {entry.team_id} is listed more than once.")
        seen.add(entry.team_id)
    return sorted((entry for entry in entries if entry.no_show or entry.dq), key=lambda entry: entry.team_id)


def _overwrites_a_submitted_partner(db: Session, match_id: int, alliance_id: int, data: dict) -> bool:
    """True when another alliance on the match has a submitted (not mirrored)
    record whose data differs from `data`. A partner whose teams are all
    flagged is skipped: its data never counts toward a score."""
    partner_records = db.execute(
        select(ScoreRecord)
        .join(Alliance, Alliance.id == ScoreRecord.alliance_id)
        .where(Alliance.match_id == match_id, Alliance.id != alliance_id)
    ).scalars().all()
    return any(
        not record.mirrored
        and not team_flags.alliance_out(
            record.teams, team_flags.alliance_team_ids(db, record.alliance_id), finals=False
        )
        and json.loads(record.data_json) != data
        for record in partner_records
    )


def write_alliance_score(
    db: Session,
    plugin: LoadedPlugin,
    match: Match,
    alliance: Alliance,
    *,
    data: dict,
    teams: list[TeamFlags],
    sitting: bool,
    force: bool,
    submitted_by: str | None,
    is_admin: bool,
) -> tuple[ScoreRecord, int, bool]:
    """Validates and stores one alliance's official score, mirroring the
    data onto the partner alliances of a cooperative match, in one commit.
    Returns (record, computed score, whether it mirrored). Raises
    ScoreRefused with the same status and detail the score route has
    always answered."""
    if match.status == qualification.NOT_PLAYED:
        raise ScoreRefused(409, qualification.NOT_PLAYED_SCORE_DETAIL)
    existing = db.execute(
        select(ScoreRecord).where(ScoreRecord.alliance_id == alliance.id)
    ).scalars().first()
    # Once submitted, only an admin may correct it (skills spec 3.6). A copy
    # the cooperative mirror wrote was never submitted for this alliance, so
    # a scorer may still submit it once.
    if existing is not None and not existing.mirrored and not is_admin:
        raise ScoreRefused(409, SCORE_ALREADY_SUBMITTED_DETAIL)

    alliance_team_ids = team_flags.alliance_team_ids(db, alliance.id)
    flags = validated_flags(teams, alliance_team_ids)
    finals = match.finals_bracket_id is not None

    try:
        violations = plugin.module.validate(data)
    except Exception as exc:
        raise ScoreRefused(422, f"Plugin could not validate this scoresheet: {exc}") from exc
    if violations and not force:
        raise ScoreRefused(422, {"violations": violations})

    try:
        computed_score = (
            0
            if team_flags.alliance_out(flags, alliance_team_ids, finals=finals)
            else plugin.module.calculate_score(data)
        )
    except Exception as exc:
        raise ScoreRefused(422, f"Plugin could not score this scoresheet: {exc}") from exc

    game_model = plugin.module.match_format()["game_model"]
    mirrors = game_model == "cooperative_score" and not team_flags.alliance_out(
        flags, alliance_team_ids, finals=False
    )
    if mirrors and not is_admin and _overwrites_a_submitted_partner(db, match.id, alliance.id, data):
        # Mirroring would change the partner's submitted score, which only an
        # admin may do; refuse before writing anything.
        raise ScoreRefused(409, SCORE_ALREADY_SUBMITTED_DETAIL)

    now = utc_now()
    if existing is None:
        record = ScoreRecord(
            alliance_id=alliance.id,
            plugin_name=plugin.name,
            plugin_version=plugin.version,
            data_json=json.dumps(data),
            sitting=sitting,
            mirrored=False,
            submitted_by_device=submitted_by,
            submitted_at=now,
            saved_at=now,
        )
        record.teams = [ScoreRecordTeam(team_id=f.team_id, no_show=f.no_show, dq=f.dq) for f in flags]
        db.add(record)
    else:
        existing.data_json = json.dumps(data)
        # Clear and flush before adding, so re-flagging the same team never
        # meets its old row in the unique constraint.
        existing.teams.clear()
        db.flush()
        existing.teams.extend(
            ScoreRecordTeam(team_id=f.team_id, no_show=f.no_show, dq=f.dq) for f in flags
        )
        existing.sitting = sitting
        existing.mirrored = False
        existing.submitted_by_device = submitted_by
        existing.submitted_at = now
        existing.saved_at = now
        record = existing
    db.flush()

    if mirrors:
        for other_alliance in db.execute(
            select(Alliance).where(Alliance.match_id == match.id, Alliance.id != alliance.id)
        ).scalars().all():
            other_record = db.execute(
                select(ScoreRecord).where(ScoreRecord.alliance_id == other_alliance.id)
            ).scalars().first()
            if other_record is None:
                db.add(
                    ScoreRecord(
                        alliance_id=other_alliance.id,
                        plugin_name=plugin.name,
                        plugin_version=plugin.version,
                        data_json=record.data_json,
                        sitting=False,
                        mirrored=True,
                        submitted_by_device=submitted_by,
                        submitted_at=now,
                        saved_at=now,
                    )
                )
            else:
                other_record.data_json = record.data_json
                other_record.plugin_name = plugin.name
                other_record.plugin_version = plugin.version

    db.commit()
    db.refresh(record)
    return record, computed_score, mirrors


def after_scores_written(
    app: "FastAPI", db: Session, plugin: LoadedPlugin, match: Match, alliance_ids: list[int]
) -> None:
    """Everything that follows saved scores: score_saved per listed alliance,
    completing the match (and clearing a queued override), then finals
    advancing or the session and season rankings."""
    for alliance_id in alliance_ids:
        broadcast_for_session(
            app, db, match.session_id, "score_saved", {"match_id": match.id, "alliance_id": alliance_id}
        )

    all_alliance_ids = db.execute(select(Alliance.id).where(Alliance.match_id == match.id)).scalars().all()
    scored_alliance_ids = set(
        db.execute(
            select(ScoreRecord.alliance_id).where(ScoreRecord.alliance_id.in_(all_alliance_ids))
        ).scalars().all()
    )
    if len(scored_alliance_ids) == len(all_alliance_ids):
        match.status = "completed"
        cleared = displays.clear_queued_matches(db, [match.id])
        db.commit()
        for field_set_id in cleared:
            displays.notify_field_set_changed(app, field_set_id)

    if match.finals_bracket_id is not None:
        bracket = db.get(FinalsBracket, match.finals_bracket_id)
        if bracket is not None and match.status == "completed":
            existing_ids = {
                m.id for m in db.execute(
                    select(Match).where(Match.finals_bracket_id == bracket.id)
                ).scalars().all()
            }
            if bracket.format == "score_chase":
                advance_score_chase(db, bracket, plugin)
            elif bracket.format == "single_elimination":
                advance_single_elimination(db, bracket, plugin, match)
            broadcast_new_finals_matches(app, db, bracket.id, existing_ids)
        return

    recompute_rankings(app, db, plugin, match.session_id, match.division_id)
    event = get_the_event(db)
    if event is not None:
        recompute_event_rankings(app, db, plugin, event.id, match.division_id)
```

- [ ] **Step 4: Make the route a thin wrapper**

Replace `server/src/tournament_server/routers/scores.py` from its imports through the end of the file with (the `list_scores` endpoint is unchanged):

```python
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server import audit
from tournament_server.auth import require_any_role, require_scorer_or_referee
from tournament_server.deps import (
    get_db,
    get_game_plugin_for_event,
    get_optional_game_plugin,
    get_session_id,
    get_the_event,
)
from tournament_server.device_auth import require_paired_scoring_device
from tournament_server.models.alliance import Alliance
from tournament_server.models.match import Match
from tournament_server.models.score_record import ScoreRecord
from tournament_server.schemas.score_record import AllianceScoreRead, ScoreRecordRead, ScoreSubmit, TeamFlags
from tournament_server.services import team_flags
from tournament_server.services.score_submission import (
    SCORE_ALREADY_SUBMITTED_DETAIL,  # noqa: F401  (re-exported for callers of this module)
    ScoreRefused,
    after_scores_written,
    write_alliance_score,
)

router = APIRouter(prefix="/api/matches", tags=["scores"])

# Saved scores by session, for the display screens (display groups design).
list_router = APIRouter(prefix="/api/scores", tags=["scores"])

@list_router.get("", response_model=list[AllianceScoreRead])
def list_scores(
    request: Request,
    session_id: int = Depends(get_session_id),
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> list[AllianceScoreRead]:
    event = get_the_event(db)
    plugin = get_optional_game_plugin(request, event) if event is not None else None
    if plugin is None:
        return []
    rows = db.execute(
        select(ScoreRecord, Alliance, Match)
        .join(Alliance, ScoreRecord.alliance_id == Alliance.id)
        .join(Match, Alliance.match_id == Match.id)
        .where(Match.session_id == session_id)
        .order_by(Match.id, Alliance.id)
    ).all()
    result = []
    for record, alliance, match in rows:
        team_ids = team_flags.alliance_team_ids(db, alliance.id)
        result.append(
            AllianceScoreRead(
                match_id=match.id,
                alliance_id=alliance.id,
                score=team_flags.effective_score(plugin, record, team_ids, finals=match.finals_bracket_id is not None),
                data=json.loads(record.data_json),
                teams=[TeamFlags(team_id=t.team_id, no_show=t.no_show, dq=t.dq) for t in record.teams],
                saved_at=record.saved_at,
            )
        )
    return result


def _to_score_record_read(record: ScoreRecord, computed_score: int) -> ScoreRecordRead:
    return ScoreRecordRead(
        id=record.id,
        alliance_id=record.alliance_id,
        plugin_name=record.plugin_name,
        plugin_version=record.plugin_version,
        data=json.loads(record.data_json),
        teams=[TeamFlags(team_id=flag.team_id, no_show=flag.no_show, dq=flag.dq) for flag in record.teams],
        sitting=record.sitting,
        submitted_by_device=record.submitted_by_device,
        submitted_at=record.submitted_at,
        saved_at=record.saved_at,
        computed_score=computed_score,
    )


@router.post("/{match_id}/alliances/{alliance_id}/score", response_model=ScoreRecordRead)
def submit_score(
    match_id: int,
    alliance_id: int,
    payload: ScoreSubmit,
    request: Request,
    db: Session = Depends(get_db),
    role: str = Depends(require_scorer_or_referee),
    device_friendly_name: str | None = Depends(require_paired_scoring_device),
) -> ScoreRecordRead:
    """The direct score write, and the admin's correction path once a match
    is submitted (services/score_submission holds every rule)."""
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    alliance = db.get(Alliance, alliance_id)
    if alliance is None or alliance.match_id != match_id:
        raise HTTPException(status_code=404, detail="Alliance not found on this match")
    plugin = get_game_plugin_for_event(request, db)
    submitted_by = (
        device_friendly_name if device_friendly_name is not None else audit.current_actor.get()
    )
    try:
        record, computed_score, _mirrored = write_alliance_score(
            db,
            plugin,
            match,
            alliance,
            data=payload.data,
            teams=payload.teams,
            sitting=payload.sitting,
            force=payload.force,
            submitted_by=submitted_by,
            is_admin=role == "admin",
        )
    except ScoreRefused as refused:
        raise HTTPException(status_code=refused.status_code, detail=refused.detail) from refused
    after_scores_written(request.app, db, plugin, match, [alliance_id])
    return _to_score_record_read(record, computed_score)
```

- [ ] **Step 5: Run the tests**

Run: `cd server && .venv/bin/pytest -q tests/test_score_submission_service.py tests/test_scores.py tests/test_cooperative_scoring.py tests/test_per_team_flags_api.py tests/test_per_team_flags_finals.py tests/test_per_team_flags_ranking.py`
Expected: all pass, with no change to the existing test files (`git diff --stat server/tests` lists only the new file).

Run: `cd server && .venv/bin/pytest -q tests/test_broadcast_wiring.py tests/test_finals.py tests/test_finals_service.py tests/test_rankings.py tests/test_season_rankings.py tests/test_match_control_displays.py tests/test_qualification_finalize.py tests/test_qualification_guards.py tests/test_sample_cooperative_plugin.py tests/test_display_reads.py`
Expected: all pass.

- [ ] **Step 6: Run the whole server suite**

Run: `cd server && .venv/bin/pytest -q -p no:cacheprovider`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/tournament_server/services/score_submission.py server/src/tournament_server/routers/scores.py \
  server/tests/test_score_submission_service.py
git commit -m "Move the official score write out of the score route into a service: one call validates, computes and stores an alliance's score with its cooperative mirror in a single commit, and a second does what follows a saved score; the route now wraps the two and answers exactly as before.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Teamwork drafts: read and merge

**Files:**
- Create: `server/src/tournament_server/schemas/draft.py`
- Create: `server/src/tournament_server/services/drafts.py`
- Create: `server/src/tournament_server/routers/drafts.py`
- Modify: `server/src/tournament_server/app.py` (register the router)
- Create: `server/tests/live_helpers.py` (shared by Tasks 6, 7 and 8)
- Test: `server/tests/test_drafts.py`

**Interfaces:**
- Consumes: Task 1 `ScoreDraft` (`models/scoring_draft.py`); Task 4 `realtime.register_active_session(app, websocket, role)` and `realtime.broadcast_active_session(app, event, data, roles=...)`; Task 5 `services/score_submission.ScoreRefused` (built here as `ScoreRefused(status_code=..., detail=...)`; `.status_code`, `.detail`); existing `routers/scores.SCORE_ALREADY_SUBMITTED_DETAIL`, `services/qualification.NOT_PLAYED` / `NOT_PLAYED_SCORE_DETAIL`, `services/team_flags.alliance_out` / `alliance_team_ids`, `services/skills_rules._field_problem`, `auth.require_scorer_or_referee`, `device_auth.require_paired_scoring_device`.
- Produces (schemas/draft.py): `ItemMeta(device_name: str, at: datetime)`; `DraftPatch(changes: dict[str, Any] = {}, teams: list[TeamFlags] | None = None)` (`extra=forbid`); `AllianceDraftRead(alliance_id, data: dict, teams: list[TeamFlags], item_meta: dict[str, ItemMeta], version: int, score: int)`; `MatchDraftRead(match_id, submitted: bool, alliances: list[AllianceDraftRead])`.
- Produces (services/drafts.py): `draft_alliance_id(db, plugin, match, alliance_id) -> int`; `item_violations(schema, changes, *, scope, team_ids) -> list[str]`; `apply_patch(db, plugin, match, alliance, patch, device_name) -> ScoreDraft` (commits; raises `ScoreRefused`); `read_match_draft(db, plugin, match) -> MatchDraftRead`; `draft_score(plugin, draft, team_ids, finals) -> int`; `is_submitted(db, match) -> bool`; `delete_match_drafts(db, match_ids) -> None` (no commit). Helpers other tasks may use: `DRAFT_WRITE_LOCK` (process-wide `threading.RLock`), `DRAFT_EVENT_ROLES = ("admin", "scorer", "referee")`, `FLAG_KEY` (regex for `team:<id>:no_show|dq`), `match_alliance_ids(db, match_id) -> list[int]` (ascending), `alliances_showing(db, plugin, match, alliance_id) -> list[int]`, `alliance_draft(db, plugin, match, alliance_id) -> AllianceDraftRead`, `broadcast_draft_changed(app, db, plugin, match, alliance_ids) -> None`.
- Produces routes: `GET /api/matches/{id}/draft` → `MatchDraftRead`; `PATCH /api/matches/{id}/alliances/{aid}/draft` → `AllianceDraftRead`. Each PATCH broadcasts `score_draft_changed` (`{"match_id", ...AllianceDraftRead}`) to `("admin", "scorer", "referee")` for every alliance whose view changed (both alliances for a cooperative game) and calls `live_scores.on_draft_changed(app, db, match)` (a no-op stub here; Task 7 fills it in).
- Produces (tests): `server/tests/live_helpers.py` with `DRAFT`, `scoring_setup`, `cooperative_setup`, `score_chase_setup`, `patch_draft`, `draft_rows`, `Recorder`, `listening`, `settle`.

Plan note: scoresheet data is stored flat by item name for every `scope` today (`ScoresheetForm` and `POST …/score` both do), so a teamwork alliance sheet accepts every schema item. `item_violations`' `scope` is the sheet being edited: `"alliance"` (a match alliance: every item) or `"team"` (a skills run, Task 9: team-scoped items only). `team_ids` checks team flag keys (`team:<id>:no_show` / `team:<id>:dq`): `apply_patch` turns each `teams` entry into those two keys and validates them with the data items in one pass, so a team not on the alliance comes back as a 422 `{"violations": ["Team 7 is not on this alliance."]}` (the same message `_validated_flags` uses) rather than a bare string detail. Flag-shaped keys sent in `changes` are refused.

Plan note: SQLite ignores `SELECT … FOR UPDATE`, and the session issues no `BEGIN` before a plain `SELECT`, so two tablets patching different items at the same moment could each write back a copy missing the other's item. One process serves one event file, so `apply_patch` (and Task 8's Submit and whole-match reset) hold the process-wide `DRAFT_WRITE_LOCK` around read, merge and commit. `test_concurrent_patches_never_lose_a_change` pins it.

Plan note: an alliance with no draft reads as `score: 0` (not `calculate_score({})`, which for some plugins is not 0). For a cooperative game every alliance's read shows the shared draft's data, version and item times, with only its own teams' flags and its own effective score.

- [ ] **Step 1: Write the shared test helpers**

Create `server/tests/live_helpers.py`:

```python
"""Shared setup for the live scoring tests: scoring-ready matches, draft
patches, and recorders registered on the active-session channel under a
role, so a test can see which roles an event reached and which it didn't."""
from __future__ import annotations

import contextlib
import time
import uuid

from sqlalchemy import select

from display_helpers import add_field_set, add_match, add_teams, setup_event
from ranking_helpers import finalize_qualification
from tournament_server import realtime
from tournament_server.models.scoring_draft import ScoreDraft

# A complete example-game alliance sheet: 3 * high_balls + low_balls, and
# "tie" adds no autonomous bonus, so this one scores 9.
DRAFT = {"high_balls": 3, "low_balls": 0, "parked": False, "auto_winner": "tie"}


def _by_station(match: dict) -> tuple[int, int]:
    alliances = {alliance["station"]: alliance["id"] for alliance in match["alliances"]}
    return alliances["red"], alliances["blue"]


def scoring_setup(client, *, round_type: str = "qualification") -> dict:
    """An example-game event with an active session, one field set of two
    fields, four teams and one match on the first field."""
    session_id = setup_event(client)
    field_set = add_field_set(client, session_id)
    teams = add_teams(client)
    match = add_match(client, session_id, field_set["field_ids"][0], 1, teams, round_type=round_type)
    red, blue = _by_station(match)
    return {
        "session_id": session_id,
        "field_set": field_set,
        "teams": teams,
        "match": match,
        "match_id": match["id"],
        "red": red,
        "blue": blue,
    }


def cooperative_setup(client) -> dict:
    """A cooperative-game event with one qualification match: one team per alliance."""
    session_id = setup_event(client, game="cooperative-game")
    t1, t2 = add_teams(client, count=2)
    created = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [{"station": "red", "team_ids": [t1]}, {"station": "blue", "team_ids": [t2]}],
        },
    )
    assert created.status_code == 201, created.text
    match = created.json()
    red, blue = _by_station(match)
    return {"session_id": session_id, "teams": [t1, t2], "match": match, "match_id": match["id"], "red": red, "blue": blue}


def score_chase_setup(client) -> dict:
    """A cooperative-game score chase with two runs, started in the active
    session: returns the bracket id, the first run's match id and its one
    alliance (a run has a single alliance holding both teams)."""
    client.post("/api/event", json={"name": "Finals Event"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    assert client.post("/api/event/active-session", json={"session_id": session_id}).status_code == 200
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})
    team_ids = [
        client.post("/api/teams", json={"number": str(n + 1), "name": f"Team {n + 1}"}).json()["id"]
        for n in range(4)
    ]
    for n, team_id in enumerate(team_ids):
        match = client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": 100 + n,
                "field_id": None,
                "alliances": [{"station": "red", "team_ids": [team_id]}, {"station": "blue", "team_ids": [team_id]}],
            },
        ).json()
        red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        client.post(
            f"/api/matches/{match['id']}/alliances/{red}/score",
            json={"data": {"objects_scored": (len(team_ids) - n) * 10}},
        )
    finalize_qualification(client, session_id)
    bracket = client.post("/api/finals/start", json={"session_id": session_id, "bracket_size": 2}).json()
    match_id = bracket["runs"][0]["match_id"]
    alliance_ids = [a["id"] for a in client.get(f"/api/matches/{match_id}").json()["alliances"]]
    return {"session_id": session_id, "bracket_id": bracket["id"], "match_id": match_id, "alliance_ids": alliance_ids}


def patch_draft(client, setup: dict, side, changes: dict | None = None, teams: list | None = None, headers=None):
    """PATCHes one alliance's draft. `side` is "red"/"blue" (a key of `setup`) or an alliance id."""
    alliance_id = setup[side] if isinstance(side, str) else side
    body: dict = {"changes": changes or {}}
    if teams is not None:
        body["teams"] = teams
    return client.patch(
        f"/api/matches/{setup['match_id']}/alliances/{alliance_id}/draft", json=body, headers=headers
    )


def draft_rows(client) -> list[ScoreDraft]:
    with client.app.state.session_factory() as db:
        return list(db.execute(select(ScoreDraft).order_by(ScoreDraft.id)).scalars().all())


class Recorder:
    """A stand-in socket on the active-session channel that keeps every message it is sent."""

    def __init__(self) -> None:
        self.received: list[dict] = []

    async def send_json(self, message: dict) -> None:
        self.received.append(message)

    def events(self, name: str) -> list[dict]:
        return [message["data"] for message in self.received if message["event"] == name]


@contextlib.contextmanager
def listening(client, *roles: str):
    """Registers one Recorder per role on the active-session channel; yields {role: Recorder}."""
    recorders = {role: Recorder() for role in roles}
    for role, recorder in recorders.items():
        realtime.register_active_session(client.app, recorder, role)
    try:
        yield recorders
    finally:
        for recorder in recorders.values():
            realtime.unregister_active_session(client.app, recorder)


def settle(client, recorders: dict, timeout: float = 3.0) -> None:
    """Waits until every broadcast sent so far has reached the recorders:
    broadcasts run in order on the server's loop, so once a marker sent to
    everyone arrives, everything before it has too."""
    marker = uuid.uuid4().hex
    realtime.broadcast_active_session(client.app, "test_marker", {"id": marker})
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if all(
            any(data["id"] == marker for data in recorder.events("test_marker"))
            for recorder in recorders.values()
        ):
            return
        time.sleep(0.01)
    raise AssertionError("broadcasts never reached the recorders")
```

- [ ] **Step 2: Write the failing tests**

Create `server/tests/test_drafts.py`:

```python
from __future__ import annotations

import datetime as dt
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from device_helpers import paired_device
from display_helpers import add_match, score_match
from live_helpers import DRAFT, cooperative_setup, draft_rows, listening, patch_draft, scoring_setup, settle
from tournament_server.db import utc_now
from tournament_server.models.match import Match
from tournament_server.routers.scores import SCORE_ALREADY_SUBMITTED_DETAIL
from tournament_server.services.qualification import NOT_PLAYED, NOT_PLAYED_SCORE_DETAIL


def _empty(alliance_id: int) -> dict:
    return {"alliance_id": alliance_id, "data": {}, "teams": [], "item_meta": {}, "version": 0, "score": 0}


def test_a_match_without_drafts_reads_empty(client):
    setup = scoring_setup(client)
    body = client.get(f"/api/matches/{setup['match_id']}/draft")
    assert body.status_code == 200
    assert body.json() == {
        "match_id": setup["match_id"],
        "submitted": False,
        "alliances": [_empty(setup["red"]), _empty(setup["blue"])],
    }


def test_patches_merge_item_by_item_and_record_who_and_when(client):
    setup = scoring_setup(client)
    tablet = paired_device(client, role="scorer", name="Red Tablet")
    before = utc_now()
    first = patch_draft(client, setup, "red", {"high_balls": 3, "auto_winner": "tie"}, headers=tablet["headers"])
    assert first.status_code == 200, first.text
    assert first.json()["version"] == 1
    second = patch_draft(client, setup, "red", {"low_balls": 2})
    after = utc_now()
    assert second.status_code == 200, second.text
    body = second.json()
    assert body["alliance_id"] == setup["red"]
    assert body["data"] == {"high_balls": 3, "auto_winner": "tie", "low_balls": 2}
    assert body["version"] == 2
    assert body["score"] == 3 * 3 + 2
    assert {key: meta["device_name"] for key, meta in body["item_meta"].items()} == {
        "high_balls": "Red Tablet",
        "auto_winner": "Red Tablet",
        "low_balls": "Admin",
    }
    for meta in body["item_meta"].values():
        assert before <= dt.datetime.fromisoformat(meta["at"]) <= after
    read = client.get(f"/api/matches/{setup['match_id']}/draft").json()
    assert read["alliances"][0] == body
    assert read["alliances"][1] == _empty(setup["blue"])


def test_the_last_write_wins_on_one_item(client):
    setup = scoring_setup(client)
    first = paired_device(client, role="scorer", name="Tablet A")
    second = paired_device(client, role="referee", name="Tablet B")
    patch_draft(client, setup, "red", {"high_balls": 3, "low_balls": 1}, headers=first["headers"])
    body = patch_draft(client, setup, "red", {"high_balls": 5}, headers=second["headers"]).json()
    assert body["data"] == {"high_balls": 5, "low_balls": 1}
    assert body["item_meta"]["high_balls"]["device_name"] == "Tablet B"
    assert body["item_meta"]["low_balls"]["device_name"] == "Tablet A"
    assert body["version"] == 2


@pytest.mark.parametrize(
    "changes, message",
    [
        ({"goals": 1}, "goals: Unknown item."),
        ({"high_balls": "3"}, "high_balls: Must be a whole number."),
        ({"high_balls": True}, "high_balls: Must be a whole number."),
        ({"high_balls": 21}, "high_balls: Must be at most 20."),
        ({"low_balls": -1}, "low_balls: Must be at least 0."),
        ({"parked": 1}, "parked: Must be true or false."),
        ({"auto_winner": "green"}, "auto_winner: Must be one of: red, blue, tie."),
        ({"team:5:dq": True}, "team:5:dq: Send team flags in teams."),
    ],
)
def test_each_item_is_checked_on_its_own(client, changes, message):
    setup = scoring_setup(client)
    refused = patch_draft(client, setup, "red", changes)
    assert refused.status_code == 422
    assert refused.json()["detail"] == {"violations": [message]}
    assert draft_rows(client) == []


def test_one_bad_item_refuses_the_whole_patch(client):
    setup = scoring_setup(client)
    patch_draft(client, setup, "red", {"high_balls": 2})
    refused = patch_draft(client, setup, "red", {"high_balls": 4, "low_balls": 99})
    assert refused.status_code == 422
    assert refused.json()["detail"] == {"violations": ["low_balls: Must be at most 20."]}
    red = client.get(f"/api/matches/{setup['match_id']}/draft").json()["alliances"][0]
    assert (red["data"], red["version"]) == ({"high_balls": 2}, 1)


def test_unknown_fields_in_the_body_are_refused(client):
    setup = scoring_setup(client)
    refused = client.patch(
        f"/api/matches/{setup['match_id']}/alliances/{setup['red']}/draft",
        json={"changes": {"high_balls": 1}, "force": True},
    )
    assert refused.status_code == 422


def test_team_flags_stay_on_their_alliance(client):
    setup = scoring_setup(client)
    t1, t2, t3, _ = setup["teams"]
    flagged = patch_draft(
        client, setup, "red", {"high_balls": 4, "auto_winner": "tie"}, teams=[{"team_id": t1, "no_show": True}]
    )
    assert flagged.status_code == 200, flagged.text
    body = flagged.json()
    assert body["teams"] == [{"team_id": t1, "no_show": True, "dq": False}]
    assert {f"team:{t1}:no_show", f"team:{t1}:dq"} <= set(body["item_meta"])
    # One of two teams out: in qualification the alliance still scores.
    assert body["score"] == 12

    both = patch_draft(client, setup, "red", teams=[{"team_id": t2, "dq": True}]).json()
    assert both["teams"] == [
        {"team_id": t1, "no_show": True, "dq": False},
        {"team_id": t2, "no_show": False, "dq": True},
    ]
    assert both["score"] == 0

    cleared = patch_draft(client, setup, "red", teams=[{"team_id": t1}]).json()
    assert cleared["teams"] == [{"team_id": t2, "no_show": False, "dq": True}]
    assert cleared["version"] == 3

    other = patch_draft(client, setup, "red", teams=[{"team_id": t3, "dq": True}])
    assert other.status_code == 422
    assert other.json()["detail"] == {"violations": [f"Team {t3} is not on this alliance."]}
    twice = patch_draft(client, setup, "red", teams=[{"team_id": t1}, {"team_id": t1, "dq": True}])
    assert twice.status_code == 422
    assert twice.json()["detail"] == {"violations": [f"Team {t1} is listed more than once."]}


def test_a_submitted_match_refuses_patches(client):
    setup = scoring_setup(client)
    red_only = client.post(
        f"/api/matches/{setup['match_id']}/alliances/{setup['red']}/score", json={"data": DRAFT}
    )
    assert red_only.status_code == 200
    # Only one alliance has an official score: the match is still being scored.
    assert patch_draft(client, setup, "blue", {"high_balls": 1}).status_code == 200
    score_match(client, setup["match"])
    refused = patch_draft(client, setup, "red", {"high_balls": 1})
    assert refused.status_code == 409
    assert refused.json()["detail"] == SCORE_ALREADY_SUBMITTED_DETAIL


def test_a_not_played_match_refuses_patches(client):
    setup = scoring_setup(client)
    with client.app.state.session_factory() as db:
        db.get(Match, setup["match_id"]).status = NOT_PLAYED
        db.commit()
    refused = patch_draft(client, setup, "red", {"high_balls": 1})
    assert refused.status_code == 409
    assert refused.json()["detail"] == NOT_PLAYED_SCORE_DETAIL


def test_unknown_matches_and_foreign_alliances_are_404(client):
    setup = scoring_setup(client)
    other = add_match(client, setup["session_id"], None, 2, setup["teams"])
    assert patch_draft(client, setup, other["alliances"][0]["id"], {"high_balls": 1}).status_code == 404
    assert client.get("/api/matches/999/draft").status_code == 404
    missing = client.patch("/api/matches/999/alliances/1/draft", json={"changes": {}})
    assert missing.status_code == 404


def test_only_scoring_roles_read_and_patch(client):
    setup = scoring_setup(client)
    url = f"/api/matches/{setup['match_id']}/draft"
    for role in ("judge", "display_device"):
        device = paired_device(client, role=role)
        assert client.get(url, headers=device["headers"]).status_code == 403
        assert patch_draft(client, setup, "red", {"high_balls": 1}, headers=device["headers"]).status_code == 403
    token = login_as(TestClient(client.app), "scorer")
    unpaired = patch_draft(client, setup, "red", {"high_balls": 1}, headers=bearer(token))
    assert unpaired.status_code == 403
    assert unpaired.json()["detail"] == "Only a paired device can submit scores."
    referee = paired_device(client, role="referee")
    assert client.get(url, headers=referee["headers"]).status_code == 200
    assert patch_draft(client, setup, "red", {"high_balls": 1}, headers=referee["headers"]).status_code == 200


def test_a_cooperative_game_shares_one_draft(cooperative_client):
    client = cooperative_client
    setup = cooperative_setup(client)
    _, t2 = setup["teams"]
    shared = min(setup["red"], setup["blue"])
    body = patch_draft(client, setup, "blue", {"objects_scored": 7}).json()
    assert (body["alliance_id"], body["data"], body["score"]) == (setup["blue"], {"objects_scored": 7}, 14)
    assert [row.alliance_id for row in draft_rows(client)] == [shared]

    with listening(client, "admin") as heard:
        # The shared draft holds every team's flags, so either alliance may set them.
        flagged = patch_draft(client, setup, "red", teams=[{"team_id": t2, "no_show": True}])
        assert flagged.status_code == 200, flagged.text
        settle(client, heard)
    assert sorted(event["alliance_id"] for event in heard["admin"].events("score_draft_changed")) == sorted(
        [setup["red"], setup["blue"]]
    )

    red, blue = client.get(f"/api/matches/{setup['match_id']}/draft").json()["alliances"]
    assert red["data"] == blue["data"] == {"objects_scored": 7}
    assert red["version"] == blue["version"] == 2
    assert red["teams"] == []
    assert blue["teams"] == [{"team_id": t2, "no_show": True, "dq": False}]
    assert (red["score"], blue["score"]) == (14, 0)
    assert len(draft_rows(client)) == 1


def test_patches_reach_the_scoring_roles_only(client):
    setup = scoring_setup(client)
    with listening(client, "admin", "scorer", "referee", "display_device", "judge") as heard:
        assert patch_draft(client, setup, "red", {"high_balls": 2, "auto_winner": "tie"}).status_code == 200
        settle(client, heard)
    for role in ("admin", "scorer", "referee"):
        [event] = heard[role].events("score_draft_changed")
        assert (event["match_id"], event["alliance_id"], event["version"], event["score"]) == (
            setup["match_id"],
            setup["red"],
            1,
            6,
        )
        assert event["data"] == {"high_balls": 2, "auto_winner": "tie"}
        assert event["teams"] == []
        assert event["item_meta"]["high_balls"]["device_name"] == "Admin"
    for role in ("display_device", "judge"):
        assert heard[role].events("score_draft_changed") == []


def test_concurrent_patches_never_lose_a_change(client):
    setup = scoring_setup(client)
    changes = [{name: n} for n in range(10) for name in ("high_balls", "low_balls")]
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda change: patch_draft(client, setup, "red", change), changes))
    assert [response.status_code for response in responses] == [200] * len(changes)
    assert sorted(response.json()["version"] for response in responses) == list(range(1, len(changes) + 1))
    red = client.get(f"/api/matches/{setup['match_id']}/draft").json()["alliances"][0]
    assert red["version"] == len(changes)
    assert set(red["data"]) == {"high_balls", "low_balls"}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd server && .venv/bin/pytest -q tests/test_drafts.py`
Expected: FAIL (the draft routes don't exist: `GET …/draft` and `PATCH …/draft` return 404 / 405).

- [ ] **Step 4: Add the schemas**

Create `server/src/tournament_server/schemas/draft.py`:

```python
from __future__ import annotations

import datetime as dt
from typing import Any

from pydantic import BaseModel, ConfigDict

from tournament_server.schemas.score_record import TeamFlags


class ItemMeta(BaseModel):
    device_name: str
    at: dt.datetime


class DraftPatch(BaseModel):
    """Only the changed items. `teams` replaces the flags of each listed team."""

    model_config = ConfigDict(extra="forbid")

    changes: dict[str, Any] = {}
    teams: list[TeamFlags] | None = None


class AllianceDraftRead(BaseModel):
    alliance_id: int
    data: dict[str, Any]
    teams: list[TeamFlags]
    item_meta: dict[str, ItemMeta]
    version: int
    score: int


class MatchDraftRead(BaseModel):
    match_id: int
    submitted: bool
    alliances: list[AllianceDraftRead]
```

- [ ] **Step 5: Add the drafts service**

Create `server/src/tournament_server/services/drafts.py`:

```python
"""Teamwork draft scores (live scoring spec §4.2 and §5).

A draft is one alliance's scoresheet while its match is scored. Items merge
one at a time, the last write wins per item, and each item remembers which
device wrote it and when. Drafts never count toward rankings, completion,
finals or any check; Submit turns them into official score records and
deletes them. A cooperative game keeps one shared draft per match, stored on
the match's lowest alliance id.
"""
from __future__ import annotations

import json
import re
import threading
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from tournament_server import realtime
from tournament_server.db import utc_now
from tournament_server.models.alliance import Alliance
from tournament_server.models.match import Match
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.scoring_draft import ScoreDraft
from tournament_server.routers.scores import SCORE_ALREADY_SUBMITTED_DETAIL
from tournament_server.schemas.draft import AllianceDraftRead, DraftPatch, ItemMeta, MatchDraftRead
from tournament_server.schemas.score_record import TeamFlags
from tournament_server.services import qualification, team_flags
from tournament_server.services.score_submission import ScoreRefused
from tournament_server.services.skills_rules import _field_problem

if TYPE_CHECKING:
    from fastapi import FastAPI

    from tournament_server.plugin_registry.loader import LoadedPlugin

# One process serves one event file, so a process-wide lock makes each
# read-merge-write of a draft (and each Submit or whole-match reset) atomic.
# SQLite ignores SELECT ... FOR UPDATE, and without this two tablets patching
# different items at once could each write back a copy missing the other's.
DRAFT_WRITE_LOCK = threading.RLock()

DRAFT_EVENT_ROLES = ("admin", "scorer", "referee")

FLAG_KEY = re.compile(r"^team:(\d+):(no_show|dq)$")


def flag_key(team_id: int, flag: str) -> str:
    return f"team:{team_id}:{flag}"


def _cooperative(plugin: "LoadedPlugin") -> bool:
    return plugin.module.match_format()["game_model"] == "cooperative_score"


def _finals(match: Match) -> bool:
    return match.finals_bracket_id is not None


def match_alliance_ids(db: Session, match_id: int) -> list[int]:
    return list(
        db.execute(select(Alliance.id).where(Alliance.match_id == match_id).order_by(Alliance.id)).scalars()
    )


def draft_alliance_id(db: Session, plugin: "LoadedPlugin", match: Match, alliance_id: int) -> int:
    """The alliance whose row holds this alliance's draft: itself, or the
    match's lowest alliance id for a cooperative game."""
    if _cooperative(plugin):
        return match_alliance_ids(db, match.id)[0]
    return alliance_id


def alliances_showing(db: Session, plugin: "LoadedPlugin", match: Match, alliance_id: int) -> list[int]:
    """The alliances whose view changes when this alliance's draft changes."""
    return match_alliance_ids(db, match.id) if _cooperative(plugin) else [alliance_id]


def _match_team_ids(db: Session, match: Match) -> list[int]:
    team_ids: list[int] = []
    for alliance_id in match_alliance_ids(db, match.id):
        team_ids.extend(team_flags.alliance_team_ids(db, alliance_id))
    return team_ids


def item_violations(
    schema: list[dict[str, Any]], changes: dict[str, Any], *, scope: str, team_ids: list[int]
) -> list[str]:
    """Each changed item checked on its own: the name exists on this sheet,
    the type matches, and the value is within min/max or among the options.

    `scope` is the sheet being edited: "alliance" (a match alliance, whose
    flat data holds every schema item, team-scoped ones included, as
    `POST …/score` stores it) or "team" (a skills run, which takes
    team-scoped items only). Team flag keys (`team:<id>:no_show`,
    `team:<id>:dq`) must name a team in `team_ids` and carry a boolean."""
    fields = {
        field["name"]: field for field in schema if scope == "alliance" or field.get("scope") == scope
    }
    problems: list[str] = []
    for name, value in changes.items():
        flag = FLAG_KEY.match(name)
        if flag is not None:
            if int(flag.group(1)) not in team_ids:
                problems.append(f"Team {flag.group(1)} is not on this alliance.")
            elif not isinstance(value, bool):
                problems.append(f"{name}: Must be true or false.")
            continue
        field = fields.get(name)
        if field is None:
            problems.append(f"{name}: Unknown item.")
            continue
        problem = _field_problem(field, value)
        if problem is not None:
            problems.append(f"{name}: {problem}")
    return list(dict.fromkeys(problems))


def _draft_row(db: Session, alliance_id: int) -> ScoreDraft | None:
    return (
        db.execute(
            select(ScoreDraft)
            .where(ScoreDraft.alliance_id == alliance_id)
            .execution_options(populate_existing=True)
        )
        .scalars()
        .first()
    )


def _stored_flags(draft: ScoreDraft) -> list[TeamFlags]:
    return [TeamFlags(**entry) for entry in json.loads(draft.teams_json)]


def is_submitted(db: Session, match: Match) -> bool:
    """True once every alliance of the match has an official score record."""
    alliance_ids = match_alliance_ids(db, match.id)
    if not alliance_ids:
        return False
    scored = set(
        db.execute(select(ScoreRecord.alliance_id).where(ScoreRecord.alliance_id.in_(alliance_ids))).scalars()
    )
    return scored == set(alliance_ids)


def apply_patch(
    db: Session, plugin: "LoadedPlugin", match: Match, alliance: Alliance, patch: DraftPatch, device_name: str
) -> ScoreDraft:
    """Validates every changed item and flag, then merges them into the
    alliance's draft (last write wins per item), records who and when, bumps
    the version and commits. Raises ScoreRefused (409 submitted / not played,
    422 {"violations": [...]})."""
    with DRAFT_WRITE_LOCK:
        db.refresh(match)
        if match.status == qualification.NOT_PLAYED:
            raise ScoreRefused(status_code=409, detail=qualification.NOT_PLAYED_SCORE_DETAIL)
        if is_submitted(db, match):
            raise ScoreRefused(status_code=409, detail=SCORE_ALREADY_SUBMITTED_DETAIL)

        cooperative = _cooperative(plugin)
        team_ids = _match_team_ids(db, match) if cooperative else team_flags.alliance_team_ids(db, alliance.id)

        problems = [f"{key}: Send team flags in teams." for key in patch.changes if FLAG_KEY.match(key)]
        items = {key: value for key, value in patch.changes.items() if not FLAG_KEY.match(key)}
        flag_items: dict[str, bool] = {}
        seen: set[int] = set()
        for entry in patch.teams or []:
            if entry.team_id in seen:
                problems.append(f"Team {entry.team_id} is listed more than once.")
                continue
            seen.add(entry.team_id)
            flag_items[flag_key(entry.team_id, "no_show")] = entry.no_show
            flag_items[flag_key(entry.team_id, "dq")] = entry.dq
        problems += item_violations(
            plugin.module.scoresheet_schema(), {**items, **flag_items}, scope="alliance", team_ids=team_ids
        )
        if problems:
            raise ScoreRefused(status_code=422, detail={"violations": list(dict.fromkeys(problems))})

        now = utc_now()
        owner_id = draft_alliance_id(db, plugin, match, alliance.id)
        draft = _draft_row(db, owner_id)
        if draft is None:
            draft = ScoreDraft(
                match_id=match.id,
                alliance_id=owner_id,
                data_json="{}",
                teams_json="[]",
                item_meta_json="{}",
                version=0,
                updated_at=now,
            )
            db.add(draft)

        data = json.loads(draft.data_json)
        data.update(items)
        meta = json.loads(draft.item_meta_json)
        stamp = {"device_name": device_name, "at": now.isoformat()}
        for key in (*items, *flag_items):
            meta[key] = stamp
        if patch.teams is not None:
            flags = {entry["team_id"]: entry for entry in json.loads(draft.teams_json)}
            for entry in patch.teams:
                if entry.no_show or entry.dq:
                    flags[entry.team_id] = entry.model_dump()
                else:
                    flags.pop(entry.team_id, None)
            draft.teams_json = json.dumps([flags[team_id] for team_id in sorted(flags)])

        draft.data_json = json.dumps(data)
        draft.item_meta_json = json.dumps(meta)
        draft.version = (draft.version or 0) + 1
        draft.updated_at = now
        db.commit()
        return draft


def draft_score(plugin: "LoadedPlugin", draft: ScoreDraft | None, team_ids, finals: bool) -> int:
    """The draft's score so far, team flags applied as for an official score.
    0 when there is no draft or the plugin can't score it yet (§5.2)."""
    if draft is None:
        return 0
    if team_flags.alliance_out(_stored_flags(draft), team_ids, finals=finals):
        return 0
    try:
        return int(plugin.module.calculate_score(json.loads(draft.data_json)))
    except Exception:
        return 0


def _shown(key: str, team_ids: list[int]) -> bool:
    flag = FLAG_KEY.match(key)
    return flag is None or int(flag.group(1)) in team_ids


def empty_alliance_draft(alliance_id: int) -> AllianceDraftRead:
    return AllianceDraftRead(alliance_id=alliance_id, data={}, teams=[], item_meta={}, version=0, score=0)


def alliance_draft(db: Session, plugin: "LoadedPlugin", match: Match, alliance_id: int) -> AllianceDraftRead:
    """One alliance's view of its draft (the shared one for a cooperative
    game, with only this alliance's team flags and its own score)."""
    draft = _draft_row(db, draft_alliance_id(db, plugin, match, alliance_id))
    if draft is None:
        return empty_alliance_draft(alliance_id)
    team_ids = team_flags.alliance_team_ids(db, alliance_id)
    return AllianceDraftRead(
        alliance_id=alliance_id,
        data=json.loads(draft.data_json),
        teams=[flag for flag in _stored_flags(draft) if flag.team_id in team_ids],
        item_meta={
            key: ItemMeta(**value)
            for key, value in json.loads(draft.item_meta_json).items()
            if _shown(key, team_ids)
        },
        version=draft.version,
        score=draft_score(plugin, draft, team_ids, _finals(match)),
    )


def _official(db: Session, plugin: "LoadedPlugin", match: Match, alliance_id: int) -> AllianceDraftRead:
    record = db.execute(select(ScoreRecord).where(ScoreRecord.alliance_id == alliance_id)).scalars().first()
    if record is None:
        return empty_alliance_draft(alliance_id)
    team_ids = team_flags.alliance_team_ids(db, alliance_id)
    return AllianceDraftRead(
        alliance_id=alliance_id,
        data=json.loads(record.data_json),
        teams=[TeamFlags(team_id=flag.team_id, no_show=flag.no_show, dq=flag.dq) for flag in record.teams],
        item_meta={},
        version=0,
        score=team_flags.effective_score(plugin, record, team_ids, finals=_finals(match)),
    )


def read_match_draft(db: Session, plugin: "LoadedPlugin", match: Match) -> MatchDraftRead:
    """Every alliance's draft; once the match is submitted, its official scores instead."""
    submitted = is_submitted(db, match)
    read = _official if submitted else alliance_draft
    return MatchDraftRead(
        match_id=match.id,
        submitted=submitted,
        alliances=[read(db, plugin, match, alliance_id) for alliance_id in match_alliance_ids(db, match.id)],
    )


def broadcast_draft_changed(
    app: "FastAPI", db: Session, plugin: "LoadedPlugin", match: Match, alliance_ids: list[int]
) -> None:
    for alliance_id in alliance_ids:
        read = alliance_draft(db, plugin, match, alliance_id)
        realtime.broadcast_active_session(
            app,
            "score_draft_changed",
            {"match_id": match.id, **read.model_dump(mode="json")},
            roles=DRAFT_EVENT_ROLES,
        )


def delete_match_drafts(db: Session, match_ids: list[int]) -> None:
    """Deletes these matches' drafts. Doesn't commit."""
    if match_ids:
        db.execute(delete(ScoreDraft).where(ScoreDraft.match_id.in_(list(match_ids))))
```

- [ ] **Step 6: The live-scores hook is already there**

Task 2 already created `services/live_scores.on_draft_changed(app, db, match)` as a no-op with its final signature; the route below calls it as is. Do not add a second definition (Task 7 fills it in).

- [ ] **Step 7: Add the routes**

Create `server/src/tournament_server/routers/drafts.py`:

```python
"""Teamwork draft scores (live scoring spec §5.1)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from tournament_server.auth import require_scorer_or_referee
from tournament_server.deps import get_db, get_game_plugin_for_event
from tournament_server.device_auth import require_paired_scoring_device
from tournament_server.models.alliance import Alliance
from tournament_server.models.match import Match
from tournament_server.schemas.draft import AllianceDraftRead, DraftPatch, MatchDraftRead
from tournament_server.services import drafts, live_scores
from tournament_server.services.score_submission import ScoreRefused

router = APIRouter(prefix="/api/matches", tags=["drafts"])

# item_meta's device name for an admin, who scores without a paired device.
ADMIN_DEVICE_NAME = "Admin"


def _match_or_404(db: Session, match_id: int) -> Match:
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    return match


def _alliance_or_404(db: Session, match: Match, alliance_id: int) -> Alliance:
    alliance = db.get(Alliance, alliance_id)
    if alliance is None or alliance.match_id != match.id:
        raise HTTPException(status_code=404, detail="Alliance not found on this match")
    return alliance


@router.get("/{match_id}/draft", response_model=MatchDraftRead)
def read_draft(
    match_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_scorer_or_referee),
) -> MatchDraftRead:
    match = _match_or_404(db, match_id)
    plugin = get_game_plugin_for_event(request, db)
    return drafts.read_match_draft(db, plugin, match)


@router.patch("/{match_id}/alliances/{alliance_id}/draft", response_model=AllianceDraftRead)
def patch_draft(
    match_id: int,
    alliance_id: int,
    payload: DraftPatch,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_scorer_or_referee),
    device_name: str | None = Depends(require_paired_scoring_device),
) -> AllianceDraftRead:
    match = _match_or_404(db, match_id)
    alliance = _alliance_or_404(db, match, alliance_id)
    plugin = get_game_plugin_for_event(request, db)
    try:
        draft = drafts.apply_patch(db, plugin, match, alliance, payload, device_name or ADMIN_DEVICE_NAME)
    except ScoreRefused as refused:
        raise HTTPException(status_code=refused.status_code, detail=refused.detail) from refused
    drafts.broadcast_draft_changed(
        request.app, db, plugin, match, drafts.alliances_showing(db, plugin, match, draft.alliance_id)
    )
    live_scores.on_draft_changed(request.app, db, match)
    return drafts.alliance_draft(db, plugin, match, alliance.id)
```

In `app.py`, add `drafts,` to the `from tournament_server.routers import (...)` list (alphabetically, after `divisions,`) and register the router after the scores routers:

```python
    app.include_router(scores.router)
    app.include_router(scores.list_router)
    app.include_router(drafts.router)
```

- [ ] **Step 8: Run the tests**

Run: `cd server && .venv/bin/pytest -q tests/test_drafts.py`
Expected: all pass.

- [ ] **Step 9: Run the wider suites**

Run: `cd server && .venv/bin/pytest -q tests/test_scores.py tests/test_cooperative_scoring.py tests/test_per_team_flags_api.py tests/test_score_submission_service.py tests/test_realtime_roles.py tests/test_alembic_drift.py`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add server/src/tournament_server/schemas/draft.py server/src/tournament_server/services/drafts.py \
  server/src/tournament_server/routers/drafts.py \
  server/src/tournament_server/app.py server/tests/live_helpers.py server/tests/test_drafts.py
git commit -m "Add teamwork draft scores: read a match's drafts and patch one alliance's items, each checked on its own against the plugin scoresheet and merged with the last write winning per item, recording the device and time per item, bumping the version, keeping one shared draft for cooperative games, and broadcasting score_draft_changed to admins, scorers and referees.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Live scores for teamwork matches

**Files:**
- Modify: `server/src/tournament_server/services/live_scores.py` (replace the stubs with the real service)
- Modify: `server/src/tournament_server/routers/displays.py` (`GET /api/displays/live-scores`)
- Modify: `server/src/tournament_server/routers/matches.py` (call `on_match_phase_changed` after every `match_phase_changed` and `match_reset`, the auto-advance task included)
- Modify: `server/src/tournament_server/app.py` (`_recover_in_flight_matches` also advances phases on start-up)
- Test: `server/tests/test_live_scores.py`

**Interfaces:**
- Consumes: Task 1 `TournamentSession.live_scores_qualification` / `live_scores_finals`; Task 2 `PATCH /api/sessions/{id}` with the switches, calling `live_scores.on_switches_changed(app, db, session_id)`; Task 4 `broadcast_active_session(..., roles=...)`; Task 6 `drafts.read_match_draft`, `live_helpers`; existing `displays.field_ids_for_set`.
- Produces: `LIVE_PHASES = frozenset({"countdown_autonomous", "autonomous", "awaiting_driver", "countdown_driver", "driver"})`; `LIVE_SCORE_ROLES = ("display_device", "admin")`; `match_live_allowed(db, match) -> bool` (a live phase, the match not completed or not played, and the session's switch for its round on: `live_scores_finals` for finals matches, else `live_scores_qualification`); `match_payload(db, plugin, match) -> {"match_id", "alliances": [{"alliance_id", "score"}]}`; `on_draft_changed(app, db, match)` (totals when allowed, nothing otherwise); `on_match_phase_changed(app, db, match)` (totals when allowed, else `{"match_id", "cleared": True}`); `on_switches_changed(app, db, session_id)` (re-sends every running match of the session); `live_snapshot(db, plugin, field_set_id: int | None) -> {"matches": [...], "skills": []}`; route `GET /api/displays/live-scores?field_set_id=` (any role, `display_device` included).
- Every `live_score` goes out with `roles=("display_device", "admin")`, and only for matches in the active session (displays only show the active session).

Plan note: `pause` and `resume` don't change whether a match is live (paused counts as running), so they are not call sites. `on_match_phase_changed` sends `cleared` whenever the match is not allowed, even if it never sent totals; a display that holds nothing ignores it. `live_snapshot` takes `field_set_id: int | None` (None: every field) so a pit display without a field set can call it. Its `skills` list stays `[]` until Task 10 adds `skills_live_payloads`.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_live_scores.py`:

```python
from __future__ import annotations

import asyncio

from device_helpers import paired_device
from display_helpers import add_field_set, add_match, add_teams
from live_helpers import listening, patch_draft, score_chase_setup, scoring_setup, settle
from tournament_server.db import utc_now
from tournament_server.match_control import cancel_auto_advance
from tournament_server.models.match import Match
from tournament_server.routers.matches import _auto_advance_match
from tournament_server.services import live_scores

LIVE_URL = "/api/displays/live-scores"


def _totals(setup: dict, red: int, blue: int) -> dict:
    return {
        "match_id": setup["match_id"],
        "alliances": [{"alliance_id": setup["red"], "score": red}, {"alliance_id": setup["blue"], "score": blue}],
    }


def _cleared(match_id: int) -> dict:
    return {"match_id": match_id, "cleared": True}


def _switch(client, session_id: int, **switches) -> None:
    assert client.patch(f"/api/sessions/{session_id}", json=switches).status_code == 200


def test_the_live_phases_are_every_running_phase():
    assert live_scores.LIVE_PHASES == {
        "countdown_autonomous",
        "autonomous",
        "awaiting_driver",
        "countdown_driver",
        "driver",
    }


def test_totals_reach_displays_and_admins_only_while_the_clock_runs(client):
    setup = scoring_setup(client)
    match_url = f"/api/matches/{setup['match_id']}"
    with listening(client, "display_device", "admin", "scorer") as heard:
        patch_draft(client, setup, "red", {"high_balls": 2, "auto_winner": "tie"})
        settle(client, heard)
        assert heard["display_device"].events("live_score") == []

        assert client.post(f"{match_url}/start").status_code == 200
        settle(client, heard)
        assert heard["display_device"].events("live_score") == [_totals(setup, 6, 0)]

        patch_draft(client, setup, "blue", {"high_balls": 1, "auto_winner": "tie"})
        settle(client, heard)
        assert heard["display_device"].events("live_score")[-1] == _totals(setup, 6, 3)

        assert client.post(f"{match_url}/pause").status_code == 200
        patch_draft(client, setup, "blue", {"low_balls": 1})
        settle(client, heard)
        # Paused still counts as running.
        assert heard["display_device"].events("live_score")[-1] == _totals(setup, 6, 4)
        assert client.post(f"{match_url}/resume").status_code == 200

        assert client.post(f"{match_url}/end").status_code == 200
        settle(client, heard)
        assert heard["display_device"].events("live_score")[-1] == _cleared(setup["match_id"])
        sent = len(heard["display_device"].events("live_score"))

        patch_draft(client, setup, "red", {"low_balls": 1})
        settle(client, heard)
        assert len(heard["display_device"].events("live_score")) == sent
    assert heard["admin"].events("live_score") == heard["display_device"].events("live_score")
    assert heard["scorer"].events("live_score") == []


def test_the_qualification_switch_hides_and_restores_totals(client):
    setup = scoring_setup(client)
    assert client.post(f"/api/matches/{setup['match_id']}/start").status_code == 200
    patch_draft(client, setup, "red", {"high_balls": 2, "auto_winner": "tie"})
    with listening(client, "display_device") as heard:
        _switch(client, setup["session_id"], live_scores_qualification=False)
        settle(client, heard)
        # The countdown may advance meanwhile; each phase change re-sends "cleared", never totals.
        events = heard["display_device"].events("live_score")
        assert events and all(event == _cleared(setup["match_id"]) for event in events)

        patch_draft(client, setup, "red", {"high_balls": 4})
        settle(client, heard)
        events = heard["display_device"].events("live_score")
        assert all(event == _cleared(setup["match_id"]) for event in events)

        _switch(client, setup["session_id"], live_scores_qualification=True)
        settle(client, heard)
        assert heard["display_device"].events("live_score")[-1] == _totals(setup, 12, 0)


def test_practice_follows_the_qualification_switch(client):
    setup = scoring_setup(client, round_type="practice")
    _switch(client, setup["session_id"], live_scores_qualification=False)
    patch_draft(client, setup, "red", {"high_balls": 1, "auto_winner": "tie"})
    with listening(client, "display_device") as heard:
        assert client.post(f"/api/matches/{setup['match_id']}/start").status_code == 200
        _switch(client, setup["session_id"], live_scores_finals=True)
        settle(client, heard)
        assert heard["display_device"].events("live_score")
        assert all(event == _cleared(setup["match_id"]) for event in heard["display_device"].events("live_score"))

        _switch(client, setup["session_id"], live_scores_qualification=True)
        settle(client, heard)
        assert heard["display_device"].events("live_score")[-1] == _totals(setup, 3, 0)


def test_finals_send_no_totals_until_their_switch_is_on(cooperative_client):
    client = cooperative_client
    chase = score_chase_setup(client)
    [alliance_id] = chase["alliance_ids"]
    with listening(client, "display_device") as heard:
        assert client.post(f"/api/matches/{chase['match_id']}/start").status_code == 200
        patch_draft(client, chase, alliance_id, {"objects_scored": 5})
        settle(client, heard)
        events = heard["display_device"].events("live_score")
        assert events and all(event == _cleared(chase["match_id"]) for event in events)

        _switch(client, chase["session_id"], live_scores_finals=True)
        settle(client, heard)
        assert heard["display_device"].events("live_score")[-1] == {
            "match_id": chase["match_id"],
            "alliances": [{"alliance_id": alliance_id, "score": 10}],
        }


def test_the_clock_running_out_clears_the_totals(client):
    setup = scoring_setup(client)
    assert client.post(f"/api/matches/{setup['match_id']}/start").status_code == 200
    patch_draft(client, setup, "red", {"high_balls": 2, "auto_winner": "tie"})
    with client.app.state.session_factory() as db:
        row = db.get(Match, setup["match_id"])
        row.phase = "driver"
        row.phase_deadline = utc_now()
        db.commit()
    cancel_auto_advance(client.app, setup["match_id"])
    with listening(client, "display_device") as heard:
        asyncio.run_coroutine_threadsafe(
            _auto_advance_match(client.app, setup["match_id"], override_sleep_seconds=0),
            client.app.state.realtime.event_loop,
        ).result(timeout=5)
        settle(client, heard)
        assert heard["display_device"].events("live_score") == [_cleared(setup["match_id"])]
    assert client.get(f"/api/matches/{setup['match_id']}").json()["phase"] == "ended"


def test_a_reset_clears_the_totals_and_a_restart_brings_them_back(client):
    setup = scoring_setup(client)
    match_url = f"/api/matches/{setup['match_id']}"
    assert client.post(f"{match_url}/start").status_code == 200
    patch_draft(client, setup, "red", {"high_balls": 2, "auto_winner": "tie"})
    with listening(client, "display_device") as heard:
        assert client.post(f"{match_url}/reset", json={"scope": "section"}).status_code == 200
        settle(client, heard)
        assert heard["display_device"].events("live_score") == [_cleared(setup["match_id"])]
        assert client.post(f"{match_url}/start").status_code == 200
        settle(client, heard)
        assert heard["display_device"].events("live_score")[-1] == _totals(setup, 6, 0)


def test_the_snapshot_agrees_with_the_events(client):
    setup = scoring_setup(client)
    main_set = setup["field_set"]["id"]
    side = add_field_set(client, setup["session_id"], "Side Fields", ("Side 1",))
    other = add_match(client, setup["session_id"], side["field_ids"][0], 2, add_teams(client, start=201))
    display = paired_device(client, role="display_device")

    def snapshot(**params):
        response = client.get(LIVE_URL, params=params, headers=display["headers"])
        assert response.status_code == 200, response.text
        return response.json()

    assert snapshot(field_set_id=main_set) == {"matches": [], "skills": []}
    with listening(client, "display_device") as heard:
        assert client.post(f"/api/matches/{setup['match_id']}/start").status_code == 200
        patch_draft(client, setup, "red", {"high_balls": 2, "auto_winner": "tie"})
        settle(client, heard)
        latest = heard["display_device"].events("live_score")[-1]
    assert latest == _totals(setup, 6, 0)
    assert snapshot(field_set_id=main_set) == {"matches": [latest], "skills": []}
    assert snapshot(field_set_id=side["id"]) == {"matches": [], "skills": []}
    assert snapshot() == {"matches": [latest], "skills": []}

    assert client.post(f"/api/matches/{other['id']}/start").status_code == 200
    other_alliances = [{"alliance_id": a["id"], "score": 0} for a in other["alliances"]]
    assert snapshot(field_set_id=side["id"])["matches"] == [{"match_id": other["id"], "alliances": other_alliances}]

    _switch(client, setup["session_id"], live_scores_qualification=False)
    assert snapshot() == {"matches": [], "skills": []}
    _switch(client, setup["session_id"], live_scores_qualification=True)
    assert client.post(f"/api/matches/{setup['match_id']}/end").status_code == 200
    assert snapshot(field_set_id=main_set) == {"matches": [], "skills": []}


def test_matches_outside_the_active_session_send_nothing(client):
    setup = scoring_setup(client)
    later = client.post("/api/sessions", json={"label": "Sunday"}).json()["id"]
    assert client.post("/api/event/active-session", json={"session_id": later}).status_code == 200
    with listening(client, "display_device") as heard:
        assert client.post(f"/api/matches/{setup['match_id']}/start").status_code == 200
        patch_draft(client, setup, "red", {"high_balls": 2})
        settle(client, heard)
    assert heard["display_device"].events("live_score") == []
    assert client.get(LIVE_URL).json() == {"matches": [], "skills": []}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && .venv/bin/pytest -q tests/test_live_scores.py`
Expected: FAIL (`AttributeError: module 'tournament_server.services.live_scores' has no attribute 'LIVE_PHASES'`, no `live_score` events, and `GET /api/displays/live-scores` returning 404/422).

- [ ] **Step 3: Write the live-scores service**

Replace the whole of `server/src/tournament_server/services/live_scores.py` (until now it holds only Task 2's four no-op stubs) with the following. It keeps Task 2's `on_skills_changed` no-op at the end, which Task 10 fills in and Task 9's `notify` calls:

```python
"""What displays may see of a match's draft scores while it is played
(live scoring spec §7). The server decides; displays draw what they get.

A teamwork match's totals go out while its clock runs (paused included)
and the session's switch for its round is on: `live_scores_finals` for a
finals match, `live_scores_qualification` otherwise (practice included).
When it stops being allowed (time up, reset, submitted, switch off) the
displays get `{"match_id", "cleared": True}`.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server import realtime
from tournament_server.deps import get_the_event
from tournament_server.models.match import Match
from tournament_server.models.session import TournamentSession
from tournament_server.services import displays, drafts, qualification

if TYPE_CHECKING:
    from fastapi import FastAPI

    from tournament_server.plugin_registry.loader import LoadedPlugin

LIVE_PHASES = frozenset({"countdown_autonomous", "autonomous", "awaiting_driver", "countdown_driver", "driver"})
LIVE_SCORE_ROLES = ("display_device", "admin")


def _plugin(app: "FastAPI", db: Session) -> "LoadedPlugin | None":
    event = get_the_event(db)
    if event is None or event.game_plugin_name is None:
        return None
    return app.state.game_plugins.get(event.game_plugin_name)


def _in_active_session(db: Session, session_id: int) -> bool:
    event = get_the_event(db)
    return event is not None and event.active_session_id == session_id


def match_live_allowed(db: Session, match: Match) -> bool:
    if match.phase not in LIVE_PHASES or match.status in ("completed", qualification.NOT_PLAYED):
        return False
    session_obj = db.get(TournamentSession, match.session_id)
    if session_obj is None:
        return False
    if match.finals_bracket_id is not None:
        return bool(session_obj.live_scores_finals)
    return bool(session_obj.live_scores_qualification)


def match_payload(db: Session, plugin: "LoadedPlugin", match: Match) -> dict:
    read = drafts.read_match_draft(db, plugin, match)
    return {
        "match_id": match.id,
        "alliances": [{"alliance_id": alliance.alliance_id, "score": alliance.score} for alliance in read.alliances],
    }


def _send(app: "FastAPI", data: dict) -> None:
    realtime.broadcast_active_session(app, "live_score", data, roles=LIVE_SCORE_ROLES)


def on_draft_changed(app: "FastAPI", db: Session, match: Match) -> None:
    """A draft changed: displays get the new totals if they may see them."""
    if not _in_active_session(db, match.session_id) or not match_live_allowed(db, match):
        return
    plugin = _plugin(app, db)
    if plugin is not None:
        _send(app, match_payload(db, plugin, match))


def on_match_phase_changed(app: "FastAPI", db: Session, match: Match) -> None:
    """The match's clock moved, it was reset or submitted, or a switch
    flipped: send its totals when allowed, else tell displays to drop them."""
    if not _in_active_session(db, match.session_id):
        return
    plugin = _plugin(app, db)
    if plugin is not None and match_live_allowed(db, match):
        _send(app, match_payload(db, plugin, match))
    else:
        _send(app, {"match_id": match.id, "cleared": True})


def on_switches_changed(app: "FastAPI", db: Session, session_id: int) -> None:
    """A session's live-score switches changed: re-evaluate every running match."""
    if not _in_active_session(db, session_id):
        return
    for match in db.execute(
        select(Match).where(Match.session_id == session_id, Match.phase.in_(LIVE_PHASES)).order_by(Match.id)
    ).scalars().all():
        on_match_phase_changed(app, db, match)


def live_snapshot(db: Session, plugin: "LoadedPlugin | None", field_set_id: int | None) -> dict:
    """What a display starting up or reconnecting may show now, the same as
    the `live_score` events would have told it."""
    event = get_the_event(db)
    if plugin is None or event is None or event.active_session_id is None:
        return {"matches": [], "skills": []}
    query = select(Match).where(
        Match.session_id == event.active_session_id, Match.phase.in_(LIVE_PHASES)
    ).order_by(Match.id)
    if field_set_id is not None:
        query = query.where(Match.field_id.in_(displays.field_ids_for_set(db, field_set_id)))
    matches = [
        match_payload(db, plugin, match)
        for match in db.execute(query).scalars().all()
        if match_live_allowed(db, match)
    ]
    # Skills fields join in Task 10 (skills_live_payloads).
    return {"matches": matches, "skills": []}


def on_skills_changed(app: "FastAPI", db: Session, field_set_id: int) -> None:
    """A skills run or timer on this set changed: push its live scores.
    Task 10 fills this in; until then nothing is sent."""
    return None
```

- [ ] **Step 4: Add the display read**

In `routers/displays.py`, change the auth import to `from tournament_server.auth import Caller, get_caller, require_admin, require_any_role`, the deps import to `from tournament_server.deps import get_db, get_optional_game_plugin, get_session_id, get_the_event`, the services import to `from tournament_server.services import displays, live_scores`, and add after `read_me`:

```python
@router.get("/api/displays/live-scores")
def read_live_scores(
    request: Request,
    field_set_id: int | None = None,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> dict:
    """Live totals a display may show now (live scoring spec §7), for start-up and reconnect."""
    event = get_the_event(db)
    plugin = get_optional_game_plugin(request, event) if event is not None else None
    return live_scores.live_snapshot(db, plugin, field_set_id)
```

- [ ] **Step 5: Call it after every phase change**

In `routers/matches.py`, change `from tournament_server.services import displays, qualification` to `from tournament_server.services import displays, live_scores, qualification`. Then:

In `_auto_advance_match`, after the `broadcast_for_session(request_app, db, match.session_id, "match_phase_changed", {...})` call and before `if new_phase in ("autonomous", "driver"):`, add:

```python
        live_scores.on_match_phase_changed(request_app, db, match)
```

In `start_match`, directly after its `broadcast_for_session(request.app, db, match.session_id, "match_phase_changed", {...})` call, add:

```python
    live_scores.on_match_phase_changed(request.app, db, match)
```

Do the same in `start_driver` and `end_match`, each directly after its `match_phase_changed` broadcast. In `reset_match`, replace

```python
    broadcast_for_session(
        request.app, db, match.session_id, "match_reset",
        {"match_id": match.id, "phase": match.phase},
    )
    return _to_match_read(match, db)
```

with

```python
    broadcast_for_session(
        request.app, db, match.session_id, "match_reset",
        {"match_id": match.id, "phase": match.phase},
    )
    live_scores.on_match_phase_changed(request.app, db, match)
    return _to_match_read(match, db)
```

In `app.py`'s `_recover_in_flight_matches`, add `from tournament_server.services import live_scores` next to its other local imports, and directly after its `broadcast_for_session(app, db, match.session_id, "match_phase_changed", {...})` call add:

```python
                live_scores.on_match_phase_changed(app, db, match)
```

- [ ] **Step 6: Run the tests**

Run: `cd server && .venv/bin/pytest -q tests/test_live_scores.py`
Expected: all pass.

- [ ] **Step 7: Run the wider suites**

Run: `cd server && .venv/bin/pytest -q tests/test_drafts.py tests/test_match_control_endpoints.py tests/test_match_control_recovery.py tests/test_match_control_displays.py tests/test_broadcast_wiring.py tests/test_display_reads.py tests/test_displays_api.py tests/test_session_live_switches.py tests/test_realtime_roles.py`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add server/src/tournament_server/services/live_scores.py server/src/tournament_server/routers/displays.py \
  server/src/tournament_server/routers/matches.py server/src/tournament_server/app.py server/tests/test_live_scores.py
git commit -m "Send live match totals to displays and admins while a match's clock runs and its session's switch for the round allows it, clear them when the clock ends, the match resets or a switch turns off, and add GET /api/displays/live-scores so a display starting up sees the same totals.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Submit, reset and draft cleanup

**Files:**
- Modify: `server/src/tournament_server/schemas/draft.py` (`SubmitRequest`)
- Modify: `server/src/tournament_server/services/drafts.py` (`submit_match`, `broadcast_drafts_cleared`)
- Modify: `server/src/tournament_server/routers/drafts.py` (`POST /api/matches/{id}/submit`)
- Modify: `server/src/tournament_server/routers/matches.py` (whole-match reset clears drafts)
- Modify: `server/src/tournament_server/routers/qualification.py` (finalize deletes the drafts of matches it marks not played)
- Modify: `server/src/tournament_server/services/deletion.py` (`delete_matches` deletes drafts)
- Test: `server/tests/test_draft_submit.py`

**Interfaces:**
- Consumes: Task 5 `write_alliance_score(db, plugin, match, alliance, *, data, teams, sitting, force, submitted_by, is_admin)` and `after_scores_written(app, db, plugin, match, alliance_ids)`; Task 6 `drafts` service and `live_helpers`; Task 7 `live_scores.on_match_phase_changed`.
- Produces: `SubmitRequest(force: bool = False)` (`extra=forbid`; Task 10 reuses it); `POST /api/matches/{id}/submit` → `MatchDraftRead` with `submitted: true` and each alliance's official data, flags and score; `drafts.submit_match(db, plugin, match, *, force, submitted_by, is_admin) -> list[int]` (the match's alliance ids; caller holds `DRAFT_WRITE_LOCK`); `drafts.broadcast_drafts_cleared(app, db, match)`. Submit broadcasts `score_saved` (through `after_scores_written`), `match_submitted {match_id}` to everyone, and calls `on_match_phase_changed` (which clears any live totals: a completed match is never live).
- Errors: 404 unknown match; 409 `qualification.NOT_PLAYED_SCORE_DETAIL`; 409 `SCORE_ALREADY_SUBMITTED_DETAIL` once submitted (and for a second Submit); 409 `"Alliance {id} has no draft score."`; 422 `{"violations": [{"alliance_id", "messages"}]}` unless `force`; 422 `"Plugin could not validate this scoresheet: …"` / `"Plugin could not score this scoresheet: …"` (never forceable, as `POST …/score`).
- Whole-match reset (`scope: "full"`) deletes the match's drafts and broadcasts `score_draft_changed` with an empty draft (`version: 0`) per alliance; `scope: "section"` keeps them. Finalizing qualification deletes the drafts of the matches it marks not played; `delete_matches` (schedule clear, finals delete, session delete) deletes drafts.

Plan note: Submit is all-or-nothing by checking first and writing second. Every alliance's draft, flags, `validate` and `calculate_score` are checked before the first `write_alliance_score`, because that function commits per alliance (Task 5), so a failure between two writes could otherwise leave half a match official. The writes then pass `force=True`, since the violations were already decided. The skeleton's `with_for_update()` select is kept for intent, but SQLite ignores it; the `DRAFT_WRITE_LOCK` plus the `is_submitted` re-check inside it is what makes a second Submit get 409.

Plan note: an alliance that already has an official score from `POST …/score` and no draft keeps that score, and Submit writes the rest. If it also has a draft, a scorer gets 409 `SCORE_ALREADY_SUBMITTED_DETAIL` (only an admin may overwrite a submitted score) and an admin's Submit overwrites it.

Plan note (cooperative): the shared draft is written once, on the shared (lowest) alliance, and mirrored as today. Per-team flags still belong to each alliance's own record, so a partner alliance is also written (same data, its own flags) when one of its teams is flagged, or when the shared alliance is out and so mirrors nothing.

Plan note: no edit to `routers/schedule.py` or `routers/finals.py` is needed. Schedule clear, finals delete and session delete all go through `services/deletion.delete_matches`, which now deletes drafts. The `score_drafts` foreign keys also cascade, but the explicit delete keeps working if that ever changes.

Plan note for Task 12: the cleared drafts a whole reset broadcasts have `version: 0`, and the next PATCH starts again at `version: 1`. "Apply only a newer version" must therefore treat an incoming `version: 0` as a reset that replaces the local draft. Otherwise a device holding version 5 ignores the reset and every later change.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_draft_submit.py`:

```python
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from auth_helpers import bearer, login_as
from device_helpers import paired_device
from display_helpers import add_match
from live_helpers import (
    DRAFT,
    cooperative_setup,
    draft_rows,
    listening,
    patch_draft,
    score_chase_setup,
    scoring_setup,
    settle,
)
from ranking_helpers import finalize_qualification
from tournament_server.models.score_record import ScoreRecord
from tournament_server.routers.scores import SCORE_ALREADY_SUBMITTED_DETAIL
from tournament_server.services.qualification import NOT_PLAYED_SCORE_DETAIL

RED_DRAFT = DRAFT  # scores 9
BLUE_DRAFT = {**DRAFT, "high_balls": 1}  # scores 3


def _submit(client, match_id: int, headers=None, **body):
    return client.post(f"/api/matches/{match_id}/submit", json=body, headers=headers)


def _records(client) -> dict[int, ScoreRecord]:
    with client.app.state.session_factory() as db:
        return {record.alliance_id: record for record in db.execute(select(ScoreRecord)).scalars().all()}


def _both_drafts(client, setup, headers=None) -> None:
    assert patch_draft(client, setup, "red", RED_DRAFT, headers=headers).status_code == 200
    assert patch_draft(client, setup, "blue", BLUE_DRAFT, headers=headers).status_code == 200


def _strict_validate(monkeypatch, client) -> None:
    module = client.app.state.game_plugins["example-game"].module
    monkeypatch.setattr(
        module,
        "validate",
        lambda data: ["Low balls can't exceed high balls."] if data.get("low_balls", 0) > data.get("high_balls", 0) else [],
    )


def test_submit_makes_the_drafts_official(client):
    setup = scoring_setup(client)
    tablet = paired_device(client, role="scorer", name="Field 1 Tablet")
    _both_drafts(client, setup, headers=tablet["headers"])
    submitted = _submit(client, setup["match_id"], headers=tablet["headers"])
    assert submitted.status_code == 200, submitted.text
    assert submitted.json() == {
        "match_id": setup["match_id"],
        "submitted": True,
        "alliances": [
            {"alliance_id": setup["red"], "data": RED_DRAFT, "teams": [], "item_meta": {}, "version": 0, "score": 9},
            {"alliance_id": setup["blue"], "data": BLUE_DRAFT, "teams": [], "item_meta": {}, "version": 0, "score": 3},
        ],
    }
    records = _records(client)
    assert set(records) == {setup["red"], setup["blue"]}
    assert {record.submitted_by_device for record in records.values()} == {"Field 1 Tablet"}
    assert draft_rows(client) == []
    assert client.get(f"/api/matches/{setup['match_id']}").json()["status"] == "completed"
    assert client.get(f"/api/matches/{setup['match_id']}/draft").json() == submitted.json()

    rankings = {row["team_id"]: row for row in client.get(f"/api/rankings?session_id={setup['session_id']}").json()}
    t1, t2, t3, t4 = setup["teams"]
    assert [rankings[team]["win_points"] for team in (t1, t2, t3, t4)] == [2, 2, 0, 0]


def test_submit_needs_a_draft_for_every_alliance(client):
    setup = scoring_setup(client)
    patch_draft(client, setup, "red", RED_DRAFT)
    refused = _submit(client, setup["match_id"])
    assert refused.status_code == 409
    assert refused.json()["detail"] == f"Alliance {setup['blue']} has no draft score."
    assert _records(client) == {}
    assert [row.alliance_id for row in draft_rows(client)] == [setup["red"]]


def test_plugin_problems_are_reported_per_alliance_and_force_overrides_them(client, monkeypatch):
    _strict_validate(monkeypatch, client)
    setup = scoring_setup(client)
    patch_draft(client, setup, "red", RED_DRAFT)
    patch_draft(client, setup, "blue", {**BLUE_DRAFT, "low_balls": 2})
    refused = _submit(client, setup["match_id"])
    assert refused.status_code == 422
    assert refused.json()["detail"] == {
        "violations": [{"alliance_id": setup["blue"], "messages": ["Low balls can't exceed high balls."]}]
    }
    # All or nothing: the valid red draft wasn't written either.
    assert _records(client) == {}
    assert len(draft_rows(client)) == 2

    forced = _submit(client, setup["match_id"], force=True)
    assert forced.status_code == 200, forced.text
    assert [alliance["score"] for alliance in forced.json()["alliances"]] == [9, 5]
    assert draft_rows(client) == []


def test_a_second_submit_and_later_patches_are_refused(client):
    setup = scoring_setup(client)
    _both_drafts(client, setup)
    assert _submit(client, setup["match_id"]).status_code == 200
    again = _submit(client, setup["match_id"])
    assert again.status_code == 409
    assert again.json()["detail"] == SCORE_ALREADY_SUBMITTED_DETAIL
    late = patch_draft(client, setup, "red", {"high_balls": 1})
    assert late.status_code == 409
    assert late.json()["detail"] == SCORE_ALREADY_SUBMITTED_DETAIL
    assert draft_rows(client) == []


def test_two_submits_at_once_write_one_score(client):
    setup = scoring_setup(client)
    _both_drafts(client, setup)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: _submit(client, setup["match_id"]), range(2)))
    assert sorted(result.status_code for result in results) == [200, 409]
    refused = next(result for result in results if result.status_code == 409)
    assert refused.json()["detail"] == SCORE_ALREADY_SUBMITTED_DETAIL
    assert len(_records(client)) == 2


def test_an_alliance_scored_earlier_keeps_its_score(client):
    setup = scoring_setup(client)
    tablet = paired_device(client, role="scorer")
    official = client.post(
        f"/api/matches/{setup['match_id']}/alliances/{setup['red']}/score", json={"data": RED_DRAFT}
    )
    assert official.status_code == 200
    patch_draft(client, setup, "blue", BLUE_DRAFT, headers=tablet["headers"])
    submitted = _submit(client, setup["match_id"], headers=tablet["headers"])
    assert submitted.status_code == 200, submitted.text
    assert [alliance["score"] for alliance in submitted.json()["alliances"]] == [9, 3]


def test_only_an_admin_submit_overwrites_an_earlier_score(client):
    setup = scoring_setup(client)
    tablet = paired_device(client, role="scorer")
    client.post(f"/api/matches/{setup['match_id']}/alliances/{setup['red']}/score", json={"data": RED_DRAFT})
    patch_draft(client, setup, "red", {**RED_DRAFT, "high_balls": 5}, headers=tablet["headers"])
    patch_draft(client, setup, "blue", BLUE_DRAFT, headers=tablet["headers"])
    refused = _submit(client, setup["match_id"], headers=tablet["headers"])
    assert refused.status_code == 409
    assert refused.json()["detail"] == SCORE_ALREADY_SUBMITTED_DETAIL
    assert set(_records(client)) == {setup["red"]}

    overwritten = _submit(client, setup["match_id"])
    assert overwritten.status_code == 200, overwritten.text
    assert [alliance["score"] for alliance in overwritten.json()["alliances"]] == [15, 3]


def test_submit_tells_every_device_and_clears_live_totals(client):
    setup = scoring_setup(client)
    assert client.post(f"/api/matches/{setup['match_id']}/start").status_code == 200
    _both_drafts(client, setup)
    with listening(client, "display_device", "scorer", "admin", "judge") as heard:
        assert _submit(client, setup["match_id"]).status_code == 200
        settle(client, heard)
    for recorder in heard.values():
        assert recorder.events("match_submitted") == [{"match_id": setup["match_id"]}]
        assert {event["alliance_id"] for event in recorder.events("score_saved")} == {setup["red"], setup["blue"]}
    assert heard["display_device"].events("live_score")[-1] == {"match_id": setup["match_id"], "cleared": True}


def test_submit_roles(client):
    setup = scoring_setup(client)
    _both_drafts(client, setup)
    judge = paired_device(client, role="judge")
    assert _submit(client, setup["match_id"], headers=judge["headers"]).status_code == 403
    token = login_as(TestClient(client.app), "scorer")
    unpaired = _submit(client, setup["match_id"], headers=bearer(token))
    assert unpaired.status_code == 403
    assert _submit(client, 999).status_code == 404
    assert _submit(client, setup["match_id"], forced=True).status_code == 422
    referee = paired_device(client, role="referee")
    assert _submit(client, setup["match_id"], headers=referee["headers"]).status_code == 200


def test_a_cooperative_submit_mirrors_the_shared_draft(cooperative_client):
    client = cooperative_client
    setup = cooperative_setup(client)
    patch_draft(client, setup, "blue", {"objects_scored": 10})
    submitted = _submit(client, setup["match_id"])
    assert submitted.status_code == 200, submitted.text
    assert [alliance["score"] for alliance in submitted.json()["alliances"]] == [20, 20]
    records = _records(client)
    assert (records[setup["red"]].mirrored, records[setup["blue"]].mirrored) == (False, True)
    assert client.get(f"/api/matches/{setup['match_id']}").json()["status"] == "completed"
    assert draft_rows(client) == []


@pytest.mark.parametrize("flagged_side", ["red", "blue"])
def test_a_cooperative_submit_keeps_each_teams_flag(cooperative_client, flagged_side):
    client = cooperative_client
    setup = cooperative_setup(client)
    t1, t2 = setup["teams"]
    flagged_team = t1 if flagged_side == "red" else t2
    other_side = "blue" if flagged_side == "red" else "red"
    patch_draft(client, setup, "red", {"objects_scored": 10}, teams=[{"team_id": flagged_team, "no_show": True}])
    assert _submit(client, setup["match_id"]).status_code == 200
    scores = {score["alliance_id"]: score for score in client.get("/api/scores").json()}
    assert scores[setup[flagged_side]]["score"] == 0
    assert scores[setup[flagged_side]]["teams"] == [{"team_id": flagged_team, "no_show": True, "dq": False}]
    assert scores[setup[other_side]]["score"] == 20
    assert scores[setup[other_side]]["teams"] == []


def test_submitting_a_finals_run_advances_the_bracket(cooperative_client):
    client = cooperative_client
    chase = score_chase_setup(client)
    [alliance_id] = chase["alliance_ids"]
    patch_draft(client, chase, alliance_id, {"objects_scored": 5})
    submitted = _submit(client, chase["match_id"])
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["alliances"][0]["score"] == 10
    bracket = client.get(f"/api/finals/{chase['bracket_id']}").json()
    assert len(bracket["runs"]) == 2


def test_a_whole_match_reset_clears_drafts_and_a_section_reset_keeps_them(client):
    setup = scoring_setup(client)
    match_url = f"/api/matches/{setup['match_id']}"
    assert client.post(f"{match_url}/start").status_code == 200
    patch_draft(client, setup, "red", RED_DRAFT)
    section = client.post(f"{match_url}/reset", json={"scope": "section"})
    assert section.status_code == 200
    assert section.json()["phase"] == "not_started"
    assert client.get(f"{match_url}/draft").json()["alliances"][0]["version"] == 1

    assert client.post(f"{match_url}/start").status_code == 200
    with listening(client, "scorer", "display_device") as heard:
        assert client.post(f"{match_url}/reset", json={"scope": "full"}).status_code == 200
        settle(client, heard)
    assert draft_rows(client) == []
    assert [alliance["version"] for alliance in client.get(f"{match_url}/draft").json()["alliances"]] == [0, 0]
    empty = {"teams": [], "item_meta": {}, "version": 0, "score": 0, "data": {}}
    assert heard["scorer"].events("score_draft_changed") == [
        {"match_id": setup["match_id"], "alliance_id": setup["red"], **empty},
        {"match_id": setup["match_id"], "alliance_id": setup["blue"], **empty},
    ]
    assert heard["display_device"].events("score_draft_changed") == []


def test_marking_a_match_not_played_deletes_its_drafts(client):
    setup = scoring_setup(client)
    second = add_match(client, setup["session_id"], setup["field_set"]["field_ids"][1], 2, setup["teams"], minutes=5)
    second_setup = {"match_id": second["id"], "red": second["alliances"][0]["id"]}
    _both_drafts(client, setup)
    assert _submit(client, setup["match_id"]).status_code == 200
    patch_draft(client, second_setup, "red", RED_DRAFT)

    finalize_qualification(client, setup["session_id"])

    assert client.get(f"/api/matches/{second['id']}").json()["status"] == "not_played"
    assert draft_rows(client) == []
    late = patch_draft(client, second_setup, "red", {"high_balls": 1})
    assert (late.status_code, late.json()["detail"]) == (409, NOT_PLAYED_SCORE_DETAIL)
    refused = _submit(client, second["id"])
    assert (refused.status_code, refused.json()["detail"]) == (409, NOT_PLAYED_SCORE_DETAIL)


@pytest.mark.parametrize("remove", ["schedule", "session"])
def test_deleting_matches_deletes_their_drafts(client, remove):
    setup = scoring_setup(client)
    _both_drafts(client, setup)
    if remove == "schedule":
        cleared = client.delete(
            "/api/schedule", params={"session_id": setup["session_id"], "round_type": "qualification"}
        )
        assert cleared.status_code == 200
        assert cleared.json()["matches_deleted"] == 1
    else:
        assert client.delete(f"/api/sessions/{setup['session_id']}").status_code == 204
    assert draft_rows(client) == []


def test_deleting_a_finals_bracket_deletes_its_drafts(cooperative_client):
    client = cooperative_client
    chase = score_chase_setup(client)
    patch_draft(client, chase, chase["alliance_ids"][0], {"objects_scored": 5})
    assert len(draft_rows(client)) == 1
    assert client.delete(f"/api/finals/{chase['bracket_id']}").status_code == 204
    assert draft_rows(client) == []
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && .venv/bin/pytest -q tests/test_draft_submit.py`
Expected: FAIL (`POST /api/matches/{id}/submit` returns 404/405, a whole reset leaves the drafts, and finalize leaves the not-played match's drafts). The deletion tests may already pass because the `score_drafts` foreign keys cascade; they pin the behaviour.

- [ ] **Step 3: Add the request schema**

Append to `schemas/draft.py`:

```python
class SubmitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    force: bool = False
```

- [ ] **Step 4: Add submit and the cleared broadcast to the drafts service**

In `services/drafts.py`, add `write_alliance_score` to the score-submission import:

```python
from tournament_server.services.score_submission import ScoreRefused, write_alliance_score
```

and append:

```python
def submit_match(
    db: Session,
    plugin: "LoadedPlugin",
    match: Match,
    *,
    force: bool,
    submitted_by: str | None,
    is_admin: bool,
) -> list[int]:
    """Turns the match's drafts into official score records, all or nothing:
    every check runs before the first write. The caller holds
    DRAFT_WRITE_LOCK. Returns the match's alliance ids. Raises ScoreRefused."""
    if match.status == qualification.NOT_PLAYED:
        raise ScoreRefused(status_code=409, detail=qualification.NOT_PLAYED_SCORE_DETAIL)
    if is_submitted(db, match):
        raise ScoreRefused(status_code=409, detail=SCORE_ALREADY_SUBMITTED_DETAIL)

    alliance_ids = match_alliance_ids(db, match.id)
    alliances = {alliance_id: db.get(Alliance, alliance_id) for alliance_id in alliance_ids}
    team_ids = {alliance_id: team_flags.alliance_team_ids(db, alliance_id) for alliance_id in alliance_ids}
    records = {
        record.alliance_id: record
        for record in db.execute(select(ScoreRecord).where(ScoreRecord.alliance_id.in_(alliance_ids))).scalars()
    }
    finals = _finals(match)

    # (alliance id, data, its own flags), in alliance order.
    writes: list[tuple[int, dict, list[TeamFlags]]] = []
    if _cooperative(plugin):
        shared_id = alliance_ids[0]
        draft = _draft_row(db, shared_id)
        if draft is None:
            raise ScoreRefused(status_code=409, detail=f"Alliance {shared_id} has no draft score.")
        data = json.loads(draft.data_json)
        flags = _stored_flags(draft)
        shared_out = team_flags.alliance_out(flags, team_ids[shared_id], finals=False)
        for alliance_id in alliance_ids:
            own = [flag for flag in flags if flag.team_id in team_ids[alliance_id]]
            # The shared alliance mirrors its data to partners; a partner is
            # written too when it has its own flags or nothing was mirrored.
            if alliance_id == shared_id or own or shared_out:
                writes.append((alliance_id, data, own))
        checked = [(shared_id, data, flags)]
    else:
        for alliance_id in alliance_ids:
            draft = _draft_row(db, alliance_id)
            record = records.get(alliance_id)
            if draft is None:
                if record is not None:
                    continue
                raise ScoreRefused(status_code=409, detail=f"Alliance {alliance_id} has no draft score.")
            if record is not None and not record.mirrored and not is_admin:
                raise ScoreRefused(status_code=409, detail=SCORE_ALREADY_SUBMITTED_DETAIL)
            own = [flag for flag in _stored_flags(draft) if flag.team_id in team_ids[alliance_id]]
            writes.append((alliance_id, json.loads(draft.data_json), own))
        checked = list(writes)

    violations = []
    for alliance_id, data, flags in checked:
        try:
            messages = plugin.module.validate(data)
        except Exception as exc:
            raise ScoreRefused(status_code=422, detail=f"Plugin could not validate this scoresheet: {exc}")
        if messages:
            violations.append({"alliance_id": alliance_id, "messages": list(messages)})
        if not team_flags.alliance_out(flags, team_ids[alliance_id], finals=finals):
            try:
                plugin.module.calculate_score(data)
            except Exception as exc:
                raise ScoreRefused(status_code=422, detail=f"Plugin could not score this scoresheet: {exc}")
    if violations and not force:
        raise ScoreRefused(status_code=422, detail={"violations": violations})

    for alliance_id, data, flags in writes:
        write_alliance_score(
            db,
            plugin,
            match,
            alliances[alliance_id],
            data=data,
            teams=flags,
            sitting=False,
            force=True,
            submitted_by=submitted_by,
            is_admin=is_admin,
        )
    delete_match_drafts(db, [match.id])
    db.commit()
    return alliance_ids


def broadcast_drafts_cleared(app: "FastAPI", db: Session, match: Match) -> None:
    """Tells scoring devices every alliance's draft is now empty (version 0)."""
    for alliance_id in match_alliance_ids(db, match.id):
        realtime.broadcast_active_session(
            app,
            "score_draft_changed",
            {"match_id": match.id, **empty_alliance_draft(alliance_id).model_dump(mode="json")},
            roles=DRAFT_EVENT_ROLES,
        )
```

- [ ] **Step 5: Add the submit route**

In `routers/drafts.py`, extend the imports:

```python
from sqlalchemy import select

from tournament_server import audit, realtime
from tournament_server.schemas.draft import AllianceDraftRead, DraftPatch, MatchDraftRead, SubmitRequest
from tournament_server.services.score_submission import ScoreRefused, after_scores_written
```

(the existing `schemas.draft` and `score_submission` import lines are replaced by these), and append:

```python
@router.post("/{match_id}/submit", response_model=MatchDraftRead)
def submit_drafts(
    match_id: int,
    payload: SubmitRequest,
    request: Request,
    db: Session = Depends(get_db),
    role: str = Depends(require_scorer_or_referee),
    device_name: str | None = Depends(require_paired_scoring_device),
) -> MatchDraftRead:
    """Makes the match's drafts its official scores (live scoring spec §5.1)."""
    plugin = get_game_plugin_for_event(request, db)
    submitted_by = device_name if device_name is not None else audit.current_actor.get()
    with drafts.DRAFT_WRITE_LOCK:
        match = (
            db.execute(
                select(Match)
                .where(Match.id == match_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
            .scalars()
            .first()
        )
        if match is None:
            raise HTTPException(status_code=404, detail="Match not found")
        try:
            alliance_ids = drafts.submit_match(
                db, plugin, match, force=payload.force, submitted_by=submitted_by, is_admin=role == "admin"
            )
        except ScoreRefused as refused:
            db.rollback()
            raise HTTPException(status_code=refused.status_code, detail=refused.detail) from refused
    after_scores_written(request.app, db, plugin, match, alliance_ids)
    db.refresh(match)
    realtime.broadcast_active_session(request.app, "match_submitted", {"match_id": match.id})
    live_scores.on_match_phase_changed(request.app, db, match)
    return drafts.read_match_draft(db, plugin, match)
```

- [ ] **Step 6: Clear drafts on a whole-match reset**

In `routers/matches.py`, change the services import to `from tournament_server.services import displays, drafts, live_scores, qualification`. In `reset_match`, replace

```python
    match.phase = new_phase
    match.phase_deadline = None
    match.paused = False
    match.remaining_seconds_at_pause = None
    db.commit()
    db.refresh(match)

    broadcast_for_session(
        request.app, db, match.session_id, "match_reset",
        {"match_id": match.id, "phase": match.phase},
    )
    live_scores.on_match_phase_changed(request.app, db, match)
    return _to_match_read(match, db)
```

with

```python
    match.phase = new_phase
    match.phase_deadline = None
    match.paused = False
    match.remaining_seconds_at_pause = None
    # The whole-match reset starts scoring over (spec §5.1); a section reset keeps the drafts.
    clears_drafts = payload.scope == "full"
    with drafts.DRAFT_WRITE_LOCK:
        if clears_drafts:
            drafts.delete_match_drafts(db, [match.id])
        db.commit()
    db.refresh(match)

    broadcast_for_session(
        request.app, db, match.session_id, "match_reset",
        {"match_id": match.id, "phase": match.phase},
    )
    if clears_drafts:
        drafts.broadcast_drafts_cleared(request.app, db, match)
    live_scores.on_match_phase_changed(request.app, db, match)
    return _to_match_read(match, db)
```

- [ ] **Step 7: Delete drafts when matches go away or are marked not played**

In `services/deletion.py`, change `from tournament_server.services import displays` to `from tournament_server.services import displays, drafts`, and in `delete_matches` replace

```python
    matches = list(matches)
    displays.clear_queued_matches(db, [match.id for match in matches])
```

with

```python
    matches = list(matches)
    displays.clear_queued_matches(db, [match.id for match in matches])
    drafts.delete_match_drafts(db, [match.id for match in matches])
```

and update its docstring's first line to `"""Deletes matches with their alliances, alliance teams, score records and draft scores,`.

In `routers/qualification.py`, change `from tournament_server.services import qualification` to `from tournament_server.services import drafts, qualification`, and in `finalize` replace

```python
    try:
        qualification.finalize(db, session_obj, state, payload.drops)
    except qualification.QualificationConflictError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _after_change(request, db, session_obj, plugin)
```

with

```python
    try:
        qualification.finalize(db, session_obj, state, payload.drops)
    except qualification.QualificationConflictError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    # Drafts of the matches just marked not played can never be submitted.
    drafts.delete_match_drafts(db, [match.id for match in state.unplayed])
    return _after_change(request, db, session_obj, plugin)
```

(`_after_change` commits.)

- [ ] **Step 8: Run the tests**

Run: `cd server && .venv/bin/pytest -q tests/test_draft_submit.py`
Expected: all pass.

- [ ] **Step 9: Run the wider suites**

Run: `cd server && .venv/bin/pytest -q tests/test_drafts.py tests/test_live_scores.py tests/test_scores.py tests/test_cooperative_scoring.py tests/test_per_team_flags_api.py tests/test_per_team_flags_finals.py tests/test_qualification_finalize.py tests/test_qualification_guards.py tests/test_session_delete.py tests/test_schedule.py tests/test_finals.py tests/test_finals_service.py tests/test_match_control_endpoints.py tests/test_rankings.py`
Expected: all pass. Then run the whole server suite once: `cd server && .venv/bin/pytest -q`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add server/src/tournament_server/schemas/draft.py server/src/tournament_server/services/drafts.py \
  server/src/tournament_server/routers/drafts.py server/src/tournament_server/routers/matches.py \
  server/src/tournament_server/routers/qualification.py server/src/tournament_server/services/deletion.py \
  server/tests/test_draft_submit.py
git commit -m "Add Submit for teamwork drafts: check every alliance's draft and the plugin's problems before writing, write the official scores through the shared score service with cooperative mirroring and per-team flags, delete the drafts, refuse a second Submit, and tell every device. A whole-match reset now clears the drafts, and drafts are deleted when their match is marked not played or deleted.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Skills runs: create, draft, discard, read

**Files:**
- Create: `server/src/tournament_server/schemas/skills_run.py`
- Create: `server/src/tournament_server/routers/skills_runs.py`
- Create: `server/tests/skills_run_helpers.py`
- Modify: `server/src/tournament_server/services/skills_runs.py` (Task 2 created it with `ensure_set_timer`; this task adds the run logic)
- Modify: `server/src/tournament_server/services/skills.py` (`attempt_refusal`, extracted from the attempts route)
- Modify: `server/src/tournament_server/routers/skills.py` (`create_skills_attempt` uses `attempt_refusal`)
- Modify: `server/src/tournament_server/app.py`
- Test: `server/tests/test_skills_runs.py`

**Interfaces:**
- Consumes: Task 1 `SkillsRun`, `SkillsSetTimer` (`models/scoring_draft.py`), `FieldSet.purpose`, `SKILLS`; Task 2 `skills_runs.ensure_set_timer(db, field_set)`; Task 3 `skills.run_seconds(plugin, skills_type)` and `run_seconds` in `GET /api/skills/settings` types; Task 4 `broadcast_active_session(..., roles=...)`; Task 6 `ItemMeta` (`schemas/draft.py`).
- Produces (schemas, `schemas/skills_run.py`): `SkillsRunCreate(team_id, skills_type=None, follows_set=True)`; `SkillsRunPatch(changes)`; `SkillsRunRead(id, field_id, field_set_id, team_id, team_number, team_name, skills_type, data, item_meta, version, score, follows_set, phase, deadline, paused, remaining_seconds)`; `SkillsSetTimerRead(field_set_id, skills_type, phase, deadline, paused, remaining_seconds, run_seconds)`; `SkillsFieldRead(field_id, name, run)`; `SkillsSetRead(timer, fields)`.
- Produces (`services/skills_runs.py`): `READY`, `RUNNING`, `ENDED`; `RunRefused(status_code, detail)`; `TimerState(phase, deadline, paused, remaining)` (a `NamedTuple`, so `effective_timer` returns the skeleton's tuple); `timer_state(row, now=None)`; `effective_timer(run, set_timer) -> TimerState`; `require_skills_set`, `skills_set_for_field`, `find_set_timer`, `run_on_field`, `following_runs`, `set_skills_type(plugin, set_timer)`, `run_score(plugin, skills_type, data)`, `item_violations(schema, changes)`; `create_run(db, plugin, field, payload, device_name) -> SkillsRun`; `patch_run(db, plugin, field, changes, device_name) -> SkillsRun`; `discard_run(db, field) -> None`; `run_read(db, plugin, run) -> SkillsRunRead`; `read_set(db, plugin, field_set) -> SkillsSetRead`; `notify(app, field_set_id, field_id=None)`.
- Produces (`services/skills.py`): `attempt_refusal(db, session_obj, team, skills_type, types) -> str | None`.
- Produces (routes): `POST /api/fields/{id}/skills-run` (201), `PATCH /api/fields/{id}/skills-run/draft`, `DELETE /api/fields/{id}/skills-run` (204), `GET /api/field-sets/{id}/skills`. Details: `"This is not a skills field."`, `"This is not a skills field set."`, `"This field already has a run."`, `"This field has no run."` (404), `"A run following the set uses the set's skills type."` (409), the existing skills-off / not-checked-in / attempts-used 409s.

Plan note: the skeleton's PATCH body is "`DraftPatch` without `teams`". This task gives the route its own `SkillsRunPatch` (`changes` only, `extra=forbid`), so a `teams` key is a 422. It also checks skills items with `item_violations` here, built on `skills_rules.scoresheet_violations` one item at a time, rather than Task 6's teamwork `item_violations`. Skills sheets are flat `{name: value}` dicts and must give the same `{field, message}` violations as `POST …/skills/attempts`. The 422 body is the skills attempts format: `{"detail": "The scoresheet has errors.", "violations": [{field, message}]}`.

Plan note: the skeleton's `notify(app, field_set_id, field_id=None)` takes no `db`, but `live_scores.on_skills_changed(app, db, field_set_id)` needs one. `notify` therefore opens its own session from `app.state.session_factory`. It imports `live_scores` inside the function, because Task 10's `live_scores` imports `skills_runs` at module level.

Plan note (set timer batches, not in the spec): a run that follows an `ended` set timer would read as ended (and show a breakdown) the moment it is created. So when a run is created on a set whose timer has ended, the runs still following it keep their ended timer on their own (`follows_set = false`), and the set timer goes back to `ready` for the next batch. A run created while the set timer is running or paused never joins it partway: it starts on its own timer (`follows_set = false`, `ready`). Pinned by `test_a_new_run_after_the_set_ended_starts_the_next_batch` and `test_a_run_created_while_the_set_runs_waits_on_its_own_timer` (Task 10).

- [ ] **Step 1: Write the shared helpers and the failing tests**

Create `server/tests/skills_run_helpers.py`:

```python
"""Shared setup for the skills run and skills timer tests."""
from __future__ import annotations

import datetime as dt

from sqlalchemy import select

from skills_helpers import create_event, create_session, enable_skills
from tournament_server.db import utc_now


def add_set(client, session_id: int, name: str, purpose: str = "skills", fields=("Skills 1", "Skills 2")) -> dict:
    created = client.post("/api/field-sets", json={"session_id": session_id, "name": name, "purpose": purpose})
    assert created.status_code == 201, created.text
    field_set_id = created.json()["id"]
    field_ids = []
    for field_name in fields:
        field = client.post(
            "/api/fields", json={"session_id": session_id, "field_set_id": field_set_id, "name": field_name}
        )
        assert field.status_code == 201, field.text
        field_ids.append(field.json()["id"])
    return {"id": field_set_id, "field_ids": field_ids}


def skills_event(client, attempts: dict[str, int] | None = None) -> dict:
    """An example-game event with skills on, teams "1".."3" (1 and 2 checked
    in), an active session, a skills set with two fields and a teamwork set
    with one."""
    teams = create_event(client)
    session_id = create_session(client, checked_in=teams[:2])
    assert client.post("/api/event/active-session", json={"session_id": session_id}).status_code == 200
    enable_skills(client, attempts)
    return {
        "teams": teams,
        "session_id": session_id,
        "set": add_set(client, session_id, "Skills Row A"),
        "teamwork": add_set(client, session_id, "Main Fields", purpose="teamwork", fields=("Field 1",)),
    }


def start_run(client, field_id: int, team_id: int, headers: dict | None = None, **body) -> dict:
    response = client.post(
        f"/api/fields/{field_id}/skills-run", json={"team_id": team_id, **body}, headers=headers or {}
    )
    assert response.status_code == 201, response.text
    return response.json()


def read_set(client, field_set_id: int) -> dict:
    response = client.get(f"/api/field-sets/{field_set_id}/skills")
    assert response.status_code == 200, response.text
    return response.json()


def runs_by_field(body: dict) -> dict[int, dict | None]:
    return {field["field_id"]: field["run"] for field in body["fields"]}


def run_on(client, field_set_id: int, field_id: int) -> dict | None:
    return runs_by_field(read_set(client, field_set_id))[field_id]


def run_length(client, skills_type: str) -> int:
    types = client.get("/api/skills/settings").json()["types"]
    return next(t["run_seconds"] for t in types if t["key"] == skills_type)


def expire(client, model, **where) -> None:
    """Moves a running timer's deadline one second into the past, straight in
    the test database (no real server is running against it)."""
    with client.app.state.session_factory() as db:
        row = db.execute(select(model).filter_by(**where)).scalars().one()
        row.deadline = utc_now() - dt.timedelta(seconds=1)
        db.commit()
```

Create `server/tests/test_skills_runs.py`:

```python
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from auth_helpers import bearer, login_as
from device_helpers import paired_device
from skills_helpers import admin_token, create_event, create_session, next_event, record_attempt
from skills_run_helpers import add_set, read_set, run_length, run_on, skills_event, start_run
from tournament_server.models.scoring_draft import SkillsRun


@pytest.fixture
def event(client):
    return skills_event(client, attempts={"autonomous": 1, "driver": 2})


def test_a_new_run_follows_the_set_with_the_sets_type(client, event):
    field_id = event["set"]["field_ids"][0]
    run = start_run(client, field_id, event["teams"][0])
    assert (run["field_id"], run["field_set_id"]) == (field_id, event["set"]["id"])
    assert (run["team_id"], run["team_number"], run["team_name"]) == (event["teams"][0], "1", "Team 1")
    assert (run["skills_type"], run["follows_set"], run["phase"], run["deadline"]) == ("autonomous", True, "ready", None)
    assert (run["data"], run["item_meta"], run["version"], run["score"]) == ({}, {}, 0, 0)
    body = read_set(client, event["set"]["id"])
    timer = body["timer"]
    assert (timer["field_set_id"], timer["skills_type"], timer["phase"]) == (event["set"]["id"], "autonomous", "ready")
    assert timer["run_seconds"] == run_length(client, "autonomous")
    assert [(f["name"], f["run"] is not None) for f in body["fields"]] == [("Skills 1", True), ("Skills 2", False)]
    assert body["fields"][0]["run"]["id"] == run["id"]


def test_a_run_needs_a_checked_in_team_with_attempts_left_and_a_free_field(client, event):
    first, second = event["set"]["field_ids"]
    team_1, team_2, team_3 = event["teams"]
    url = f"/api/fields/{first}/skills-run"
    refused = client.post(url, json={"team_id": team_3})
    assert (refused.status_code, refused.json()["detail"]) == (409, "Team 3 is not checked in for this session.")
    assert record_attempt(client, event["session_id"], team_1, "autonomous").status_code == 201
    refused = client.post(url, json={"team_id": team_1})
    assert (refused.status_code, refused.json()["detail"]) == (409, "Team 1 has used all 1 Autonomous attempts.")
    start_run(client, first, team_2)
    refused = client.post(url, json={"team_id": team_2, "skills_type": "driver", "follows_set": False})
    assert (refused.status_code, refused.json()["detail"]) == (409, "This field already has a run.")
    assert client.post(f"/api/fields/{second}/skills-run", json={"team_id": 999}).status_code == 422
    unknown_type = client.post(
        f"/api/fields/{second}/skills-run", json={"team_id": team_2, "skills_type": "teleop", "follows_set": False}
    )
    assert unknown_type.status_code == 422


def test_no_run_while_skills_are_off(client):
    teams = create_event(client)
    session_id = create_session(client, checked_in=teams)
    field_id = add_set(client, session_id, "Skills Row A")["field_ids"][0]
    refused = client.post(f"/api/fields/{field_id}/skills-run", json={"team_id": teams[0]})
    assert (refused.status_code, refused.json()["detail"]) == (409, "Skills challenges are turned off for this event.")


def test_another_type_needs_the_run_on_its_own_timer(client, event):
    field_id = event["set"]["field_ids"][0]
    refused = client.post(
        f"/api/fields/{field_id}/skills-run", json={"team_id": event["teams"][0], "skills_type": "driver"}
    )
    assert (refused.status_code, refused.json()["detail"]) == (409, "A run following the set uses the set's skills type.")
    run = start_run(client, field_id, event["teams"][0], skills_type="driver", follows_set=False)
    assert (run["skills_type"], run["follows_set"], run["phase"]) == ("driver", False, "ready")


def test_teamwork_fields_and_sets_refuse_skills_runs(client, event):
    teamwork_field = event["teamwork"]["field_ids"][0]
    refused = client.post(f"/api/fields/{teamwork_field}/skills-run", json={"team_id": event["teams"][0]})
    assert (refused.status_code, refused.json()["detail"]) == (409, "This is not a skills field.")
    patched = client.patch(f"/api/fields/{teamwork_field}/skills-run/draft", json={"changes": {}})
    assert (patched.status_code, patched.json()["detail"]) == (409, "This is not a skills field.")
    deleted = client.delete(f"/api/fields/{teamwork_field}/skills-run")
    assert (deleted.status_code, deleted.json()["detail"]) == (409, "This is not a skills field.")
    read = client.get(f"/api/field-sets/{event['teamwork']['id']}/skills")
    assert (read.status_code, read.json()["detail"]) == (409, "This is not a skills field set.")
    assert client.post("/api/fields/999/skills-run", json={"team_id": event["teams"][0]}).status_code == 404
    assert client.get("/api/field-sets/999/skills").status_code == 404


def test_draft_changes_merge_item_by_item(client, event):
    field_id = event["set"]["field_ids"][0]
    scorer = paired_device(client, role="scorer", name="Scorer A")
    start_run(client, field_id, event["teams"][0], headers=scorer["headers"])
    url = f"/api/fields/{field_id}/skills-run/draft"
    first = client.patch(url, json={"changes": {"objects_scored": 3}}, headers=scorer["headers"])
    assert first.status_code == 200, first.text
    body = first.json()
    assert (body["data"], body["version"], body["score"]) == ({"objects_scored": 3}, 1, 6)
    assert body["item_meta"]["objects_scored"]["device_name"] == "Scorer A"
    second = client.patch(url, json={"changes": {"parked": True}}).json()
    assert (second["data"], second["version"], second["score"]) == ({"objects_scored": 3, "parked": True}, 2, 10)
    assert second["item_meta"]["objects_scored"]["device_name"] == "Scorer A"
    assert second["item_meta"]["parked"]["device_name"] == "Admin"
    third = client.patch(url, json={"changes": {"objects_scored": 4}}).json()
    assert (third["data"]["objects_scored"], third["version"]) == (4, 3)
    assert third["item_meta"]["objects_scored"]["device_name"] == "Admin"
    assert run_on(client, event["set"]["id"], field_id)["data"] == {"objects_scored": 4, "parked": True}


def test_bad_draft_items_are_refused_and_nothing_is_applied(client, event):
    first, second = event["set"]["field_ids"]
    start_run(client, first, event["teams"][0])
    url = f"/api/fields/{first}/skills-run/draft"
    refused = client.patch(url, json={"changes": {"objects_scored": 31, "parked": True}})
    assert refused.status_code == 422
    assert refused.json()["violations"] == [{"field": "objects_scored", "message": "Must be at most 30."}]
    unknown = client.patch(url, json={"changes": {"bogus": 1}})
    assert unknown.json()["violations"] == [{"field": "bogus", "message": "Unknown field."}]
    wrong_type = client.patch(url, json={"changes": {"parked": 1}})
    assert wrong_type.json()["violations"] == [{"field": "parked", "message": "Must be true or false."}]
    assert client.patch(url, json={"changes": {}, "teams": []}).status_code == 422
    run = run_on(client, event["set"]["id"], first)
    assert (run["data"], run["version"]) == ({}, 0)
    missing = client.patch(f"/api/fields/{second}/skills-run/draft", json={"changes": {}})
    assert (missing.status_code, missing.json()["detail"]) == (404, "This field has no run.")


def test_discarding_a_run_uses_no_attempt(client, event):
    field_id = event["set"]["field_ids"][0]
    team_1 = event["teams"][0]
    start_run(client, field_id, team_1)
    client.patch(f"/api/fields/{field_id}/skills-run/draft", json={"changes": {"objects_scored": 5}})
    assert client.delete(f"/api/fields/{field_id}/skills-run").status_code == 204
    assert run_on(client, event["set"]["id"], field_id) is None
    assert client.get(f"/api/sessions/{event['session_id']}/skills/attempts").json() == []
    # Autonomous allows one attempt, and the discarded run didn't use it.
    assert start_run(client, field_id, team_1)["version"] == 0
    assert client.delete(f"/api/fields/{event['set']['field_ids'][1]}/skills-run").status_code == 404


def test_paired_scorers_and_referees_run_skills_and_any_role_reads(client, event):
    field_id = event["set"]["field_ids"][0]
    url = f"/api/fields/{field_id}/skills-run"
    judge = paired_device(client, role="judge")
    assert client.post(url, json={"team_id": event["teams"][0]}, headers=judge["headers"]).status_code == 403
    unpaired = bearer(login_as(TestClient(client.app), "scorer"))
    refused = client.post(url, json={"team_id": event["teams"][0]}, headers=unpaired)
    assert (refused.status_code, refused.json()["detail"]) == (403, "Only a paired device can submit scores.")
    referee = paired_device(client, role="referee")
    start_run(client, field_id, event["teams"][0], headers=referee["headers"])
    display = paired_device(client, role="display_device")
    assert client.get(f"/api/field-sets/{event['set']['id']}/skills", headers=display["headers"]).status_code == 200
    assert client.delete(url, headers=display["headers"]).status_code == 403


def test_run_changes_are_announced_to_scorers_admins_and_displays(client, event):
    field_id = event["set"]["field_ids"][0]
    display = paired_device(client, role="display_device")
    expected = {"field_set_id": event["set"]["id"], "field_id": field_id}
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as admin_socket, \
            client.websocket_connect(f"/ws/active-session?token={display['access_token']}") as display_socket:
        start_run(client, field_id, event["teams"][0])
        assert next_event(admin_socket, "skills_run_changed")["data"] == expected
        assert next_event(display_socket, "skills_run_changed")["data"] == expected
        client.patch(f"/api/fields/{field_id}/skills-run/draft", json={"changes": {"objects_scored": 1}})
        assert next_event(admin_socket, "skills_run_changed")["data"] == expected
        client.delete(f"/api/fields/{field_id}/skills-run")
        assert next_event(admin_socket, "skills_run_changed")["data"] == expected


def test_deleting_a_field_deletes_its_run(client, event):
    field_id = event["set"]["field_ids"][1]
    start_run(client, field_id, event["teams"][0])
    assert client.delete(f"/api/fields/{field_id}").status_code == 204
    with client.app.state.session_factory() as db:
        assert db.execute(select(SkillsRun)).scalars().all() == []
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && .venv/bin/pytest -q tests/test_skills_runs.py`
Expected: FAIL. The skills-run routes don't exist yet: the `start_run` asserts see `404 Not Found`, the read tests get 404, and the teamwork-field checks get 404 instead of 409.

- [ ] **Step 3: Extract the attempt checks into the skills service**

In `services/skills.py` change the imports to:

```python
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from tournament_server.models.participation import SessionParticipation
from tournament_server.models.session import TournamentSession
from tournament_server.models.skills import SkillsAttempt, SkillsSettings
from tournament_server.models.team import Team
```

and add after `session_allowed`:

```python
def attempt_refusal(
    db: Session, session_obj: TournamentSession, team: Team, skills_type: str, types: dict[str, dict]
) -> str | None:
    """Why `team` can't take another `skills_type` attempt in this session (a
    409 detail), or None. Only submitted attempts count; `types` maps each
    plugin type key to its entry."""
    checked_in = db.execute(
        select(SessionParticipation.id).where(
            SessionParticipation.session_id == session_obj.id,
            SessionParticipation.team_id == team.id,
            SessionParticipation.checked_in.is_(True),
        )
    ).first()
    if checked_in is None:
        return f"Team {team.number} is not checked in for this session."
    allowed = session_allowed(db, session_obj, list(types))[skills_type]
    used = db.execute(
        select(func.count(SkillsAttempt.id)).where(
            SkillsAttempt.session_id == session_obj.id,
            SkillsAttempt.team_id == team.id,
            SkillsAttempt.skills_type == skills_type,
        )
    ).scalar_one()
    if used >= allowed:
        return f"Team {team.number} has used all {allowed} {types[skills_type]['label']} attempts."
    return None
```

In `routers/skills.py`'s `create_skills_attempt`, replace everything from `checked_in = db.execute(` down to and including the `raise HTTPException(... has used all ...)` block (the check-in query, `allowed`, `used` and the two raises) with:

```python
    refusal = skills.attempt_refusal(db, session_obj, team, payload.skills_type, types)
    if refusal is not None:
        raise HTTPException(status_code=409, detail=refusal)
```

The file no longer needs them, so remove `func` from the `sqlalchemy` import (it becomes `from sqlalchemy import select`) and delete `from tournament_server.models.participation import SessionParticipation`.

- [ ] **Step 4: Add the schemas**

Create `server/src/tournament_server/schemas/skills_run.py`:

```python
"""Skills runs, skills set timers and the skills set view (live scoring spec §6)."""
from __future__ import annotations

import datetime as dt
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt

from tournament_server.schemas.draft import ItemMeta


class SkillsRunCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    team_id: StrictInt
    # Defaults to the set's type; another type needs follows_set false.
    skills_type: str | None = None
    follows_set: StrictBool = True


class SkillsRunPatch(BaseModel):
    """Only the changed items; a skills run has no team flags."""

    model_config = ConfigDict(extra="forbid")

    changes: dict[str, Any] = Field(default_factory=dict)


class SkillsRunRead(BaseModel):
    id: int
    field_id: int
    field_set_id: int
    team_id: int
    team_number: str
    team_name: str
    skills_type: str
    data: dict[str, Any]
    item_meta: dict[str, ItemMeta]
    version: int
    # The plugin's score for the sheet so far; 0 while it can't be scored.
    score: int
    follows_set: bool
    # The timer this run is on (the set's while it follows the set), as it reads now.
    phase: str
    deadline: dt.datetime | None
    paused: bool
    remaining_seconds: int | None


class SkillsSetTimerRead(BaseModel):
    field_set_id: int
    skills_type: str | None
    phase: str
    deadline: dt.datetime | None
    paused: bool
    remaining_seconds: int | None
    run_seconds: int | None


class SkillsFieldRead(BaseModel):
    field_id: int
    name: str
    run: SkillsRunRead | None


class SkillsSetRead(BaseModel):
    timer: SkillsSetTimerRead
    fields: list[SkillsFieldRead]
```

- [ ] **Step 5: Add the run logic to the skills runs service**

In `services/skills_runs.py`, make the import block this (keep anything else `ensure_set_timer` already needs):

```python
from __future__ import annotations

import datetime as dt
import json
import math
from typing import Any, NamedTuple

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tournament_server import realtime
from tournament_server.db import utc_now
from tournament_server.models.field import Field
from tournament_server.models.field_set import SKILLS, FieldSet
from tournament_server.models.scoring_draft import SkillsRun, SkillsSetTimer
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.schemas.skills_run import (
    SkillsFieldRead,
    SkillsRunCreate,
    SkillsRunRead,
    SkillsSetRead,
    SkillsSetTimerRead,
)
from tournament_server.services import skills
from tournament_server.services.skills_rules import scoresheet_violations
```

and append below `ensure_set_timer`:

```python
READY, RUNNING, ENDED = "ready", "running", "ended"
RUN_EVENT_ROLES = ("admin", "scorer", "referee", "display_device")

NOT_SKILLS_FIELD = "This is not a skills field."
NOT_SKILLS_SET = "This is not a skills field set."
FIELD_BUSY = "This field already has a run."
NO_RUN = "This field has no run."
SET_TYPE_ONLY = "A run following the set uses the set's skills type."
SCORESHEET_ERRORS = "The scoresheet has errors."


class RunRefused(Exception):
    """A refused skills-run request. `detail` is a string, or a dict that is
    the whole response body (scoresheet violations)."""

    def __init__(self, status_code: int, detail: object) -> None:
        super().__init__(str(detail))
        self.status_code = status_code
        self.detail = detail


class TimerState(NamedTuple):
    phase: str
    deadline: dt.datetime | None
    paused: bool
    remaining: int | None


_READY_STATE = TimerState(READY, None, False, None)


def timer_state(row: SkillsSetTimer | SkillsRun | None, now: dt.datetime | None = None) -> TimerState:
    """A timer as it reads now (a set timer, or a run's own timer). Timers end
    on the server clock: a running timer past its deadline reads as ended,
    computed on read as match phases are. A missing set timer reads as ready."""
    if row is None:
        return _READY_STATE
    if row.phase == RUNNING and row.paused:
        return TimerState(RUNNING, None, True, row.remaining_seconds_at_pause)
    if row.phase == RUNNING and row.deadline is not None:
        left = (row.deadline - (now or utc_now())).total_seconds()
        if left <= 0:
            return TimerState(ENDED, None, False, None)
        return TimerState(RUNNING, row.deadline, False, math.ceil(left))
    return TimerState(row.phase, None, False, None)


def effective_timer(run: SkillsRun, set_timer: SkillsSetTimer | None) -> TimerState:
    """The timer a run is on: the set's while it follows the set, else its own."""
    return timer_state(set_timer if run.follows_set else run)


def _copy_state(row: SkillsSetTimer | SkillsRun, state: TimerState) -> None:
    row.phase = state.phase
    row.deadline = state.deadline
    row.paused = state.paused
    row.remaining_seconds_at_pause = state.remaining if state.paused else None


def require_skills_set(field_set: FieldSet) -> FieldSet:
    if field_set.purpose != SKILLS:
        raise RunRefused(409, NOT_SKILLS_SET)
    return field_set


def skills_set_for_field(db: Session, field: Field) -> FieldSet:
    field_set = db.get(FieldSet, field.field_set_id)
    if field_set is None or field_set.purpose != SKILLS:
        raise RunRefused(409, NOT_SKILLS_FIELD)
    return field_set


def find_set_timer(db: Session, field_set_id: int) -> SkillsSetTimer | None:
    return db.execute(
        select(SkillsSetTimer).where(SkillsSetTimer.field_set_id == field_set_id)
    ).scalars().first()


def run_on_field(db: Session, field_id: int) -> SkillsRun | None:
    return db.execute(select(SkillsRun).where(SkillsRun.field_id == field_id)).scalars().first()


def _run_or_404(db: Session, field_id: int) -> SkillsRun:
    run = run_on_field(db, field_id)
    if run is None:
        raise RunRefused(404, NO_RUN)
    return run


def following_runs(db: Session, field_set_id: int) -> list[SkillsRun]:
    return list(
        db.execute(
            select(SkillsRun).where(SkillsRun.field_set_id == field_set_id, SkillsRun.follows_set.is_(True))
        ).scalars().all()
    )


def set_skills_type(plugin: LoadedPlugin, set_timer: SkillsSetTimer | None) -> str | None:
    """The set's skills type: the one last chosen, else the game's first."""
    if set_timer is not None and set_timer.skills_type:
        return set_timer.skills_type
    types = skills.plugin_types(plugin)
    return types[0]["key"] if types else None


def _run_length(plugin: LoadedPlugin, skills_type: str | None) -> int | None:
    return skills.run_seconds(plugin, skills_type) if skills_type else None


def run_score(plugin: LoadedPlugin, skills_type: str, data: dict[str, Any]) -> int:
    """The score so far; 0 while the plugin can't score the sheet yet."""
    try:
        return int(plugin.module.calculate_skills_score(skills_type, data))
    except Exception:  # noqa: BLE001 - a half-filled sheet just shows 0
        return 0


def item_violations(schema: list[dict[str, Any]], changes: dict[str, Any]) -> list[dict[str, str]]:
    """Each changed item checked alone against the type's scoresheet, with the
    same messages as a submitted skills attempt."""
    by_name = {item["name"]: item for item in schema}
    violations: list[dict[str, str]] = []
    for name, value in changes.items():
        item = by_name.get(name)
        if item is None:
            violations.append({"field": name, "message": "Unknown field."})
            continue
        violations.extend(scoresheet_violations([item], {name: value}))
    return violations


def _start_next_batch(db: Session, field_set_id: int, set_timer: SkillsSetTimer, now: dt.datetime) -> None:
    """The set's timer has ended and a new run is joining it: runs still
    following the set keep their ended timer on their own, and the set timer
    is ready for the next batch."""
    ended = timer_state(set_timer, now)
    for run in following_runs(db, field_set_id):
        _copy_state(run, ended)
        run.follows_set = False
    _copy_state(set_timer, _READY_STATE)


def create_run(
    db: Session, plugin: LoadedPlugin, field: Field, payload: SkillsRunCreate, device_name: str
) -> SkillsRun:
    field_set = skills_set_for_field(db, field)
    session_obj = db.get(TournamentSession, field_set.session_id)
    types = {t["key"]: t for t in skills.plugin_types(plugin)}
    set_timer = ensure_set_timer(db, field_set)
    set_type = set_skills_type(plugin, set_timer)
    skills_type = payload.skills_type or set_type
    if skills_type not in types:
        raise RunRefused(422, f"Unknown skills type: {skills_type!r}")
    team = db.get(Team, payload.team_id)
    if team is None or team.event_id != session_obj.event_id:
        raise RunRefused(422, "Unknown team")
    refusal = skills.attempt_refusal(db, session_obj, team, skills_type, types)
    if refusal is not None:
        raise RunRefused(409, refusal)
    if run_on_field(db, field.id) is not None:
        raise RunRefused(409, FIELD_BUSY)
    follows_set = payload.follows_set
    if follows_set and skills_type != set_type:
        raise RunRefused(409, SET_TYPE_ONLY)
    now = utc_now()
    if follows_set:
        set_phase = timer_state(set_timer, now).phase
        if set_phase == ENDED:
            _start_next_batch(db, field_set.id, set_timer, now)
        elif set_phase == RUNNING:
            # A late team never joins a running set timer partway: it waits on its own.
            follows_set = False
    run = SkillsRun(
        field_id=field.id,
        field_set_id=field_set.id,
        session_id=field_set.session_id,
        team_id=team.id,
        skills_type=skills_type,
        data_json="{}",
        item_meta_json="{}",
        version=0,
        follows_set=follows_set,
        phase=READY,
        deadline=None,
        paused=False,
        remaining_seconds_at_pause=None,
        created_by_device=device_name,
        created_at=now,
    )
    db.add(run)
    try:
        db.commit()
    except IntegrityError:
        # Another request put a run on this field between the check and the insert.
        db.rollback()
        raise RunRefused(409, FIELD_BUSY)
    db.refresh(run)
    return run


def patch_run(
    db: Session, plugin: LoadedPlugin, field: Field, changes: dict[str, Any], device_name: str
) -> SkillsRun:
    """Merges changed items into the run's sheet: each accepted item overwrites
    the stored one (last write wins per item), records who changed it and
    when, and the version goes up by one. Any bad item refuses them all."""
    skills_set_for_field(db, field)
    run = _run_or_404(db, field.id)
    violations = item_violations(plugin.module.skills_scoresheet_schema(run.skills_type), changes)
    if violations:
        raise RunRefused(422, {"detail": SCORESHEET_ERRORS, "violations": violations})
    if not changes:
        return run
    data = json.loads(run.data_json)
    meta = json.loads(run.item_meta_json)
    at = utc_now().isoformat()
    for name, value in changes.items():
        data[name] = value
        meta[name] = {"device_name": device_name, "at": at}
    run.data_json = json.dumps(data)
    run.item_meta_json = json.dumps(meta)
    run.version += 1
    db.commit()
    db.refresh(run)
    return run


def discard_run(db: Session, field: Field) -> None:
    """Throws the field's run away; no attempt is used."""
    skills_set_for_field(db, field)
    db.delete(_run_or_404(db, field.id))
    db.commit()


def _run_read(db: Session, plugin: LoadedPlugin, run: SkillsRun, set_timer: SkillsSetTimer | None) -> SkillsRunRead:
    state = effective_timer(run, set_timer)
    team = db.get(Team, run.team_id)
    data = json.loads(run.data_json)
    return SkillsRunRead(
        id=run.id,
        field_id=run.field_id,
        field_set_id=run.field_set_id,
        team_id=run.team_id,
        team_number=team.number,
        team_name=team.name,
        skills_type=run.skills_type,
        data=data,
        item_meta=json.loads(run.item_meta_json),
        version=run.version,
        score=run_score(plugin, run.skills_type, data),
        follows_set=run.follows_set,
        phase=state.phase,
        deadline=state.deadline,
        paused=state.paused,
        remaining_seconds=state.remaining,
    )


def run_read(db: Session, plugin: LoadedPlugin, run: SkillsRun) -> SkillsRunRead:
    return _run_read(db, plugin, run, find_set_timer(db, run.field_set_id))


def _timer_read(plugin: LoadedPlugin, field_set_id: int, set_timer: SkillsSetTimer | None) -> SkillsSetTimerRead:
    state = timer_state(set_timer)
    skills_type = set_skills_type(plugin, set_timer)
    return SkillsSetTimerRead(
        field_set_id=field_set_id,
        skills_type=skills_type,
        phase=state.phase,
        deadline=state.deadline,
        paused=state.paused,
        remaining_seconds=state.remaining,
        run_seconds=_run_length(plugin, skills_type),
    )


def read_set(db: Session, plugin: LoadedPlugin, field_set: FieldSet) -> SkillsSetRead:
    """The set's timer and each of its fields with its run, for Skills
    Control, the scoring page and displays."""
    require_skills_set(field_set)
    set_timer = ensure_set_timer(db, field_set)
    db.commit()
    runs = {
        run.field_id: run
        for run in db.execute(select(SkillsRun).where(SkillsRun.field_set_id == field_set.id)).scalars().all()
    }
    fields = db.execute(select(Field).where(Field.field_set_id == field_set.id).order_by(Field.id)).scalars().all()
    return SkillsSetRead(
        timer=_timer_read(plugin, field_set.id, set_timer),
        fields=[
            SkillsFieldRead(
                field_id=field.id,
                name=field.name,
                run=_run_read(db, plugin, runs[field.id], set_timer) if field.id in runs else None,
            )
            for field in fields
        ],
    )


def notify(app, field_set_id: int, field_id: int | None = None) -> None:
    """Announces a run or timer change (`skills_run_changed`) and re-sends the
    set's live scores to displays."""
    from tournament_server.services import live_scores  # live_scores imports this module

    data: dict[str, int] = {"field_set_id": field_set_id}
    if field_id is not None:
        data["field_id"] = field_id
    realtime.broadcast_active_session(app, "skills_run_changed", data, roles=RUN_EVENT_ROLES)
    with app.state.session_factory() as db:
        live_scores.on_skills_changed(app, db, field_set_id)
```

- [ ] **Step 6: The skills live-scores hook is already there**

`services/live_scores.on_skills_changed(app, db, field_set_id)` exists as a no-op since Task 2 (Task 7 keeps it); `notify` calls it as is and Task 10 fills it in. Do not add a second definition.

- [ ] **Step 7: Add the routes**

Create `server/src/tournament_server/routers/skills_runs.py`:

```python
"""Skills runs on skills fields, and a skills field set's view (live scoring spec §6)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from tournament_server.auth import require_any_role
from tournament_server.deps import get_db, get_event_or_404, get_optional_game_plugin
from tournament_server.device_auth import require_paired_scoring_device
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.schemas.skills_run import SkillsRunCreate, SkillsRunPatch, SkillsRunRead, SkillsSetRead
from tournament_server.services import skills, skills_runs

router = APIRouter(tags=["skills-runs"])

ADMIN_DEVICE_NAME = "Admin"


def _plugin_or_409(request: Request, db: Session) -> LoadedPlugin:
    event = get_event_or_404(db)
    plugin = get_optional_game_plugin(request, event)
    if plugin is None or not skills.is_enabled(db, event.id):
        raise HTTPException(status_code=409, detail=skills.SKILLS_OFF_DETAIL)
    return plugin


def _field_or_404(db: Session, field_id: int) -> Field:
    field = db.get(Field, field_id)
    if field is None:
        raise HTTPException(status_code=404, detail="Field not found")
    return field


def _field_set_or_404(db: Session, field_set_id: int) -> FieldSet:
    field_set = db.get(FieldSet, field_set_id)
    if field_set is None:
        raise HTTPException(status_code=404, detail="FieldSet not found")
    return field_set


def _refusal(refused: skills_runs.RunRefused) -> JSONResponse:
    content = refused.detail if isinstance(refused.detail, dict) else {"detail": refused.detail}
    return JSONResponse(status_code=refused.status_code, content=content)


@router.post("/api/fields/{field_id}/skills-run", response_model=SkillsRunRead, status_code=201)
def create_skills_run(
    field_id: int,
    payload: SkillsRunCreate,
    request: Request,
    db: Session = Depends(get_db),
    device: str | None = Depends(require_paired_scoring_device),
) -> Any:
    field = _field_or_404(db, field_id)
    plugin = _plugin_or_409(request, db)
    try:
        run = skills_runs.create_run(db, plugin, field, payload, device or ADMIN_DEVICE_NAME)
    except skills_runs.RunRefused as refused:
        return _refusal(refused)
    skills_runs.notify(request.app, run.field_set_id, run.field_id)
    return skills_runs.run_read(db, plugin, run)


@router.patch("/api/fields/{field_id}/skills-run/draft", response_model=SkillsRunRead)
def patch_skills_run(
    field_id: int,
    payload: SkillsRunPatch,
    request: Request,
    db: Session = Depends(get_db),
    device: str | None = Depends(require_paired_scoring_device),
) -> Any:
    field = _field_or_404(db, field_id)
    plugin = _plugin_or_409(request, db)
    try:
        run = skills_runs.patch_run(db, plugin, field, payload.changes, device or ADMIN_DEVICE_NAME)
    except skills_runs.RunRefused as refused:
        return _refusal(refused)
    skills_runs.notify(request.app, run.field_set_id, run.field_id)
    return skills_runs.run_read(db, plugin, run)


@router.delete("/api/fields/{field_id}/skills-run", status_code=204)
def discard_skills_run(
    field_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _device: str | None = Depends(require_paired_scoring_device),
) -> Response:
    field = _field_or_404(db, field_id)
    _plugin_or_409(request, db)
    try:
        skills_runs.discard_run(db, field)
    except skills_runs.RunRefused as refused:
        return _refusal(refused)
    skills_runs.notify(request.app, field.field_set_id, field.id)
    return Response(status_code=204)


@router.get("/api/field-sets/{field_set_id}/skills", response_model=SkillsSetRead)
def read_skills_set(
    field_set_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> Any:
    field_set = _field_set_or_404(db, field_set_id)
    plugin = _plugin_or_409(request, db)
    try:
        return skills_runs.read_set(db, plugin, field_set)
    except skills_runs.RunRefused as refused:
        return _refusal(refused)
```

In `app.py`, add `skills_runs` to the `from tournament_server.routers import (...)` list and register it right after the skills router:

```python
    app.include_router(skills.router)
    app.include_router(skills_runs.router)
```

- [ ] **Step 8: Run the tests**

Run: `cd server && .venv/bin/pytest -q tests/test_skills_runs.py`
Expected: all pass.

- [ ] **Step 9: Run the wider suites**

Run: `cd server && .venv/bin/pytest -q tests/test_skills_attempts.py tests/test_skills_settings.py tests/test_skills_rankings_api.py tests/test_field_set_purpose.py tests/test_fields.py tests/test_field_sets.py tests/test_live_scores.py tests/test_alembic_drift.py`
Expected: all pass (the attempts route keeps its exact 409 details through `attempt_refusal`).

- [ ] **Step 10: Commit**

```bash
git add server/src/tournament_server/schemas/skills_run.py server/src/tournament_server/routers/skills_runs.py \
  server/src/tournament_server/services/skills_runs.py server/src/tournament_server/services/skills.py \
  server/src/tournament_server/routers/skills.py \
  server/src/tournament_server/app.py server/tests/skills_run_helpers.py server/tests/test_skills_runs.py
git commit -m "Add skills runs on skills fields: create a run for a checked-in team with attempts left, merge draft items as they change, discard without using an attempt, and read a skills field set with its timer and each field's run, announcing every change as skills_run_changed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Skills timers, submit and skills live scores

**Files:**
- Modify: `server/src/tournament_server/services/skills_runs.py` (timer actions, set type, submit, breakdown, expiry notice)
- Modify: `server/src/tournament_server/routers/skills_runs.py` (timer, set type and submit routes)
- Modify: `server/src/tournament_server/schemas/skills_run.py` (`SkillsTypeWrite`)
- Modify: `server/src/tournament_server/services/skills.py` (`new_attempt`)
- Modify: `server/src/tournament_server/routers/skills.py` (`create_skills_attempt` uses `new_attempt`; `_numbered_read` becomes `numbered_read`; attempts read `field_id`)
- Modify: `server/src/tournament_server/schemas/skills.py` (`SkillsAttemptRead.field_id`)
- Modify: `server/src/tournament_server/services/live_scores.py` (`skills_live_payloads`, `on_skills_changed`, the skills part of `live_snapshot` and `on_switches_changed`)
- Test: `server/tests/test_skills_timers.py`

**Interfaces:**
- Consumes: Task 9 (everything in its Produces list, plus `skills_run_helpers.py`); Task 3 `skills.run_seconds`; Task 7 `live_snapshot`, `on_switches_changed`, `GET /api/displays/live-scores`; Task 8 `SubmitRequest(force: bool = False)` (`schemas/draft.py`); Task 2 `PATCH /api/sessions/{id}` with `live_scores_qualification`.
- Produces (`services/skills_runs.py`): `TimerAction` (str enum: `start`, `pause`, `resume`, `end`, `reset`); `field_timer_action(db, plugin, field, action) -> SkillsRun`; `set_timer_action(db, plugin, field_set, action) -> SkillsSetTimer`; `set_set_type(db, plugin, field_set, skills_type) -> SkillsSetTimer`; `submit_run(db, plugin, field, *, force) -> SkillsAttempt`; `breakdown(plugin, skills_type, data) -> list[dict]`; `schedule_expiry(app, field_set_id, field_id, deadline)`.
- Produces (`services/skills.py`): `new_attempt(plugin, session_id, team_id, skills_type, data, score, *, field_id=None) -> SkillsAttempt`.
- Produces (`services/live_scores.py`): `skills_live_payloads(db, plugin, field_set_id) -> list[dict]`, `on_skills_changed(app, db, field_set_id)`.
- Produces (routes): `POST /api/fields/{id}/skills-run/{start|pause|resume|end|reset}` → `SkillsRunRead`; `POST /api/field-sets/{id}/skills-timer/{start|pause|resume|end|reset}` → `SkillsSetRead`; `PUT /api/field-sets/{id}/skills-timer` `{skills_type}` → `SkillsSetRead`; `POST /api/fields/{id}/skills-run/submit` `SubmitRequest` → `SkillsAttemptRead` (now with `field_id`). Details: `"No run is following this field set."`, `"Finish or discard this set's runs first."`, `"This skills type has no run length."`, `"The timer has already started; reset it first."`, `"The timer is not running."`, `"The timer is not paused."`.

Plan note: Submit fills every item the scorer never touched with its schema `default`, as the scoresheet form shows it, before `scoresheet_violations` runs. The live sync sends only the items that changed, so an untouched counter left at 0 would otherwise make every submit a 422 "This field is required.". `force` still writes a sheet that fails the check, for example a stored value a newer plugin rejects.

Plan note: Submit claims the run with a `DELETE` as its transaction's first write, then re-counts the team's attempts inside that transaction. SQLite takes the write lock on that first write, so the count sees every attempt already committed, and a second Submit for the same run finds nothing to delete (404 `"This field has no run."`). The test runs the two fields' submits one after the other, which pins the re-check itself.

Plan note: a timer that runs out changes nothing in the database, so nothing would tell displays to switch from the live total to the breakdown. `schedule_expiry` schedules one notice on the realtime loop just after the deadline. The notice only re-sends the current state (`notify`), so a stale one (after a pause, reset or end) is harmless. A server restart drops pending notices; reads still show `ended` and the next change re-sends the breakdown.

Plan note: Task 1 added `SkillsAttempt.field_id`, but no task exposes it, and Task 16 needs it to show an attempt's field. This task adds `field_id` to `SkillsAttemptRead`. It also renames `routers/skills.py`'s `_numbered_read` to `numbered_read`, so that the submit route returns the same numbered attempt read.

Plan note: Task 7's `live_snapshot` returns an empty `skills` list and its `on_switches_changed` covers teamwork matches only. This task puts `skills_live_payloads` into the first and re-sends every skills set of the session from the second, so flipping the switch takes effect for skills at once.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_skills_timers.py`:

```python
from __future__ import annotations

import datetime as dt
import json

import pytest
from sqlalchemy import select

from device_helpers import paired_device
from skills_helpers import admin_token, next_event
from skills_run_helpers import expire, read_set, run_length, run_on, runs_by_field, skills_event, start_run
from tournament_server.db import utc_now
from tournament_server.models.scoring_draft import SkillsRun, SkillsSetTimer
from tournament_server.services import skills as skills_service


@pytest.fixture
def event(client):
    return skills_event(client, attempts={"autonomous": 1, "driver": 2})


def _set_action(client, event, action: str) -> dict:
    response = client.post(f"/api/field-sets/{event['set']['id']}/skills-timer/{action}")
    assert response.status_code == 200, response.text
    return response.json()


def _field_action(client, field_id: int, action: str) -> dict:
    response = client.post(f"/api/fields/{field_id}/skills-run/{action}")
    assert response.status_code == 200, response.text
    return response.json()


def _submit(client, field_id: int, **body):
    return client.post(f"/api/fields/{field_id}/skills-run/submit", json=body)


def _next_live(socket, field_id: int) -> dict:
    """The next live_score for this field, skipping every other message."""
    while True:
        message = socket.receive_json()
        if message["event"] == "live_score" and message["data"].get("field_id") == field_id:
            return message["data"]


def _within(deadline: str, before: dt.datetime, seconds: int) -> bool:
    gap = dt.datetime.fromisoformat(deadline) - before
    return dt.timedelta(seconds=seconds - 1) <= gap <= dt.timedelta(seconds=seconds + 2)


def test_the_set_timer_moves_every_following_run_at_once(client, event):
    first, second = event["set"]["field_ids"]
    start_run(client, first, event["teams"][0])
    start_run(client, second, event["teams"][1])
    before = utc_now()
    started = _set_action(client, event, "start")
    assert started["timer"]["phase"] == "running"
    assert _within(started["timer"]["deadline"], before, run_length(client, "autonomous"))
    for run in runs_by_field(started).values():
        assert (run["phase"], run["paused"], run["follows_set"]) == ("running", False, True)
        assert run["deadline"] == started["timer"]["deadline"]
    paused = _set_action(client, event, "pause")
    assert (paused["timer"]["paused"], paused["timer"]["deadline"]) == (True, None)
    assert paused["timer"]["remaining_seconds"] > 0
    for run in runs_by_field(paused).values():
        assert run["paused"] and run["remaining_seconds"] == paused["timer"]["remaining_seconds"]
    resumed = _set_action(client, event, "resume")
    assert all(run["phase"] == "running" and not run["paused"] for run in runs_by_field(resumed).values())
    ended = _set_action(client, event, "end")
    assert ended["timer"]["phase"] == "ended"
    assert {run["phase"] for run in runs_by_field(ended).values()} == {"ended"}
    reset = _set_action(client, event, "reset")
    assert reset["timer"]["phase"] == "ready"
    assert {run["phase"] for run in runs_by_field(reset).values()} == {"ready"}


def test_the_set_timer_needs_a_following_run_to_start(client, event):
    set_url = f"/api/field-sets/{event['set']['id']}/skills-timer"
    refused = client.post(f"{set_url}/start")
    assert (refused.status_code, refused.json()["detail"]) == (409, "No run is following this field set.")
    start_run(client, event["set"]["field_ids"][0], event["teams"][0], skills_type="driver", follows_set=False)
    assert client.post(f"{set_url}/start").json()["detail"] == "No run is following this field set."
    not_running = client.post(f"{set_url}/pause")
    assert (not_running.status_code, not_running.json()["detail"]) == (409, "The timer is not running.")
    assert client.post(f"{set_url}/jump").status_code == 422


def test_a_field_timer_action_takes_the_field_off_the_set_timer(client, event):
    first, second = event["set"]["field_ids"]
    start_run(client, first, event["teams"][0])
    start_run(client, second, event["teams"][1])
    _set_action(client, event, "start")
    alone = _field_action(client, first, "pause")
    assert (alone["follows_set"], alone["phase"], alone["paused"]) == (False, "running", True)
    assert alone["remaining_seconds"] > 0
    runs = runs_by_field(_set_action(client, event, "pause"))
    assert (runs[second]["follows_set"], runs[second]["paused"]) == (True, True)
    runs = runs_by_field(_set_action(client, event, "resume"))
    assert runs[first]["paused"] is True
    assert runs[second]["paused"] is False
    own = _field_action(client, first, "resume")
    assert (own["phase"], own["paused"]) == ("running", False)
    runs = runs_by_field(_set_action(client, event, "end"))
    assert (runs[first]["phase"], runs[second]["phase"]) == ("running", "ended")


def test_a_field_on_its_own_timer_runs_its_own_type(client, event):
    field_id = event["set"]["field_ids"][0]
    start_run(client, field_id, event["teams"][0], skills_type="driver", follows_set=False)
    before = utc_now()
    started = _field_action(client, field_id, "start")
    assert (started["phase"], started["skills_type"]) == ("running", "driver")
    assert _within(started["deadline"], before, run_length(client, "driver"))
    assert read_set(client, event["set"]["id"])["timer"]["phase"] == "ready"
    again = client.post(f"/api/fields/{field_id}/skills-run/start")
    assert (again.status_code, again.json()["detail"]) == (409, "The timer has already started; reset it first.")
    assert _field_action(client, field_id, "end")["phase"] == "ended"
    assert _field_action(client, field_id, "reset")["phase"] == "ready"
    no_run = client.post(f"/api/fields/{event['set']['field_ids'][1]}/skills-run/start")
    assert (no_run.status_code, no_run.json()["detail"]) == (404, "This field has no run.")


def test_the_set_type_changes_only_while_the_set_has_no_runs(client, event):
    field_id = event["set"]["field_ids"][0]
    url = f"/api/field-sets/{event['set']['id']}/skills-timer"
    start_run(client, field_id, event["teams"][0])
    refused = client.put(url, json={"skills_type": "driver"})
    assert (refused.status_code, refused.json()["detail"]) == (409, "Finish or discard this set's runs first.")
    assert client.delete(f"/api/fields/{field_id}/skills-run").status_code == 204
    changed = client.put(url, json={"skills_type": "driver"})
    assert changed.status_code == 200, changed.text
    timer = changed.json()["timer"]
    assert (timer["skills_type"], timer["run_seconds"], timer["phase"]) == ("driver", run_length(client, "driver"), "ready")
    assert start_run(client, field_id, event["teams"][0])["skills_type"] == "driver"
    assert client.put(url, json={"skills_type": "teleop"}).status_code == 422


def test_a_timer_past_its_deadline_reads_as_ended(client, event):
    first, second = event["set"]["field_ids"]
    start_run(client, first, event["teams"][0])
    start_run(client, second, event["teams"][1], skills_type="driver", follows_set=False)
    _set_action(client, event, "start")
    _field_action(client, second, "start")
    expire(client, SkillsSetTimer, field_set_id=event["set"]["id"])
    expire(client, SkillsRun, field_id=second)
    body = read_set(client, event["set"]["id"])
    assert (body["timer"]["phase"], body["timer"]["deadline"], body["timer"]["remaining_seconds"]) == ("ended", None, None)
    assert {run["phase"] for run in runs_by_field(body).values()} == {"ended"}
    refused = client.post(f"/api/fields/{second}/skills-run/pause")
    assert (refused.status_code, refused.json()["detail"]) == (409, "The timer is not running.")


def test_a_new_run_after_the_set_ended_starts_the_next_batch(client, event):
    first, second = event["set"]["field_ids"]
    start_run(client, first, event["teams"][0])
    _set_action(client, event, "start")
    _set_action(client, event, "end")
    start_run(client, second, event["teams"][1])
    body = read_set(client, event["set"]["id"])
    runs = runs_by_field(body)
    assert (runs[first]["follows_set"], runs[first]["phase"]) == (False, "ended")
    assert (runs[second]["follows_set"], runs[second]["phase"]) == (True, "ready")
    assert body["timer"]["phase"] == "ready"


def test_a_run_created_while_the_set_runs_waits_on_its_own_timer(client, event):
    first, second = event["set"]["field_ids"]
    start_run(client, first, event["teams"][0])
    _set_action(client, event, "start")
    late = start_run(client, second, event["teams"][1])
    assert (late["follows_set"], late["phase"], late["skills_type"]) == (False, "ready", "autonomous")


def test_submit_writes_the_attempt_with_its_field_and_ends_the_run(client, event):
    field_id = event["set"]["field_ids"][0]
    team_1 = event["teams"][0]
    start_run(client, field_id, team_1)
    client.patch(f"/api/fields/{field_id}/skills-run/draft", json={"changes": {"objects_scored": 5}})
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        submitted = _submit(client, field_id)
        assert submitted.status_code == 200, submitted.text
        attempt = submitted.json()
        assert (attempt["team_id"], attempt["skills_type"], attempt["number"]) == (team_1, "autonomous", 1)
        assert (attempt["score"], attempt["field_id"]) == (10, field_id)
        assert attempt["data"] == {"objects_scored": 5, "parked": False}
        assert next_event(socket, "skills_changed")["data"] == {"session_id": event["session_id"]}
        assert next_event(socket, "skills_run_changed")["data"] == {"field_set_id": event["set"]["id"], "field_id": field_id}
    assert run_on(client, event["set"]["id"], field_id) is None
    listed = client.get(f"/api/sessions/{event['session_id']}/skills/attempts").json()
    assert [(a["team_id"], a["field_id"]) for a in listed] == [(team_1, field_id)]
    again = _submit(client, field_id)
    assert (again.status_code, again.json()["detail"]) == (404, "This field has no run.")


def test_submit_rechecks_the_attempt_limit(client, event):
    first, second = event["set"]["field_ids"]
    team_1 = event["teams"][0]
    # Autonomous allows one attempt; both runs were allowed when created.
    start_run(client, first, team_1)
    start_run(client, second, team_1)
    assert _submit(client, first).status_code == 200
    refused = _submit(client, second)
    assert (refused.status_code, refused.json()["detail"]) == (409, "Team 1 has used all 1 Autonomous attempts.")
    assert run_on(client, event["set"]["id"], second) is not None
    assert len(client.get(f"/api/sessions/{event['session_id']}/skills/attempts").json()) == 1
    assert client.delete(f"/api/fields/{second}/skills-run").status_code == 204


def test_submit_checks_the_scoresheet_unless_forced(client, event):
    field_id = event["set"]["field_ids"][0]
    start_run(client, field_id, event["teams"][0])
    with client.app.state.session_factory() as db:
        run = db.execute(select(SkillsRun)).scalars().one()
        run.data_json = json.dumps({"objects_scored": 31, "parked": False})
        db.commit()
    refused = _submit(client, field_id)
    assert refused.status_code == 422
    assert refused.json()["violations"] == [{"field": "objects_scored", "message": "Must be at most 30."}]
    forced = _submit(client, field_id, force=True)
    assert (forced.status_code, forced.json()["score"]) == (200, 62)


def test_skills_live_scores_follow_the_timer_and_the_switch(client, event):
    first = event["set"]["field_ids"][0]
    start_run(client, first, event["teams"][0])
    draft = f"/api/fields/{first}/skills-run/draft"
    snapshot = f"/api/displays/live-scores?field_set_id={event['set']['id']}"
    assert client.get(snapshot).json()["skills"] == []
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        _set_action(client, event, "start")
        assert _next_live(socket, first) == {"field_id": first, "score": 0}
        client.patch(draft, json={"changes": {"objects_scored": 3}})
        assert _next_live(socket, first) == {"field_id": first, "score": 6}
        assert client.get(snapshot).json()["skills"] == [{"field_id": first, "score": 6}]
        switched = client.patch(f"/api/sessions/{event['session_id']}", json={"live_scores_qualification": False})
        assert switched.status_code == 200, switched.text
        assert _next_live(socket, first) == {"field_id": first, "cleared": True}
        client.patch(draft, json={"changes": {"objects_scored": 4}})
        assert _next_live(socket, first) == {"field_id": first, "cleared": True}
        assert client.get(snapshot).json()["skills"] == []
        _set_action(client, event, "end")
        breakdown = {
            "field_id": first,
            "breakdown": [{"label": "Objects Scored", "value": 4}, {"label": "Robot Parked", "value": None}],
            "score": 8,
        }
        assert _next_live(socket, first) == breakdown
        assert client.get(snapshot).json()["skills"] == [breakdown]
        assert _submit(client, first).status_code == 200
        assert _next_live(socket, first) == {"field_id": first, "cleared": True}
    assert client.get(snapshot).json()["skills"] == []


def test_the_breakdown_goes_out_when_the_timer_runs_out(client, event, monkeypatch):
    monkeypatch.setattr(skills_service, "run_seconds", lambda plugin, skills_type: 1)
    field_id = event["set"]["field_ids"][0]
    start_run(client, field_id, event["teams"][0])
    client.patch(f"/api/fields/{field_id}/skills-run/draft", json={"changes": {"objects_scored": 2}})
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        _set_action(client, event, "start")
        assert _next_live(socket, field_id) == {"field_id": field_id, "score": 4}
        expired = _next_live(socket, field_id)
        assert expired["breakdown"][0] == {"label": "Objects Scored", "value": 2}
        assert expired["score"] == 4
    assert read_set(client, event["set"]["id"])["timer"]["phase"] == "ended"


def test_timer_routes_refuse_teamwork_fields_and_sets_and_other_roles(client, event):
    teamwork = event["teamwork"]
    field_id = teamwork["field_ids"][0]
    for response in (
        client.post(f"/api/fields/{field_id}/skills-run/start"),
        _submit(client, field_id),
    ):
        assert (response.status_code, response.json()["detail"]) == (409, "This is not a skills field.")
    for response in (
        client.post(f"/api/field-sets/{teamwork['id']}/skills-timer/start"),
        client.put(f"/api/field-sets/{teamwork['id']}/skills-timer", json={"skills_type": "driver"}),
    ):
        assert (response.status_code, response.json()["detail"]) == (409, "This is not a skills field set.")
    judge = paired_device(client, role="judge")
    skills_set = event["set"]["id"]
    assert client.post(f"/api/field-sets/{skills_set}/skills-timer/start", headers=judge["headers"]).status_code == 403
    scorer = paired_device(client, role="scorer")
    start_run(client, event["set"]["field_ids"][0], event["teams"][0], headers=scorer["headers"])
    started = client.post(f"/api/field-sets/{skills_set}/skills-timer/start", headers=scorer["headers"])
    assert started.status_code == 200, started.text
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && .venv/bin/pytest -q tests/test_skills_timers.py`
Expected: FAIL. The timer, type and submit routes don't exist: POSTs to `/skills-timer/...` and `/skills-run/start` give `404 Not Found`, and `/skills-run/submit` gives 404 or 405.

- [ ] **Step 3: Write attempts through one helper and expose their field**

In `services/skills.py` add `import json` and `from tournament_server.db import utc_now` to the imports, and add after `attempt_refusal`:

```python
def new_attempt(
    plugin: LoadedPlugin,
    session_id: int,
    team_id: int,
    skills_type: str,
    data: dict,
    score: int,
    *,
    field_id: int | None = None,
) -> SkillsAttempt:
    """A recorded attempt, not yet added to the session. `field_id` is set when
    it comes from a skills run on that field."""
    now = utc_now()
    return SkillsAttempt(
        session_id=session_id,
        team_id=team_id,
        skills_type=skills_type,
        data_json=json.dumps(data),
        score=score,
        plugin_name=plugin.name,
        plugin_version=plugin.version,
        field_id=field_id,
        recorded_at=now,
        updated_at=now,
    )
```

In `routers/skills.py`'s `create_skills_attempt`, replace

```python
    score = _score(plugin, payload.skills_type, payload.data)
    now = utc_now()
    attempt = SkillsAttempt(
        session_id=session_id,
        team_id=team.id,
        skills_type=payload.skills_type,
        data_json=json.dumps(payload.data),
        score=score,
        plugin_name=plugin.name,
        plugin_version=plugin.version,
        recorded_at=now,
        updated_at=now,
    )
    db.add(attempt)
```

with

```python
    score = _score(plugin, payload.skills_type, payload.data)
    attempt = skills.new_attempt(plugin, session_id, team.id, payload.skills_type, payload.data, score)
    db.add(attempt)
```

Rename `_numbered_read` to `numbered_read`: its definition and its two call sites, in `create_skills_attempt` and `update_skills_attempt`. `_attempt_read` stays private. In `_attempt_read` add `field_id=attempt.field_id,` after `skills_type=attempt.skills_type,`. `utc_now` is still used by `update_skills_attempt`, so keep its import.

In `schemas/skills.py`, `SkillsAttemptRead` gains, after `skills_type: str`:

```python
    # The skills field the attempt was run on; None when entered directly.
    field_id: int | None = None
```

- [ ] **Step 4: Add timers, the set type, submit and the expiry notice to the service**

In `services/skills_runs.py` add to the imports:

```python
import asyncio
import enum
import logging

from sqlalchemy import delete

from tournament_server.models.skills import SkillsAttempt
```

and append:

```python
logger = logging.getLogger(__name__)

NO_RUN_LENGTH = "This skills type has no run length."
NO_FOLLOWING_RUN = "No run is following this field set."
RUNS_EXIST = "Finish or discard this set's runs first."
TIMER_NOT_READY = "The timer has already started; reset it first."
TIMER_NOT_RUNNING = "The timer is not running."
TIMER_NOT_PAUSED = "The timer is not paused."
EXPIRY_GRACE_SECONDS = 0.05


class TimerAction(str, enum.Enum):
    START = "start"
    PAUSE = "pause"
    RESUME = "resume"
    END = "end"
    RESET = "reset"


def _apply_action(row: SkillsSetTimer | SkillsRun, action: str, length: int | None, now: dt.datetime) -> None:
    """One timer control on a set timer or a run's own timer, like the match
    clock: start from ready (deadline = now + the type's run length), pause and
    resume a running timer, end it, or reset it to ready from anywhere."""
    state = timer_state(row, now)
    if action == TimerAction.START:
        if state.phase != READY:
            raise RunRefused(409, TIMER_NOT_READY)
        if length is None:
            raise RunRefused(409, NO_RUN_LENGTH)
        _copy_state(row, TimerState(RUNNING, now + dt.timedelta(seconds=length), False, None))
    elif action == TimerAction.PAUSE:
        if state.phase != RUNNING or state.paused:
            raise RunRefused(409, TIMER_NOT_RUNNING)
        _copy_state(row, TimerState(RUNNING, None, True, state.remaining))
    elif action == TimerAction.RESUME:
        if state.phase != RUNNING or not state.paused:
            raise RunRefused(409, TIMER_NOT_PAUSED)
        _copy_state(row, TimerState(RUNNING, now + dt.timedelta(seconds=state.remaining), False, None))
    elif action == TimerAction.END:
        if state.phase != RUNNING:
            raise RunRefused(409, TIMER_NOT_RUNNING)
        _copy_state(row, TimerState(ENDED, None, False, None))
    else:
        _copy_state(row, _READY_STATE)


def field_timer_action(db: Session, plugin: LoadedPlugin, field: Field, action: str) -> SkillsRun:
    """A control on the field's own timer. The first one takes the run off the
    set timer, starting from the set timer's current state; from then on only
    this field's controls move it, and its length is its own type's."""
    field_set = skills_set_for_field(db, field)
    run = _run_or_404(db, field.id)
    now = utc_now()
    if run.follows_set:
        _copy_state(run, timer_state(find_set_timer(db, field_set.id), now))
        run.follows_set = False
    _apply_action(run, action, _run_length(plugin, run.skills_type), now)
    db.commit()
    db.refresh(run)
    return run


def set_timer_action(db: Session, plugin: LoadedPlugin, field_set: FieldSet, action: str) -> SkillsSetTimer:
    """A control on the set timer, which every run following the set reads."""
    require_skills_set(field_set)
    set_timer = ensure_set_timer(db, field_set)
    if action == TimerAction.START and not following_runs(db, field_set.id):
        raise RunRefused(409, NO_FOLLOWING_RUN)
    _apply_action(set_timer, action, _run_length(plugin, set_skills_type(plugin, set_timer)), utc_now())
    db.commit()
    return set_timer


def set_set_type(db: Session, plugin: LoadedPlugin, field_set: FieldSet, skills_type: str) -> SkillsSetTimer:
    """Changes the set's skills type, only while the set has no run at all."""
    require_skills_set(field_set)
    if skills_type not in [t["key"] for t in skills.plugin_types(plugin)]:
        raise RunRefused(422, f"Unknown skills type: {skills_type!r}")
    if db.execute(select(SkillsRun.id).where(SkillsRun.field_set_id == field_set.id).limit(1)).first() is not None:
        raise RunRefused(409, RUNS_EXIST)
    set_timer = ensure_set_timer(db, field_set)
    set_timer.skills_type = skills_type
    _copy_state(set_timer, _READY_STATE)
    db.commit()
    return set_timer


def submit_run(db: Session, plugin: LoadedPlugin, field: Field, *, force: bool) -> SkillsAttempt:
    """Turns the field's run into a recorded attempt (with the field's id) and
    deletes the run, re-checking the team's attempt limit inside the write."""
    skills_set_for_field(db, field)
    run = _run_or_404(db, field.id)
    run_id, session_id, team_id, skills_type = run.id, run.session_id, run.team_id, run.skills_type
    schema = plugin.module.skills_scoresheet_schema(skills_type)
    # Items nobody touched count at their default, as the scoresheet shows them.
    data = {**{item["name"]: item["default"] for item in schema}, **json.loads(run.data_json)}
    violations = scoresheet_violations(schema, data)
    if violations and not force:
        raise RunRefused(422, {"detail": SCORESHEET_ERRORS, "violations": violations})
    try:
        score = int(plugin.module.calculate_skills_score(skills_type, data))
    except Exception as exc:  # noqa: BLE001 - a plugin bug becomes a readable 422, not a 500
        raise RunRefused(422, f"Plugin could not score this scoresheet: {exc}")
    session_obj = db.get(TournamentSession, session_id)
    team = db.get(Team, team_id)
    types = {t["key"]: t for t in skills.plugin_types(plugin)}
    # Claim the run first. The delete is this transaction's first write, so
    # SQLite serialises two submits here, and the count below sees every
    # attempt already committed (two fields racing one team's last attempt).
    if db.execute(delete(SkillsRun).where(SkillsRun.id == run_id)).rowcount == 0:
        db.rollback()
        raise RunRefused(404, NO_RUN)
    refusal = skills.attempt_refusal(db, session_obj, team, skills_type, types)
    if refusal is not None:
        db.rollback()
        raise RunRefused(409, refusal)
    attempt = skills.new_attempt(plugin, session_id, team_id, skills_type, data, score, field_id=field.id)
    db.add(attempt)
    db.commit()
    db.refresh(attempt)
    return attempt


def breakdown(plugin: LoadedPlugin, skills_type: str, data: dict[str, Any]) -> list[dict[str, Any]]:
    """Each scoresheet item's label and value (None until entered), in schema order."""
    return [
        {"label": item["label"], "value": data.get(item["name"])}
        for item in plugin.module.skills_scoresheet_schema(skills_type)
    ]


def _log_expiry_failure(future) -> None:
    if future.cancelled():
        return
    error = future.exception()
    if error is not None:
        logger.error("Skills timer expiry notice failed", exc_info=error)


def schedule_expiry(app, field_set_id: int, field_id: int | None, deadline: dt.datetime | None) -> None:
    """Announces the set or run again just after `deadline`, so displays switch
    to the breakdown when a timer runs out. A stale notice (the timer was
    paused, reset or ended meanwhile) only repeats the current state."""
    loop = app.state.realtime.event_loop
    if loop is None or deadline is None:
        return
    delay = max(0.0, (deadline - utc_now()).total_seconds()) + EXPIRY_GRACE_SECONDS

    async def _announce() -> None:
        await asyncio.sleep(delay)
        notify(app, field_set_id, field_id)

    asyncio.run_coroutine_threadsafe(_announce(), loop).add_done_callback(_log_expiry_failure)
```

- [ ] **Step 5: Add the schema and the routes**

Append to `schemas/skills_run.py`:

```python
class SkillsTypeWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    skills_type: str
```

In `routers/skills_runs.py` extend the imports:

```python
from tournament_server.realtime import broadcast_active_session, broadcast_session
from tournament_server.routers.skills import numbered_read
from tournament_server.schemas.draft import SubmitRequest
from tournament_server.schemas.skills import SkillsAttemptRead
from tournament_server.schemas.skills_run import (
    SkillsRunCreate,
    SkillsRunPatch,
    SkillsRunRead,
    SkillsSetRead,
    SkillsTypeWrite,
)
```

and append (the submit route must be registered before the `{action}` route):

```python
@router.post("/api/fields/{field_id}/skills-run/submit", response_model=SkillsAttemptRead)
def submit_skills_run(
    field_id: int,
    payload: SubmitRequest,
    request: Request,
    db: Session = Depends(get_db),
    _device: str | None = Depends(require_paired_scoring_device),
) -> Any:
    field = _field_or_404(db, field_id)
    plugin = _plugin_or_409(request, db)
    try:
        attempt = skills_runs.submit_run(db, plugin, field, force=payload.force)
    except skills_runs.RunRefused as refused:
        return _refusal(refused)
    data = {"session_id": attempt.session_id}
    broadcast_session(request.app, attempt.session_id, "skills_changed", data)
    broadcast_active_session(request.app, "skills_changed", data)
    skills_runs.notify(request.app, field.field_set_id, field.id)
    return numbered_read(db, attempt)


@router.post("/api/fields/{field_id}/skills-run/{action}", response_model=SkillsRunRead)
def field_timer(
    field_id: int,
    action: skills_runs.TimerAction,
    request: Request,
    db: Session = Depends(get_db),
    _device: str | None = Depends(require_paired_scoring_device),
) -> Any:
    field = _field_or_404(db, field_id)
    plugin = _plugin_or_409(request, db)
    try:
        run = skills_runs.field_timer_action(db, plugin, field, action.value)
    except skills_runs.RunRefused as refused:
        return _refusal(refused)
    skills_runs.schedule_expiry(request.app, run.field_set_id, run.field_id, run.deadline)
    skills_runs.notify(request.app, run.field_set_id, run.field_id)
    return skills_runs.run_read(db, plugin, run)


@router.post("/api/field-sets/{field_set_id}/skills-timer/{action}", response_model=SkillsSetRead)
def set_timer(
    field_set_id: int,
    action: skills_runs.TimerAction,
    request: Request,
    db: Session = Depends(get_db),
    _device: str | None = Depends(require_paired_scoring_device),
) -> Any:
    field_set = _field_set_or_404(db, field_set_id)
    plugin = _plugin_or_409(request, db)
    try:
        timer = skills_runs.set_timer_action(db, plugin, field_set, action.value)
    except skills_runs.RunRefused as refused:
        return _refusal(refused)
    skills_runs.schedule_expiry(request.app, field_set_id, None, timer.deadline)
    skills_runs.notify(request.app, field_set_id)
    return skills_runs.read_set(db, plugin, field_set)


@router.put("/api/field-sets/{field_set_id}/skills-timer", response_model=SkillsSetRead)
def set_skills_type(
    field_set_id: int,
    payload: SkillsTypeWrite,
    request: Request,
    db: Session = Depends(get_db),
    _device: str | None = Depends(require_paired_scoring_device),
) -> Any:
    field_set = _field_set_or_404(db, field_set_id)
    plugin = _plugin_or_409(request, db)
    try:
        skills_runs.set_set_type(db, plugin, field_set, payload.skills_type)
    except skills_runs.RunRefused as refused:
        return _refusal(refused)
    skills_runs.notify(request.app, field_set_id)
    return skills_runs.read_set(db, plugin, field_set)
```

- [ ] **Step 6: Send skills live scores**

In `services/live_scores.py` add these imports if they aren't there yet:

```python
import json

from sqlalchemy import select

from tournament_server import realtime
from tournament_server.deps import get_the_event
from tournament_server.models.field_set import SKILLS, FieldSet
from tournament_server.models.scoring_draft import SkillsRun
from tournament_server.models.session import TournamentSession
from tournament_server.services import displays, skills_runs
```

Replace the no-op `on_skills_changed` (Task 2's, kept by Task 7) with:

```python
_SKILLS_LIVE_ROLES = ("display_device", "admin")


def skills_live_payloads(db, plugin, field_set_id: int) -> list[dict]:
    """What displays may show for a skills set's fields (spec §7): a run's live
    total while its timer runs and the session's live_scores_qualification
    switch is on; once its timer has ended, the breakdown and total whatever
    the switch, until it is submitted or discarded."""
    field_set = db.get(FieldSet, field_set_id)
    if plugin is None or field_set is None or field_set.purpose != SKILLS:
        return []
    session_obj = db.get(TournamentSession, field_set.session_id)
    set_timer = skills_runs.find_set_timer(db, field_set_id)
    payloads = []
    for run in db.execute(
        select(SkillsRun).where(SkillsRun.field_set_id == field_set_id).order_by(SkillsRun.field_id)
    ).scalars().all():
        phase = skills_runs.effective_timer(run, set_timer).phase
        data = json.loads(run.data_json)
        score = skills_runs.run_score(plugin, run.skills_type, data)
        if phase == skills_runs.ENDED:
            payloads.append(
                {"field_id": run.field_id, "breakdown": skills_runs.breakdown(plugin, run.skills_type, data), "score": score}
            )
        elif phase == skills_runs.RUNNING and session_obj.live_scores_qualification:
            payloads.append({"field_id": run.field_id, "score": score})
    return payloads


def _event_plugin(app, db):
    event = get_the_event(db)
    if event is None or event.game_plugin_name is None:
        return None
    return app.state.game_plugins.get(event.game_plugin_name)


def on_skills_changed(app, db, field_set_id: int) -> None:
    """A skills set's runs or timer changed: every field of the set gets its
    payload, or `cleared` when nothing may be shown."""
    shown = {payload["field_id"]: payload for payload in skills_live_payloads(db, _event_plugin(app, db), field_set_id)}
    for field_id in displays.field_ids_for_set(db, field_set_id):
        realtime.broadcast_active_session(
            app, "live_score", shown.get(field_id, {"field_id": field_id, "cleared": True}), roles=_SKILLS_LIVE_ROLES
        )
```

In `live_snapshot`, replace the final `return {"matches": matches, "skills": []}` with the following, so a call without `field_set_id` (Task 7: "None: every field") covers every skills set of the active session:

```python
    if field_set_id is not None:
        skills_sets = [field_set_id]
    else:
        skills_sets = db.execute(
            select(FieldSet.id)
            .where(FieldSet.session_id == event.active_session_id, FieldSet.purpose == SKILLS)
            .order_by(FieldSet.id)
        ).scalars().all()
    skills = [payload for set_id in skills_sets for payload in skills_live_payloads(db, plugin, set_id)]
    return {"matches": matches, "skills": skills}
```

At the end of `on_switches_changed`, add:

```python
    for skills_set_id in db.execute(
        select(FieldSet.id).where(FieldSet.session_id == session_id, FieldSet.purpose == SKILLS)
    ).scalars().all():
        on_skills_changed(app, db, skills_set_id)
```

- [ ] **Step 7: Run the tests**

Run: `cd server && .venv/bin/pytest -q tests/test_skills_timers.py tests/test_skills_runs.py`
Expected: all pass.

- [ ] **Step 8: Run the wider suites**

Run: `cd server && .venv/bin/pytest -q tests/test_skills_attempts.py tests/test_skills_settings.py tests/test_skills_rankings_api.py tests/test_live_scores.py tests/test_session_live_switches.py tests/test_broadcast_wiring.py tests/test_alembic_drift.py`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add server/src/tournament_server/services/skills_runs.py server/src/tournament_server/routers/skills_runs.py \
  server/src/tournament_server/schemas/skills_run.py server/src/tournament_server/services/skills.py \
  server/src/tournament_server/routers/skills.py server/src/tournament_server/schemas/skills.py \
  server/src/tournament_server/services/live_scores.py server/tests/test_skills_timers.py
git commit -m "Run skills timers on a skills field set or on one field, change a set's skills type while it has no runs, submit a run as an attempt that records its field after re-checking the team's attempt limit, and send displays each skills field's live total while its timer runs and its breakdown once the timer ends.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Scorer bindings

**Files:**
- Create: `server/src/tournament_server/services/scorer_bindings.py`
- Create: `server/src/tournament_server/routers/bindings.py`
- Modify: `server/src/tournament_server/schemas/device.py` (`BindingRead`, `BindingWrite`, `DeviceRead.binding`)
- Modify: `server/src/tournament_server/routers/devices.py` (`to_device_read`, role change, delete)
- Modify: `server/src/tournament_server/routers/fields.py` (`delete_field`)
- Modify: `server/src/tournament_server/routers/field_sets.py` (`delete_field_set`)
- Modify: `server/src/tournament_server/routers/sessions.py` (`remove_session`)
- Modify: `server/src/tournament_server/app.py`
- Test: `server/tests/test_scorer_bindings.py`

**Interfaces:**
- Consumes: Task 1 `ScorerBinding` (`models/scoring_draft.py`); Task 4 `realtime.send_to_devices_and_admins(app, device_ids, event, data)`.
- Produces (`services/scorer_bindings.py`): `ACTIVE_FIELD_DETAIL = "Pick a field in the active session."`; `BindingRefused`; `find_binding(db, device_id)`, `binding_read(db, device_id) -> {"field_id", "field_name"} | None` (active session); `set_binding(db, device_id, field_id)`; `clear_binding(db, device_id) -> bool`; `clear_for_fields(db, field_ids) -> list[int]`, `clear_for_session(db, session_id) -> list[int]`, `clear_for_device(db, device_id) -> list[int]` (no commit; return the affected device ids); `notify(app, device_ids)`.
- Produces (routes): `GET /api/devices/me/binding` → `{field_id, field_name} | null`; `PUT /api/devices/me/binding` `{field_id}` → `{field_id, field_name}` (422 `"Pick a field in the active session."`); `DELETE /api/devices/me/binding` (204); `DELETE /api/devices/{id}/binding` (admin, 204, 404 unknown device). The `me` routes are for paired scorer and referee devices only: anything else gets 403 `"Only a paired scorer or referee device can be bound to a field."`.
- Produces: `DeviceRead.binding: BindingRead | None` (scorer and referee devices, active session).
- Every change, including a field, field set or session delete that clears bindings, sends `scorer_binding_changed {device_id}` to admins and that device.

Plan note: the spec gives `GET /api/devices/me/binding` as `{field_id} | null`. This task returns `{field_id, field_name}` (the same `BindingRead` that `DeviceRead.binding` uses), so the tablet can label its binding without another read.

Plan note: the spec only requires clearing bindings when a field is deleted. This task also clears them, and tells the devices, when a field set or session is deleted, through the same helper. The rows would go anyway with the foreign-key cascade, but the devices would not be told. A device whose role changes away from scorer or referee also loses its bindings. Its sockets are already closed with 4403 then, so no event is sent. A binding in a session that is no longer active is kept, but is no longer read or shown, because every read is scoped to the active session.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_scorer_bindings.py`:

```python
from __future__ import annotations

import pytest
from sqlalchemy import select

from device_helpers import paired_device
from display_helpers import add_field_set, admin_token, setup_event
from skills_helpers import next_event
from tournament_server.models.scoring_draft import ScorerBinding


@pytest.fixture
def event(client):
    session_id = setup_event(client)
    fields = add_field_set(client, session_id)
    other_session = client.post("/api/sessions", json={"label": "Sunday"}).json()["id"]
    other = add_field_set(client, other_session, fields=("Field 9",))
    return {
        "session_id": session_id,
        "fields": fields,
        "other_session": other_session,
        "other": other,
        "scorer": paired_device(client, role="scorer", name="Scorer A"),
    }


def _bind(client, device: dict, field_id: int):
    return client.put("/api/devices/me/binding", json={"field_id": field_id}, headers=device["headers"])


def _binding(client, device: dict):
    response = client.get("/api/devices/me/binding", headers=device["headers"])
    assert response.status_code == 200, response.text
    return response.json()


def _binding_rows(client) -> list[ScorerBinding]:
    with client.app.state.session_factory() as db:
        return list(db.execute(select(ScorerBinding)).scalars().all())


def _events_until(socket, marker: str) -> list[str]:
    """The names of the events received before the next `marker` event."""
    names = []
    while True:
        message = socket.receive_json()
        if message["event"] == marker:
            return names
        names.append(message["event"])


def test_a_scorer_binds_rebinds_and_clears_its_field(client, event):
    scorer = event["scorer"]
    first, second = event["fields"]["field_ids"]
    assert _binding(client, scorer) is None
    bound = _bind(client, scorer, first)
    assert (bound.status_code, bound.json()) == (200, {"field_id": first, "field_name": "Field 1"})
    assert _binding(client, scorer) == {"field_id": first, "field_name": "Field 1"}
    assert _bind(client, scorer, second).json() == {"field_id": second, "field_name": "Field 2"}
    assert [(row.device_id, row.field_id) for row in _binding_rows(client)] == [(scorer["id"], second)]
    assert client.delete("/api/devices/me/binding", headers=scorer["headers"]).status_code == 204
    assert _binding(client, scorer) is None
    assert client.delete("/api/devices/me/binding", headers=scorer["headers"]).status_code == 204


def test_only_a_field_in_the_active_session_can_be_bound(client, event):
    scorer = event["scorer"]
    other_field = event["other"]["field_ids"][0]
    for field_id in (other_field, 999):
        refused = _bind(client, scorer, field_id)
        assert (refused.status_code, refused.json()["detail"]) == (422, "Pick a field in the active session.")
    assert _bind(client, scorer, event["fields"]["field_ids"][0]).status_code == 200
    client.post("/api/event/active-session", json={"session_id": event["other_session"]})
    assert _binding(client, scorer) is None
    assert _bind(client, scorer, other_field).status_code == 200
    assert len(_binding_rows(client)) == 2


def test_only_paired_scorer_and_referee_devices_bind_themselves(client, event):
    first = event["fields"]["field_ids"][0]
    referee = paired_device(client, role="referee")
    assert _bind(client, referee, first).status_code == 200
    for role in ("judge", "display_device"):
        device = paired_device(client, role=role)
        refused = _bind(client, device, first)
        assert (refused.status_code, refused.json()["detail"]) == (
            403,
            "Only a paired scorer or referee device can be bound to a field.",
        )
        assert client.get("/api/devices/me/binding", headers=device["headers"]).status_code == 403
    assert client.put("/api/devices/me/binding", json={"field_id": first}).status_code == 403
    scorer_headers = event["scorer"]["headers"]
    assert client.delete(f"/api/devices/{referee['id']}/binding", headers=scorer_headers).status_code == 403


def test_an_admin_clears_a_devices_binding(client, event):
    scorer = event["scorer"]
    _bind(client, scorer, event["fields"]["field_ids"][0])
    assert client.delete(f"/api/devices/{scorer['id']}/binding").status_code == 204
    assert _binding(client, scorer) is None
    assert client.delete("/api/devices/999/binding").status_code == 404


def test_device_reads_show_the_binding_in_the_active_session(client, event):
    scorer = event["scorer"]
    display = paired_device(client, role="display_device")
    _bind(client, scorer, event["fields"]["field_ids"][0])
    rows = {device["id"]: device for device in client.get("/api/devices").json()}
    assert rows[scorer["id"]]["binding"] == {"field_id": event["fields"]["field_ids"][0], "field_name": "Field 1"}
    assert rows[display["id"]]["binding"] is None
    client.post("/api/event/active-session", json={"session_id": event["other_session"]})
    rows = {device["id"]: device for device in client.get("/api/devices").json()}
    assert rows[scorer["id"]]["binding"] is None


def test_deleting_the_field_clears_the_binding_and_tells_the_device(client, event):
    scorer = event["scorer"]
    second = event["fields"]["field_ids"][1]
    _bind(client, scorer, second)
    with client.websocket_connect(f"/ws/active-session?token={scorer['access_token']}") as socket:
        assert client.delete(f"/api/fields/{second}").status_code == 204
        assert next_event(socket, "scorer_binding_changed")["data"] == {"device_id": scorer["id"]}
    assert _binding(client, scorer) is None


def test_deleting_a_field_set_or_session_clears_its_bindings(client, event):
    scorer = event["scorer"]
    _bind(client, scorer, event["fields"]["field_ids"][0])
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        assert client.delete(f"/api/field-sets/{event['fields']['id']}").status_code == 204
        assert next_event(socket, "scorer_binding_changed")["data"] == {"device_id": scorer["id"]}
    assert _binding_rows(client) == []
    client.post("/api/event/active-session", json={"session_id": event["other_session"]})
    _bind(client, scorer, event["other"]["field_ids"][0])
    client.post("/api/event/active-session", json={"session_id": event["session_id"]})
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        assert client.delete(f"/api/sessions/{event['other_session']}").status_code == 204
        assert next_event(socket, "scorer_binding_changed")["data"] == {"device_id": scorer["id"]}
    assert _binding_rows(client) == []


def test_a_device_that_stops_scoring_loses_its_bindings(client, event):
    scorer = event["scorer"]
    _bind(client, scorer, event["fields"]["field_ids"][0])
    assert client.patch(f"/api/devices/{scorer['id']}", json={"role": "referee"}).status_code == 200
    assert len(_binding_rows(client)) == 1
    assert client.patch(f"/api/devices/{scorer['id']}", json={"role": "judge"}).status_code == 200
    assert _binding_rows(client) == []


def test_binding_changes_go_to_admins_and_that_device_only(client, event):
    scorer = event["scorer"]
    other_scorer = paired_device(client, role="scorer", name="Scorer B")
    first = event["fields"]["field_ids"][0]
    expected = {"device_id": scorer["id"]}
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as admin_socket, \
            client.websocket_connect(f"/ws/active-session?token={scorer['access_token']}") as mine, \
            client.websocket_connect(f"/ws/active-session?token={other_scorer['access_token']}") as theirs:
        _bind(client, scorer, first)
        assert next_event(admin_socket, "scorer_binding_changed")["data"] == expected
        assert next_event(mine, "scorer_binding_changed")["data"] == expected
        client.delete("/api/devices/me/binding", headers=scorer["headers"])
        assert next_event(mine, "scorer_binding_changed")["data"] == expected
        _bind(client, scorer, first)
        client.delete(f"/api/devices/{scorer['id']}/binding")
        assert next_event(admin_socket, "scorer_binding_changed")["data"] == expected
        # A rename reaches every socket: everything the other scorer got before it
        # is what the binding changes sent it, which must be nothing.
        client.patch(f"/api/devices/{other_scorer['id']}", json={"name": "Scorer B2"})
        assert "scorer_binding_changed" not in _events_until(theirs, "devices_changed")
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && .venv/bin/pytest -q tests/test_scorer_bindings.py`
Expected: FAIL. `/api/devices/me/binding` matches no route (GET gives 404, PUT 405), `DELETE /api/devices/{id}/binding` gives 404 or 405, and `DeviceRead` has no `binding` key.

- [ ] **Step 3: Add the service**

Create `server/src/tournament_server/services/scorer_bindings.py`:

```python
"""Scorer bindings (live scoring spec §6.2): a paired scorer or referee device
may follow one field in the active session. Binding is optional; an unbound
scorer picks each match or skills field."""
from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tournament_server import realtime
from tournament_server.deps import get_the_event
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.models.scoring_draft import ScorerBinding

ACTIVE_FIELD_DETAIL = "Pick a field in the active session."
BINDING_CHANGED = "scorer_binding_changed"


class BindingRefused(Exception):
    pass


def _active_session_id(db: Session) -> int | None:
    event = get_the_event(db)
    return event.active_session_id if event is not None else None


def find_binding(db: Session, device_id: int) -> ScorerBinding | None:
    """The device's binding in the active session."""
    session_id = _active_session_id(db)
    if session_id is None:
        return None
    return db.execute(
        select(ScorerBinding).where(ScorerBinding.session_id == session_id, ScorerBinding.device_id == device_id)
    ).scalars().first()


def binding_read(db: Session, device_id: int) -> dict | None:
    binding = find_binding(db, device_id)
    if binding is None:
        return None
    field = db.get(Field, binding.field_id)
    return {"field_id": field.id, "field_name": field.name} if field is not None else None


def set_binding(db: Session, device_id: int, field_id: int) -> ScorerBinding:
    """Binds the device to a field of the active session, replacing its binding."""
    session_id = _active_session_id(db)
    field = db.get(Field, field_id)
    field_set = db.get(FieldSet, field.field_set_id) if field is not None else None
    if session_id is None or field_set is None or field_set.session_id != session_id:
        raise BindingRefused(ACTIVE_FIELD_DETAIL)
    binding = find_binding(db, device_id)
    if binding is None:
        binding = ScorerBinding(session_id=session_id, device_id=device_id, field_id=field_id)
        db.add(binding)
    else:
        binding.field_id = field_id
    try:
        db.commit()
    except IntegrityError:
        # The same device bound itself twice at once: the other request's row wins, then this one updates it.
        db.rollback()
        binding = find_binding(db, device_id)
        binding.field_id = field_id
        db.commit()
    return binding


def clear_binding(db: Session, device_id: int) -> bool:
    """Removes the device's binding in the active session; False if it had none."""
    binding = find_binding(db, device_id)
    if binding is None:
        return False
    db.delete(binding)
    db.commit()
    return True


def _delete_where(db: Session, *conditions) -> list[int]:
    rows = db.execute(select(ScorerBinding).where(*conditions)).scalars().all()
    device_ids = sorted({row.device_id for row in rows})
    for row in rows:
        db.delete(row)
    db.flush()
    return device_ids


def clear_for_fields(db: Session, field_ids: Iterable[int]) -> list[int]:
    """Deletes the bindings to these fields (no commit); returns the devices that had one."""
    field_ids = list(field_ids)
    if not field_ids:
        return []
    return _delete_where(db, ScorerBinding.field_id.in_(field_ids))


def clear_for_session(db: Session, session_id: int) -> list[int]:
    return _delete_where(db, ScorerBinding.session_id == session_id)


def clear_for_device(db: Session, device_id: int) -> list[int]:
    return _delete_where(db, ScorerBinding.device_id == device_id)


def notify(app, device_ids: Iterable[int]) -> None:
    """Tells admins and each device that its binding changed."""
    for device_id in device_ids:
        realtime.send_to_devices_and_admins(app, [device_id], BINDING_CHANGED, {"device_id": device_id})
```

- [ ] **Step 4: Add the schemas and the routes**

In `schemas/device.py` change the pydantic import to `from pydantic import BaseModel, ConfigDict, Field`, and add above `DeviceRead`:

```python
class BindingRead(BaseModel):
    field_id: int
    field_name: str


class BindingWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    field_id: int
```

and give `DeviceRead`, after `display_group`:

```python
    # A scorer's or referee's field in the active session.
    binding: BindingRead | None = None
```

Create `server/src/tournament_server/routers/bindings.py`:

```python
"""Scorer bindings (live scoring spec §6.2). The /me routes are registered
before /{device_id}/binding so "me" never reaches the id route."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from tournament_server.auth import Caller, get_caller, require_admin
from tournament_server.deps import get_db
from tournament_server.models.device import Device
from tournament_server.schemas.device import BindingRead, BindingWrite
from tournament_server.services import scorer_bindings
from tournament_server.services.devices import SCORING_ROLES

router = APIRouter(prefix="/api/devices", tags=["bindings"])

NOT_A_SCORING_DEVICE = "Only a paired scorer or referee device can be bound to a field."


def _scoring_device(caller: Caller = Depends(get_caller)) -> Caller:
    if caller.device_id is None or caller.role not in SCORING_ROLES:
        raise HTTPException(status_code=403, detail=NOT_A_SCORING_DEVICE)
    return caller


@router.get("/me/binding", response_model=BindingRead | None)
def read_my_binding(caller: Caller = Depends(_scoring_device), db: Session = Depends(get_db)) -> dict | None:
    return scorer_bindings.binding_read(db, caller.device_id)


@router.put("/me/binding", response_model=BindingRead)
def bind_me(
    payload: BindingWrite,
    request: Request,
    caller: Caller = Depends(_scoring_device),
    db: Session = Depends(get_db),
) -> dict | None:
    try:
        scorer_bindings.set_binding(db, caller.device_id, payload.field_id)
    except scorer_bindings.BindingRefused as refused:
        raise HTTPException(status_code=422, detail=str(refused))
    scorer_bindings.notify(request.app, [caller.device_id])
    return scorer_bindings.binding_read(db, caller.device_id)


@router.delete("/me/binding", status_code=204)
def unbind_me(
    request: Request, caller: Caller = Depends(_scoring_device), db: Session = Depends(get_db)
) -> Response:
    if scorer_bindings.clear_binding(db, caller.device_id):
        scorer_bindings.notify(request.app, [caller.device_id])
    return Response(status_code=204)


@router.delete("/{device_id}/binding", status_code=204)
def unbind_device(
    device_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    if db.get(Device, device_id) is None:
        raise HTTPException(status_code=404, detail="Device not found")
    if scorer_bindings.clear_binding(db, device_id):
        scorer_bindings.notify(request.app, [device_id])
    return Response(status_code=204)
```

In `app.py` add `bindings` to the `from tournament_server.routers import (...)` list and register it next to the devices router:

```python
    app.include_router(devices.router)
    app.include_router(bindings.router)
```

- [ ] **Step 5: Show the binding on device reads and drop it when a device stops scoring**

In `routers/devices.py` add `from tournament_server.services import scorer_bindings` and add `SCORING_ROLES` to the `services.devices` import list. In `to_device_read`, after the `display_group=...` argument, add:

```python
        binding=scorer_bindings.binding_read(db, device.id) if device.role in SCORING_ROLES else None,
```

In `update_device`, below

```python
        if role_changed and before["role"] == "display_device":
            displays.delete_device_assignments(db, device.id)
```

add:

```python
        if role_changed and role not in SCORING_ROLES:
            scorer_bindings.clear_for_device(db, device.id)
```

In `delete_device`, below `displays.delete_device_assignments(db, device.id)`, add `scorer_bindings.clear_for_device(db, device.id)`.

- [ ] **Step 6: Clear bindings when their field, field set or session is deleted**

In `routers/fields.py` add `from tournament_server.services import scorer_bindings` (next to the `displays` import). In `delete_field` replace

```python
    displays.delete_field_groups(db, field_id)
    db.delete(field)
    db.commit()
    notify_display_changed(request, session_id, None)
```

with

```python
    displays.delete_field_groups(db, field_id)
    cleared = scorer_bindings.clear_for_fields(db, [field_id])
    db.delete(field)
    db.commit()
    notify_display_changed(request, session_id, None)
    scorer_bindings.notify(request.app, cleared)
```

In `routers/field_sets.py` add `scorer_bindings` to `from tournament_server.services import displays, qualification, skills_runs` (Task 2's import line). In `delete_field_set` replace

```python
    displays.delete_field_set_groups(db, field_set_id)
    for field in fields:
        db.delete(field)
```

with

```python
    displays.delete_field_set_groups(db, field_set_id)
    cleared = scorer_bindings.clear_for_fields(db, field_ids)
    for field in fields:
        db.delete(field)
```

and after its final `notify_display_changed(request, session_id, None)` add `scorer_bindings.notify(request.app, cleared)`.

In `routers/sessions.py` add `scorer_bindings` to `from tournament_server.services import displays, live_scores, skills_runs` (Task 2's import line). In `remove_session` replace

```python
    was_active = delete_session(db, session_obj)
    db.commit()
```

with

```python
    cleared = scorer_bindings.clear_for_session(db, session_id)
    was_active = delete_session(db, session_obj)
    db.commit()
    scorer_bindings.notify(request.app, cleared)
```

- [ ] **Step 7: Run the tests**

Run: `cd server && .venv/bin/pytest -q tests/test_scorer_bindings.py`
Expected: all pass.

- [ ] **Step 8: Run the wider suites**

Run: `cd server && .venv/bin/pytest -q tests/test_device_management.py tests/test_device_sockets.py tests/test_pairing_api.py tests/test_displays_api.py tests/test_fields.py tests/test_field_sets.py tests/test_session_delete.py tests/test_sessions.py tests/test_realtime_roles.py tests/test_websockets_router.py tests/test_alembic_drift.py`
Expected: all pass (`binding` is an added key; no existing test compares a whole `DeviceRead`).

- [ ] **Step 9: Commit**

```bash
git add server/src/tournament_server/services/scorer_bindings.py server/src/tournament_server/routers/bindings.py \
  server/src/tournament_server/schemas/device.py server/src/tournament_server/routers/devices.py \
  server/src/tournament_server/routers/fields.py server/src/tournament_server/routers/field_sets.py \
  server/src/tournament_server/routers/sessions.py server/src/tournament_server/app.py \
  server/tests/test_scorer_bindings.py
git commit -m "Let a paired scorer or referee device bind itself to one field in the active session, and let an admin clear it. Device reads show the binding, deleting its field, field set or session clears it, and every change is sent as scorer_binding_changed to admins and that device.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Shared draft sync

**Files:**
- Create: `frontend/packages/shared/src/scoring/types.ts`, `frontend/packages/shared/src/scoring/api.ts`, `frontend/packages/shared/src/scoring/mergeDraft.ts`, `frontend/packages/shared/src/scoring/useLiveDraft.ts`, `frontend/packages/shared/src/scoring/index.ts`
- Modify: `frontend/packages/shared/src/index.ts`
- Test: `frontend/packages/shared/tests/scoring.test.tsx`

**Interfaces:**
- Consumes: Task 6 (`GET /api/matches/{id}/draft` → `MatchDraftRead`, `PATCH /api/matches/{id}/alliances/{aid}/draft` → `AllianceDraftRead`, `score_draft_changed`), Task 8 (`POST /api/matches/{id}/submit` with `{force}`, 409 `"Alliance {id} has no draft score."`, 422 `{"detail": {"violations": [{alliance_id, messages}]}}`, `match_submitted {match_id}`, whole-match reset broadcasting `version: 0` drafts), Task 9 (`GET /api/field-sets/{id}/skills` → `SkillsSetRead`, `PATCH /api/fields/{id}/skills-run/draft`, `DELETE /api/fields/{id}/skills-run`, `skills_run_changed {field_set_id, field_id?}`), Task 10 (field and set timer actions, `POST /api/fields/{id}/skills-run/submit`), the existing `GET /api/scores?session_id=`, `GET /api/skills/types/{key}/schema`, `ApiError`, `apiRequest`, `RealtimeEvent`, `AllianceScore`, `ScoresheetValues`.
- Produces (`scoring/types.ts`): `ItemMeta`, `TeamFlags`, `TeamFlag`, `AllianceDraft`, `MatchDraft`, `ScoreDraftChanged`, `SubmitViolation`, `SkillsPhase`, `SkillsSetTimer`, `SkillsRun`, `SkillsSetField`, `SkillsSet`, `ScoringSocket`, `ScoringRequest`, `MatchClockAction`, `SkillsTimerAction`, `ScoringMatchFormat`, `SCORE_ALREADY_SUBMITTED_DETAIL`, `NOT_PLAYED_SCORE_DETAIL`, `FLASH_MS` (2000), `RETRY_MS` (3000).
- Produces (`scoring/api.ts`): `scoringPaths`, `isNetworkError(error)`, `violationsOf(error)`, `submitViolations(error) -> SubmitViolation[] | null`, `missingDraftAlliance(error) -> number | null` (the id in Task 8's 409 `"Alliance {id} has no draft score."`), `errorText(error) -> string | null`, `createScoringHub() -> {emit, subscribe}`.
- Produces (`scoring/mergeDraft.ts`): `teamFlagKey(teamId, flag)`, `parseTeamFlagKey(key)`, `DraftLike`, `withPending(draft, pending)`, `mergeIncoming(local, incoming, pending) -> AllianceDraft`, `changedByOthers(prev, next, myDevice) -> string[]`.
- Produces (`scoring/useLiveDraft.ts`): `flashKey(allianceId, item)`, `useLiveDraft(options: UseLiveDraftOptions) -> LiveDraftState`, `useSkillsRun(options: UseSkillsRunOptions) -> SkillsRunState`, `SkillsSaved`.

> **Plan note:** the skeleton's `useLiveDraft({ matchId, myDeviceName, socketEvents })` gains `sessionId` (to read the official scores for "Saved"), an optional `request` (the device app makes requests through its own fetch helper, never the shared `apiRequest`, so the hook can't hard-wire it) and `defaults` (see the next note). `socketEvents` is a `ScoringSocket` (`{connected, subscribe}`); the admin feeds it from `useRealtimeChannel` through `createScoringHub()`, the device app will feed it from its event bus. `pending` is the number of unacknowledged changes (the per-item pending values stay inside the hook and are what `mergeIncoming` lays on top). `flashing` is keyed by `flashKey(allianceId, item)`. The state also carries `loading`, `submitting`, `saved` (the official scores once submitted), `missingDraft`, `fillDefaults(allianceId)` and `error`. `useSkillsRun` takes `{fieldId, fieldSetId, myDeviceName, socketEvents, request?, defaults?}` and adds `set`, `run`, `discard()` and `timerAction("field" | "set", action)`.
>
> **Plan note:** Task 8 refuses Submit with 409 `"Alliance {id} has no draft score."` while any alliance has no draft. That guard keeps a split-scored match from being half-saved, so the hook never fills drafts on its own: `submit()` waits for this device's queued changes to be acknowledged, posts Submit, and on that 409 sets `missingDraft` to the named alliance (no error, nothing submitted). `fillDefaults(allianceId)` is the explicit way out: it PATCHes that alliance with the scoresheet `defaults`, and the scorer presses Submit again. A skills run has one scorer and no such guard, so `useSkillsRun.submit()` still sends the defaults of items the run never set before submitting.
>
> **Plan note:** Task 8's whole-match reset broadcasts drafts with `version: 0`, and the next PATCH starts a new row at version 1, so versions are not monotonic across a reset. The hook therefore always applies an incoming `version: 0` draft, and on `match_reset` for its match it refetches the draft and takes the server's copy whatever its version.

- [ ] **Step 1: Write the failing tests**

Create `frontend/packages/shared/tests/scoring.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ApiError, type ApiRequestOptions } from "../src/api-client";
import type { RealtimeEvent } from "../src/realtime";
import {
  FLASH_MS,
  SCORE_ALREADY_SUBMITTED_DETAIL,
  changedByOthers,
  createScoringHub,
  flashKey,
  mergeIncoming,
  useLiveDraft,
  useSkillsRun,
  type AllianceDraft,
  type MatchDraft,
  type ScoringRequest,
  type SkillsRun,
  type SkillsSet,
} from "../src/scoring";

const AT = "2026-10-19T10:00:00Z";

function draft(overrides: Partial<AllianceDraft>): AllianceDraft {
  return { alliance_id: 11, data: {}, teams: [], item_meta: {}, version: 0, score: 0, ...overrides };
}

interface Call {
  path: string;
  options?: ApiRequestOptions;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/** GETs answer from `gets` at once; everything else waits in `calls` until the test settles it. */
function fakeServer(gets: Record<string, unknown>) {
  const calls: Call[] = [];
  const request = vi.fn((path: string, options?: ApiRequestOptions) => {
    if ((options?.method ?? "GET") === "GET") {
      const value = gets[path];
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }
    return new Promise((resolve, reject) => calls.push({ path, options, resolve, reject }));
  });
  return { request: request as unknown as ScoringRequest, mock: request, calls, gets };
}

function fakeSocket() {
  const hub = createScoringHub();
  return { socket: { connected: true, subscribe: hub.subscribe }, emit: (event: RealtimeEvent) => act(() => hub.emit(event)) };
}

const MATCH_DRAFT: MatchDraft = {
  match_id: 1,
  submitted: false,
  alliances: [
    draft({ alliance_id: 11, data: { balls: 2 }, item_meta: { balls: { device_name: "Tablet A", at: AT } }, version: 3, score: 2 }),
    draft({ alliance_id: 12 }),
  ],
};

function renderDraft(server: ReturnType<typeof fakeServer>, socket = fakeSocket().socket) {
  return renderHook(
    (props: { connected: boolean }) =>
      useLiveDraft({
        matchId: 1,
        sessionId: 5,
        myDeviceName: "Admin",
        socketEvents: { ...socket, connected: props.connected },
        request: server.request,
        defaults: { balls: 0, parked: false },
      }),
    { initialProps: { connected: true } }
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("mergeIncoming", () => {
  it("takes the newer version and keeps still-pending local items on top", () => {
    const local = draft({ data: { balls: 1, parked: false }, version: 2 });
    const incoming = draft({ data: { balls: 4, parked: true }, version: 3 });
    expect(mergeIncoming(local, incoming, { balls: 5 }).data).toEqual({ balls: 5, parked: true });
    expect(mergeIncoming(local, incoming, {}).version).toBe(3);
  });

  it("ignores an older incoming version", () => {
    const local = draft({ data: { balls: 4 }, version: 5 });
    expect(mergeIncoming(local, draft({ data: { balls: 1 }, version: 4 }), {}).data).toEqual({ balls: 4 });
  });

  it("lays pending team flags over the teams list", () => {
    const local = draft({ teams: [{ team_id: 7, no_show: true, dq: false }], version: 1 });
    expect(mergeIncoming(local, local, { "team:7:no_show": false, "team:8:dq": true }).teams).toEqual([
      { team_id: 8, no_show: false, dq: true },
    ]);
  });
});

describe("changedByOthers", () => {
  it("lists items another device changed, team flags included, but not this device's", () => {
    const prev = draft({ data: { balls: 1, parked: false } });
    const next = draft({
      data: { balls: 3, parked: true },
      teams: [{ team_id: 7, no_show: false, dq: true }],
      item_meta: {
        balls: { device_name: "Tablet A", at: AT },
        parked: { device_name: "Admin", at: AT },
        "team:7:dq": { device_name: "Tablet B", at: AT },
      },
    });
    expect(changedByOthers(prev, next, "Admin")).toEqual(["balls", "team:7:dq"]);
  });
});

describe("useLiveDraft", () => {
  it("loads the drafts, shows a change at once and sends one PATCH at a time in order", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { result } = renderDraft(server);
    await waitFor(() => expect(result.current.draft?.alliances[0].data).toEqual({ balls: 2 }));

    act(() => result.current.setItem(11, "balls", 3));
    act(() => result.current.setItem(11, "parked", true));
    expect(result.current.draft?.alliances[0].data).toEqual({ balls: 3, parked: true });
    expect(result.current.pending).toBe(2);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0].path).toBe("/api/matches/1/alliances/11/draft");
    expect(server.calls[0].options).toEqual({ method: "PATCH", body: { changes: { balls: 3 } } });

    await act(async () => server.calls[0].resolve(draft({ data: { balls: 3 }, version: 4, score: 3 })));
    await waitFor(() => expect(server.calls).toHaveLength(2));
    expect(server.calls[1].options).toEqual({ method: "PATCH", body: { changes: { parked: true } } });
    expect(result.current.pending).toBe(1);

    await act(async () => server.calls[1].resolve(draft({ data: { balls: 3, parked: true }, version: 5, score: 3 })));
    await waitFor(() => expect(result.current.pending).toBe(0));
    expect(result.current.draft?.alliances[0]).toMatchObject({ data: { balls: 3, parked: true }, version: 5 });
  });

  it("sends a team flag with that team's other flag kept", async () => {
    const server = fakeServer({
      "/api/matches/1/draft": {
        ...MATCH_DRAFT,
        alliances: [draft({ alliance_id: 11, teams: [{ team_id: 7, no_show: true, dq: false }], version: 1 }), draft({ alliance_id: 12 })],
      },
    });
    const { result } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setTeamFlag(11, 7, "dq", true));
    expect(server.calls[0].options).toEqual({
      method: "PATCH",
      body: { changes: {}, teams: [{ team_id: 7, no_show: true, dq: true }] },
    });
    expect(result.current.draft?.alliances[0].teams).toEqual([{ team_id: 7, no_show: true, dq: true }]);
  });

  it("applies a newer score_draft_changed, ignores an older one, and flashes another device's item for 2 s", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { socket, emit } = fakeSocket();
    const { result } = renderDraft(server, socket);
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    vi.useFakeTimers();
    emit({
      event: "score_draft_changed",
      data: {
        match_id: 1,
        ...draft({ data: { balls: 6 }, item_meta: { balls: { device_name: "Tablet B", at: AT } }, version: 4, score: 6 }),
      },
    });
    expect(result.current.draft?.alliances[0].data).toEqual({ balls: 6 });
    expect(result.current.flashing).toEqual({ [flashKey(11, "balls")]: "Tablet B" });

    emit({ event: "score_draft_changed", data: { match_id: 1, ...draft({ data: { balls: 1 }, version: 2 }) } });
    expect(result.current.draft?.alliances[0].data).toEqual({ balls: 6 });

    act(() => vi.advanceTimersByTime(FLASH_MS - 1));
    expect(result.current.flashing).toEqual({ [flashKey(11, "balls")]: "Tablet B" });
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.flashing).toEqual({});
  });

  it("does not flash or overwrite an item this device still has queued", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { socket, emit } = fakeSocket();
    const { result } = renderDraft(server, socket);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setItem(11, "balls", 9));
    emit({
      event: "score_draft_changed",
      data: { match_id: 1, ...draft({ data: { balls: 6 }, item_meta: { balls: { device_name: "Tablet B", at: AT } }, version: 4 }) },
    });
    expect(result.current.draft?.alliances[0].data).toEqual({ balls: 9 });
    expect(result.current.flashing).toEqual({});
  });

  it("keeps changes queued while offline, then sends them and refetches on reconnect", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { result, rerender } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.setItem(11, "balls", 3));
    await act(async () => server.calls[0].reject(new TypeError("Failed to fetch")));
    expect(result.current.offline).toBe(true);
    expect(result.current.pending).toBe(1);
    expect(result.current.draft?.alliances[0].data).toEqual({ balls: 3 });

    rerender({ connected: false });
    act(() => result.current.setItem(11, "parked", true));
    expect(result.current.pending).toBe(2);

    server.mock.mockClear();
    rerender({ connected: true });
    await waitFor(() => expect(server.calls).toHaveLength(2));
    expect(server.calls[1].options).toEqual({ method: "PATCH", body: { changes: { balls: 3 } } });
    await act(async () => server.calls[1].resolve(draft({ data: { balls: 3 }, version: 4 })));
    await waitFor(() => expect(server.calls).toHaveLength(3));
    expect(server.calls[2].options).toEqual({ method: "PATCH", body: { changes: { parked: true } } });

    server.gets["/api/matches/1/draft"] = {
      ...MATCH_DRAFT,
      alliances: [draft({ data: { balls: 3, parked: true, zone: "far" }, version: 6 }), draft({ alliance_id: 12 })],
    };
    await act(async () => server.calls[2].resolve(draft({ data: { balls: 3, parked: true }, version: 5 })));
    await waitFor(() => expect(result.current.draft?.alliances[0].data).toEqual({ balls: 3, parked: true, zone: "far" }));
    expect(server.mock.mock.calls.map(([path, options]) => `${options?.method ?? "GET"} ${path}`)).toEqual([
      "PATCH /api/matches/1/alliances/11/draft",
      "PATCH /api/matches/1/alliances/11/draft",
      "GET /api/matches/1/draft",
    ]);
    expect(result.current.offline).toBe(false);
    expect(result.current.pending).toBe(0);
  });

  it("reads offline while the socket is down even with nothing queued", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { result, rerender } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    rerender({ connected: false });
    expect(result.current.offline).toBe(true);
  });

  it("switches to submitted on a 409 already submitted and reads the official scores", async () => {
    const server = fakeServer({
      "/api/matches/1/draft": MATCH_DRAFT,
      "/api/scores?session_id=5": [
        { match_id: 1, alliance_id: 11, score: 8, data: {}, teams: [], saved_at: AT },
        { match_id: 2, alliance_id: 21, score: 1, data: {}, teams: [], saved_at: AT },
      ],
    });
    const { result } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setItem(11, "balls", 3));
    await act(async () =>
      server.calls[0].reject(new ApiError(409, SCORE_ALREADY_SUBMITTED_DETAIL, { detail: SCORE_ALREADY_SUBMITTED_DETAIL }))
    );
    await waitFor(() => expect(result.current.saved).toEqual([expect.objectContaining({ alliance_id: 11, score: 8 })]));
    expect(result.current.submitted).toBe(true);
    expect(result.current.pending).toBe(0);
  });

  it("marks the match gone on a 404", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { result } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setItem(11, "balls", 3));
    await act(async () => server.calls[0].reject(new ApiError(404, "Match not found")));
    expect(result.current.gone).toBe(true);
  });

  it("drops a refused change, shows why and restores the server's copy", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { result } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setItem(11, "balls", 99));
    await act(async () =>
      server.calls[0].reject(new ApiError(422, "", { detail: { violations: ["balls must be at most 10"] } }))
    );
    await waitFor(() => expect(result.current.draft?.alliances[0].data).toEqual({ balls: 2 }));
    expect(result.current.error).toBe("balls must be at most 10");
    expect(result.current.pending).toBe(0);
  });

  it("goes to Saved when another device submits", async () => {
    const server = fakeServer({
      "/api/matches/1/draft": MATCH_DRAFT,
      "/api/scores?session_id=5": [{ match_id: 1, alliance_id: 11, score: 4, data: {}, teams: [], saved_at: AT }],
    });
    const { socket, emit } = fakeSocket();
    const { result } = renderDraft(server, socket);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    emit({ event: "match_submitted", data: { match_id: 2 } });
    expect(result.current.submitted).toBe(false);
    emit({ event: "match_submitted", data: { match_id: 1 } });
    expect(result.current.submitted).toBe(true);
    await waitFor(() => expect(result.current.saved).toHaveLength(1));
  });

  it("refuses to submit while an alliance has no draft, names it, and fills it with the defaults only when asked", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { result } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.submit());
    expect(result.current.submitting).toBe(true);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]).toMatchObject({ path: "/api/matches/1/submit", options: { method: "POST", body: { force: false } } });
    await act(async () => server.calls[0].reject(new ApiError(409, "Alliance 12 has no draft score.")));
    expect(result.current.missingDraft).toBe(12);
    expect(result.current.error).toBeNull();
    expect(result.current.submitted).toBe(false);

    act(() => result.current.fillDefaults(12));
    expect(result.current.missingDraft).toBeNull();
    expect(server.calls[1]).toMatchObject({
      path: "/api/matches/1/alliances/12/draft",
      options: { method: "PATCH", body: { changes: { balls: 0, parked: false } } },
    });
    await act(async () => server.calls[1].resolve(draft({ alliance_id: 12, data: { balls: 0, parked: false }, version: 1 })));
    await waitFor(() => expect(result.current.pending).toBe(0));

    act(() => result.current.submit());
    await waitFor(() => expect(server.calls).toHaveLength(3));
    expect(server.calls[2]).toMatchObject({ path: "/api/matches/1/submit", options: { body: { force: false } } });
    await act(async () => server.calls[2].resolve({ match_id: 1, submitted: true, alliances: [] }));
    await waitFor(() => expect(result.current.submitted).toBe(true));
  });

  it("shows the plugin's violations per alliance and submits anyway", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { result } = renderDraft(server);
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.submit());
    await act(async () =>
      server.calls[0].reject(
        new ApiError(422, "", { detail: { violations: [{ alliance_id: 11, messages: ["Too many balls"] }] } })
      )
    );
    expect(result.current.violations).toEqual([{ alliance_id: 11, messages: ["Too many balls"] }]);
    expect(result.current.submitting).toBe(false);

    act(() => result.current.submit(true));
    await waitFor(() => expect(server.calls).toHaveLength(2));
    expect(server.calls[1]).toMatchObject({ path: "/api/matches/1/submit", options: { method: "POST", body: { force: true } } });
  });

  it("replaces a draft that a whole-match reset cleared (version 0)", async () => {
    const server = fakeServer({ "/api/matches/1/draft": MATCH_DRAFT });
    const { socket, emit } = fakeSocket();
    const { result } = renderDraft(server, socket);
    await waitFor(() => expect(result.current.draft?.alliances[0].version).toBe(3));
    emit({ event: "score_draft_changed", data: { match_id: 1, ...draft({ version: 0 }) } });
    expect(result.current.draft?.alliances[0]).toMatchObject({ data: {}, version: 0 });
    expect(result.current.flashing).toEqual({});
  });
});

const RUN: SkillsRun = {
  id: 40, field_id: 3, field_set_id: 9, team_id: 7, team_number: "101A", team_name: "Rockets", skills_type: "driver",
  data: { balls: 1 }, item_meta: { balls: { device_name: "Admin", at: AT } }, version: 1, score: 1,
  follows_set: true, phase: "running", deadline: null, paused: true, remaining_seconds: 30,
};

function skillsSet(run: SkillsRun | null): SkillsSet {
  return {
    timer: { field_set_id: 9, skills_type: "driver", phase: "running", deadline: null, paused: true, remaining_seconds: 30, run_seconds: 60 },
    fields: [{ field_id: 3, name: "Skills 1", run }],
  };
}

describe("useSkillsRun", () => {
  function renderRun(server: ReturnType<typeof fakeServer>, socket = fakeSocket().socket) {
    return renderHook(() =>
      useSkillsRun({
        fieldId: 3,
        fieldSetId: 9,
        myDeviceName: "Admin",
        socketEvents: socket,
        request: server.request,
        defaults: { balls: 0, parked: false },
      })
    );
  }

  it("sends changes to the run's draft and flashes another device's change after skills_run_changed", async () => {
    const server = fakeServer({ "/api/field-sets/9/skills": skillsSet(RUN) });
    const { socket, emit } = fakeSocket();
    const { result } = renderRun(server, socket);
    await waitFor(() => expect(result.current.run?.data).toEqual({ balls: 1 }));

    act(() => result.current.setItem("balls", 2));
    expect(server.calls[0]).toMatchObject({
      path: "/api/fields/3/skills-run/draft",
      options: { method: "PATCH", body: { changes: { balls: 2 } } },
    });
    await act(async () => server.calls[0].resolve({ ...RUN, data: { balls: 2 }, version: 2, score: 2 }));

    server.gets["/api/field-sets/9/skills"] = skillsSet({
      ...RUN, data: { balls: 5 }, item_meta: { balls: { device_name: "Tablet C", at: AT } }, version: 3, score: 5,
    });
    emit({ event: "skills_run_changed", data: { field_set_id: 9, field_id: 3 } });
    await waitFor(() => expect(result.current.run?.data).toEqual({ balls: 5 }));
    expect(result.current.flashing).toEqual({ balls: "Tablet C" });
  });

  it("submits with untouched defaults filled in, shows violations, submits anyway and shows Saved", async () => {
    const server = fakeServer({ "/api/field-sets/9/skills": skillsSet(RUN) });
    const { result } = renderRun(server);
    await waitFor(() => expect(result.current.run).not.toBeNull());

    act(() => result.current.submit());
    expect(server.calls[0].options).toEqual({ method: "PATCH", body: { changes: { parked: false } } });
    await act(async () => server.calls[0].resolve({ ...RUN, data: { balls: 1, parked: false }, version: 2 }));
    await waitFor(() => expect(server.calls).toHaveLength(2));
    expect(server.calls[1]).toMatchObject({ path: "/api/fields/3/skills-run/submit", options: { body: { force: false } } });
    await act(async () =>
      server.calls[1].reject(new ApiError(422, "", { violations: [{ field: "balls", message: "Too many." }] }))
    );
    expect(result.current.violations).toEqual([{ alliance_id: null, messages: ["balls: Too many."] }]);

    server.gets["/api/field-sets/9/skills"] = skillsSet(null);
    act(() => result.current.submit(true));
    await waitFor(() => expect(server.calls).toHaveLength(3));
    expect(server.calls[2].options).toEqual({ method: "POST", body: { force: true } });
    await act(async () => server.calls[2].resolve({}));
    await waitFor(() => expect(result.current.saved).toEqual({ team_number: "101A", team_name: "Rockets", skills_type: "driver", score: 1 }));
    expect(result.current.run).toBeNull();
  });

  it("discards the run", async () => {
    const server = fakeServer({ "/api/field-sets/9/skills": skillsSet(RUN) });
    const { result } = renderRun(server);
    await waitFor(() => expect(result.current.run).not.toBeNull());
    server.gets["/api/field-sets/9/skills"] = skillsSet(null);
    act(() => result.current.discard());
    expect(server.calls[0]).toMatchObject({ path: "/api/fields/3/skills-run", options: { method: "DELETE" } });
    await act(async () => server.calls[0].resolve(undefined));
    await waitFor(() => expect(result.current.run).toBeNull());
    expect(result.current.saved).toBeNull();
  });

  it("posts field and set timer actions", async () => {
    const server = fakeServer({ "/api/field-sets/9/skills": skillsSet(RUN) });
    const { result } = renderRun(server);
    await waitFor(() => expect(result.current.run).not.toBeNull());
    act(() => result.current.timerAction("field", "resume"));
    act(() => result.current.timerAction("set", "end"));
    expect(server.calls.map((call) => `${call.options?.method} ${call.path}`)).toEqual([
      "POST /api/fields/3/skills-run/resume",
      "POST /api/field-sets/9/skills-timer/end",
    ]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend/packages/shared && npx vitest run tests/scoring.test.tsx`
Expected: FAIL, `../src/scoring` cannot be resolved.

- [ ] **Step 3: Write the types and the request helpers**

Create `frontend/packages/shared/src/scoring/types.ts`:

```ts
import type { ApiRequestOptions } from "../api-client";
import type { RealtimeEvent } from "../realtime";
import type { ScoresheetValues } from "../scoresheet";

/** Who last changed one draft item, and when (server time). */
export interface ItemMeta {
  device_name: string;
  at: string;
}

/** One team's No-show / DQ flags. Drafts list flagged teams only. */
export interface TeamFlags {
  team_id: number;
  no_show: boolean;
  dq: boolean;
}

export type TeamFlag = "no_show" | "dq";

/** One alliance's draft, as GET /api/matches/{id}/draft lists it and the PATCH returns it. */
export interface AllianceDraft {
  alliance_id: number;
  data: ScoresheetValues;
  teams: TeamFlags[];
  item_meta: Record<string, ItemMeta>;
  /** 0 while the alliance has no draft; +1 per accepted change. */
  version: number;
  /** The plugin's score of the draft so far (0 when it can't be calculated yet). */
  score: number;
}

export interface MatchDraft {
  match_id: number;
  submitted: boolean;
  alliances: AllianceDraft[];
}

/** The `score_draft_changed` payload: one alliance's full draft. */
export interface ScoreDraftChanged extends AllianceDraft {
  match_id: number;
}

/** A Submit refused by the plugin's rules: one entry per alliance (null for a skills run). */
export interface SubmitViolation {
  alliance_id: number | null;
  messages: string[];
}

export type SkillsPhase = "ready" | "running" | "ended";

export interface SkillsSetTimer {
  field_set_id: number;
  skills_type: string | null;
  phase: SkillsPhase;
  deadline: string | null;
  paused: boolean;
  remaining_seconds: number | null;
  run_seconds: number | null;
}

/** A skills run; its timer fields are the effective ones (the set's while it follows the set). */
export interface SkillsRun {
  id: number;
  field_id: number;
  field_set_id: number;
  team_id: number;
  team_number: string;
  team_name: string;
  skills_type: string;
  data: ScoresheetValues;
  item_meta: Record<string, ItemMeta>;
  version: number;
  score: number;
  follows_set: boolean;
  phase: SkillsPhase;
  deadline: string | null;
  paused: boolean;
  remaining_seconds: number | null;
}

export interface SkillsSetField {
  field_id: number;
  name: string;
  run: SkillsRun | null;
}

/** GET /api/field-sets/{id}/skills. */
export interface SkillsSet {
  timer: SkillsSetTimer;
  fields: SkillsSetField[];
}

/** The live events a scoring page listens to, from whichever socket its app holds. */
export interface ScoringSocket {
  connected: boolean;
  /** Must be stable across renders; returns the unsubscribe function. */
  subscribe: (listener: (event: RealtimeEvent) => void) => () => void;
}

/** The app's request function (the admin's `apiRequest`, or the device app's own). */
export type ScoringRequest = <T>(path: string, options?: ApiRequestOptions) => Promise<T>;

export type MatchClockAction = "start" | "start-driver" | "pause" | "resume" | "end" | "reset";
export type SkillsTimerAction = "start" | "pause" | "resume" | "end" | "reset";

/** The part of GET /api/event/match-format the scoring page needs. */
export interface ScoringMatchFormat {
  game_model: string;
  autonomous_seconds: number;
  driver_seconds: number;
}

/** The server's exact details, which change what the page shows. */
export const SCORE_ALREADY_SUBMITTED_DETAIL = "This score has already been submitted; ask an admin to correct it.";
export const NOT_PLAYED_SCORE_DETAIL = "This match was not played; reopen qualification to score it.";

/** How long an item another device changed stays highlighted. */
export const FLASH_MS = 2000;
/** How often a change that failed on the network is retried. */
export const RETRY_MS = 3000;
```

Create `frontend/packages/shared/src/scoring/api.ts`:

```ts
import { ApiError } from "../api-client";
import type { RealtimeEvent } from "../realtime";
import type { MatchClockAction, SkillsTimerAction, SubmitViolation } from "./types";

/** Every scoring endpoint the shared page calls. */
export const scoringPaths = {
  matchDraft: (matchId: number) => `/api/matches/${matchId}/draft`,
  allianceDraft: (matchId: number, allianceId: number) => `/api/matches/${matchId}/alliances/${allianceId}/draft`,
  submit: (matchId: number) => `/api/matches/${matchId}/submit`,
  matchAction: (matchId: number, action: MatchClockAction) => `/api/matches/${matchId}/${action}`,
  sessionScores: (sessionId: number) => `/api/scores?session_id=${sessionId}`,
  skillsSet: (fieldSetId: number) => `/api/field-sets/${fieldSetId}/skills`,
  setTimer: (fieldSetId: number, action: SkillsTimerAction) => `/api/field-sets/${fieldSetId}/skills-timer/${action}`,
  skillsRun: (fieldId: number) => `/api/fields/${fieldId}/skills-run`,
  skillsRunDraft: (fieldId: number) => `/api/fields/${fieldId}/skills-run/draft`,
  skillsRunAction: (fieldId: number, action: SkillsTimerAction) => `/api/fields/${fieldId}/skills-run/${action}`,
  skillsRunSubmit: (fieldId: number) => `/api/fields/${fieldId}/skills-run/submit`,
  skillsSchema: (skillsType: string) => `/api/skills/types/${skillsType}/schema`,
};

/** A request that never reached the server (fetch rejects with a TypeError, not an ApiError). */
export function isNetworkError(error: unknown): boolean {
  return !(error instanceof ApiError);
}

/** The `violations` list of a 422, whether the route put it at the top level or under `detail`. */
export function violationsOf(error: unknown): unknown[] | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  const body = error.body as { violations?: unknown; detail?: { violations?: unknown } } | null;
  const list = body?.violations ?? body?.detail?.violations;
  return Array.isArray(list) ? list : null;
}

/** A refused Submit's problems, per alliance for a match or as one entry for a skills run. */
export function submitViolations(error: unknown): SubmitViolation[] | null {
  const list = violationsOf(error);
  if (list === null) return null;
  const result: SubmitViolation[] = [];
  const loose: string[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      loose.push(entry);
    } else if (entry && typeof entry === "object" && "messages" in entry) {
      const { alliance_id, messages } = entry as { alliance_id?: number; messages?: unknown };
      result.push({
        alliance_id: typeof alliance_id === "number" ? alliance_id : null,
        messages: Array.isArray(messages) ? messages.map(String) : [],
      });
    } else if (entry && typeof entry === "object" && "message" in entry) {
      const { field, message } = entry as { field?: unknown; message?: unknown };
      loose.push(typeof field === "string" ? `${field}: ${String(message)}` : String(message));
    }
  }
  if (loose.length > 0) result.push({ alliance_id: null, messages: loose });
  return result;
}

const MISSING_DRAFT = /^Alliance (\d+) has no draft score\.$/;

/** The alliance a Submit was refused for because nobody has scored it yet (409 "Alliance {id} has no draft score."), else null. */
export function missingDraftAlliance(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.status !== 409 || typeof error.detail !== "string") return null;
  const match = MISSING_DRAFT.exec(error.detail);
  return match ? Number(match[1]) : null;
}

/** A readable message for a refused request: the server's text detail or its violations joined. */
export function errorText(error: unknown): string | null {
  const violations = submitViolations(error);
  if (violations) return violations.flatMap((entry) => entry.messages).join(" ");
  if (error instanceof ApiError && typeof error.detail === "string" && error.detail) return error.detail;
  return null;
}

/** A tiny fan-out so one socket's `onEvent` can feed several scoring hooks through `ScoringSocket.subscribe`. */
export function createScoringHub(): {
  emit: (event: RealtimeEvent) => void;
  subscribe: (listener: (event: RealtimeEvent) => void) => () => void;
} {
  const listeners = new Set<(event: RealtimeEvent) => void>();
  return {
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
```

- [ ] **Step 4: Write the merge rules**

Create `frontend/packages/shared/src/scoring/mergeDraft.ts`:

```ts
import type { ScoresheetValue } from "../scoresheet";
import type { AllianceDraft, ItemMeta, TeamFlag, TeamFlags } from "./types";

/** The item key a team flag is stored under in `item_meta` (and in the pending map). */
export function teamFlagKey(teamId: number, flag: TeamFlag): string {
  return `team:${teamId}:${flag}`;
}

const TEAM_KEY = /^team:(\d+):(no_show|dq)$/;

/** Parses `team:<id>:<flag>`; null for a scoresheet item. */
export function parseTeamFlagKey(key: string): { teamId: number; flag: TeamFlag } | null {
  const match = TEAM_KEY.exec(key);
  return match ? { teamId: Number(match[1]), flag: match[2] as TeamFlag } : null;
}

/** Anything with draft items: a teamwork alliance draft or a skills run. */
export interface DraftLike {
  data: Record<string, ScoresheetValue>;
  item_meta: Record<string, ItemMeta>;
  teams?: TeamFlags[];
}

/** Every item of a draft as one flat map, team flags included (an unlisted team's flags are false). */
function flatten(draft: DraftLike): Record<string, unknown> {
  const flat: Record<string, unknown> = { ...draft.data };
  for (const team of draft.teams ?? []) {
    flat[teamFlagKey(team.team_id, "no_show")] = team.no_show;
    flat[teamFlagKey(team.team_id, "dq")] = team.dq;
  }
  return flat;
}

function flagValue(draft: DraftLike, key: string): unknown {
  const flat = flatten(draft);
  if (key in flat) return flat[key];
  return parseTeamFlagKey(key) ? false : undefined;
}

/** The draft with the still-unacknowledged local changes laid over it. */
export function withPending<T extends DraftLike>(draft: T, pending: Record<string, unknown>): T {
  const keys = Object.keys(pending);
  if (keys.length === 0) return draft;
  const data = { ...draft.data };
  const teams = new Map((draft.teams ?? []).map((team) => [team.team_id, { ...team }]));
  for (const key of keys) {
    const flag = parseTeamFlagKey(key);
    if (flag === null) {
      data[key] = pending[key] as ScoresheetValue;
      continue;
    }
    const team = teams.get(flag.teamId) ?? { team_id: flag.teamId, no_show: false, dq: false };
    team[flag.flag] = pending[key] === true;
    teams.set(flag.teamId, team);
  }
  const merged = { ...draft, data };
  if (draft.teams === undefined) return merged;
  return {
    ...merged,
    teams: [...teams.values()].filter((team) => team.no_show || team.dq).sort((a, b) => a.team_id - b.team_id),
  };
}

/** The newer of the two drafts (by version), with still-pending local items kept on top. */
export function mergeIncoming(local: AllianceDraft, incoming: AllianceDraft, pending: Record<string, unknown>): AllianceDraft {
  const base = incoming.version > local.version ? incoming : local;
  return withPending(base, pending);
}

/** Item keys whose value differs between the two drafts and that another device changed last. */
export function changedByOthers(prev: DraftLike, next: DraftLike, myDevice: string): string[] {
  const before = flatten(prev);
  const after = flatten(next);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (flagValue(prev, key) === flagValue(next, key)) continue;
    const meta = next.item_meta[key];
    if (meta && meta.device_name !== myDevice) changed.push(key);
  }
  return changed.sort();
}
```

- [ ] **Step 5: Write the sync hooks**

Create `frontend/packages/shared/src/scoring/useLiveDraft.ts`. The queue sends one PATCH per change, in order, one in flight; a network failure keeps the change at the head, marks the hook offline, holds newer changes and retries every `RETRY_MS`; a reconnect sends the queue at once and then refetches. A refused change (422, 403) is dropped, its message shown, and the server's copy fetched again; 409 "already submitted" switches to submitted; 404 or 409 "not played" switches to gone.

```ts
import { useEffect, useReducer, useRef, useState } from "react";
import { ApiError, apiRequest } from "../api-client";
import type { RealtimeEvent } from "../realtime";
import type { AllianceScore } from "../display";
import type { ScoresheetValue, ScoresheetValues } from "../scoresheet";
import { errorText, isNetworkError, missingDraftAlliance, scoringPaths, submitViolations } from "./api";
import { changedByOthers, teamFlagKey, withPending } from "./mergeDraft";
import {
  FLASH_MS,
  NOT_PLAYED_SCORE_DETAIL,
  RETRY_MS,
  SCORE_ALREADY_SUBMITTED_DETAIL,
  type AllianceDraft,
  type MatchDraft,
  type ScoreDraftChanged,
  type ScoringRequest,
  type ScoringSocket,
  type SkillsRun,
  type SkillsSet,
  type SkillsTimerAction,
  type SubmitViolation,
  type TeamFlag,
  type TeamFlags,
} from "./types";

/** The key `flashing` uses for one alliance's item. */
export function flashKey(allianceId: number, itemKey: string): string {
  return `${allianceId}:${itemKey}`;
}

interface QueueEntry {
  /** The alliance id (0 for a skills run). */
  scope: number;
  changes: Record<string, unknown>;
  teams?: TeamFlags[];
  /** The item keys this entry carries, for releasing them from `pending` once acknowledged. */
  keys: string[];
}

/** ack: applied; drop: refused, forget it; clear: forget everything queued; retry: network failure. */
type Outcome = "ack" | "drop" | "clear" | "retry";

/**
 * Local changes not yet acknowledged, sent one PATCH at a time in the order
 * they were made. A network failure keeps the change at the head of the queue
 * and retries it; `pending` holds the newest local value of each queued item
 * so the page can keep showing it over the server's copy.
 */
class ChangeQueue {
  entries: QueueEntry[] = [];
  pending: Record<number, Record<string, unknown>> = {};
  sending = false;
  failed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (entry: QueueEntry) => Promise<Outcome>,
    private readonly onIdle: () => void,
    private readonly changed: () => void
  ) {}

  push(entry: QueueEntry, values: Record<string, unknown>) {
    this.pending[entry.scope] = { ...(this.pending[entry.scope] ?? {}), ...values };
    this.entries.push(entry);
    this.changed();
    // After a network failure the retry timer or a reconnect sends the queue again.
    if (!this.failed) this.pump();
  }

  pump() {
    if (this.sending) return;
    const head = this.entries[0];
    if (!head) {
      this.onIdle();
      return;
    }
    this.sending = true;
    void this.send(head).then((outcome) => {
      this.sending = false;
      if (outcome === "retry") {
        this.failed = true;
        this.changed();
        this.scheduleRetry();
        return;
      }
      this.failed = false;
      if (outcome === "clear") {
        this.clear();
      } else if (this.entries[0] === head) {
        this.entries.shift();
        this.release(head);
      }
      this.changed();
      this.pump();
    });
  }

  /** Forget a sent entry's keys unless a later queued entry carries them too. */
  private release(entry: QueueEntry) {
    const scoped = this.pending[entry.scope];
    if (!scoped) return;
    for (const key of entry.keys) {
      const stillQueued = this.entries.some((other) => other.scope === entry.scope && other.keys.includes(key));
      if (!stillQueued) delete scoped[key];
    }
    if (Object.keys(scoped).length === 0) delete this.pending[entry.scope];
  }

  scheduleRetry() {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.pump();
    }, RETRY_MS);
  }

  retryNow() {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.pump();
  }

  clear() {
    this.entries = [];
    this.pending = {};
  }

  dispose() {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

/** Highlights for items another device changed, each cleared FLASH_MS after its last change. */
class Flasher {
  current: Record<string, string> = {};
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly changed: () => void) {}

  flash(key: string, device: string) {
    const old = this.timers.get(key);
    if (old !== undefined) clearTimeout(old);
    this.current = { ...this.current, [key]: device };
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        const next = { ...this.current };
        delete next[key];
        this.current = next;
        this.changed();
      }, FLASH_MS)
    );
  }

  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

function isSubmittedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.detail === SCORE_ALREADY_SUBMITTED_DETAIL;
}

function isGoneError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || (error.status === 409 && error.detail === NOT_PLAYED_SCORE_DETAIL))
  );
}

function emptyDraft(allianceId: number): AllianceDraft {
  return { alliance_id: allianceId, data: {}, teams: [], item_meta: {}, version: 0, score: 0 };
}

/** Runs `controller.start()` on mount, feeds it socket events and reconnects, and stops it on unmount. */
function useController(
  controller: { start: () => void; stop: () => void; onEvent: (event: RealtimeEvent) => void; reconnected: () => void },
  socket: ScoringSocket
) {
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  const { subscribe, connected } = socket;
  useEffect(() => subscribe(controller.onEvent), [controller, subscribe]);
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current) controller.reconnected();
    wasConnected.current = connected;
  }, [connected, controller]);
}

// ---------------------------------------------------------------- teamwork

export interface UseLiveDraftOptions {
  matchId: number;
  /** The match's session, for reading the official scores once it is submitted. */
  sessionId: number;
  /** This device's name as the server records it ("Admin" for the admin app). */
  myDeviceName: string;
  socketEvents: ScoringSocket;
  request?: ScoringRequest;
  /** The scoresheet's defaults, which `fillDefaults` sends for an alliance nobody has scored. */
  defaults?: ScoresheetValues;
}

export interface LiveDraftState {
  /** The match's drafts with this device's unacknowledged changes on top; null until loaded. */
  draft: MatchDraft | null;
  loading: boolean;
  setItem: (allianceId: number, key: string, value: ScoresheetValue) => void;
  setTeamFlag: (allianceId: number, teamId: number, flag: TeamFlag, value: boolean) => void;
  /** Changes made here and not yet acknowledged by the server. */
  pending: number;
  /** The socket is down or the last PATCH never reached the server. */
  offline: boolean;
  /** `flashKey(allianceId, item)` -> the device that changed it, for FLASH_MS. */
  flashing: Record<string, string>;
  submit: (force?: boolean) => void;
  submitting: boolean;
  submitted: boolean;
  /** The official scores of this match once submitted (null while loading them). */
  saved: AllianceScore[] | null;
  violations: SubmitViolation[] | null;
  /** The alliance Submit was refused for because nobody has scored it yet (409); null otherwise. */
  missingDraft: number | null;
  /** Sends the scoresheet defaults as that alliance's draft (the scorer then presses Submit again). */
  fillDefaults: (allianceId: number) => void;
  /** The match was deleted or marked not played. */
  gone: boolean;
  /** A refused request: the server's text, "" when it gave none; null when nothing failed. */
  error: string | null;
}

function createMatchController(get: () => UseLiveDraftOptions, notify: () => void) {
  const state = {
    alive: false,
    loaded: false,
    server: new Map<number, AllianceDraft>(),
    submitted: false,
    saved: null as AllianceScore[] | null,
    gone: false,
    violations: null as SubmitViolation[] | null,
    missingDraft: null as number | null,
    error: null as string | null,
    submitting: false,
    refetchAfterFlush: false,
    submitAfterFlush: null as boolean | null,
  };
  const request: ScoringRequest = (path, options) => (get().request ?? apiRequest)(path, options);
  const flasher = new Flasher(notify);
  const queue = new ChangeQueue(send, onIdle, notify);

  function displayed(allianceId: number): AllianceDraft {
    return withPending(state.server.get(allianceId) ?? emptyDraft(allianceId), queue.pending[allianceId] ?? {});
  }

  async function send(entry: QueueEntry): Promise<Outcome> {
    const body = entry.teams ? { changes: entry.changes, teams: entry.teams } : { changes: entry.changes };
    try {
      const draft = await request<AllianceDraft>(scoringPaths.allianceDraft(get().matchId, entry.scope), {
        method: "PATCH",
        body,
      });
      const held = state.server.get(draft.alliance_id);
      if (!held || draft.version > held.version) state.server.set(draft.alliance_id, draft);
      return "ack";
    } catch (error) {
      if (isNetworkError(error)) return "retry";
      if (isSubmittedError(error)) {
        void markSubmitted();
        return "clear";
      }
      if (isGoneError(error)) {
        state.gone = true;
        return "clear";
      }
      // Refused (bad value, wrong role): drop it and show the server's copy again.
      state.error = errorText(error) ?? "";
      state.refetchAfterFlush = true;
      return "drop";
    }
  }

  function onIdle() {
    if (!state.alive || state.submitted || state.gone) return;
    if (state.submitAfterFlush !== null) {
      const force = state.submitAfterFlush;
      state.submitAfterFlush = null;
      void postSubmit(force);
      return;
    }
    if (state.refetchAfterFlush) {
      state.refetchAfterFlush = false;
      void load();
    }
  }

  async function load() {
    try {
      const draft = await request<MatchDraft>(scoringPaths.matchDraft(get().matchId));
      if (!state.alive) return;
      state.loaded = true;
      queue.failed = false;
      if (draft.submitted) {
        await markSubmitted();
        return;
      }
      // The server's copy wins; this device's still-queued changes stay on top through `pending`.
      state.server = new Map(draft.alliances.map((alliance) => [alliance.alliance_id, alliance]));
      notify();
    } catch (error) {
      if (!state.alive) return;
      if (isGoneError(error)) {
        state.gone = true;
      } else if (isNetworkError(error)) {
        queue.failed = true;
        state.refetchAfterFlush = true;
        queue.scheduleRetry();
      } else {
        state.error = errorText(error) ?? "";
      }
      notify();
    }
  }

  async function markSubmitted() {
    if (state.submitted) return;
    state.submitted = true;
    state.submitting = false;
    state.violations = null;
    state.submitAfterFlush = null;
    queue.clear();
    notify();
    try {
      const scores = await request<AllianceScore[]>(scoringPaths.sessionScores(get().sessionId));
      state.saved = scores.filter((row) => row.match_id === get().matchId);
      notify();
    } catch {
      // "Saved" still shows; only the totals are missing.
    }
  }

  async function postSubmit(force: boolean) {
    try {
      await request<MatchDraft>(scoringPaths.submit(get().matchId), { method: "POST", body: { force } });
      await markSubmitted();
    } catch (error) {
      state.submitting = false;
      const violations = submitViolations(error);
      const missing = missingDraftAlliance(error);
      if (violations) state.violations = violations;
      // Nothing is saved while any alliance is unscored (two scorers splitting a match); the page names it.
      else if (missing !== null) state.missingDraft = missing;
      else if (isSubmittedError(error)) await markSubmitted();
      else if (isGoneError(error)) state.gone = true;
      else state.error = errorText(error) ?? "";
      notify();
    }
  }

  function incoming(event: ScoreDraftChanged) {
    const { match_id: _matchId, ...draft } = event;
    const held = state.server.get(draft.alliance_id);
    if (draft.version === 0) {
      // A whole-match reset cleared this alliance's draft.
      state.server.set(draft.alliance_id, draft);
      notify();
      return;
    }
    if (held && draft.version <= held.version) return;
    const mine = queue.pending[draft.alliance_id] ?? {};
    for (const key of changedByOthers(held ?? emptyDraft(draft.alliance_id), draft, get().myDeviceName)) {
      if (!(key in mine)) flasher.flash(flashKey(draft.alliance_id, key), draft.item_meta[key].device_name);
    }
    state.server.set(draft.alliance_id, draft);
    notify();
  }

  return {
    start() {
      state.alive = true;
      void load();
    },
    stop() {
      state.alive = false;
      queue.dispose();
      flasher.dispose();
    },
    onEvent(event: RealtimeEvent) {
      const data = event.data as { match_id?: number } | null;
      if (!state.alive || !data || data.match_id !== get().matchId) return;
      if (event.event === "score_draft_changed") incoming(data as ScoreDraftChanged);
      else if (event.event === "match_submitted") void markSubmitted();
      else if (event.event === "match_reset") void load();
    },
    reconnected() {
      state.refetchAfterFlush = true;
      queue.retryNow();
    },
    setItem(allianceId: number, key: string, value: ScoresheetValue) {
      if (state.submitted || state.gone) return;
      state.error = null;
      queue.push({ scope: allianceId, changes: { [key]: value }, keys: [key] }, { [key]: value });
    },
    setTeamFlag(allianceId: number, teamId: number, flag: TeamFlag, value: boolean) {
      if (state.submitted || state.gone) return;
      state.error = null;
      const current = displayed(allianceId).teams.find((team) => team.team_id === teamId) ?? {
        team_id: teamId,
        no_show: false,
        dq: false,
      };
      const key = teamFlagKey(teamId, flag);
      queue.push(
        { scope: allianceId, changes: {}, teams: [{ ...current, [flag]: value }], keys: [key] },
        { [key]: value }
      );
    },
    submit(force = false) {
      if (state.submitted || state.gone || state.submitting) return;
      state.submitting = true;
      state.violations = null;
      state.missingDraft = null;
      state.error = null;
      // Submit only once every change made here has been acknowledged.
      state.submitAfterFlush = force;
      notify();
      queue.pump();
    },
    fillDefaults(allianceId: number) {
      const { defaults } = get();
      if (!defaults || state.submitted || state.gone) return;
      state.missingDraft = null;
      state.error = null;
      queue.push({ scope: allianceId, changes: { ...defaults }, keys: Object.keys(defaults) }, { ...defaults });
    },
    snapshot(connected: boolean): LiveDraftState {
      const ids = [...state.server.keys()].sort((a, b) => a - b);
      return {
        draft: state.loaded ? { match_id: get().matchId, submitted: state.submitted, alliances: ids.map(displayed) } : null,
        loading: !state.loaded && !state.gone,
        setItem: this.setItem,
        setTeamFlag: this.setTeamFlag,
        pending: queue.entries.length,
        offline: !connected || queue.failed,
        flashing: flasher.current,
        submit: this.submit,
        submitting: state.submitting,
        submitted: state.submitted,
        saved: state.saved,
        violations: state.violations,
        missingDraft: state.missingDraft,
        fillDefaults: this.fillDefaults,
        gone: state.gone,
        error: state.error,
      };
    },
  };
}

/**
 * One match's live drafts: every change is sent at once as a PATCH of that
 * item (one in flight, in order), incoming `score_draft_changed` events with
 * a newer version replace an alliance's copy, and items another device
 * changed flash for FLASH_MS. Key the calling component by match id.
 */
export function useLiveDraft(options: UseLiveDraftOptions): LiveDraftState {
  const latest = useRef(options);
  latest.current = options;
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [controller] = useState(() => createMatchController(() => latest.current, rerender));
  useController(controller, options.socketEvents);
  return controller.snapshot(options.socketEvents.connected);
}

// ---------------------------------------------------------------- skills

export interface UseSkillsRunOptions {
  fieldId: number;
  fieldSetId: number;
  myDeviceName: string;
  socketEvents: ScoringSocket;
  request?: ScoringRequest;
  /** The run type's scoresheet defaults, sent for items never touched when Submit is pressed. */
  defaults?: ScoresheetValues;
}

export interface SkillsSaved {
  team_number: string;
  team_name: string;
  skills_type: string;
  score: number;
}

export interface SkillsRunState {
  /** The field set's timer and fields; null until loaded. */
  set: SkillsSet | null;
  /** This field's run with this device's unacknowledged changes on top; null when there is none. */
  run: SkillsRun | null;
  loading: boolean;
  setItem: (key: string, value: ScoresheetValue) => void;
  pending: number;
  offline: boolean;
  /** Item key -> the device that changed it, for FLASH_MS. */
  flashing: Record<string, string>;
  submit: (force?: boolean) => void;
  submitting: boolean;
  /** The run this device submitted last, until the field's next run. */
  saved: SkillsSaved | null;
  violations: SubmitViolation[] | null;
  discard: () => void;
  timerAction: (target: "field" | "set", action: SkillsTimerAction) => void;
  /** The field is no longer a skills field of this set. */
  gone: boolean;
  error: string | null;
}

const RUN_SCOPE = 0;

function createSkillsController(get: () => UseSkillsRunOptions, notify: () => void) {
  const state = {
    alive: false,
    loaded: false,
    set: null as SkillsSet | null,
    run: null as SkillsRun | null,
    saved: null as SkillsSaved | null,
    gone: false,
    violations: null as SubmitViolation[] | null,
    error: null as string | null,
    submitting: false,
    refetchAfterFlush: false,
    submitAfterFlush: null as boolean | null,
  };
  const request: ScoringRequest = (path, options) => (get().request ?? apiRequest)(path, options);
  const flasher = new Flasher(notify);
  const queue = new ChangeQueue(send, onIdle, notify);

  function takeRun(run: SkillsRun | null, fromEvent: boolean) {
    const held = state.run;
    if (run === null || held === null || run.id !== held.id) {
      // A different run (or none): nothing queued belongs to it, and a new run replaces the last "Saved".
      if (run !== null) state.saved = null;
      queue.clear();
      state.run = run;
      return;
    }
    if (run.version < held.version) {
      // An older draft than ours: keep our items, take the timer.
      state.run = { ...run, data: held.data, item_meta: held.item_meta, version: held.version, score: held.score };
      return;
    }
    if (fromEvent && run.version > held.version) {
      const mine = queue.pending[RUN_SCOPE] ?? {};
      for (const key of changedByOthers(held, run, get().myDeviceName)) {
        if (!(key in mine)) flasher.flash(key, run.item_meta[key].device_name);
      }
    }
    state.run = run;
  }

  async function load(fromEvent = false) {
    try {
      const set = await request<SkillsSet>(scoringPaths.skillsSet(get().fieldSetId));
      if (!state.alive) return;
      state.loaded = true;
      queue.failed = false;
      state.set = set;
      const field = set.fields.find((entry) => entry.field_id === get().fieldId);
      if (!field) state.gone = true;
      else takeRun(field.run, fromEvent);
      notify();
    } catch (error) {
      if (!state.alive) return;
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
        state.gone = true;
      } else if (isNetworkError(error)) {
        queue.failed = true;
        state.refetchAfterFlush = true;
        queue.scheduleRetry();
      } else {
        state.error = errorText(error) ?? "";
      }
      notify();
    }
  }

  async function send(entry: QueueEntry): Promise<Outcome> {
    try {
      const run = await request<SkillsRun>(scoringPaths.skillsRunDraft(get().fieldId), {
        method: "PATCH",
        body: { changes: entry.changes },
      });
      if (state.run && run.id === state.run.id && run.version > state.run.version) state.run = run;
      return "ack";
    } catch (error) {
      if (isNetworkError(error)) return "retry";
      state.error = errorText(error) ?? "";
      state.refetchAfterFlush = true;
      // 422: just this change was refused. Anything else: the run is gone (submitted or discarded elsewhere).
      return error instanceof ApiError && error.status === 422 ? "drop" : "clear";
    }
  }

  function onIdle() {
    if (!state.alive || state.gone) return;
    if (state.submitAfterFlush !== null) {
      const force = state.submitAfterFlush;
      state.submitAfterFlush = null;
      void postSubmit(force);
      return;
    }
    if (state.refetchAfterFlush) {
      state.refetchAfterFlush = false;
      void load();
    }
  }

  async function postSubmit(force: boolean) {
    const run = state.run ? withPending(state.run, queue.pending[RUN_SCOPE] ?? {}) : null;
    try {
      await request<unknown>(scoringPaths.skillsRunSubmit(get().fieldId), { method: "POST", body: { force } });
      state.submitting = false;
      if (run) {
        state.saved = {
          team_number: run.team_number,
          team_name: run.team_name,
          skills_type: run.skills_type,
          score: run.score,
        };
      }
      state.run = null;
      notify();
      void load();
    } catch (error) {
      state.submitting = false;
      const violations = submitViolations(error);
      if (violations) state.violations = violations;
      else if (isNetworkError(error)) state.error = "";
      else {
        state.error = errorText(error) ?? "";
        void load();
      }
      notify();
    }
  }

  function displayedRun(): SkillsRun | null {
    return state.run ? withPending(state.run, queue.pending[RUN_SCOPE] ?? {}) : null;
  }

  return {
    start() {
      state.alive = true;
      void load();
    },
    stop() {
      state.alive = false;
      queue.dispose();
      flasher.dispose();
    },
    onEvent(event: RealtimeEvent) {
      const data = event.data as { field_set_id?: number } | null;
      if (!state.alive || event.event !== "skills_run_changed" || !data || data.field_set_id !== get().fieldSetId) return;
      void load(true);
    },
    reconnected() {
      state.refetchAfterFlush = true;
      queue.retryNow();
    },
    setItem(key: string, value: ScoresheetValue) {
      if (!state.run || state.gone) return;
      state.error = null;
      queue.push({ scope: RUN_SCOPE, changes: { [key]: value }, keys: [key] }, { [key]: value });
    },
    submit(force = false) {
      if (!state.run || state.submitting) return;
      state.submitting = true;
      state.violations = null;
      state.error = null;
      const { defaults } = get();
      const shown = displayedRun();
      if (defaults && shown) {
        const missing = Object.fromEntries(Object.entries(defaults).filter(([key]) => !(key in shown.data)));
        const keys = Object.keys(missing);
        if (keys.length > 0) queue.push({ scope: RUN_SCOPE, changes: missing, keys }, missing);
      }
      state.submitAfterFlush = force;
      notify();
      queue.pump();
    },
    discard() {
      void (async () => {
        try {
          await request<void>(scoringPaths.skillsRun(get().fieldId), { method: "DELETE" });
          queue.clear();
          state.run = null;
          state.violations = null;
        } catch (error) {
          state.error = errorText(error) ?? "";
        }
        notify();
        void load();
      })();
    },
    timerAction(target: "field" | "set", action: SkillsTimerAction) {
      const path =
        target === "field"
          ? scoringPaths.skillsRunAction(get().fieldId, action)
          : scoringPaths.setTimer(get().fieldSetId, action);
      void (async () => {
        try {
          await request<unknown>(path, { method: "POST" });
        } catch (error) {
          state.error = errorText(error) ?? "";
          notify();
        }
        void load();
      })();
    },
    snapshot(connected: boolean): SkillsRunState {
      return {
        set: state.set,
        run: displayedRun(),
        loading: !state.loaded && !state.gone,
        setItem: this.setItem,
        pending: queue.entries.length,
        offline: !connected || queue.failed,
        flashing: flasher.current,
        submit: this.submit,
        submitting: state.submitting,
        saved: state.saved,
        violations: state.violations,
        discard: this.discard,
        timerAction: this.timerAction,
        gone: state.gone,
        error: state.error,
      };
    },
  };
}

/** One skills field's run, synced like `useLiveDraft`; refetches its set on `skills_run_changed`. Key the caller by field id. */
export function useSkillsRun(options: UseSkillsRunOptions): SkillsRunState {
  const latest = useRef(options);
  latest.current = options;
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [controller] = useState(() => createSkillsController(() => latest.current, rerender));
  useController(controller, options.socketEvents);
  return controller.snapshot(options.socketEvents.connected);
}
```

Create `frontend/packages/shared/src/scoring/index.ts`:

```ts
export * from "./types";
export * from "./api";
export * from "./mergeDraft";
export * from "./useLiveDraft";
```

In `frontend/packages/shared/src/index.ts`, add after `export * from "./display";`:

```ts
export * from "./scoring";
```

- [ ] **Step 6: Run the tests and type checks**

Run: `cd frontend/packages/shared && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: all pass (the new file's 21 tests included).

Run: `cd frontend/apps/admin && npx tsc -b && cd ../device && npx tsc -b`
Expected: both pass (the new exports clash with nothing either app imports).

- [ ] **Step 7: Commit**

```bash
git add frontend/packages/shared/src/scoring frontend/packages/shared/src/index.ts frontend/packages/shared/tests/scoring.test.tsx
git commit -m "Add shared live draft sync: one PATCH per change sent in order with one in flight, a pending map laid over the server's copy, offline detection with a held queue that flushes and refetches on reconnect, newer-version merging of score_draft_changed with a two-second Changed by flash, Submit with violations and force, a named alliance with no draft and an explicit fill with the default score, Saved and gone states, and the same for one skills run.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Shared live scoring page

**Files:**
- Create: `frontend/packages/shared/src/scoring/ClockControls.tsx`, `frontend/packages/shared/src/scoring/LiveScoringPage.tsx`, `frontend/packages/shared/src/scoring/SkillsRunPanel.tsx`
- Modify: `frontend/packages/shared/src/scoring/index.ts`, `frontend/packages/shared/src/scoresheet/ScoresheetForm.tsx`
- Test: `frontend/packages/shared/tests/scoringT.ts` (test strings), `frontend/packages/shared/tests/LiveScoringPage.test.tsx`, `frontend/packages/shared/tests/SkillsRunPanel.test.tsx`

**Interfaces:**
- Consumes: Task 12 (`useLiveDraft`, `useSkillsRun`, `flashKey`, `teamFlagKey`, `scoringPaths`, `errorText`, the types), the existing match clock endpoints (`POST /api/matches/{id}/{start|start-driver|pause|resume|end}`, `POST /api/matches/{id}/reset` with `{scope: "section" | "full"}`), `ScoresheetForm`, `defaultValues`, `formatClock`, `remainingSeconds`, `LiveMatch`.
- Produces: the missing-draft notice, which names the alliance by colour and team numbers ("Blue 102B has no score yet…") and offers "Use the default score for <alliance>" (`fillDefaults`; a cooperative game fills the lowest alliance, which holds the shared draft); `ClockControls({ match, matchFormat, t, onAction, busy? })`, `ClockMatch`, `isTwoPart(format)`, `useClockNow(intervalMs?)`; `LiveScoringPage(props: LiveScoringPageProps)`, `ScoringTeam`, `ScoringAlliance`; `SkillsRunPanel(props: SkillsRunPanelProps)`; `ScoresheetForm`'s new optional `notes` prop.
- Produces the `scoring.*` translation keys these components call (the caller's `t`); Task 14 adds them to the admin app, the scorer-app spec to the device app. The English values are in `tests/scoringT.ts` below.

> **Plan note:** the skeleton names the whole-match reset scope `match`; the server's `MatchResetRequest` takes `"section" | "full"` (`schemas/match.py`), and Match Control already posts `full`. "Reset entire match timer" posts `{scope: "full"}`.
>
> **Plan note:** `LiveScoringPage` takes, beyond the skeleton's props, `sessionId`, `socketEvents`, `request?` and `onClockChanged?`; `alliances` is `ScoringAlliance[]` (`{alliance_id, station, teams: [{id, number, name}]}`), so the page needs no team lookup of its own. `ClockControls` adds `busy?`. `SkillsRunPanel` takes `{fieldId, fieldSetId, t, myDeviceName, socketEvents, request?, typeLabel?}` and reads the run type's sheet itself (`GET /api/skills/types/{key}/schema`).
>
> **Plan note:** `ScoresheetForm` has no way to mark one field, so it gains an optional `notes` prop (field name → text), shown under the field with `role="status"` and a `scoresheet__row--flash` class on the row. Existing callers are unchanged.
>
> **Plan note:** a cooperative game (`game_model == "cooperative_score"`) shows one "Shared score" column bound to the lowest alliance id (where Task 6 keeps the shared draft), with every team's No-show / DQ toggles; each flag is patched on the team's own alliance, as Task 6's `teams` validation requires. A flag reads as set if any alliance's draft lists it.

- [ ] **Step 1: Write the failing tests**

Create `frontend/packages/shared/tests/scoringT.ts`:

```ts
import type { ScoresheetTranslate } from "../src/scoresheet";

/** The English strings the scoring components use, as the admin app's admin.json carries them. */
const EN: Record<string, string> = {
  "scoresheet.decrease": "Decrease {{label}}",
  "scoresheet.increase": "Increase {{label}}",
  "scoring.loading": "Loading…",
  "scoring.offline": "Offline, changes not saved yet",
  "scoring.reconnecting": "Offline, reconnecting…",
  "scoring.error": "Something went wrong. Try again.",
  "scoring.changedBy": "Changed by {{device}}",
  "scoring.scoreSoFar": "Score so far: {{score}}",
  "scoring.sharedSheet": "Shared score",
  "scoring.alliances": "Alliances",
  "scoring.noShow": "No-show {{team}}",
  "scoring.dq": "DQ {{team}}",
  "scoring.submit": "Submit",
  "scoring.submitting": "Submitting…",
  "scoring.submitAnyway": "Submit anyway",
  "scoring.violationsHeading": "The game's rules found problems:",
  "scoring.savedHeading": "Saved",
  "scoring.gone": "This match is no longer available.",
  "scoring.missingDraft": "{{alliance}} has no score yet. Score it, or use the default score, then Submit again.",
  "scoring.useDefaults": "Use the default score for {{alliance}}",
  "scoring.allianceFallback": "Alliance {{id}}",
  "scoring.station.red": "Red",
  "scoring.station.blue": "Blue",
  "scoring.phase.not_started": "Not started",
  "scoring.phase.autonomous": "Autonomous",
  "scoring.phase.awaiting_driver": "Waiting for driver control",
  "scoring.phase.driver": "Driver control",
  "scoring.phase.ended": "Ended",
  "scoring.clock.heading": "Timer",
  "scoring.clock.start": "Start",
  "scoring.clock.startDriver": "Start driver",
  "scoring.clock.pause": "Pause",
  "scoring.clock.resume": "Resume",
  "scoring.clock.end": "End",
  "scoring.clock.endHeading": "End the match now?",
  "scoring.clock.endNow": "End now",
  "scoring.clock.reset": "Reset timer",
  "scoring.clock.resetHeading": "Reset the timer?",
  "scoring.clock.resetSegment": "Reset current segment",
  "scoring.clock.resetMatch": "Reset entire match timer",
  "scoring.clock.resetWarning": "Resetting the entire match timer also clears the draft scores.",
  "scoring.clock.cancel": "Cancel",
  "scoring.clock.paused": "Paused",
  "scoring.skills.noRun": "No run on this field.",
  "scoring.skills.gone": "This field is no longer a skills field.",
  "scoring.skills.saved": "Saved: {{team}} · {{type}} · {{score}}",
  "scoring.skills.fieldTimer": "Field timer",
  "scoring.skills.setTimer": "Set timer",
  "scoring.skills.followsSet": "Following the set timer",
  "scoring.skills.alone": "On its own timer",
  "scoring.skills.discard": "Discard",
  "scoring.skills.discardHeading": "Discard this run? No attempt is used.",
  "scoring.skills.discardNow": "Discard run",
  "scoring.skills.phase.ready": "Ready",
  "scoring.skills.phase.running": "Running",
  "scoring.skills.phase.ended": "Run over",
};

export const t: ScoresheetTranslate = (key, options) => {
  const template = EN[key] ?? (typeof options?.defaultValue === "string" ? options.defaultValue : key);
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ""));
};
```

Create `frontend/packages/shared/tests/LiveScoringPage.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError, type ApiRequestOptions } from "../src/api-client";
import type { LiveMatch } from "../src/display/types";
import type { RealtimeEvent } from "../src/realtime";
import type { ScoresheetField } from "../src/scoresheet";
import {
  ClockControls,
  LiveScoringPage,
  createScoringHub,
  type AllianceDraft,
  type ScoringAlliance,
  type ScoringMatchFormat,
  type ScoringRequest,
} from "../src/scoring";
import { t } from "./scoringT";

const AT = "2026-10-19T10:00:00Z";
const BALLS: ScoresheetField = {
  name: "balls", label: "Balls", data_type: "integer", widget: "counter", min: 0, max: 10, step: 1,
  options: null, icon: null, scope: "alliance", default: 0,
};
const HEAD_TO_HEAD: ScoringMatchFormat = { game_model: "head_to_head", autonomous_seconds: 15, driver_seconds: 105 };
const ALLIANCES: ScoringAlliance[] = [
  { alliance_id: 11, station: "red", teams: [{ id: 1, number: "101A", name: "Rockets" }] },
  { alliance_id: 12, station: "blue", teams: [{ id: 2, number: "102B", name: "Gears" }] },
];

function liveMatch(overrides: Partial<LiveMatch> = {}): LiveMatch {
  return {
    id: 1, session_id: 5, division_id: null, round_type: "qualification", match_number: 1, label: "Q1",
    field_id: 3, scheduled_time: null, status: "scheduled", phase: "driver",
    phase_deadline: new Date(Date.now() + 60_000).toISOString(), paused: false, remaining_seconds_at_pause: null,
    is_finals: false,
    alliances: [
      { id: 11, station: "red", team_ids: [1] },
      { id: 12, station: "blue", team_ids: [2] },
    ],
    ...overrides,
  };
}

function draft(overrides: Partial<AllianceDraft>): AllianceDraft {
  return { alliance_id: 11, data: {}, teams: [], item_meta: {}, version: 0, score: 0, ...overrides };
}

let drafts: AllianceDraft[];
let scores: unknown[];
let refuse: Record<string, unknown>;
let submitted: boolean;
let request: ReturnType<typeof vi.fn>;
let hub: ReturnType<typeof createScoringHub>;

beforeEach(() => {
  drafts = [draft({ data: { balls: 2 }, version: 2, score: 2 }), draft({ alliance_id: 12 })];
  scores = [];
  refuse = {};
  submitted = false;
  hub = createScoringHub();
  request = vi.fn(async (path: string, options?: ApiRequestOptions) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    if (key in refuse) throw refuse[key];
    if (key === "GET /api/matches/1/draft") return { match_id: 1, submitted: false, alliances: drafts };
    if (key === "GET /api/scores?session_id=5") return scores;
    if (key === "POST /api/matches/1/submit") {
      if (drafts.some((entry) => entry.version === 0)) {
        const missing = drafts.find((entry) => entry.version === 0)?.alliance_id;
        throw new ApiError(409, `Alliance ${missing} has no draft score.`);
      }
      submitted = true;
      return { match_id: 1, submitted: true, alliances: [] };
    }
    const patch = /^PATCH \/api\/matches\/1\/alliances\/(\d+)\/draft$/.exec(key);
    if (patch) {
      const id = Number(patch[1]);
      const held = drafts.find((entry) => entry.alliance_id === id) ?? draft({ alliance_id: id });
      const body = options?.body as { changes: Record<string, number> };
      const next = { ...held, data: { ...held.data, ...body.changes }, version: held.version + 1 };
      drafts = drafts.map((entry) => (entry.alliance_id === id ? next : entry));
      return next;
    }
    return {};
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(overrides: { match?: LiveMatch; format?: ScoringMatchFormat; alliances?: ScoringAlliance[] } = {}) {
  return render(
    <LiveScoringPage
      matchId={1}
      sessionId={5}
      t={t}
      myDeviceName="Admin"
      match={overrides.match ?? liveMatch()}
      alliances={overrides.alliances ?? ALLIANCES}
      schema={[BALLS]}
      matchFormat={overrides.format ?? HEAD_TO_HEAD}
      socketEvents={{ connected: true, subscribe: hub.subscribe }}
      request={request as unknown as ScoringRequest}
    />
  );
}

const emit = (event: RealtimeEvent) => act(() => hub.emit(event));

describe("LiveScoringPage", () => {
  it("shows a column per alliance with its teams and score so far, and sends each change at once", async () => {
    renderPage();
    const red = await screen.findByRole("region", { name: "Red" });
    expect(within(red).getByText("101A Rockets")).toBeInTheDocument();
    expect(within(red).getByText("Score so far: 2")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Blue" })).getByText("102B Gears")).toBeInTheDocument();

    fireEvent.click(within(red).getByRole("button", { name: "Increase Balls" }));
    expect(within(red).getByLabelText("Balls")).toHaveValue("3");
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/api/matches/1/alliances/11/draft", { method: "PATCH", body: { changes: { balls: 3 } } })
    );

    fireEvent.click(within(red).getByLabelText("DQ 101A"));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/api/matches/1/alliances/11/draft", {
        method: "PATCH",
        body: { changes: {}, teams: [{ team_id: 1, no_show: false, dq: true }] },
      })
    );
  });

  it("shows another device's change with Changed by", async () => {
    renderPage();
    const blue = await screen.findByRole("region", { name: "Blue" });
    emit({
      event: "score_draft_changed",
      data: {
        match_id: 1,
        ...draft({ alliance_id: 12, data: { balls: 4 }, item_meta: { balls: { device_name: "Tablet B", at: AT } }, version: 1, score: 4 }),
      },
    });
    expect(within(blue).getByLabelText("Balls")).toHaveValue("4");
    expect(within(blue).getByText("Changed by Tablet B")).toBeInTheDocument();
    expect(within(blue).getByText("Score so far: 4")).toBeInTheDocument();
  });

  it("shows the offline banner while a change can't reach the server and blocks Submit", async () => {
    refuse["PATCH /api/matches/1/alliances/11/draft"] = new TypeError("Failed to fetch");
    renderPage();
    const red = await screen.findByRole("region", { name: "Red" });
    fireEvent.click(within(red).getByRole("button", { name: "Increase Balls" }));
    expect(await screen.findByText("Offline, changes not saved yet")).toBeInTheDocument();
    expect(within(red).getByLabelText("Balls")).toHaveValue("3");
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
  });

  it("lists the plugin's problems per alliance and submits anyway", async () => {
    drafts = [draft({ data: { balls: 2 }, version: 2 }), draft({ alliance_id: 12, data: { balls: 1 }, version: 1 })];
    refuse["POST /api/matches/1/submit"] = new ApiError(422, "", {
      detail: { violations: [{ alliance_id: 12, messages: ["Too many balls"] }] },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Submit" }));
    const problems = await screen.findByRole("alert");
    expect(problems).toHaveTextContent("Blue: Too many balls");
    delete refuse["POST /api/matches/1/submit"];
    scores = [
      { match_id: 1, alliance_id: 11, score: 2, data: {}, teams: [], saved_at: AT },
      { match_id: 1, alliance_id: 12, score: 1, data: {}, teams: [], saved_at: AT },
    ];
    fireEvent.click(within(problems).getByRole("button", { name: "Submit anyway" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/matches/1/submit", { method: "POST", body: { force: true } }));
    const saved = await screen.findByRole("region", { name: "Saved" });
    await waitFor(() => expect(saved).toHaveTextContent("Red 101A: 2"));
    expect(saved).toHaveTextContent("Blue 102B: 1");
  });

  it("names an alliance nobody scored, uses its default score only when asked, then submits", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Submit" }));
    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent("Blue 102B has no score yet.");
    expect(request).not.toHaveBeenCalledWith("/api/matches/1/alliances/12/draft", expect.anything());
    fireEvent.click(within(warning).getByRole("button", { name: "Use the default score for Blue 102B" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/api/matches/1/alliances/12/draft", { method: "PATCH", body: { changes: { balls: 0 } } })
    );
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByRole("region", { name: "Saved" })).toBeInTheDocument();
    expect(submitted).toBe(true);
  });

  it("shows Saved with the official scores when another device submits", async () => {
    scores = [
      { match_id: 1, alliance_id: 11, score: 7, data: {}, teams: [], saved_at: AT },
      { match_id: 1, alliance_id: 12, score: 5, data: {}, teams: [], saved_at: AT },
    ];
    renderPage();
    await screen.findByRole("region", { name: "Red" });
    emit({ event: "match_submitted", data: { match_id: 1 } });
    const saved = await screen.findByRole("region", { name: "Saved" });
    await waitFor(() => expect(saved).toHaveTextContent("Red 101A: 7"));
    expect(screen.queryByRole("button", { name: "Submit" })).not.toBeInTheDocument();
  });

  it("says the match is no longer available when it was marked not played", async () => {
    renderPage({ match: liveMatch({ status: "not_played" }) });
    expect(await screen.findByText("This match is no longer available.")).toBeInTheDocument();
  });

  it("scores one shared sheet for a cooperative game, with every team's flags", async () => {
    renderPage({ format: { game_model: "cooperative_score", autonomous_seconds: 0, driver_seconds: 60 } });
    const shared = await screen.findByRole("region", { name: "Shared score" });
    expect(within(shared).getByLabelText("No-show 101A")).toBeInTheDocument();
    expect(within(shared).getByLabelText("No-show 102B")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Red" })).not.toBeInTheDocument();
    fireEvent.click(within(shared).getByLabelText("No-show 102B"));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/api/matches/1/alliances/12/draft", {
        method: "PATCH",
        body: { changes: {}, teams: [{ team_id: 2, no_show: true, dq: false }] },
      })
    );
  });

  it("shows the alliances as tabs on a narrow screen", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {},
    }));
    renderPage();
    expect(await screen.findByRole("region", { name: "Red" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Blue" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Blue" }));
    expect(screen.getByRole("region", { name: "Blue" })).toBeInTheDocument();
  });

  it("posts clock actions for the match", async () => {
    renderPage({ match: liveMatch({ phase: "awaiting_driver", phase_deadline: null }) });
    const clock = await screen.findByRole("region", { name: "Timer" });
    fireEvent.click(within(clock).getByRole("button", { name: "Start driver" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/matches/1/start-driver", { method: "POST" }));
  });
});

describe("ClockControls", () => {
  function renderClock(match: LiveMatch, format: ScoringMatchFormat) {
    const onAction = vi.fn();
    render(<ClockControls match={match} matchFormat={format} t={t} onAction={onAction} />);
    return onAction;
  }

  it("offers both resets on a two-part match and warns that the whole-match reset clears drafts", () => {
    const onAction = renderClock(liveMatch({ phase: "autonomous" }), HEAD_TO_HEAD);
    fireEvent.click(screen.getByRole("button", { name: "Reset timer" }));
    const choice = screen.getByRole("group", { name: "Reset the timer?" });
    expect(choice).toHaveTextContent("Resetting the entire match timer also clears the draft scores.");
    fireEvent.click(within(choice).getByRole("button", { name: "Reset current segment" }));
    expect(onAction).toHaveBeenLastCalledWith("reset", { scope: "section" });
    fireEvent.click(screen.getByRole("button", { name: "Reset timer" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset entire match timer" }));
    expect(onAction).toHaveBeenLastCalledWith("reset", { scope: "full" });
  });

  it("offers only the whole-match reset on a one-part match", () => {
    renderClock(liveMatch({ phase: "driver" }), { game_model: "cooperative_score", autonomous_seconds: 0, driver_seconds: 60 });
    fireEvent.click(screen.getByRole("button", { name: "Reset timer" }));
    expect(screen.queryByRole("button", { name: "Reset current segment" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset entire match timer" })).toBeInTheDocument();
  });

  it("pauses a running match, resumes a paused one and ends after asking", () => {
    const onAction = renderClock(liveMatch({ phase: "driver" }), HEAD_TO_HEAD);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(onAction).toHaveBeenLastCalledWith("pause", undefined);
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    fireEvent.click(within(screen.getByRole("group", { name: "End the match now?" })).getByRole("button", { name: "End now" }));
    expect(onAction).toHaveBeenLastCalledWith("end", undefined);
  });

  it("shows Resume and the frozen time while paused", () => {
    renderClock(liveMatch({ phase: "driver", paused: true, phase_deadline: null, remaining_seconds_at_pause: 42 }), HEAD_TO_HEAD);
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByTestId("scoring-clock")).toHaveTextContent("0:42");
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });

  it("starts a match that has not started", () => {
    const onAction = renderClock(liveMatch({ phase: "not_started", phase_deadline: null }), HEAD_TO_HEAD);
    expect(screen.getByTestId("scoring-clock")).toHaveTextContent("0:15");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onAction).toHaveBeenLastCalledWith("start", undefined);
    expect(screen.queryByRole("button", { name: "Reset timer" })).not.toBeInTheDocument();
  });
});
```

Create `frontend/packages/shared/tests/SkillsRunPanel.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError, type ApiRequestOptions } from "../src/api-client";
import type { ScoresheetField } from "../src/scoresheet";
import { SkillsRunPanel, createScoringHub, type ScoringRequest, type SkillsRun, type SkillsSet } from "../src/scoring";
import { t } from "./scoringT";

const AT = "2026-10-19T10:00:00Z";
const SCORE: ScoresheetField = {
  name: "score", label: "Score", data_type: "integer", widget: "counter", min: 0, max: 999, step: 1,
  options: null, icon: null, scope: "team", default: 0,
};
const RUN: SkillsRun = {
  id: 40, field_id: 3, field_set_id: 9, team_id: 7, team_number: "101A", team_name: "Rockets", skills_type: "driver",
  data: { score: 4 }, item_meta: { score: { device_name: "Admin", at: AT } }, version: 1, score: 4,
  follows_set: true, phase: "ended", deadline: null, paused: false, remaining_seconds: 0,
};

let run: SkillsRun | null;
let refuse: Record<string, unknown>;
let request: ReturnType<typeof vi.fn>;

function skillsSet(): SkillsSet {
  return {
    timer: { field_set_id: 9, skills_type: "driver", phase: "ended", deadline: null, paused: false, remaining_seconds: 0, run_seconds: 60 },
    fields: [{ field_id: 3, name: "Skills 1", run }],
  };
}

beforeEach(() => {
  run = RUN;
  refuse = {};
  request = vi.fn(async (path: string, options?: ApiRequestOptions) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    if (key in refuse) throw refuse[key];
    if (key === "GET /api/field-sets/9/skills") return skillsSet();
    if (key === "GET /api/skills/types/driver/schema") return [SCORE];
    if (key === "PATCH /api/fields/3/skills-run/draft" && run) {
      const changes = (options?.body as { changes: Record<string, number> }).changes;
      run = { ...run, data: { ...run.data, ...changes }, version: run.version + 1 };
      return run;
    }
    if (key === "POST /api/fields/3/skills-run/submit" || key === "DELETE /api/fields/3/skills-run") {
      run = null;
      return undefined;
    }
    return {};
  });
});

function renderPanel() {
  const hub = createScoringHub();
  render(
    <SkillsRunPanel
      fieldId={3}
      fieldSetId={9}
      t={t}
      myDeviceName="Admin"
      socketEvents={{ connected: true, subscribe: hub.subscribe }}
      request={request as unknown as ScoringRequest}
      typeLabel={(key) => (key === "driver" ? "Driver" : key)}
    />
  );
}

describe("SkillsRunPanel", () => {
  it("shows the team, type and timers and sends a change to the run's draft", async () => {
    renderPanel();
    const panel = await screen.findByRole("region", { name: "Skills 1" });
    expect(within(panel).getByText("101A Rockets · Driver")).toBeInTheDocument();
    expect(within(panel).getByText(/Run over · Following the set timer/)).toBeInTheDocument();
    expect(within(panel).getByRole("group", { name: "Field timer" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Set timer" })).getByRole("button", { name: "Reset timer" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/field-sets/9/skills-timer/reset", { method: "POST" }));
    fireEvent.click(await within(panel).findByRole("button", { name: "Increase Score" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/api/fields/3/skills-run/draft", { method: "PATCH", body: { changes: { score: 5 } } })
    );
  });

  it("lists the problems, submits anyway and shows the saved score", async () => {
    refuse["POST /api/fields/3/skills-run/submit"] = new ApiError(422, "", {
      violations: [{ field: "score", message: "Too high." }],
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Submit" }));
    const problems = await screen.findByRole("alert");
    expect(problems).toHaveTextContent("score: Too high.");
    delete refuse["POST /api/fields/3/skills-run/submit"];
    fireEvent.click(within(problems).getByRole("button", { name: "Submit anyway" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/api/fields/3/skills-run/submit", { method: "POST", body: { force: true } })
    );
    expect(await screen.findByText("Saved: 101A Rockets · Driver · 4")).toBeInTheDocument();
    expect(screen.getByText("No run on this field.")).toBeInTheDocument();
  });

  it("discards the run after asking", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Discard this run? No attempt is used." })).getByRole("button", { name: "Discard run" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/fields/3/skills-run", { method: "DELETE" }));
    expect(await screen.findByText("No run on this field.")).toBeInTheDocument();
    expect(screen.queryByText(/^Saved:/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend/packages/shared && npx vitest run tests/LiveScoringPage.test.tsx tests/SkillsRunPanel.test.tsx`
Expected: FAIL, `LiveScoringPage`, `ClockControls` and `SkillsRunPanel` are not exported from `../src/scoring` (React reports an undefined element type).

- [ ] **Step 3: Let the scoresheet show a note beside a field**

In `frontend/packages/shared/src/scoresheet/ScoresheetForm.tsx`, add the prop to `ScoresheetFormProps` after `errors`:

```tsx
  /** Field name -> a passing note (e.g. "Changed by Tablet 2"), shown beside that field and highlighting its row. */
  notes?: Record<string, string>;
```

and replace the `ScoresheetForm` function with:

```tsx
/** A plugin scoresheet drawn from its field list. Knows nothing about skills or teamwork. */
export function ScoresheetForm({ fields, values, onChange, errors = {}, notes = {}, t, idPrefix }: ScoresheetFormProps) {
  return (
    <div className="scoresheet">
      {fields.map((field) => {
        const id = `${idPrefix}-${field.name}`;
        const error = errors[field.name];
        const errorId = error ? `${id}-error` : undefined;
        const Widget = WIDGETS[field.widget];
        const note = notes[field.name];
        return (
          <div key={field.name} className={note ? "scoresheet__row scoresheet__row--flash" : "scoresheet__row"}>
            <Widget
              field={field}
              value={values[field.name]}
              id={id}
              errorId={errorId}
              t={t}
              onChange={(value) => onChange({ ...values, [field.name]: value })}
            />
            {error && (
              <p className="field__hint field__error" id={errorId}>
                {error}
              </p>
            )}
            {note && (
              <p className="field__hint scoresheet__note" role="status">
                {note}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Write the clock controls**

Create `frontend/packages/shared/src/scoring/ClockControls.tsx`. Start shows before the match starts, Start driver while waiting for driver control, Pause or Resume in an active period, End (asks first) while running, and Reset timer once started. Reset timer asks: on a two-part match (both `autonomous_seconds` and `driver_seconds` above 0) inside a period it offers "Reset current segment" (`section`) and "Reset entire match timer" (`full`); otherwise only the whole-match reset. The warning that the whole-match reset clears the drafts always shows.

```tsx
import { useEffect, useState } from "react";
import { formatClock, remainingSeconds } from "../display/clock";
import type { LiveMatch } from "../display/types";
import type { ScoresheetTranslate } from "../scoresheet";
import type { MatchClockAction, ScoringMatchFormat } from "./types";

/** Phases a segment reset applies to; the server refuses it elsewhere. */
const SECTION_PHASES = new Set(["countdown_autonomous", "autonomous", "countdown_driver", "driver"]);

export type ClockMatch = Pick<
  LiveMatch,
  "id" | "phase" | "phase_deadline" | "paused" | "remaining_seconds_at_pause" | "status"
>;

export interface ClockControlsProps {
  match: ClockMatch;
  matchFormat: ScoringMatchFormat;
  t: ScoresheetTranslate;
  onAction: (action: MatchClockAction, body?: { scope: "section" | "full" }) => void;
  /** Disables the buttons while an action is on its way. */
  busy?: boolean;
}

export function useClockNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** True when the match has an autonomous part and a driver part. */
export function isTwoPart(format: ScoringMatchFormat): boolean {
  return format.autonomous_seconds > 0 && format.driver_seconds > 0;
}

function clockText(match: ClockMatch, format: ScoringMatchFormat, now: number): string {
  if (match.phase === "ended") return formatClock(0);
  if (match.phase === "not_started") {
    return formatClock(format.autonomous_seconds > 0 ? format.autonomous_seconds : format.driver_seconds);
  }
  if (match.phase === "awaiting_driver") return formatClock(format.driver_seconds);
  return formatClock(remainingSeconds(match, now) ?? 0);
}

/** A match's clock with Start / Start driver, Pause / Resume, Reset timer and End, as a scorer or the admin runs it. */
export function ClockControls({ match, matchFormat, t, onAction, busy = false }: ClockControlsProps) {
  const now = useClockNow();
  const [confirming, setConfirming] = useState<"end" | "reset" | null>(null);
  const finished = match.status === "completed" || match.status === "not_played";
  const running = match.phase !== "not_started" && match.phase !== "ended";
  const act = (action: MatchClockAction, body?: { scope: "section" | "full" }) => {
    setConfirming(null);
    onAction(action, body);
  };

  return (
    <section className="clock-controls" role="region" aria-label={t("scoring.clock.heading")}>
      <p className="clock-controls__clock" data-testid="scoring-clock">
        {clockText(match, matchFormat, now)}
      </p>
      <p className="clock-controls__phase">
        {match.paused ? t("scoring.clock.paused") : t(`scoring.phase.${match.phase}`, { defaultValue: match.phase })}
      </p>
      {!finished && (
        <div className="form-actions">
          {match.phase === "not_started" && (
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => act("start")}>
              {t("scoring.clock.start")}
            </button>
          )}
          {match.phase === "awaiting_driver" && (
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => act("start-driver")}>
              {t("scoring.clock.startDriver")}
            </button>
          )}
          {SECTION_PHASES.has(match.phase) &&
            (match.paused ? (
              <button className="btn btn-primary" type="button" disabled={busy} onClick={() => act("resume")}>
                {t("scoring.clock.resume")}
              </button>
            ) : (
              <button className="btn" type="button" disabled={busy} onClick={() => act("pause")}>
                {t("scoring.clock.pause")}
              </button>
            ))}
          {match.phase !== "not_started" && (
            <button className="btn" type="button" disabled={busy} onClick={() => setConfirming("reset")}>
              {t("scoring.clock.reset")}
            </button>
          )}
          {running && (
            <button className="btn btn-danger" type="button" disabled={busy} onClick={() => setConfirming("end")}>
              {t("scoring.clock.end")}
            </button>
          )}
        </div>
      )}
      {confirming === "end" && (
        <div className="clock-controls__confirm" role="group" aria-label={t("scoring.clock.endHeading")}>
          <p>{t("scoring.clock.endHeading")}</p>
          <div className="form-actions">
            <button className="btn btn-danger" type="button" onClick={() => act("end")}>
              {t("scoring.clock.endNow")}
            </button>
            <button className="btn" type="button" onClick={() => setConfirming(null)}>
              {t("scoring.clock.cancel")}
            </button>
          </div>
        </div>
      )}
      {confirming === "reset" && (
        <div className="clock-controls__confirm" role="group" aria-label={t("scoring.clock.resetHeading")}>
          <p>{t("scoring.clock.resetHeading")}</p>
          <div className="form-actions">
            {isTwoPart(matchFormat) && SECTION_PHASES.has(match.phase) && (
              <button className="btn" type="button" onClick={() => act("reset", { scope: "section" })}>
                {t("scoring.clock.resetSegment")}
              </button>
            )}
            <button className="btn btn-danger" type="button" onClick={() => act("reset", { scope: "full" })}>
              {t("scoring.clock.resetMatch")}
            </button>
            <button className="btn" type="button" onClick={() => setConfirming(null)}>
              {t("scoring.clock.cancel")}
            </button>
          </div>
          <p className="field__hint">{t("scoring.clock.resetWarning")}</p>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Write the live scoring page**

Create `frontend/packages/shared/src/scoring/LiveScoringPage.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api-client";
import type { LiveMatch } from "../display/types";
import {
  ScoresheetForm,
  defaultValues,
  type ScoresheetField,
  type ScoresheetTranslate,
  type ScoresheetValues,
} from "../scoresheet";
import { errorText, scoringPaths } from "./api";
import { ClockControls } from "./ClockControls";
import { teamFlagKey } from "./mergeDraft";
import { flashKey, useLiveDraft } from "./useLiveDraft";
import type {
  AllianceDraft,
  MatchClockAction,
  ScoringMatchFormat,
  ScoringRequest,
  ScoringSocket,
  SubmitViolation,
  TeamFlag,
} from "./types";

export interface ScoringTeam {
  id: number;
  number: string;
  name: string;
}

export interface ScoringAlliance {
  alliance_id: number;
  station: string;
  teams: ScoringTeam[];
}

export interface LiveScoringPageProps {
  matchId: number;
  sessionId: number;
  t: ScoresheetTranslate;
  myDeviceName: string;
  /** The match as GET /api/matches/{id} returns it; the caller keeps it current from match events. */
  match: LiveMatch;
  alliances: ScoringAlliance[];
  schema: ScoresheetField[];
  matchFormat: ScoringMatchFormat;
  socketEvents: ScoringSocket;
  request?: ScoringRequest;
  /** Called after a clock action succeeds, so the caller can refetch the match. */
  onClockChanged?: () => void;
}

const NARROW_QUERY = "(max-width: 719px)";

/** True under 720 px wide, where alliances become tabs. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

interface Sheet {
  allianceId: number;
  title: string;
  teams: (ScoringTeam & { allianceId: number })[];
}

/**
 * Live scoring for one teamwork match: one column per alliance (tabs on a
 * narrow screen), each change saved at once as a draft, clock controls, and
 * Submit. Cooperative games score one shared sheet. Key it by match id.
 */
export function LiveScoringPage({
  matchId,
  sessionId,
  t,
  myDeviceName,
  match,
  alliances,
  schema,
  matchFormat,
  socketEvents,
  request,
  onClockChanged,
}: LiveScoringPageProps) {
  const cooperative = matchFormat.game_model === "cooperative_score";
  const defaults = useMemo(() => defaultValues(schema), [schema]);
  const live = useLiveDraft({ matchId, sessionId, myDeviceName, socketEvents, request, defaults });
  const narrow = useNarrow();
  const [tab, setTab] = useState(0);
  const [clockBusy, setClockBusy] = useState(false);
  const [clockError, setClockError] = useState<string | null>(null);

  const stationLabel = (station: string) => t(`scoring.station.${station}`, { defaultValue: station });
  const ordered = [...alliances].sort((a, b) => a.alliance_id - b.alliance_id);
  const sheets: Sheet[] = cooperative
    ? [
        {
          allianceId: ordered[0]?.alliance_id ?? 0,
          title: t("scoring.sharedSheet"),
          teams: ordered.flatMap((alliance) => alliance.teams.map((team) => ({ ...team, allianceId: alliance.alliance_id }))),
        },
      ]
    : alliances.map((alliance) => ({
        allianceId: alliance.alliance_id,
        title: stationLabel(alliance.station),
        teams: alliance.teams.map((team) => ({ ...team, allianceId: alliance.alliance_id })),
      }));

  const runClock = async (action: MatchClockAction, body?: { scope: "section" | "full" }) => {
    setClockBusy(true);
    setClockError(null);
    try {
      await (request ?? apiRequest)(scoringPaths.matchAction(matchId, action), body ? { method: "POST", body } : { method: "POST" });
      onClockChanged?.();
    } catch (error) {
      setClockError(errorText(error) ?? t("scoring.error"));
    } finally {
      setClockBusy(false);
    }
  };

  if (live.gone || match.status === "not_played") {
    return (
      <p className="alert alert-warning" role="status">
        {t("scoring.gone")}
      </p>
    );
  }

  if (live.submitted) {
    return (
      <section className="panel scoring__saved" role="region" aria-label={t("scoring.savedHeading")}>
        <h2>{t("scoring.savedHeading")}</h2>
        <ul className="list-plain">
          {alliances.map((alliance) => (
            <li key={alliance.alliance_id}>
              {`${stationLabel(alliance.station)} ${alliance.teams.map((team) => team.number).join(" ")}: `}
              <strong>{live.saved?.find((row) => row.alliance_id === alliance.alliance_id)?.score ?? "–"}</strong>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  if (live.draft === null) return <p>{t("scoring.loading")}</p>;

  const draftFor = (allianceId: number): AllianceDraft =>
    live.draft?.alliances.find((alliance) => alliance.alliance_id === allianceId) ?? {
      alliance_id: allianceId,
      data: {},
      teams: [],
      item_meta: {},
      version: 0,
      score: 0,
    };
  const flagOf = (teamId: number, flag: TeamFlag): boolean =>
    live.draft?.alliances.some((alliance) => alliance.teams.some((team) => team.team_id === teamId && team[flag])) ?? false;
  const flagFlash = (teamId: number, flag: TeamFlag): string | undefined =>
    Object.entries(live.flashing).find(([key]) => key.endsWith(`:${teamFlagKey(teamId, flag)}`))?.[1];
  const violationLabel = (violation: SubmitViolation) => {
    const alliance = alliances.find((entry) => entry.alliance_id === violation.alliance_id);
    return alliance ? stationLabel(alliance.station) : t("scoring.sharedSheet");
  };
  /** An alliance named the way scorers know it: colour and team numbers. */
  const allianceName = (allianceId: number) => {
    const alliance = alliances.find((entry) => entry.alliance_id === allianceId);
    if (!alliance) return t("scoring.allianceFallback", { id: allianceId });
    return `${stationLabel(alliance.station)} ${alliance.teams.map((team) => team.number).join(" ")}`.trim();
  };
  const visible = narrow && sheets.length > 1 ? [sheets[Math.min(tab, sheets.length - 1)]] : sheets;

  return (
    <div className="scoring">
      <ClockControls match={match} matchFormat={matchFormat} t={t} busy={clockBusy} onAction={(a, b) => void runClock(a, b)} />
      {clockError && (
        <p className="alert alert-danger" role="alert">
          {clockError}
        </p>
      )}
      {live.offline && (
        <p className="alert alert-warning" role="status">
          {live.pending > 0 ? t("scoring.offline") : t("scoring.reconnecting")}
        </p>
      )}
      {live.error !== null && (
        <p className="alert alert-danger" role="alert">
          {live.error || t("scoring.error")}
        </p>
      )}
      {narrow && sheets.length > 1 && (
        <div className="division-tabs" role="tablist" aria-label={t("scoring.alliances")}>
          {sheets.map((sheet, index) => (
            <button
              key={sheet.allianceId}
              type="button"
              role="tab"
              className="division-tabs__tab"
              aria-selected={index === Math.min(tab, sheets.length - 1)}
              onClick={() => setTab(index)}
            >
              {sheet.title}
            </button>
          ))}
        </div>
      )}
      <div className="scoring__columns">
        {visible.map((sheet) => {
          const draft = draftFor(sheet.allianceId);
          const values: ScoresheetValues = { ...defaults, ...draft.data };
          const notes: Record<string, string> = {};
          for (const field of schema) {
            const device = live.flashing[flashKey(sheet.allianceId, field.name)];
            if (device) notes[field.name] = t("scoring.changedBy", { device });
          }
          return (
            <section key={sheet.allianceId} className="panel scoring__column" role="region" aria-label={sheet.title}>
              <h2>{sheet.title}</h2>
              <p className="scoring__total">{t("scoring.scoreSoFar", { score: draft.score })}</p>
              <ul className="list-plain scoring__teams">
                {sheet.teams.map((team) => (
                  <li key={team.id}>
                    <span className="scoring__team">{`${team.number} ${team.name}`}</span>
                    {(["no_show", "dq"] as const).map((flag) => {
                      const device = flagFlash(team.id, flag);
                      return (
                        <span key={flag} className={device ? "scoring__flag scoring__flag--flash" : "scoring__flag"}>
                          <label className="choice">
                            <input
                              type="checkbox"
                              checked={flagOf(team.id, flag)}
                              onChange={(event) => live.setTeamFlag(team.allianceId, team.id, flag, event.target.checked)}
                            />{" "}
                            {t(flag === "no_show" ? "scoring.noShow" : "scoring.dq", { team: team.number })}
                          </label>
                          {device && (
                            <span className="field__hint scoresheet__note" role="status">
                              {t("scoring.changedBy", { device })}
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </li>
                ))}
              </ul>
              <ScoresheetForm
                fields={schema}
                values={values}
                notes={notes}
                t={t}
                idPrefix={`alliance-${sheet.allianceId}`}
                onChange={(next) => {
                  for (const field of schema) {
                    if (next[field.name] !== values[field.name]) live.setItem(sheet.allianceId, field.name, next[field.name]);
                  }
                }}
              />
            </section>
          );
        })}
      </div>
      {live.missingDraft !== null && (
        <div className="alert alert-warning" role="alert">
          <p>{t("scoring.missingDraft", { alliance: allianceName(live.missingDraft) })}</p>
          <button
            className="btn"
            type="button"
            onClick={() => live.fillDefaults(cooperative ? (ordered[0]?.alliance_id ?? live.missingDraft ?? 0) : (live.missingDraft ?? 0))}
          >
            {t("scoring.useDefaults", { alliance: allianceName(live.missingDraft) })}
          </button>
        </div>
      )}
      {live.violations && (
        <div className="alert alert-danger" role="alert">
          <p>{t("scoring.violationsHeading")}</p>
          <ul>
            {live.violations.map((violation) => (
              <li key={String(violation.alliance_id)}>{`${violationLabel(violation)}: ${violation.messages.join(" ")}`}</li>
            ))}
          </ul>
          <button className="btn btn-danger" type="button" disabled={live.submitting} onClick={() => live.submit(true)}>
            {t("scoring.submitAnyway")}
          </button>
        </div>
      )}
      <div className="form-actions">
        <button
          className="btn btn-primary btn-large"
          type="button"
          disabled={live.pending > 0 || live.submitting || live.offline}
          onClick={() => live.submit()}
        >
          {live.submitting ? t("scoring.submitting") : t("scoring.submit")}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Write the skills run panel**

Create `frontend/packages/shared/src/scoring/SkillsRunPanel.tsx`. The field timer's buttons always show (the server makes the first one take the run off the set); the set timer's show only while the run follows the set.

```tsx
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api-client";
import { formatClock } from "../display/clock";
import { ScoresheetForm, defaultValues, type ScoresheetField, type ScoresheetTranslate } from "../scoresheet";
import { scoringPaths } from "./api";
import { useClockNow } from "./ClockControls";
import { useSkillsRun } from "./useLiveDraft";
import type { ScoringRequest, ScoringSocket, SkillsPhase, SkillsTimerAction } from "./types";

export interface SkillsRunPanelProps {
  fieldId: number;
  fieldSetId: number;
  t: ScoresheetTranslate;
  myDeviceName: string;
  socketEvents: ScoringSocket;
  request?: ScoringRequest;
  /** A skills type's label (the plugin's), else its key is shown. */
  typeLabel?: (key: string) => string;
}

function timerSeconds(
  timer: { phase: SkillsPhase; deadline: string | null; paused: boolean; remaining_seconds: number | null },
  fullLength: number | null,
  now: number
): number {
  if (timer.phase === "ended") return 0;
  if (timer.paused || timer.deadline === null) return timer.remaining_seconds ?? fullLength ?? 0;
  return Math.max(0, (Date.parse(timer.deadline) - now) / 1000);
}

function TimerButtons({
  label,
  phase,
  paused,
  t,
  onAction,
}: {
  label: string;
  phase: SkillsPhase;
  paused: boolean;
  t: ScoresheetTranslate;
  onAction: (action: SkillsTimerAction) => void;
}) {
  return (
    <div className="form-actions" role="group" aria-label={label}>
      {phase === "ready" && (
        <button className="btn btn-primary" type="button" onClick={() => onAction("start")}>
          {t("scoring.clock.start")}
        </button>
      )}
      {phase === "running" &&
        (paused ? (
          <button className="btn btn-primary" type="button" onClick={() => onAction("resume")}>
            {t("scoring.clock.resume")}
          </button>
        ) : (
          <button className="btn" type="button" onClick={() => onAction("pause")}>
            {t("scoring.clock.pause")}
          </button>
        ))}
      {phase === "running" && (
        <button className="btn" type="button" onClick={() => onAction("end")}>
          {t("scoring.clock.end")}
        </button>
      )}
      {phase !== "ready" && (
        <button className="btn" type="button" onClick={() => onAction("reset")}>
          {t("scoring.clock.reset")}
        </button>
      )}
    </div>
  );
}

/** One skills field's run: team, type, the field's and the set's timers, the sheet, Submit and Discard. Key it by field id. */
export function SkillsRunPanel({
  fieldId,
  fieldSetId,
  t,
  myDeviceName,
  socketEvents,
  request,
  typeLabel = (key) => key,
}: SkillsRunPanelProps) {
  const [schema, setSchema] = useState<ScoresheetField[]>([]);
  const defaults = useMemo(() => defaultValues(schema), [schema]);
  const live = useSkillsRun({ fieldId, fieldSetId, myDeviceName, socketEvents, request, defaults });
  const now = useClockNow();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const skillsType = live.run?.skills_type ?? null;

  useEffect(() => {
    if (skillsType === null) return undefined;
    let cancelled = false;
    void (request ?? apiRequest)<ScoresheetField[]>(scoringPaths.skillsSchema(skillsType))
      .then((fields) => {
        if (!cancelled) setSchema(fields);
      })
      .catch(() => {
        // The sheet stays empty; the error banner of the next request explains more.
      });
    return () => {
      cancelled = true;
    };
  }, [skillsType, request]);

  const field = live.set?.fields.find((entry) => entry.field_id === fieldId);
  const title = field?.name ?? t("scoring.loading");
  const run = live.run;
  const timer = live.set?.timer ?? null;

  return (
    <section className="panel skills-run" role="region" aria-label={title}>
      <h2>{title}</h2>
      {live.offline && (
        <p className="alert alert-warning" role="status">
          {live.pending > 0 ? t("scoring.offline") : t("scoring.reconnecting")}
        </p>
      )}
      {live.error !== null && (
        <p className="alert alert-danger" role="alert">
          {live.error || t("scoring.error")}
        </p>
      )}
      {live.gone ? (
        <p role="status">{t("scoring.skills.gone")}</p>
      ) : live.loading ? (
        <p>{t("scoring.loading")}</p>
      ) : run === null ? (
        <>
          {live.saved && (
            <p className="alert alert-success" role="status">
              {t("scoring.skills.saved", {
                team: `${live.saved.team_number} ${live.saved.team_name}`,
                type: typeLabel(live.saved.skills_type),
                score: live.saved.score,
              })}
            </p>
          )}
          <p>{t("scoring.skills.noRun")}</p>
        </>
      ) : (
        <>
          <p className="skills-run__team">{`${run.team_number} ${run.team_name} · ${typeLabel(run.skills_type)}`}</p>
          <p className="clock-controls__clock" data-testid="skills-clock">
            {formatClock(timerSeconds(run, run.follows_set ? (timer?.run_seconds ?? null) : null, now))}
          </p>
          <p>
            {run.paused ? t("scoring.clock.paused") : t(`scoring.skills.phase.${run.phase}`)}
            {" · "}
            {run.follows_set ? t("scoring.skills.followsSet") : t("scoring.skills.alone")}
          </p>
          <TimerButtons
            label={t("scoring.skills.fieldTimer")}
            phase={run.phase}
            paused={run.paused}
            t={t}
            onAction={(action) => live.timerAction("field", action)}
          />
          {run.follows_set && timer && (
            <TimerButtons
              label={t("scoring.skills.setTimer")}
              phase={timer.phase}
              paused={timer.paused}
              t={t}
              onAction={(action) => live.timerAction("set", action)}
            />
          )}
          <p className="scoring__total">{t("scoring.scoreSoFar", { score: run.score })}</p>
          <ScoresheetForm
            fields={schema}
            values={{ ...defaults, ...run.data }}
            notes={Object.fromEntries(
              Object.entries(live.flashing).map(([key, device]) => [key, t("scoring.changedBy", { device })])
            )}
            t={t}
            idPrefix={`skills-${fieldId}`}
            onChange={(next) => {
              const current = { ...defaults, ...run.data };
              for (const entry of schema) {
                if (next[entry.name] !== current[entry.name]) live.setItem(entry.name, next[entry.name]);
              }
            }}
          />
          {live.violations && (
            <div className="alert alert-danger" role="alert">
              <p>{t("scoring.violationsHeading")}</p>
              <ul>
                {live.violations.flatMap((violation) => violation.messages).map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
              <button className="btn btn-danger" type="button" disabled={live.submitting} onClick={() => live.submit(true)}>
                {t("scoring.submitAnyway")}
              </button>
            </div>
          )}
          <div className="form-actions">
            <button
              className="btn btn-primary"
              type="button"
              disabled={live.pending > 0 || live.submitting || live.offline}
              onClick={() => live.submit()}
            >
              {live.submitting ? t("scoring.submitting") : t("scoring.submit")}
            </button>
            <button className="btn" type="button" onClick={() => setConfirmDiscard(true)}>
              {t("scoring.skills.discard")}
            </button>
          </div>
          {confirmDiscard && (
            <div className="clock-controls__confirm" role="group" aria-label={t("scoring.skills.discardHeading")}>
              <p>{t("scoring.skills.discardHeading")}</p>
              <div className="form-actions">
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={() => {
                    setConfirmDiscard(false);
                    live.discard();
                  }}
                >
                  {t("scoring.skills.discardNow")}
                </button>
                <button className="btn" type="button" onClick={() => setConfirmDiscard(false)}>
                  {t("scoring.clock.cancel")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
```

Replace `frontend/packages/shared/src/scoring/index.ts` with:

```ts
export * from "./types";
export * from "./api";
export * from "./mergeDraft";
export * from "./useLiveDraft";
export * from "./ClockControls";
export * from "./LiveScoringPage";
export * from "./SkillsRunPanel";
```

- [ ] **Step 7: Run the tests and type checks**

Run: `cd frontend/packages/shared && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: all pass.

Run: `cd frontend/apps/admin && npx tsc -b && cd ../device && npx tsc -b`
Expected: both pass.

- [ ] **Step 8: Commit**

```bash
git add frontend/packages/shared/src/scoring frontend/packages/shared/src/scoresheet/ScoresheetForm.tsx frontend/packages/shared/tests/scoringT.ts frontend/packages/shared/tests/LiveScoringPage.test.tsx frontend/packages/shared/tests/SkillsRunPanel.test.tsx
git commit -m "Add the shared live scoring page: a column per alliance (tabs under 720 px, one shared sheet for cooperative games) with No-show and DQ toggles and the score so far, Changed by notes beside fields another device changed, the offline banner, Submit with per-alliance problems and Submit anyway, the notice naming an alliance nobody scored with its Use the default score button, the Saved and no-longer-available views, clock controls with the two reset choices and the drafts-cleared warning, and a skills run panel with field and set timers, Submit and Discard.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Admin scoring, correction and Match Control controls

**Files:**
- Create: `frontend/apps/admin/src/routes/MatchScoringRoute.tsx`, `frontend/apps/admin/src/matchScoring/SubmittedScores.tsx`
- Modify: `frontend/apps/admin/src/router.tsx`, `frontend/apps/admin/src/types.ts`, `frontend/apps/admin/src/displays/types.ts`, `frontend/apps/admin/src/routes/SessionMatchesRoute.tsx`, `frontend/apps/admin/src/routes/MatchControlRoute.tsx`, `frontend/apps/admin/src/matchControl/useMatchControl.ts`, `frontend/apps/admin/src/styles/components.css`, `frontend/apps/admin/src/i18n/en/admin.json`, `frontend/apps/admin/src/i18n/zh/admin.json`
- Test: `frontend/apps/admin/tests/unit/MatchScoringRoute.test.tsx` (new); extend `frontend/apps/admin/tests/unit/MatchControlRoute.test.tsx` and `frontend/apps/admin/tests/unit/SessionMatchesRoute.test.tsx`

**Interfaces:**
- Consumes: Task 13 (`LiveScoringPage`, `ScoringAlliance`), Task 2 (`FieldSetRead.purpose: "teamwork" | "skills"` on `GET /api/field-sets`, which the server does not filter), Task 12 (`createScoringHub`, `submitViolations`, `ScoringMatchFormat`, `TeamFlags`, `TeamFlag`), Task 2 (`SessionRead.live_scores_qualification` / `live_scores_finals`, accepted by `PATCH /api/sessions/{id}`), Task 8 (`match_submitted`), the existing `GET /api/matches/{id}`, `GET /api/event/scoresheet-schema`, `GET /api/event/match-format`, `GET /api/scores?session_id=`, `POST /api/matches/{id}/alliances/{aid}/score` (`{data, teams, force}`; admins may overwrite).
- Produces: route `/sessions/:sessionId/matches/:matchId/score` (`MatchScoringRoute`, a child of the session layout, so the Matches tab stays highlighted); `SubmittedScores`; Matches page "Score" / "View score" column; Match Control "Score" link, "Hide live scores" / "Show live scores" toggle, Match Control listing teamwork field sets only, `FieldSetLiveRead.purpose`, `useMatchControlData(...).sessions`, `useMatchControlActions().setLiveScores`, `LiveScoresSwitch`; i18n `scoring.*`, `matchScoring.*`, `sessions.matches.{columnScore,score,viewScore}`, `matchControl.{score,hideLive,showLive,scoreSaved}`.

> **Plan note:** `SessionRead.live_scores_qualification` / `live_scores_finals` are added as optional here (missing → the server defaults, on / off), because a dozen existing test fixtures type a `SessionRead` without them. Task 16 may make them required and update those fixtures.
>
> **Plan note:** Match Control reads `GET /api/field-sets` unfiltered, so it filters out `purpose == "skills"` sets itself (they are run from Skills Control); a session with only skills sets shows the existing "no fields" line. `purpose` is added to `FieldSetLiveRead` in `src/displays/types.ts`, the type only Match Control uses. The `FieldSetRead` in `src/types.ts` gains `purpose` in Task 15 (with its fixtures); Task 16's Fields page reads it.
>
> **Plan note:** the route passes `request={apiRequest}` to `LiveScoringPage` explicitly: the shared page's own fallback imports `apiRequest` from inside the package, which the admin tests' `vi.mock("@tournament-admin/shared")` does not replace. The admin's device name for drafts is `"Admin"`, as the server records it, so two admin browsers don't flash each other's changes (the spec's rule compares device names).
>
> **Plan note:** a match counts as submitted when every alliance has an official score in `GET /api/scores`. After a Submit (here or on a tablet), `match_submitted` refetches the scores and the route swaps the live page for `SubmittedScores`: the official scores, read-only, with "Correct score". A correction posts each alliance in order; a cooperative game edits one shared sheet and posts it to every alliance with that alliance's own flags. Match Control's ended-match line now reads "Score saved." once the match is completed instead of waiting forever.

- [ ] **Step 1: Write the failing tests**

Create `frontend/apps/admin/tests/unit/MatchScoringRoute.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { ApiError, initI18n, type LiveMatch, type RealtimeEvent } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { MatchScoringRoute } from "../../src/routes/MatchScoringRoute";
import type { SessionRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

const AT = "2026-10-19T10:00:00Z";
const SESSION: SessionRead = {
  id: 1, event_id: 1, label: "Saturday", session_date: "2026-11-07", timezone: null, has_scored_matches: false,
  qualification_finalized_at: null, qualification_drops: null,
};
const SCHEMA = [
  {
    name: "balls", label: "Balls", data_type: "integer", widget: "counter", min: 0, max: 10, step: 1,
    options: null, icon: null, scope: "alliance", default: 0,
  },
];

let match: LiveMatch | ApiError;
let scores: Record<string, unknown>[];
let format: Record<string, unknown>;
let refuse: Record<string, unknown>;
let onEvent: ((event: RealtimeEvent) => void) | undefined;

function liveMatch(overrides: Partial<LiveMatch> = {}): LiveMatch {
  return {
    id: 7, session_id: 1, division_id: null, round_type: "qualification", match_number: 7, label: "Q7",
    field_id: 3, scheduled_time: null, status: "scheduled", phase: "driver",
    phase_deadline: new Date(Date.now() + 60_000).toISOString(), paused: false, remaining_seconds_at_pause: null,
    is_finals: false,
    alliances: [
      { id: 71, station: "red", team_ids: [1] },
      { id: 72, station: "blue", team_ids: [2] },
    ],
    ...overrides,
  };
}

function stub() {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    if (key in refuse) throw refuse[key];
    if (key === "GET /api/matches/7") {
      if (match instanceof ApiError) throw match;
      return match as never;
    }
    const routes: Record<string, unknown> = {
      "GET /api/teams": [
        { id: 1, number: "101A", name: "Rockets", division_id: null },
        { id: 2, number: "102B", name: "Gears", division_id: null },
      ],
      "GET /api/event/scoresheet-schema": SCHEMA,
      "GET /api/event/match-format": format,
      "GET /api/scores?session_id=1": scores,
      "GET /api/matches/7/draft": {
        match_id: 7,
        submitted: false,
        alliances: [
          { alliance_id: 71, data: { balls: 2 }, teams: [], item_meta: {}, version: 2, score: 2 },
          { alliance_id: 72, data: {}, teams: [], item_meta: {}, version: 0, score: 0 },
        ],
      },
    };
    if (key in routes) return routes[key] as never;
    if (key.startsWith("PATCH /api/matches/7/alliances/")) {
      const allianceId = Number(key.split("/")[5]);
      const changes = (options?.body as { changes: Record<string, unknown> }).changes;
      return { alliance_id: allianceId, data: changes, teams: [], item_meta: {}, version: 3, score: 0 } as never;
    }
    if (options?.method && options.method !== "GET") return {} as never;
    throw new Error(`unexpected request: ${key}`);
  });
}

function SessionOutlet() {
  return <Outlet context={{ session: SESSION }} />;
}

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: "/sessions/:sessionId",
        element: <SessionOutlet />,
        children: [
          { path: "matches/:matchId/score", element: <MatchScoringRoute /> },
          { path: "matches", element: <p>Matches list</p> },
        ],
      },
    ],
    { initialEntries: ["/sessions/1/matches/7/score"] }
  );
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  match = liveMatch();
  scores = [];
  format = { game_model: "head_to_head", autonomous_seconds: 15, driver_seconds: 105 };
  refuse = {};
  onEvent = undefined;
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockImplementation((options) => {
    onEvent = options.onEvent;
    return { connected: true };
  });
  stub();
});

describe("MatchScoringRoute", () => {
  it("scores an unsubmitted match live on the active-session channel", async () => {
    renderRoute();
    const red = await screen.findByRole("region", { name: "Red" });
    expect(screen.getByRole("heading", { name: "Score Q7" })).toBeInTheDocument();
    expect(vi.mocked(useRealtimeChannel).mock.calls[0][0].path).toBe("/ws/active-session");
    fireEvent.click(within(red).getByRole("button", { name: "Increase Balls" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/matches/7/alliances/71/draft", { method: "PATCH", body: { changes: { balls: 3 } } })
    );

    const blue = screen.getByRole("region", { name: "Blue" });
    act(() =>
      onEvent?.({
        event: "score_draft_changed",
        data: {
          match_id: 7, alliance_id: 72, data: { balls: 5 }, teams: [],
          item_meta: { balls: { device_name: "Field 2 tablet", at: AT } }, version: 1, score: 5,
        },
      })
    );
    expect(within(blue).getByText("Changed by Field 2 tablet")).toBeInTheDocument();
  });

  it("refetches the match on its clock events", async () => {
    renderRoute();
    await screen.findByRole("region", { name: "Red" });
    match = liveMatch({ paused: true, phase_deadline: null, remaining_seconds_at_pause: 30 });
    act(() => onEvent?.({ event: "match_paused", data: { match_id: 7 } }));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("shows a submitted match read-only and corrects it through the score endpoint", async () => {
    match = liveMatch({ status: "completed", phase: "ended", phase_deadline: null });
    scores = [
      { match_id: 7, alliance_id: 71, score: 6, data: { balls: 6 }, teams: [], saved_at: AT },
      { match_id: 7, alliance_id: 72, score: 1, data: { balls: 1 }, teams: [{ team_id: 2, no_show: false, dq: true }], saved_at: AT },
    ];
    stub();
    renderRoute();
    const red = await screen.findByRole("region", { name: "Red" });
    expect(red).toHaveTextContent("Score: 6");
    expect(screen.getByRole("region", { name: "Blue" })).toHaveTextContent("102B (DQ)");
    expect(screen.queryByRole("button", { name: "Submit" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Correct score" }));
    const editRed = screen.getByRole("region", { name: "Red" });
    fireEvent.click(within(editRed).getByRole("button", { name: "Increase Balls" }));
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/matches/7/alliances/72/score", {
        method: "POST",
        body: { data: { balls: 1 }, teams: [{ team_id: 2, no_show: false, dq: true }], force: false },
      })
    );
    expect(apiRequest).toHaveBeenCalledWith("/api/matches/7/alliances/71/score", {
      method: "POST",
      body: { data: { balls: 7 }, teams: [], force: false },
    });
    expect(await screen.findByText("Score corrected.")).toBeInTheDocument();
  });

  it("shows the rules' problems on a correction and saves anyway", async () => {
    match = liveMatch({ status: "completed", phase: "ended", phase_deadline: null });
    scores = [
      { match_id: 7, alliance_id: 71, score: 6, data: { balls: 6 }, teams: [], saved_at: AT },
      { match_id: 7, alliance_id: 72, score: 1, data: { balls: 1 }, teams: [], saved_at: AT },
    ];
    refuse["POST /api/matches/7/alliances/71/score"] = new ApiError(422, "", { detail: { violations: ["balls look wrong"] } });
    stub();
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "Correct score" }));
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    const problems = await screen.findByRole("alert");
    expect(problems).toHaveTextContent("balls look wrong");
    delete refuse["POST /api/matches/7/alliances/71/score"];
    fireEvent.click(within(problems).getByRole("button", { name: "Save anyway" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/matches/7/alliances/71/score", {
        method: "POST",
        body: { data: { balls: 6 }, teams: [], force: true },
      })
    );
  });

  it("corrects a cooperative match's shared sheet on every alliance", async () => {
    format = { game_model: "cooperative_score", autonomous_seconds: 0, driver_seconds: 60 };
    match = liveMatch({ status: "completed", phase: "ended", phase_deadline: null });
    scores = [
      { match_id: 7, alliance_id: 71, score: 6, data: { balls: 6 }, teams: [], saved_at: AT },
      { match_id: 7, alliance_id: 72, score: 6, data: { balls: 6 }, teams: [], saved_at: AT },
    ];
    stub();
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "Correct score" }));
    const shared = screen.getByRole("region", { name: "Shared score" });
    fireEvent.click(within(shared).getByRole("button", { name: "Decrease Balls" }));
    fireEvent.click(within(shared).getByLabelText("No-show 102B"));
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/matches/7/alliances/72/score", {
        method: "POST",
        body: { data: { balls: 5 }, teams: [{ team_id: 2, no_show: true, dq: false }], force: false },
      })
    );
    expect(apiRequest).toHaveBeenCalledWith("/api/matches/7/alliances/71/score", {
      method: "POST",
      body: { data: { balls: 5 }, teams: [], force: false },
    });
  });

  it("says the match is no longer available when it is gone", async () => {
    match = new ApiError(404, "Match not found");
    stub();
    renderRoute();
    expect(await screen.findByText("This match is no longer available.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to matches" })).toHaveAttribute("href", "/sessions/1/matches");
  });
});
```

In `frontend/apps/admin/tests/unit/MatchControlRoute.test.tsx`:
- change the Testing Library import to `import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";`, the shared import to `import { ApiError, initI18n, type LiveMatch, type RealtimeEvent } from "@tournament-admin/shared";`, and the mocked import to `import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";`;
- add `let sessions: Record<string, unknown>[];` after `let audience: Record<string, unknown>;`;
- in `beforeEach`, replace the `fieldSets` fixture with (a skills set added, every set carrying `purpose`):

```tsx
  fieldSets = [
    { id: 10, session_id: 1, name: "Main Fields", division_id: null, queued_match_id: null, timeout_deadline: null, purpose: "teamwork" },
    { id: 11, session_id: 1, name: "Side Fields", division_id: null, queued_match_id: null, timeout_deadline: null, purpose: "teamwork" },
    { id: 12, session_id: 1, name: "Skills Row", division_id: null, queued_match_id: null, timeout_deadline: null, purpose: "skills" },
  ];
```

- add `"GET /api/sessions": sessions,` to `stub()`'s `routes`;
- in `beforeEach`, add `vi.mocked(useRealtimeChannel).mockReset();` after `vi.mocked(apiRequest).mockReset();`, and before `stub();`:

```tsx
  sessions = [
    {
      id: 1, event_id: 1, label: "Saturday", session_date: null, timezone: null, has_scored_matches: false,
      qualification_finalized_at: null, qualification_drops: null,
      live_scores_qualification: true, live_scores_finals: false,
    },
  ];
```

- and add these tests at the end of the `describe("Match Control", …)` block:

```tsx
  it("links the current match to its scoring page", async () => {
    matches = [match({ id: 1, phase: "driver", phase_deadline: soon(1) })];
    stub();
    renderRoute();
    const timer = await screen.findByRole("region", { name: "Timer" });
    expect(within(timer).getByRole("link", { name: "Score" })).toHaveAttribute("href", "/sessions/1/matches/1/score");
  });

  it("hides live scores for a qualification match and shows them for a finals match", async () => {
    matches = [match({ id: 1, phase: "driver", phase_deadline: soon(1) })];
    stub();
    renderRoute();
    const timer = await screen.findByRole("region", { name: "Timer" });
    fireEvent.click(await within(timer).findByRole("button", { name: "Hide live scores" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/sessions/1", { method: "PATCH", body: { live_scores_qualification: false } })
    );
    cleanup();
    matches = [match({ id: 1, phase: "driver", phase_deadline: soon(1), is_finals: true, round_type: "elimination" })];
    stub();
    renderRoute();
    const finalsTimer = await screen.findByRole("region", { name: "Timer" });
    fireEvent.click(await within(finalsTimer).findByRole("button", { name: "Show live scores" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/sessions/1", { method: "PATCH", body: { live_scores_finals: true } })
    );
  });

  it("stops waiting for the score when the match is submitted", async () => {
    let onEvent: ((event: RealtimeEvent) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      onEvent = options.onEvent;
      return { connected: true };
    });
    matches = [match({ id: 1, phase: "ended" })];
    stub();
    renderRoute();
    const timer = await screen.findByRole("region", { name: "Timer" });
    expect(within(timer).getByText("Match over — waiting for the score.")).toBeInTheDocument();
    matches = [match({ id: 1, phase: "ended", status: "completed" })];
    scores = [
      { match_id: 1, alliance_id: 11, score: 9, data: {}, teams: [], saved_at: soon(0) },
      { match_id: 1, alliance_id: 12, score: 3, data: {}, teams: [], saved_at: soon(0) },
    ];
    stub();
    act(() => onEvent?.({ event: "match_submitted", data: { match_id: 1 } }));
    expect(await within(timer).findByText("Score saved.")).toBeInTheDocument();
    expect(within(timer).queryByText("Match over — waiting for the score.")).not.toBeInTheDocument();
    expect(within(timer).queryByRole("link", { name: "Score" })).not.toBeInTheDocument();
  });

  it("lists teamwork field sets only", async () => {
    renderRoute();
    expect(await screen.findByRole("tab", { name: "Main Fields" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Side Fields" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Skills Row" })).not.toBeInTheDocument();
  });

  it("says there are no fields when the session has only skills sets", async () => {
    fieldSets = [fieldSets[2]];
    stub();
    renderRoute();
    expect(await screen.findByText("This session has no fields yet.")).toBeInTheDocument();
  });
```

In `frontend/apps/admin/tests/unit/SessionMatchesRoute.test.tsx`, add at the end of the `describe("SessionMatchesRoute", …)` block:

```tsx
  it("links unsubmitted matches to Score, completed ones to View score, and not played ones to nothing", async () => {
    stub([
      ...MATCHES,
      { ...MATCHES[1], id: 3, label: "P2", match_number: 2, status: "not_played", scheduled_time: "2026-11-07T17:20:00Z" },
    ]);
    renderMatches();
    await screen.findByRole("gridcell", { name: "P1" });
    expect(screen.getByRole("link", { name: "Score" })).toHaveAttribute("href", "/sessions/1/matches/1/score");
    expect(screen.getByRole("link", { name: "View score" })).toHaveAttribute("href", "/sessions/1/matches/2/score");
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/MatchScoringRoute.test.tsx tests/unit/MatchControlRoute.test.tsx tests/unit/SessionMatchesRoute.test.tsx`
Expected: FAIL: `MatchScoringRoute` cannot be resolved; the new Match Control tests find no "Score" link or "Hide live scores" button, still see "waiting for the score", and find a "Skills Row" tab; the Matches test finds no "Score" link.

- [ ] **Step 3: Add the session switches to the admin's session type**

In `frontend/apps/admin/src/types.ts`, add to `SessionRead` after `qualification_drops`:

```ts
  /** Live totals on displays for practice and qualification (and skills); the server's default is on. */
  live_scores_qualification?: boolean;
  /** Live totals on displays for finals; the server's default is off. */
  live_scores_finals?: boolean;
```

- [ ] **Step 4: Write the submitted view with correction**

Create `frontend/apps/admin/src/matchScoring/SubmittedScores.tsx`:

```tsx
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ScoresheetForm,
  apiRequest,
  defaultValues,
  submitViolations,
  type AllianceScore,
  type LiveMatch,
  type ScoresheetField,
  type ScoresheetValues,
  type ScoringMatchFormat,
  type TeamFlag,
  type TeamFlags,
} from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { useScoresheetT } from "../skills/useScoresheetT";
import type { TeamSummary } from "../types";

interface SubmittedScoresProps {
  match: LiveMatch;
  /** This match's official scores, one per alliance. */
  scores: AllianceScore[];
  schema: ScoresheetField[];
  matchFormat: ScoringMatchFormat;
  teams: Map<number, TeamSummary>;
}

interface CorrectionDraft {
  /** Alliance id -> its sheet (a cooperative game edits the lowest alliance's sheet for all). */
  data: Record<number, ScoresheetValues>;
  /** Team id -> its flags. */
  flags: Record<number, { no_show: boolean; dq: boolean }>;
}

function seed(match: LiveMatch, scores: AllianceScore[], schema: ScoresheetField[]): CorrectionDraft {
  const defaults = defaultValues(schema);
  const data: Record<number, ScoresheetValues> = {};
  const flags: Record<number, { no_show: boolean; dq: boolean }> = {};
  for (const alliance of match.alliances) {
    const score = scores.find((row) => row.alliance_id === alliance.id);
    data[alliance.id] = { ...defaults, ...(score?.data ?? {}) };
    for (const teamId of alliance.team_ids) {
      const flag = score?.teams.find((entry) => entry.team_id === teamId);
      flags[teamId] = { no_show: flag?.no_show ?? false, dq: flag?.dq ?? false };
    }
  }
  return { data, flags };
}

/** A submitted match: its official scores, read-only, with "Correct score" (admin, any session). */
export function SubmittedScores({ match, scores, schema, matchFormat, teams }: SubmittedScoresProps) {
  const { t } = useTranslation();
  const scoresheetT = useScoresheetT();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<CorrectionDraft | null>(null);
  const [corrected, setCorrected] = useState(false);
  const cooperative = matchFormat.game_model === "cooperative_score";
  const alliances = [...match.alliances].sort((a, b) => a.id - b.id);
  const stationLabel = (station: string) => t(`scoring.station.${station}`, { defaultValue: station });
  const teamNumber = (id: number) => teams.get(id)?.number ?? String(id);

  const save = useMutation({
    mutationFn: async ({ draft, force }: { draft: CorrectionDraft; force: boolean }) => {
      // One POST per alliance, in alliance order; a cooperative game sends its one sheet to each.
      for (const alliance of alliances) {
        const data = cooperative ? draft.data[alliances[0].id] : draft.data[alliance.id];
        const flagged: TeamFlags[] = alliance.team_ids
          .map((teamId) => ({ team_id: teamId, ...draft.flags[teamId] }))
          .filter((entry) => entry.no_show || entry.dq);
        await apiRequest(`/api/matches/${match.id}/alliances/${alliance.id}/score`, {
          method: "POST",
          body: { data, teams: flagged, force },
        });
      }
    },
    onSuccess: async () => {
      setEditing(null);
      setCorrected(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["scores", match.session_id] }),
        queryClient.invalidateQueries({ queryKey: ["matches", match.session_id] }),
        queryClient.invalidateQueries({ queryKey: ["match", match.id] }),
      ]);
    },
  });
  const violations = save.error ? submitViolations(save.error) : null;

  if (editing === null) {
    return (
      <div className="match-scoring__submitted">
        {corrected && (
          <p className="alert alert-success" role="status">
            {t("matchScoring.corrected")}
          </p>
        )}
        <div className="scoring__columns">
          {alliances.map((alliance) => {
            const score = scores.find((row) => row.alliance_id === alliance.id);
            return (
              <section key={alliance.id} className="panel" role="region" aria-label={stationLabel(alliance.station)}>
                <h2>{stationLabel(alliance.station)}</h2>
                <p className="scoring__total">{t("matchScoring.officialScore", { score: score?.score ?? "–" })}</p>
                <ul className="list-plain">
                  {alliance.team_ids.map((teamId) => {
                    const flag = score?.teams.find((entry) => entry.team_id === teamId);
                    const notes = [flag?.no_show ? t("matchScoring.noShowTag") : null, flag?.dq ? t("matchScoring.dqTag") : null]
                      .filter(Boolean)
                      .join(", ");
                    return <li key={teamId}>{notes ? `${teamNumber(teamId)} (${notes})` : teamNumber(teamId)}</li>;
                  })}
                </ul>
                <dl className="match-scoring__items">
                  {schema.map((field) => (
                    <div key={field.name}>
                      <dt>{field.label}</dt>
                      <dd>{String(score?.data[field.name] ?? "–")}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
        <div className="form-actions">
          <button
            className="btn"
            type="button"
            onClick={() => {
              save.reset();
              setCorrected(false);
              setEditing(seed(match, scores, schema));
            }}
          >
            {t("matchScoring.correct")}
          </button>
        </div>
      </div>
    );
  }

  const sheets = cooperative ? alliances.slice(0, 1) : alliances;
  const setFlag = (teamId: number, flag: TeamFlag, value: boolean) =>
    setEditing({ ...editing, flags: { ...editing.flags, [teamId]: { ...editing.flags[teamId], [flag]: value } } });

  return (
    <div className="match-scoring__correct">
      <p className="field__hint">{t("matchScoring.correctHint")}</p>
      <div className="scoring__columns">
        {sheets.map((alliance) => {
          const title = cooperative ? t("scoring.sharedSheet") : stationLabel(alliance.station);
          const teamIds = cooperative ? alliances.flatMap((entry) => entry.team_ids) : alliance.team_ids;
          return (
            <section key={alliance.id} className="panel" role="region" aria-label={title}>
              <h2>{title}</h2>
              <ul className="list-plain scoring__teams">
                {teamIds.map((teamId) => (
                  <li key={teamId}>
                    {(["no_show", "dq"] as const).map((flag) => (
                      <label key={flag} className="choice">
                        <input
                          type="checkbox"
                          checked={editing.flags[teamId]?.[flag] ?? false}
                          onChange={(event) => setFlag(teamId, flag, event.target.checked)}
                        />{" "}
                        {t(flag === "no_show" ? "scoring.noShow" : "scoring.dq", { team: teamNumber(teamId) })}
                      </label>
                    ))}
                  </li>
                ))}
              </ul>
              <ScoresheetForm
                fields={schema}
                values={editing.data[alliance.id]}
                t={scoresheetT}
                idPrefix={`correct-${alliance.id}`}
                onChange={(values) => setEditing({ ...editing, data: { ...editing.data, [alliance.id]: values } })}
              />
            </section>
          );
        })}
      </div>
      {violations ? (
        <div className="alert alert-danger" role="alert">
          <p>{t("scoring.violationsHeading")}</p>
          <ul>
            {violations.flatMap((entry) => entry.messages).map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
          <button
            className="btn btn-danger"
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate({ draft: editing, force: true })}
          >
            {t("matchScoring.saveAnyway")}
          </button>
        </div>
      ) : (
        save.isError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(save.error, t("errors.generic"))}
          </p>
        )
      )}
      <div className="form-actions">
        <button
          className="btn btn-primary"
          type="button"
          disabled={save.isPending}
          onClick={() => save.mutate({ draft: editing, force: false })}
        >
          {t("matchScoring.saveCorrection")}
        </button>
        <button className="btn" type="button" disabled={save.isPending} onClick={() => setEditing(null)}>
          {t("matchScoring.cancel")}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Write the scoring route and register it**

Create `frontend/apps/admin/src/routes/MatchScoringRoute.tsx`:

```tsx
import { useMemo } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ApiError,
  LiveScoringPage,
  apiRequest,
  createScoringHub,
  useRealtimeChannel,
  type AllianceScore,
  type LiveMatch,
  type RealtimeEvent,
  type ScoresheetField,
  type ScoringAlliance,
  type ScoringMatchFormat,
} from "@tournament-admin/shared";
import { SubmittedScores } from "../matchScoring/SubmittedScores";
import { useScoresheetT } from "../skills/useScoresheetT";
import type { SessionRead, TeamSummary } from "../types";

/** The name the server records for an admin's draft changes. */
const ADMIN_DEVICE_NAME = "Admin";

/** Events that move this match's clock or scores. */
const MATCH_EVENTS = new Set([
  "match_phase_changed",
  "match_paused",
  "match_resumed",
  "match_reset",
  "match_submitted",
  "score_saved",
]);

/** /sessions/:sessionId/matches/:matchId/score: live scoring for an unsubmitted match, else its scores with "Correct score". */
export function MatchScoringRoute() {
  const { t } = useTranslation();
  const scoresheetT = useScoresheetT();
  const { session } = useOutletContext<{ session: SessionRead }>();
  const matchId = Number(useParams().matchId);
  const queryClient = useQueryClient();
  const hub = useMemo(createScoringHub, []);
  const { connected } = useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (event: RealtimeEvent) => {
      hub.emit(event);
      const data = event.data as { match_id?: number } | null;
      if (!MATCH_EVENTS.has(event.event) || data?.match_id !== matchId) return;
      void queryClient.invalidateQueries({ queryKey: ["match", matchId] });
      if (event.event === "match_submitted" || event.event === "score_saved") {
        void queryClient.invalidateQueries({ queryKey: ["scores", session.id] });
      }
    },
  });
  const socketEvents = useMemo(() => ({ connected, subscribe: hub.subscribe }), [connected, hub]);

  const match = useQuery({
    queryKey: ["match", matchId],
    queryFn: () => apiRequest<LiveMatch>(`/api/matches/${matchId}`),
  });
  const teams = useQuery({ queryKey: ["teams"], queryFn: () => apiRequest<TeamSummary[]>("/api/teams") });
  const schema = useQuery({
    queryKey: ["scoresheetSchema"],
    queryFn: () => apiRequest<ScoresheetField[]>("/api/event/scoresheet-schema"),
  });
  const matchFormat = useQuery({
    queryKey: ["matchFormat"],
    queryFn: () => apiRequest<ScoringMatchFormat>("/api/event/match-format"),
  });
  const scores = useQuery({
    queryKey: ["scores", session.id],
    queryFn: () => apiRequest<AllianceScore[]>(`/api/scores?session_id=${session.id}`),
  });

  const back = (
    <p>
      <Link to={`/sessions/${session.id}/matches`}>{t("matchScoring.back")}</Link>
    </p>
  );

  if (match.error instanceof ApiError && match.error.status === 404) {
    return (
      <div>
        {back}
        <p className="alert alert-warning" role="status">
          {t("scoring.gone")}
        </p>
      </div>
    );
  }
  if (!match.data || !teams.data || !schema.data || !matchFormat.data || !scores.data) {
    return (
      <div>
        {back}
        <p>{t("matchScoring.loading")}</p>
      </div>
    );
  }

  const teamById = new Map(teams.data.map((team) => [team.id, team]));
  const matchScores = scores.data.filter((row) => row.match_id === matchId);
  const submitted =
    match.data.alliances.length > 0 &&
    match.data.alliances.every((alliance) => matchScores.some((row) => row.alliance_id === alliance.id));
  const alliances: ScoringAlliance[] = match.data.alliances.map((alliance) => ({
    alliance_id: alliance.id,
    station: alliance.station,
    teams: alliance.team_ids.map((id) => ({
      id,
      number: teamById.get(id)?.number ?? String(id),
      name: teamById.get(id)?.name ?? "",
    })),
  }));

  return (
    <div className="match-scoring">
      {back}
      <h2>{t("matchScoring.heading", { match: match.data.label })}</h2>
      {submitted ? (
        <SubmittedScores
          match={match.data}
          scores={matchScores}
          schema={schema.data}
          matchFormat={matchFormat.data}
          teams={teamById}
        />
      ) : (
        <LiveScoringPage
          key={matchId}
          matchId={matchId}
          sessionId={session.id}
          t={scoresheetT}
          myDeviceName={ADMIN_DEVICE_NAME}
          match={match.data}
          alliances={alliances}
          schema={schema.data}
          matchFormat={matchFormat.data}
          socketEvents={socketEvents}
          request={apiRequest}
          onClockChanged={() => void queryClient.invalidateQueries({ queryKey: ["match", matchId] })}
        />
      )}
    </div>
  );
}
```

In `frontend/apps/admin/src/router.tsx`, import it after the `SessionMatchesRoute` import:

```tsx
import { MatchScoringRoute } from "./routes/MatchScoringRoute";
```

and add the child route after the `matches` entry under `sessions/:sessionId`:

```tsx
          { path: "matches/:matchId/score", element: <RequiresGamePlugin><MatchScoringRoute /></RequiresGamePlugin> },
```

- [ ] **Step 6: Link each match on the Matches page**

In `frontend/apps/admin/src/routes/SessionMatchesRoute.tsx`, replace the end of the `columns` memo (the status column through the dependency list) with:

```tsx
      {
        key: "status",
        name: t("sessions.matches.columnStatus"),
        renderCell: ({ row }) => t(`sessions.matches.status.${row.status}`, { defaultValue: row.status }),
      },
      {
        key: "score",
        name: t("sessions.matches.columnScore"),
        renderCell: ({ row }) =>
          row.status === "not_played" ? null : (
            <Link to={`/sessions/${session.id}/matches/${row.id}/score`}>
              {row.status === "completed" ? t("sessions.matches.viewScore") : t("sessions.matches.score")}
            </Link>
          ),
      },
    ],
    [t, stations, session.id]
  );
```

- [ ] **Step 7: Add the teamwork filter, Score, the live-scores toggle and match_submitted to Match Control**

In `frontend/apps/admin/src/displays/types.ts`, add to `FieldSetLiveRead` after `name`:

```ts
  /** Teamwork sets run matches here; skills sets are run from Skills Control. */
  purpose: "teamwork" | "skills";
```

In `frontend/apps/admin/src/matchControl/useMatchControl.ts`:
- import `SessionRead` alongside `TeamSummary`: `import type { SessionRead, TeamSummary } from "../types";`
- add `match_submitted: ["matches", "scores"],` to `LIVE` after `score_saved`;
- add to the object `useMatchControlData` returns, after `displays`:

```ts
    sessions: useQuery({ queryKey: ["sessions"], queryFn: () => apiRequest<SessionRead[]>("/api/sessions") }),
```

- add above `export type MatchAction`:

```ts
/** The session switch that governs live totals for a match's round. */
export type LiveScoresSwitch = "live_scores_qualification" | "live_scores_finals";
```

- add to `useMatchControlActions`'s mutations, before `updateGroup`:

```ts
    setLiveScores: useMutation({
      mutationFn: ({ sessionId, field, value }: { sessionId: number; field: LiveScoresSwitch; value: boolean }) =>
        apiRequest<SessionRead>(`/api/sessions/${sessionId}`, { method: "PATCH", body: { [field]: value } }),
      onSuccess: () => refresh("sessions"),
    }),
```

In `frontend/apps/admin/src/routes/MatchControlRoute.tsx`:
- in `MatchControlBody`, replace `const fieldSets = data.fieldSets.data ?? [];` with:

```tsx
  // Matches run on teamwork sets only; skills sets belong to Skills Control.
  const fieldSets = (data.fieldSets.data ?? []).filter((fs) => fs.purpose !== "skills");
```

- change the hook and type imports to:

```tsx
import { useMatchControlActions, useMatchControlData, type LiveScoresSwitch } from "../matchControl/useMatchControl";
import type { EventRead, SessionRead, TeamSummary } from "../types";
```

- pass the session to the panel: add `session={data.sessions.data?.find((s) => s.id === sessionId) ?? null}` to `<FieldSetPanel …/>` in `MatchControlBody`, and add `session` to `FieldSetPanel`'s destructured props and `session: SessionRead | null;` to its prop types;
- add before `const act = …` in `FieldSetPanel`:

```tsx
  const liveSwitch: LiveScoresSwitch = current?.is_finals ? "live_scores_finals" : "live_scores_qualification";
  // An older server leaves the switches out; fall back to its defaults (qualification on, finals off).
  const liveOn = session ? (session[liveSwitch] ?? liveSwitch === "live_scores_qualification") : null;
```

- in the Timer card, replace

```tsx
            {current.phase === "ended" ? (
              <p>{t("matchControl.waitingForScore")}</p>
            ) : (
```

with

```tsx
            <div className="form-actions">
              {current.status !== "completed" && (
                <Link className="btn" to={`/sessions/${current.session_id}/matches/${current.id}/score`}>
                  {t("matchControl.score")}
                </Link>
              )}
              {session && liveOn !== null && (
                <button
                  className="btn"
                  type="button"
                  disabled={actions.setLiveScores.isPending}
                  onClick={() => actions.setLiveScores.mutate({ sessionId: session.id, field: liveSwitch, value: !liveOn })}
                >
                  {liveOn ? t("matchControl.hideLive") : t("matchControl.showLive")}
                </button>
              )}
            </div>
            {current.phase === "ended" ? (
              <p>{current.status === "completed" ? t("matchControl.scoreSaved") : t("matchControl.waitingForScore")}</p>
            ) : (
```

(the rest of that ternary, the period buttons, stays as it is; `failed` already picks up a refused `setLiveScores`).

- [ ] **Step 8: Add the styles and translations**

Append to `frontend/apps/admin/src/styles/components.css`:

```css
/* Live scoring (shared scoring page and the admin's score / correction route). */
.scoring { display: grid; gap: var(--space-4); }
.scoring__columns { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
.scoring__total { font-size: var(--text-xl); font-weight: 600; margin: 0; }
.scoring__teams li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.scoring__team { font-weight: 600; }
.scoresheet__row--flash, .scoring__flag--flash { background: var(--color-warning-bg); border-radius: var(--radius-sm); }
.scoresheet__note { color: var(--color-warning); }
.clock-controls__clock { font-size: 3rem; font-weight: 700; font-variant-numeric: tabular-nums; margin: 0; }
.clock-controls__phase { margin: 0 0 var(--space-2); color: var(--color-text-secondary); }
.clock-controls__confirm { border-top: 1px solid var(--color-border); margin-top: var(--space-3); padding-top: var(--space-3); }
.match-scoring__items { display: grid; grid-template-columns: max-content 1fr; gap: var(--space-1) var(--space-3); margin: var(--space-3) 0 0; }
.match-scoring__items > div { display: contents; }
.match-scoring__items dd { margin: 0; font-variant-numeric: tabular-nums; }
```

In `frontend/apps/admin/src/i18n/en/admin.json`, add to `sessions.matches`:

```json
"columnScore": "Score",
"score": "Score",
"viewScore": "View score"
```

to `matchControl`:

```json
"score": "Score",
"hideLive": "Hide live scores",
"showLive": "Show live scores",
"scoreSaved": "Score saved."
```

and these top-level keys:

```json
"scoring": {
  "loading": "Loading…",
  "offline": "Offline, changes not saved yet",
  "reconnecting": "Offline, reconnecting…",
  "error": "Something went wrong. Try again.",
  "changedBy": "Changed by {{device}}",
  "scoreSoFar": "Score so far: {{score}}",
  "sharedSheet": "Shared score",
  "alliances": "Alliances",
  "noShow": "No-show {{team}}",
  "dq": "DQ {{team}}",
  "submit": "Submit",
  "submitting": "Submitting…",
  "submitAnyway": "Submit anyway",
  "violationsHeading": "The game's rules found problems:",
  "savedHeading": "Saved",
  "gone": "This match is no longer available.",
  "missingDraft": "{{alliance}} has no score yet. Score it, or use the default score, then Submit again.",
  "useDefaults": "Use the default score for {{alliance}}",
  "allianceFallback": "Alliance {{id}}",
  "station": {
    "red": "Red",
    "blue": "Blue"
  },
  "phase": {
    "not_started": "Not started",
    "countdown_autonomous": "Autonomous count-in",
    "autonomous": "Autonomous",
    "awaiting_driver": "Waiting for driver control",
    "countdown_driver": "Driver count-in",
    "driver": "Driver control",
    "ended": "Ended"
  },
  "clock": {
    "heading": "Timer",
    "start": "Start",
    "startDriver": "Start driver",
    "pause": "Pause",
    "resume": "Resume",
    "end": "End",
    "endHeading": "End the match now?",
    "endNow": "End now",
    "reset": "Reset timer",
    "resetHeading": "Reset the timer?",
    "resetSegment": "Reset current segment",
    "resetMatch": "Reset entire match timer",
    "resetWarning": "Resetting the entire match timer also clears the draft scores.",
    "cancel": "Cancel",
    "paused": "Paused"
  },
  "skills": {
    "noRun": "No run on this field.",
    "gone": "This field is no longer a skills field.",
    "saved": "Saved: {{team}} · {{type}} · {{score}}",
    "fieldTimer": "Field timer",
    "setTimer": "Set timer",
    "followsSet": "Following the set timer",
    "alone": "On its own timer",
    "discard": "Discard",
    "discardHeading": "Discard this run? No attempt is used.",
    "discardNow": "Discard run",
    "phase": {
      "ready": "Ready",
      "running": "Running",
      "ended": "Run over"
    }
  }
},
"matchScoring": {
  "heading": "Score {{match}}",
  "back": "Back to matches",
  "loading": "Loading…",
  "officialScore": "Score: {{score}}",
  "noShowTag": "no-show",
  "dqTag": "DQ",
  "correct": "Correct score",
  "correctHint": "Saving replaces the official score and recalculates the rankings.",
  "saveCorrection": "Save correction",
  "saveAnyway": "Save anyway",
  "cancel": "Cancel",
  "corrected": "Score corrected."
}
```

In `frontend/apps/admin/src/i18n/zh/admin.json`, add to `sessions.matches`:

```json
"columnScore": "分数",
"score": "计分",
"viewScore": "查看分数"
```

to `matchControl`:

```json
"score": "计分",
"hideLive": "隐藏实时分数",
"showLive": "显示实时分数",
"scoreSaved": "分数已保存。"
```

and these top-level keys:

```json
"scoring": {
  "loading": "加载中…",
  "offline": "离线，更改尚未保存",
  "reconnecting": "离线，正在重新连接…",
  "error": "出错了，请重试。",
  "changedBy": "由 {{device}} 更改",
  "scoreSoFar": "当前得分：{{score}}",
  "sharedSheet": "共同得分",
  "alliances": "联盟",
  "noShow": "{{team}} 缺席",
  "dq": "{{team}} 取消资格",
  "submit": "提交",
  "submitting": "正在提交…",
  "submitAnyway": "仍然提交",
  "violationsHeading": "比赛规则发现以下问题：",
  "savedHeading": "已保存",
  "gone": "此比赛已不可用。",
  "missingDraft": "{{alliance}} 还没有分数。请为其计分，或使用默认分数，然后再次提交。",
  "useDefaults": "为 {{alliance}} 使用默认分数",
  "allianceFallback": "联盟 {{id}}",
  "station": {
    "red": "红方",
    "blue": "蓝方"
  },
  "phase": {
    "not_started": "未开始",
    "countdown_autonomous": "自动阶段倒数",
    "autonomous": "自动阶段",
    "awaiting_driver": "等待手动控制",
    "countdown_driver": "手动控制倒数",
    "driver": "手动控制",
    "ended": "已结束"
  },
  "clock": {
    "heading": "计时",
    "start": "开始",
    "startDriver": "开始手动控制",
    "pause": "暂停",
    "resume": "继续",
    "end": "结束",
    "endHeading": "现在结束比赛？",
    "endNow": "立即结束",
    "reset": "重置计时",
    "resetHeading": "重置计时？",
    "resetSegment": "重置当前阶段",
    "resetMatch": "重置整场比赛计时",
    "resetWarning": "重置整场比赛计时也会清除草稿分数。",
    "cancel": "取消",
    "paused": "已暂停"
  },
  "skills": {
    "noRun": "此场地没有进行中的挑战。",
    "gone": "此场地已不是技能场地。",
    "saved": "已保存：{{team}} · {{type}} · {{score}}",
    "fieldTimer": "场地计时",
    "setTimer": "场地组计时",
    "followsSet": "跟随场地组计时",
    "alone": "使用自己的计时",
    "discard": "放弃",
    "discardHeading": "放弃这次挑战？不会占用尝试次数。",
    "discardNow": "放弃挑战",
    "phase": {
      "ready": "就绪",
      "running": "进行中",
      "ended": "挑战结束"
    }
  }
},
"matchScoring": {
  "heading": "为 {{match}} 计分",
  "back": "返回比赛列表",
  "loading": "加载中…",
  "officialScore": "得分：{{score}}",
  "noShowTag": "缺席",
  "dqTag": "取消资格",
  "correct": "更正分数",
  "correctHint": "保存会替换正式分数并重新计算排名。",
  "saveCorrection": "保存更正",
  "saveAnyway": "仍然保存",
  "cancel": "取消",
  "corrected": "分数已更正。"
}
```

- [ ] **Step 9: Run the tests and type check**

Run: `cd frontend/apps/admin && npx vitest run && npx tsc -b`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add frontend/apps/admin/src/routes/MatchScoringRoute.tsx frontend/apps/admin/src/matchScoring/SubmittedScores.tsx frontend/apps/admin/src/router.tsx frontend/apps/admin/src/types.ts frontend/apps/admin/src/displays/types.ts frontend/apps/admin/src/routes/SessionMatchesRoute.tsx frontend/apps/admin/src/routes/MatchControlRoute.tsx frontend/apps/admin/src/matchControl/useMatchControl.ts frontend/apps/admin/src/styles/components.css frontend/apps/admin/src/i18n/en/admin.json frontend/apps/admin/src/i18n/zh/admin.json frontend/apps/admin/tests/unit/MatchScoringRoute.test.tsx frontend/apps/admin/tests/unit/MatchControlRoute.test.tsx frontend/apps/admin/tests/unit/SessionMatchesRoute.test.tsx
git commit -m "Add admin live scoring at /sessions/:id/matches/:id/score, with a submitted match shown read-only and Correct score posting each alliance's official score, Score and View score links on the Matches page, and on Match Control teamwork field sets only, a Score link, a Hide or Show live scores toggle for the current match's round, and Waiting for score clearing on match_submitted.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Skills Control

**Files:**
- Test: `server/tests/test_skills_attempt_field.py` (pins `SkillsAttemptRead.field_id`, which Task 10 added)
- Create: `frontend/packages/shared/src/display/skillsClock.ts`; modify `frontend/packages/shared/src/display/index.ts`
- Test: `frontend/packages/shared/tests/skillsClock.test.ts`
- Create: `frontend/apps/admin/src/routes/SkillsControlRoute.tsx`, `frontend/apps/admin/src/skillsControl/useSkillsControl.ts`, `frontend/apps/admin/src/skillsControl/startRun.ts`, `frontend/apps/admin/src/skillsControl/StartRunDialog.tsx`, `frontend/apps/admin/src/skillsControl/SkillsSetCard.tsx`
- Modify: `frontend/apps/admin/src/types.ts`, `frontend/apps/admin/src/components/AppShell.tsx`, `frontend/apps/admin/src/router.tsx`, `frontend/apps/admin/src/styles/components.css`, `frontend/apps/admin/src/i18n/en/admin.json`, `frontend/apps/admin/src/i18n/zh/admin.json`
- Modify (fixtures for the new required type fields): `frontend/apps/admin/tests/unit/SessionFieldsRoute.test.tsx`, `SessionScheduleRoute.test.tsx`, `readiness.test.ts`, `SessionSkillsRoute.test.tsx`, `AttemptsTable.test.tsx`, `attemptsTable.test.ts`, `recordForm.test.ts`
- Test: `frontend/apps/admin/tests/unit/SkillsControlRoute.test.tsx`, `frontend/apps/admin/tests/unit/AppShell.test.tsx` (extended)

**Interfaces:**
- Consumes: Task 9/10 routes (`POST/DELETE /api/fields/{id}/skills-run`, `POST /api/fields/{id}/skills-run/{action}`, `GET /api/field-sets/{id}/skills`, `PUT /api/field-sets/{id}/skills-timer`, `POST /api/field-sets/{id}/skills-timer/{action}`), Task 2's `FieldSetRead.purpose`, Task 3's `run_seconds` on skills types, Task 4's `skills_run_changed` on `/ws/active-session` (admin role), Task 12's types `SkillsSet`, `SkillsRun`, `SkillsSetTimer`, Task 13's `SkillsRunPanel`.
- Produces (shared): `SkillsClockState`, `SkillsClockAction`, `skillsClockPhase(timer, nowMs)`, `skillsClockSeconds(timer, nowMs, fullSeconds)`, `skillsClockActions(timer, nowMs)` (Task 17 reuses them on the TVs).
- Produces (admin): `/skills-control` (`SkillsControlRoute`), nav "Skills Control"; `skillsSetKey(fieldSetId)` = `["skillsSet", fieldSetId]`; `useNow`, `useSkillsControlData`, `useSkillsControlActions`; `eligibleTeams`, `lastFieldAttempt`; `StartRunDialog`; `SkillsSetCard`. Admin types gain `FieldSetPurpose`, `FieldSetRead.purpose`, `SkillsType.run_seconds?`, `SkillsAttemptRead.field_id`.
- Consumes (server): Task 10's `SkillsAttemptRead.field_id: int | None` on every attempt read (this task only pins it with a test).

Plan note: Task 10 already adds `field_id` to `SkillsAttemptRead` and `_attempt_read` (its Step 3). Skills Control's "submitted" state and Task 16's Skills page both read it, so Steps 1-3 here only add a pinning test from the Skills page's side; they change no server code, and the test passes as soon as it is written.

Plan note: Task 13's `SkillsRunPanel` requires `{fieldId, fieldSetId, t, myDeviceName, socketEvents}` and takes `request?`. This page passes `fieldId`, `fieldSetId`, `t` (the admin's `useScoresheetT()`), `myDeviceName="Admin"`, `request={apiRequest}` (the admin tests mock the package's `apiRequest`, as Task 14 does for `LiveScoringPage`) and `socketEvents`, which `useSkillsControlData` builds by feeding its `/ws/active-session` events through `createScoringHub()`. The unit tests' stub of the panel stays as it is.

The page's skills timer helpers live in `packages/shared/src/display/` (not in Task 12's `scoring/` folder), because both apps read them and the display folder already holds the shared clock rules. Their names start with `skillsClock` so they can't collide with anything Task 12 or 13 exports.

- [ ] **Step 1: Write the failing server test**

Create `server/tests/test_skills_attempt_field.py`:

```python
"""Skills attempts report the skills field they were scored on."""
from __future__ import annotations

from skills_helpers import create_event, create_session, enable_skills, record_attempt


def _setup(client) -> tuple[int, int]:
    t1, _, _ = create_event(client)
    enable_skills(client)
    session_id = create_session(client, checked_in=(t1,))
    activated = client.post("/api/event/active-session", json={"session_id": session_id})
    assert activated.status_code < 300, activated.text
    return session_id, t1


def _skills_field(client, session_id: int) -> int:
    field_set = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Skills Row", "purpose": "skills"}
    )
    assert field_set.status_code == 201, field_set.text
    field = client.post(
        "/api/fields",
        json={"session_id": session_id, "field_set_id": field_set.json()["id"], "name": "Skills 1"},
    )
    assert field.status_code == 201, field.text
    return field.json()["id"]


def test_an_attempt_recorded_on_the_skills_page_has_no_field(client):
    session_id, t1 = _setup(client)
    created = record_attempt(client, session_id, t1, "driver", objects=3)
    assert created.status_code == 201, created.text
    assert created.json()["field_id"] is None
    listed = client.get(f"/api/sessions/{session_id}/skills/attempts").json()
    assert [attempt["field_id"] for attempt in listed] == [None]


def test_an_attempt_submitted_from_a_run_carries_its_field(client):
    session_id, t1 = _setup(client)
    field_id = _skills_field(client, session_id)
    created = client.post(f"/api/fields/{field_id}/skills-run", json={"team_id": t1})
    assert created.status_code < 300, created.text
    patched = client.patch(
        f"/api/fields/{field_id}/skills-run/draft", json={"changes": {"objects_scored": 4, "parked": False}}
    )
    assert patched.status_code == 200, patched.text
    submitted = client.post(f"/api/fields/{field_id}/skills-run/submit", json={})
    assert submitted.status_code < 300, submitted.text

    listed = client.get(f"/api/sessions/{session_id}/skills/attempts").json()
    assert [(attempt["field_id"], attempt["skills_type"], attempt["score"]) for attempt in listed] == [
        (field_id, "autonomous", 8)
    ]
```

(The example game's first skills type is `autonomous`, so the run follows the set with that type; four objects score 8.)

- [ ] **Step 2: Run it**

Run: `cd server && .venv/bin/pytest -q tests/test_skills_attempt_field.py`
Expected: PASS at once: Task 10 Step 3 already added `field_id` to `SkillsAttemptRead` and `_attempt_read`. (If it fails with `KeyError: 'field_id'`, Task 10 was not applied; stop and apply it rather than adding the field here.)

- [ ] **Step 3: Check the attempt read (no server change)**

`SkillsAttemptRead.field_id` and `_attempt_read`'s `field_id=attempt.field_id` come from Task 10; do not add them a second time (a repeated keyword in `_attempt_read` is a syntax error).

Run: `cd server && .venv/bin/pytest -q tests/test_skills_attempt_field.py tests/test_skills_attempts.py tests/test_skills_runs.py tests/test_skills_timers.py`
Expected: PASS.

- [ ] **Step 4: Write the failing shared clock tests**

Create `frontend/packages/shared/tests/skillsClock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { skillsClockActions, skillsClockPhase, skillsClockSeconds, type SkillsClockState } from "../src";

const NOW = Date.parse("2026-11-07T16:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
const timer = (overrides: Partial<SkillsClockState> = {}): SkillsClockState => ({
  phase: "ready",
  deadline: null,
  paused: false,
  remaining_seconds: null,
  ...overrides,
});

describe("skills clock", () => {
  it("shows the full run length while ready", () => {
    expect(skillsClockSeconds(timer(), NOW, 60)).toBe(60);
    expect(skillsClockSeconds(timer({ remaining_seconds: 42 }), NOW, 60)).toBe(42);
    expect(skillsClockSeconds(timer(), NOW, null)).toBe(0);
  });

  it("counts down to the deadline while running and freezes while paused", () => {
    expect(skillsClockSeconds(timer({ phase: "running", deadline: at(45_000) }), NOW, 60)).toBe(45);
    expect(skillsClockSeconds(timer({ phase: "running", paused: true, remaining_seconds: 12 }), NOW, 60)).toBe(12);
  });

  it("reads a running timer past its deadline as ended, as the server does", () => {
    const late = timer({ phase: "running", deadline: at(-1) });
    expect(skillsClockPhase(late, NOW)).toBe("ended");
    expect(skillsClockSeconds(late, NOW, 60)).toBe(0);
    expect(skillsClockPhase(timer({ phase: "running", paused: true, deadline: at(-1) }), NOW)).toBe("running");
  });

  it("offers Start when ready, Pause or Resume with End and Reset while running, and Reset once ended", () => {
    expect(skillsClockActions(timer(), NOW)).toEqual(["start"]);
    expect(skillsClockActions(timer({ phase: "running", deadline: at(5_000) }), NOW)).toEqual(["pause", "end", "reset"]);
    expect(skillsClockActions(timer({ phase: "running", paused: true, remaining_seconds: 5 }), NOW)).toEqual([
      "resume",
      "end",
      "reset",
    ]);
    expect(skillsClockActions(timer({ phase: "ended" }), NOW)).toEqual(["reset"]);
  });
});
```

Run: `cd frontend/packages/shared && npx vitest run tests/skillsClock.test.ts`
Expected: FAIL (`skillsClockActions` is not exported).

- [ ] **Step 5: Write the shared clock helpers**

Create `frontend/packages/shared/src/display/skillsClock.ts`:

```ts
/** A skills timer as the server sends it: a skills field set's timer or one run's own. */
export interface SkillsClockState {
  phase: string;
  deadline: string | null;
  paused: boolean;
  remaining_seconds: number | null;
}

export type SkillsClockAction = "start" | "pause" | "resume" | "reset" | "end";

/** "ready", "running" or "ended". A running timer past its deadline reads as
 * ended between reads, the way the server reads it. */
export function skillsClockPhase(timer: SkillsClockState, nowMs: number): string {
  if (timer.phase === "running" && !timer.paused && timer.deadline !== null && Date.parse(timer.deadline) <= nowMs) {
    return "ended";
  }
  return timer.phase;
}

/** Seconds left: to the deadline while running, frozen while paused, and the
 * run's full length (`fullSeconds`) while ready unless the server sent one. */
export function skillsClockSeconds(timer: SkillsClockState, nowMs: number, fullSeconds: number | null): number {
  const phase = skillsClockPhase(timer, nowMs);
  if (phase === "ended") return 0;
  if (phase === "running" && !timer.paused && timer.deadline !== null) {
    return Math.max(0, (Date.parse(timer.deadline) - nowMs) / 1000);
  }
  return timer.remaining_seconds ?? fullSeconds ?? 0;
}

/** The controls a timer offers right now. */
export function skillsClockActions(timer: SkillsClockState, nowMs: number): SkillsClockAction[] {
  const phase = skillsClockPhase(timer, nowMs);
  if (phase === "ready") return ["start"];
  if (phase === "ended") return ["reset"];
  return [timer.paused ? "resume" : "pause", "end", "reset"];
}
```

Add `export * from "./skillsClock";` to `frontend/packages/shared/src/display/index.ts`.

Run: `cd frontend/packages/shared && npx vitest run tests/skillsClock.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing Skills Control tests**

Create `frontend/apps/admin/tests/unit/SkillsControlRoute.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, initI18n, type RealtimeEvent } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SkillsControlRoute } from "../../src/routes/SkillsControlRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return {
    ...actual,
    apiRequest: vi.fn(),
    useRealtimeChannel: vi.fn(),
    // The panel itself is Task 13's and has its own tests; here it only has to open for the right field.
    SkillsRunPanel: ({ fieldId }: { fieldId: number }) => <p>{`Run panel for field ${fieldId}`}</p>,
  };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

const TEAMS = [
  { id: 1, number: "11A", name: "Alpha", division_id: null },
  { id: 2, number: "22B", name: "Bravo", division_id: null },
  { id: 3, number: "33C", name: "Charlie", division_id: null },
  { id: 4, number: "44D", name: "Delta", division_id: null },
  { id: 5, number: "55E", name: "Echo", division_id: null },
];
// Delta is not checked in.
const PARTICIPANTS = [1, 2, 3, 5].map((teamId) => ({ id: teamId, session_id: 1, team_id: teamId, checked_in: true }));
const MAIN = { id: 10, session_id: 1, name: "Main Fields", division_id: null, purpose: "teamwork" };
const ROW = { id: 20, session_id: 1, name: "Skills Row", division_id: null, purpose: "skills" };

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, field_id: 31, field_set_id: 20, team_id: 1, team_number: "11A", team_name: "Alpha",
    skills_type: "autonomous", data: {}, item_meta: {}, version: 1, score: 0, follows_set: true,
    phase: "ready", deadline: null, paused: false, remaining_seconds: null, ...overrides,
  };
}

function attempt(overrides: Record<string, unknown>) {
  return {
    id: 1, team_id: 3, skills_type: "autonomous", number: 1, score: 20, data: {}, recorded_at: "", updated_at: "",
    field_id: null, ...overrides,
  };
}

let event: { active_session_id: number | null };
let fieldSets: Record<string, unknown>[];
let skillsSet: { timer: Record<string, unknown>; fields: Record<string, unknown>[] };
let attempts: Record<string, unknown>[];

function stub(extra: Record<string, unknown> = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string }) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    const routes: Record<string, unknown> = {
      "GET /api/event": { id: 1, name: "E", game_plugin_name: "g", game_plugin_locked: false, created_at: "", ...event },
      "GET /api/field-sets?session_id=1": fieldSets,
      "GET /api/field-sets/20/skills": skillsSet,
      "GET /api/skills/settings": {
        enabled: true,
        attempts: {},
        types: [
          { key: "autonomous", label: "Autonomous", run_seconds: 60 },
          { key: "driver", label: "Driver", run_seconds: 60 },
        ],
      },
      "GET /api/sessions/1/skills": {
        types: [
          { key: "autonomous", label: "Autonomous", allowed: 1 },
          { key: "driver", label: "Driver", allowed: 3 },
        ],
        override: null,
      },
      "GET /api/sessions/1/skills/attempts": attempts,
      "GET /api/teams": TEAMS,
      "GET /api/sessions/1/participants": PARTICIPANTS,
      ...extra,
    };
    if (key in routes) {
      const value = routes[key];
      if (value instanceof Error) throw value;
      return value as never;
    }
    if (options?.method && options.method !== "GET") return {} as never;
    throw new Error(`unexpected request: ${key}`);
  });
}

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <SkillsControlRoute />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

const card = () => screen.findByRole("region", { name: "Skills Row" });
const gets = (path: string) =>
  vi.mocked(apiRequest).mock.calls.filter(([p, options]) => p === path && !(options as { method?: string } | undefined)?.method)
    .length;

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
  event = { active_session_id: 1 };
  fieldSets = [MAIN, ROW];
  skillsSet = {
    timer: { field_set_id: 20, skills_type: "autonomous", phase: "ready", deadline: null, paused: false, remaining_seconds: null, run_seconds: 60 },
    fields: [
      { field_id: 31, name: "Skills 1", run: run() },
      { field_id: 32, name: "Skills 2", run: null },
      {
        field_id: 33,
        name: "Skills 3",
        run: run({ id: 3, field_id: 33, team_id: 5, team_number: "55E", team_name: "Echo", follows_set: false, phase: "running", deadline: inSeconds(45) }),
      },
    ],
  };
  // Charlie has used its only autonomous attempt.
  attempts = [attempt({})];
  stub();
});

describe("Skills Control", () => {
  it("asks for an active session when there is none", async () => {
    event = { active_session_id: null };
    stub();
    renderRoute();
    expect(await screen.findByText(/No session is active/)).toBeInTheDocument();
  });

  it("points to the Fields page when the session has no skills field set", async () => {
    fieldSets = [MAIN];
    stub();
    renderRoute();
    expect(await screen.findByRole("link", { name: "Fields page." })).toHaveAttribute("href", "/sessions/1/fields");
  });

  it("shows each skills set with its type, its timer and a row per field", async () => {
    renderRoute();
    const set = await card();
    expect(within(set).getByLabelText("Skills type")).toHaveValue("autonomous");
    expect(within(set).getByLabelText("Skills type")).toBeDisabled();
    expect(within(set).getByTestId("set-clock-20")).toHaveTextContent("1:00");
    const one = within(set).getByRole("row", { name: "Skills 1" });
    expect(one).toHaveTextContent("11A Alpha");
    expect(one).toHaveTextContent("Autonomous");
    expect(one).toHaveTextContent("Set timer");
    expect(one).toHaveTextContent("Ready");
    const two = within(set).getByRole("row", { name: "Skills 2" });
    expect(two).toHaveTextContent("No run");
    expect(within(two).getByRole("button", { name: "Start run" })).toBeInTheDocument();
    const three = within(set).getByRole("row", { name: "Skills 3" });
    expect(three).toHaveTextContent(/Alone · 0:4[45]/);
    expect(three).toHaveTextContent("Running");
    expect(screen.queryByRole("region", { name: "Main Fields" })).not.toBeInTheDocument();
  });

  it("runs the set timer, and changes the set's type once no run is left", async () => {
    renderRoute();
    const set = await card();
    fireEvent.click(within(within(set).getByRole("group", { name: "Set timer" })).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/field-sets/20/skills-timer/start", { method: "POST" }));

    cleanup();
    skillsSet = { ...skillsSet, fields: skillsSet.fields.map((field) => ({ ...field, run: null })) };
    stub();
    renderRoute();
    const select = within(await card()).getByLabelText("Skills type");
    expect(select).toBeEnabled();
    fireEvent.change(select, { target: { value: "driver" } });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/field-sets/20/skills-timer", { method: "PUT", body: { skills_type: "driver" } })
    );
  });

  it("starts a run with a checked-in team that is free and has an attempt left", async () => {
    renderRoute();
    const two = within(await card()).getByRole("row", { name: "Skills 2" });
    fireEvent.click(within(two).getByRole("button", { name: "Start run" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Start a run on Skills 2" });
    const team = within(dialog).getByLabelText("Team");
    await waitFor(() =>
      expect(within(team).getAllByRole("option").map((option) => option.textContent)).toEqual(["Choose a team…", "22B Bravo"])
    );
    fireEvent.change(team, { target: { value: "2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start run" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/fields/32/skills-run", {
        method: "POST",
        body: { team_id: 2, skills_type: "autonomous", follows_set: true },
      })
    );
  });

  it("starts a run of another type on the field's own timer", async () => {
    renderRoute();
    fireEvent.click(within(within(await card()).getByRole("row", { name: "Skills 2" })).getByRole("button", { name: "Start run" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Start a run on Skills 2" });
    fireEvent.change(within(dialog).getByLabelText("Skills type"), { target: { value: "driver" } });
    expect(within(dialog).getByText(/runs on this field's own timer/)).toBeInTheDocument();
    const team = within(dialog).getByLabelText("Team");
    await waitFor(() =>
      expect(within(team).getAllByRole("option").map((option) => option.textContent)).toEqual([
        "Choose a team…",
        "22B Bravo",
        "33C Charlie",
      ])
    );
    fireEvent.change(team, { target: { value: "3" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start run" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/fields/32/skills-run", {
        method: "POST",
        body: { team_id: 3, skills_type: "driver", follows_set: false },
      })
    );
  });

  it("moves a field's own timer, and discards a run after asking", async () => {
    renderRoute();
    const set = await card();
    const three = within(set).getByRole("row", { name: "Skills 3" });
    fireEvent.click(within(within(three).getByRole("group", { name: "Timer for Skills 3" })).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/fields/33/skills-run/pause", { method: "POST" }));

    fireEvent.click(within(within(set).getByRole("row", { name: "Skills 1" })).getByRole("button", { name: "Discard" }));
    const dialog = screen.getByRole("alertdialog", { name: "Discard the run on Skills 1?" });
    expect(dialog).toHaveTextContent("Team 11A's entries are thrown away and no attempt is used.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard run" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/fields/31/skills-run", { method: "DELETE" }));
  });

  it("opens the scoring panel for a field's run", async () => {
    renderRoute();
    fireEvent.click(within(within(await card()).getByRole("row", { name: "Skills 1" })).getByRole("button", { name: "Score" }));
    const dialog = screen.getByRole("alertdialog", { name: "Score Skills 1" });
    expect(within(dialog).getByText("Run panel for field 31")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("shows a field's last submitted attempt once its run is gone", async () => {
    attempts = [attempt({}), attempt({ id: 7, team_id: 2, score: 40, field_id: 32 })];
    stub();
    renderRoute();
    const two = within(await card()).getByRole("row", { name: "Skills 2" });
    expect(two).toHaveTextContent("Submitted");
    expect(two).toHaveTextContent("Last: 22B · 40");
  });

  it("shows the server's message when an action is refused", async () => {
    stub({ "POST /api/field-sets/20/skills-timer/start": new ApiError(409, "No run is following this field set.") });
    renderRoute();
    const set = await card();
    fireEvent.click(within(within(set).getByRole("group", { name: "Set timer" })).getByRole("button", { name: "Start" }));
    expect(await within(set).findByRole("alert")).toHaveTextContent("No run is following this field set.");
  });

  it("refetches a set when its runs change", async () => {
    let onEvent: ((event: RealtimeEvent) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      onEvent = options.onEvent;
      return { connected: true };
    });
    renderRoute();
    await card();
    expect(vi.mocked(useRealtimeChannel).mock.calls[0][0].path).toBe("/ws/active-session");
    const before = gets("/api/field-sets/20/skills");
    act(() => onEvent?.({ event: "skills_run_changed", data: { field_set_id: 20, field_id: 31 } }));
    await waitFor(() => expect(gets("/api/field-sets/20/skills")).toBeGreaterThan(before));
  });
});
```

In `frontend/apps/admin/tests/unit/AppShell.test.tsx`, in `it("shows the full admin nav including Sessions for the admin role", …)`, add after the Sessions assertion:

```tsx
    expect(screen.getByRole("link", { name: "Skills Control" })).toHaveAttribute("href", "/skills-control");
```

- [ ] **Step 7: Run them to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/SkillsControlRoute.test.tsx tests/unit/AppShell.test.tsx`
Expected: FAIL (`SkillsControlRoute` does not exist; no "Skills Control" link).

- [ ] **Step 8: Extend the admin types and their test fixtures**

In `frontend/apps/admin/src/types.ts`:

```ts
export type FieldSetPurpose = "teamwork" | "skills";

export interface FieldSetRead {
  id: number;
  session_id: number;
  name: string;
  division_id: number | null;
  /** Teamwork sets run matches; skills sets run skills runs. */
  purpose: FieldSetPurpose;
}
```

```ts
export interface SkillsType {
  key: string;
  label: string;
  /** How long one run of this type lasts; null or missing when the game gives no length. */
  run_seconds?: number | null;
}
```

and add to `SkillsAttemptRead`, after `updated_at`:

```ts
  /** The skills field it was scored on; null when entered on the Skills page. */
  field_id: number | null;
```

Fixtures typed with these interfaces need the new fields (`npx tsc -b` lists them):
- `tests/unit/SessionFieldsRoute.test.tsx` and `tests/unit/SessionScheduleRoute.test.tsx`: `const MAIN_SET: FieldSetRead = { id: 10, session_id: 1, name: "Main Fields", division_id: null, purpose: "teamwork" };`
- `tests/unit/readiness.test.ts`: add `purpose: "teamwork" as const` to both field sets in the "counts only fields in field sets scoped to the division" test.
- The `attempt(...)` helpers in `tests/unit/SessionSkillsRoute.test.tsx`, `AttemptsTable.test.tsx`, `attemptsTable.test.ts` and `recordForm.test.ts`: add `field_id: null` to the returned object, e.g. `return { id, team_id, skills_type, number, score, data: { score }, recorded_at: "", updated_at: "", field_id: null };`.

- [ ] **Step 9: Write the data hook and the start-run rules**

Create `frontend/apps/admin/src/skillsControl/useSkillsControl.ts`:

```ts
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  apiRequest,
  createScoringHub,
  useRealtimeChannel,
  type ScoringSocket,
  type SkillsClockAction,
  type SkillsSet,
} from "@tournament-admin/shared";
import { handleSkillsEvent } from "../skills/liveUpdates";
import { useSessionSkills, useSkillsAttempts } from "../skills/useSessionSkills";
import { useSkillsSettings } from "../skills/useSkillsSettings";
import type { FieldSetRead, TeamSummary } from "../types";

export const skillsSetKey = (fieldSetId: number) => ["skillsSet", fieldSetId];

/** The local time, re-read every `intervalMs` so countdowns move. */
export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Everything Skills Control shows for the active session, kept live off /ws/active-session. */
export function useSkillsControlData(sessionId: number) {
  const queryClient = useQueryClient();
  // The same socket feeds the scoring panel (Task 13's SkillsRunPanel) through a hub.
  const hub = useMemo(createScoringHub, []);
  const channel = useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (event) => {
      hub.emit(event);
      if (event.event === "skills_run_changed") {
        const fieldSetId = (event.data as { field_set_id?: unknown } | null)?.field_set_id;
        void queryClient.invalidateQueries({
          queryKey: typeof fieldSetId === "number" ? skillsSetKey(fieldSetId) : ["skillsSet"],
        });
      } else if (event.event === "active_session_changed") {
        void queryClient.invalidateQueries({ queryKey: ["event"] });
      } else {
        handleSkillsEvent(queryClient, event);
      }
    },
  });
  const fieldSets = useQuery({
    queryKey: ["fieldSets", sessionId],
    queryFn: () => apiRequest<FieldSetRead[]>(`/api/field-sets?session_id=${sessionId}`),
  });
  const skillsSets = (fieldSets.data ?? []).filter((fieldSet) => fieldSet.purpose === "skills");
  const sets = useQueries({
    queries: skillsSets.map((fieldSet) => ({
      queryKey: skillsSetKey(fieldSet.id),
      queryFn: () => apiRequest<SkillsSet>(`/api/field-sets/${fieldSet.id}/skills`),
    })),
  });
  const socketEvents: ScoringSocket = useMemo(
    () => ({ connected: channel?.connected ?? false, subscribe: hub.subscribe }),
    [channel?.connected, hub]
  );
  return {
    fieldSets,
    skillsSets,
    sets,
    socketEvents,
    settings: useSkillsSettings(),
    sessionSkills: useSessionSkills(sessionId),
    attempts: useSkillsAttempts(sessionId),
    teams: useQuery({ queryKey: ["teams"], queryFn: () => apiRequest<TeamSummary[]>("/api/teams") }),
  };
}

export function useSkillsControlActions() {
  const queryClient = useQueryClient();
  const refresh = (fieldSetId: number) => queryClient.invalidateQueries({ queryKey: skillsSetKey(fieldSetId) });
  return {
    setTimer: useMutation({
      mutationFn: ({ fieldSetId, action }: { fieldSetId: number; action: SkillsClockAction }) =>
        apiRequest(`/api/field-sets/${fieldSetId}/skills-timer/${action}`, { method: "POST" }),
      onSuccess: (_data, { fieldSetId }) => refresh(fieldSetId),
    }),
    setType: useMutation({
      mutationFn: ({ fieldSetId, skillsType }: { fieldSetId: number; skillsType: string }) =>
        apiRequest(`/api/field-sets/${fieldSetId}/skills-timer`, { method: "PUT", body: { skills_type: skillsType } }),
      onSuccess: (_data, { fieldSetId }) => refresh(fieldSetId),
    }),
    fieldTimer: useMutation({
      mutationFn: ({ fieldId, action }: { fieldSetId: number; fieldId: number; action: SkillsClockAction }) =>
        apiRequest(`/api/fields/${fieldId}/skills-run/${action}`, { method: "POST" }),
      onSuccess: (_data, { fieldSetId }) => refresh(fieldSetId),
    }),
    discard: useMutation({
      mutationFn: ({ fieldId }: { fieldSetId: number; fieldId: number }) =>
        apiRequest<void>(`/api/fields/${fieldId}/skills-run`, { method: "DELETE" }),
      onSuccess: (_data, { fieldSetId }) => refresh(fieldSetId),
    }),
  };
}
```

Create `frontend/apps/admin/src/skillsControl/startRun.ts`:

```ts
import { attemptStatus, compareTeamNumbers } from "../skills/recordForm";
import type { ParticipationRead, SkillsAttemptRead, TeamSummary } from "../types";

/** Teams that may start a run of `skillsType`: checked in, not already on a
 * skills field, and with an attempt of that type left (the server checks again). */
export function eligibleTeams({
  teams,
  participants,
  attempts,
  skillsType,
  allowed,
  busyTeamIds,
}: {
  teams: TeamSummary[];
  participants: ParticipationRead[];
  attempts: SkillsAttemptRead[];
  skillsType: string;
  allowed: number;
  busyTeamIds: Set<number>;
}): TeamSummary[] {
  const checkedIn = new Set(participants.filter((row) => row.checked_in).map((row) => row.team_id));
  return teams
    .filter(
      (team) =>
        checkedIn.has(team.id) &&
        !busyTeamIds.has(team.id) &&
        !attemptStatus(attempts, team.id, skillsType, allowed).usedUp
    )
    .sort(compareTeamNumbers);
}

/** The newest attempt scored on this skills field, or null. */
export function lastFieldAttempt(attempts: SkillsAttemptRead[], fieldId: number): SkillsAttemptRead | null {
  let latest: SkillsAttemptRead | null = null;
  for (const attempt of attempts) {
    if (attempt.field_id === fieldId && (latest === null || attempt.id > latest.id)) latest = attempt;
  }
  return latest;
}
```

- [ ] **Step 10: Write the start-run dialog and the set card**

Create `frontend/apps/admin/src/skillsControl/StartRunDialog.tsx`:

```tsx
import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { Modal } from "../components/Modal";
import { useSkillsAttempts } from "../skills/useSessionSkills";
import type { ParticipationRead, SessionSkillsType, SkillsType, TeamSummary } from "../types";
import { eligibleTeams } from "./startRun";
import { skillsSetKey } from "./useSkillsControl";

/** Picks a team (and, rarely, another type) for an empty skills field. */
export function StartRunDialog({
  sessionId,
  fieldSetId,
  field,
  setType,
  types,
  sessionTypes,
  teams,
  busyTeamIds,
  onClose,
}: {
  sessionId: number;
  fieldSetId: number;
  field: { id: number; name: string };
  /** The set timer's type; a run of another type runs on its own timer. */
  setType: string | null;
  types: SkillsType[];
  sessionTypes: SessionSkillsType[];
  teams: TeamSummary[];
  busyTeamIds: Set<number>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const headingId = useId();
  const typeSelectId = useId();
  const teamSelectId = useId();
  const [skillsType, setSkillsType] = useState(setType ?? types[0]?.key ?? "");
  const [team, setTeam] = useState("");
  // Same keys as Check-In and the Skills page; mounting refetches them, so a
  // team checked in or an attempt used since the page loaded counts.
  const participants = useQuery({
    queryKey: ["participants", sessionId],
    queryFn: () => apiRequest<ParticipationRead[]>(`/api/sessions/${sessionId}/participants`),
  });
  const attempts = useSkillsAttempts(sessionId);
  const allowed = sessionTypes.find((type) => type.key === skillsType)?.allowed ?? 0;
  const loaded = participants.data !== undefined && attempts.data !== undefined;
  const options = loaded
    ? eligibleTeams({
        teams,
        participants: participants.data!,
        attempts: attempts.data!,
        skillsType,
        allowed,
        busyTeamIds,
      })
    : [];
  const followsSet = setType === null || skillsType === setType;
  const create = useMutation({
    mutationFn: () =>
      apiRequest(`/api/fields/${field.id}/skills-run`, {
        method: "POST",
        body: { team_id: Number(team), skills_type: skillsType, follows_set: followsSet },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: skillsSetKey(fieldSetId) });
      onClose();
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (team) create.mutate();
  }

  return (
    <Modal labelledBy={headingId} onCancel={onClose}>
      <form onSubmit={handleSubmit}>
        <h2 id={headingId}>{t("skillsControl.startHeading", { name: field.name })}</h2>
        <div className="field">
          <label className="field__label" htmlFor={typeSelectId}>
            {t("skillsControl.typeLabel")}
          </label>
          <select
            id={typeSelectId}
            className="select"
            value={skillsType}
            onChange={(event) => {
              setSkillsType(event.target.value);
              setTeam("");
            }}
          >
            {types.map((type) => (
              <option key={type.key} value={type.key}>
                {type.label}
              </option>
            ))}
          </select>
          {!followsSet && <p className="field__hint">{t("skillsControl.ownTimerHint")}</p>}
        </div>
        <div className="field">
          <label className="field__label" htmlFor={teamSelectId}>
            {t("skillsControl.teamLabel")}
          </label>
          <select
            id={teamSelectId}
            className="select"
            value={team}
            data-autofocus
            onChange={(event) => setTeam(event.target.value)}
          >
            <option value="">{t("skillsControl.teamPlaceholder")}</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>{`${option.number} ${option.name}`}</option>
            ))}
          </select>
          {loaded && options.length === 0 && <p className="field__hint">{t("skillsControl.noTeams")}</p>}
        </div>
        {create.isError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(create.error, t("errors.generic"))}
          </p>
        )}
        <div className="dialog__actions">
          <button type="submit" className="btn btn-primary" disabled={!team || create.isPending}>
            {t("skillsControl.startConfirm")}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t("skillsControl.cancel")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
```

Create `frontend/apps/admin/src/skillsControl/SkillsSetCard.tsx`:

```tsx
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SkillsRunPanel,
  apiRequest,
  formatClock,
  skillsClockActions,
  skillsClockPhase,
  skillsClockSeconds,
  type ScoringSocket,
  type SkillsClockAction,
  type SkillsClockState,
  type SkillsRun,
  type SkillsSet,
} from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { useScoresheetT } from "../skills/useScoresheetT";
import type { FieldSetRead, SessionSkillsType, SkillsAttemptRead, SkillsType, TeamSummary } from "../types";
import { StartRunDialog } from "./StartRunDialog";
import { lastFieldAttempt } from "./startRun";
import { useSkillsControlActions } from "./useSkillsControl";

type FieldRef = { id: number; name: string };

/** The phase label key: a paused running timer reads "paused". */
function phaseKey(timer: SkillsClockState, now: number): string {
  const phase = skillsClockPhase(timer, now);
  return phase === "running" && timer.paused ? "paused" : phase;
}

function rowStateKey(run: SkillsRun | null, last: SkillsAttemptRead | null, now: number): string {
  if (run) return phaseKey(run, now);
  return last ? "submitted" : "none";
}

function TimerButtons({
  timer,
  now,
  disabled,
  onAction,
}: {
  timer: SkillsClockState;
  now: number;
  disabled: boolean;
  onAction: (action: SkillsClockAction) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {skillsClockActions(timer, now).map((action) => (
        <button
          key={action}
          type="button"
          className={`btn btn-small${action === "start" || action === "resume" ? " btn-primary" : ""}`}
          disabled={disabled}
          onClick={() => onAction(action)}
        >
          {t(`skillsControl.action.${action}`)}
        </button>
      ))}
    </>
  );
}

/** One skills field set: its type, its shared timer, and a row per field. */
export function SkillsSetCard({
  sessionId,
  fieldSet,
  set,
  types,
  sessionTypes,
  teams,
  attempts,
  busyTeamIds,
  now,
  socketEvents,
}: {
  sessionId: number;
  fieldSet: FieldSetRead;
  set: SkillsSet;
  types: SkillsType[];
  sessionTypes: SessionSkillsType[];
  teams: TeamSummary[];
  attempts: SkillsAttemptRead[];
  busyTeamIds: Set<number>;
  now: number;
  /** Live events for the scoring panel (from useSkillsControlData). */
  socketEvents: ScoringSocket;
}) {
  const { t } = useTranslation();
  const scoresheetT = useScoresheetT();
  const actions = useSkillsControlActions();
  const headingId = useId();
  const typeSelectId = useId();
  const scoreHeadingId = useId();
  const [starting, setStarting] = useState<FieldRef | null>(null);
  const [scoring, setScoring] = useState<FieldRef | null>(null);
  const [discarding, setDiscarding] = useState<(FieldRef & { teamNumber: string }) | null>(null);
  const hasRuns = set.fields.some((field) => field.run !== null);
  const typeLabel = (key: string) => types.find((type) => type.key === key)?.label ?? key;
  const runSeconds = (key: string) => types.find((type) => type.key === key)?.run_seconds ?? null;
  const teamNumber = (id: number) => teams.find((team) => team.id === id)?.number ?? "?";
  const failed = [actions.setTimer, actions.setType, actions.fieldTimer].find((mutation) => mutation.isError);
  const busy = actions.setTimer.isPending || actions.fieldTimer.isPending;

  return (
    <section className="panel skills-set" role="region" aria-labelledby={headingId}>
      <h2 id={headingId}>{fieldSet.name}</h2>
      {failed && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(failed.error, t("errors.generic"))}
        </p>
      )}
      <div className="skills-set__header">
        <div className="field">
          <label className="field__label" htmlFor={typeSelectId}>
            {t("skillsControl.typeLabel")}
          </label>
          <select
            id={typeSelectId}
            className="select"
            value={set.timer.skills_type ?? ""}
            disabled={hasRuns || actions.setType.isPending}
            onChange={(event) => actions.setType.mutate({ fieldSetId: fieldSet.id, skillsType: event.target.value })}
          >
            {types.map((type) => (
              <option key={type.key} value={type.key}>
                {type.label}
              </option>
            ))}
          </select>
          {hasRuns && <p className="field__hint">{t("skillsControl.typeLocked")}</p>}
        </div>
        <div className="skills-set__timer" role="group" aria-label={t("skillsControl.setTimer")}>
          <p className="match-control__clock" data-testid={`set-clock-${fieldSet.id}`}>
            {formatClock(skillsClockSeconds(set.timer, now, set.timer.run_seconds))}
          </p>
          <p>{t(`skillsControl.phase.${phaseKey(set.timer, now)}`)}</p>
          <div className="form-actions">
            <TimerButtons
              timer={set.timer}
              now={now}
              disabled={busy}
              onAction={(action) => actions.setTimer.mutate({ fieldSetId: fieldSet.id, action })}
            />
          </div>
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t("skillsControl.columns.field")}</th>
              <th scope="col">{t("skillsControl.columns.team")}</th>
              <th scope="col">{t("skillsControl.columns.type")}</th>
              <th scope="col">{t("skillsControl.columns.timer")}</th>
              <th scope="col">{t("skillsControl.columns.state")}</th>
              <th scope="col" className="table__actions">
                {t("skillsControl.columns.actions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {set.fields.map((row) => {
              const run = row.run;
              const field = { id: row.field_id, name: row.name };
              const last = lastFieldAttempt(attempts, row.field_id);
              return (
                <tr key={row.field_id} aria-label={row.name}>
                  <th scope="row">{row.name}</th>
                  <td>
                    {run
                      ? `${run.team_number} ${run.team_name}`
                      : last
                        ? t("skillsControl.last", { number: teamNumber(last.team_id), score: last.score })
                        : "—"}
                  </td>
                  <td>{run ? typeLabel(run.skills_type) : "—"}</td>
                  <td className="table__nowrap">
                    {run
                      ? run.follows_set
                        ? t("skillsControl.followsSet")
                        : t("skillsControl.alone", {
                            clock: formatClock(skillsClockSeconds(run, now, runSeconds(run.skills_type))),
                          })
                      : "—"}
                  </td>
                  <td>{t(`skillsControl.state.${rowStateKey(run, last, now)}`)}</td>
                  <td className="table__actions">
                    {run ? (
                      <div className="skills-set__row-actions">
                        <button className="btn btn-small btn-primary" type="button" onClick={() => setScoring(field)}>
                          {t("skillsControl.score")}
                        </button>
                        <button
                          className="btn btn-small btn-danger"
                          type="button"
                          onClick={() => setDiscarding({ ...field, teamNumber: run.team_number })}
                        >
                          {t("skillsControl.discard")}
                        </button>
                        <div
                          className="form-actions"
                          role="group"
                          aria-label={t("skillsControl.fieldTimer", { name: row.name })}
                        >
                          <TimerButtons
                            timer={run}
                            now={now}
                            disabled={busy}
                            onAction={(action) =>
                              actions.fieldTimer.mutate({ fieldSetId: fieldSet.id, fieldId: row.field_id, action })
                            }
                          />
                        </div>
                      </div>
                    ) : (
                      <button className="btn btn-small" type="button" onClick={() => setStarting(field)}>
                        {t("skillsControl.startRun")}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="field__hint">{t("skillsControl.fieldTimerHint")}</p>

      {starting && (
        <StartRunDialog
          sessionId={sessionId}
          fieldSetId={fieldSet.id}
          field={starting}
          setType={set.timer.skills_type}
          types={types}
          sessionTypes={sessionTypes}
          teams={teams}
          busyTeamIds={busyTeamIds}
          onClose={() => setStarting(null)}
        />
      )}
      {scoring && (
        <Modal labelledBy={scoreHeadingId} onCancel={() => setScoring(null)}>
          <h2 id={scoreHeadingId}>{t("skillsControl.scoreHeading", { name: scoring.name })}</h2>
          <SkillsRunPanel
            fieldId={scoring.id}
            fieldSetId={fieldSet.id}
            t={scoresheetT}
            myDeviceName="Admin"
            socketEvents={socketEvents}
            request={apiRequest}
          />
          <div className="dialog__actions">
            <button className="btn" type="button" onClick={() => setScoring(null)}>
              {t("skillsControl.close")}
            </button>
          </div>
        </Modal>
      )}
      {discarding && (
        <ConfirmDialog
          heading={t("skillsControl.discardHeading", { name: discarding.name })}
          body={t("skillsControl.discardBody", { number: discarding.teamNumber })}
          confirmLabel={t("skillsControl.discardConfirm")}
          cancelLabel={t("skillsControl.cancel")}
          isPending={actions.discard.isPending}
          error={actions.discard.isError ? apiErrorMessage(actions.discard.error, t("errors.generic")) : null}
          onConfirm={() =>
            actions.discard.mutate(
              { fieldSetId: fieldSet.id, fieldId: discarding.id },
              { onSuccess: () => setDiscarding(null) }
            )
          }
          onCancel={() => {
            actions.discard.reset();
            setDiscarding(null);
          }}
        />
      )}
    </section>
  );
}
```

- [ ] **Step 11: Write the route, the nav link and the route entry**

Create `frontend/apps/admin/src/routes/SkillsControlRoute.tsx`:

```tsx
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { SkillsSetCard } from "../skillsControl/SkillsSetCard";
import { useNow, useSkillsControlData } from "../skillsControl/useSkillsControl";
import type { EventRead } from "../types";

/** The operator page for skills fields in the active session. */
export function SkillsControlRoute() {
  const { t } = useTranslation();
  const event = useQuery({ queryKey: ["event"], queryFn: () => apiRequest<EventRead>("/api/event") });
  const sessionId = event.data?.active_session_id ?? null;
  return (
    <div>
      <h1>{t("skillsControl.heading")}</h1>
      {event.data && sessionId === null && (
        <p className="alert alert-warning">
          {t("skillsControl.noSession")} <Link to="/sessions">{t("skillsControl.sessionsLink")}</Link>
        </p>
      )}
      {sessionId !== null && <SkillsControlBody sessionId={sessionId} />}
    </div>
  );
}

function SkillsControlBody({ sessionId }: { sessionId: number }) {
  const { t } = useTranslation();
  const now = useNow();
  const data = useSkillsControlData(sessionId);
  const settings = data.settings.data;
  if (settings && !settings.enabled) {
    return (
      <p className="alert alert-warning">
        {t("skillsControl.skillsOff")} <Link to="/events/setup">{t("skillsControl.skillsOffLink")}</Link>
      </p>
    );
  }
  if (data.fieldSets.data && data.skillsSets.length === 0) {
    return (
      <p>
        {t("skillsControl.noSets")} <Link to={`/sessions/${sessionId}/fields`}>{t("skillsControl.fieldsLink")}</Link>
      </p>
    );
  }
  const sessionSkills = data.sessionSkills.data;
  const attempts = data.attempts.data;
  const teams = data.teams.data;
  if (!data.fieldSets.data || !settings || !sessionSkills || !attempts || !teams) {
    return <p>{t("skillsControl.loading")}</p>;
  }
  const loaded = data.sets.map((query) => query.data);
  // A team already on any skills field can't start a second run.
  const busyTeamIds = new Set(
    loaded.flatMap((set) => set?.fields.flatMap((field) => (field.run ? [field.run.team_id] : [])) ?? [])
  );
  return (
    <div className="skills-control">
      {data.skillsSets.map((fieldSet, index) => {
        const set = loaded[index];
        if (!set) return <p key={fieldSet.id}>{t("skillsControl.loading")}</p>;
        return (
          <SkillsSetCard
            key={fieldSet.id}
            sessionId={sessionId}
            fieldSet={fieldSet}
            set={set}
            types={settings.types}
            sessionTypes={sessionSkills.types}
            teams={teams}
            attempts={attempts}
            busyTeamIds={busyTeamIds}
            now={now}
            socketEvents={data.socketEvents}
          />
        );
      })}
    </div>
  );
}
```

In `frontend/apps/admin/src/components/AppShell.tsx`, in the admin `<nav>`, add after the Match Control link:

```tsx
            <NavLink to="/skills-control" className={navLinkClassName}>
              {t("shell.skillsControlLink")}
            </NavLink>
```

In `frontend/apps/admin/src/router.tsx`, import `SkillsControlRoute` from `./routes/SkillsControlRoute` and add after the `match-control` entry:

```tsx
      { path: "skills-control", element: <RequiresGamePlugin><SkillsControlRoute /></RequiresGamePlugin> },
```

- [ ] **Step 12: Add the styles and strings**

Append to `frontend/apps/admin/src/styles/components.css`:

```css
.skills-control { display: grid; gap: var(--space-4); }
.skills-set__header { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--space-4); }
.skills-set__timer { min-width: 240px; }
.skills-set__row-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-1); }
.skills-set__row-actions .form-actions { margin: 0; }
```

Add to `shell` in `en/admin.json`: `"skillsControlLink": "Skills Control"`, and in `zh/admin.json`: `"skillsControlLink": "技能赛控制"`.

Add a top-level `"skillsControl"` object to `en/admin.json`:

```json
  "skillsControl": {
    "heading": "Skills Control",
    "noSession": "No session is active. Make one active on the",
    "sessionsLink": "Sessions page.",
    "skillsOff": "Skills challenges are turned off for this event.",
    "skillsOffLink": "Go to Event Setup",
    "noSets": "This session has no skills field set. Set a field set's purpose to Skills on the",
    "fieldsLink": "Fields page.",
    "loading": "Loading…",
    "typeLabel": "Skills type",
    "typeLocked": "Finish or discard this set's runs to change the type.",
    "setTimer": "Set timer",
    "fieldTimer": "Timer for {{name}}",
    "fieldTimerHint": "A field's own timer buttons take that field off the set timer until its run is submitted or discarded.",
    "columns": { "field": "Field", "team": "Team", "type": "Type", "timer": "Timer", "state": "State", "actions": "Actions" },
    "followsSet": "Set timer",
    "alone": "Alone · {{clock}}",
    "last": "Last: {{number}} · {{score}}",
    "state": { "none": "No run", "ready": "Ready", "running": "Running", "paused": "Paused", "ended": "Ended", "submitted": "Submitted" },
    "phase": { "ready": "Ready", "running": "Running", "paused": "Paused", "ended": "Time's up" },
    "action": { "start": "Start", "pause": "Pause", "resume": "Resume", "reset": "Reset", "end": "End" },
    "startRun": "Start run",
    "startHeading": "Start a run on {{name}}",
    "teamLabel": "Team",
    "teamPlaceholder": "Choose a team…",
    "noTeams": "No checked-in team has an attempt of this type left.",
    "ownTimerHint": "A type other than the set's runs on this field's own timer.",
    "startConfirm": "Start run",
    "score": "Score",
    "scoreHeading": "Score {{name}}",
    "close": "Close",
    "discard": "Discard",
    "discardHeading": "Discard the run on {{name}}?",
    "discardBody": "Team {{number}}'s entries are thrown away and no attempt is used.",
    "discardConfirm": "Discard run",
    "cancel": "Cancel"
  },
```

and to `zh/admin.json`:

```json
  "skillsControl": {
    "heading": "技能赛控制",
    "noSession": "当前没有进行中的场次。请在",
    "sessionsLink": "场次页面设置。",
    "skillsOff": "本赛事已关闭技能挑战赛。",
    "skillsOffLink": "前往赛事设置",
    "noSets": "本场次没有技能赛场地组。请在",
    "fieldsLink": "场地页面将场地组的用途设为技能赛。",
    "loading": "加载中…",
    "typeLabel": "技能赛类型",
    "typeLocked": "完成或放弃本组的所有轮次后才能更改类型。",
    "setTimer": "场地组计时",
    "fieldTimer": "{{name}} 的计时",
    "fieldTimerHint": "使用某个场地自己的计时按钮后，该场地将脱离场地组计时，直到本轮提交或放弃。",
    "columns": { "field": "场地", "team": "队伍", "type": "类型", "timer": "计时", "state": "状态", "actions": "操作" },
    "followsSet": "场地组计时",
    "alone": "单独 · {{clock}}",
    "last": "上一轮：{{number}} · {{score}}",
    "state": { "none": "无轮次", "ready": "就绪", "running": "进行中", "paused": "已暂停", "ended": "已结束", "submitted": "已提交" },
    "phase": { "ready": "就绪", "running": "进行中", "paused": "已暂停", "ended": "时间到" },
    "action": { "start": "开始", "pause": "暂停", "resume": "继续", "reset": "重置", "end": "结束" },
    "startRun": "开始一轮",
    "startHeading": "在 {{name}} 开始一轮",
    "teamLabel": "队伍",
    "teamPlaceholder": "选择队伍…",
    "noTeams": "没有已签到且仍有该类型尝试次数的队伍。",
    "ownTimerHint": "与场地组不同的类型将使用该场地自己的计时。",
    "startConfirm": "开始一轮",
    "score": "计分",
    "scoreHeading": "为 {{name}} 计分",
    "close": "关闭",
    "discard": "放弃",
    "discardHeading": "放弃 {{name}} 上的这一轮？",
    "discardBody": "队伍 {{number}} 的记录将被丢弃，不消耗尝试次数。",
    "discardConfirm": "放弃这一轮",
    "cancel": "取消"
  },
```

- [ ] **Step 13: Run the tests and type checks**

Run: `cd frontend/apps/admin && npx vitest run && npx tsc -b`
Expected: all pass, `tsc` silent.

Run: `cd frontend/packages/shared && npx vitest run && npx tsc -b`
Expected: all pass, `tsc` silent.

- [ ] **Step 14: Commit**

```bash
git add server/tests/test_skills_attempt_field.py frontend/packages/shared/src/display/skillsClock.ts frontend/packages/shared/src/display/index.ts frontend/packages/shared/tests/skillsClock.test.ts frontend/apps/admin/src/routes/SkillsControlRoute.tsx frontend/apps/admin/src/skillsControl frontend/apps/admin/src/types.ts frontend/apps/admin/src/components/AppShell.tsx frontend/apps/admin/src/router.tsx frontend/apps/admin/src/styles/components.css frontend/apps/admin/src/i18n/en/admin.json frontend/apps/admin/src/i18n/zh/admin.json frontend/apps/admin/tests/unit/SkillsControlRoute.test.tsx frontend/apps/admin/tests/unit/AppShell.test.tsx frontend/apps/admin/tests/unit/SessionFieldsRoute.test.tsx frontend/apps/admin/tests/unit/SessionScheduleRoute.test.tsx frontend/apps/admin/tests/unit/readiness.test.ts frontend/apps/admin/tests/unit/SessionSkillsRoute.test.tsx frontend/apps/admin/tests/unit/AttemptsTable.test.tsx frontend/apps/admin/tests/unit/attemptsTable.test.ts frontend/apps/admin/tests/unit/recordForm.test.ts
git commit -m "Add Skills Control: one card per skills field set in the active session with its type, the shared set timer and a row per field showing the team, type, set or own timer and state, with Start run for a checked-in team that has an attempt left, Score, Discard and the field's own timer controls, plus a test pinning the field each skills attempt reports.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Admin settings surfaces

**Files:**
- Modify: `frontend/apps/admin/src/routes/SessionFieldsRoute.tsx`, `frontend/apps/admin/src/schedule/readiness.ts`
- Modify: `frontend/apps/admin/src/routes/SessionsRoute.tsx` (the `SessionRead` switches are typed by Task 14)
- Modify: `frontend/apps/admin/src/routes/DevicesRoute.tsx`, `frontend/apps/admin/src/devices/useDevices.ts`
- Modify: `frontend/apps/admin/src/routes/SessionSkillsRoute.tsx`, `frontend/apps/admin/src/skills/AttemptsTable.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `frontend/apps/admin/src/i18n/zh/admin.json`
- Test: `frontend/apps/admin/tests/unit/SessionFieldsRoute.test.tsx`, `readiness.test.ts`, `SessionsRoute.test.tsx`, `DevicesRoute.test.tsx`, `AttemptsTable.test.tsx`, `SessionSkillsRoute.test.tsx` (all extended)

**Interfaces:**
- Consumes: Task 2 (`PATCH /api/field-sets/{id}` with `purpose` and its 409s `"This field set has matches."` / `"This field set has skills runs."`; `PATCH /api/sessions/{id}` with `live_scores_qualification` / `live_scores_finals`), Task 11 (`DeviceRead.binding: {field_id, field_name} | null`, `DELETE /api/devices/{id}/binding`, `scorer_binding_changed`), Task 15 (`FieldSetRead.purpose`, `SkillsAttemptRead.field_id`).
- Produces: the session form's live-score switches (reading Task 14's optional `SessionRead.live_scores_qualification?` / `live_scores_finals?`); `DeviceBinding`, `DeviceRead.binding`; `useDeviceMutations().clearBinding`; `AttemptsTable`'s new `fields: FieldRead[]` prop; `countUsableFields` ignores skills sets.

Plan note: `SessionRead`'s two switches are declared optional by Task 14 (read here with `?? true` / `?? false`, the server defaults) so the many existing `SessionRead` test fixtures keep compiling; the server always sends them.

Plan note: the schedule's readiness check counts usable fields per division; a skills set would wrongly satisfy "This division has no fields", so `countUsableFields` now skips skills sets. It is the admin half of Task 2's "scheduling ignores skills sets".

- [ ] **Step 1: Write the failing tests**

In `frontend/apps/admin/tests/unit/SessionFieldsRoute.test.tsx`, add a skills set fixture under `FIELD_A`:

```tsx
const SKILLS_SET: FieldSetRead = { id: 11, session_id: 1, name: "Skills Row", division_id: null, purpose: "skills" };
const SKILLS_FIELD: FieldRead = { id: 110, field_set_id: 11, name: "Skills 1" };
```

and add these tests inside `describe("SessionFieldsRoute", …)`:

```tsx
  it("lists teamwork and skills field sets in separate sections", async () => {
    stubServer({ divisions: ONE_DIVISION, fieldSets: [MAIN_SET, SKILLS_SET], fields: [FIELD_A, SKILLS_FIELD] });
    renderFields();
    const teamwork = await screen.findByRole("region", { name: "Teamwork field sets" });
    const skills = screen.getByRole("region", { name: "Skills field sets" });
    expect(within(teamwork).getByRole("region", { name: "Main Fields" })).toBeInTheDocument();
    expect(within(teamwork).queryByRole("region", { name: "Skills Row" })).not.toBeInTheDocument();
    expect(within(skills).getByRole("region", { name: "Skills Row" })).toHaveTextContent("Skills 1");
    expect(within(within(skills).getByRole("region", { name: "Skills Row" })).getByLabelText("Purpose")).toHaveValue("skills");
  });

  it("hides the skills section while there is no skills set", async () => {
    stubServer({ divisions: ONE_DIVISION, fieldSets: [MAIN_SET], fields: [FIELD_A] });
    renderFields();
    expect(await screen.findByRole("region", { name: "Teamwork field sets" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Skills field sets" })).not.toBeInTheDocument();
  });

  it("changes a set's purpose", async () => {
    stubServer({ divisions: ONE_DIVISION, fieldSets: [MAIN_SET], fields: [FIELD_A] }, (path, options) =>
      path === "/api/field-sets/10" && options?.method === "PATCH" ? { ...MAIN_SET, purpose: "skills" } : NOT_HANDLED
    );
    renderFields();
    const card = await screen.findByRole("region", { name: "Main Fields" });
    fireEvent.change(within(card).getByLabelText("Purpose"), { target: { value: "skills" } });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/field-sets/10", { method: "PATCH", body: { purpose: "skills" } })
    );
  });

  it("shows the server's refusal when a set's purpose can't change", async () => {
    stubServer({ divisions: ONE_DIVISION, fieldSets: [MAIN_SET], fields: [FIELD_A] }, (path, options) =>
      path === "/api/field-sets/10" && options?.method === "PATCH" ? new ApiError(409, "This field set has matches.") : NOT_HANDLED
    );
    renderFields();
    const card = await screen.findByRole("region", { name: "Main Fields" });
    fireEvent.change(within(card).getByLabelText("Purpose"), { target: { value: "skills" } });
    expect(await within(card).findByRole("alert")).toHaveTextContent("This field set has matches.");
  });
```

In `frontend/apps/admin/tests/unit/readiness.test.ts`, add:

```ts
  it("never counts a skills set's fields", () => {
    const fieldSets = [
      { id: 1, session_id: 1, name: "Main Fields", division_id: null, purpose: "teamwork" as const },
      { id: 2, session_id: 1, name: "Skills Row", division_id: null, purpose: "skills" as const },
    ];
    const fields = [
      { id: 10, field_set_id: 1, name: "A" },
      { id: 11, field_set_id: 2, name: "Skills 1" },
      { id: 12, field_set_id: 2, name: "Skills 2" },
    ];
    expect(countUsableFields(fieldSets, fields, null)).toBe(1);
  });
```

In `frontend/apps/admin/tests/unit/SessionsRoute.test.tsx`, change the edit test's expectation to

```tsx
      expect(patchBody).toEqual({
        label: "Renamed",
        session_date: null,
        timezone: null,
        live_scores_qualification: true,
        live_scores_finals: false,
      })
```

and add:

```tsx
  it("edits a session's live-score switches", async () => {
    let patchBody: unknown = null;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/sessions" && !options) {
        return [
          {
            id: 1, event_id: 1, label: "Saturday", session_date: null, timezone: null,
            live_scores_qualification: true, live_scores_finals: false,
          },
        ] as never;
      }
      if (path === "/api/sessions/1" && (options as { method?: string })?.method === "PATCH") {
        patchBody = (options as { body: unknown }).body;
        return { id: 1, event_id: 1, label: "Saturday", session_date: null, timezone: null } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByText("Saturday");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const qualification = screen.getByLabelText("Show live scores on displays in practice and qualification");
    const finals = screen.getByLabelText("Show live scores on displays in finals");
    expect(qualification).toBeChecked();
    expect(finals).not.toBeChecked();
    fireEvent.click(qualification);
    fireEvent.click(finals);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(patchBody).toEqual({
        label: "Saturday",
        session_date: null,
        timezone: null,
        live_scores_qualification: false,
        live_scores_finals: true,
      })
    );
  });

  it("leaves the live-score switches out of a new session's form", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/sessions") return [] as never;
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "Add session..." }));
    expect(screen.queryByLabelText("Show live scores on displays in finals")).not.toBeInTheDocument();
  });
```

In `frontend/apps/admin/tests/unit/DevicesRoute.test.tsx`, add `binding: null,` to the object `device(...)` returns (after `disabled_at: null,`), and add inside `describe("DevicesRoute", …)`:

```tsx
  it("shows a scorer's field binding and clears it", async () => {
    devices = [device({ id: 2, name: "Tablet 1", role: "scorer", binding: { field_id: 5, field_name: "Field 2" } })];
    stub({ "DELETE /api/devices/2/binding": undefined });
    renderRoute();
    const row = await rowFor("Tablet 1");
    expect(row).toHaveTextContent("Scoring · Field 2");
    fireEvent.click(within(row).getByRole("button", { name: "Clear Tablet 1's field" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/devices/2/binding", { method: "DELETE" }));
  });

  it("shows nothing in the Group column for an unbound scorer", async () => {
    devices = [device({ id: 2, name: "Tablet 1", role: "scorer" })];
    stub();
    renderRoute();
    const row = await rowFor("Tablet 1");
    expect(within(row).queryByRole("button", { name: /field$/ })).not.toBeInTheDocument();
    expect(row).not.toHaveTextContent("Scoring");
  });

  it("refetches the list on a scorer_binding_changed event", async () => {
    let onEvent: ((event: RealtimeEvent) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      onEvent = options.onEvent;
      return { connected: true };
    });
    renderRoute();
    await rowFor("Pit TV");
    const before = devicesFetches();
    act(() => onEvent?.({ event: "scorer_binding_changed", data: { device_id: 2 } } as RealtimeEvent));
    await waitFor(() => expect(devicesFetches()).toBeGreaterThan(before));
  });
```

In `frontend/apps/admin/tests/unit/AttemptsTable.test.tsx`, add `const FIELDS = [{ id: 31, field_set_id: 20, name: "Skills 1" }];`, pass `fields={FIELDS}` to `<AttemptsTable … />` in `renderTable`, change `ATTEMPTS`' first entry to `{ ...attempt(1, 1, "autonomous", 1, 20), field_id: 31 }`, and add:

```tsx
  it("shows the field an attempt was scored on", () => {
    stub();
    renderTable();
    const cell = screen.getByRole("button", { name: /Edit Autonomous attempt 1 for team 101/ }).closest("td")!;
    expect(cell).toHaveTextContent("Skills 1");
    const driver = screen.getByRole("button", { name: /Edit Driver attempt 1 for team 101/ }).closest("td")!;
    expect(driver).not.toHaveTextContent("Skills 1");
  });
```

In `frontend/apps/admin/tests/unit/SessionSkillsRoute.test.tsx`'s `stub`, serve the session's fields before the final `throw`:

```tsx
    if (path === "/api/fields?session_id=1") return [] as never;
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/SessionFieldsRoute.test.tsx tests/unit/readiness.test.ts tests/unit/SessionsRoute.test.tsx tests/unit/DevicesRoute.test.tsx tests/unit/AttemptsTable.test.tsx`
Expected: FAIL (no "Teamwork field sets" region, no Purpose select, skills fields counted, the PATCH body has no switches, no binding text, no field name in the table).

- [ ] **Step 3: Fields page: purpose select and two sections**

In `frontend/apps/admin/src/routes/SessionFieldsRoute.tsx`:

Import the purpose type: change the types import to `import type { Division, FieldRead, FieldSetPurpose, FieldSetRead, SessionRead } from "../types";` and add under the imports:

```tsx
const PURPOSES: FieldSetPurpose[] = ["teamwork", "skills"];
```

Add a mutation after `assignDivisionMutation`:

```tsx
  const purposeMutation = useMutation({
    mutationFn: ({ id, purpose }: { id: number; purpose: FieldSetPurpose }) =>
      apiRequest<FieldSetRead>(`/api/field-sets/${id}`, { method: "PATCH", body: { purpose } }),
    onSuccess: (_set, { id }) => {
      setCardError(id, null);
      refresh();
    },
    onError: (error, { id }) => setCardError(id, apiErrorMessage(error, generic)),
  });
```

Group the cards by purpose. Replace

```tsx
      ) : (
        fieldSets.map((fieldSet) => {
          const setFields = fields.filter((field) => field.field_set_id === fieldSet.id);
```

with

```tsx
      ) : (
        PURPOSES.filter(
          (purpose) => purpose === "teamwork" || fieldSets.some((fieldSet) => fieldSet.purpose === purpose)
        ).map((purpose) => (
          <section
            key={purpose}
            className="field-set-group"
            aria-labelledby={`field-sets-${purpose}-heading`}
          >
            <h2 id={`field-sets-${purpose}-heading`}>{t(`sessions.fields.${purpose}Heading`)}</h2>
            {fieldSets
              .filter((fieldSet) => fieldSet.purpose === purpose)
              .map((fieldSet) => {
          const setFields = fields.filter((field) => field.field_set_id === fieldSet.id);
```

and close it by replacing the end of that map

```tsx
            </section>
          );
        })
      )}
      <form
```

with

```tsx
            </section>
          );
        })}
          </section>
        ))
      )}
      <form
```

(re-indent the card body one level; nothing inside it changes apart from the select below). Then, in the card header, add the purpose select right after the division `<label>` block (before the Delete set button):

```tsx
                <label className="field-set-card__division">
                  <span>{t("sessions.fields.purposeLabel")}</span>
                  <select
                    className="select"
                    value={fieldSet.purpose}
                    disabled={purposeMutation.isPending && purposeMutation.variables?.id === fieldSet.id}
                    onChange={(event) =>
                      purposeMutation.mutate({ id: fieldSet.id, purpose: event.target.value as FieldSetPurpose })
                    }
                  >
                    {PURPOSES.map((purpose) => (
                      <option key={purpose} value={purpose}>
                        {t(`sessions.fields.purpose.${purpose}`)}
                      </option>
                    ))}
                  </select>
                </label>
```

The card's existing `cardErrors[fieldSet.id]` alert shows the server's 409 (`"This field set has matches."`, `"This field set has skills runs."`).

In `frontend/apps/admin/src/schedule/readiness.ts`, make `countUsableFields` skip skills sets:

```ts
/** Fields the generator will use for this division: those in teamwork sets assigned to it (`null` = unassigned sets). */
export function countUsableFields(
  fieldSets: FieldSetRead[],
  fields: FieldRead[],
  divisionId: number | null
): number {
  const setIds = new Set(
    fieldSets.filter((fs) => fs.purpose !== "skills" && fs.division_id === divisionId).map((fs) => fs.id)
  );
  return fields.filter((field) => setIds.has(field.field_set_id)).length;
}
```

- [ ] **Step 4: Sessions page: the two switches**

`SessionRead.live_scores_qualification?` / `live_scores_finals?` are already in `frontend/apps/admin/src/types.ts` (Task 14 Step 3); do not declare them again.

In `frontend/apps/admin/src/routes/SessionsRoute.tsx`:

```tsx
interface SessionFormValues {
  label: string;
  sessionDate: string;
  timezone: string;
  liveQualification: boolean;
  liveFinals: boolean;
}

const EMPTY_FORM: SessionFormValues = {
  label: "",
  sessionDate: "",
  timezone: "",
  liveQualification: true,
  liveFinals: false,
};
```

Give `SessionForm` a `showLiveSwitches?: boolean` prop (default `false`) and render, after the timezone field:

```tsx
      {showLiveSwitches && (
        <fieldset className="field">
          <legend className="field__label">{t("sessions.liveScoresLegend")}</legend>
          <label className="choice">
            <input
              type="checkbox"
              checked={values.liveQualification}
              onChange={(event) => setValues({ ...values, liveQualification: event.target.checked })}
            />{" "}
            {t("sessions.liveQualificationLabel")}
          </label>
          <label className="choice">
            <input
              type="checkbox"
              checked={values.liveFinals}
              onChange={(event) => setValues({ ...values, liveFinals: event.target.checked })}
            />{" "}
            {t("sessions.liveFinalsLabel")}
          </label>
        </fieldset>
      )}
```

The edit row passes `showLiveSwitches` and seeds the switches:

```tsx
                    <SessionForm
                      inline
                      showLiveSwitches
                      initial={{
                        label: session.label,
                        sessionDate: session.session_date ?? "",
                        timezone: session.timezone ?? "",
                        liveQualification: session.live_scores_qualification ?? true,
                        liveFinals: session.live_scores_finals ?? false,
                      }}
```

and `updateMutation` sends them:

```tsx
        body: {
          label: values.label,
          session_date: values.sessionDate || null,
          timezone: values.timezone || null,
          live_scores_qualification: values.liveQualification,
          live_scores_finals: values.liveFinals,
        },
```

`createMutation`'s body is unchanged: a new session starts with the server defaults.

- [ ] **Step 5: Devices page: a scorer's binding with Clear**

In `frontend/apps/admin/src/devices/useDevices.ts`:

```ts
export interface DeviceBinding {
  field_id: number;
  field_name: string;
}
```

add `binding: DeviceBinding | null;` to `DeviceRead` after `display_group`, and add to `useDeviceMutations`' returned object:

```ts
    clearBinding: useMutation({
      mutationFn: (id: number) => apiRequest<void>(`/api/devices/${id}/binding`, { method: "DELETE" }),
      onSuccess: refresh,
    }),
```

In `frontend/apps/admin/src/routes/DevicesRoute.tsx`, take `clearBinding` from `useDeviceMutations()`, refetch on the binding event too:

```tsx
    onEvent: (event) => {
      if (event.event === "devices_changed" || event.event === "scorer_binding_changed") {
        void queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
      }
    },
```

and replace the Group cell with:

```tsx
                    <td>
                      {device.role === "display_device" ? (
                        device.display_group ?? t("devices.noGroup")
                      ) : device.binding ? (
                        <span className="devices__binding">
                          {t("devices.binding", { field: device.binding.field_name })}{" "}
                          <button
                            className="btn btn-small"
                            type="button"
                            disabled={clearBinding.isPending}
                            aria-label={t("devices.clearBindingLabel", { name: device.name })}
                            onClick={() => clearBinding.mutate(device.id)}
                          >
                            {t("devices.clearBinding")}
                          </button>
                        </span>
                      ) : (
                        ""
                      )}
                    </td>
```

Below the existing `setEnabled` error alert add:

```tsx
        {clearBinding.isError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(clearBinding.error, t("errors.generic"))}
          </p>
        )}
```

- [ ] **Step 6: Skills page: an attempt's field**

In `frontend/apps/admin/src/skills/AttemptsTable.tsx`, add a `fields` prop:

```tsx
export function AttemptsTable({
  sessionId,
  types,
  attempts,
  teams,
  fields,
}: {
  sessionId: number;
  types: SessionSkillsType[];
  attempts: SkillsAttemptRead[];
  /** Every team (not just checked-in ones): a team may have been un-checked-in after recording. */
  teams: TeamSummary[];
  /** The session's fields, to name the skills field an attempt was scored on. */
  fields: FieldRead[];
}) {
```

(import `FieldRead` with the other types), compute `const fieldName = (id: number | null) => (id === null ? null : fields.find((field) => field.id === id)?.name ?? null);` next to `rows`, and right after the attempt's `<button className="btn-link" …>{attempt.score}</button>` add:

```tsx
                              {fieldName(attempt.field_id) && (
                                <span className="table__secondary"> {fieldName(attempt.field_id)}</span>
                              )}
```

(the button and this span go inside a fragment in the `attempt ? (…)` branch).

In `frontend/apps/admin/src/routes/SessionSkillsRoute.tsx`, read the session's fields (same key as the Fields tab) and pass them; a field read that fails only drops the names:

```tsx
  const fields = useQuery({
    queryKey: ["fields", session.id],
    queryFn: () => apiRequest<FieldRead[]>(`/api/fields?session_id=${session.id}`),
  });
```

```tsx
      <AttemptsTable
        sessionId={session.id}
        types={sessionSkills.data.types}
        attempts={attempts.data}
        teams={teams.data}
        fields={fields.data ?? []}
      />
```

(add `FieldRead` to the `../types` import).

- [ ] **Step 7: Add the strings**

`en/admin.json`:
- in `sessions.fields`: `"purposeLabel": "Purpose"`, `"purpose": { "teamwork": "Teamwork", "skills": "Skills" }`, `"teamworkHeading": "Teamwork field sets"`, `"skillsHeading": "Skills field sets"`;
- in `sessions`: `"liveScoresLegend": "Live scores on displays"`, `"liveQualificationLabel": "Show live scores on displays in practice and qualification"`, `"liveFinalsLabel": "Show live scores on displays in finals"`;
- in `devices`: `"binding": "Scoring · {{field}}"`, `"clearBinding": "Clear"`, `"clearBindingLabel": "Clear {{name}}'s field"`.

`zh/admin.json`:
- in `sessions.fields`: `"purposeLabel": "用途"`, `"purpose": { "teamwork": "团队赛", "skills": "技能赛" }`, `"teamworkHeading": "团队赛场地组"`, `"skillsHeading": "技能赛场地组"`;
- in `sessions`: `"liveScoresLegend": "显示屏上的实时比分"`, `"liveQualificationLabel": "在练习赛和资格赛期间在显示屏上显示实时比分"`, `"liveFinalsLabel": "在决赛期间在显示屏上显示实时比分"`;
- in `devices`: `"binding": "计分 · {{field}}"`, `"clearBinding": "清除"`, `"clearBindingLabel": "清除 {{name}} 的场地"`.

- [ ] **Step 8: Run the tests and type check**

Run: `cd frontend/apps/admin && npx vitest run && npx tsc -b`
Expected: all pass, `tsc` silent.

- [ ] **Step 9: Commit**

```bash
git add frontend/apps/admin/src/routes/SessionFieldsRoute.tsx frontend/apps/admin/src/schedule/readiness.ts frontend/apps/admin/src/routes/SessionsRoute.tsx frontend/apps/admin/src/types.ts frontend/apps/admin/src/routes/DevicesRoute.tsx frontend/apps/admin/src/devices/useDevices.ts frontend/apps/admin/src/routes/SessionSkillsRoute.tsx frontend/apps/admin/src/skills/AttemptsTable.tsx frontend/apps/admin/src/i18n/en/admin.json frontend/apps/admin/src/i18n/zh/admin.json frontend/apps/admin/tests/unit/SessionFieldsRoute.test.tsx frontend/apps/admin/tests/unit/readiness.test.ts frontend/apps/admin/tests/unit/SessionsRoute.test.tsx frontend/apps/admin/tests/unit/DevicesRoute.test.tsx frontend/apps/admin/tests/unit/AttemptsTable.test.tsx frontend/apps/admin/tests/unit/SessionSkillsRoute.test.tsx
git commit -m "Let the admin set up live scoring: a purpose for each field set with teamwork and skills sets in separate sections on the Fields page, the two live-score switches when editing a session, a scorer's field binding with Clear on the Devices page, and each skills attempt's field on the Skills page. The schedule's readiness check no longer counts skills fields.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Displays: live totals and skills TVs

**Files:**
- Create: `frontend/apps/device/src/display/useLiveScores.ts`, `frontend/apps/device/src/display/SkillsFieldDisplay.tsx`, `frontend/apps/device/src/display/SkillsSetDisplay.tsx`
- Modify: `frontend/apps/device/src/display/components/InMatchView.tsx`, `frontend/apps/device/src/display/GroupView.tsx`, `frontend/apps/device/src/display/api.ts`, `frontend/apps/device/src/display/useLiveRefresh.ts`
- Modify: `frontend/apps/device/src/styles/display.css`, `frontend/apps/device/src/i18n/en/device.json`, `frontend/apps/device/src/i18n/zh/device.json`
- Modify: `frontend/apps/device/tests/unit/displayFixtures.ts` (`FIELD_SETS` purpose)
- Test: `frontend/apps/device/tests/unit/liveScores.test.tsx`, `frontend/apps/device/tests/unit/skillsDisplays.test.tsx`, `server/tests/test_skills_display_reads.py`

**Interfaces:**
- Consumes: Task 7/10 `GET /api/displays/live-scores?field_set_id=` and `live_score` events; Task 9 `GET /api/field-sets/{id}/skills` (`SkillsSet` from `@tournament-admin/shared`); Task 15's `skillsClockPhase`, `skillsClockSeconds` and the attempts' `field_id`; Task 2's `FieldSetRead.purpose`; Task 3's `run_seconds` on skills types; `skills_run_changed`.
- Produces: `LiveScores`, `LiveMatchScore`, `LiveSkillsScore`, `BreakdownItem`, `applyLiveScore(current, data)`, `useLiveScores(fieldSetId)`; `SkillsFieldDisplay({sessionId, fieldSetId, fieldId})`; `SkillsSetDisplay({sessionId, fieldSetId})`; device `FieldSet.purpose`, `useSkillsSet(fieldSetId)` (key `["skillsSet", id]`), `paths.skillsSet`, `paths.liveScores`; test ids `live-red` / `live-blue` / `live-all`, `skills-clock`, `skills-live`, `skills-total`, `skills-final`, `set-clock`.

Plan note: the In Match screen draws its alliances as chips and a clock, not with `AllianceBands` (that component belongs to Match Intro and Last Scored Match), so the live totals go into `InMatchView`, one coloured total per alliance group under the clock, and `AllianceBands.tsx` is unchanged. `events.ts` is unchanged too: the bus already carries every event, and `useLiveRefresh.ts` gets the new refresh entries instead.

Plan note: spec §6.1 says displays read `GET /api/field-sets/{id}/skills`; the interface block for Task 9 doesn't name its roles. Step 1's server test pins that a display device may read it. If it fails with 403, change that route's dependency in `routers/skills_runs.py` to `Depends(require_any_role)` (reads only; every write keeps its scoring-role guard).

- [ ] **Step 1: Pin the display's reads on the server**

Create `server/tests/test_skills_display_reads.py`:

```python
"""A display device reads a skills field set and the live scores it may show."""
from __future__ import annotations

from device_helpers import paired_device
from skills_helpers import create_event, create_session, enable_skills


def test_a_display_reads_a_skills_set_and_its_live_scores(client):
    t1, _, _ = create_event(client)
    enable_skills(client)
    session_id = create_session(client, checked_in=(t1,))
    assert client.post("/api/event/active-session", json={"session_id": session_id}).status_code < 300
    field_set = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Skills Row", "purpose": "skills"}
    ).json()
    field = client.post(
        "/api/fields", json={"session_id": session_id, "field_set_id": field_set["id"], "name": "Skills 1"}
    ).json()
    display = paired_device(client, role="display_device", name="Skills TV")

    read = client.get(f"/api/field-sets/{field_set['id']}/skills", headers=display["headers"])
    assert read.status_code == 200, read.text
    assert [(row["field_id"], row["name"], row["run"]) for row in read.json()["fields"]] == [
        (field["id"], "Skills 1", None)
    ]

    live = client.get(f"/api/displays/live-scores?field_set_id={field_set['id']}", headers=display["headers"])
    assert live.status_code == 200, live.text
    assert live.json() == {"matches": [], "skills": []}
```

Run: `cd server && .venv/bin/pytest -q tests/test_skills_display_reads.py`
Expected: PASS. (If it fails with 403 on the skills read, apply the plan note above and run it again.)

- [ ] **Step 2: Write the failing live-total tests**

In `frontend/apps/device/tests/unit/displayFixtures.ts`, give the teamwork set its purpose:

```ts
export const FIELD_SETS = [{ id: 10, session_id: 1, name: "Main Fields", division_id: null, purpose: "teamwork" }];
```

Create `frontend/apps/device/tests/unit/liveScores.test.tsx`:

```tsx
import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOPERATIVE, audienceGroup, baseRoutes, fieldGroup, match, me } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";
import { applyLiveScore, type LiveScores } from "../../src/display/useLiveScores";

const NOW = new Date("2026-11-07T16:00:00Z").getTime();
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();
const EMPTY: LiveScores = { matches: [], skills: [] };
const TOTALS = { match_id: 5, alliances: [{ alliance_id: 51, score: 12 }, { alliance_id: 52, score: 7 }] };

let matches: unknown[];
let live: LiveScores;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  matches = [match({ id: 5, label: "Q5", match_number: 5, phase: "driver", phase_deadline: iso(30_000) })];
  live = EMPTY;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function show(group: Record<string, unknown> = audienceGroup({ screen: "in_match" }), extra: Record<string, unknown> = {}) {
  serveDisplay({
    ...baseRoutes(),
    "/api/displays/me": me(group),
    "/api/matches?session_id=1": () => matches,
    "/api/displays/live-scores?field_set_id=10": () => live,
    ...extra,
  });
  return renderDisplay();
}

describe("live totals on In Match", () => {
  it("shows each alliance's live total with a Live tag", async () => {
    live = { matches: [TOTALS], skills: [] };
    show();
    expect(await screen.findByTestId("live-red")).toHaveTextContent("12");
    expect(screen.getByTestId("live-red")).toHaveTextContent("Live");
    expect(screen.getByTestId("live-blue")).toHaveTextContent("7");
  });

  it("follows live_score events and drops the totals when they are cleared", async () => {
    const { emit } = show();
    await screen.findByTestId("clock");
    expect(screen.queryByTestId("live-red")).not.toBeInTheDocument();
    live = { matches: [TOTALS], skills: [] };
    emit("live_score", TOTALS);
    expect(await screen.findByTestId("live-red")).toHaveTextContent("12");
    live = EMPTY;
    emit("live_score", { match_id: 5, cleared: true });
    await waitFor(() => expect(screen.queryByTestId("live-red")).not.toBeInTheDocument());
  });

  it("hides the totals once the match has ended, before any clear arrives", async () => {
    matches = [match({ id: 5, label: "Q5", match_number: 5, phase: "ended" })];
    live = { matches: [TOTALS], skills: [] };
    show();
    expect(await screen.findByText("Match over")).toBeInTheDocument();
    expect(screen.queryByTestId("live-red")).not.toBeInTheDocument();
  });

  it("shows one total for a cooperative game", async () => {
    live = { matches: [{ match_id: 5, alliances: [{ alliance_id: 51, score: 15 }, { alliance_id: 52, score: 15 }] }], skills: [] };
    show(audienceGroup({ screen: "in_match" }), { "/api/event/match-format": COOPERATIVE });
    expect(await screen.findByTestId("live-all")).toHaveTextContent("15");
    expect(screen.queryByTestId("live-red")).not.toBeInTheDocument();
  });

  it("shows the totals on the field display too", async () => {
    live = { matches: [TOTALS], skills: [] };
    show(fieldGroup());
    expect(await screen.findByTestId("live-blue")).toHaveTextContent("7");
  });
});

describe("applyLiveScore", () => {
  it("replaces a match's totals and removes them when cleared", () => {
    const first = applyLiveScore(EMPTY, TOTALS);
    expect(first.matches).toEqual([TOTALS]);
    const updated = applyLiveScore(first, { match_id: 5, alliances: [{ alliance_id: 51, score: 14 }] });
    expect(updated.matches).toEqual([{ match_id: 5, alliances: [{ alliance_id: 51, score: 14 }] }]);
    expect(applyLiveScore(updated, { match_id: 5, cleared: true }).matches).toEqual([]);
  });

  it("keeps a skills field's score and breakdown, and removes them when cleared", () => {
    const running = applyLiveScore(EMPTY, { field_id: 31, score: 9 });
    expect(running.skills).toEqual([{ field_id: 31, score: 9, breakdown: null }]);
    const ended = applyLiveScore(running, { field_id: 31, score: 9, breakdown: [{ label: "Score", value: 9 }] });
    expect(ended.skills).toEqual([{ field_id: 31, score: 9, breakdown: [{ label: "Score", value: 9 }] }]);
    expect(applyLiveScore(ended, { field_id: 31, cleared: true }).skills).toEqual([]);
  });

  it("ignores anything else", () => {
    expect(applyLiveScore(EMPTY, { something: 1 })).toBe(EMPTY);
    expect(applyLiveScore(EMPTY, null)).toBe(EMPTY);
  });
});
```

- [ ] **Step 3: Write the failing skills TV tests**

Create `frontend/apps/device/tests/unit/skillsDisplays.test.tsx`:

```tsx
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIELDS, FIELD_SETS, audienceGroup, baseRoutes, fieldGroup, me } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

const NOW = new Date("2026-11-07T16:00:00Z").getTime();
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

const SKILLS_SET = { id: 20, session_id: 1, name: "Skills Row", division_id: null, purpose: "skills" };
const SKILLS_FIELD = { id: 31, field_set_id: 20, name: "Skills 1" };
const SETTINGS = {
  enabled: true,
  attempts: {},
  types: [
    { key: "autonomous", label: "Autonomous", run_seconds: 60 },
    { key: "driver", label: "Driver", run_seconds: 60 },
  ],
};

function timer(overrides: Record<string, unknown> = {}) {
  return { field_set_id: 20, skills_type: "autonomous", phase: "ready", deadline: null, paused: false, remaining_seconds: null, run_seconds: 60, ...overrides };
}
function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, field_id: 31, field_set_id: 20, team_id: 1, team_number: "101A", team_name: "Rockets",
    skills_type: "autonomous", data: {}, item_meta: {}, version: 1, score: 0, follows_set: true,
    phase: "ready", deadline: null, paused: false, remaining_seconds: null, ...overrides,
  };
}
const fieldRow = (fieldRun: unknown) => ({ field_id: 31, name: "Skills 1", run: fieldRun });

let set: { timer: unknown; fields: unknown[] };
let live: { matches: unknown[]; skills: unknown[] };
let attempts: unknown[];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  set = { timer: timer(), fields: [fieldRow(null)] };
  live = { matches: [], skills: [] };
  attempts = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function show(group: Record<string, unknown>) {
  serveDisplay({
    ...baseRoutes(),
    "/api/displays/me": me(group),
    "/api/field-sets?session_id=1": [...FIELD_SETS, SKILLS_SET],
    "/api/fields?session_id=1": [...FIELDS, SKILLS_FIELD],
    "/api/skills/settings": SETTINGS,
    "/api/field-sets/20/skills": () => set,
    "/api/displays/live-scores?field_set_id=20": () => live,
    "/api/sessions/1/skills/attempts": () => attempts,
  });
  return renderDisplay();
}
const showFieldTv = () => show(fieldGroup({ id: 60, name: "Skills 1", field_set_id: 20, field_id: 31 }));

describe("skills field TV", () => {
  it("waits for the next team while the field has no run", async () => {
    showFieldTv();
    expect(await screen.findByText("Skills · Waiting for the next team")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Skills 1" })).toBeInTheDocument();
  });

  it("shows the team, the type and the full run time once a run is created", async () => {
    set = { timer: timer(), fields: [fieldRow(run())] };
    showFieldTv();
    expect(await screen.findByText("101A")).toBeInTheDocument();
    expect(screen.getByText("Rockets")).toBeInTheDocument();
    expect(screen.getByText("Autonomous")).toBeInTheDocument();
    expect(screen.getByTestId("skills-clock")).toHaveTextContent("1:00");
  });

  it("counts down while running and shows the live total only while the server sends one", async () => {
    set = { timer: timer({ phase: "running", deadline: iso(45_000) }), fields: [fieldRow(run({ phase: "running", deadline: iso(45_000) }))] };
    const { emit } = showFieldTv();
    expect(await screen.findByTestId("skills-clock")).toHaveTextContent("0:45");
    expect(screen.queryByTestId("skills-live")).not.toBeInTheDocument();
    live = { matches: [], skills: [{ field_id: 31, score: 17 }] };
    emit("live_score", { field_id: 31, score: 17 });
    expect(await screen.findByTestId("skills-live")).toHaveTextContent("17");
    expect(screen.getByTestId("skills-live")).toHaveTextContent("Live");
    live = { matches: [], skills: [] };
    emit("live_score", { field_id: 31, cleared: true });
    await waitFor(() => expect(screen.queryByTestId("skills-live")).not.toBeInTheDocument());
  });

  it("shows Run over and fills in the breakdown after the timer", async () => {
    set = { timer: timer({ phase: "ended" }), fields: [fieldRow(run({ phase: "ended" }))] };
    live = { matches: [], skills: [{ field_id: 31, score: 17, breakdown: [{ label: "Score", value: 17 }] }] };
    const { emit } = showFieldTv();
    expect(await screen.findByText("Run over")).toBeInTheDocument();
    const breakdown = screen.getByRole("list", { name: "Score breakdown" });
    expect(within(breakdown).getByText("Score")).toBeInTheDocument();
    expect(within(breakdown).getByText("17")).toBeInTheDocument();
    expect(screen.getByTestId("skills-total")).toHaveTextContent("17");
    live = { matches: [], skills: [{ field_id: 31, score: 21, breakdown: [{ label: "Score", value: 21 }] }] };
    emit("live_score", live.skills[0]);
    expect(await within(breakdown).findByText("21")).toBeInTheDocument();
    expect(screen.getByTestId("skills-total")).toHaveTextContent("21");
  });

  it("shows the final score after Submit, and waiting again after a Discard", async () => {
    set = { timer: timer(), fields: [fieldRow(run())] };
    const { emit } = showFieldTv();
    expect(await screen.findByText("101A")).toBeInTheDocument();

    set = { timer: timer(), fields: [fieldRow(null)] };
    attempts = [{ id: 9, team_id: 1, skills_type: "autonomous", score: 23, recorded_at: iso(0), field_id: 31 }];
    emit("skills_run_changed", { field_set_id: 20, field_id: 31 });
    emit("skills_changed", { session_id: 1 });
    expect(await screen.findByTestId("skills-final")).toHaveTextContent("23");
    expect(screen.getByText("Final score")).toBeInTheDocument();

    set = { timer: timer(), fields: [fieldRow(run({ id: 2, team_id: 2, team_number: "102B", team_name: "Gears" }))] };
    emit("skills_run_changed", { field_set_id: 20, field_id: 31 });
    expect(await screen.findByText("102B")).toBeInTheDocument();

    set = { timer: timer(), fields: [fieldRow(null)] };
    emit("skills_run_changed", { field_set_id: 20, field_id: 31 });
    expect(await screen.findByText("Skills · Waiting for the next team")).toBeInTheDocument();
    expect(screen.queryByTestId("skills-final")).not.toBeInTheDocument();
  });
});

describe("skills set TV", () => {
  it("shows the set's name, type and countdown, and never a score", async () => {
    set = { timer: timer({ phase: "running", deadline: iso(30_000) }), fields: [fieldRow(run({ phase: "running", deadline: iso(30_000) }))] };
    live = { matches: [], skills: [{ field_id: 31, score: 17 }] };
    show(audienceGroup({ id: 61, name: "Skills Row", field_set_id: 20, screen: "in_match" }));
    expect(await screen.findByRole("heading", { name: "Skills Row" })).toBeInTheDocument();
    expect(screen.getByText("Autonomous")).toBeInTheDocument();
    expect(screen.getByTestId("set-clock")).toHaveTextContent("0:30");
    expect(screen.queryByText("17")).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(31_000));
    expect(screen.getByTestId("set-clock")).toHaveTextContent("0:00");
    expect(screen.getByText("Time's up")).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `cd frontend/apps/device && npx vitest run tests/unit/liveScores.test.tsx tests/unit/skillsDisplays.test.tsx`
Expected: FAIL (`useLiveScores` does not exist; skills groups still show the teamwork field display and audience screens).

- [ ] **Step 5: Extend the display API and refresh map**

In `frontend/apps/device/src/display/api.ts`:
- import `type SkillsSet` from `@tournament-admin/shared` with the other shared types;
- `FieldSet` gains `purpose: "teamwork" | "skills";`
- `SkillsSettings.types` becomes `{ key: string; label: string; run_seconds?: number | null }[]`;
- `SkillsAttempt` gains `field_id: number | null;`
- add to `paths`:

```ts
  skillsSet: (fieldSetId: number) => `/api/field-sets/${fieldSetId}/skills`,
  liveScores: (fieldSetId: number) => `/api/displays/live-scores?field_set_id=${fieldSetId}`,
```

- add the hook beside the others:

```ts
export const useSkillsSet = (fieldSetId: number) =>
  useJson<SkillsSet>(["skillsSet", fieldSetId], paths.skillsSet(fieldSetId));
```

In `frontend/apps/device/src/display/useLiveRefresh.ts`, add to `REFRESH`:

```ts
  match_submitted: ["matches", "scores"],
  skills_run_changed: ["skillsSet"],
```

(`live_score` is applied by `useLiveScores` itself, not refetched.)

- [ ] **Step 6: Write `useLiveScores`**

Create `frontend/apps/device/src/display/useLiveScores.ts`:

```ts
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { paths, useFetchJson } from "./api";
import { useLiveEvents } from "./events";

export interface LiveAllianceScore {
  alliance_id: number;
  score: number;
}
export interface LiveMatchScore {
  match_id: number;
  alliances: LiveAllianceScore[];
}
export interface BreakdownItem {
  label: string;
  value: number | string | boolean;
}
export interface LiveSkillsScore {
  field_id: number;
  /** Sent while the run's timer runs and the session allows live scores. */
  score?: number | null;
  /** Sent once the timer has ended, until the run is submitted or discarded. */
  breakdown?: BreakdownItem[] | null;
}
export interface LiveScores {
  matches: LiveMatchScore[];
  skills: LiveSkillsScore[];
}

const EMPTY: LiveScores = { matches: [], skills: [] };

/** Folds one `live_score` event into what the display holds: totals replace a
 * match's or field's entry, `cleared` removes it, anything else is ignored. */
export function applyLiveScore(current: LiveScores, data: unknown): LiveScores {
  if (typeof data !== "object" || data === null) return current;
  const event = data as {
    match_id?: unknown;
    field_id?: unknown;
    cleared?: unknown;
    alliances?: LiveAllianceScore[];
    score?: number | null;
    breakdown?: BreakdownItem[] | null;
  };
  if (typeof event.match_id === "number") {
    const others = current.matches.filter((entry) => entry.match_id !== event.match_id);
    return {
      ...current,
      matches: event.cleared ? others : [...others, { match_id: event.match_id, alliances: event.alliances ?? [] }],
    };
  }
  if (typeof event.field_id === "number") {
    const others = current.skills.filter((entry) => entry.field_id !== event.field_id);
    return {
      ...current,
      skills: event.cleared
        ? others
        : [...others, { field_id: event.field_id, score: event.score ?? null, breakdown: event.breakdown ?? null }],
    };
  }
  return current;
}

/** What the server lets this field set's displays show right now: fetched
 * once (and again on reconnect, like every read), then kept by live_score. */
export function useLiveScores(fieldSetId: number | null): LiveScores {
  const fetchJson = useFetchJson();
  const queryClient = useQueryClient();
  const queryKey = ["liveScores", fieldSetId];
  const query = useQuery({
    queryKey,
    queryFn: () => fetchJson<LiveScores>(paths.liveScores(fieldSetId as number)),
    enabled: fieldSetId !== null,
  });
  useLiveEvents(["live_score"], (event) => {
    if (fieldSetId === null) return;
    queryClient.setQueryData<LiveScores>(queryKey, (current) => applyLiveScore(current ?? EMPTY, event.data));
  });
  return query.data ?? EMPTY;
}
```

- [ ] **Step 7: Live totals on In Match**

Replace `frontend/apps/device/src/display/components/InMatchView.tsx` with:

```tsx
import { useTranslation } from "react-i18next";
import { COUNT_IN_PHASES, formatClock, remainingSeconds, type LiveMatch } from "@tournament-admin/shared";
import { useFields, useMatchFormat, useRanks, useTeamsById } from "../api";
import { allianceGroups, groupScore } from "../logic/alliances";
import { matchTitle } from "../matchTitle";
import { useLiveScores } from "../useLiveScores";
import { PeriodIcon } from "./PeriodIcon";
import { ScreenFrame } from "./ScreenFrame";

function periodOf(phase: string): "autonomous" | "driver" | null {
  if (phase === "countdown_autonomous" || phase === "autonomous") return "autonomous";
  if (phase === "countdown_driver" || phase === "driver") return "driver";
  return null;
}

/** The match clock, shared by the field display and the audience's In Match
 * screen, with each alliance's live total while the server sends one. */
export function InMatchView({ match, sessionId, now }: { match: LiveMatch; sessionId: number; now: number }) {
  const { t } = useTranslation();
  const teams = useTeamsById();
  const ranks = useRanks(sessionId, match.division_id);
  const fields = useFields(sessionId);
  const format = useMatchFormat();
  const fieldSetId = fields.data?.find((field) => field.id === match.field_id)?.field_set_id ?? null;
  const live = useLiveScores(fieldSetId);
  const remaining = remainingSeconds(match, now) ?? 0;
  const period = periodOf(match.phase);
  // The server clears totals when the clock stops; this covers the moment between.
  const clockRunning = match.phase !== "not_started" && match.phase !== "ended";
  const liveEntry = clockRunning ? live.matches.find((entry) => entry.match_id === match.id) : undefined;
  const liveScores = liveEntry ? new Map(liveEntry.alliances.map((row) => [row.alliance_id, row.score])) : null;

  let centre;
  if (match.phase === "ended") {
    centre = (
      <>
        <p className="clock" data-testid="clock">
          0:00
        </p>
        <p className="in-match__over">{t("display.matchOver")}</p>
      </>
    );
  } else if (match.phase === "awaiting_driver") {
    centre = <p className="clock clock--message">{t("display.driverNext")}</p>;
  } else if (COUNT_IN_PHASES.has(match.phase)) {
    centre = (
      <p className="clock clock--count-in" data-testid="count-in">
        {Math.max(1, Math.ceil(remaining - 1e-9))}
      </p>
    );
  } else {
    centre = (
      <p className="clock" data-testid="clock">
        {formatClock(remaining)}
      </p>
    );
  }

  return (
    <ScreenFrame title={matchTitle(t, match)} className="in-match">
      <ul className="in-match__chips">
        {match.alliances.flatMap((alliance) =>
          alliance.team_ids.map((teamId) => (
            <li key={`${alliance.id}-${teamId}`} className={`chip chip--${alliance.station}`} data-testid={`chip-${teamId}`}>
              <span className="chip__rank">{ranks?.get(teamId) ?? "–"}</span>
              <span className="chip__number">{teams?.get(teamId)?.number ?? ""}</span>
            </li>
          ))
        )}
      </ul>
      <div className="in-match__centre">
        {centre}
        {liveScores && format.data && (
          <div className="in-match__live">
            {allianceGroups(match, format.data.game_model).map((group) => (
              <p key={group.station} className={`live-total live-total--${group.station}`} data-testid={`live-${group.station}`}>
                <span className="live-total__score">{groupScore(group, liveScores) ?? 0}</span>
                <span className="live-total__tag">{t("display.live")}</span>
              </p>
            ))}
          </div>
        )}
      </div>
      {match.paused && (
        <p className="in-match__paused" role="status">
          {t("display.paused")}
        </p>
      )}
      {period && match.phase !== "ended" && (
        <p className="in-match__banner">
          <PeriodIcon period={period} />
          {t(`display.period.${period}`)}
        </p>
      )}
    </ScreenFrame>
  );
}
```

- [ ] **Step 8: Write the skills TVs and route skills groups to them**

Create `frontend/apps/device/src/display/SkillsFieldDisplay.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { formatClock, skillsClockPhase, skillsClockSeconds } from "@tournament-admin/shared";
import { useFields, useSkillsAttempts, useSkillsSet, useSkillsSettings, useTeamsById, type SkillsAttempt } from "./api";
import { ScreenFrame, ScreenNotice, WaitingForData } from "./components/ScreenFrame";
import { useServerNow } from "./serverClock";
import { useLiveScores } from "./useLiveScores";

function latestFieldAttempt(attempts: SkillsAttempt[], fieldId: number): SkillsAttempt | null {
  let latest: SkillsAttempt | null = null;
  for (const attempt of attempts) {
    if (attempt.field_id === fieldId && (latest === null || attempt.id > latest.id)) latest = attempt;
  }
  return latest;
}

/** A skills field's own TV: waiting, the loaded team and full run time, the
 * countdown with the live total, then "Run over" with the breakdown the team
 * checks, and the final score until the next run. */
export function SkillsFieldDisplay({
  sessionId,
  fieldSetId,
  fieldId,
}: {
  sessionId: number;
  fieldSetId: number;
  fieldId: number;
}) {
  const { t } = useTranslation();
  const now = useServerNow();
  const set = useSkillsSet(fieldSetId);
  const fields = useFields(sessionId);
  const settings = useSkillsSettings();
  const attempts = useSkillsAttempts(sessionId);
  const teams = useTeamsById();
  const live = useLiveScores(fieldSetId);
  const fieldName = fields.data?.find((field) => field.id === fieldId)?.name ?? "";
  const run = set.data?.fields.find((field) => field.field_id === fieldId)?.run ?? null;
  const latest = latestFieldAttempt(attempts.data ?? [], fieldId);
  // The newest attempt on this field while the last run was showing. An attempt
  // newer than it, once the run is gone, is that run's submitted score; none
  // (a discard, or a TV switched on between runs) means waiting.
  const seenWhileRunning = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (run) seenWhileRunning.current = latest?.id ?? 0;
  }, [run, latest]);

  if (!set.data || !settings.data) return <WaitingForData title={fieldName} />;
  const types = settings.data.types;
  const typeLabel = (key: string) => types.find((type) => type.key === key)?.label ?? key;

  if (!run) {
    const baseline = seenWhileRunning.current;
    const submitted = baseline !== undefined && latest !== null && latest.id > baseline ? latest : null;
    if (!submitted) return <ScreenNotice title={fieldName} text={t("display.skills.waiting")} />;
    const team = teams?.get(submitted.team_id);
    return (
      <ScreenFrame title={fieldName} subtitle={typeLabel(submitted.skills_type)} className="skills-field">
        <p className="skills-field__team">
          <span className="skills-field__number">{team?.number ?? ""}</span>
          <span className="skills-field__name">{team?.name ?? ""}</span>
        </p>
        <p className="skills-field__label">{t("display.skills.finalScore")}</p>
        <p className="skills-field__total" data-testid="skills-final">
          {submitted.score}
        </p>
      </ScreenFrame>
    );
  }

  const phase = skillsClockPhase(run, now);
  const fullSeconds = run.follows_set
    ? set.data.timer.run_seconds
    : types.find((type) => type.key === run.skills_type)?.run_seconds ?? null;
  const entry = live.skills.find((row) => row.field_id === fieldId);
  return (
    <ScreenFrame title={fieldName} subtitle={typeLabel(run.skills_type)} className="skills-field">
      <p className="skills-field__team">
        <span className="skills-field__number">{run.team_number}</span>
        <span className="skills-field__name">{run.team_name}</span>
      </p>
      {phase === "ended" ? (
        <>
          <p className="in-match__over">{t("display.skills.runOver")}</p>
          <ul className="skills-breakdown" aria-label={t("display.breakdown")}>
            {(entry?.breakdown ?? []).map((item) => (
              <li key={item.label}>
                <span>{item.label}</span>
                <span>{String(item.value)}</span>
              </li>
            ))}
          </ul>
          {typeof entry?.score === "number" && (
            <p className="skills-field__total">
              <span className="skills-field__label">{t("display.col.total")}</span>{" "}
              <span data-testid="skills-total">{entry.score}</span>
            </p>
          )}
        </>
      ) : (
        <>
          <p className="clock" data-testid="skills-clock">
            {formatClock(skillsClockSeconds(run, now, fullSeconds))}
          </p>
          {run.paused && (
            <p className="in-match__paused" role="status">
              {t("display.paused")}
            </p>
          )}
          {phase === "running" && typeof entry?.score === "number" && (
            <p className="live-total live-total--all" data-testid="skills-live">
              <span className="live-total__score">{entry.score}</span>
              <span className="live-total__tag">{t("display.live")}</span>
            </p>
          )}
        </>
      )}
    </ScreenFrame>
  );
}
```

Create `frontend/apps/device/src/display/SkillsSetDisplay.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { formatClock, skillsClockPhase, skillsClockSeconds } from "@tournament-admin/shared";
import { useFieldSets, useSkillsSet, useSkillsSettings } from "./api";
import { ScreenFrame, WaitingForData } from "./components/ScreenFrame";
import { useServerNow } from "./serverClock";

/** A skills field set's audience TV: the set's name, its type and its shared
 * countdown, never a score. */
export function SkillsSetDisplay({ sessionId, fieldSetId }: { sessionId: number; fieldSetId: number }) {
  const { t } = useTranslation();
  const now = useServerNow();
  const set = useSkillsSet(fieldSetId);
  const fieldSets = useFieldSets(sessionId);
  const settings = useSkillsSettings();
  const name = fieldSets.data?.find((fieldSet) => fieldSet.id === fieldSetId)?.name ?? "";
  if (!set.data || !settings.data) return <WaitingForData title={name} />;
  const timer = set.data.timer;
  const typeLabel =
    timer.skills_type === null
      ? undefined
      : settings.data.types.find((type) => type.key === timer.skills_type)?.label ?? timer.skills_type;
  const phase = skillsClockPhase(timer, now);
  return (
    <ScreenFrame title={name} subtitle={typeLabel} className="skills-set-tv">
      <div className="in-match__centre">
        <p className="clock" data-testid="set-clock">
          {formatClock(skillsClockSeconds(timer, now, timer.run_seconds))}
        </p>
        {phase === "ended" && <p className="in-match__over">{t("display.skills.timeUp")}</p>}
      </div>
      {phase === "running" && timer.paused && (
        <p className="in-match__paused" role="status">
          {t("display.paused")}
        </p>
      )}
    </ScreenFrame>
  );
}
```

Replace `GroupView` in `frontend/apps/device/src/display/GroupView.tsx` (keep `screenContext`) with:

```tsx
/** Mounts what a display's group shows. */
export function GroupView({ me }: { me: DisplayMe & { session_id: number; group: DisplayMeGroup } }) {
  const { group, session_id: sessionId } = me;
  const fieldSets = useFieldSets(sessionId);
  const timeoutDeadline = group.field_set?.timeout_deadline ?? null;
  const fieldSetId = group.kind === "pit" ? null : group.field_set_id;
  // A skills set's groups show skills screens, so wait to know the set's purpose.
  if (fieldSetId !== null && !fieldSets.data) return <WaitingForData title={group.name} />;
  const skills = fieldSetId !== null && fieldSets.data?.find((fs) => fs.id === fieldSetId)?.purpose === "skills";
  if (group.kind === "field" && group.field_id !== null) {
    return (
      <TimeoutGate deadline={timeoutDeadline}>
        {skills && fieldSetId !== null ? (
          <SkillsFieldDisplay sessionId={sessionId} fieldSetId={fieldSetId} fieldId={group.field_id} />
        ) : (
          <FieldDisplay sessionId={sessionId} fieldId={group.field_id} />
        )}
      </TimeoutGate>
    );
  }
  if (group.kind === "audience" && skills && fieldSetId !== null) {
    return <SkillsSetDisplay sessionId={sessionId} fieldSetId={fieldSetId} />;
  }
  const divisionId =
    group.kind === "pit"
      ? group.division_id
      : fieldSets.data?.find((fs) => fs.id === group.field_set_id)?.division_id ?? null;
  const context = screenContext(sessionId, group, divisionId, group.screen_settings);
  if (group.kind === "pit" && group.rotation?.length) {
    const base = {
      sessionId: context.sessionId,
      fieldSetId: context.fieldSetId,
      divisionId: context.divisionId,
      queuedMatchId: context.queuedMatchId,
    };
    return <RotationRunner key={JSON.stringify(group.rotation)} entries={group.rotation} base={base} />;
  }
  const { Component } = screenModule(group.screen);
  if (group.kind !== "audience") return <Component context={context} />;
  return (
    <>
      <TimeoutGate deadline={timeoutDeadline}>
        <Component context={context} />
      </TimeoutGate>
      {group.play_sounds && (
        <AudienceSounds sessionId={sessionId} fieldSetId={group.field_set_id} timeoutDeadline={timeoutDeadline} />
      )}
    </>
  );
}
```

and add the imports:

```tsx
import { WaitingForData } from "./components/ScreenFrame";
import { SkillsFieldDisplay } from "./SkillsFieldDisplay";
import { SkillsSetDisplay } from "./SkillsSetDisplay";
```

- [ ] **Step 9: Add the styles and strings**

Append to `frontend/apps/device/src/styles/display.css`:

```css
/* Live totals: one coloured block per alliance under the clock, tagged as not yet official. */
.in-match__live { display: flex; justify-content: center; gap: 4vw; margin-top: 2vw; }
.live-total { display: flex; align-items: baseline; gap: 1vw; margin: 0; padding: 0.6vw 2.5vw; border-radius: 1vw; font-variant-numeric: tabular-nums; }
.live-total--red { background: var(--kiosk-red); }
.live-total--blue,
.live-total--all { background: var(--kiosk-blue); }
.live-total__score { font-size: 7vw; font-weight: 900; line-height: 1; }
.live-total__tag { padding: 0.2vw 0.8vw; border-radius: 0.5vw; background: var(--kiosk-band); color: var(--kiosk-ink-on-band); font-size: 1.4vw; font-weight: 800; text-transform: uppercase; }

/* Skills TVs. */
.skills-field .screen__body,
.skills-set-tv .screen__body { align-items: center; justify-content: center; gap: 1.5vw; }
.skills-field__team { margin: 0; text-align: center; }
.skills-field__number { display: block; font-size: 9vw; font-weight: 900; line-height: 1; font-variant-numeric: tabular-nums; }
.skills-field__name { display: block; font-size: 3vw; color: var(--kiosk-muted); }
.skills-field__label { margin: 0; font-size: 3vw; color: var(--kiosk-muted); }
.skills-field__total { margin: 0; font-size: 10vw; font-weight: 900; line-height: 1; font-variant-numeric: tabular-nums; }
.skills-breakdown { margin: 0; padding: 0; list-style: none; min-width: 40vw; font-size: 3vw; }
.skills-breakdown li { display: flex; justify-content: space-between; gap: 4vw; padding: 0.4vw 0; border-bottom: 1px solid var(--kiosk-surface); }
```

Add to the `"display"` object in `en/device.json`:

```json
    "live": "Live",
    "skills": {
      "waiting": "Skills · Waiting for the next team",
      "runOver": "Run over",
      "finalScore": "Final score",
      "timeUp": "Time's up"
    },
```

and in `zh/device.json`:

```json
    "live": "实时",
    "skills": {
      "waiting": "技能赛 · 等待下一支队伍",
      "runOver": "本轮结束",
      "finalScore": "最终得分",
      "timeUp": "时间到"
    },
```

- [ ] **Step 10: Run the tests and type check**

Run: `cd frontend/apps/device && npx vitest run && npx tsc -b`
Expected: all pass (the existing field display, In Match and screen tests unchanged), `tsc` silent.

- [ ] **Step 11: Commit**

```bash
git add frontend/apps/device/src/display/useLiveScores.ts frontend/apps/device/src/display/SkillsFieldDisplay.tsx frontend/apps/device/src/display/SkillsSetDisplay.tsx frontend/apps/device/src/display/components/InMatchView.tsx frontend/apps/device/src/display/GroupView.tsx frontend/apps/device/src/display/api.ts frontend/apps/device/src/display/useLiveRefresh.ts frontend/apps/device/src/styles/display.css frontend/apps/device/src/i18n/en/device.json frontend/apps/device/src/i18n/zh/device.json frontend/apps/device/tests/unit/displayFixtures.ts frontend/apps/device/tests/unit/liveScores.test.tsx frontend/apps/device/tests/unit/skillsDisplays.test.tsx server/tests/test_skills_display_reads.py
git commit -m "Show live scores on displays: each alliance's live total with a Live tag on In Match while the server sends one, gone when the clock ends; a skills field's TV with the waiting team, countdown and live total, Run over with the breakdown after the timer, and the final score until the next run; and a skills set's audience TV with its type and shared countdown.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If Step 1 needed the role change, also `git add server/src/tournament_server/routers/skills_runs.py`.

---

### Task 18: End-to-end tests

**Files:**
- Create: `frontend/apps/admin/tests/e2e/liveScoring.spec.ts`

**Interfaces:**
- Consumes: everything above; `startIsolatedServer` with `devicePort`; `buildSampleCooperativePluginZip`; the scoring page at `/sessions/:sessionId/matches/:matchId/score` (Task 14 with Task 13's `LiveScoringPage`), Skills Control (Task 15), the displays (Task 17).

The shipped sample game is cooperative (one shared draft per match, one `Score` counter named `score`, a 60-second driver-only match, both skills types 60 s), which keeps the test short. Ports: backend 8143, admin Vite 5204, device Vite 5205.

Two admin browser contexts both edit as "Admin", so a change one makes never flashes on the other (the flash names another device). The clash therefore comes from a paired scorer tablet: the test pairs one through the API (open a code, pair it as `scorer` named "Tablet 2", poll for its device token, sign in) and sends its draft changes with that token while both admin pages watch. Both admin pages must then show "Changed by Tablet 2", and one Submit must send both to "Saved". "Time ends" is driven with `POST …/end` rather than waiting 60 s; the server treats both alike.

Labels on the scoring page come from Task 13 (`Score`, `Submit`, `Saved`, `Changed by <device>`, `Offline, changes not saved yet`) and Task 14 (`Correct score`, `Save correction`). If a step fails only on a label, match the label to the UI rather than the UI to the test, unless the UI contradicts the spec.

- [ ] **Step 1: Write the spec**

Create `frontend/apps/admin/tests/e2e/liveScoring.spec.ts`:

```ts
import fs from "node:fs";
import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { buildSampleCooperativePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

const PASSWORD = "live-scoring-e2e-pw";

interface MatchInfo {
  id: number;
  label: string;
  is_finals: boolean;
  alliances: { id: number; station: string; team_ids: number[] }[];
}

test.describe.serial("live scoring", () => {
  test.describe.configure({ timeout: 180_000 });

  let server: IsolatedServer;
  let token = "";
  let tabletToken = "";
  let friday = 0;
  let saturday = 0;
  let mainFields = 0;
  let skillsRow = 0;
  const teams: number[] = [];
  const skillsFields: Record<string, number> = {};
  const matches: Record<string, MatchInfo> = {};
  const screens: Record<string, Page> = {};
  const api = (route: string) => `${server.apiUrl}${route}`;
  const admin = () => ({ Authorization: `Bearer ${token}` });
  const tablet = () => ({ Authorization: `Bearer ${tabletToken}` });

  async function call(
    request: APIRequestContext,
    method: "get" | "post" | "put" | "patch" | "delete",
    route: string,
    data?: unknown,
    headers: Record<string, string> = admin()
  ) {
    const response = await request[method](api(route), { headers, data });
    const text = await response.text();
    expect(response.ok(), `${method.toUpperCase()} ${route}: ${text}`).toBeTruthy();
    return text ? JSON.parse(text) : null;
  }

  async function createMatch(request: APIRequestContext, sessionId: number, number: number, fieldId: number, red: number, blue: number) {
    return (await call(request, "post", "/api/matches", {
      session_id: sessionId,
      round_type: "qualification",
      match_number: number,
      field_id: fieldId,
      scheduled_time: new Date(Date.now() + number * 5 * 60_000).toISOString(),
      alliances: [
        { station: "red", team_ids: [teams[red]] },
        { station: "blue", team_ids: [teams[blue]] },
      ],
    })) as MatchInfo;
  }

  /** A scorer tablet paired through the API; its token sends draft changes as "Tablet 2". */
  async function pairTablet(request: APIRequestContext, name: string): Promise<string> {
    const opened = await (await request.post(api("/api/pairing"))).json();
    await call(request, "post", "/api/devices/pair", { code: opened.code, role: "scorer", name });
    const polled = await (
      await request.get(api(`/api/pairing/${opened.id}`), { headers: { "X-Pairing-Key": opened.poll_key } })
    ).json();
    expect(polled.status).toBe("paired");
    const signedIn = await (await request.post(api("/api/auth/device"), { data: { device_token: polled.device_token } })).json();
    return signedIn.access_token;
  }

  async function pairDisplay(browser: Browser, request: APIRequestContext, name: string): Promise<number> {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await page.goto(`${server.baseUrl}/pair`);
    const code = (await page.getByTestId("pairing-code").textContent())!.replace(" ", "");
    const paired = await call(request, "post", "/api/devices/pair", { code, role: "display_device", name });
    screens[name] = page;
    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
    return paired.id;
  }

  async function adminPage(browser: Browser, path: string): Promise<{ page: Page; context: BrowserContext }> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.baseUrl}${path}`);
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    return { page, context };
  }

  const draftPath = (match: MatchInfo) => `/api/matches/${match.id}/alliances/${match.alliances[0].id}/draft`;

  test.beforeAll(async ({ request, browser }) => {
    server = await startIsolatedServer({ backendPort: 8143, frontendPort: 5204, devicePort: 5205 });
    expect((await request.post(api("/api/event"), { data: { name: "Live League", password: PASSWORD } })).status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json()).access_token;
    const uploaded = await request.post(api("/api/plugins/games"), {
      headers: admin(),
      multipart: {
        file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(await buildSampleCooperativePluginZip()) },
      },
    });
    expect(uploaded.status()).toBe(201);
    await call(request, "post", "/api/event/game-plugin", { name: "sample_cooperative" });
    await call(request, "put", "/api/skills/settings", { enabled: true, attempts: {} });
    for (const [number, name] of [["11A", "Alpha"], ["22B", "Bravo"], ["33C", "Charlie"], ["44D", "Delta"], ["55E", "Echo"], ["66F", "Foxtrot"]]) {
      teams.push((await call(request, "post", "/api/teams", { number, name })).id);
    }

    // An earlier session with one scored match, for the correction test.
    friday = (await call(request, "post", "/api/sessions", { label: "Friday", session_date: "2026-11-06" })).id;
    const fridaySet = (await call(request, "post", "/api/field-sets", { session_id: friday, name: "Friday Fields" })).id;
    const fridayField = (await call(request, "post", "/api/fields", { session_id: friday, field_set_id: fridaySet, name: "Field F" })).id;
    matches.FQ1 = await createMatch(request, friday, 1, fridayField, 0, 1);
    await call(request, "post", `/api/matches/${matches.FQ1.id}/alliances/${matches.FQ1.alliances[0].id}/score`, { data: { score: 30 } });

    saturday = (await call(request, "post", "/api/sessions", { label: "Saturday", session_date: "2026-11-07" })).id;
    await call(request, "post", "/api/event/active-session", { session_id: saturday });
    for (const teamId of teams) {
      await call(request, "post", `/api/sessions/${saturday}/participants`, { team_id: teamId, checked_in: true });
    }
    mainFields = (await call(request, "post", "/api/field-sets", { session_id: saturday, name: "Main Fields" })).id;
    const fieldOne = (await call(request, "post", "/api/fields", { session_id: saturday, field_set_id: mainFields, name: "Field 1" })).id;
    const fieldTwo = (await call(request, "post", "/api/fields", { session_id: saturday, field_set_id: mainFields, name: "Field 2" })).id;
    skillsRow = (await call(request, "post", "/api/field-sets", { session_id: saturday, name: "Skills Row", purpose: "skills" })).id;
    for (const name of ["Skills 1", "Skills 2", "Skills 3"]) {
      skillsFields[name] = (await call(request, "post", "/api/fields", { session_id: saturday, field_set_id: skillsRow, name })).id;
    }
    matches.Q1 = await createMatch(request, saturday, 1, fieldOne, 0, 1);
    matches.Q2 = await createMatch(request, saturday, 2, fieldTwo, 2, 3);
    matches.Q3 = await createMatch(request, saturday, 3, fieldOne, 4, 5);

    tabletToken = await pairTablet(request, "Tablet 2");
    const bigTv = await pairDisplay(browser, request, "Big TV");
    const skillsTv = await pairDisplay(browser, request, "Skills TV");
    const groups = (await call(request, "get", `/api/displays?session_id=${saturday}`)).groups as {
      id: number;
      kind: string;
      field_set_id: number | null;
      field_id: number | null;
    }[];
    const audience = groups.find((group) => group.kind === "audience" && group.field_set_id === mainFields)!;
    const skillsFieldGroup = groups.find((group) => group.kind === "field" && group.field_id === skillsFields["Skills 1"])!;
    await call(request, "put", "/api/displays/assignments", { session_id: saturday, device_id: bigTv, group_id: audience.id });
    await call(request, "put", "/api/displays/assignments", { session_id: saturday, device_id: skillsTv, group_id: skillsFieldGroup.id });
  });

  test.afterAll(() => server?.stop());

  test("the audience sees a live total while the clock runs and loses it when time ends", async ({ request }) => {
    const bigTv = screens["Big TV"];
    await call(request, "post", `/api/matches/${matches.Q1.id}/start`, {});
    await expect(bigTv.getByRole("heading", { name: "Qualification 1" })).toBeVisible({ timeout: 10_000 });
    await call(request, "patch", draftPath(matches.Q1), { changes: { score: 7 } }, tablet());
    const live = bigTv.getByTestId("live-all");
    await expect(live).toContainText("7", { timeout: 10_000 });
    await expect(live).toContainText("Live");

    await call(request, "post", `/api/matches/${matches.Q1.id}/end`, {});
    await expect(bigTv.getByText("Match over")).toBeVisible({ timeout: 10_000 });
    await expect(live).toHaveCount(0);
    expect((await call(request, "get", `/api/displays/live-scores?field_set_id=${mainFields}`)).matches).toEqual([]);
  });

  test("two browsers score one match: a clash flashes on both and one Submit saves both", async ({ browser, request }) => {
    const path = `/sessions/${saturday}/matches/${matches.Q1.id}/score`;
    const first = (await adminPage(browser, path)).page;
    const second = (await adminPage(browser, path)).page;
    const firstScore = first.getByLabel("Score", { exact: true }).first();
    const secondScore = second.getByLabel("Score", { exact: true }).first();
    // The tablet's draft from the last test is already there.
    await expect(firstScore).toHaveValue("7", { timeout: 15_000 });
    await expect(secondScore).toHaveValue("7", { timeout: 15_000 });

    await firstScore.fill("5");
    await expect(secondScore).toHaveValue("5", { timeout: 10_000 });

    // The tablet changes the same item: the later write wins and both pages say who made it.
    await call(request, "patch", draftPath(matches.Q1), { changes: { score: 12 } }, tablet());
    await Promise.all([
      expect(first.getByText("Changed by Tablet 2").first()).toBeVisible({ timeout: 10_000 }),
      expect(second.getByText("Changed by Tablet 2").first()).toBeVisible({ timeout: 10_000 }),
    ]);
    await expect(firstScore).toHaveValue("12");
    await expect(secondScore).toHaveValue("12");

    await first.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(first.getByText("Saved", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(second.getByText("Saved", { exact: true })).toBeVisible({ timeout: 10_000 });
    const scores = (await call(request, "get", `/api/scores?session_id=${saturday}`)) as { match_id: number; score: number }[];
    expect(scores.filter((row) => row.match_id === matches.Q1.id).map((row) => row.score)).toEqual([12, 12]);

    // A late change from the tablet is refused now that the score is official.
    const late = await request.patch(api(draftPath(matches.Q1)), { headers: tablet(), data: { changes: { score: 13 } } });
    expect(late.status()).toBe(409);
  });

  test("a finals match shows no live total until the finals switch is turned on", async ({ request }) => {
    await call(request, "post", `/api/matches/${matches.Q2.id}/alliances/${matches.Q2.alliances[0].id}/score`, { data: { score: 20 } });
    await call(request, "post", `/api/matches/${matches.Q3.id}/alliances/${matches.Q3.alliances[0].id}/score`, { data: { score: 10 } });
    const preview = await call(request, "get", `/api/sessions/${saturday}/qualification/finalize-preview`);
    const drops = Object.fromEntries(
      (preview.rows as { played: number; suggested: number }[]).map((row) => [String(row.played), row.suggested])
    );
    await call(request, "post", `/api/sessions/${saturday}/qualification/finalize`, { drops });
    await call(request, "post", "/api/finals/start", { session_id: saturday, bracket_size: 2, field_set_id: mainFields });
    const all = (await call(request, "get", `/api/matches?session_id=${saturday}`)) as MatchInfo[];
    matches.F1 = all.find((match) => match.is_finals)!;

    const bigTv = screens["Big TV"];
    await call(request, "post", `/api/matches/${matches.F1.id}/start`, {});
    await expect(bigTv.getByRole("heading", { name: `Final ${matches.F1.label}` })).toBeVisible({ timeout: 10_000 });
    await call(request, "patch", draftPath(matches.F1), { changes: { score: 9 } }, tablet());
    expect(await call(request, "get", `/api/displays/live-scores?field_set_id=${mainFields}`)).toEqual({ matches: [], skills: [] });
    await bigTv.waitForTimeout(1_500);
    await expect(bigTv.getByTestId("live-all")).toHaveCount(0);

    await call(request, "patch", `/api/sessions/${saturday}`, { live_scores_finals: true });
    await expect(bigTv.getByTestId("live-all")).toContainText("9", { timeout: 10_000 });
    await call(request, "patch", `/api/sessions/${saturday}`, { live_scores_finals: false });
    await expect(bigTv.getByTestId("live-all")).toHaveCount(0, { timeout: 10_000 });
    await call(request, "post", `/api/matches/${matches.F1.id}/end`, {});
  });

  test("a scoring page that loses the network keeps its change and sends it when the network returns", async ({ browser, request }) => {
    const { page, context } = await adminPage(browser, `/sessions/${saturday}/matches/${matches.F1.id}/score`);
    const score = page.getByLabel("Score", { exact: true }).first();
    await expect(score).toHaveValue("9", { timeout: 15_000 });

    await context.setOffline(true);
    await score.fill("14");
    await expect(page.getByText("Offline, changes not saved yet")).toBeVisible({ timeout: 10_000 });
    expect((await call(request, "get", `/api/matches/${matches.F1.id}/draft`)).alliances[0].data.score).toBe(9);

    await context.setOffline(false);
    await expect(page.getByText("Offline, changes not saved yet")).toHaveCount(0, { timeout: 20_000 });
    await expect
      .poll(async () => (await call(request, "get", `/api/matches/${matches.F1.id}/draft`)).alliances[0].data.score, { timeout: 10_000 })
      .toBe(14);
    await expect(score).toHaveValue("14");
  });

  test("a skills set timer starts two fields at once while a third runs alone, and the field TV shows the breakdown", async ({ browser, request }) => {
    const { page } = await adminPage(browser, "/skills-control");
    const card = page.getByRole("region", { name: "Skills Row" });
    const row = (name: string) => card.getByRole("row", { name });
    for (const [field, team] of [["Skills 1", "11A Alpha"], ["Skills 2", "22B Bravo"], ["Skills 3", "33C Charlie"]]) {
      await row(field).getByRole("button", { name: "Start run" }).click();
      const dialog = page.getByRole("alertdialog", { name: `Start a run on ${field}` });
      await dialog.getByLabel("Team").selectOption({ label: team });
      await dialog.getByRole("button", { name: "Start run" }).click();
      await expect(row(field)).toContainText("Ready");
    }
    const skillsTv = screens["Skills TV"];
    await expect(skillsTv.getByText("11A")).toBeVisible({ timeout: 10_000 });
    await expect(skillsTv.getByTestId("skills-clock")).toHaveText("1:00");

    // Skills 3's team runs on the field's own timer.
    await row("Skills 3").getByRole("group", { name: "Timer for Skills 3" }).getByRole("button", { name: "Start", exact: true }).click();
    await expect(row("Skills 3")).toContainText("Alone ·");
    await expect(row("Skills 3")).toContainText("Running");
    await expect(row("Skills 1")).toContainText("Ready");

    // The set timer starts Skills 1 and Skills 2 together.
    await card.getByRole("group", { name: "Set timer" }).getByRole("button", { name: "Start", exact: true }).click();
    await expect(row("Skills 1")).toContainText("Running");
    await expect(row("Skills 2")).toContainText("Running");
    const read = await call(request, "get", `/api/field-sets/${skillsRow}/skills`);
    const runs = Object.fromEntries(
      (read.fields as { name: string; run: { follows_set: boolean; phase: string; deadline: string | null } | null }[]).map(
        (field) => [field.name, field.run!]
      )
    );
    expect(runs["Skills 1"].follows_set).toBe(true);
    expect(runs["Skills 2"].follows_set).toBe(true);
    expect(runs["Skills 1"].deadline).toBe(runs["Skills 2"].deadline);
    expect(runs["Skills 3"].follows_set).toBe(false);
    expect(runs["Skills 3"].deadline).not.toBe(runs["Skills 1"].deadline);

    await call(request, "patch", `/api/fields/${skillsFields["Skills 1"]}/skills-run/draft`, { changes: { score: 33 } }, tablet());
    await expect(skillsTv.getByTestId("skills-live")).toContainText("33", { timeout: 10_000 });

    // Ending the set timer ends Skills 1 and 2; Skills 3 keeps running alone.
    await card.getByRole("group", { name: "Set timer" }).getByRole("button", { name: "End", exact: true }).click();
    await expect(skillsTv.getByText("Run over")).toBeVisible({ timeout: 10_000 });
    const breakdown = skillsTv.getByRole("list", { name: "Score breakdown" });
    await expect(breakdown).toContainText("Score");
    await expect(breakdown).toContainText("33");
    await expect(skillsTv.getByTestId("skills-total")).toHaveText("33");
    await expect(row("Skills 2")).toContainText("Ended");
    await expect(row("Skills 3")).toContainText("Running");

    await call(request, "post", `/api/fields/${skillsFields["Skills 1"]}/skills-run/submit`, {}, tablet());
    await expect(skillsTv.getByTestId("skills-final")).toHaveText("33", { timeout: 10_000 });
    await expect(row("Skills 1")).toContainText("Submitted");

    await row("Skills 2").getByRole("button", { name: "Discard" }).click();
    await page.getByRole("alertdialog", { name: "Discard the run on Skills 2?" }).getByRole("button", { name: "Discard run" }).click();
    await expect(row("Skills 2")).toContainText("No run");
    const attempts = (await call(request, "get", `/api/sessions/${saturday}/skills/attempts`)) as { team_id: number; field_id: number | null; score: number }[];
    expect(attempts.map((attempt) => [attempt.team_id, attempt.field_id, attempt.score])).toEqual([
      [teams[0], skillsFields["Skills 1"], 33],
    ]);
  });

  test("an admin corrects a score in an earlier session and its rankings follow", async ({ browser, request }) => {
    const { page } = await adminPage(browser, `/sessions/${friday}/matches/${matches.FQ1.id}/score`);
    await expect(page.getByRole("button", { name: "Correct score" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("30").first()).toBeVisible();
    await page.getByRole("button", { name: "Correct score" }).click();
    // A cooperative match may show its sheet once per alliance: correct every copy.
    for (const input of await page.getByLabel("Score", { exact: true }).all()) await input.fill("45");
    await page.getByRole("button", { name: "Save correction" }).click();
    await expect
      .poll(
        async () => ((await call(request, "get", `/api/scores?session_id=${friday}`)) as { score: number }[]).map((row) => row.score),
        { timeout: 10_000 }
      )
      .toEqual([45, 45]);
    const rankings = (await call(request, "get", `/api/rankings?session_id=${friday}`)) as { team_id: number; average_score: number }[];
    expect(rankings.find((row) => row.team_id === teams[0])?.average_score).toBe(45);
  });
});
```

- [ ] **Step 2: Run the new spec**

Run: `cd frontend/apps/admin && npx playwright test tests/e2e/liveScoring.spec.ts`
Expected: all six tests pass. If a step fails only on a label, match the label to the UI rather than the UI to the test, unless the UI contradicts the spec.

- [ ] **Step 3: Run the whole E2E suite**

Run: `cd frontend/apps/admin && npx playwright test`
Expected: all pass (`displays.spec.ts` included: its field sets are teamwork by default, so its screens and Match Control are unchanged).

- [ ] **Step 4: Commit**

```bash
git add frontend/apps/admin/tests/e2e/liveScoring.spec.ts
git commit -m "Test live scoring end to end: the audience's live total while the clock runs and gone when it ends, two admin browsers and a scorer tablet editing one match with the clash flashing on both and one Submit saving both, a finals match hidden until the finals switch is on, a scoring page catching up after losing the network, a skills set timer starting two fields while a third runs alone with the field TV's breakdown and final score, and an admin correcting an earlier session's score.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Documentation

**Files:**
- Modify: `server/CLAUDE.md`, `frontend/CLAUDE.md`, `PRODUCT.md`
- Modify: `docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md` (§1 scope line, §6 paragraph, §10 lines)
- Modify: `docs/superpowers/specs/2026-10-19-live-scoring-design.md` (status line)

Write in each file's existing voice: plain sentences, exact names, routes and status codes, no marketing. Describe what was built; where a task's Plan note changed something (for example `SkillsAttemptRead.field_id`, the display's read of `GET /api/field-sets/{id}/skills`), describe the code as it is.

- [ ] **Step 1: `server/CLAUDE.md`**

In `## Plugin system`, extend the skills paragraph: `skills_types()` entries are `{"key", "label", "run_seconds"}`; `run_seconds` is a positive integer the conformance tool requires; the sample game gives 60 for both types; `services/skills.run_seconds(plugin, type)` returns None for a plugin without it, and starting a timer for such a type is a 409 `"This skills type has no run length."`.

In `## Match & scoring`, replace the sentence "Draft scores that scorers may overwrite belong to the later live-scoring spec." with "Scorers edit drafts instead (see Live scoring); `POST …/score` stays the admin correction path."

Add a `## Live scoring` section after `## Display groups`, covering, in the file's existing style:
- the spec link (`docs/superpowers/specs/2026-10-19-live-scoring-design.md`) and the rule that drafts never count: `score_drafts`, `skills_runs`, `skills_set_timers` and `scorer_bindings` live in `models/scoring_draft.py`, are left out of the audit log (`audit._EXCLUDED_TABLES`), and nothing that treats "a score record exists" as "scored" reads them;
- teamwork drafts (`services/drafts.py`, `routers/drafts.py`): one row per alliance (cooperative games: one shared row on the match's lowest alliance id); `GET /api/matches/{id}/draft` (`MatchDraftRead`, alliances with no draft read as `data: {}`, `version: 0`); `PATCH /api/matches/{id}/alliances/{aid}/draft` (`{changes, teams?}`, `extra=forbid`, each item checked alone by `item_violations`, any bad item a 422 `{violations}` with nothing applied, last write wins per item by server order, `item_meta` records the device name or "Admin" and the time, `version` +1, team flags under `team:<id>:no_show` / `team:<id>:dq`); 409 `SCORE_ALREADY_SUBMITTED_DETAIL` once every alliance has a score, 409 for a not-played match; the score so far is `calculate_score` with team flags applied, 0 when the plugin raises;
- Submit: `POST /api/matches/{id}/submit` (`{force}`) locks the match row and re-checks `is_submitted` in the transaction (so a second Submit is a 409), 409 `"Alliance {id} has no draft score."`, 422 `{violations: [{alliance_id, messages}]}` unless `force`, then writes through `services/score_submission.write_alliance_score` and `after_scores_written`, the same path `POST …/score` uses (mirroring, per-team flags, completion, queued override, finals advancing, rankings), deletes the drafts and broadcasts `match_submitted`; the whole-match reset, marking a match not played and every match deletion path delete drafts (`delete_match_drafts`), a section reset keeps them;
- live scores (`services/live_scores.py`): `sessions.live_scores_qualification` (default true; practice, qualification and skills) and `sessions.live_scores_finals` (default false); a teamwork match is live in `LIVE_PHASES` (`countdown_autonomous`, `autonomous`, `awaiting_driver`, `countdown_driver`, `driver`, paused or not); a skills run's total is sent while its timer runs and the switch is on, and its breakdown after the timer regardless of the switch until submit or discard; `on_draft_changed`, `on_match_phase_changed` (after every phase and reset broadcast, including the auto-advance task), `on_switches_changed`, `on_skills_changed`; `GET /api/displays/live-scores?field_set_id=` (`live_snapshot`, any role) for start-up and reconnect;
- field-set purpose: `field_sets.purpose` is `teamwork` or `skills`; schedule generation, finals, Match Control's reads and the audience In Match switch use teamwork sets only; a match on a skills field is a 409 `"This is a skills field set."`; changing to skills while the set has matches (409 `"This field set has matches."`) or to teamwork while it has runs (409 `"This field set has skills runs."`) is refused; skills endpoints on a teamwork field or set are 409 `"This is not a skills field."` / `"This is not a skills field set."`;
- skills runs and timers (`services/skills_runs.py`, `routers/skills_runs.py`): one `skills_set_timers` row per skills set (`ensure_set_timer`, type defaulting to the game's first type, then the last used), at most one `skills_runs` row per field; the routes in spec §6.1; a run follows the set until its first field-level timer action (`follows_set = false`, copying the set's state first), after which only that field's controls move it and it may have any type; a set Start is refused with no following run (409 `"No run is following this field set."`); a type change is refused while any run exists (409 `"Finish or discard this set's runs first."`); a running timer past its deadline reads as ended; Submit re-checks the attempt limit inside the transaction, validates with `skills_rules.scoresheet_violations`, writes the attempt with `field_id` (now on `SkillsAttemptRead`) and deletes the run; Discard uses no attempt; displays may read `GET /api/field-sets/{id}/skills`;
- scorer bindings (`services/scorer_bindings.py`, `routers/bindings.py`): one per session and device, `GET/PUT/DELETE /api/devices/me/binding` (scorer and referee devices; 422 `"Pick a field in the active session."`), `DELETE /api/devices/{id}/binding` (admin), `DeviceRead.binding: {field_id, field_name} | null`, cleared when the field is deleted;
- role-filtered broadcasts: `register_active_session(app, websocket, role)` records each socket's role, `broadcast_active_session(app, event, data, roles=…)` sends to the listed roles only (`None` = everyone; `"admin"` must be listed to reach admins), and `send_to_devices_and_admins` carries `scorer_binding_changed`;
- the tests: `test_scoring_tables.py`, `test_field_set_purpose.py`, `test_session_live_switches.py`, `test_realtime_roles.py`, `test_score_submission_service.py`, `test_drafts.py`, `test_live_scores.py`, `test_draft_submit.py`, `test_skills_runs.py`, `test_skills_timers.py`, `test_scorer_bindings.py`, `test_skills_attempt_field.py`, `test_skills_display_reads.py`.

In `### Event catalog`, add:
- `score_draft_changed` — one alliance's full draft (`AllianceDraftRead` plus `match_id`: `alliance_id, data, teams, item_meta, version, score`), to admin, scorer and referee sockets only, after every draft change and a whole-match reset (empty drafts, `version: 0`). A client applies it only when `version` is newer than the one it holds.
- `match_submitted` — `{match_id}`, to every socket, after a Submit.
- `live_score` — `{match_id, alliances: [{alliance_id, score}]}`, `{field_id, score?, breakdown?}`, `{match_id, cleared: true}` or `{field_id, cleared: true}`, to display and admin sockets only.
- `skills_run_changed` — `{field_set_id, field_id?}`, to admin, scorer, referee and display sockets, when a run is created, its timer or the set's moves, its draft changes, or it is submitted or discarded.
- `scorer_binding_changed` — `{device_id}`, to admins and that device, on every binding change.

In `## Real-time channels and live match control`, note that the active-session channel now records each socket's role, so these role-filtered events go only to the roles listed.

- [ ] **Step 2: `frontend/CLAUDE.md`**

Add a **Live scoring (shared)** paragraph after the Skills challenges list: `packages/shared/src/scoring/` holds the draft types, `api.ts`, `mergeDraft.ts` (`mergeIncoming`: a newer version wins and still-pending local items stay on top; `changedByOthers` picks the items to flash for 2 s), `useLiveDraft` / `useSkillsRun` (one PATCH in flight, changes queued in order, the "Offline, changes not saved yet" banner while queued and disconnected, flush then refetch on reconnect, "Saved" after any Submit including another device's `match_submitted`, "This match is no longer available" when it disappears), `LiveScoringPage`, `ClockControls` and `SkillsRunPanel`, all taking the caller's `t` like `ScoresheetForm`, built for the admin app now and the scorer app later. `packages/shared/src/display/skillsClock.ts` holds the skills timer rules (`skillsClockPhase`, `skillsClockSeconds`, `skillsClockActions`) both apps use.

In "Routes and role-gated nav":
- extend the **Match Control** paragraph: "Score" on the current match opens the scoring page, "Hide live scores" / "Show live scores" flips the session switch for its round, and "Waiting for score" clears on `match_submitted`;
- add the scoring route `/sessions/:sessionId/matches/:matchId/score` (`MatchScoringRoute`): `LiveScoringPage` for an unsubmitted match; a submitted one is read-only with "Correct score", which posts `POST …/score` per alliance in any session; the Matches tab's "Score" opens it;
- add a **Skills Control** paragraph (`src/routes/SkillsControlRoute.tsx`, `src/skillsControl/`, admin nav "Skills Control", route `/skills-control`): one card per skills field set of the active session with the type (locked while any run exists), the set timer and its Start / Pause-Resume / End / Reset, and a row per field (`aria-label` = the field name) with team, type, "Set timer" or "Alone · m:ss", state (No run, Ready, Running, Paused, Ended, Submitted from the field's newest attempt), Score (`SkillsRunPanel` in a modal), Discard (asks first) and the field's own timer buttons; "Start run" offers checked-in teams not on another skills field with an attempt of that type left, and a type other than the set's starts the run on its own timer; the page refetches a set on `skills_run_changed` (key `["skillsSet", id]`) and attempts on `skills_changed`; with no skills set it links to the Fields page;
- in the Fields tab description: a Purpose select per set and separate "Teamwork field sets" / "Skills field sets" sections, the server's 409 shown on the card; the schedule's readiness check ignores skills sets;
- Sessions: the edit form's two live-score switches (not on the create form; new sessions take the server defaults);
- Devices: a scorer's or referee's binding shows in the Group column as "Scoring · <field>" with Clear, and the list refetches on `scorer_binding_changed`;
- Skills page: an attempt scored on a skills field shows the field's name.

In the **Display mode** paragraph: `useLiveScores(fieldSetId)` reads `GET /api/displays/live-scores` once (and on every reconnect, like every read) and applies `live_score` events; In Match shows each alliance group's total with a "Live" tag under the clock while the server sends one and never once the match has ended; a field group on a skills set runs `SkillsFieldDisplay` (waiting, the loaded team and full run time, countdown with the live total, "Run over" with the breakdown, then "Final score" from the newest attempt on that field, detected against the newest attempt seen while the run showed, so a discard goes back to waiting); an audience group on a skills set always runs `SkillsSetDisplay` (name, type, shared countdown, no scores, no In Match switch); `skills_run_changed` refetches `["skillsSet"]`.

In "Testing", add `liveScoring.spec.ts` (live scoring: two admin browsers and an API-paired scorer tablet on one match, live totals on displays, finals hidden by default, offline catch-up, Skills Control with a skills field TV, an earlier session's correction) on 8143/5204 with the device app on 5205 to the isolated-server list.

- [ ] **Step 3: `PRODUCT.md` and the specs**

In `PRODUCT.md`'s Operating Context, add a **Live scoring** bullet after **Displays**: every change a scorer or admin makes is saved on the server as a draft that never counts until Submit; several tablets can score one match together and see each other's changes, with the item another device changed flashing with its name; one Submit makes it official on every device; displays show a running total marked "Live" during practice and qualification (and finals only when an admin turns that on), never after the clock ends; skills fields run timed runs on a shared field-set timer or a field's own, with a field TV that shows the team, the countdown and, after the timer, the breakdown the team checks; the admin scores and corrects teamwork matches (in any session) and runs skills fields from Skills Control. Add "tablets and the admin can run a match's clock" to the Match Control sentence.

In `docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md`:
- §1: change "Live in-progress score preview during scoring (see §6) — designed here, building it can wait." to "Live in-progress score preview during scoring (see §6) — built as live scoring, see `2026-10-19-live-scoring-design.md`."
- §6: after the deferred-preview paragraph add "*As built (live scoring, 2026-10-19): drafts saved on every change and merged item by item across devices, one Submit per match, and live totals on displays under per-session switches, on for practice and qualification and off for finals by default. See `docs/superpowers/specs/2026-10-19-live-scoring-design.md`.*"
- §10: change "Whether/when to build the deferred live-score-preview feature (§6)." to "~~Whether/when to build the deferred live-score-preview feature (§6).~~ Built as live scoring (`2026-10-19-live-scoring-design.md`)."; in the display-groups "Still for later" sentence, drop "skills field displays, " (built by live scoring); and in "**Already planned here but not built:**" remove ", and several devices editing one live score (the deferred live-score preview, §6)" so the list ends at "inspection (`InspectionRecord`)." with a following sentence "Several devices editing one live score is built (live scoring)."

In `docs/superpowers/specs/2026-10-19-live-scoring-design.md`, change the status line to `**Status:** implemented 2026-10-xx on branch live-scoring.` with the actual date.

- [ ] **Step 4: Check for brand names**

Run `git diff master --stat`, then read the whole diff of this branch (`git diff master`) and confirm that no real-world competition brand or product name appears in any code, comment, test, string or document (the root `CLAUDE.md`'s hard constraint). Reference tools are only ever "a closed-source reference tool".

- [ ] **Step 5: Commit**

```bash
git add server/CLAUDE.md frontend/CLAUDE.md PRODUCT.md docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md docs/superpowers/specs/2026-10-19-live-scoring-design.md
git commit -m "Document live scoring: the server's drafts, Submit, live-score rules and switches, field-set purpose, skills runs and timers, scorer bindings, role-filtered broadcasts and new live events; the shared scoring module, the admin's scoring page, Skills Control and settings surfaces, the displays' live totals and skills TVs, and the new end-to-end test.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

