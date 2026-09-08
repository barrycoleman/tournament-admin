# Scoring Device Admission — Design Spec

Status: approved for planning
Date: 2026-09-08

## 0. Project constraint

Nothing in this project's code, comments, documentation, file names, or
user-facing text may reference any real-world competition brand or product
name. All descriptions in this spec are written in neutral/generic terms
for that reason.

## 1. Purpose & scope

`docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md`
("the master spec") §4 designed two separate device concepts —
`Device` (Raspberry Pi / unattended kiosk displays, admin-driven) and
`ScoringDevice` (tablets/phones used for scoring, self-registering) — and
explicitly left open how either layers with the role-based auth system
built in `docs/superpowers/specs/2026-09-03-real-authentication-design.md`
("the auth spec"). The auth spec itself deferred this, saying only that a
later phase "can require a session's underlying device to *also* be
admitted, layered on top of the role check."

This spec is that later phase, scoped to `ScoringDevice` only.
`Device`/Pi-display admission is **not** built here — it depends on a Pi
display client and a WebSocket "active-session" push mechanism, neither
of which exists in this codebase yet (confirmed: no `websocket` reference
anywhere in `server/src/`), so building its admission flow now would be
speculative. `ScoringDevice` admission, by contrast, plugs directly into
the score-submission endpoint that already exists and is fully
exercisable end-to-end today.

In scope:
- A `ScoringDevice` data model and self-registration endpoint that hands
  out a persistent, human-friendly random name plus a browser-storable
  token.
- An admin "Pending Devices" list, an admit action, and a revoke action.
- A `require_admitted_device` enforcement layer on top of the existing
  `require_scorer_or_referee` role check on score submission — `admin`
  bypasses both, unchanged from the auth spec's superuser semantics.
- Real device attribution on `ScoreRecord.submitted_by_device`, replacing
  today's fallback to the spoofable actor header for score-submission
  requests that carry a device token.
- A lazy, request-time idle-timeout computation (no background job), and
  a lightweight middleware that keeps a device's last-seen timestamp
  current across any request it makes, not just scoring ones.

