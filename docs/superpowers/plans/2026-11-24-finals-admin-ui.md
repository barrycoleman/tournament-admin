# Finals Set-up, Alliance Selection and Running — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give organisers a Finals page that goes from final rankings to finals match 1 (exclusions, team count, pairing style, fields, games per round), with partner picking driven from the admin page or any scorer/referee tablet and shown on an audience TV.

**Architecture:** The server's finals engine (`services/finals.py`, `routers/finals.py`) gains exclusions, team-count pairing rules, a field subset and a new invite/accept/decline picking model whose state is derived from rankings + an append-only picking log. The admin app gets a `sessions/:sessionId/finals` page; the device app gets its first scorer/referee shell (picking screen only) and a new `alliance_selection` display screen. Everything stays live through the existing `finals_changed` broadcast.

**Tech Stack:** FastAPI + SQLAlchemy + SQLite (pytest), React + TypeScript + TanStack Query + react-i18next (vitest), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-24-finals-admin-ui-design.md` (read it first; §3 rules are binding). Engine background: `docs/superpowers/specs/2026-08-31-finals-and-elimination-brackets-design.md`. A code map of everything touched is in the controller's scratchpad; the facts each task needs are repeated in its Interfaces block.

## Global Constraints

- Never name any real-world competition brand or product anywhere in the repo, including commit messages, comments, test names and fixture data.
- Every new user-facing string exists in both `en` and `zh` (admin: `frontend/apps/admin/src/i18n/{en,zh}/admin.json`; device: `frontend/apps/device/src/i18n/{en,zh}/device.json`).
- Schema changes are made by editing `server/src/tournament_server/_alembic/versions/000000000001_baseline.py` in place; `server/tests/test_alembic_drift.py` must stay green. New models are imported and listed in `server/src/tournament_server/models/__init__.py`.
- Any new table hanging off a bracket is deleted in `services/deletion.py::delete_finals_bracket`; any table hanging off a session/division is deleted in the session and division delete paths in the same file.
- Tests ship with each task: pytest (real app + temp-file SQLite) for server work, vitest for components/logic, Playwright for UI golden paths (Task 9).
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on branch `finals-admin-ui` in the main checkout (no worktrees). Do not push.
- Server tests: `cd server && .venv/bin/python -m pytest ...`. Frontend unit tests: `cd frontend/apps/<app> && npx vitest run ...` (shared: `frontend/packages/shared`). Type-check: `cd frontend && npm run typecheck --workspaces --if-present`.
- Finals alliances are always exactly two teams. `finals_format` stays fixed by the plugin; the plugin's `alliance_selection` is only the default (no plugin-contract or conformance change).

## Review Focus

1. Two people answer the same invite at once (admin clicks Accept as a tablet taps Decline): exactly one wins, the other gets a 409 and nothing is double-recorded — pinned in Task 3 (`test_second_answer_to_same_invite_is_refused`).
2. A tablet showing a stale invite (already cancelled or answered) sends accept/decline: refused with 409 because the request names the team it thinks is invited — pinned in Task 3 (`test_answer_naming_a_different_team_is_refused`).
3. An exclusion edited while a bracket exists for that session/division: refused 409, so picking state can't shift under the organiser — pinned in Task 1 (`test_exclusions_locked_while_bracket_exists`).
4. Undo after the final accept already started the finals matches: refused 409 ("Start over instead") — pinned in Task 3 (`test_undo_refused_once_finals_are_in_progress`).
5. A checked-in team with no ranking row (never played): not a captain and not invitable; it is simply not on the list — pinned in Task 3 (`test_unranked_team_is_never_captain_or_invitable`).

---

### Task 1: Finals exclusions (server)

**Files:**
- Create: `server/src/tournament_server/models/finals_exclusion.py`, `server/tests/test_finals_exclusions.py`
- Modify: `server/src/tournament_server/models/__init__.py`, `_alembic/versions/000000000001_baseline.py`, `schemas/finals.py`, `routers/finals.py`, `services/deletion.py`

**Interfaces:**
- Produces: model `FinalsExclusion` (`finals_exclusions`: id, session_id FK, division_id FK nullable, team_id FK, reason String(20) ∈ {"disqualified","left_early"}).
- Produces: `services/finals.py::excluded_team_ids(db, session_id: int, division_id: int | None) -> set[int]`.
- Produces endpoints: `GET /api/finals/exclusions?session_id=&division_id=` (require_any_role) → `list[FinalsExclusionRead{id, session_id, division_id, team_id, reason}]`; `POST /api/finals/exclusions` body `FinalsExclusionCreate{session_id, division_id, team_id, reason}` (require_admin, 201; re-posting the same team updates its reason); `DELETE /api/finals/exclusions/{id}` (require_admin, 204). Writes broadcast `finals_changed` with `{"session_id", "bracket_id": None}` via the existing `_finals_changed` helper (allow `bracket_id=None`).
- Consumes: `POST /api/finals/start` (existing) — it must now skip excluded teams when taking ranked teams.

- [ ] **Step 1: Write failing tests** in `test_finals_exclusions.py` (use `cooperative_client` and the `_setup_ranked_teams` / `_rank_teams_directly` helpers — copy or import them from `test_finals.py`):
  - `test_exclude_and_list` — POST `{team_id, reason:"left_early"}` → 201; GET returns it with reason `left_early`.
  - `test_reason_must_be_known` — reason `"bored"` → 422.
  - `test_unexclude` — DELETE → 204; GET returns `[]`.
  - `test_start_skips_excluded_teams` — 6 ranked teams, exclude rank 3, start seed_pairing with `bracket_size: 2` → alliances are (rank1, rank2) and (rank4, rank5).
  - `test_exclusions_locked_while_bracket_exists` — after start, POST and DELETE both → 409.
  - `test_exclusions_survive_start_over` — start, DELETE the bracket, GET still returns the exclusion, and POST works again.
  - `test_exclusion_broadcasts_finals_changed` (use `_session_socket` pattern from `test_finals.py`).
- [ ] **Step 2: Run** `cd server && .venv/bin/python -m pytest tests/test_finals_exclusions.py -v` → FAIL (404s / import errors).
- [ ] **Step 3: Implement** the model, baseline table, schemas, endpoints, `excluded_team_ids`, the start filter, and session/division deletion of exclusions. "Bracket exists" = any `FinalsBracket` for that session + division (any status).
- [ ] **Step 4: Run** the new file plus `tests/test_finals.py tests/test_alembic_drift.py` → PASS.
- [ ] **Step 5: Commit.**

### Task 2: Team count, pairing rules, pairing override and field subset (server)

**Files:**
- Modify: `schemas/finals.py`, `routers/finals.py`, `services/finals.py`, `models/finals_bracket.py`, baseline migration
- Test: `server/tests/test_finals_setup_options.py` (new)

**Interfaces:**
- Produces: `FinalsStartRequest` gains `team_count: int | None`, `alliance_selection: Literal["captain_pick","seed_pairing"] | None`, `field_ids: list[int] | None`. Exactly one of `team_count` / `bracket_size` must be given (422 otherwise); `bracket_size: N` keeps meaning N alliances = `team_count: 2N` so existing callers and tests keep working.
- Produces: `FinalsBracket` columns `alliance_selection String(20)` (the resolved choice; plugin default when omitted) and `field_ids String nullable` (JSON list; null = all fields of the set). `FinalsBracketRead` exposes both (`field_ids: list[int] | None`).
- Produces: `services/finals.py::auto_pairs(team_ids_in_rank_order: list[int], fmt: str) -> list[tuple[int, int]]` returning pairs in seed order (index 0 = seed 1 = best):
  - `single_elimination`: an odd count drops the last team; pairs top-down (1+2, 3+4 …).
  - `score_chase`: pairs bottom-up; an odd count makes the second-lowest team appear twice. 31 teams → seeds 1..16 = (1,2), (3,4) … (27,28), (29,30), (30,31); 30 teams → (1,2) … (29,30).
- Produces: `next_finals_field_id` rotates over `field_ids` (ordered by Field.id) when set.
- Validation (422): `team_count < 2` (or < 4 when it yields fewer than 2 alliances); `alliance_selection == "captain_pick"` with an odd `team_count` (detail text: `"Partner picking needs an even number of teams."`); a `field_ids` entry not in the resolved field set, or an empty list; fewer non-excluded ranked teams than `team_count` (existing "enough ranked teams" check, now after exclusions). For partner picking, the old "checked-in teams ≥ 2 × bracket_size" check becomes "non-excluded ranked teams ≥ team_count".
- Alliances for captain_pick = `team_count // 2`; seed_pairing = `len(auto_pairs(...))`. Store that in `bracket_size`.

