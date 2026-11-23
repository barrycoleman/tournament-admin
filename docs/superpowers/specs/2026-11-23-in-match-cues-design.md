# In-Match Cues — Design

**Status:** draft for owner review, 2026-11-23
**Builds on:** display groups (`2026-10-15-display-groups-design.md`, §6.5 Sounds), live scoring and skills timers (`2026-10-19-live-scoring-design.md`), TV readability (`2026-11-14-tv-readability-design.md`, the driver-change tag).

## 1. Why

People around a field watch the robots, not the TV. They need to hear and catch out of the corner of an eye the moments that matter: the count-in, the start, the last seconds of a section, a driver change, the end, and a match the timer operator stops. Today the TVs play plain single-pitch tones the browser makes, at a different set of moments (including a 30-seconds-left warning nobody asked for), and only the driver-change tag gives a visual cue, at a window fixed in the TV code. Games change every season, so the moments a game cares about (a driver change, an endgame) belong to the game plugin, not to the TV app.

## 2. Goals

1. Real recorded sounds, all public domain (CC0), for a fixed set of cue moments, on head-to-head matches and on skills runs.
2. Game plugins name their own in-match moments (instants or windows) in match data; the driver-change window moves there.
3. A visual flash on the TV for game moments, for the match running out, and for a match the timer operator ends early or resets.
4. The five sounds are defaults; an event organiser can replace any of them with an upload of their own and restore the default later.

## 3. Non-goals

- A volume setting, or different sounds per field set or per TV (one sound per slot per event).
- Editing or trimming audio in the app.
- Game plugins shipping their own sound files.
- Plugin-defined moments in skills runs (skills get only the standard cues this round).
- Sounds on field-group TVs (see §5.4).
- Referee violation indicators, awards reveal, inspections.

## 4. Anti-goals

- **Never cover the timer.** A flash must not hide the clock, the team numbers or the scores.
- **Never mistake an early stop for a normal finish** (or the reverse). A match the operator stopped must not play the buzzer or show MATCH OVER; a match that ran out must not play the stop sound or show MATCH STOPPED — including on a TV whose clock is a little off the server's.
- **No cue on a TV turned on mid-match.** As today, the first reading after a TV loads or switches screens is silent and does not flash.
- **No unlicensed audio in the repo.** Every sound file has its source page, author and CC0 licence recorded.

## 5. Behaviour

### 5.1 Sounds (owner's choices)

| Moment | Sound | Freesound |
|---|---|---|
| Each count-in second (before autonomous, before driver control) | Beep — jeckkech | 391650 |
| Start of autonomous; start of driver control; start of a skills run | Ta-da fanfare — plasterbrain ("Tada Fanfare A") | 397355 |
| Each of the last 3 seconds of a section (autonomous, driver, skills run) | Beep — jeckkech | 391650 |
| Match or skills run runs out | Buzzer — guitarguy1985 ("buzzer.wav") | 54047 |
| A game moment fires; a window opens; a window closes | Ding — D.S.G. ("Ding 1") | 241288 |
| A time-out runs out | Ding — D.S.G. | 241288 |
| Timer operator ends the match/run early, or resets it while it is live | Power down — noirenex | 159399 |

All five were confirmed CC0 1.0 on their Freesound pages (`https://freesound.org/s/<id>/`) on 2026-11-23.

- The last-3-seconds beeps play at 3, 2 and 1 seconds remaining in the section. The section ending itself plays no separate sound: autonomous's end flows into the driver count-in beeps; driver's end is the buzzer.
- The 30-seconds-left warning, the "period end" tone and the browser-generated tones go away.
- **Silent:** pause, resume, and a reset or end that touches a timer that isn't live (not started, ready, or already ended). Resetting a finished skills timer for the next team must not play the power-down.
- "Live" means, for a match, started and not yet ended: a count-in, a section, or waiting for driver control (`awaiting_driver`), running or paused; for a skills timer, running or paused. Ending or resetting a match while it waits for driver control is a stop. A section reset (driver section back to awaiting driver) counts as a reset of a live match; its red flash shows over the awaiting-driver layout, since the TV stays on the in-match view.
- A match that is ended early plays only the power-down, never the buzzer.

