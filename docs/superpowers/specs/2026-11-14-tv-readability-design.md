# TV readability: design

Date: 2026-11-14. Status: draft for owner review.

## Why

The kiosk screens in the device app (`frontend/apps/device/src/display/`) are hard to read from across a venue. On the in-match screen the clock competes with a header, small team chips tucked in a corner, live totals, and a period banner. These elements can overlap on a 16:9 TV because every size is a fixed `vw` value. The audience and pit screens carry side panels and small type that people don't read.

The owner's priorities, in their words:

- **Audience and field TVs** are read from far away. On the timer, "the important thing is the time remaining". Team numbers must be "visible and readable". Live scores "can be shown at the bottom". There should be an icon for the driver-change period while it is on.
- **Pit TVs** are read up close and hold more information. They should be "clean, uncluttered and easy to read". People walking up want to know when and on which field their next match is, and where they stand in the teamwork and skills rankings.

All of the layouts below were chosen from mockups in a brainstorming session. The approved mockups are kept in `.superpowers/brainstorm/2260565-1794621249/content/`: `in-match-c-v3.html`, `field-next-v2.html`, `audience-screens-v2.html`, `pit-screens.html` and `inspection.html`. They are reference pictures, not code to copy.

## Goals

1. Each screen has one obvious most-important thing, sized to the screen. Nothing overlaps or gets cut off at any 16:9 resolution, with up to four six-character team numbers ("83897A").
2. Every match screen uses one visual family: a dark background; red and blue used only to mean an alliance or starting side; the match name and field in a bottom bar.
3. Pit screens become single, clean tables with no side panels.
4. Two new screens: **Schedule by team**, and **Check-in & inspection** (check-in only until inspections exist).
5. A driver-change cue on the in-match screen.

## Non-goals

- Sounds, screen flashes and plugin-defined cue moments belong to the next slice ("in-match cues"). This slice adds only the visual driver-change tag, with a fixed window.
- No change to how display groups, assignments or rotations work. The owner's "TV 1 alternates rankings, TV 2 alternates schedules" setup already works: make two pit groups, each with its own rotation (see `2026-10-15-display-groups-design.md`).
- No new server data apart from registering the two new screen keys and one realtime event for check-in changes.
- No admin UI changes beyond the new screen's label (en and zh).
- No sponsor logos.

## Anti-goals (failure even if it "works")

- Text that overlaps, is clipped, or is cut off with an ellipsis on a team number. Shrinking to fit is fine; hiding part of a number is not.
- Red and blue shown for anything other than the alliance or side, e.g. a decorative blue banner.
- Low-contrast labels. Text on a coloured badge is either full-strength dark ink or full-strength white (black on amber; white on red, green and blue).
- Bringing clutter back: side panels, scoresheet breakdowns on the audience result, ranks on the in-match band.

## Cooperative games

Cooperative games (`game_model == "cooperative_score"`) still put each team on a side. A cooperative match is stored as two one-team alliances, red and blue, sharing one mirrored score. **The first team in the schedule is red and the other is blue. This matters for starting positions and where drivers stand.**

Today `allianceGroups()` (`display/logic/alliances.ts`) merges a cooperative match into one blue "all" group. That must change. Every screen that shows a match's teams shows them by side (red, blue) for both game models. Only the **score** differs: cooperative shows one combined score, with no winner and nothing dimmed. Expect to split the grouping into "teams by side" (both models) and "score groups" (one per side for head-to-head, one combined for cooperative). `groupScore`'s max-of-mirrored rule for cooperative scores stays.

