# Season Rankings Design

## Context and motivation

A league is an event with more than one session. Each session already ranks its teams from its own qualification matches, and `Ranking` rows with `session_id = NULL` are meant to hold the event-wide ("season") standings. Today those standings are incomplete:

- **Head-to-head events have no season standings.** `recompute_event_rankings` returns immediately unless the game model is `cooperative_score`.
- **Cooperative drop rules are a single per-division knob** (`RankingConfiguration`: `exclude` the lowest *count* or `include` the best *count*). That one setting serves both the session and the season ranking, with no way to express how a league actually wants each one.
- **The match-count drop table is never used.** `suggest_exclusion_count` exists, but nothing calls it. With no configuration a session drops nothing.
- **Nobody can see any of it.** The admin UI has no rankings page and no ranking settings.

**Intended outcome:**
- Each session has a Rankings tab.
- The event has a Season Rankings page.
- An admin sets how cooperative sessions drop matches and how the season combines them.
- Rankings recompute whenever a score or a setting changes.

**Decisions made during design (user-confirmed):**

- **Only qualification matches count.** Finals never count toward any ranking, even a mid-season finals. Practice never counts either. A mid-season finals may feed awards later, but it has no bearing on standings.
- **Head-to-head season standings are total win points** (2 for a win, 1 for a tie, 0 for a loss) over every qualification match in every session. Nothing is ever dropped. A team that misses a session simply earns fewer win points; that is the penalty.
- **Cooperative session rankings** drop the lowest-scoring matches. By default the count comes from the tier table (0–3 played → 0 dropped, 4–7 → 1, 8–11 → 2, 12–15 → 3, 16+ → 4). The admin may instead choose **no drops** or **drop the lowest P**.
- **Cooperative season rankings** have three admin settings:
  - **Keep the best N matches.** Blank means all.
  - **"Only use matches counted in a session ranking."** A match its session dropped is left out of the season.
  - **Minimum matches.** A team with fewer counted matches than the minimum gets zeroes for the shortfall. For example, N = 24, minimum = 24 and 16 matches played gives 8 zeroes, so the score is the sum divided by 24.
- **No-shows and DQs are always scored 0 and never ignored.** Four independent settings decide whether that zero *may be dropped*:
  - session no-show
  - session DQ
  - season no-show
  - season DQ

  An organiser might, for example, let no-shows be dropped but not DQs.
- **A zero that may not be dropped at season level is forced into the season.** It occupies one of the N slots, so the team has N − 1 other scores counted, and the score is the sum (including the zero) divided by N. When a team has more forced zeroes than N, all N slots are zeroes and the score is 0. Only N matches ever count.
- **A no-show is a scheduled match the team failed to attend.** A team that never checked in for a session has no matches in it. That is not a no-show and produces no records at all.
- **The defaults give a plain season average:** N blank, minimum 0, checkbox off.
- **One settings record per event, shared by every division** (approach A). It replaces the per-division `RankingConfiguration`.
- **Rankings are computed from the matches every time.** Nothing like a "dropped in session" flag is stored. The season recompute replays the session drop selection in memory.
- **Skills rankings are out of scope here.** The Season Rankings page ships with a single **Teamwork** tab. The skills spec adds tabs for each plugin-defined skills type (e.g. Driver, Autonomous) and for Overall Skills:
  - **Session Overall:** the sum of the team's best attempt in each type in that session.
  - **Season Overall:** the team's best session Overall.
  - **Season per type:** the team's best attempt of that type across all sessions.

## Global Constraints

- Never reference any real-world competition brand or product name anywhere.
- Every backend change ships with pytest unit and integration tests against a real FastAPI `TestClient` and a real temp-file SQLite database, in the same change as the code.
- Every frontend change ships with Vitest component tests and Playwright E2E coverage of its user-facing flows, with no mocking at the HTTP/WebSocket boundary in E2E.
- Schema changes go through the project's Alembic migration mechanism (`docs/superpowers/specs/2026-09-10-database-migrations-design.md`). Existing ranking configuration is carried forward, not discarded.
- Every user-facing string goes through `t(...)` in both the `en` and `zh` `admin.json` files.
- No change to the game-plugin interface. `rank_teams` keeps its current input and output shapes.

## Section 1: Settings and data model

### 1.1 `ranking_settings` table

There is one row per event (`event_id` unique). The row is created with defaults the first time it is read or written.

