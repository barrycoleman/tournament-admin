# TV Readability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the device app's kiosk screens so each one reads from across a venue, and add the Schedule by Team and Check-in screens.

**Architecture:** Pure display logic (sides, score groups, driver-change window, schedule rules, check-in summary, text fitting) goes in small tested modules under `frontend/apps/device/src/display/logic/`. Two new frame components replace the tall `ScreenFrame` header: `MatchFrame` (no header, bottom bar) for match screens and a compact heading row for table screens. Each screen module is then rewritten on top of these. The server gains two registry keys and one realtime event, `participation_changed`.

**Tech Stack:** FastAPI + SQLAlchemy (pytest), React 19 + TanStack Query + react-i18next (Vitest + RTL), Playwright (admin app's `tests/e2e`, which already starts an isolated backend, admin Vite and device Vite).

**Spec:** `docs/superpowers/specs/2026-11-14-tv-readability-design.md`. The approved mockups are in `.superpowers/brainstorm/2260565-1794621249/content/` (`in-match-c-v3.html`, `field-next-v2.html`, `audience-screens-v2.html`, `pit-screens.html`, `inspection.html`). Treat them as pictures to match, not code to copy.

## Global Constraints

- Never name a real-world competition brand or product anywhere, including commit messages.
- Every new user-facing string goes in both `frontend/apps/device/src/i18n/{en,zh}/device.json` (and `admin.json` for the admin labels). No bare string literals in JSX.
- Red (`#c8322b`) and blue (`#1f63c6`) are used only for a side or alliance. Text on a coloured badge is full-strength dark ink (`#1b1815`) on amber (`#e3b21a`) or light, and full-strength white on red, green (`#2f9e5a`) and blue. Background `#0e0d0b`, ink `#f6f3ec`, muted `#a59d8c`, panel `#1d1b17`, rule `#2a2723`. Put these as CSS custom properties at the top of `src/styles/display.css`.
- Sizes follow the screen (container-query or viewport units). Team numbers, the clock and the count-in are never clipped or ellipsised; they shrink to fit (`FitText`, Task 4). Long names may be ellipsised.
- Tabular figures (`font-variant-numeric: tabular-nums`) on every number.
- Follow existing device patterns: `ScreenModule`, `ScreenProps`, `useServerNow`, `WaitingForData`, `ScreenNotice`, `ScrollingList`, `useLiveRefresh`.
- Tests: Vitest for logic and components (`cd frontend/apps/device && npm test`), pytest for server (`cd server && .venv/bin/pytest`), Playwright for screens (`cd frontend/apps/admin && npx playwright test <file>`). Update existing tests that this changes without weakening their assertions.
- Commit messages are plain sentences ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on branch `tv-readability` in the main checkout (no worktrees). Don't push.

## Review Focus

1. **A match with three or more teams per side, or seven-character numbers** (e.g. "123456B"): numbers still fit their half without clipping. Covered by the `FitText` Playwright check in Task 14 with seven-character numbers.
2. **Every match already played** on Schedule: the screen still shows rows (the whole list from the top), not an empty table or "no matches". Test in Task 10.
3. **Driver period of exactly 35 s or shorter, and a paused clock inside the window**: no tag for a short period; a match paused at 30 s remaining shows the paused indicator in the line under the clock (paused wins over the tag), never over the digits. Tests in Task 3 and Task 6.
4. **A session with no participants yet, or a team in a division the pit group doesn't show**: Check-in shows its notice for none, and the totals count only the shown teams. Tests in Task 12.
5. **A score-chase run whose finalists have no rank** (ranking not loaded, or a team missing from it): server order is used, and nothing crashes while ranks load. Test in Task 3.

---

## File map

Device app (`frontend/apps/device/`):

- `src/display/logic/sides.ts` (new, replaces `alliances.ts`): `matchSides`, `scoreGroups`, `groupScore`, `resultOutcome`, `teamPlace`.
- `src/display/logic/driverChange.ts` (new): window constants and `inDriverChange`.
- `src/display/logic/fit.ts` (new): `fitScale`.
- `src/display/logic/schedule.ts` (new): `scheduleRows`, `onFieldMatchIds`, `roundProgress`, `nextMatchesForTeam`, `isOnFieldNow`, `shortFieldName`, `compareTeamNumbers`.
- `src/display/logic/checkin.ts` (new): `checkinSummary`.
- `src/display/components/FitText.tsx` (new), `MatchFrame.tsx` (new: `MatchFrame`, `BottomBar`), `TeamBand.tsx` (new, shared side band of numbers), `ScreenFrame.tsx` (compact heading), `StartCountdown.tsx` (label + time), `InMatchView.tsx` (rewritten), `DriverChangeTag.tsx` (new).
- Deleted once unused: `components/AllianceBands.tsx`, `components/ScoreBreakdown.tsx`, `components/MatchSchedulePanel.tsx`, `components/MatchCells.tsx` (if nothing still imports it), `logic/alliances.ts`.
- `src/display/screens/teamSchedule.tsx`, `src/display/screens/checkinStatus.tsx` (new); every other screen in `screens/` plus `FieldDisplay.tsx`, `SkillsFieldDisplay.tsx`, `SkillsSetDisplay.tsx` restyled.
- `src/display/api.ts`: `Participant`, `paths.participants`, `useParticipants`.
- `src/display/useLiveRefresh.ts`: `participation_changed: ["participants"]`.
- `src/styles/display.css`: tokens and the new layouts.
- Tests in `tests/unit/` (existing files updated; new `sides.test.ts`, `schedule.test.ts`, `checkin.test.ts`, `fit.test.ts`).

Shared, server, admin:

- `frontend/packages/shared/src/display/screens.ts`: two new keys.
- `server/src/tournament_server/services/display_screens.py`: two new entries.
- `server/src/tournament_server/routers/participation.py`: broadcast.
- `frontend/apps/admin/src/i18n/{en,zh}/admin.json`: labels.
- `frontend/apps/admin/tests/e2e/tvScreens.spec.ts` (new), `tvScreensCooperative.spec.ts` (new); `displays.spec.ts` updated.
- Docs: `docs/superpowers/specs/2026-10-15-display-groups-design.md` (screen table), `docs/superpowers/specs/2026-09-11-realtime-websockets-design.md` (event list).

---

### Task 1: Register the two new screen keys

**Files:**
- Modify: `server/src/tournament_server/services/display_screens.py` (`SCREENS`)
- Modify: `frontend/packages/shared/src/display/screens.ts` (`SCREEN_KEYS`, `SCROLLING_SCREENS`)
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `zh/admin.json` (the screen-label object holding `"teamwork_rankings": "Teamwork Rankings"`)
- Modify: `frontend/apps/device/src/i18n/en/device.json`, `zh/device.json` (`display.screens`)
- Test: `server/tests/test_display_screens.py`, the shared package's screens test if one exists (`grep -rl SCREEN_KEYS frontend/packages/shared`), admin `PitGroupEditor` tests if they enumerate labels.

**Interfaces:**
- Produces: screen keys `"team_schedule"` and `"checkin_status"`, both audience and pit, no settings, `scrolls=True`, placed after `"schedule"` in button order.

- [ ] **Step 1: Write the failing test.** In `test_the_registry_holds_exactly_the_spec_screens`, add both keys to the full set and to the `scrolls` set. Add:

```python
def test_the_new_screens_take_no_settings_on_either_group():
    for key in ("team_schedule", "checkin_status"):
        assert clean_screen(key, None, "audience") == {}
        assert clean_screen(key, {}, "pit") == {}
        with pytest.raises(ScreenSettingsError, match="no settings"):
            clean_screen(key, {"count": 3}, "pit")
```

- [ ] **Step 2: Run** `cd server && .venv/bin/pytest tests/test_display_screens.py -v`. Expected: FAIL (unknown keys).
- [ ] **Step 3: Implement.** Add `"team_schedule": ScreenSpec(_AUDIENCE_AND_PIT, _no_settings, scrolls=True)` and `"checkin_status"` the same, after `"schedule"`. Mirror in `SCREEN_KEYS` and `SCROLLING_SCREENS`. Labels: admin en "Schedule by Team" / "Check-in Status", zh "按队伍赛程" / "签到状态"; device `display.screens` the same pair.
- [ ] **Step 4: Run** the pytest file, then `cd frontend/apps/admin && npm test` and `cd frontend/apps/device && npm test`. Expected: PASS (fix any test that enumerates every key by adding the two keys).
- [ ] **Step 5: Commit** ("Register the Schedule by Team and Check-in Status display screens.").

### Task 2: Broadcast `participation_changed` when a check-in is set

**Files:**
- Modify: `server/src/tournament_server/routers/participation.py` (`add_participant`)
- Create: `server/tests/test_participation_events.py`
- Modify: `docs/superpowers/specs/2026-09-11-realtime-websockets-design.md` (event list)

**Interfaces:**
- Produces: event `participation_changed` with data `{"session_id": <int>}`, sent through `broadcast_for_session` (the session's own channel, plus the active-session channel when that session is active), after the row is committed, on both the update and insert paths (and the IntegrityError fallback).

- [ ] **Step 1: Write the failing tests** using `next_event` from `skills_helpers` and `paired_device` from `device_helpers` (see `tests/test_device_sockets.py` for the device socket URL):
  - `test_checking_in_a_team_tells_the_active_session_channel`: active session, admin socket on `/ws/active-session`, POST `/api/sessions/{id}/participants` `{"team_id": t, "checked_in": true}`; `next_event(socket, "participation_changed")["data"] == {"session_id": id}`.
  - `test_unchecking_an_existing_participant_also_broadcasts`: second POST with `checked_in: false` on the same team sends the event again.
  - `test_a_display_device_receives_the_event`: a paired `display_device` connected on `/ws/active-session?token=<device token>` receives it.
  - `test_an_inactive_sessions_channel_receives_it`: session not active, socket on `/ws/session/{id}`, event arrives.
  - `test_a_refused_check_in_sends_nothing`: monkeypatch `tournament_server.routers.participation.broadcast_for_session` with a spy; a POST for an unknown team (404) and for an unknown session (404) leave the spy uncalled; a valid POST calls it once.
- [ ] **Step 2: Run** `.venv/bin/pytest tests/test_participation_events.py -v`. Expected: FAIL (timeout/no event).
- [ ] **Step 3: Implement.** Add `request: Request` to `add_participant`; call `broadcast_for_session(request.app, db, session_id, "participation_changed", {"session_id": session_id})` once, after the final commit on every success path.
- [ ] **Step 4: Run** the new file and `tests/test_participation.py`. Expected: PASS. Add the event to the realtime spec's event list with a one-line description and its recipients.
- [ ] **Step 5: Commit** ("Broadcast participation_changed to the session's channels, displays included, whenever a team's check-in is set.").

### Task 3: Side and score logic, and the driver-change window

**Files:**
- Create: `frontend/apps/device/src/display/logic/sides.ts`, `src/display/logic/driverChange.ts`
- Create: `frontend/apps/device/tests/unit/sides.test.ts` (also covers driverChange)
- Modify: every importer of `logic/alliances` (`grep -rn "logic/alliances" src`), then delete `logic/alliances.ts`

**Interfaces:**
- Produces:
  - `type Side = "red" | "blue"`
  - `interface MatchSides { red: number[]; blue: number[] }`
  - `matchSides(match: LiveMatch, ranks?: Map<number, number>): MatchSides`: a `red` alliance's teams go to red, `blue` to blue, for both game models. A `solo` alliance (score-chase run) puts the better-ranked (lower rank) team red and the other blue. If any of its teams has no rank in `ranks` (or `ranks` is undefined), use server order: first red, second blue. A one-team solo alliance gives `{ red: [id], blue: [] }`.
  - `type ScoreSide = Side | "combined"`; `interface ScoreGroup { side: ScoreSide; allianceIds: number[] }`
  - `scoreGroups(match: LiveMatch, gameModel: GameModel): ScoreGroup[]`: head-to-head with red and blue alliances gives `[red, blue]`; cooperative, or any match with a solo alliance, gives one `combined` group with every alliance id.
  - `groupScore(group: ScoreGroup, scores: Map<number, number>): number | null`: unchanged max-of-alliances rule.
  - `resultOutcome(groups: ScoreGroup[], scores: Map<number, number>): Side | "tie" | null`: winner side, `"tie"` when equal, `null` for a single combined group or a missing score.
  - `teamPlace(team?: Team): string` moved here unchanged.
  - In `driverChange.ts`: `export const DRIVER_CHANGE_STARTS_AT = 35; export const DRIVER_CHANGE_ENDS_AT = 25;` and `inDriverChange(phase: string, remaining: number, driverSeconds: number): boolean` — true only when `phase === "driver"`, `driverSeconds > 35`, and `25 < remaining <= 35`. A comment says the in-match cues slice will move these into game-plugin data.

- [ ] **Step 1: Write failing tests** in `sides.test.ts` with the `match()` fixture from `displayFixtures.ts`:
  - head-to-head 2v2: `matchSides` gives the red alliance's ids red and blue's blue, whatever order the alliances arrive in.
  - cooperative two one-team alliances: red team red, blue team blue; `scoreGroups(..., "cooperative_score")` is one `combined` group with both alliance ids.
  - score-chase solo `[7, 3]` with ranks `{7→4, 3→1}`: `{ red: [3], blue: [7] }`; with ranks missing 7: `{ red: [7], blue: [3] }`; with `ranks` undefined: server order; one team: `{ red: [7], blue: [] }`; `scoreGroups` is `combined`.
  - `resultOutcome`: 52–48 → `"blue"`; 30–30 → `"tie"`; combined → `null`; a missing score → `null`.
  - `inDriverChange("driver", 35, 105)` true; `(…, 30, 105)` true; `(…, 25, 105)` false; `(…, 35.5, 105)` false; `(…, 30, 35)` false; `("autonomous", 30, 105)` false.
- [ ] **Step 2: Run** `npx vitest run tests/unit/sides.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** both modules. Move existing callers to `matchSides`/`scoreGroups` (screens get restyled later; here they only need to compile and keep today's tests green, so map `"combined"` to the old `"all"` styling for now where a class name is built).
- [ ] **Step 4: Run** `npm test`. Expected: PASS except the existing tests asserting one "Alliance" band for cooperative (`matchScreens.test.tsx` "uses one Alliance band…", `fieldDisplay.test.tsx` "one bar for a cooperative game"). Change those to assert a red and a blue band each holding one team, which is the new rule, not a weakening.
- [ ] **Step 5: Commit** ("Show cooperative and score-chase teams by side, keep one combined score, and add the driver-change window.").

### Task 4: Fit text to its box

**Files:**
- Create: `src/display/logic/fit.ts`, `src/display/components/FitText.tsx`, `tests/unit/fit.test.ts`

**Interfaces:**
- Produces:
  - `fitScale(contentWidth: number, contentHeight: number, boxWidth: number, boxHeight: number): number` — `min(1, boxWidth / contentWidth, boxHeight / contentHeight)`, `1` when any content size is 0.
  - `<FitText className? testId? children />`: an outer box (`display:block; width:100%; height:100%; overflow:hidden`) and an inner inline-block whose natural size is measured; it sets `transform: scale(s)` (or a reduced font size) from `fitScale`, re-measured with a `ResizeObserver` on both elements and when `children` change. Never ellipsises.

- [ ] **Step 1: Failing tests:** `fitScale(200, 50, 100, 100) === 0.5`, `fitScale(50, 50, 100, 100) === 1`, `fitScale(100, 200, 100, 100) === 0.5`, `fitScale(0, 0, 100, 100) === 1`. A render test that `FitText` renders its children unchanged (jsdom has no layout; the Playwright checks in Tasks 6–8 and 14 prove the fit).
- [ ] **Step 2: Run** and see FAIL. **Step 3: Implement.** **Step 4: Run**, PASS.
- [ ] **Step 5: Commit** ("Add FitText, which shrinks team numbers and clocks to fit their box instead of clipping them.").

### Task 5: Frames, tokens and the start badge

**Files:**
- Create: `src/display/components/MatchFrame.tsx`, `src/display/components/TeamBand.tsx`
- Modify: `src/display/components/ScreenFrame.tsx`, `src/display/components/StartCountdown.tsx`, `src/styles/display.css`, `device.json` (en, zh)
- Test: `tests/unit/screenNotice.test.tsx`, `tests/unit/fieldDisplay.test.tsx` (start badge cases)

**Interfaces:**
- Produces:
  - `<MatchFrame className? bottom={ReactNode}>{children}</MatchFrame>`: full-screen flex column, no header, body fills, `bottom` rendered in the bottom bar.
  - `<BottomBar title={string} field?={string} prefix?={string} end?={ReactNode} />`: uppercase "PREFIX · TITLE" with " · Field 1" muted, and `end` on the right. Test id `bottom-bar`.
  - `ScreenFrame` keeps its props (`title`, `subtitle`, `className`, `children`) but renders a compact heading row: title left (uppercase, heavy), `subtitle` muted right, then the event name small and muted beside it. Add an optional `context?: string` prop shown muted on the right in place of `subtitle` when given. `ScreenNotice` and `WaitingForData` keep working through it.
  - `<TeamBand side: Side; teamIds: number[]; teams: Map<number, Team>; orientation: "row" | "fill" />`: a side-coloured block with each number in its own `FitText`, evenly spaced, thin light divider between numbers. Test ids `band-red`/`band-blue`, each number `band-number-<teamId>`.
  - `StartCountdown` renders `<span class="start__label">` + `<span class="start__time">`, keeps `data-testid="start"` and `data-band`. Keys: `display.startsInLabel` "Starts in", `display.lateLabel` "Late by" (zh to match), replacing `startsIn`/`late`. "Up next" with no scheduled time unchanged. Badge colours per Global Constraints (amber band uses dark ink).
- [ ] **Step 1: Update tests first:** the start-badge test asserts label "Starts in" and time "1:45" in their spans, "Late by" once late, `data-band` unchanged; `ScreenNotice` test asserts the title and text still render, and the event name appears.
- [ ] **Step 2: Run**, FAIL. **Step 3: Implement**, adding the colour tokens and the frame, band, bottom-bar and badge CSS. **Step 4: Run** `npm test`, PASS.
- [ ] **Step 5: Commit** ("Add the match frame, bottom bar and side band, shrink the screen heading to one row, and split the start badge into label and time.").

### Task 6: In-match screen

**Files:**
- Modify: `src/display/components/InMatchView.tsx`, `src/display/components/PeriodIcon.tsx` (add a swap-arrows `DriverChangeTag` or a new `DriverChangeTag.tsx`), `display.css`, `device.json` (en, zh)
- Test: `tests/unit/fieldDisplay.test.tsx`, `tests/unit/liveScores.test.tsx`
- Create: `frontend/apps/admin/tests/e2e/tvScreens.spec.ts` (setup + in-match tests; later tasks add tests to it)

**Interfaces:**
- Consumes: `matchSides`, `scoreGroups`, `groupScore` (Task 3), `inDriverChange` (Task 3), `FitText` (Task 4), `MatchFrame`, `BottomBar`, `TeamBand` (Task 5).
- Produces: test ids `clock`, `count-in` (overlay root), `period`, `driver-change`, `paused`, `live-red`, `live-blue`, `live-combined`, `band-red`, `band-blue`, `bottom-bar`.

Layout from top: team band row (red half left, blue right, no ranks), clock in `FitText` filling the middle, then one line below it: the paused indicator when paused, else `DriverChangeTag` when `inDriverChange(match.phase, remaining, format.driver_seconds)`, else the muted period name. Bottom bar: red live total left, `matchTitle` + field middle, blue live total right (cooperative: one combined total). Totals keep the "LIVE" tag and show only while the clock runs. Count-in phases render a full-screen black overlay over everything with the number in `FitText`. `awaiting_driver`: clock area shows "Driver control next". `ended`: "0:00" and "Match over". Remove the rank chips and `useRanks` (keep `useRanks` only if needed for score-chase sides — it is: pass ranks to `matchSides`). New string: `display.driverChange` "Driver change" (zh "换手").

- [ ] **Step 1: Update unit tests first:**
  - "shows the period clock…": no `chip-*`; `band-red` contains the red numbers, `band-blue` the blue; `period` shows "Driver control"; after `match_paused`, `paused` is shown and `period` is gone.
  - New: driver phase with `phase_deadline` 30 s ahead and `driver_seconds` 105 shows `driver-change` ("Driver change") and no `period`; 40 s ahead shows `period`; cooperative fixture with `driver_seconds` 60 at 30 s shows the tag; a format with `driver_seconds` 30 never shows it.
  - Paused at 30 s remaining in the driver period: `paused` shown, neither `driver-change` nor `period`.
  - Count-in: `count-in` contains "3" and no `band-red` is visible above it (the overlay covers; assert the overlay has the class making it fixed full-screen).
  - "audience In Match … rank chips" becomes "… with team bands" asserting numbers and no rank text.
  - `liveScores.test.tsx`: `live-red`/`live-blue` (head-to-head) and `live-combined` (cooperative) replace `live-all`.
- [ ] **Step 2: Run**, FAIL. **Step 3: Implement** the view and CSS.
- [ ] **Step 4: Run** `npm test`, PASS.
- [ ] **Step 5: Write the Playwright spec** `tvScreens.spec.ts`, modelled on `displays.spec.ts` (`startIsolatedServer({ backendPort: 8173, frontendPort: 5234, devicePort: 5235 })`, `test.describe.serial`, the `call`/`pairDisplay` helpers). Setup: example game plugin (`buildExampleGamePluginZip`), six teams with six-character numbers `83897A 10480B 19533Z 94927X 55210C 31415P` (the first with a 40-character name), one session, a field set "Main Fields" with "Field 1" and "Field 2", qualification matches Q1–Q4 two-per-side with scheduled times, an audience group on the field set (assign the paired display), a field group for Field 1. Pair displays at 1920×1080 and one at 1280×720. A helper `expectFits(page, testIds)` asserts for each element `scrollWidth <= clientWidth + 1` and `scrollHeight <= clientHeight + 1`, that its bounding box lies within the viewport, and that the boxes of `band-red`, `clock`, `bottom-bar` don't intersect. Tests:
  - start Q1 from Match Control's API (as `displays.spec.ts` does); the field TV shows `count-in` filling the viewport (its box equals the viewport), then `clock`; `expectFits` passes on both viewports.
  - driver-change tag: with `page.clock` (install before navigation, then `fastForward`) move the display into the driver period at 30 s remaining and see `driver-change`; fast-forward past 25 s and see `period` again. If the match's period timing makes this impractical, instead pause through the API at a moment inside the window, and say so in the test's comment.
- [ ] **Step 6: Run** `cd frontend/apps/admin && npx playwright test tests/e2e/tvScreens.spec.ts`. Expected: PASS.
- [ ] **Step 7: Commit** ("Redesign the in-match screen around a large clock with side bands, a bottom score bar, a full-screen count-in and a driver-change tag.").

### Task 7: Field TV before the match

**Files:**
- Modify: `src/display/FieldDisplay.tsx`, `display.css`
- Test: `tests/unit/fieldDisplay.test.tsx`, `tvScreens.spec.ts`

**Interfaces:**
- Consumes: `matchSides`, `TeamBand` (`orientation="fill"`), `MatchFrame`, `BottomBar`, `StartCountdown`.

Red fills the top half, blue the bottom half, numbers as large as `FitText` allows. Bottom bar: match title and field on the left, start badge on the right. `ScreenNotice`/`WaitingForData` paths unchanged.

- [ ] **Step 1: Update tests:** `bar-red`/`bar-blue` become `band-red`/`band-blue`; the bottom bar holds "Qualification 1" and "Field 1"; cooperative shows a red band with the first team and a blue band with the second.
- [ ] **Step 2: Run**, FAIL. **Step 3: Implement.** **Step 4: Run**, PASS.
- [ ] **Step 5: Playwright:** before Q2 starts, the Field 1 TV (at both viewports) passes `expectFits` on `band-red`, `band-blue`, `bottom-bar`; the band boxes split the area above the bar in half (heights within 2 px).
- [ ] **Step 6: Run**, PASS. **Step 7: Commit** ("Fill the field TV with each side's team numbers before the match, with the match and countdown in a bottom bar.").

### Task 8: Match intro and last result

**Files:**
- Modify: `src/display/screens/matchIntro.tsx`, `src/display/screens/lastScoredMatch.tsx`, `display.css`, `device.json`
- Delete: `src/display/components/AllianceBands.tsx`, `src/display/components/ScoreBreakdown.tsx` (and `useScoresheetSchema` usage in this screen; keep the hook if anything else uses it)
- Modify: `docs/superpowers/specs/2026-10-15-display-groups-design.md` (the `last_scored_match` row: drop the breakdown, describe the scoreboard)
- Test: `tests/unit/matchScreens.test.tsx`, `tvScreens.spec.ts`

**Interfaces:**
- Consumes: `matchSides(match, ranks)`, `scoreGroups`, `groupScore`, `resultOutcome`, `teamPlace`, `MatchFrame`, `BottomBar`, `FitText`.
- Produces test ids: intro `intro-red`/`intro-blue`, rows `intro-team-<id>` containing `rank-<id>`; result `result-red`/`result-blue`, `score-red`/`score-blue`/`score-combined`, `winner`.

Intro: red half on top, blue below; one row per team: muted "#3", number (fixed column wide enough for six characters, `FitText`), name (ellipsis), place small under the name. Bottom bar prefix "Up next" (`display.upNextPrefix`), title, field, start badge. Result head-to-head: left red / right blue, huge score, team numbers under it, `winner` tag ("Winner", `display.winner`) on the winning side, losing side gets class `is-loser` (dimmed); tie: neither. Cooperative or solo: red and blue team blocks with their numbers and one `score-combined`, no tag, nothing dimmed. Bottom bar prefix "Result" (`display.resultPrefix`).

- [ ] **Step 1: Update tests:** intro shows `#` ranks, names and places per side; cooperative shows one team in each side; result shows `score-red` 48 / `score-blue` 52, `winner` inside `result-blue`, `result-red` has `is-loser`; a 30–30 tie has no `winner` and no `is-loser`; cooperative shows `score-combined` and no `winner`; the breakdown labels are gone (assert `queryByText` of a scoresheet field label is null).
- [ ] **Step 2: Run**, FAIL. **Step 3: Implement**, delete the unused components, update the display-groups spec row. **Step 4: Run**, PASS.
- [ ] **Step 5: Playwright:** an audience display whose group shows `match_intro` (set the group's screen through the API) passes `expectFits` with the long-named team, and its number is shown in full (`textContent` equals "83897A"); after scoring Q1 52–48 and switching to `last_scored_match`, `winner` is on the right side.
- [ ] **Step 6: Run**, PASS. **Step 7: Commit** ("Redesign Match Intro as one row per team by side and Last Scored Match as a two-score scoreboard without the breakdown.").

### Task 9: Teamwork and skills rankings

**Files:**
- Modify: `src/display/screens/teamworkRankings.tsx`, `src/display/screens/skillsRankings.tsx`, `display.css`, `device.json`
- Delete: `src/display/components/MatchSchedulePanel.tsx`; the `top10`, `recentScores`, `schedulePanel` strings if unused
- Test: `tests/unit/listScreens.test.tsx`, `tests/unit/skillsAndBracket.test.tsx`

**Interfaces:**
- Produces: CSS class `table-screen--pit` when `context.fieldSetId === null`, else `table-screen--audience`; test id `rank-row-<teamId>`; top-three rank cells get class `is-top`.

Teamwork: compact heading "Rankings" with context `display.context.rankingsProgress` "After {{played}} of {{total}} qualification matches" (completed vs all qualification matches kept by the division filter). Columns: rank, number (bold), name, then head-to-head W-L-T (muted), WP, SOS, or cooperative matches, average. Skills: rank, number, name, total (bold), then per type `best` and muted `used/allowed` where allowed is `settings.attempts[type.key]`; a type with no attempt shows "–" and "0/3". Remove the side panels. Pit size shows ten or more rows, audience about eight (row height from the class).

- [ ] **Step 1: Update tests:** "lists the head-to-head columns and the schedule and results panel" becomes "…columns, with no side panel" asserting the columns, the W-L-T text, `is-top` on ranks 1–3 only, and that "Match schedule & results" is absent; the context line reads "After 1 of 2 qualification matches" for the fixture; a pit context renders `table-screen--pit`. Skills: a team with best 120 using 2 of 3 attempts shows "120" and "2/3"; a team with no attempt in a type shows "–" and "0/3"; the "Top 10" and "Recent scores" panels are absent.
- [ ] **Step 2: Run**, FAIL. **Step 3: Implement.** **Step 4: Run**, PASS.
- [ ] **Step 5: Commit** ("Make the rankings screens one full-width table, sized for audience or pit, with the side panels removed.").

### Task 10: Match schedule

**Files:**
- Create: `src/display/logic/schedule.ts`, `tests/unit/schedule.test.ts`
- Modify: `src/display/screens/schedule.tsx`, `display.css`, `device.json`
- Test: `tests/unit/listScreens.test.tsx`

**Interfaces:**
- Produces (in `schedule.ts`):
  - `scheduleRows(matches: LiveMatch[], lead = 2): LiveMatch[]`: drop `status === "not_played"`, sort with `sortMatches`, start `lead` played (`isFinished`) matches before the earliest unplayed one; when every match is played, return the whole list.
  - `onFieldMatchIds(matches: LiveMatch[], fieldIds: number[]): Set<number>`: `currentMatchForField` per field.
  - `isOnFieldNow(match: LiveMatch): boolean`: running (`isRunning`) or `phase === "ended" && !isFinished(match)`.
  - `roundProgress(matches: LiveMatch[]): { round: "practice" | "qualification" | "elimination"; played: number; total: number } | null`: the round of the earliest unplayed match (finals count as `"elimination"`), and played/total in that round; null when nothing is unplayed.
  - `shortFieldName(fields: Field[], fieldId: number | null): string`: the field's name when 4 characters or fewer, else `"F"` + its 1-based position in `fields` sorted by id; `""` for null.
  - `compareTeamNumbers(a: string, b: string): number`: `a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })`.
  - `nextMatchesForTeam(matches: LiveMatch[], teamId: number, count = 3): LiveMatch[]`: sorted, not finished, not `not_played`, containing the team.
- Strings: `display.context.practice` "Practice · {{played}} of {{total}} played", `qualification` "Qualification · {{played}} of {{total}} played", `elimination` "Eliminations"; `display.onField` "On field"; zh for each.

Screen: compact heading "Match schedule" + context; columns match, time ("–" when none), field, red teams (right-aligned, red text), blue teams (blue text), by `matchSides`. Played rows get `is-done` (greyed); the on-field match per field gets `is-on-field` and an amber "ON FIELD" tag (`data-testid="on-field"`).

- [ ] **Step 1: Failing logic tests:** with Q1–Q5 where Q1–Q3 completed: `scheduleRows` starts at Q2; all completed: starts at Q1; a `not_played` match is dropped. `onFieldMatchIds` returns the running Q4 for Field 1 and the next unplayed for Field 2. `roundProgress` gives `{ round: "qualification", played: 3, total: 5 }`; practice all done and qualification untouched gives qualification 0 of N; a finals match next gives `"elimination"`. `shortFieldName`: "F2" for "Field 2" in position 2, "A" for "A". `compareTeamNumbers("9A", "10A") < 0`. `nextMatchesForTeam` returns at most three, in order, skipping finished ones.
- [ ] **Step 2: Run**, FAIL. **Step 3: Implement** the module.
- [ ] **Step 4: Update and add screen tests** in `listScreens.test.tsx`: "Schedule lists every match in order with field and time" becomes the windowed list with red/blue columns; one `on-field` tag per field; played rows `is-done`; a finals row with no time shows "–"; times in the session zone/UTC tests stay as they are.
- [ ] **Step 5: Implement the screen. Run** `npm test`, PASS.
- [ ] **Step 6: Commit** ("Redesign the match schedule with red and blue columns, greyed played matches and an On field tag, starting just before now.").

### Task 11: Schedule by team

**Files:**
- Create: `src/display/screens/teamSchedule.tsx`
- Modify: `src/display/screens/registry.ts`, `display.css`, `device.json`
- Test: `tests/unit/listScreens.test.tsx`

**Interfaces:**
- Consumes: `nextMatchesForTeam`, `isOnFieldNow`, `shortFieldName`, `compareTeamNumbers`, `matchSides` (for the side dot), `useDivisionFilter` on teams' `division_id`.
- Produces: `teamScheduleScreen: ScreenModule = { key: "team_schedule", scrolls: true, ... }`; test ids `team-row-<teamId>`, cells `next-<teamId>-<0|1|2>`.

Heading "Schedule by team" with context `display.context.teamSchedule` "Next matches · teams in number order". One row per team kept by the division filter, sorted by `compareTeamNumbers`. Each cell: a red or blue dot (by the team's side in that match), then "Q13 · F2 · 10:32" — the match's `label`, `shortFieldName`, and the time from `formatTime` in the session zone; "now" (`display.now`) in place of the time when `isOnFieldNow`; the time part left off when the match has no scheduled time. Empty cells show "–". A team with none left shows a single muted cell spanning the three, "No more matches" (`display.noMoreForTeam`). Wrapped in `ScrollingList`.

- [ ] **Step 1: Failing tests:** teams render in number order "9A", "10A", "83897A"; a team in three upcoming matches shows three cells with the right labels and a `side-dot--blue` where it's blue; a team whose match is running shows "now"; a team with one left shows "–" in the other two; a team with none shows "No more matches"; a pit group with a division shows only that division's teams; the registry returns this module for `"team_schedule"`.
- [ ] **Step 2: Run**, FAIL. **Step 3: Implement** and register. **Step 4: Run**, PASS.
- [ ] **Step 5: Commit** ("Add the Schedule by Team screen: each team's next three matches with field, time and side.").

### Task 12: Check-in status

**Files:**
- Create: `src/display/logic/checkin.ts`, `tests/unit/checkin.test.ts`, `src/display/screens/checkinStatus.tsx`
- Modify: `src/display/api.ts`, `src/display/useLiveRefresh.ts`, `src/display/screens/registry.ts`, `display.css`, `device.json`
- Test: `tests/unit/listScreens.test.tsx` (or a new `checkinScreen.test.tsx`)

**Interfaces:**
- Consumes: event `participation_changed` (Task 2), `compareTeamNumbers` (Task 10).
- Produces:
  - `interface Participant { id: number; session_id: number; team_id: number; checked_in: boolean }`; `paths.participants(sessionId)` = `/api/sessions/${sessionId}/participants`; `useParticipants(sessionId)` with query key `["participants", sessionId]`.
  - `REFRESH.participation_changed = ["participants"]`.
  - `checkinSummary(participants: Participant[], teams: Map<number, Team>, keep: (row: { division_id: number | null }) => boolean): { rows: { team: Team; checkedIn: boolean }[]; checkedIn: number; total: number }`: participants whose team exists and passes `keep`, sorted by `compareTeamNumbers`.
  - `checkinStatusScreen: ScreenModule = { key: "checkin_status", scrolls: true, ... }`; test ids `total-in`, `total-out`, `checkin-<teamId>` with `data-state="in" | "out"`.

Heading "Check-in" (`display.checkin.title`) with the session label muted right. Two total tiles: "Checked in" `N / total` with its own icon (a filled-centre ring or person-check; distinct from the plain white ring the team tiles use), and "Not checked in" `total−N / total` with the dashed ring. Team grid in three columns, four when more than 30 teams, each tile icon + number (bold) + name (muted, ellipsis). Not checked in: dashed grey ring, no fill, dashed outline, dimmed text. Checked in: white ring on a dark tile. No red or blue. `ScrollingList` around the grid. Notice `display.checkin.none` "No teams are taking part in this session yet" when there are no rows. The SVG icons copy the shapes in `inspection.html`.

- [ ] **Step 1: Failing logic tests:** summary counts 2 of 3 checked in; sorted by number; a participant whose team is in another division is dropped by `keep` and doesn't count in `total`; a participant whose team id isn't in `teams` is dropped.
- [ ] **Step 2: Failing screen tests:** renders `total-in` "2 / 3", `total-out` "1 / 3", tiles in number order with the right `data-state`; emitting `participation_changed` after changing the served participants updates a tile to `in`; empty participants shows the notice.
- [ ] **Step 3: Run**, FAIL. **Step 4: Implement** and register. **Step 5: Run** `npm test`, PASS.
- [ ] **Step 6: Commit** ("Add the Check-in Status screen, with live updates when the front desk checks a team in.").

### Task 13: Restyle the remaining screens

**Files:**
- Modify: `src/display/screens/upcomingMatches.tsx`, `matchResults.tsx`, `eliminationBracket.tsx`, `logo.tsx`, `src/display/SkillsFieldDisplay.tsx`, `src/display/SkillsSetDisplay.tsx`, `display.css`
- Delete: `src/display/components/MatchCells.tsx` if no longer imported
- Test: `tests/unit/listScreens.test.tsx`, `tests/unit/skillsAndBracket.test.tsx`, `tests/unit/skillsDisplays.test.tsx`

No layout redesign: apply the dark tokens, compact heading, table style and side colours from Tasks 5 and 9. Upcoming Matches uses red and blue team columns like Schedule. Match Results becomes the scoreboard list: newest first, match label, red teams (right-aligned), red score, blue score, blue teams; the losing side's teams and score get `is-loser`; a tie dims neither; cooperative shows both teams in side colours and one combined score (`score-combined`). Skills field/set TVs: dark background, no low-contrast labels; nothing else changes.

- [ ] **Step 1: Update tests:** Match Results asserts `score-red`/`score-blue` per row, `is-loser` on the lower side, none on a tie, and `score-combined` for cooperative. Others keep their assertions; fix selectors only where class names changed.
- [ ] **Step 2: Run**, FAIL where expected. **Step 3: Implement.** **Step 4: Run** `npm test`, PASS.
- [ ] **Step 5: Commit** ("Bring Upcoming Matches, Match Results, the bracket, the logo and the skills TVs into the same dark style, with results as a scoreboard list.").

### Task 14: End-to-end coverage for the edge cases

**Files:**
- Modify: `frontend/apps/admin/tests/e2e/tvScreens.spec.ts`
- Create: `frontend/apps/admin/tests/e2e/tvScreensCooperative.spec.ts` (`startIsolatedServer({ backendPort: 8183, frontendPort: 5244, devicePort: 5245 })`, `buildSampleCooperativePluginZip`)
- Modify: `frontend/apps/admin/tests/e2e/displays.spec.ts` where its selectors changed (chips → bands, `live-all` → `live-combined`), keeping every behaviour it checks

Add to `tvScreens.spec.ts` (pit group with a rotation, or switching the group's screen through the API between tests):
- [ ] **Step 1:** one-versus-one match (add Q5 with one team per side and seven-character numbers "123456B" vs "654321C"): field TV and in-match pass `expectFits`; the numbers' `textContent` is complete.
- [ ] **Step 2:** a tie: score Q2 30–30, `last_scored_match` shows no `winner`.
- [ ] **Step 3:** Schedule by Team on a pit display: a team with no unplayed matches shows "No more matches"; the team in the running match shows "now".
- [ ] **Step 4:** Check-in on a pit display: POST a check-in through the API and see that team's tile change to `data-state="in"` and `total-in` go up within 5 s, without reloading the page.
- [ ] **Step 5:** Schedule and rankings on the pit display at 1280×720 have no horizontal overflow (`document.documentElement.scrollWidth <= innerWidth`).
- [ ] **Step 6:** In `tvScreensCooperative.spec.ts`: a cooperative match's field TV shows a red band with the first team and a blue band with the second; in-match shows `live-combined` once a draft total arrives (follow `liveScoring.spec.ts` for posting a draft); the result shows `score-combined` and no `winner`.
- [ ] **Step 7: Run** `npx playwright test tests/e2e/tvScreens.spec.ts tests/e2e/tvScreensCooperative.spec.ts tests/e2e/displays.spec.ts tests/e2e/liveScoring.spec.ts`. Expected: PASS. Then the full suites once: device `npm test`, admin `npm test`, admin `npx playwright test`, server `.venv/bin/pytest`.
- [ ] **Step 8: Commit** ("Cover the TV screens end to end: one versus one, long numbers, ties, cooperative matches, a team with no matches left and live check-in.").

### Task 15: Look at it on the demo servers

- [ ] **Step 1:** Restart the three demo servers (backend on 8000, admin Vite on 5174 with `--host`, device Vite on 5175 with `--strictPort`; background with `timeout: 7200000`) and confirm the served device bundle contains `team_schedule` and `checkin_status`.
- [ ] **Step 2:** Take Playwright screenshots of each redesigned screen at 1920×1080 and compare them side by side with the approved mockups; fix any visible mismatch in spacing, contrast or proportion and re-run the affected tests.
- [ ] **Step 3:** Ask the owner to hard-refresh the TVs and look.