**Score-chase finals runs** (the owner's rule: "finals matches should still have a red and blue alliance. The higher ranked team is always red."). A score-chase run is stored as one alliance with `station == "solo"` holding the finalist pair, with no opponent and no scheduled time. On every screen its two teams are shown by side, like a cooperative match, with one score:

- **Red** is the team with the better (lower) qualification rank, the ranking the finals were seeded from.
- **Blue** is the other team.
- If a rank is missing, fall back to the order the server lists the teams in.

The builder may instead assign stations on the server when the run is created, if that is simpler and keeps every client consistent. Either way, the side rule is the same. A one-team solo alliance shows that team as red, with no blue team.

## Screens

The sizes given below are proportions of a 16:9 screen, taken from the approved mockups. They are a guide, not exact pixel values.

### 1. In-match screen (field TV and the audience `in_match` screen)

They share one component (today `InMatchView`). From top to bottom:

- **Team band** across the top, red half on the left and blue half on the right. Each half shows its teams' numbers, spaced evenly, with a thin light divider between two teams on the same side. There are no ranks. With one team per side the numbers are larger. With four six-character numbers they are about 5.5% of screen width tall. The numbers fit their half automatically (see Fitting text).
- **Clock**, using all the space between the bands. That is roughly half the screen height, about 28% of screen width in font size, with tabular figures.
- **Under the clock:** the period name, small and muted ("Autonomous", "Driver control"). During the driver-change window it is replaced by an **amber tag**, "⇄ Driver change": dark ink on amber, with a swap-arrows icon.
- **Score bar** along the bottom:
  - head-to-head: red live total on the left (light red text), match name and field in the middle ("QUALIFICATION 12 · Field 1", with the field muted), blue live total on the right;
  - cooperative: one combined total and the match name.
  - Totals keep the small "LIVE" tag. They show only while the clock runs, as today. When there is no live total, the score positions are empty but the bar and title stay.

**Driver-change window (fixed for this slice).** The window is on when `phase == "driver"` and the time remaining is at most 35 s and more than 25 s. A match whose driver period is 35 s or shorter never shows it. Keep the window boundaries as named constants in one place, because the in-match cues slice will move them into game-plugin data.

**Other states keep their current behaviour in the new layout:**

- **Count-in** (`COUNT_IN_PHASES`): a **full-screen overlay**. One giant number on black covers everything, bands included, as big as the screen allows. This is what the room sees when the operator presses Start, and before the driver period when the game has a count-in there.
- **`awaiting_driver`:** the clock area shows "Driver control next". The bands and score bar stay.
- **`ended`:** the clock shows 0:00 with "Match over" under it.
- **Paused:** keep a clear paused indicator. It may sit under the clock in place of the period line, or as a band, but it must not overlap the clock digits.

### 2. Field TV before the match (`FieldDisplay`, `not_started`)

For the referees' robot check, so the numbers are the biggest thing on screen.

- Red alliance fills the top half and blue the bottom half. Team numbers are as large as fit: about 11% of screen width for two per side with six characters, larger for one per side. A thin divider separates two teams on the same side.
- **Bottom bar:** the match name and field on the left, the start-countdown badge on the right. The badge keeps today's colour rules (`startBand`: green early, amber from 30 s, red once late; "Up next" when there's no scheduled time) and today's wording ("Starts in 1:45", "Late by 0:40"). The label part ("STARTS IN") is smaller but the same full-contrast colour as the time.
- Cooperative games look the same: first team red on top, second team blue below.

### 3. Audience: match intro (`match_intro`)

- Red half on top, blue half below (cooperative too). One row per team: rank ("#3", muted), number (large and bold), name, and the team's place (city, state, country; small, under the name). The number column is wide enough for six characters, and names never push into it. A long name may shrink, or be clipped with an ellipsis; a number may not.
- **Bottom bar:** "UP NEXT · QUALIFICATION 12 · Field 1" and the start-countdown badge.

### 4. Audience: last match result (`last_scored_match`)

- **Head-to-head:** the screen splits left and right. Red is on the left and blue on the right, each with its score huge (about 19% of screen width) and its team numbers under it. The winner gets a "WINNER" tag (dark ink on light). The losing side is dimmed. A tie: both sides at full strength, no tag.
- **Cooperative:** both team blocks stay in their side colours, each with its team number, and one combined score sits large between or below them. No winner tag and nothing dimmed.
- **Bottom bar:** "RESULT · QUALIFICATION 11 · Field 2".
- **The scoresheet breakdown is removed from this screen.** That is the owner's call. Update the display-groups spec's description of `last_scored_match` to match.

### 5. Teamwork rankings (`teamwork_rankings`), audience and pit