### 5.2 Game moments (plugin data)

`match_format()` gains an optional `moments` list (missing = none). Each entry:

| Key | Meaning |
|---|---|
| `key` | identifier, unique within the list |
| `label` | text shown on the TV banner and tag, e.g. "Driver change" (shown as given, upper-cased by CSS; plugin text is not translated, like skills type labels) |
| `period` | `"autonomous"` or `"driver"` |
| `at_remaining` | whole seconds left in that period when the moment fires |
| `until_remaining` | optional; whole seconds left when it ends. Present = a window |

- Conformance (`tm test-plugin`): `moments` is a list of dicts with exactly these keys (`until_remaining` optional); keys unique; `period` valid; `0 < at_remaining < that period's seconds`; if present, `0 <= until_remaining < at_remaining`. Each failure names the moment.
- The sample game plugin declares `{"key": "driver_change", "label": "Driver change", "period": "driver", "at_remaining": 35, "until_remaining": 25}`. `DRIVER_CHANGE_STARTS_AT`/`ENDS_AT` and their "driver period longer than 35 s" rule in the device's `logic/driverChange.ts` go away; the conformance rule replaces the length guard.
- A moment fires when the clock crosses `at_remaining` in its period (and, for a window, again when it crosses `until_remaining`). Ding plus amber flash each time.
- The existing driver-change tag under the timer generalises: while inside any window, the in-match screen shows that window's label as the tag (the tag style stays). A TV that loads mid-window shows the tag but plays nothing.

### 5.3 Flashes (owner's choices, from mockups)

A flash is two things together, on the screen showing the running timer:

- **Border:** a thick inset frame around the whole screen pulses twice (about 1.5 s).
- **Banner:** a solid band naming the moment covers the bottom bar (the "QUALIFICATION 7 · SHARKS" line) for about 2 s, then the bottom bar returns.

| Moment | Colour | Banner text |
|---|---|---|
| Game moment (window open, window close, instant) | amber (`--kiosk-soon`), dark text | the moment's label |
| Match runs out | white (`--kiosk-ink`), dark text | MATCH OVER |
| Skills run runs out | white, dark text | TIME |
| Ended early or reset while live (match or skills) | red (`--kiosk-late`), white text | MATCH STOPPED (skills: STOPPED) |

