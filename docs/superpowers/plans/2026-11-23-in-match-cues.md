# In-Match Cues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recorded public-domain cue sounds and border-and-banner flashes on the TVs for matches and skills runs, plugin-defined game moments (the driver-change window moves into plugin data), and organiser uploads that replace any of the five sounds.

**Architecture:** The server gains three things: a `moments` list in the game plugin's match format (checked by conformance, passed through `/api/event/match-format`), an `ended_early` flag on matches and skills timers so every TV agrees how a timer stopped, a five-slot event sound store whose audio endpoint serves an upload or the bundled default, and a per-TV sound switch (replacing the group switch). The device app replaces its tone logic with one pure cue function (readings + moments → cues), a slot-based `SoundPlayer` that plays decoded audio, and a `CueFlash` overlay mounted wherever a running timer shows. The cue function, server clock and sound player live in the shared package so the admin's Match Control and Skills Control can play the same cues on the operator's computer. The admin app gets a Sounds panel, a Sound switch per TV, and Match Control's field-set switch.

**Tech Stack:** FastAPI, SQLAlchemy/SQLite, pytest; React + TypeScript, TanStack Query, react-i18next, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-23-in-match-cues-design.md`

## Global Constraints

- Never write any real-world competition brand or product name anywhere (code, comments, tests, commits, strings).
- Every new user-facing string in both `en` and `zh` (device: `frontend/apps/device/src/i18n/{en,zh}/device.json`; admin: the admin app's `en`/`zh` files).
- No new server runtime dependency (the common audio-tag library is GPL; the app is MIT).
- Schema changes edit `server/src/tournament_server/_alembic/versions/000000000001_baseline.py` in place; `tests/test_alembic_drift.py` must pass.
- The five shipped sounds, verbatim from the spec (Freesound id → slot): 391650 → `beep`, 397355 → `start`, 54047 → `buzzer`, 241288 → `moment`, 159399 → `stop`. All CC0 1.0, checked 2026-11-23.
- Slots are exactly `beep`, `start`, `buzzer`, `moment`, `stop`.
- Upload limits: MP3, OGG or WAV; at most 1 MB (1,048,576 bytes); at most 10 s (checked in the admin browser; TVs stop any cue at 10 s).
- Flash colours: moment amber `--kiosk-soon` with dark text; run-out white `--kiosk-ink` with dark text; stop red `--kiosk-late` with white text. Border pulses twice (~1.5 s); banner covers the bottom bar ~2 s. Never cover the clock, team bands, period line or scores.
- The first reading after a TV loads or switches screen never cues.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit only on branch `in-match-cues`; never push.

## Review Focus

1. **Run-out vs early end on a skewed TV clock** — a match that runs out while the TV's clock is 1 s behind must buzz, not power down; one ended early with 0.4 s left must power down. Pinned in Task 5 (cue function keys only on `ended_early`, never on remaining time) and Task 2 (server flag).
2. **Resetting a finished timer** — Skills Control resets an ended skills timer for the next team; that must be silent. Pinned in Task 5.
3. **A TV that misses readings** (tab throttled, refetch late) jumps from 9 s left to 2 s left: it must play the moment(s) crossed and the beeps for 3 and 2 once each, not replay or skip the run-out. Pinned in Task 5.
4. **An organiser upload that won't decode** on a TV (renamed text file that slipped past, codec the browser lacks) — that slot falls back to the default, other slots unaffected. Pinned in Task 6.
5. **Audit rows for uploads** — the audit hook must not dump a megabyte of `bytes` into `audit_log`. Pinned in Task 3.

---

### Task 1: Game moments in plugin data

**Files:**
- Modify: `server/src/tournament_server/plugin_registry/conformance.py` (`_check_match_format`)
- Modify: `server/src/tournament_server/schemas/event.py` (`MatchFormatRead`), `server/src/tournament_server/routers/event.py` (`read_match_format`)
- Modify: `server/plugins/games/sample_cooperative/plugin.py`, `server/tests/fixtures/plugins/games/example-game/plugin.py`, `server/tests/fixtures/plugins/games/cooperative-game/plugin.py`
- Create: `server/tests/fixtures/plugins/games/cue-game/` (`manifest.json`, `plugin.py`) — a copy of `fast-timer-game` with name `cue-game`, `autonomous_seconds: 4`, `driver_seconds: 10`, and the moments below
- Test: `server/tests/test_conformance.py` (or the file holding `_check_match_format` tests), `server/tests/test_event_router.py` (match-format), `server/tests/test_sample_cooperative_plugin.py`

**Interfaces:**
- Produces: `MatchFormatRead.moments: list[MomentRead]`, `MomentRead = {key: str, label: str, period: "autonomous" | "driver", at_remaining: int, until_remaining: int | None}` (missing plugin list → `[]`).
- Produces fixture `cue-game` moments: `[{"key": "driver_change", "label": "Driver change", "period": "driver", "at_remaining": 8, "until_remaining": 6}, {"key": "endgame", "label": "Endgame", "period": "driver", "at_remaining": 4}]`.
- Sample and existing fixtures declare `{"key": "driver_change", "label": "Driver change", "period": "driver", "at_remaining": 35, "until_remaining": 25}` (only where `driver_seconds > 35`).

- [ ] **Step 1: Failing tests.** Conformance passes a valid list and a missing list; fails, with the moment's key in the message, for each of: not a list; entry not a dict; unknown key; missing `label`; duplicate `key`; `period` not autonomous/driver; `at_remaining` 0, equal to the period length, or not an int (incl. `True`); `until_remaining` ≥ `at_remaining` or negative. `GET /api/event/match-format` returns `moments` equal to the plugin's list (with `until_remaining: null` filled for instants) and `[]` for a plugin without one. `tm test-plugin` on `sample_cooperative` and `cue-game` passes.
- [ ] **Step 2:** `cd server && .venv/bin/python -m pytest tests -k "moment or match_format" -q` → FAIL.
- [ ] **Step 3:** Implement the check inside `_check_match_format` (same `CheckResult("match_format() shape", False, msg)` style), the schema field, and the router mapping; add the plugin moments and the `cue-game` fixture.
- [ ] **Step 4:** same command → PASS; then the full server suite.
- [ ] **Step 5:** Commit.

### Task 2: How a timer stopped (`ended_early`)

**Files:**
- Modify: `server/src/tournament_server/models/match.py`, the skills timer/run models (`SkillsSetTimer`, `SkillsRun`), baseline migration
- Modify: `server/src/tournament_server/routers/matches.py` (`end_match`, `reset_match`, start, the `match_phase_changed` payloads), `server/src/tournament_server/schemas/match.py` (`MatchRead`)
- Modify: `server/src/tournament_server/services/skills_runs.py` (`TimerState`, `timer_state`, `_copy_state`, `_apply_action`), `server/src/tournament_server/schemas/skills_run.py` (`SkillsRunRead`, `SkillsSetTimerRead`)
- Test: `server/tests/test_match_control*.py` / `test_skills_runs*.py` (where the existing end/reset tests live)

**Interfaces:**
- Produces: `Match.ended_early: bool` (default False) → `MatchRead.ended_early` and every `match_phase_changed` payload gains `"ended_early"`. True only after `POST /matches/{id}/end`; cleared by start and by both reset scopes; the auto-advance to `ended` leaves it False.
- Produces: `SkillsSetTimer.ended_early`, `SkillsRun.ended_early` (default False); `TimerState` gains `ended_early: bool`; `SkillsSetTimerRead.ended_early` and `SkillsRunRead.ended_early`. END sets True; START and RESET clear; a running timer read past its deadline reads `ENDED` with `ended_early=False`. A run that copies the set timer's state copies the flag.
- Device/shared TypeScript types `LiveMatch.ended_early: boolean`, skills timer types `ended_early: boolean` (Task 4 consumes).

- [ ] **Step 1: Failing tests.** End a running match → `ended_early` true in the response, in `GET` matches, and in the broadcast payload. A match left to run out (use `fast-timer-game`) → `ended`, `ended_early` false. End during `awaiting_driver` → true. Start after reset → false. Skills: END on set timer and on a field's own timer → true; deadline passed → `ended` with false; RESET → false; field timer taking over from an ended-early set timer carries true.
- [ ] **Step 2:** run them → FAIL.
- [ ] **Step 3:** Implement; edit the baseline migration (`server_default=sa.false()`, not null) for `matches`, `skills_set_timers`, `skills_runs`.
- [ ] **Step 4:** targeted tests → PASS; `tests/test_alembic_drift.py` → PASS; full server suite.
- [ ] **Step 5:** Commit.

### Task 3: Event sounds — store, API, bundled defaults

**Files:**
- Create: `server/src/tournament_server/default_sounds/{beep,start,buzzer,moment,stop}.mp3` and `server/src/tournament_server/default_sounds/CREDITS.md`
- Create: `server/src/tournament_server/models/event_sound.py`, `server/src/tournament_server/schemas/event_sound.py`, `server/src/tournament_server/services/event_sounds.py`, `server/src/tournament_server/routers/event_sounds.py`; register the router in `app.py`; model import wherever models are collected
- Modify: `server/pyproject.toml` (`[tool.setuptools.package-data]` add `"tournament_server" = ["default_sounds/*.mp3", "default_sounds/CREDITS.md"]`), baseline migration, `server/src/tournament_server/audit.py` (`_to_jsonable`)
- Test: `server/tests/test_event_sounds.py`

**Interfaces:**
- Produces: table `event_sounds` (`id`, `slot` unique String(20), `filename` String(200), `content_type` String(50), `data` LargeBinary, `uploaded_at` UTCDateTime).
- Produces API (all under `/api/sounds`):
  - `GET /api/sounds` (any role) → `[{slot, replaced: bool, filename: str | null, uploaded_at: str | null}]` in slot order `beep, start, buzzer, moment, stop`.
  - `GET /api/sounds/{slot}/audio` (any role, including paired displays) → the upload's bytes with its content type, else the bundled default (`audio/mpeg`); `Cache-Control: no-cache`. 404 for an unknown slot.
  - `PUT /api/sounds/{slot}` (admin, multipart `file`) → the slot's row as in the list; replaces any earlier upload. 422 (message names the limit) when: over 1,048,576 bytes; empty; not MP3/OGG/WAV by leading bytes (`ID3` or an MPEG frame sync `0xFF 0xE0` mask → `audio/mpeg`; `OggS` → `audio/ogg`; `RIFF....WAVE` → `audio/wav`). 404 for an unknown slot.
  - `GET /api/sounds/{slot}/audio?default=1` → always the bundled file (the TVs' fallback when an upload won't decode).
  - `DELETE /api/sounds/{slot}` (admin) → 204; restoring a default slot is a no-op 204.
  - Every PUT/DELETE broadcasts `broadcast_all(app, "sounds_changed", {"slot": slot})`.
- `_to_jsonable(bytes)` → `f"<{len(value)} bytes>"`.

- [ ] **Step 1: Sound files.** Download each Freesound HQ preview (`https://cdn.freesound.org/previews/<first 3 digits>/<id>_<user id>-hq.mp3`; find the exact URL as the `data-mp3` attribute on `https://freesound.org/s/<id>/`, swapping `-lq` for `-hq`), trim leading silence if any (ffmpeg if available, else leave), save under the slot names. Confirm the CC0 licence link on each page. Write `CREDITS.md`: a table of file, Freesound id, page URL, title, author, licence "CC0 1.0", checked 2026-11-23, plus one line that CC0 needs no credit and this is a courtesy record.
- [ ] **Step 2: Failing tests.** List shows five defaults; audio of a default slot returns the bundled bytes; `?default=1` on a replaced slot returns the bundled bytes; PUT each type (tiny valid MP3/OGG/WAV byte fixtures built in the test) → list shows `replaced`, filename; audio returns the upload; second PUT replaces; DELETE → default again; 422 for too big, empty, text file named `.mp3`; 404 unknown slot; 403 for a non-admin PUT/DELETE; a paired display can GET audio; `sounds_changed` broadcast on PUT and DELETE (use the existing realtime test helper); the audit row for the insert holds `"<N bytes>"`, not the data.
- [ ] **Step 3:** run → FAIL. **Step 4:** implement. **Step 5:** run → PASS; drift test; full suite; check `python -m build`-free: `importlib.resources.files("tournament_server") / "default_sounds" / "beep.mp3"` exists from an installed package (`pip install -e` already in `.venv` is enough to assert the path resolves).
- [ ] **Step 6:** Commit.