| Column | Type | Default | Meaning |
|---|---|---|---|
| `event_id` | FK `events.id`, unique | — | |
| `session_drop_mode` | String(20): `tiered` / `none` / `lowest` | `tiered` | How a cooperative session picks its drop count |
| `session_drop_count` | int ≥ 1 | 1 | P, used only when the mode is `lowest` |
| `session_drop_no_show` | bool | false | A no-show zero may be dropped in a session |
| `session_drop_dq` | bool | false | A DQ zero may be dropped in a session |
| `season_keep_best` | int ≥ 1, nullable | NULL | N; NULL means keep all |
| `season_only_session_counted` | bool | false | Leave out matches the session dropped |
| `season_minimum` | int ≥ 0 | 0 | Shortfall below this is filled with zeroes |
| `season_drop_no_show` | bool | false | A no-show zero may be dropped from the season |
| `season_drop_dq` | bool | false | A DQ zero may be dropped from the season |

**Validation** (422 with a readable `detail`):
- `session_drop_mode` must be one of the three values.
- `session_drop_count` must be ≥ 1.
- `season_keep_best` must be NULL or ≥ 1.
- `season_minimum` must be ≥ 0.
- When `season_keep_best` is set, `season_minimum` must be ≤ it. Only N matches ever count, so the zero-fill can never reach a larger minimum.

Head-to-head events ignore every setting. The API still stores and returns them, so switching a not-yet-scored event's game plugin loses nothing.

### 1.2 API

- **`GET /api/ranking-settings`** (any role): returns the settings plus a read-only `game_model` (`head_to_head` / `cooperative_score`, or `null` when no game plugin is selected). The UI uses `game_model` to decide whether to show the panel. Returns 404 when the event isn't initialised.
- **`PUT /api/ranking-settings`** (admin):
  - Validates and saves the whole settings object.
  - Then recomputes every session's rankings for every division, and the season rankings for every division (Section 2.5).
  - Returns the saved settings.
  - When no game plugin is selected, saves without recomputing.

### 1.3 Migration and removal

One Alembic revision:
1. Creates `ranking_settings`.
2. Converts an existing `ranking_configurations` row. The event-wide row (`division_id IS NULL`) wins; otherwise the lowest-id row is used.
   - `exclude` with count P becomes `session_drop_mode = lowest`, `session_drop_count = P`.
   - `include` with count N becomes `season_keep_best = N`, `season_minimum = N`. This is exactly today's include behaviour: keep the top N and zero-pad the shortfall.
   - `allow_drop_no_show` / `allow_drop_dq` copy into both the session pair and the season pair.
   - With no row, no settings row is written; defaults apply on first read.
3. Drops `ranking_configurations`.

The `RankingConfiguration` model, its schemas, `routers/ranking_configuration.py` and `tests/test_ranking_configuration.py` are removed. `tests/test_cooperative_scoring.py` moves to the new endpoint. No frontend code uses the old endpoint.

### 1.4 `Ranking` rows

The table is unchanged:
- Session rows have `session_id` set.
- Season rows have `session_id = NULL`.
- For cooperative events, `matches_played` is the number of qualification matches the team played (in that session, or in the whole season). It is not the number counted after drops.

## Section 2: Calculations

The rules live in a new pure module, `services/ranking_rules.py`. It has no database access and no plugin calls, and is unit-tested exhaustively. `services/ranking.py` gathers the records, calls these functions, calls `plugin.rank_teams`, and writes `Ranking` rows.

### 2.1 Match records

A cooperative match record is one team's result in one completed qualification match:

```python
@dataclass(frozen=True)
class MatchRecord:
    match_id: int
    session_id: int
    score: int        # 0 when no_show or dq
    no_show: bool
    dq: bool
```

**Qualification** means:
- `status == "completed"`
- `finals_bracket_id IS NULL`
- `round_type != "practice"`

These are today's filters, applied identically to the session and the season.

### 2.2 Cooperative session ranking

`session_drops(records, settings) -> set[int]` returns the match ids dropped for one team in one session.

1. **Drop count D:**
   - `tiered`: `suggest_exclusion_count(len(records))`, counting every record, forced zeroes included.
   - `none`: 0.
   - `lowest`: `session_drop_count`.
2. **Choosing the drops.** Sort the records by `(score, match_id)` ascending. Walk the list and drop each record that is **droppable at session level** until D are dropped or the list runs out.
   - **Droppable** means neither no-show nor DQ, or a no-show with `session_drop_no_show`, or a DQ with `session_drop_dq`.
   - The `match_id` tie-break only makes the result repeatable; dropping either of two equal scores gives the same average.
   - If every record would be dropped (e.g. `lowest` with P ≥ matches played), the drops stop when one record is left.

`session_score(records, drops) -> float` is the mean of the records not in `drops`, or 0.0 when there are no records.

### 2.3 Cooperative season ranking

`season_score(records, session_drops_by_match, settings) -> float`, for one team across all sessions:

1. **Pool.** All of the team's records.
   - With `season_only_session_counted`, remove every record whose match was dropped by its session (`session_drops_by_match`, computed with 2.2 per session).
   - **Except:** a record that is **not droppable at season level** stays in the pool even if its session dropped it. Season-droppable uses the same rule as session-droppable, with the season flags.
2. **Forced** = pool records not droppable at season level. **Others** = the rest of the pool.
3. **Kept.**
   - With `season_keep_best` N set: take `forced[:N]` (ordered by `match_id`), then fill the remaining `N − len(that)` slots with the highest-scoring `others`.
   - With N blank: kept = the whole pool.
4. **Divisor** = max(len(kept), `season_minimum`).
5. **Score** = sum(kept scores) ÷ divisor, or 0.0 when the divisor is 0.

Worked examples (each one is a unit test):
- **Shortfall.** N = 24, minimum = 24, checkbox on. The team played 20, and its sessions dropped 3. That leaves 17, so 17 are kept and the score is sum ÷ 24.
- **Forced zero.** N = 5, one DQ that may not be dropped, plus scores 50, 40, 30, 20, 10, 5. Kept = {0, 50, 40, 30, 20}, so the score is 140 ÷ 5 = 28.
- **More forced zeroes than N.** N = 3 with four undroppable DQs: kept = three zeroes, so the score is 0.
- **Session-dropped forced zero.** The checkbox is on, and the session dropped a no-show (session no-shows droppable). Season no-shows are not droppable, so it returns to the pool as forced.
- **Defaults** give the plain mean of every record.

### 2.4 Head-to-head

Today's session code is extracted into `head_to_head_results(match_rows) -> list[team result]`:
- **Win points:** 2 for a win, 1 for a tie, 0 for a loss. A no-show or DQ alliance scores 0.
- **Strength of schedule:** the sum of opponents' win points, computed within the same match set.
- **Skipped:** matches without exactly two alliances or with a missing score record.

The session recompute passes that session's qualification matches. The season recompute passes the qualification matches of every session in the event. Both then call `plugin.rank_teams`. There are no drops, and settings are ignored.

### 2.5 Recompute

- **`recompute_rankings(app, db, plugin, session_id, division_id)`** computes the full ranked list for that scope. It then **replaces** the scope's `Ranking` rows, deleting rows for teams no longer present. A scope with no qualifying matches ends with no rows, and broadcasts `ranking_updated` as today.
- **`recompute_event_rankings(app, db, plugin, event_id, division_id)`** now runs for both game models. It replaces the season rows for that division in the same way and broadcasts with `event_wide: true`.
- **`recompute_all_rankings(app, db, plugin)`** is new. Called after a settings save, it walks every session × division (including `NULL`), then every division's season.

Callers:
- The **score endpoint** is unchanged; it already calls both.
- The **round-delete endpoint** no longer needs its own "delete stale rankings first" blocks, because the recomputes now replace rows. Those blocks are removed.
- **Session deletion** only ever removes unscored sessions, so it needs no recompute.

A team appears in a ranking only if it has at least one qualifying match record in that scope.

## Section 3: Admin UI

### 3.1 Session → Rankings tab

**Route and placement:** `/sessions/:sessionId/rankings`, added after **Matches** in `SessionDetailLayout`'s tab bar.

**Layout:**
- One table per division, headed by the division name.
- With no divisions, a single unheaded table for `division_id = null`.
- The query is `GET /api/rankings?session_id=…&division_id=…` under the key `["rankings", sessionId, divisionId]`.

**Columns:**
- Cooperative: Rank, Team (number), Name, Score (two decimals), Matches played.
- Head-to-head: Rank, Team, Name, Win points, Strength of schedule.

**Live updates:**
- The session WebSocket (`/ws/session/:id`, as `useSessionMatches` uses) delivers `ranking_updated`.
- On that message the page invalidates `["rankings", sessionId]`.

**Empty state:** "No rankings yet. Rankings appear once qualification matches are scored."

### 3.2 Season Rankings page

**Route and nav:** `/rankings`, a new top-level nav item ("Season rankings").

**Tabs:**
- A tab strip with one tab, **Teamwork**. The tab strip exists so the skills spec can add tabs without reshaping the page.
- The Teamwork tab shows the same per-division tables, from `GET /api/rankings?event_wide=true&division_id=…`, keyed `["rankings", "season", divisionId]`.
- Same columns and empty state as 3.1.

**Rules line (cooperative only):**
- Above the tables, one sentence describes the active season rules from `GET /api/ranking-settings`.
- With defaults: "Average of every qualification match."
- Otherwise, e.g.: "Best 24 matches · minimum 24 · only matches counted in a session ranking."

