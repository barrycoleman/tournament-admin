# Finalize Qualification Design

## Context and motivation

Season rankings (`2026-10-06-season-rankings-design.md`) earn cooperative session drops against each team's *scheduled* qualification matches. Drops start only when the last P scheduled matches are scored. A session that ends early, for example because the venue closes, never reaches those matches, so its teams never earn their drops. There is also no point at which the qualification results are declared final. Today finals can be generated from rankings that may still change.

**Intended outcome:**
- An admin explicitly **finalizes qualification** for a session from the Matches page.
- When finalizing a cooperative session, the admin decides how many matches each team drops, based on how many it actually played.
- Session and season rankings then use those numbers.
- Finals can be generated only from a finalized session.

**Decisions made during design (user-confirmed):**

- **Finalizing is manual only.** It never happens automatically when the last match is scored, because scores may still be disputed at that point.
- **Finals require a finalized session.** Generating a finals bracket for a session whose qualification is not finalized is refused. The UI must say why the action is unavailable.
- **The drops dialog asks once per played count.**
  - The dialog has one row for each distinct number of qualification matches played by at least one team in the session, across all divisions. For example, if some teams played 7 and some 8, it shows a "7 played" row and an "8 played" row. It never shows rows for counts no team has.
  - Each row starts at a suggested value taken from the event's session drop setting:
    - tier table → the tier for the played count;
    - lowest P → P;
    - none → 0.
- **No-shows count as played.** The match happened and the team missed it, and its zero stays.
- **Unplayed qualification matches become "not played".**
  - They stop counting as scheduled, never count as zeroes, and cannot be scored.
  - Practice and finals matches are untouched.
- **A finalized team's drops come straight from its row.** They are applied immediately, replacing the "earned as the last scheduled matches are scored" rule. The usual guards still apply:
  - a team's last remaining record is never dropped;
  - a no-show or DQ zero is dropped only if the session settings allow it.
- **Head-to-head sessions can be finalized too** (to end qualification and unlock finals). They have no drops dialog, only a confirmation, because head-to-head never drops matches.
- **Season rankings follow automatically.** "Only use matches counted in a session ranking" uses the finalized session drops.
- **Score corrections remain allowed after finalizing.** A played match's score can be corrected, and rankings recompute with the drop counts already entered.
- **Reopening is allowed only while the session has no finals bracket.** Reopening:
  - turns the "not played" matches back to "scheduled";
  - clears the entered drop counts;
  - unfinalizes the session.
- **Storage (approach 1).** The session records when it was finalized and a map from played count to drops. Played counts cannot change after finalizing, since no new qualification match can be scored, so the map stays valid through later corrections.

## Global Constraints

- Never reference any real-world competition brand or product name anywhere.
- Every backend change ships with pytest unit and integration tests against a real FastAPI `TestClient` and a real temp-file SQLite database, in the same change as the code.
- Every frontend change ships with Vitest component tests and Playwright E2E coverage of its user-facing flows, with no mocking at the HTTP/WebSocket boundary in E2E.
- Schema changes go through the project's Alembic migration mechanism.
- Every user-facing string goes through `t(...)` in both the `en` and `zh` `admin.json` files.
- No change to the game-plugin interface.

## Section 1: Data model

### 1.1 `sessions` columns

| Column | Type | Meaning |
|---|---|---|
| `qualification_finalized_at` | `UTCDateTime`, nullable | When qualification was finalized. `NULL` means open. |
| `qualification_drops` | `JSON`, nullable | Map from played count to drops, with string keys, e.g. `{"7": 1, "8": 2}`. `NULL` while open, and `{}` for a finalized head-to-head session. |

One Alembic migration adds both columns. Existing sessions start open.

### 1.2 Match status `not_played`

`Match.status` gains the value `"not_played"`. It is a string column, so no schema change is needed. Only qualification matches (not practice, not finals) whose status is not `completed` at finalize time get it. Reopening sets them back to `"scheduled"`.

### 1.3 `SessionRead`

