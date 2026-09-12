# Real-Time WebSocket Data Flow & Live Match Control — Design Spec

## 0. Hard constraint

Never reference any real-world competition brand or product name anywhere
in this spec, the code it produces, comments, docs, or user-facing text
(root `CLAUDE.md`).

## 1. Purpose & scope

The master spec
(`docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md`
§6) designed a real-time WebSocket data flow — two channel kinds,
`active-session` and `session:<id>` — but it was never implemented.
Building it is the second of two backend prerequisites identified before
starting the Admin UI phase (the first, LAN binding/discoverability, is
already merged).

While scoping this, it became clear the master spec's named event
"match start/pause/resume/end" describes a live match-control capability
that doesn't exist yet either — today `Match.status` only ever
transitions `"scheduled"` → `"completed"` (via full scoring); there's no
concept of a running match, a countdown, or a pause. This phase builds
that capability too, since a WebSocket channel with nothing live to
report would defeat the point.

**In scope:**
- A WebSocket connection manager and the two channel kinds.
- Live match-control: a phase state machine (countdown → timed segment,
  repeated for autonomous and driver periods), pause/resume, early
  end, and two flavors of reset.
- A time-synchronization endpoint so clients can render synchronized
  countdowns without relying on NTP (the venue may have no internet at
  all).
- Broadcasting for existing state changes that aren't live-match-control
  related: score saved, new match created, ranking updated, active
  session changed.
- Real integration tests (real FastAPI `TestClient` WebSocket
  connections, real temp-file SQLite) for all of the above.

**Explicitly out of scope / deferred:**
- The live, provisional score-preview-during-scoring feature the master
  spec already deferred (§6) — untouched by this phase.
- Any UI (Admin UI, scorer/tablet UI, Pi display client) actually
  consuming these channels — this phase is server-only. A future UI
  phase builds the client side.
- The hosted participant/attendee SPA and its relay (master spec §10) —
  unrelated, separate future subsystem.
- Judged-awards workflow, plugin sandboxing, and every other item the
  master spec already deferred — untouched.

## 2. Time synchronization

A new, no-auth endpoint (matching the bootstrap-endpoint status of
`POST /api/auth/login` and `POST /api/devices/register`, since every
client — even one not yet logged in — needs to know the server's clock
before it can render anything time-based):

```
GET /api/time-sync
```

Returns `{"server_time": "<ISO 8601 UTC timestamp>"}`, generated at the
moment the request is handled. A client computes its own clock offset
via the classic round-trip-adjusted estimate (record `t0` at send,
`t1` = the returned `server_time`, `t2` at receive; `offset = t1 -
(t0+t2)/2`), typically once at startup and periodically thereafter, and
renders every countdown from `local_time + offset` rather than raw local
time. This makes the server itself the shared clock authority for every
device on the venue LAN, independent of whether NTP is reachable — a
deliberate requirement, since this project must work at a venue with no
internet access at all.

This offset-computation and countdown-rendering logic is entirely
client-side and out of scope for this phase's implementation (no UI
exists yet) — this phase only needs to ship the endpoint itself.

## 3. Live match-control state machine

### 3.1 Phases

A match's live-control state is tracked independently of its existing
`status` column (`"scheduled"`/`"completed"`, unchanged — that remains
the authority for whether a match has been officially scored). A new
`phase` column holds one of:

- `not_started` (default)
- `countdown_autonomous`
- `autonomous`
- `awaiting_driver`
- `countdown_driver`
- `driver`
- `ended`

Two segments exist — autonomous and driver — each preceded by a 3-second
countdown. `countdown_autonomous`/`autonomous` are skipped entirely when
the active game plugin's `match_format()` declares
`autonomous_seconds == 0`: `start` goes straight to `countdown_driver` in
that case, and `awaiting_driver` never occurs. The 3-second countdown
duration is a fixed system constant, not configurable per plugin, unless
a future need arises.

### 3.2 Transitions

```
not_started
  --(manual: start)-->
    [if autonomous_seconds > 0]
      countdown_autonomous --(auto, 3s)--> autonomous
        --(auto, autonomous_seconds)--> awaiting_driver
          --(manual: start-driver)--> countdown_driver
    [else]
      countdown_driver
  countdown_driver --(auto, 3s)--> driver
    --(auto, driver_seconds)--> ended
```