### Task 4: Per-TV sound switch (server)

**Files:**
- Modify: `server/src/tournament_server/models/device.py` (`Device.play_sounds: bool`, default False), `models/display.py` (remove `DisplayGroup.play_sounds`), baseline migration
- Modify: `server/src/tournament_server/routers/devices.py` (`PATCH /api/devices/{device_id}` accepts `play_sounds`), `schemas/device.py` (`DeviceRead.play_sounds`, the PATCH body)
- Modify: `server/src/tournament_server/routers/displays.py`, `schemas/display.py`, `services/displays.py` (drop group `play_sounds` from reads, PATCH, allowed fields, copy-spots; `DisplayMe.device.play_sounds`; new bulk endpoint)
- Test: the existing devices/displays router tests (update every `play_sounds` group case), plus new cases

**Interfaces:**
- Produces: `PATCH /api/devices/{id}` `{play_sounds: bool}` (admin) — 422 "Only TVs play sounds." for a non-display device; sends `display_changed` to that device so its `/api/displays/me` refreshes.
- Produces: `GET /api/displays/me` → `device: {id, name, play_sounds}`; `GET /api/devices` rows carry `play_sounds`.
- Produces: `PUT /api/displays/field-sets/{field_set_id}/sounds` `{play_sounds: bool}` (admin) → `{device_ids: number[]}` — every device assigned, in the field set's session, to that set's audience group or one of its fields' groups, set to the value; `display_changed` to each. 404 unknown field set.
- Removes: `play_sounds` from `DisplayGroupRead`, the group PATCH body (now 422 as an unknown field, like other disallowed fields) and copy-spots.