`SessionRead` adds `qualification_finalized_at: datetime | None` and `qualification_drops: dict[str, int] | None`.

## Section 2: Calculations

### 2.1 Played count

A team's **played count** in a session is the number of its qualification match records (`MatchRecord`s, as built for rankings, including no-shows and DQs). Teams with zero records get no dialog row and no ranking, as today.

### 2.2 Session drops after finalizing

`session_drops(records, scheduled, rules, finalized_drops=None)` gains an optional `finalized_drops: int | None`.

- **`None` (session open):** unchanged behaviour.
- **An integer:** the allowance is that integer, applied immediately. There is no earning gate. The result is still capped at `len(records) - 1`, still respects the session no-show/DQ settings, and still breaks ties lowest score first, then match id.

`recompute_rankings` and the season replay look up `qualification_drops[str(played_count)]` for each team in a finalized session and pass it in.

If a team's played count is missing from the map, it is treated as 0 drops. That can only happen through direct database edits, because played counts are frozen at finalize time.

### 2.3 Suggested values

`suggest_finalize_drops(played: int, rules) -> int`:
- tier mode → `suggest_exclusion_count(played)`;
- lowest mode → `rules.session_drop_count`;
- none → 0.

In every mode the result is capped at `played - 1` (minimum 0). It is pure and lives in `ranking_rules.py`.

## Section 3: API

All three endpoints are under `/api/sessions/{session_id}/qualification`.

### 3.1 `GET .../finalize-preview` (admin)

```json
{
  "finalized": false,
  "game_model": "cooperative_score",
  "rows": [{"played": 7, "teams": 4, "suggested": 1}, {"played": 8, "teams": 12, "suggested": 2}],
  "unplayed_matches": 6,
  "blockers": []
}
```

`blockers` lists reasons finalizing is not possible right now, each as `{"code": ..., "count": n}`:
- `in_progress`: a qualification match whose phase is not `not_started` or `ended` (running or paused);
- `ended_unscored`: a qualification match whose phase is `ended` but which has no score yet;
- `no_matches`: the session has no qualification matches.

For head-to-head, `rows` is `[]`.

### 3.2 `POST .../finalize` (admin)

The body is `{"drops": {"7": 1, "8": 2}}`. Head-to-head sends `{"drops": {}}`.

It fails with:
- **409** if the session is already finalized, or if any blocker exists. The detail is a readable message naming the blocker.
- **422** unless:
  - the keys are exactly the played counts present (cooperative);
  - each value is an integer with `0 ≤ value ≤ played − 1`;
  - head-to-head sends no keys.

On success, in one transaction, it:
1. marks the unplayed qualification matches `not_played`;
2. sets both session columns;
3. recomputes the session and the event-wide rankings;
4. broadcasts a new `qualification_status_changed` event (`{"session_id", "finalized": bool}`) through `broadcast_for_session`, plus the existing `ranking_updated` events.

It returns the updated `SessionRead`.

### 3.3 `POST .../reopen` (admin)

It fails with **409** if the session is not finalized, or if any finals bracket exists for the session ("Delete this session's finals brackets before reopening qualification").

Otherwise it reverts `not_played` → `scheduled`, clears both columns, recomputes, and broadcasts as in 3.2. It returns `SessionRead`.

### 3.4 Guards elsewhere

- **Finals:** creating a finals bracket for an unfinalized session returns **409**: "Finalize this session's qualification before generating finals."
- **Scores:** submitting a score for a `not_played` match returns **409**: "This match was not played; reopen qualification to score it." Corrections to `completed` matches in a finalized session are allowed.
- **Schedule:** in a finalized session, any change to the qualification schedule (generate, regenerate, add or delete rounds or matches) returns **409**: "Qualification is finalized; reopen it to change the schedule."
- **Match control:** starting a `not_played` match returns **409**.

## Section 4: Admin UI

### 4.1 Matches page

- **Header actions:**
  - An open session shows a **Finalize qualification** button.
  - A finalized session shows a status line, "Qualification finalized on {date}. Finals can now be generated.", and a **Reopen** button.