- **Manual triggers** (each restricted to `scorer`/`referee`/`admin`,
  matching who's already allowed to submit scores):
  `POST /api/matches/{id}/start` — valid only from `not_started`.
  Transitions to `countdown_autonomous` if `autonomous_seconds > 0`,
  else directly to `countdown_driver`.
  `POST /api/matches/{id}/start-driver` — valid only from
  `awaiting_driver` (409 otherwise, including when the game has no
  autonomous period at all, since that state is never reached there).
- **Auto-advancing transitions** (server-driven, no request involved):
  `countdown_autonomous` → `autonomous` (after 3s); `autonomous` →
  `awaiting_driver` (after `autonomous_seconds`); `countdown_driver` →
  `driver` (after 3s); `driver` → `ended` (after `driver_seconds`). See
  §3.4 for the timer mechanism.
- **Pause/resume** (`POST /api/matches/{id}/pause` /
  `.../resume`, same role gate): valid only during the four actively
  timed phases (`countdown_autonomous`, `autonomous`, `countdown_driver`,
  `driver`); 409 otherwise (including from `awaiting_driver`, which has
  no running timer to pause). Freezes/resumes the current phase's
  countdown — see §3.3.
- **End** (`POST /api/matches/{id}/end`, same role gate): valid from any
  phase after `not_started` and before `ended` — both the automatic
  outcome of `driver`'s timer expiring, and a manual early-abort (an
  E-stop-equivalent) from any active or waiting phase. Always lands on
  `ended`.
- **Reset** (`POST /api/matches/{id}/reset`, body `{"scope": "section" |
  "full"}`, same role gate):
  - `scope: "full"` resolves to `not_started` from any phase, including
    a harmless no-op when already `not_started`.
  - `scope: "section"` is only meaningful from the four actively timed
    phases — `409` from `not_started`, `awaiting_driver`, or `ended`,
    since there's no "section" to redo there (a UI shouldn't even
    surface this action outside those four phases). From
    `countdown_driver`/`driver` it resolves to `awaiting_driver` (redo
    just the driver segment, keeping the fact that autonomous already
    ran); from `countdown_autonomous`/`autonomous` it resolves to
    `not_started` (there's no meaningful "section" to redo other than
    the whole match, since nothing precedes autonomous but the start).
  - Either scope 409s once `Match.status == "completed"` — resetting
    live timing on an already-scored match doesn't make sense, and this
    never touches `ScoreRecord`s regardless.

### 3.3 Timing representation

Three columns carry everything a client needs to render a correct
countdown, including one that just reconnected:

- `phase_deadline: datetime | None` — the absolute server-clock
  timestamp the current phase ends at, while running. `null` while
  paused or during a non-timed phase (`not_started`, `awaiting_driver`,
  `ended`).
- `paused: bool`
- `remaining_seconds_at_pause: float | None` — the frozen remaining time
  in the current phase, set when paused, cleared on resume. `null`
  unless `paused` is true.

`pause` cancels the scheduled auto-advance (§3.4), computes
`remaining_seconds_at_pause = phase_deadline - now()`, clears
`phase_deadline`, sets `paused = true`, and broadcasts. `resume`
computes a fresh `phase_deadline = now() + remaining_seconds_at_pause`,
clears `remaining_seconds_at_pause` and `paused`, reschedules the
auto-advance for the new deadline, and broadcasts.

A client (including one that just reconnected) reads `phase` +
`phase_deadline`/`paused`/`remaining_seconds_at_pause` from `MatchRead`
(§8) and knows exactly what to render and, per §6, exactly what event to
expect next on the socket (e.g. `phase: "driver"` with a `phase_deadline`
12 seconds out means the next expected event for this match is a
`match_phase_changed` carrying `phase: "ended"`).

### 3.4 Background auto-advance timers

Since route handlers are synchronous (§4.2 explains why this is a
constraint), the auto-advance mechanism is a small in-process registry —
`match_id -> asyncio.TimerHandle` — living alongside the connection
manager (§4.1). `start`/`start-driver`/`resume` schedule a callback (via
`asyncio.run_coroutine_threadsafe` from the sync route, same bridge as
broadcasting) that fires at `phase_deadline`, opens its own DB session
(`app.state.session_factory`), performs the phase transition, persists
it, broadcasts it, and — if the new phase is itself auto-advancing —
schedules the next callback. `pause`/`reset`/`end` cancel any pending
timer for that match before making their own change. Only one match is
ever active per FieldSet (existing invariant), so the number of
concurrently scheduled timers is small and bounded by FieldSet count,
never a scaling concern.