- [ ] **Step 1: Failing tests:** PATCH a display's `play_sounds` → reflected in `/api/devices` and in that device's `/api/displays/me`; PATCH a scorer device → 422; field-set bulk on → all audience + field-group TVs of that set on, a TV in another set untouched, a pit TV untouched; bulk off; group PATCH with `play_sounds` → 422; copy-spots no longer mentions it.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS; drift test; full server suite (fix every test that used group `play_sounds`).
- [ ] **Step 5:** Commit.

### Task 5: Cue engine in the shared package (pure function + server clock)

**Files:**
- Create: `frontend/packages/shared/src/cues/cues.ts`, export it from the shared package index
- Move: `frontend/apps/device/src/display/serverClock.ts` → `frontend/packages/shared/src/cues/serverClock.ts` (unchanged API: `measureOffset`, `useServerClockOffset`, `ServerClockContext`, `useServerNow`, `RESYNC_MS`); device imports updated
- Delete: `frontend/apps/device/src/display/logic/sounds.ts`, `frontend/apps/device/src/display/logic/driverChange.ts` (`InMatchView` uses `activeWindow`; keep its period-line behaviour otherwise)
- Modify: `frontend/apps/device/src/display/api.ts` (`MatchFormat.moments: Moment[]`), shared `LiveMatch` and skills timer types (`ended_early: boolean`)
- Test: `frontend/packages/shared/tests/cues.test.ts` (or the shared package's test location; if it has none, `frontend/apps/device/tests/unit/cues.test.ts` importing from `@tournament-admin/shared`); move `serverClock.test.ts` alongside

**Interfaces:**
- Produces (from `@tournament-admin/shared`):
  ```ts
  export type SoundSlot = "beep" | "start" | "buzzer" | "moment" | "stop";
  export const SOUND_SLOTS: readonly SoundSlot[]; // ["beep","start","buzzer","moment","stop"]
  export interface Moment { key: string; label: string; period: "autonomous" | "driver"; at_remaining: number; until_remaining: number | null }
  export type FlashKind = "moment" | "over" | "stop";
  export interface Cue { sound: SoundSlot | null; flash: { kind: FlashKind; label: string | null } | null }
  // label null = the screen's own text (MATCH OVER / TIME / MATCH STOPPED / STOPPED)
  export interface MatchReading { matchId: number; phase: string; whole: number; paused: boolean; endedEarly: boolean }
  export interface SkillsReading { timerKey: string; phase: "ready" | "running" | "ended"; whole: number; paused: boolean; endedEarly: boolean }
  export function matchCues(prev: MatchReading | null, next: MatchReading | null, moments: readonly Moment[]): Cue[];
  export function skillsCues(prev: SkillsReading | null, next: SkillsReading | null): Cue[];
  export function timeoutCues(prevRemaining: number | null, nextRemaining: number | null): Cue[]; // [{sound:"moment", flash:null}] on run-out
  export function activeWindow(phase: string, remaining: number, moments: readonly Moment[]): Moment | null;
  ```
  `whole` = whole seconds left, ceiling (as `AudienceSounds` computes today). A changed `matchId`/`timerKey` treats `prev` as not started (as today); `prev === null` → `[]`.

- [ ] **Step 1: Failing tests**, each asserting the exact `Cue[]`:
  - count-in beat per whole second in `countdown_*` → `beep`, no flash; entering `autonomous` and `driver` → `start`.
  - `whole` crossing to 3, 2, 1 inside `autonomous`/`driver` → one `beep` each; nothing at 30.
  - `driver` → `ended` with `endedEarly:false` → `buzzer` + `{over, null}`; with `endedEarly:true` → `stop` + `{stop, null}` and no buzzer (Review Focus 1: also with a reading at `whole: 1` before the run-out end, and at `whole: 0` before an early end — the result depends only on `endedEarly`).
  - any live phase (`countdown_*`, `autonomous`, `awaiting_driver`, `countdown_driver`, `driver`, paused or not) → `not_started`, and `driver`/`countdown_driver` → `awaiting_driver` (section reset) → `stop` + `{stop,null}`; `ended` → `not_started` → `[]`.
  - moment crossing `at_remaining` in its period → `moment` + `{moment, "Driver change"}`; crossing `until_remaining` → the same again; a jump 9 → 2 with the cue-game moments yields, in order, driver_change open, close, endgame, then beeps for 3 and 2 (Review Focus 3).
  - paused readings and pause/resume transitions → `[]`; first reading → `[]`.
  - skills: ready → running → `start`; 3/2/1 beeps; running → ended `endedEarly:false` → `buzzer` + `{over,null}`; `true` → `stop` + `{stop,null}`; running or paused → ready → `stop` + `{stop,null}`; ended → ready → `[]` (Review Focus 2); changed `timerKey` with first reading ended → `[]`.
  - `activeWindow`: inside the window when `until < remaining <= at` in the window's period (today's 35 ≥ r > 25 rule), `null` for instants and outside.