**Live updates:** the page listens on the active-session WebSocket. A `ranking_updated` message with `event_wide: true` invalidates `["rankings", "season"]`.

### 3.3 Event Setup → Rankings panel

A new `panel` section on Event Setup. It is shown only when `game_model == "cooperative_score"`; for head-to-head or no plugin, the panel is not rendered.

**Session drops:**
- Radio buttons:
  - "Drop by matches played (recommended)". The tier table appears as helper text.
  - "No drops".
  - "Drop the lowest [P] matches". The number input is enabled only when this option is selected.
- Checkboxes: "No-shows can be dropped", "DQs can be dropped".

**Season:**
- "Keep best [N] matches": a number input, where blank means all.
- Checkbox: "Only use matches counted in a session ranking".
- "Minimum matches [M]": a number input, where 0 means no minimum. Helper text: "Teams with fewer counted matches get zeroes for the rest."
- Checkboxes: "No-shows can be dropped", "DQs can be dropped".

**Save:**
- The button issues `PUT /api/ranking-settings`.
- **On success:** a status line reads "Settings saved. Rankings recalculated.", and the `["rankingSettings"]` and `["rankings"]` queries are invalidated.
- **On 422:** the server's `detail` is shown inline as an alert, and the form keeps the admin's input.
- The client also blocks the obvious cases (minimum > N, P < 1) with field-level messages before submitting.

## Section 4: Error handling summary

| Situation | Behaviour |
|---|---|
| Invalid settings | 422 with `detail`, shown inline; nothing saved |
| Event not initialised | 404 from both endpoints |
| Non-admin `PUT` | 403 |
| No game plugin selected | Settings save without recompute; `game_model: null` hides the panel |
| Score saved for a finals or practice match | Rankings unaffected (filtered out as today) |
| All of a team's matches dropped by `lowest` | One record is always kept (2.2) |
| Team never checked in for a session | No records in that session; nothing counted, no zero |

## Section 5: Testing

**pytest — pure rules (`tests/test_ranking_rules.py`):**
- Tier boundaries: 0, 3, 4, 7, 8, 11, 12, 15, 16 and 30 matches.
- `none` and `lowest`. `lowest` with P ≥ played keeps one.
- A protected no-show or DQ is skipped, so the next-lowest is dropped instead. Each flag is tested independently.
- Deterministic tie-break on equal scores.
- Every worked example in 2.3, plus:
  - N blank with a minimum
  - minimum 0 with N
  - the checkbox off versus on with the same data

**pytest — integration (real `TestClient` and temp-file SQLite):**
- `GET`/`PUT /api/ranking-settings`:
  - defaults on first read
  - every validation rule
  - admin-only `PUT`
  - `game_model` in the response
  - a save recomputes existing session and season rows
- Cooperative across two sessions:
  - session rows use the tier table by default
  - season rows follow N, the minimum and the checkbox
  - finals and practice matches never change either
- Head-to-head across two sessions:
  - season rows have total win points and season strength of schedule
  - a finals match changes nothing
  - a team absent from one session has fewer win points and still appears
- Stale rows: correcting a score so a team's only match leaves the scope removes its row.
- Round delete still leaves correct session and season rows, now without the removed pre-delete blocks.
- The migration: an `exclude` row, an `include` row, a per-division-only row, and no row. Each upgrades to the documented settings, and `ranking_configurations` is gone.

**Vitest:**
- `SessionRankingsRoute`: columns per game model, per-division tables, empty state, refetch on `ranking_updated`.
- `SeasonRankingsRoute`: Teamwork tab, rules line for defaults and non-defaults.
- `RankingSettingsPanel`:
  - hidden for head-to-head
  - P enabled only for "Drop the lowest"
  - minimum > N blocked client-side
  - server 422 shown inline
  - the saved body matches the form

**Playwright:**
1. **Cooperative event, two sessions:** score qualification matches in both, then check that the session Rankings tab and the Season Rankings page show the expected order and scores.
2. **Settings change:** set N and a minimum on Event Setup, save, and check that the Season Rankings page changes without a reload.
3. **Head-to-head event:** the Rankings panel is absent from Event Setup, and season rankings show summed win points.
4. **Validation:** minimum > N shows the error, and nothing is saved.

## Out of scope

- **Skills challenges.** The data model, attempts and the skills tabs on Season Rankings get their own spec next.
- **Awards.** They get their own spec after skills, and may draw winners from these rankings.
- **Per-division ranking settings.**
- **Score correction UI.** It belongs to the scoring-entry module.
- **Public display or projector views of rankings.** These belong to the display client spec.