**Startup recovery:** if the server restarts while a match is mid-phase
(in-memory timer state is lost on any restart), `create_app()` queries
for any match with `phase` not in `{not_started, ended}` and not
`paused`, and either reschedules its timer from the persisted
`phase_deadline` (if still in the future) or immediately performs the
transition (if the deadline already passed while the server was down).
A `paused` match needs no recovery — it has no pending timer by
definition.

## 4. WebSocket channels & connection manager

### 4.1 Connection manager

A new module (`realtime.py`) holds two subscriber registries in process
memory — `active_session: set[WebSocket]` and `session: dict[int,
set[WebSocket]]` — since this project is one process per event; no
cross-process pub/sub is needed. It exposes:

- `broadcast_active_session(event: str, data: dict) -> None` (sync,
  callable from any router) — sends to every `active_session`
  subscriber.
- `broadcast_session(session_id: int, event: str, data: dict) -> None`
  (sync) — sends to every subscriber of that specific `session_id`.
- A combined helper, `broadcast_for_session(session_id: int, event: str,
  data: dict) -> None`, that always calls `broadcast_session` and
  additionally calls `broadcast_active_session` if `session_id` equals
  `Event.active_session_id` at the moment of the call — this is what
  most routers actually call, so they never have to reason about which
  channel(s) apply.

### 4.2 Sync-to-async bridge

Every existing route handler is a plain sync `def` (FastAPI's implicit
threadpool), and this phase's new match-control endpoints follow the
same convention rather than introducing a mix of styles. Since sending
over a WebSocket is inherently async, `broadcast_*` internally uses
`asyncio.run_coroutine_threadsafe(coro, loop)` against the main event
loop — the standard bridge for scheduling a coroutine from a worker
thread. The loop reference must be captured from inside a FastAPI
startup/lifespan hook (`app.state.event_loop = asyncio.get_running_loop()`),
not at `create_app()`'s own construction time — `create_app()` runs as
plain sync code before Uvicorn's event loop exists, so grabbing "the
event loop" there would either fail or return the wrong one entirely.
This keeps every router's signature and behavior unchanged; a router
just gets one extra plain function call at the right point. The same
loop reference is what §3.4's timer registry uses to schedule and cancel
auto-advance callbacks.

### 4.3 Routes

```
GET /ws/active-session?token=<jwt>
GET /ws/session/{session_id}?token=<jwt>
```

The JWT (the same access token `POST /api/auth/login` already issues)
is passed as a query parameter, not a header, since a browser's native
`WebSocket` API cannot set custom headers on the handshake request.
Validated identically to the existing `require_role`/`require_admin`
dependencies' logic (decode, check expiry, check role) — just adapted to
read from a query param instead of an `Authorization` header. Any
authenticated role may open `active-session` (it's the shared live-view
channel every role — display, scorer, referee, judge, attendee, admin —
watches by default, per the master spec). `session:<id>` requires
`admin`. An invalid/expired/missing token closes the connection
immediately with a policy-violation close code, before adding it to
either registry.

Both endpoints are receive-only: a client never sends application
messages over the socket after connecting (all commands — start, score
submission, etc. — go through the existing/new REST endpoints, which
then trigger a broadcast). The server does not need to read incoming
WebSocket frames at all beyond the initial handshake.

## 5. Event catalog

Envelope: `{"event": "<type>", "data": {...}}`.

**Match-control events** (payload carries the live state directly —
this is the latency-sensitive data the whole channel exists for, so a
client never needs a round-trip to REST just to render a countdown
tick):
- `match_phase_changed` — `{match_id, phase, phase_deadline}`. Covers
  every phase transition uniformly, manual or automatic — start,
  start-driver, and every auto-advance (including the transition into
  `ended`).
- `match_paused` — `{match_id, phase, remaining_seconds_at_pause}`.
- `match_resumed` — `{match_id, phase, phase_deadline}`.
- `match_reset` — `{match_id, phase}` (always `not_started` or
  `awaiting_driver`; `phase_deadline` is implicitly `null` in both).