Explicitly out of scope / deferred:
- `Device`/Pi-display admission (master spec §4's other half) — a
  separate future phase, once a Pi client and real-time push exist.
- Any WebSocket-based "device just went offline" push notification —
  this phase's idle-timeout is purely a lazy, request-time computation;
  there is no live presence tracking.
- Rate-limiting or CAPTCHA on `POST /api/devices/register` — matches this
  project's consistently-accepted local-LAN/single-admin-in-the-room
  threat model (see the auth spec §7 for the same acceptance re: login).
- A per-event device roster or per-session device scoping — a single
  running server instance only ever has one event (the project's
  existing one-process-one-event-one-SQLite-file model), so
  `ScoringDevice` rows are server-wide, not scoped to a session or
  division.

## 2. Data model

- **`ScoringDevice`** (new table, one row per registered browser/tablet):
  `id`, `friendly_name: str` (unique, adjective-animal pattern, e.g.
  `"shifty-squirrel"`), `device_token_hash: str` (unique; only the hash
  is ever stored, same principle as `AuthSession.refresh_token_hash` —
  the raw token is returned to the caller exactly once, at
  registration), `registered_at: datetime`, `admitted_at: datetime |
  None`, `admitted_by: str | None` (the admitting actor's identity, same
  value `audit.current_actor` would resolve to at admit time),
  `last_seen_at: datetime` (updated by the activity-tracking middleware
  on every request that carries this device's token, and set to
  `registered_at`'s value at creation).
- **No stored status enum.** "Currently admitted" (the boolean the
  enforcement gate in §4 actually checks) is always computed at the
  point of use: `admitted_at is not None AND (now - last_seen_at) <
  idle_timeout`. This mirrors `AuthSession`'s existing lazy-expiry
  pattern (`revoked_at`/`expires_at` checked at request time, never
  swept by a background job) — this project has no job scheduler, and
  introducing one for a single narrow purpose would be a structural
  addition this phase doesn't need. Revoking a device is simply clearing
  `admitted_at`/`admitted_by` back to `None`; re-admitting after an
  idle-timeout lapse re-runs the same admit action and needs no separate
  "expired" state to manage. For display (§3's device list), the same
  two fields resolve to one of three strings rather than a bare boolean:
  `"pending"` (`admitted_at is None`), `"admitted"` (currently admitted,
  per the boolean above), or `"idle"` (`admitted_at is not None` but the
  boolean above is false — was admitted, has lapsed) — a three-way
  presentation of the identical underlying computation, not a second
  source of truth.
- `Event` gains no new columns. `ScoringDevice` rows are server-wide, not
  linked to any `Event`/`TournamentSession` row (see §1 — a single
  running instance only ever has one event).

## 3. Endpoints

New `devices` router, prefix `/api/devices`:

- **`POST /api/devices/register`** — **no auth required.** A fifth
  bootstrap exception alongside `POST`/`GET /api/event` and
  `POST /api/auth/login`/`refresh` (the auth spec's original four). Body:
  none required. Generates a unique `friendly_name` (retries on
  collision against the unique constraint; see §6) and a random device
  token (`secrets.token_urlsafe(32)`, matching `generate_refresh_token`'s
  entropy), creates the row with `admitted_at: None`, and returns
  `{device_token: str, friendly_name: str, status: "pending"}`. The
  response's `status` is the same computed value described in §2,
  included for the caller's convenience — always `"pending"` for a
  freshly registered device.
- **`GET /api/devices`** — **admin-only.** Lists every `ScoringDevice`
  with its computed status: `id`, `friendly_name`, `status` (`"pending"`
  | `"admitted"` | `"idle"` — `"idle"` being an admitted device whose
  idle-timeout has lapsed, distinguished from `"pending"` so the admin
  UI can show "needs re-admission" rather than "never admitted"),
  `registered_at`, `admitted_at`, `admitted_by`, `last_seen_at`.
- **`POST /api/devices/{id}/admit`** — **admin-only.** Sets
  `admitted_at = now`, `admitted_by = <acting admin's actor identity>`,
  **and `last_seen_at = now`** (see §5 for why re-admitting must also
  refresh `last_seen_at`, not just `admitted_at`). 404 if the device
  doesn't exist. Idempotent — admitting an already-admitted (or idle)
  device just refreshes all three fields.
- **`POST /api/devices/{id}/revoke`** — **admin-only.** Clears
  `admitted_at`/`admitted_by` back to `None`. 404 if the device doesn't
  exist. Idempotent — revoking an already-pending device is a no-op that
  still returns success.

## 4. Enforcement & auth integration

A new `require_admitted_device` FastAPI dependency, applied *in addition
to* `require_scorer_or_referee` on exactly one endpoint:
`POST /api/matches/{match_id}/alliances/{alliance_id}/score`. It reads
the `X-Device-Token` header, hashes it with the same `hash_token`
function `AuthSession` already uses, looks up the `ScoringDevice` row,
and:
- 401s if the header is missing or the token doesn't match any row
  (indistinguishable from "missing" — no information leak about whether
  a token was ever issued).
- 403s if the device exists but isn't currently admitted (per §2's
  computed check).
- Otherwise passes, returning the device's `friendly_name` for the
  endpoint to use (see §5).

**`admin` bypasses only the *rejection*, never the *lookup*.** The
dependency always attempts to resolve `X-Device-Token` when the header is
present, for every role, so attribution (§5) stays accurate even for an
admin using a real scoring tablet. What `admin` skips is 401/403: if the
header is missing, or present but unresolvable/not-admitted, an `admin`
caller passes anyway (with no resolved device, so §5's actor-header
fallback applies) — whereas a `scorer`/`referee` caller would be rejected
in that same situation. This is a deliberate consistency choice (the
superuser role bypasses every gate's *rejection* in this system, not just
role gates) and also means every one of the 286 existing tests — all of
which act as `admin` via the auto-authenticating test fixture and never
send a device token — keeps passing unchanged, with no device-registration
plumbing added to them.

No other endpoint gets this dependency. Reading data (matches, rankings,
etc.) remains governed purely by the existing role gates from the auth
spec; `ScoringDevice` registration/admission status has no bearing on
reads, matching the master spec's "can view read-only information but
cannot submit scores" framing for a pending device — the "view" half is
already handled by the role system, and this phase only adds the "cannot
submit scores" half.

## 5. Activity tracking & attribution

A new ASGI middleware, registered in `app.py` alongside the existing
`actor_scope` middleware: it lets the request complete first, and only
then — if an `X-Device-Token` header was present **and the response
succeeded (status `< 400`)** — hashes the token and updates that
`ScoringDevice` row's `last_seen_at` to now. An unknown or malformed
token is silently ignored (enforcement and error responses are the job
of `require_admitted_device` on the one endpoint that needs them, not
this middleware).

**The success-only condition is load-bearing, not an optimization.** If
`last_seen_at` were touched unconditionally (including on a *rejected*
request), a device that has genuinely gone idle would revive its own
admission simply by attempting — and failing — a request: the failed
attempt would refresh `last_seen_at`, making the very next attempt (or
even that same request one tick later) pass `is_currently_admitted`'s
lazy check with no admin action at all. That directly contradicts this
phase's own "requiring one-click re-admission" goal (§1, from the master
spec). Gating the touch on response success means only a request the
device was actually *allowed* to make counts as activity — an idle
device's repeated rejected attempts never resurrect it; only an admin's
explicit `admit` (§3) does. `POST /api/devices/{id}/admit` correspondingly
sets `last_seen_at = now` as well as `admitted_at = now`, so re-admitting
a device that has been silent for a long time takes effect immediately,
rather than staying rejected until its next successful request happens
to refresh the clock.

This is what makes the idle-timeout reflect genuine device activity
across every endpoint a scoring device's browser successfully touches
(viewing matches, rankings, etc.), not just how often it happens to
submit a score — while still keeping "idle" a one-way gate only an admin
can reopen.

`POST /api/matches/{match_id}/alliances/{alliance_id}/score` additionally
sets `ScoreRecord.submitted_by_device` from the resolved device's
`friendly_name` whenever `require_admitted_device` successfully resolved
one (per §4, resolution happens for any role when `X-Device-Token` is
present and valid — not just non-admin roles). Whenever no device was
resolved — no header at all, or (for `admin` only, since every other
role would already have been rejected) a present-but-invalid/unadmitted
one — `submitted_by_device` falls back to today's behavior
(`audit.current_actor.get()`, still populated from the existing
`X-Actor-Name` header/default). This is unchanged behavior for every
caller that never registered a device, including all 286 existing tests.

## 6. Friendly name generation

A small, curated word list embedded in code — adjectives (e.g. `shifty`,
`brave`, `quiet`, `swift`) crossed with animal nouns (e.g. `squirrel`,
`badger`, `otter`, `hawk`) — large enough that collisions are rare (on
the order of hundreds of combinations) but the list itself is short
enough to read and audit for accidental brand/trademark collisions (see
§0). On generating a candidate name that collides with an existing
`friendly_name` (caught via the unique constraint, or checked
proactively), retry with a new random pick; after a bounded number of
retries (generous relative to the list's size), append a short random
numeric suffix to guarantee termination without an unbounded loop. No
word list exhaustion is expected in practice for a single event's device
count.

## 7. Configuration

`TOURNAMENT_DEVICE_IDLE_TIMEOUT_MINUTES` environment variable, added to
the existing `Settings` dataclass (`server/src/tournament_server/settings.py`)
alongside `TOURNAMENT_DB_PATH`/`TOURNAMENT_PLUGINS_ROOT`. Default: `60`
(one hour), matching the master spec's stated default. An ordinary
configuration value, not a structural decision — tunable without any
change to the admission model itself.

## 8. Testing

**New coverage** (integration tests through `TestClient`, matching this
project's existing testing policy — no mocking at the HTTP boundary):
- Registration returns a unique `friendly_name`/`device_token` pair,
  starts `"pending"`.
- A pending device's score-submission attempt (as `scorer`, with a valid
  role token and its own device token) is rejected 403; the same request
  as `admin` with no device token at all succeeds (bypass).
- After `POST /api/devices/{id}/admit`, the same scorer-role request with
  its device token now succeeds, and the resulting `ScoreRecord`'s
  `submitted_by_device` equals the device's `friendly_name`.
- An unknown/malformed `X-Device-Token` on a score-submission request
  401s.
- Idle-timeout: seed a `ScoringDevice` directly with `admitted_at` set
  and `last_seen_at` in the past beyond the configured timeout (matching
  how the auth spec's own tests seed an expired `AuthSession` directly)
  — the same device's score submission now 403s again, without ever
  calling revoke. Critically, that rejected attempt must **not** silently
  revive the device (confirm a second, immediately-following identical
  attempt still 403s) — only an explicit re-admit restores access.
- `POST /api/devices/{id}/revoke` immediately un-admits a device (403 on
  its next score-submission attempt), and is idempotent when called on
  an already-pending device.
- `GET /api/devices` is admin-only (403 for `scorer`, matching the
  representative-authorization-check pattern the auth spec's own tests
  already established); non-admin roles get 403 on admit/revoke too.
- A non-scoring request (e.g. `GET /api/divisions`) carrying a valid
  `X-Device-Token` updates that device's `last_seen_at` — proving the
  middleware, not just the endpoint-scoped dependency, tracks activity.
- Friendly-name collision handling: a focused unit test forces a
  collision (e.g. by pre-seeding a `ScoringDevice` with a specific name
  and monkeypatching/seeding the random picker, or by exhausting a
  tiny word list in an isolated unit test of the generation function
  directly) and confirms a distinct name is still produced.
- Every one of the 286 pre-existing tests keeps passing unchanged (no
  device registration added to any of them), proving the `admin`-bypass
  design actually holds.

## 9. Deferred / open items

- `Device`/Pi-display admission — a separate future phase, per §1.
- Live/WebSocket-based device presence — this phase is lazy and
  request-time only; a device that goes silent is only discovered idle
  the next time anything checks, never proactively pushed.
- Any admin UI for the "Pending Devices" list itself — this spec is API
  layer only, per this project's existing phase-ordering (UI specs are
  written separately, once the admin UI phase begins).
- Rate-limiting on registration — not requested, matches this project's
  consistently-accepted local-LAN threat model.

## 10. Migration note

This is a schema change (one new table) on top of every prior phase's own
schema changes — same situation as always per this project's convention:
no real deployed event data exists yet, so a pre-this-phase database is
recreated (delete the `.db` file), not migrated.