- One full-width table, with the "Match schedule & results" side panel removed. A heading row has "RANKINGS" on the left and a muted "After N of M qualification matches" on the right.
- Columns: rank (the top three in amber), number (bold), name, then the game model's columns: head-to-head W-L-T (muted), WP, SOS; cooperative matches played and average score. These come from the game model, as they do today.
- **Audience size** shows about eight rows at large type. **Pit size** shows about ten or more rows at smaller type. The screen chooses the size from where it is shown: a pit group has `fieldSetId == null`.
- Scrolls slowly when longer than the screen, as today.

### 6. Skills rankings (`skills_rankings`), audience and pit

- One full-width table, with the "Top 10" and "Recent scores" side panels removed.
- Columns: rank (top three amber), number, name, total (bold), then one column per skills type with its best score and the attempts used, shown small and muted ("120 2/3"). A type with no attempt shows "–" and "0/3".
- Uses the same audience and pit sizing rule as teamwork rankings.

### Rules shared by the two schedule screens (my calls)

- **Rounds.** Both schedule screens keep today's scope, every round (practice, qualification, elimination), in time order. The heading's context line names the round of the earliest unplayed match: "Practice · 3 of 8 played", "Qualification · 11 of 40 played" or "Eliminations". The count is played over total in that round. A match with no scheduled time (finals) shows "–" in the time cell, and on Schedule by team "Q13 · F2" with the time left off.
- **"On field".** A match is on a field if it is the match that field's own TV shows. That is the existing `currentMatchForField()` in `@tournament-admin/shared`: a running match, else one that has ended but isn't scored yet, else the field's next unplayed match. It is computed per field from the match list alone, so it works on pit groups. The schedule tags one match per field with "ON FIELD". Schedule by team shows "now" for a match that is running or ended-but-unscored. A field's next unplayed match keeps its time.
- **"Played"** means fully scored (`isFinished`), the same rule the device app already uses. The schedule's starting row is two played matches before the earliest unplayed one.

### 7. Match schedule (`schedule`)

- Table in time order: match, time, field, red teams (right-aligned, red text), blue teams (blue text). Cooperative uses the same red and blue columns.
- Played matches are greyed. The match currently on a field gets an amber "ON FIELD" tag and a highlighted row. The list starts two played matches before the earliest unplayed one, so "now" is near the top. It scrolls after that.
- Heading: "MATCH SCHEDULE", with a muted "Qualification · N of M played".

### 8. Schedule by team (new screen key `team_schedule`)

- One row per team in the division, in team-number order. Columns: number (bold), name (muted), then the team's **next three unplayed matches**. Each is shown on two lines, "Q13 · Sharks" then "10:32": match label and the field's own name (shrunk to fit, never wrapped), then the scheduled time. A red or blue dot in front shows the team's side. A match running now shows "now" in place of the time.
- Fewer than three left: empty cells show "–". No matches left: a single muted "No more matches".
- Heading: "SCHEDULE BY TEAM", with a muted "Next matches · teams in number order".
- Allowed on audience and pit groups, no settings, `scrolls: true`.
- Register it on the server (`services/display_screens.py` registry and the shared `ScreenKey` list), in the device app's screen registry, and in the admin app's screen labels (en: "Schedule by Team"; zh: a matching label).
- **Field name:** always the field's own name, as on every other screen. An earlier "F" plus position for long names was dropped: it showed some fields by name and others by code, which no team could match to the field.

### 9. Check-in & inspection (new screen key `checkin_status`; pit and audience)

This is the owner's design. The screen is built in this slice **with check-in only**. The inspection parts appear when the deferred inspections subsystem lands; the approved picture is `inspection.html` in the mockup folder.

- **Heading row:** "CHECK-IN & INSPECTION" (in this slice, "CHECK-IN"), with the session name muted on the right.
- **Totals row:** dark tiles, each with an icon, a large count over its total, and a small caps label.
  - Final design: **Checked in N / all teams**; **Inspected N / checked in**; **Partial N / checked in**; **Not started N / checked in**.
  - In this slice: only **Checked in N / all teams** and **Not checked in N / all teams**.