**Structural events** (thin — identifying info only; a client already
has, or refetches via, the existing REST resource for the actual data,
keeping one source of truth for that richer shape rather than
duplicating it into the event payload):
- `score_saved` — `{match_id, alliance_id}`.
- `new_match_created` — `{match_id, session_id, division_id, field_id}`.
- `ranking_updated` — `{session_id, division_id, event_wide}`; when
  `event_wide` is `true`, `session_id` is `null`, matching the
  event-wide `Ranking` row's own null `session_id` (`GET
  /api/rankings?event_wide=true`).
- `active_session_changed` — `{active_session_id}`. Delivered only on
  the `active-session` channel (obviously — that's the channel whose
  meaning just shifted); a client receiving this treats it as a signal
  that everything it previously fetched for "the active session" is now
  stale and should be refetched for the new one.

## 6. Reconnection & resync

Per the master spec's requirement ("WebSocket clients resync full
current state on reconnect, not just missed deltas"): reconnecting is
simply "refetch current state via the existing REST endpoints (matches,
rankings), then resume listening to the socket." No bespoke snapshot
message type exists on the WebSocket itself. This works because §3.3's
live-timing fields are part of `MatchRead` (§8), so a plain
`GET /api/matches?session_id=...` already returns everything — including
"this match is in `driver`, ending at this timestamp" — with no special
casing. A client that just connected (or reconnected) always does this
REST fetch first; the socket only ever needs to carry "this changed"
events from that point forward, never a way to bootstrap state from
nothing.

## 7. Testing

All new coverage follows this project's existing policy: real
(`TestClient`) FastAPI instances, real temp-file SQLite, no mocking at
the HTTP/WebSocket boundary.

- **Time sync**: `GET /api/time-sync` returns a timestamp close to
  "now" and requires no auth.
- **Connection manager / auth**: connecting to `active-session` with no
  token, an invalid token, or an expired token is rejected before
  registration; a valid token for any role succeeds. Connecting to
  `session:<id>` with a non-admin role is rejected; admin succeeds.
- **Match-control transitions**: each manual endpoint (`start`,
  `start-driver`, `pause`, `resume`, `end`, `reset` with both scopes)
  tested against a real `TestClient` WebSocket connection, asserting
  the exact expected event arrives via `ws.receive_json()` after the
  corresponding REST call, for both the `autonomous_seconds > 0` and
  `autonomous_seconds == 0` game-plugin cases.
- **Auto-advance**: since these tests can't literally wait out a real
  `autonomous_seconds`/`driver_seconds` duration, test fixtures use a
  short custom game plugin declaring single-digit-second segments (e.g.
  1-2 seconds) so a test can `await`/poll briefly and assert the
  auto-transition and its broadcast actually happened, not just that
  the scheduling call was made.
  - Cancellation on pause/reset/end: schedule an auto-advance, then
    pause/reset/end before it would have fired, and assert no stray
    `match_phase_changed` for the cancelled transition arrives.
- **Startup recovery**: a match persisted with `phase="driver"` and a
  `phase_deadline` already in the past, brought up via `create_app()`,
  is immediately transitioned to `ended` (and broadcasts) rather than
  staying stuck; one with a deadline still in the future is correctly
  rescheduled (verified by waiting for it to actually fire).
- **Broadcast routing**: an event for a session that IS the active
  session arrives on both `active-session` and `session:<id>`; an event
  for a session that is NOT active arrives only on `session:<id>`.
- **Existing structural events**: submitting a score, generating a
  schedule (new match created), a ranking recompute, and switching the
  active session each produce their documented event on the correct
  channel(s).

## 8. Data model changes

`Match` gains four columns (Alembic migration in the same change,
per this project's now-established migration discipline):
`phase: str` (default `"not_started"`), `phase_deadline: datetime |
None`, `paused: bool` (default `false`), `remaining_seconds_at_pause:
float | None`. `MatchRead` (`schemas/match.py`) gains the same four
fields so they're visible via the existing `GET /api/matches` /
`GET /api/matches/{id}` endpoints without any new response shape.

## 9. API surface summary

New REST endpoints (all under the existing `matches` router, same
`require_scorer_or_referee`-style role gate already used for scoring):
`POST /api/matches/{id}/start`, `.../start-driver`, `.../pause`,
`.../resume`, `.../end`, `.../reset`.

New standalone endpoint: `GET /api/time-sync` (no auth).

New WebSocket routes: `GET /ws/active-session`, `GET
/ws/session/{session_id}` (both `?token=<jwt>`).

## 10. Deferred / out of scope (restated)

- Live score-preview-during-scoring (master spec §6) — untouched.
- Any actual UI consuming these channels — a later phase.
- The hosted participant SPA/relay (master spec §10) — unrelated.
- Configurable countdown duration (currently a fixed 3s constant) — no
  need identified yet.