- [ ] **Step 2:** run the test file → FAIL.
- [ ] **Step 3:** Implement. Crossing rule for a threshold `t` (a moment edge, or 3/2/1) in period `p`: it fires when `next` is in `p`, unpaused, `next.whole <= t`, and either `prev` was in `p` with `prev.whole > t`, or `prev` was not yet in `p` (its count-in or an earlier phase). Emit the cues of one transition in descending threshold order (moment cues before a beep at the same second). Move `serverClock.ts` and update imports.
- [ ] **Step 4:** → PASS; device unit suite; device and admin type-checks.
- [ ] **Step 5:** Commit.

### Task 6: Slot sound player, cue trigger hook, TVs play sound

**Files:**
- Create: `frontend/packages/shared/src/cues/soundPlayer.ts` (replaces `frontend/apps/device/src/display/soundPlayer.ts`), `frontend/packages/shared/src/cues/useCueTrigger.ts`
- Create: `frontend/apps/device/src/display/useCueStream.ts`
- Rewrite: `frontend/apps/device/src/display/AudienceSounds.tsx` → rename `TvSounds.tsx`
- Modify: `frontend/apps/device/src/display/api.ts` (`getAudio(path, token): Promise<ArrayBuffer>` beside `getJson`; `useEventSounds()` key `["sounds"]` on `GET /api/sounds`; `DisplayMe.device.play_sounds`; drop group `play_sounds`), `useLiveRefresh.ts` (`sounds_changed: ["sounds"]`), `GroupView.tsx` and `FieldDisplay.tsx`/skills displays as needed to mount `TvSounds` for every TV with `me.device.play_sounds` (not pit TVs)
- Test: `frontend/apps/device/tests/unit/sounds.test.tsx` (rewrite), shared player tests beside `cues.test.ts`

