# Game Plugin Gating — Design

**Status:** approved in brainstorming 2026-10-11.

**Builds on:** the core architecture spec (`2026-08-28-core-server-plugin-architecture-design.md`), skills challenges (`2026-10-08-skills-challenges-design.md`) and awards (`2026-10-09-awards-design.md`).

## 1. Problem

A new event has no game plugin. Nothing in the admin app says so prominently. Plugin-dependent screens instead behave in confusing ways:

- The Skills settings switch is disabled.
- The Matches tab shows an ordinary empty state.
- Finalize qualification fails with a generic error.
- Rankings show empty tables.
- The award form offers sources that can never produce a winner.

An organizer reasonably misses that the game plugin must be chosen first.

The game plugin is also set-once today: `POST /api/event/game-plugin` returns 409 once a plugin is chosen. There is no way to change or clear it. A first choice made in a hurry, which a prominent banner encourages, cannot be undone.

## 2. Goals

- A new organizer cannot miss that a game plugin must be chosen. Every admin page says so until one is.
- Features that need a plugin are visibly unavailable. They explain why and link to the fix, instead of failing or looking empty.
- Roster setup stays open without a plugin: teams, divisions, sessions, check-in, fields, role passwords, server info and judged awards.
- The plugin can be changed or cleared until it is in use. After that it is locked, as safely as today.
- The award form offers only sources that can produce a winner in the event's current state.

### Non-goals

- Changing the plugin after play has started. Scores carry their own `plugin_name`/`plugin_version`, but mixed-plugin rankings would need their own design.
- Gating on the scheduler plugin.
- Hiding locked features. They stay visible with an explanation, except the Skills tab (§5.3).

## 3. Server

### 3.1 Choosing, changing and clearing the plugin

All of these are **admin-only**; any other role gets 403.

- **`POST /api/event/game-plugin`** with `{name}` chooses the plugin, or changes it.
  - Choosing the plugin that is already selected succeeds and changes nothing: no reset, no broadcast.
  - An unknown name gets 404, as today.
- **`DELETE /api/event/game-plugin`** clears the selection back to none.
- **Lock.** Changing to a different plugin, or clearing, is refused with 409 and the detail "The game plugin can't be changed after matches are scheduled or skills attempts are recorded." while the plugin is **in use**.
  - **In use** means at least one `Match` row exists or at least one `SkillsAttempt` row exists.
  - Scores and finals brackets cannot exist without matches, so they are covered.
  - Choosing a plugin when none is selected is never blocked.
- **`GET /api/event`** gains `game_plugin_locked: bool`, which is true exactly when the plugin is in use. A plugin cannot be in use without being selected, so this is false when none is selected.

### 3.2 Reset on change or clear

When the selected plugin actually changes (to another plugin, or to none), the same transaction:

- **Skills settings.** Sets the event's `skills_settings` row to `enabled = false` and `attempts = {}`, the defaults: off, 3 attempts per type. If no row exists, it stays absent.
- **Session overrides.** Sets every session's `skills_attempts` override to null.
- **Ranking settings.** Resets the event's `ranking_settings` row to the model defaults. If no row exists, it stays absent.
- **Awards.** Leaves awards untouched. An award whose `skills_type` the new plugin lacks shows the existing `unknown_skills_type` note. An award whose source is no longer available follows §6.2.

All changes commit together, or not at all.

### 3.3 Dry run

Both endpoints accept `?dry_run=true`. A dry run validates exactly as a real call does, including the 403, 404 and 409 checks, and writes nothing. It returns:

```json
{
  "would_reset": {
    "skills_enabled": true,
    "session_attempt_overrides": 2,
    "ranking_settings": true
  },
  "awards_needing_attention": [
    {"award_id": 7, "session_id": 1, "name": "Autonomous Skill Champion", "reason": "unknown_skills_type"}
  ]
}
```

- **`skills_enabled`:** true when skills are currently on.
- **`session_attempt_overrides`:** how many sessions have a non-null override.
- **`ranking_settings`:** true when a row exists and differs from the defaults.
- **`awards_needing_attention`:** every performance award that would be unavailable or broken under the target state, using the §6 availability rules and the `unknown_skills_type` check. Clearing the plugin makes every performance award unavailable.