- [ ] **Step 1: Write failing tests** (`cooperative_client` for score-chase, `client` + `_setup_ranked_teams_for_example_game` for knockout):
  - `test_auto_pairs_knockout_odd_drops_lowest` — unit: `auto_pairs(list(range(1, 32)), "single_elimination")` has 15 pairs, last `(29, 30)`, 31 absent.
  - `test_auto_pairs_score_chase_odd_second_lowest_twice` — unit: 31 → 16 pairs, `pairs[-1] == (30, 31)`, `pairs[-2] == (29, 30)`, `pairs[0] == (1, 2)`.
  - `test_auto_pairs_score_chase_even` — 30 → 15 pairs, `pairs[-1] == (29, 30)`.
  - `test_start_score_chase_with_odd_team_count_runs_worst_pair_first` — 5 ranked teams, `team_count: 5` → 3 alliances; the first run's teams are ranks 4 and 5; rank 4 appears in two alliances.
  - `test_start_knockout_auto_pairs_odd_count` — 7 teams, `team_count: 7`, `alliance_selection: "seed_pairing"` → 3 alliances, rank 7 in none.
  - `test_alliance_selection_override_and_default` — example-game omitted → bracket `alliance_selection == "captain_pick"`; explicit `"seed_pairing"` → alliances formed immediately, status `in_progress`.
  - `test_captain_pick_rejects_odd_team_count` — 422 with the exact detail above.
  - `test_field_subset_rotation` — set with 3 fields, `field_ids: [f1, f3]` → finals games alternate f1, f3, f1.
  - `test_field_subset_rejects_foreign_field` — a field from another set → 422.
  - `test_bracket_size_and_team_count_are_exclusive` — both given → 422; neither → 422.