**Interfaces:**
- Consumes: Task 5; Task 3 API; Task 4 `device.play_sounds`.
- Produces (shared):
  ```ts
  export class SoundPlayer {
    constructor(load: (slot: SoundSlot, useDefault: boolean) => Promise<ArrayBuffer>, create?: () => AudioContext);
    get blocked(): boolean; unlock(): Promise<void>; close(): void;
    reload(slot: SoundSlot): void;   // drops the cached buffer; next play/preload re-fetches
    preload(): Promise<void>;        // all five
    play(slot: SoundSlot): void;     // starts at once if decoded, stops at 10 s, dispatches window CustomEvent("tv-cue", {detail:{slot}})
  }
  export function useCueTrigger<R>(reading: R | null, compute: (prev: R | null, next: R | null) => Cue[], onCues: (cues: Cue[]) => void): void;
  // keeps the previous reading in a ref; first reading never triggers
  ```
  `load(slot, false)` fetches `/api/sounds/{slot}/audio`; on fetch or decode failure the player retries once with `load(slot, true)` → `?default=1` (Review Focus 4).
- Produces (device) `useCueStream.ts`: `useMatchReading(sessionId: number, fieldIds: readonly number[]): MatchReading | null`, `useSkillsReading(timer: SkillsTimerLike | null, timerKey: string): SkillsReading | null`, using `useServerNow(100)` so cues land within 0.1 s of the server-time crossing.
- `useCueStream.ts` also exports `type Follows =` the union below and `useFollowedCues(sessionId, follows, onCues)` (reading + compute + `useCueTrigger`), shared by `TvSounds` and Task 7's `CueFlash`.
- `TvSounds({sessionId, follows})` where `follows` is `{kind:"fieldSet", fieldSetId, timeoutDeadline}` | `{kind:"field", fieldId}` | `{kind:"skillsSet", fieldSetId}` | `{kind:"skillsField", fieldSetId, fieldId}`; plays `cue.sound` for each cue; shows the enable-sound note while blocked.