The real (non-dry-run) call returns the updated `EventRead`.

### 3.4 Realtime

A real change broadcasts `game_plugin_changed` with `{"game_plugin_name": <name or null>}` to **every** connected socket: the active-session channel and every per-session channel. This needs a new `broadcast_all` helper in `realtime.py`.

No-op selections do not broadcast.

### 3.5 Award availability check

On `POST /api/sessions/{id}/awards`, and on `PATCH` when any rule field changes (the existing `RULE_FIELDS` set), the server applies the §6.1 availability rules after its existing `definition_error` validation.

- **Error codes.** A performance award that is unavailable gets 422 with one of these details:
  - "Performance awards need a game plugin."
  - "Event-wide performance awards come from skills challenges, which are off."
  - "Skills awards need skills challenges turned on."
- **Name-only edits.** A `PATCH` that changes no rule field is not checked.
- **Copy.** `POST …/awards/copy` copies awards as they are, without the check.

## 4. Banner

- **Who and where.** The banner shows for the **admin** role only. It appears on every page inside the app shell, directly under the header (where the transient error banner sits), while `event.game_plugin_name` is null.
- **Text.**
  - Message: "Choose a game plugin to set up scheduling, matches, rankings and skills."
  - Link: **Choose a game plugin**, to `/events/setup#game-plugins`.
- **Style.** Warning style (`alert alert-warning`), `role="status"`. It cannot be dismissed.
- **Event Setup.** The banner is not shown on Event Setup itself. The game plugin section carries its own message there.
- **Disappearing.** It disappears on every open admin page when `game_plugin_changed` arrives. The app shell subscribes to `/ws/active-session` for this (admins may use that channel). On that event it invalidates `["event"]`, the skills settings, ranking settings, match format and awards queries.

## 5. Locked screens

### 5.1 Shared check and panel

- **`useGamePlugin()`** returns `{ selected: boolean, locked: boolean, name: string | null, isLoading }`. It reads from the `["event"]` query. Every gated screen uses it.
- **`<NeedsGamePlugin />`** is the shared panel, with `alert alert-warning` styling.
  - **Admin:** "This needs a game plugin. Choose one in Event Setup." The link goes to `/events/setup#game-plugins`.
  - **Any other role:** "The organizer hasn't chosen a game plugin yet." It has no link.
- **Loading.** While the event is loading, gated screens show their normal loading state, not the panel.

### 5.2 Where it applies

- **Panel replaces the content** when no plugin is selected:
  - session Matches tab
  - session Rankings tab
  - season Rankings page (`/rankings`)
  - judge Session rankings (`/judge/rankings`)
  - the judge's `/rankings`
  - session Skills tab, if reached by URL (§5.3)
- **A smaller control locks instead:**
  - **Schedule tab:** keeps its readiness checklist. The game plugin item uses the shared wording and link.
  - **Finalize qualification:** the button is disabled, with a short reason under it ("Needs a game plugin.") instead of a generic error.
  - **Skills settings on Event Setup:** stay disabled, with the shared wording.
- **Unchanged:** dashboard, teams, divisions, sessions list and detail header, check-in, fields, role passwords, server info, and judged awards.

### 5.3 Skills tab

The Skills tab remains hidden unless skills challenges are on. Skills cannot be on without a plugin, so it is hidden with no plugin. If the URL is opened directly with no plugin, the route shows `<NeedsGamePlugin />` instead of "skills are off".

## 6. Award form

### 6.1 Availability rules

| State | Division-scope awards | Event-scope awards |
|---|---|---|
| No game plugin | Judged only | Judged only |
| Plugin, skills off | Judged; performance from Teamwork ranking or Finals | Judged only |
| Plugin, skills on | Judged; performance from all four sources | Judged; performance from Skills overall or a skills type |