- **Blockers:** when the preview reports blockers, the Finalize button is disabled and a line below it names them, e.g. "2 matches are in progress", "1 match has ended but has no score".
- **Status column:** shows "Not played" for `not_played` matches.
- **Reopen:**
  - asks for confirmation;
  - if the server refuses because finals exist, shows the server's message inline.

### 4.2 Finalize dialog

- **Cooperative:**
  - A short explanation ("No more qualification matches will be played. Choose how many of each team's lowest matches to drop.").
  - One row per played count: "{played} played ({teams} teams)" with a number input pre-filled with `suggested`, `min=0`, `max=played−1`.
  - The number of matches that will be marked "Not played".
  - **Finalize** and **Cancel** buttons.
  - Invalid inputs show inline errors (announced with `aria-live`) and disable Finalize.
- **Head-to-head:** a confirmation with the explanation and the "Not played" count, plus Finalize and Cancel.
- **Server errors** (409 or 422) appear inside the dialog.

### 4.3 Live updates and finals

- **Live updates:** the session, matches and finalize-preview queries are invalidated on `qualification_status_changed`, so other open admin windows update. The preview is also invalidated on `match_phase_changed` and `score_saved`, so its blockers stay current.
- **Finals:**
  - The admin app has no Finals page yet.
  - Until then, the server refusal in 3.4 and the Matches-page status line are the user-visible signal.
  - The future Finals page **must** read `qualification_finalized_at` and show the generate action disabled with "Finalize qualification on the Matches page before generating finals.", linking to the Matches page.

## Section 5: Error handling summary

| Situation | Result |
|---|---|
| Finalize while a match is running/paused or ended unscored | 409; the button is disabled with the reason |
| Finalize twice | 409 |
| Drops map missing a played count, has extra keys, or a value out of range | 422, shown in the dialog |
| Score a `not_played` match | 409 |
| Generate finals before finalizing | 409 |
| Change the schedule after finalizing | 409 |
| Reopen with finals present | 409, shown inline |

## Section 6: Testing

**pytest:**
- **Rules:**
  - `session_drops` with `finalized_drops`: applied immediately, capped at `len − 1`, and no-show/DQ settings honoured;
  - `suggest_finalize_drops` for every mode, including the `played − 1` cap.
- **API:**
  - Preview rows, team counts and suggestions across two divisions, plus each blocker.
  - Finalize, checking:
    - match statuses;
    - columns;
    - rankings recomputed with the entered drops (e.g. 10 scheduled, 8 played, 2 drops → the lowest two dropped, where before finalizing none were);
    - the season ranking using the session drops under "only use matches counted in a session ranking".
  - The 422 validation cases.
  - The 409 cases: twice, and with blockers.
  - Head-to-head finalize.
  - Reopen restores statuses and rankings.
  - Reopen refused while a finals bracket exists.
  - Finals creation refused before finalizing and allowed after.
  - Scoring a `not_played` match refused.
  - Correcting a completed match after finalizing recomputes rankings.
  - Schedule changes refused after finalizing.
  - Broadcasts sent.
- **Migration:** the upgrade adds the columns, and existing sessions read as open.

**Vitest:**
- the Finalize dialog (rows, prefill, validation, head-to-head confirmation, server error);
- the Matches page header (open, finalized, blockers);
- the "Not played" status.

**Playwright** (real server):
- **Golden path:** finalize a cooperative session with uneven played counts, adjust a row, confirm, and check:
  - the unplayed matches show "Not played";
  - the Rankings tab reflects the entered drops;
  - Reopen restores them.
- **Edge cases:**
  - Finalize disabled while a match is in progress;
  - out-of-range drop input blocks submit;
  - head-to-head finalize confirmation;
  - Reopen refused with a finals bracket present (bracket created through the API).

## Out of scope

- A Finals page in the admin app (the gate is enforced on the server; see 4.3).
- Per-team drop exceptions.
- Automatic finalizing.
- Finalizing per division. One finalize covers the whole session.