- [ ] **Step 1: Failing tests:** player plays the decoded buffer through a fake `AudioContext` (source `start` called, `stop` at +10 s); dispatches `tv-cue`; `reload` re-fetches; a failing decode falls back to the default and other slots are unaffected; `TvSounds` plays `start` when a fake match goes countdown → autonomous, plays `stop` for an `ended_early` end, plays `buzzer` for a skills set run-out; a TV with `play_sounds: false` mounts no player; a pit TV never does; `sounds_changed` reloads that slot; the enable-sound note shows while blocked.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS; device unit suite; type-checks.
- [ ] **Step 5:** Commit.

### Task 7: Flash overlay, window tag, wiring

**Files:**
- Create: `frontend/apps/device/src/display/components/CueFlash.tsx`
- Modify: `components/InMatchView.tsx` (window tag via `activeWindow`, label from the moment), `components/DriverChangeTag.tsx` → `components/WindowTag.tsx` (`{label}`, `data-testid="window-tag"`; update `frontend/apps/admin/tests/e2e/fixtures/tvFits.ts`), `FieldDisplay.tsx`, `GroupView.tsx` (audience `in_match` screen), `SkillsSetDisplay.tsx`, `SkillsFieldDisplay.tsx`
- Modify: `frontend/apps/device/src/styles/display.css`, `frontend/apps/device/src/i18n/{en,zh}/device.json`
- Test: `frontend/apps/device/tests/unit/cueFlash.test.tsx`; update `fieldDisplay.test.tsx` driver-change cases to come from format moments