- **Shared module.** One pure function, `availableSources(scope, { pluginSelected, skillsEnabled })`, holds the rules for the frontend. `allowedSources(scope)` in `awardForm.ts` is replaced by it. The server applies the same rules in `services/awards.py`.
- **Disabled Performance option.** When no performance source is available for the chosen scope, the Performance option is disabled, not hidden. It shows a one-line reason:
  - no plugin: "Needs a game plugin."
  - event scope with skills off: "Event-wide performance awards come from skills challenges, which are off."
- **Skills type list.** It comes from the selected plugin's skills types, as today.

### 6.2 Existing awards that no longer fit

- **On the list.** An existing award whose source is no longer available keeps showing its server note (`skills_disabled` / `unknown_skills_type`).
- **Opening it to edit.**
  - Its current kind and source stay selected and are marked "(not available)", so saving a name or description change sends no rule-field change and succeeds (§3.5).
  - Choosing a different available source drops the unavailable one from the list.
  - Saving a rule change to another unavailable value is refused by the server and shown as the form's error.

## 7. Event Setup

- **Order.** The game plugin section moves to the top, with anchor `id="game-plugins"`. It is followed by schedulers, ranking settings, skills settings and server info.
- **Game plugin section states:**

| State | Chosen plugin row | Other plugin rows | Section extras |
|---|---|---|---|
| None chosen | n/a | **Select** | Hint: "Choose the game first. Scheduling, matches, rankings and skills depend on it." |
| Chosen, not locked | **Selected** badge | **Switch to this** | **Clear selection** button |
| Chosen, locked | **Selected** badge | No button | Note: "Locked because matches are scheduled or skills attempts are recorded." |

- **Confirm dialog.** **Switch to this** and **Clear selection** run the dry run, then open a confirm dialog.
  - It lists what will reset: skills challenges turned off, N sessions' skills attempts, ranking settings.
  - It lists any awards needing attention, by session and name.
  - Its confirm button reads "Switch plugin" / "Clear plugin". Confirming makes the real call.
- **Errors.** Failures of select, switch or clear, including a 409 lock race, show `alert alert-danger` with the server detail. Today a failed select shows nothing.

## 8. Testing

### Server (pytest)

- **Choosing:**
  - choosing with none selected;
  - re-choosing the same plugin is a no-op (no reset, no broadcast);
  - an unknown name gets 404.
- **Changing and clearing:**
  - switching while unused resets skills settings, session overrides and ranking settings in one transaction;
  - clearing while unused does the same;
  - switching or clearing with a `Match` gets 409;
  - switching or clearing with a `SkillsAttempt` gets 409.
- **Roles:** every endpoint is 403 for each non-admin role.
- **Dry run:**
  - it reports `would_reset` and `awards_needing_attention` correctly;
  - it writes nothing;
  - it enforces the same 403, 404 and 409 checks.
- **`game_plugin_locked`:** reported correctly.
- **Broadcast:** `game_plugin_changed` reaches both an active-session socket and a per-session socket; no-op selections do not broadcast.
- **Award availability:**
  - create is refused for each unavailable case;
  - a rule-field `PATCH` is refused;
  - a name-only `PATCH` is allowed;
  - copy is unaffected.

### Admin unit (Vitest)

- `availableSources` for each row of §6.1.
- `useGamePlugin`.
- `<NeedsGamePlugin />` wording for admin and other roles.
- The banner is shown and hidden, including on Event Setup.
- Each locked screen and control.
- The award form:
  - the disabled Performance option and its reasons;
  - the "(not available)" edit case.
- The Event Setup section in all three states, including the confirm dialog content.

### Playwright

- **Fresh event, no plugin:**
  - the banner shows;
  - Matches and Rankings show the panel;
  - finalize is disabled;
  - the award form allows judged only.
- **Choosing a plugin** unlocks everything live, with no reload. A second open tab unlocks too.
- **Switching a plugin** while unused shows the confirm dialog with the reset list. After confirming, skills settings are off.
- **Locked plugin:** after a schedule is generated, the plugin section shows the locked note and no switch buttons.
- **Award sources:**
  - with skills off, the skills sources are absent and event-scope performance is disabled;
  - turning skills on makes them appear.