- Nothing else flashes: no flash for count-in, starts, last-3-seconds or time-outs.
- The timer, team bands, period label and scores are never covered.
- Flashes show on every TV showing a running timer: audience TVs on the in-match screen, head-to-head field TVs (they draw the same in-match view), and skills field-set and field TVs. They do not depend on the Play sounds switch.
- Reset sends the TV back to its pre-match screen; the red flash shows first, at least long enough to read (builder's call how).
- New user-facing strings (MATCH OVER, MATCH STOPPED, TIME, STOPPED) in en and zh.

### 5.4 Where sound plays

- Unchanged rule: only TVs whose audience group has **Play sounds** on, whatever screen they show; the "Click to enable sound" note stays. This now covers skills field sets' audience groups too, cueing from the set's timer.
- Field-group TVs never play sound (a row of ten skills fields must not become ten overlapping beeps).

### 5.5 Skills runs

Skills timers have no count-in and one section of the type's `run_seconds`. Cues: fanfare on start, beeps at 3/2/1, buzzer + white TIME flash when it runs out, power-down + red STOPPED flash when ended early or reset while live. A field running its own timer (off the set timer) cues on its own field TV (flash only; sound only via a Play-sounds audience group, which follows the set timer).

## 6. Sound files

- Stored in the device app as static assets with a `CREDITS.md` (or similar) beside them listing, per file: our filename, Freesound id and page URL, title, author, licence (CC0 1.0) and the date checked. **Builder's call** on folder and format.
- **My call:** use Freesound's high-quality MP3 previews (128 kbps), which are public without a login and are copies of the same CC0 works; if the owner later downloads the originals, swap them in. Trim leading silence if any, so cues land on the second; keep each file small.
- Playback through Web Audio (decoded buffers) so a cue starts on time and two cues can overlap; preload all five on TV start.

## 6a. Organiser sounds

**Slots.** Five fixed slots, one per sound in §5.1: `beep`, `start`, `buzzer`, `moment` (the ding, also the time-out end), `stop`. Each plays the shipped default unless the event has an upload for it.

**Admin.** A **Sounds** section on the Displays page (admin only), one row per slot: the slot's name and when it plays (e.g. "Match start and driver start"), a play button that plays the current sound in the browser, the current file's name or "Default", **Upload**, and **Restore default** (only when replaced). Under the list, one line: the organiser must hold the rights to any sound they upload. All new strings in en and zh.

**Limits (my calls).** MP3, OGG or WAV; at most 1 MB and 10 seconds; the server checks type by content, not just the extension, and rejects with a message naming the limit. **My call on how the 10 seconds is enforced, with no new server dependency** (the common audio-tag library is GPL, which an MIT app must not bundle): the server checks size and type by the file's leading bytes; the admin page decodes the file in the browser before uploading and refuses one longer than 10 s with a message; and TVs stop any cue at 10 s, so a long file that slips past (e.g. uploaded through the API directly) can never play longer. Upload replaces the slot's previous upload.

**Storage (my call).** Uploads live in the event's SQLite file (one row per replaced slot: slot, original filename, content type, bytes, uploaded_at), so a copied or backed-up event carries its sounds. Restore default deletes the row. Changes are audited like other admin settings.

**API (shape is the builder's call).** List the slots with whether each is replaced; upload to a slot (admin); restore a slot (admin); fetch a slot's current audio (what paired TVs and the admin play button load — a replaced slot serves the upload, a default slot may serve or point at the shipped file). Changing a slot sends a live event so open TVs reload that one sound without a page reload; a TV that fails to load an upload falls back to the default for that slot.

**Tests.** Server: upload (each accepted type), each rejection (too big, too long, not audio, wrong slot), restore, replace twice, audit row, live event, fetch for a paired display. Playwright: upload a sound to a slot and see "Default" change to the filename, play it, restore default; an open TV picks up the new sound without reload (asserted by the file it fetches).

## 7. Telling an early end from a normal one

The TV must not guess from its own clock reading at the moment the phase changes (anti-goal 4). **Builder's call** on mechanism; one acceptable shape is for the server to say how a match or skills timer ended (ran out vs. ended by the operator) and to mark a live reset, in what the TVs already receive, so every TV agrees. Whatever the shape, it needs server and API tests, and an E2E that ends a match early with time left and checks the stop sound and red flash, not the buzzer.

## 8. Testing

- Server/pytest: conformance for `moments` (valid, each invalid case, missing list); sample plugin passes; whatever §7 adds.
- Device unit: the cue rules as a pure function from (previous reading, next reading, moments) to cues and flashes — count-in beeps, starts, 3/2/1, moment open/close/instant, run-out, early end, live vs. non-live reset, pause silent, first reading silent, mid-window load shows tag but no cue; skills equivalents.
- Playwright: the in-match screen flashes and banner text for a game moment, a run-out and an early end (sound asserted by observing which cue the player was asked to play, not by audio); timer never covered (bounding boxes); skills field-set TV run-out and early end; zh strings.

## 9. Left to the builder

- Exact flash timing and easing within the ~1.5 s / ~2 s envelope.
- Where the cue rules live and how the in-match screen and skills screens share them.
- How the plugin's moments reach the TV (the TVs already read the match format).
- §6 folder/format, §6a API shape, and §7 mechanism.