- [ ] **Step 2: Run** `.venv/bin/python -m pytest tests/test_finals_setup_options.py -v` → FAIL.
- [ ] **Step 3: Implement.** Use `auto_pairs` for every seed_pairing start (with an even count it equals today's top-down pairs, so existing tests hold).
- [ ] **Step 4: Run** `tests/test_finals_setup_options.py tests/test_finals.py tests/test_finals_exclusions.py tests/test_alembic_drift.py` → PASS.
- [ ] **Step 5: Commit.**

### Task 3: Partner picking with invite / accept / decline / cancel / undo (server)

**Files:**
- Create: `server/src/tournament_server/models/finals_pick.py`, `server/src/tournament_server/services/alliance_selection.py`, `server/tests/test_alliance_selection.py`
- Modify: `models/__init__.py`, `models/finals_bracket.py`, baseline migration, `schemas/finals.py`, `routers/finals.py`, `services/deletion.py`, `server/tests/test_finals.py` (rewrite the three `test_captain_pick_*` tests and `test_start_finals_captain_pick_succeeds_in_a_single_division_event`, `test_pick_and_unavailable_broadcast_finals_changed` onto the new endpoints)

**Interfaces:**
- Produces: model `FinalsPick` (`finals_picks`: id, bracket_id FK, seq Int, kind String(10) ∈ {"accept","decline"}, captain_team_id FK teams, team_id FK teams, bracket_alliance_id FK nullable (set for accept)). `FinalsBracket` gains `pending_captain_team_id`, `pending_team_id` (nullable FK teams) for the one open invite.
- Captain_pick start no longer pre-creates alliances: status `selecting_alliances`, zero alliances.
- Produces `services/alliance_selection.py`:
  - `@dataclass SelectionState: captain_team_id: int | None; invitable_team_ids: list[int]  # rank order; declined_team_ids: list[int]; pending_team_id: int | None; alliances_formed: int; alliances_target: int; last_step: FinalsPick | None`
  - `selection_state(db, bracket) -> SelectionState` — eligible = ranked teams (session + division Ranking rows, rank order) minus exclusions. Captain = first eligible team not on any alliance of this bracket. Invitable = eligible, not on an alliance, not declined in this bracket, not the captain. Captain is None once `alliances_formed == alliances_target`.
  - `invite(db, bracket, team_id)`, `accept(db, bracket, team_id)`, `decline(db, bracket, team_id)`, `cancel(db, bracket)`, `undo(db, bracket)`, `finish_early(db, bracket)`; each raises `SelectionError(status: int, detail: str)`.
  - Accept creates `BracketAlliance(seed = alliances_formed + 1)` with captain + partner and a `FinalsPick(kind="accept")`; when `alliances_formed == alliances_target` the bracket goes `in_progress` and `generate_bracket` / `start_score_chase` run (as `/pick` did), then `broadcast_new_finals_matches`.
  - Undo deletes the last `FinalsPick` (and, for accept, its alliance + team rows), clears any open invite.
  - `finish_early` (admin) sets `bracket_size = alliances_formed` and starts matches; allowed only when no captain or no invitable team remains and `alliances_formed >= 2`.
- Produces endpoints on `/api/finals/{id}/selection/…` (all return the full `FinalsBracketRead` and broadcast `finals_changed`):
  - `POST invite {team_id}`, `POST accept {team_id}`, `POST decline {team_id}`, `POST cancel` — `require_role("scorer", "referee")` (admin passes automatically).
  - `POST undo`, `POST finish` — `require_admin`.
  - Remove `POST /api/finals/{id}/pick` and `FinalsPickRequest`.
- Produces: `FinalsBracketRead.selection: SelectionRead | None` (present while `selecting_alliances`): `{captain_team_id, invitable_team_ids, declined_team_ids, pending_team_id, alliances_formed, alliances_target, last_step: {kind, captain_team_id, team_id} | None}`. `FinalsBracketRead.alliance_selection` from Task 2.
- Errors: 409 when not `selecting_alliances`; 409 `"An invite is already open."` on a second invite; 409 `"No invite is open."` on accept/decline/cancel with none; 409 when the body's `team_id` ≠ `pending_team_id`; 422 when inviting a team that isn't invitable; 409 `"Finals have started — use Start over instead."` on undo when `in_progress`/`complete`; 409 on undo with an empty log.

- [ ] **Step 1: Write failing tests** in `test_alliance_selection.py` (example-game `client`, 8 ranked + checked-in teams, `team_count: 4` → 2 alliances unless noted; ranks R1..R8):
  - `test_captain_is_highest_unallied_team` — fresh bracket: `captain == R1`, invitable = R2..R8 in rank order.
  - `test_accept_forms_alliance_one_and_next_captain_follows` — R1 invites R2, R2 accepts → alliance seed 1 = {R1, R2}; captain now R3.
  - `test_decline_blocks_invites_but_allows_captaincy` — `team_count: 6`; R1 invites R4 → decline; R1 invites R7 → accept; R2 can't invite R4 (422); R2 invites R5 → accept; captain is R3; R3 invites R6 → accept → bracket `in_progress` with alliances {R1,R7}, {R2,R5}, {R3,R6}. (Owner's example with 3 alliances; R4 never captains here, so it's out.)
  - `test_declined_team_becomes_captain_when_reached` — `team_count: 8`, R1 invites R4 → decline; R1+R7, R2+R5, R3+R6 accepted; captain is R4; R4 invites R8 → accept.
  - `test_any_ranked_team_can_be_invited` — `team_count: 4`, R1 invites R8 → accept.
  - `test_cancel_clears_invite_without_record` — invite, cancel → `pending_team_id is None`, no FinalsPick rows, team still invitable.
  - `test_second_invite_refused_while_one_open` — 409.
  - `test_second_answer_to_same_invite_is_refused` — accept then decline (same team) → second 409; one alliance only.
  - `test_answer_naming_a_different_team_is_refused` — R1 invites R2; accept `{team_id: R3}` → 409.
  - `test_undo_reverses_accept_then_decline` — decline R4, accept R7, undo → no alliance, R7 invitable, captain R1; undo → R4 invitable again; undo → 409.
  - `test_undo_refused_once_finals_are_in_progress` — 409 with the exact detail.
  - `test_unranked_team_is_never_captain_or_invitable` — a checked-in team with no Ranking row is in neither list.
  - `test_excluded_team_is_never_captain_or_invitable` — exclude R1 before start → captain R2.
  - `test_finish_early_when_teams_run_out` — 6 ranked teams, `team_count: 6` (3 alliances): R1 invites R2..R6, all decline → `finish` → 409 (0 alliances). Second bracket (Start over): R1+R2 accept, R3+R4 accept, captain R5 invites R6 → decline → no invitable team → `finish` → `in_progress`, `bracket_size == 2`.
  - `test_tablet_can_invite_and_answer_but_not_undo` — `paired_device(client, "scorer", "Tablet")` headers: invite/accept 200; undo 403; `"judge"` device invite → 403.
  - `test_selection_broadcasts_finals_changed`.
  - `test_delete_bracket_removes_picks`.
- [ ] **Step 2: Run** `.venv/bin/python -m pytest tests/test_alliance_selection.py -v` → FAIL.
- [ ] **Step 3: Implement**; rewrite the listed `test_finals.py` captain-pick tests onto invite + accept; keep score-chase alliance creation free of the "already claimed" check (Task 2 needs a team in two alliances).
- [ ] **Step 4: Run** `.venv/bin/python -m pytest tests/test_alliance_selection.py tests/test_finals.py tests/test_finals_setup_options.py tests/test_finals_exclusions.py tests/test_alembic_drift.py tests/test_broadcast_wiring.py -q` → PASS. Then `grep -rn "/pick" frontend/apps/admin/tests/e2e` and note the callers for Task 9.
- [ ] **Step 5: Commit.**

### Task 4: Best-of series take turns (server)

**Files:**
- Modify (only if the test fails): `server/src/tournament_server/services/finals.py` (`advance_single_elimination`, `_maybe_create_matchup_game`)
- Test: `server/tests/test_finals_turn_order.py` (new)

**Interfaces:**
- Consumes: Match Control's next match = lowest `Match.id` among unstarted matches on the set's fields (`frontend/packages/shared/src/display/matchOrder.ts::nextMatchForFieldSet`); finals games have no `scheduled_time`, so **creation order is play order**.
- Rule (spec §4.5): within a round, series alternate — game k of every still-undecided series is played before game k+1 of any; a decided series creates no more games; with one series left it plays back to back.

- [ ] **Step 1: Write the failing test** `test_best_of_series_take_turns_within_a_round`: 4 alliances, `wins_to_advance: [2, 2]`; repeatedly take the lowest-id unscored finals match and score it so the red side wins, recording `(round, position, game)` labels. Expected order: `SF1-G1, SF2-G1, SF1-G2, SF2-G2, F-G1, F-G2`. Add `test_tied_game_adds_a_turn` (tie SF1-G1 → order `SF1-G1, SF2-G1, SF1-G2(replay), SF2-G2, SF1-G3 …` with SF1 needing two wins) and `test_last_open_series_plays_back_to_back` (SF2 decided 2-0 while SF1 is 1-1 → SF1-G3 follows immediately).
- [ ] **Step 2: Run** `.venv/bin/python -m pytest tests/test_finals_turn_order.py -v`. The engine may already satisfy this, because the next game of a series is created after the other series' current game already exists. If it passes, record that in the task report and skip Step 3.
- [ ] **Step 3: If it fails:** create a series' next game only when no other undecided, both-sides-known matchup in the same round has fewer games created; after any game in a round completes, create pending next games in position order.
- [ ] **Step 4: Run** the new file plus `tests/test_finals.py` → PASS.
- [ ] **Step 5: Commit.**

### Task 5: Audience TV "Alliance selection" screen

**Files:**
- Create: `frontend/apps/device/src/display/screens/allianceSelection.tsx`, `frontend/apps/device/tests/unit/allianceSelection.test.tsx`
- Modify: `server/src/tournament_server/services/display_screens.py` (`SCREENS["alliance_selection"] = ScreenSpec(<audience kinds>, _no_settings, scrolls=False)` — use the same kinds constant as `elimination_bracket`), `server/tests/test_display_screens.py`, `frontend/packages/shared/src/display/screens.ts` (`SCREEN_KEYS`), `frontend/apps/device/src/display/screens/registry.ts`, `frontend/apps/device/src/display/api.ts` (extend the `FinalsBracket` type with `alliance_selection`, `selection`), device + admin i18n (`display.screens.alliance_selection` / `displayScreens.alliance_selection` = "Alliance selection" / "联盟选择"), `frontend/apps/device/src/styles/display.css`

**Interfaces:**
- Consumes: `useNewestFinals(sessionId, divisionId)` (`display/api.ts`), `useTeamsById()`, `useRanks(sessionId, divisionId)`; `FinalsBracketRead.selection` from Task 3; live refresh already maps `finals_changed` → `["finals", "matches"]`.
- Produces screen key `alliance_selection` (testids: `alliance-row-<n>`, `available-team-<teamNumber>`, `pending-invite`).
- Layout (spec §4.4, mockup `picking.html` part 3): title "ALLIANCE SELECTION"; amber pending invite top right ("5521B invites 6410A…"); left = alliances 1..target (number, captain, partner; the forming alliance shows the current captain and, while pending, the invitee with "?" in amber); right = AVAILABLE = `invitable_team_ids` plus declined teams, **each with its rank number**, rank order, declined struck through. When no bracket is selecting: `ScreenNotice` "Alliance selection hasn't started" (en/zh). After selection finishes, the full alliance list stays shown with the title. Use `ScreenFrame` and `FitText`/`FitLine` per the TV readability rules.

- [ ] **Step 1: Write failing tests**: renders alliances and pending invite; available list shows `#7 6410A` style rank labels in rank order; declined team has the struck class; notice when no selecting bracket. Server: `test_alliance_selection_screen_is_registered`.
- [ ] **Step 2: Run** `cd frontend/apps/device && npx vitest run tests/unit/allianceSelection.test.tsx` and the server test → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both again plus `npx vitest run` in `frontend/packages/shared` and `frontend/apps/device` → PASS; type-check clean.
- [ ] **Step 5: Commit.**

### Task 6: Scorer/referee tablet shell with the picking screen (device app)

**Files:**
- Create: `frontend/apps/device/src/scorer/ScorerApp.tsx` (providers: QueryClient, TokenContext, event bus — mirror `display/DisplayApp.tsx`), `frontend/apps/device/src/scorer/PickingScreen.tsx`, `frontend/apps/device/src/scorer/useActiveFinals.ts`, `frontend/apps/device/tests/unit/pickingScreen.test.tsx`
- Modify: `frontend/apps/device/src/App.tsx` (home + role `scorer` | `referee` → `<ScorerApp …/>`), `frontend/apps/device/src/deviceApi.ts` (add `postJson<T>(path, body, accessToken): Promise<T>` throwing an error carrying `status` and `detail`), device i18n en/zh, `styles/`

**Interfaces:**
- Consumes: Task 3 endpoints `POST /api/finals/{id}/selection/{invite|accept|decline|cancel}` with `{team_id}`; `GET /api/finals?session_id=<active>` (newest first); the active session id the display app already reads (reuse its hook from `display/api.ts`); `finals_changed` on `/ws/active-session` (already delivered to devices).
- Behaviour: if the active session's newest bracket is `selecting_alliances` → `PickingScreen`; otherwise the existing `HomeScreen`. Switches automatically both ways on `finals_changed`.
  - State (a) no pending invite: "Alliance {n} · Captain", captain number large, "Who do you invite?", grid of invitable teams (rank order, with rank) plus declined teams struck through and disabled; tap → invite.
  - State (b) pending: "{captain} invites", invitee number very large, huge green ACCEPT and red DECLINE side by side (testids `accept-invite`, `decline-invite`), small "Cancel invite" link. Each call sends the pending `team_id`.
  - A 409 shows a short "Someone else just answered — updated." notice and refetches. No undo on tablets.
- Build the shell so the coming scorer app adds routes beside `PickingScreen` instead of replacing it (one `ScorerApp` with a screen switch).

- [ ] **Step 1: Write failing tests** (mock fetch): no bracket → home text; selecting with no invite → captain + team grid, clicking a team POSTs invite `{team_id}`; pending → ACCEPT posts accept with the pending team id; DECLINE posts decline; 409 shows the notice and refetches; a role `judge` device still gets `HomeScreen`.
- [ ] **Step 2: Run** `cd frontend/apps/device && npx vitest run tests/unit/pickingScreen.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the device unit suite and type-check → PASS.
- [ ] **Step 5: Commit.**

### Task 7: Admin Finals page — set-up (rankings, exclusions, settings, start)

**Files:**
- Create: `frontend/apps/admin/src/routes/SessionFinalsRoute.tsx`, `frontend/apps/admin/src/finals/useFinals.ts`, `frontend/apps/admin/src/finals/FinalsSetup.tsx`, `frontend/apps/admin/src/finals/finalsPreview.ts`, `frontend/apps/admin/tests/unit/finalsSetup.test.tsx`, `frontend/apps/admin/tests/unit/finalsPreview.test.ts`
- Modify: `router.tsx` (child `finals` under `sessions/:sessionId`, wrapped in `<RequiresGamePlugin>`), `routes/SessionDetailLayout.tsx` (tab `sessions.finalsTab` = "Finals" / "决赛"), `qualification/QualificationBar.tsx` (after the finalized text, a link "Set up finals" / "设置决赛" to `../finals`), `types.ts` (`FinalsBracket`, `FinalsExclusion`, `FinalsSelection`), admin i18n en/zh

**Interfaces:**
- Consumes: Task 1 exclusion endpoints; Task 2 start body `{session_id, division_id, team_count, alliance_selection, field_ids, wins_to_advance}`; `GET /api/finals?session_id&division_id`; `useRankingGroups` (`rankings/useRankingGroups.ts`) for rank order; `GET /api/event/match-format` (`finals_format`, `alliance_selection` default); field sets/fields (`["fieldSets", sessionId]`, `["fields", sessionId]`); divisions; `SessionRead.qualification_finalized_at`. Live: `useRealtimeChannel` on `/ws/session/{id}` invalidating `["finals", …]`, `["finalsExclusions", …]` on `finals_changed`, and rankings on `ranking_updated`.
- Produces `finalsPreview.ts`:
  - `finalsColumn(rankedTeamIds: number[], excluded: Set<number>, teamCount: number, mode: "picking" | "pairs_knockout" | "score_chase"): Map<number, {kind: "captain" | "invitable" | "alliance" | "out" | "excluded", n?: number, movedUp?: boolean}>` — picking: first `teamCount/2` non-excluded = captain 1..n, rest invitable; pairs modes use the same pairing rules as the server's `auto_pairs` (Task 2) and mark the cut.
  - `roundLabels(alliances: number): string[]` keys for games-per-round rows (Final, Semi-finals, Quarter-finals, Round of 16 … from the end), and `winsToAdvance(choices) -> number[]` (Single match = 1, Best 2 of 3 = 2, Best 3 of 5 = 3). Default all 1 except Final = 2.
- Page (spec §4.1, mockups `finals-setup-v2.html`): not finalized → message + link to Matches. Division switcher when the event has divisions. Left: rankings table (rank, team number + name, record W-L-T if available from rankings, Finals column, Exclude…/Undo with reason select). Right: team count (+ "All teams"), pairing style radio (single_elimination only), field set select (only if >1 teamwork set for the division) + field checkboxes (all ticked), games per round (single_elimination only), start button ("Start alliance selection" / "Create finals matches" / "Create finals runs"). Server 4xx details show via `apiErrorMessage`.

- [ ] **Step 1: Write failing tests**: `finalsPreview.test.ts` — picking marks first 8 non-excluded as captains with rank 3 excluded → captain 8 is rank 9, rank 29 invitable; score-chase 31 → rank 30 in two alliances, nobody "out"; knockout pairs 31 → rank 31 "out"; `roundLabels(8)` = QF, SF, Final; `winsToAdvance` default for 8 alliances = `[1, 1, 2]`. `finalsSetup.test.tsx` — not-finalized message; exclude flow posts `{reason}`; start posts the expected body for picking and for score-chase (`alliance_selection: "seed_pairing"`, no `wins_to_advance`).
- [ ] **Step 2: Run** `cd frontend/apps/admin && npx vitest run tests/unit/finalsPreview.test.ts tests/unit/finalsSetup.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** admin unit suite + type-check → PASS.
- [ ] **Step 5: Commit.**

### Task 8: Admin Finals page — alliance selection and finals in progress

**Files:**
- Create: `frontend/apps/admin/src/finals/AllianceSelectionPanel.tsx`, `frontend/apps/admin/src/finals/FinalsProgress.tsx`, `frontend/apps/admin/tests/unit/allianceSelectionPanel.test.tsx`, `frontend/apps/admin/tests/unit/finalsProgress.test.tsx`
- Modify: `routes/SessionFinalsRoute.tsx` (switch on bracket status: none → `FinalsSetup`; `selecting_alliances` → `AllianceSelectionPanel`; `in_progress` / `complete` → `FinalsProgress`), `finals/useFinals.ts` (mutations), admin i18n en/zh

**Interfaces:**
- Consumes: Task 3 selection endpoints and `selection` block; `DELETE /api/finals/{id}`; `POST /api/finals/{id}/alliances/{aid}/unavailable`; `components/ConfirmDialog.tsx`.
- AllianceSelectionPanel (spec §4.2, mockup `picking.html` part 1): alliances table 1..target (current row highlighted, pending shows "invited, waiting…"); green Accept / red Decline (send pending team id), grey Cancel invite, "↶ Undo last step" with "last: {team} declined {captain}" / "last: {team} joined {captain}" (disabled with no last step); right list = invitable teams in rank order with rank and Invite (disabled while pending) plus declined teams struck through; "Finish with {n} alliances" button shown only when no captain or no invitable team remains and `alliances_formed >= 2`; Start over (confirm).
- FinalsProgress: status line (in progress / complete), alliances with seeds and teams, per-alliance "Can't play" (single_elimination, in_progress only; confirm; explains the whole alliance forfeits), Start over (confirm; hidden when complete), link to Match Control.

- [ ] **Step 1: Write failing tests**: panel renders captain/pending; Invite disabled while pending; Accept posts `{team_id: pending}`; Undo shows last-step text and posts undo; finish button only in the run-out case; progress panel Can't play posts unavailable after confirm; Start over deletes after confirm.
- [ ] **Step 2: Run** the two test files → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** admin unit suite + type-check → PASS.
- [ ] **Step 5: Commit.**

### Task 9: End-to-end tests and existing-spec updates

**Files:**
- Create: `frontend/apps/admin/tests/e2e/finalsSetup.spec.ts`, `frontend/apps/admin/tests/e2e/alliancePicking.spec.ts`
- Modify: e2e callers of the removed `/pick` endpoint (`tvBracket.spec.ts` and any others found in Task 3 Step 4) → invite + accept; `frontend/CLAUDE.md` isolated-port list

**Interfaces:**
- Consumes: `fixtures/isolatedServer.ts::startIsolatedServer({backendPort, frontendPort, devicePort})`, `fixtures/buildPluginZip.ts` (`buildExampleGamePluginZip`, `buildSampleCooperativePluginZip`), the `bracketEvent` set-up pattern in `tvBracket.spec.ts`, `pairTablet` / browser display pairing pattern in `liveScoring.spec.ts`, `fixtures/tvFits.ts::expectFits`. Ports: alliancePicking 8213/5274/5275; finalsSetup 8214/5276/5277 (add both to `frontend/CLAUDE.md`).

- [ ] **Step 1: Write the specs:**
  - `finalsSetup.spec.ts`: head-to-head event, 10 ranked teams, qualification finalized → the Matches page "Set up finals" link opens Finals. Exclude rank 3 (Disqualified); team count 8 → the Finals column shows Captain 1–4 on ranks 1, 2, 4, 5 and every other team "Can be invited". Switch to Automatic pairs → cut line after rank 9, rank 3 excluded. Set Final to Best 2 of 3, untick one field, Create finals matches → progress panel shows 4 alliances, and Match Control's next match is on a ticked field. Score-chase event (sample cooperative), 5 teams, All teams → Create finals runs → the first run is ranks 4 + 5. A session that isn't finalized shows the message and link.
  - `alliancePicking.spec.ts`: head-to-head event, 6 ranked teams, a paired scorer tablet (browser context on the device app) and a paired audience TV showing `alliance_selection`. Admin starts selection with team count 4 (2 alliances). Tablet invites R3 → TV shows the amber pending invite; reload the tablet → it shows ACCEPT/DECLINE again; tablet DECLINE → TV strikes R3 through. Admin invites R4 and clicks Accept → alliance 1 = R1 + R4 on admin, tablet and TV. Admin Undo → alliance 1 gone everywhere; admin re-invites R4 and accepts. Tablet (captain R2) invites R5, ACCEPT → tablet returns to its home page, admin page shows finals in progress, TV keeps both alliances. `expectFits` on the TV at 1280×720 and 1920×1080.
- [ ] **Step 2: Run** `cd frontend/apps/admin && npx playwright test tests/e2e/finalsSetup.spec.ts tests/e2e/alliancePicking.spec.ts` → fix until PASS.
- [ ] **Step 3: Run** the finals-touching existing specs: `npx playwright test tests/e2e/tvBracket.spec.ts tests/e2e/liveScoring.spec.ts tests/e2e/finalizeQualification.spec.ts tests/e2e/zzz_finalizeHeadToHead.spec.ts` → PASS.
- [ ] **Step 4: Run** full server suite, all three unit suites, type-check → PASS.
- [ ] **Step 5: Commit.**