**Interfaces:**
- Consumes: Task 5 `activeWindow`, `matchCues`, `skillsCues`; Task 6 `useCueTrigger`, `useMatchReading`, `useSkillsReading`; Task 2 `ended_early`.
- Produces: `CueFlash({ sessionId, follows }: { sessionId: number; follows: Follows })` (the Task 6 `Follows` type; `skillsSet`/`skillsField` use the skills banner texts) rendering, while a flash is active, `<div class="cue-flash cue-flash--{kind}" data-testid="cue-flash" data-kind={kind}>` with a fixed full-viewport border layer and a `.cue-flash__banner` over the bottom bar's box (`7.5vw` high at the bottom, matching `.in-match .bottom-bar`), text = label or `t("display.cue.matchOver" | "display.cue.time" | "display.cue.matchStopped" | "display.cue.stopped")`. A new flash replaces the current one. Mounted at GroupView/FieldDisplay level so it survives the screen changing under it after a reset. Flashes do not depend on the TV's sound switch.
- i18n (en / zh): `display.cue.matchOver` "MATCH OVER" / "比赛结束"; `display.cue.matchStopped` "MATCH STOPPED" / "比赛中止"; `display.cue.time` "TIME" / "时间到"; `display.cue.stopped` "STOPPED" / "已中止". Remove `display.driverChange` (now plugin text).
- Where mounted: audience group whose screen is `in_match` (match); field group via `FieldDisplay` (match); skills audience via `SkillsSetDisplay` (skills, set timer); skills field via `SkillsFieldDisplay` (skills, the run's effective timer, timerKey = run id or `"none"`).

- [ ] **Step 1: Failing tests:** each flash kind renders with its class and text (en and zh); banner gone after ~2 s, border after ~1.5 s (fake timers); a reset while live keeps the red banner visible after the in-match view unmounts; window tag shows the moment label inside the window, the period line outside, Paused over it when paused; field TV and skills field TV render the flash; no flash for count-in/start/beeps/time-out.
- [ ] **Step 2:** → FAIL. **Step 3:** implement; CSS keyframes per the spec envelope; `.cue-flash` `pointer-events: none`, above the screen.
- [ ] **Step 4:** → PASS; device unit suite; type-check.
- [ ] **Step 5:** Commit.

### Task 8: Operator computers play sounds

**Files:**
- Create: `frontend/apps/admin/src/cues/OperatorSounds.tsx`, `frontend/apps/admin/src/cues/useOperatorSoundSetting.ts`
- Modify: `frontend/apps/admin/src/routes/MatchControlRoute.tsx`, `frontend/apps/admin/src/routes/SkillsControlRoute.tsx`, the admin app root (wrap in `ServerClockContext` with `useServerClockOffset`, measured once on load and on socket reconnect, as the device does), admin `en`/`zh` files
- Test: `frontend/apps/admin/tests/unit/OperatorSounds.test.tsx`, update `MatchControlRoute.test.tsx`

**Interfaces:**
- Consumes: Task 5/6 shared `SoundPlayer`, `useCueTrigger`, `matchCues`, `skillsCues`, `timeoutCues`, `useServerNow(100)`; Task 3 audio endpoint (admin token); Task 2 `ended_early`; match format `moments`.
- Produces: `useOperatorSoundSetting(page: "matchControl" | "skillsControl"): [boolean, (on: boolean) => void]` backed by `localStorage` key `tm.operatorSounds.<page>` (wrapped in try/catch; default false). `OperatorSounds` plays, for Match Control, the cues of the running match on the page's field set plus its time-out end; for Skills Control, the cues of the set timer shown. No flashes. Shows "Click to enable sound" if the browser blocks audio.
- UI: a switch "Play sounds on this computer" / "在此电脑上播放声音" on both pages, near the timer controls.

- [ ] **Step 1: Failing tests:** switch off by default; turning it on persists across remount; with it on, a fake match going countdown → autonomous plays `start`; an `ended_early` end plays `stop`; Skills Control plays `buzzer` on set-timer run-out; with it off nothing plays; localStorage throwing still renders.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS; admin unit suite; type-check.
- [ ] **Step 5:** Commit.

### Task 9: Admin — Sounds panel, per-TV switch, field-set switch

**Files:**
- Create: `frontend/apps/admin/src/devices/SoundsSection.tsx`, `frontend/apps/admin/src/devices/useEventSounds.ts`
- Modify: `frontend/apps/admin/src/routes/DevicesDisplaysRoute.tsx` (Sounds `<section className="panel" aria-labelledby="sounds-heading">` after the TVs panel), `frontend/apps/admin/src/devices/DisplaysTable.tsx` (a Sound switch per TV row → `PATCH /api/devices/{id}`), `frontend/apps/admin/src/routes/MatchControlRoute.tsx` + `matchControl/useMatchControl.ts` (replace the group "Play sounds" switch with "TVs play sounds" → `PUT /api/displays/field-sets/{id}/sounds`; checked when every TV assigned to the set's audience and field groups has `play_sounds`), `devices/SpotsSection.tsx` and `displays/useDisplays.ts` (drop group `play_sounds`), admin `en`/`zh` files
- Test: `frontend/apps/admin/tests/unit/SoundsSection.test.tsx`, update `DevicesDisplaysRoute.test.tsx`, `MatchControlRoute.test.tsx`, `PairDeviceForm.test.tsx` where they use group `play_sounds`

**Interfaces:**
- Consumes: Task 3 and Task 4 APIs.
- Sounds panel: heading "Sounds" / "声音"; one row per slot with name and when it plays:
  - beep "Beep" / "提示音" — "Count-in and last 3 seconds" / "倒数和最后3秒"
  - start "Start" / "开始" — "Match start and driver start" / "比赛开始和手动阶段开始"
  - buzzer "Buzzer" / "蜂鸣器" — "Time runs out" / "时间用完"
  - moment "Ding" / "叮" — "Game moments and time-out end" / "比赛时刻和暂停结束"
  - stop "Stop" / "停止" — "Ended early or reset" / "提前结束或重置"

  Each row: play button (fetches `/api/sounds/{slot}/audio`, plays it), current file name or "Default" / "默认", **Upload** (file input `accept="audio/mpeg,audio/ogg,audio/wav,.mp3,.ogg,.wav"`), **Restore default** / "恢复默认" only when replaced. Before upload the page decodes the file (`AudioContext.decodeAudioData`) and refuses over 10 s with "This sound is longer than 10 seconds." / "此声音超过10秒。"; over 1 MB with "This file is larger than 1 MB." / "此文件超过1 MB。"; server 422 messages shown as returned. Note under the list: "Only upload sounds you have the rights to use." / "请只上传您有权使用的声音。"
- TV row switch label "Sound" / "声音"; Match Control switch "TVs play sounds" / "电视播放声音".
- [ ] **Step 1: Failing tests:** Sounds rows render with Default; upload calls PUT and shows the filename; >10 s and >1 MB refused without a request; restore calls DELETE; the TV row switch PATCHes the device; Match Control's switch PUTs the field-set endpoint and reflects all-on; zh labels.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS; admin unit suite; type-check.
- [ ] **Step 5:** Commit.

### Task 10: End-to-end

**Files:**
- Modify: `frontend/apps/admin/tests/e2e/fixtures/buildPluginZip.ts` (`buildCueGamePluginZip()` for the Task 1 fixture, manifest.json + plugin.py only)
- Create: `frontend/apps/admin/tests/e2e/tvCues.spec.ts`
- Modify: `frontend/apps/admin/tests/e2e/displays.spec.ts` (Sounds panel, TV switch), existing specs that toggled group Play sounds

**Interfaces:** Consumes everything above. Sound assertions use `page.addInitScript` to collect `tv-cue` events into `window.__cues` and stub `AudioContext` to a running state (headless has no audio output); assert on `__cues`, never on audio.

- [ ] **Step 1: Write `tvCues.spec.ts`** (isolated server, `cue-game` plugin; an audience TV with its Sound switch on showing In Match; a field TV with sound off), tests:
  - a full match (start, wait out autonomous, `start-driver`, wait out driver): the audience TV's `__cues` holds `beep`×3, `start`, `beep`×3, `beep`×3, `start`, `moment`×2, `moment`, `beep`×3, `buzzer` in that order; flashes seen: amber "DRIVER CHANGE" banner and window tag, amber "ENDGAME", white "MATCH OVER"; the field TV shows the same flashes and its `__cues` stays empty; turning the field TV's switch on (admin API) makes it cue on the next match.
  - end early in driver with time left → `stop`, red "MATCH STOPPED", no `buzzer`.
  - full reset during autonomous → `stop` and red flash, then the TV's pre-match view.
  - flash never overlaps the clock or team bands (bounding boxes, 1280×720 and 1920×1080).
  - skills set (skills field set, audience TV with sound on, a field TV): start → `start`; run out → `buzzer` + white "TIME"; start then end → `stop` + red "STOPPED"; reset an ended timer → no cue.
  - zh: one red banner reads "比赛中止".
  - organiser upload: PUT a WAV to `start` via API while a TV is open; the next start fetches `/api/sounds/start/audio` again (observe the request) without a page reload.
  - Match Control "Play sounds on this computer": on, start a match → the admin page's `__cues` gets `start`; reload → still on; off → nothing.
- [ ] **Step 2: `displays.spec.ts`:** upload a WAV in the Sounds panel → filename shows; play button requests the audio; Restore default → "Default"; the TV row Sound switch persists after reload.
- [ ] **Step 3:** `cd frontend/apps/admin && npx playwright test tvCues displays tvScreens tvScreensCooperative tvBracket liveScoring skillsChallenges` → all PASS (fix specs that used group Play sounds).
- [ ] **Step 4:** Full suites: server, device unit, admin unit, type-checks.
- [ ] **Step 5:** Commit.