- **Team grid:** every team taking part in the session, in team-number order, in three columns (four if needed to fit), scrolling slowly when it is still too long. Each tile shows an icon, the number (bold) and the name (muted, cut with an ellipsis if long).
- **States.** Each state has a distinct icon shape as well as a colour, so it reads without colour vision. Red and blue are never used here.

  | State | Icon | Tile |
  |---|---|---|
  | Not checked in | dashed grey ring | no fill, dashed outline, dimmed text |
  | Checked in (in this slice); later, checked in but inspection not started | solid white dot (a plain ring read as empty on a TV) | dark tile |
  | Partly inspected (later) | half-filled amber circle | amber tint |
  | Fully inspected (later) | green circle with a check | green tint |

  The "Checked in" total tile gets its own icon, distinct from the "Not started" ring; the mockup reused the ring by mistake.
- **Which teams:** the session's participants, from `GET /api/sessions/{id}/participants`, which displays can already read. The division filter is applied the same way as on other screens: a pit group's division, or every team in a single-division event.
- **Live updates:** today nothing tells displays that a check-in changed. Add a realtime event (e.g. `participation_changed {session_id}`) broadcast when a check-in is set. Also send it to display devices, following the existing event model and `useLiveRefresh` pattern. The screen refetches on it, so a check-in shows on the TV within a second or two. Ship the event with pytest integration tests.
- **Registration:** register the screen like `team_schedule`: in the server registry, the shared `ScreenKey`, the device registry, and the admin labels (en "Check-in Status", zh to match). It is `scrolls: true`, with no settings.
- **When inspections exist,** the inspections slice adds the three inspection states and totals to this same screen. That later slice doesn't need a new screen key.

### 10. Remaining screens

`upcoming_matches`, `match_results`, `elimination_bracket`, `logo`, the skills field TV (`SkillsFieldDisplay`) and the skills set TV are not being redesigned. Bring them into the same visual family:

- dark background;
- side colours only for sides;
- the same heading style, table style and bottom-bar treatment where they fit;
- no low-contrast labels.

The `match_results` list follows the approved "recent results" scoreboard: newest first, red teams, red score, blue score, blue teams, with the losing side dimmed. Cooperative shows both teams in side colours and one score.

## The common frame

The current `ScreenFrame` header (event name plus a giant uppercase title) takes up too much height on match screens.

- **Match screens** (in-match, field-next, intro, result) drop the header. Their identity moves into the bottom bar.
- **Table screens** (rankings, schedules, results, bracket) use a compact heading row instead: the title on the left, a muted context line on the right.
- The event name may appear small in a table screen's heading. It doesn't appear on match screens.

## Fitting text

The screens are 16:9 TVs and projectors at any resolution. Sizes should follow the screen as they do today. Team numbers, the clock and the count-in must also be guaranteed to fit their box. Use whatever approach is simplest and reliable, for example:

- container-relative units plus a measured shrink-to-fit for team-number rows; or
- a fixed character budget per row.

The test cases: four six-character numbers; one six-character number per side; seven-character numbers; a cooperative match. Very long team names on the intro and ranking screens may be cut with an ellipsis. Numbers may not.

## Constraints

- Every new user-facing string goes in en and zh (`device.json`, and `admin.json` for the new label).
- Never name a real-world competition brand or product anywhere.
- Follow the existing device-app patterns: screen modules, `ScreenProps`, `useServerNow`, `WaitingForData` and `ScreenNotice`, and the scrolling and rotation behaviour.
- Tests:
  - Vitest for the logic: side grouping for both game models, the driver-change window, the schedule-by-team "next three", and the fit rules.
  - pytest for the new screen key in the registry.
  - Playwright for each redesigned screen's golden path, plus the edge cases above: cooperative, one versus one, four long numbers, ties, a team with no more matches, the count-in overlay, and the driver-change tag on and off.
  - Update existing specs that this changes, without weakening their assertions.

## Left to the builder

- The exact sizes, spacing and component structure, within the proportions above.
- How the text fitting is done.
- The paused indicator's exact placement (it must not overlap the clock).
- Whether the intro's long team names shrink or are cut with an ellipsis.
