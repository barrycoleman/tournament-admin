# Core Server & Plugin Architecture — Design Spec

Status: approved for planning
Date: 2026-08-28

## 0. Project constraint

Nothing in this project's code, comments, documentation, file names, or
user-facing text may reference any real-world competition brand or product
name. All descriptions in this spec are written in neutral/generic terms for
that reason, even where they describe a specific closed-source reference
product's behavior.

## 1. Purpose & scope

This spec defines the **core server**: the backend process, data model,
plugin contracts, real-time event model, scheduling, error handling, and
packaging for a free, self-hostable tournament management system, aimed
first at small robotics-style head-to-head competitions with an optional
individual skills-challenge track.

It does **not** define:
- The actual admin web UI, scorer/tablet UI, or Raspberry Pi display client
  implementations (HTML/CSS/JS). Those are separate follow-on specs that
  consume the REST/WebSocket API and the plugin-declared scoresheet schema
  this spec defines.
- The first real game's scoring rules (a small follow-on spec/plugin once
  the target game's rules are in hand).

In scope for v1:
- Data model for Event/Session/Division/Team/Match/Alliance/ScoreRecord/
  SkillsAttempt/EliminationBracket/InspectionRecord/Award/Device/
  ScoringDevice/Asset/AuditLog.
- Game-scoring plugin contract and schedule-generator plugin contract,
  both distributed as zip packages.
- Two built-in schedule generators (simple random, balanced/club- and
  league-history-aware), selectable per event, with a documented interface
  for custom ones.
- REST + WebSocket API surface (no frontend).
- A generic elimination bracket engine.
- A plugin compliance/checksum/capability-declaration tool.
- Packaging as a standalone executable (primary) and a Docker image
  (secondary).

Explicitly out of scope / deferred:
- Physical field-control hardware (light towers, motor stop relays).
- Any external results-registry sync or SMS-style reminder integration.
- A "single shared server across divisions" split mode — divisions are
  first-class scoped data in one server/file instead.
- Live in-progress score preview during scoring (see §6) — designed here,
  building it can wait.
- Cryptographic plugin signing / OS-level plugin sandboxing (see §9).

## 2. Architecture

Single Python process (FastAPI + Uvicorn) per event, serving:
- A JSON REST API for CRUD and historical queries.
- WebSocket endpoints for live updates.
- Static SPA bundles (admin, scorer, display) — everything is one process,
  one port, "download it, run it, open a browser."

Data lives in one SQLite file per event (via SQLAlchemy models). One file
is the entire tournament: teams, matches, scores, uploaded images, audit
history. Copying that file is the entire backup/relocation story.

### Sessions, not "league mode"

A **Session** is one calendar sitting (a single-day tournament has exactly
one; a season-long league has several, all in the same Event/file). There
is no special "league mode" — every event is session-capable from the
start, avoiding a mode-split entirely. **Division** is orthogonal to
Session: a same-session partition of teams/matches (e.g. two skill-level
brackets running the same day). The real scoping key on all live-data
tables is `(session_id, division_id)`.

### Current Active Session

The server holds exactly one piece of small, explicit, mutable global
state: `Event.active_session_id`. Field devices (Pi displays, scoring
devices) and their WebSocket channels always follow whichever session is
active — they never choose one. Every REST endpoint instead takes an
explicit `session_id` query parameter (defaulting to the active session
only for convenience, always overridable), so an admin can read or correct
a different (including inactive) session's data at any time. Switching the
active session is a cheap, explicit admin action: move the pointer, then
broadcast an "active session changed" event to anything following it.
Never a restart, never a data migration. This is what lets an admin jump
into session 2 to fix a mistake while session 4 keeps running live on the
field.

## 3. Data model

- **Event** — one per SQLite file. `active_session_id`, name, selected
  game plugin `(name, version)` — fixed for the life of the event, since
  scoring rules can't sensibly change mid-tournament.
- **Session** — `event_id`, label/date. Each schedule-generation action
  (e.g. "Create Practice Matches" or "Create Qualification Matches" for
  this session) records which scheduler plugin `(name, version)` it used,
  so different sessions in the same league may use different generators
  if an organizer chooses to, without any event-wide setting to keep in
  sync.
- **Division** — `event_id`, name.
- **Team** — `number, name, organization, city, state, country,
  tiebreaker_seed` (a random value committed at creation time, not derived
  live, so re-ranking is always reproducible). Teams belong to Divisions.
- **SessionParticipation** — which teams are checked in/participating in a
  given session (a league's roster can shift session to session).
- **Match** — `session_id, division_id, round_type` (practice /
  qualification / elimination), `match_number, field_id, scheduled_time,
  actual_start_time, resume_events[]` (a match's pause/resume history is
  first-class, not derived from start/end alone), `status`.
- **Alliance** — one per side of a Match: `match_id, station, team_ids[]`.
- **ScoreRecord** — `alliance_id, plugin_name, plugin_version, data`
  (plain JSON — a flat list/object of named fields, e.g.
  `{"auto": 1, "highballs": 15}` — human-readable, no opaque blob format),
  `no_show, dq, sitting, submitted_by_device, submitted_at, saved_at`
  (null until an admin/scorekeeper commits it as official).
- **Ranking** — cached per `(session_id, division_id, team_id)`: win
  points, tiebreaker score, rank. Recomputed from ScoreRecords plus the
  plugin's ranking function on every save; the cache is a read
  optimization, not the source of truth.
- **SkillsAttempt** — same shape as ScoreRecord for the separate
  driver/programming skills track: `session_id, division_id, team_id,
  skills_type, data (JSON), attempt_number`.
- **EliminationBracket** — `division_id, round, wins_to_advance,
  seed_overrides[], unavailable_teams[(team_id, reason)]`.
- **InspectionRecord** — `session_id, team_id, status (not_started /
  partial / passed), notes`.
- **AuditLog** — append-only, comprehensive (see §8): every mutation,
  not a curated subset, with before/after values and the acting
  user/device.
- **Award** — `name, type, session_id/division_id scope, recipient`.
- **Device** — Raspberry Pi / unattended kiosk displays only. `device_id,
  name, ip, display_type (audience / pit / field-queue),
  assigned_field_or_division, last_seen`.
- **ScoringDevice** — tablets/phones used for scoring. See §4.
- **Asset** — uploaded images: `purpose (sponsor_logo / event_banner /
  etc.), content_type, data (blob), width, height, uploaded_at`. The
  product ships with **zero** default sponsor or advertising content of
  any kind; the only branding ever shown anywhere is what the event
  organizer explicitly uploads here.

## 4. Device admission

**Pi displays** (`Device` table): admin-driven. The server discovers or
is given a Pi's IP, then the admin assigns it a type, field/division, and
name from the admin UI; the Pi is told what to display and reconnects
automatically after network drops or power cycles.

**Scoring devices** (`ScoringDevice` table, separate from `Device`):
self-registering. When a browser opens the scoring page, the server
assigns it a persistent, human-friendly random name (adjective-animal,
e.g. `shifty-squirrel`) plus a browser-stored token so refreshes and
reconnects don't re-trigger registration or renaming. It starts in
`pending` status — it can view read-only information but cannot submit
scores — and appears in an admin "Pending Devices" list. An admin clicks
**Admit**, flipping it to `admitted` and stamping `admitted_by` /
`admitted_at`. Every `ScoreRecord.submitted_by_device` references this
friendly name, so any submission or correction is immediately
attributable ("shifty-squirrel edited alliance 74's score at 2:41pm") in
both the UI and the audit log. Admission auto-expires after a configurable
idle timeout (default matches prior art: 1 hour), requiring one-click
re-admission rather than staying silently trusted indefinitely.

## 5. Plugin contracts

Two plugin kinds, both folder-based with a manifest, both distributed as
a single `.zip` (see §7 for packaging/installation flow).

### 5.1 Game scoring plugin (`plugins/games/<name>/`)

Interface (documented as a `typing.Protocol`/ABC):

- `match_format()` — alliance count per match, teams per alliance, match
  phase durations (e.g. autonomous/driver period lengths), which round
  types it applies to.
- `scoresheet_schema()` — a list of field definitions that (a) the
  generic frontend renders as a form, and (b) literally defines the JSON
  shape stored in `ScoreRecord.data`. Each field:

  ```json
  {
    "name": "highballs",
    "label": "High Balls",
    "data_type": "integer",
    "widget": "counter",
    "min": 0, "max": 20, "step": 1,
    "icon": "high_ball.svg",
    "scope": "alliance",
    "default": 0
  }
  ```

  `data_type` is `integer | boolean | enum`. `widget` selects the control
  rendered: `toggle` (yes/no), `counter` (a +/- stepper whose buttons
  disable exactly at `min`/`max`, preventing illegal values at the point
  of entry rather than only flagging them after submission), `select` /
  `radio` (enum). `icon` is optional: a plugin may ship small image files
  in its own folder, served as static assets by the server, or omit it and
  fall back to a small built-in generic icon set (checkmark, robot, ball,
  goal, etc.) plus the label. `scope` is `alliance` or `team`.
- `calculate_score(data)` — pure function turning submitted field values
  into alliance score(s), applying no-show/DQ zeroing.
- `validate(data)` — out-of-range/illegal-combination checks. This is a
  backstop, not the primary defense (the UI's widget min/max already
  prevents most bad input at entry time) — it still matters for direct
  API calls, admin overrides, and stale/offline clients.
- `rank_teams(...)` — win-point allocation and an ordered tiebreaker list
  (e.g. win points → strength-of-schedule → the team's pre-committed
  random tiebreaker seed).
- `skills_scoresheet_schema()` / `calculate_skills_score()` — same shape
  as above, for the separate skills-challenge track.

Plugin authors are told to keep field `name`s stable across versions:
because scoresheets are stored as plain JSON using those names, old data
stays human-readable and interpretable even after a plugin's internal
logic changes in a later version.

### 5.2 Schedule generator plugin (`plugins/schedulers/<name>/`)

One function: `generate_schedule(teams, target_matches_per_team, fields,
field_sets, cross_session_pairing_history, constraints) -> matches`.

Built-in generators:
- `simple_random` — random assignment respecting field count and
  matches-per-team, no variety optimization.
- `balanced` — avoids repeat partner/opponent pairings and same-
  organization pairings where possible, using pairing history from
  **every session in the event**, not just the one being scheduled (so a
  league's 4th session avoids rematches from sessions 1–3 too). Falls back
  to minimizing the maximum repeat count once every unique pairing within
  the current field/match-count constraints is exhausted (i.e. "everyone
  plays everyone once, then everyone plays everyone twice," etc.).

Custom generators can be dropped in following the same interface.

## 6. Real-time data flow

Two kinds of WebSocket channel:
- **`active-session`** — followed by Pi displays, scoring devices, and
  the admin UI by default. Carries: match start/pause/resume/end, score
  saved, new match created (e.g. a freshly generated elimination match
  appears instantly — no manual reload), ranking updated, and "active
  session changed."
- **`session:<id>`** — the admin UI can additionally open this for any
  specific (including inactive) session while making a correction,
  without affecting what field devices see.

Everything else (CRUD, historical queries, exports) is plain REST.

A live, provisional score preview during scoring (individual field edits
broadcast to the Audience Display before submission, explicitly marked
unofficial) is designed but **deferred**: worth having during
practice/qualification matches for spectator engagement, but suppressed
during elimination/finals rounds so results aren't spoiled before the
official reveal. This round-type gate is captured now so it isn't
forgotten when the feature is eventually built.

## 7. Error handling, offline recovery, and packaging

**Offline recovery**: the scorer SPA keeps an on-device log (browser
storage) of every submission attempt with its exact HTTP status and raw
payload, so a scorer can see and manually recover a lost score if the
network drops mid-submission. Submissions carry a client-generated
idempotency key so a retried request after an ambiguous timeout never
double-applies.

**Backups**: automatic, timestamped snapshots of the SQLite file on a
time interval and before risky transitions (switching the active session,
generating an elimination bracket). If the server detects it didn't shut
down cleanly last time, it proactively offers to restore from the most
recent backup rather than requiring the operator to know a backup folder
exists.

**Reconnection**: WebSocket clients resync full current state on
reconnect, not just missed deltas, so a dropped connection never
permanently desyncs a device.

**Packaging**: primary distribution is a standalone executable per OS
(PyInstaller, built via a CI matrix across Windows/Mac/Linux), unsigned at
first launch (a documented one-click SmartScreen/Gatekeeper bypass);
free OSS code-signing (e.g. SignPath Foundation) pursued once the project
is public with an OSI license, rather than paying for certificates
up front. A Docker image is offered as a secondary option for technical/
self-hosting users.

**Plugin installation**: plugins are authored as folders but distributed
and installed as a single `.zip`. An organizer uploads the zip through the
running admin UI (or drops it into a watched `plugins/incoming/` folder);
the server validates and unpacks it into the correct `plugins/games/
<name>/` or `plugins/schedulers/<name>/` location automatically — no
manual file placement, no restart required to pick it up. Because
installation only depends on the documented plugin interface, this
packaging is inherently game-agnostic: any conforming zip can be added,
not just ones the project ships itself.

## 8. Audit log

Every mutation (score save/edit, ranking recompute, session activation
change, device admission, team edit, inspection change — not a curated
subset) is recorded with before/after values and the acting user/device,
generically via SQLAlchemy session events (before/after flush) rather than
manual logging calls scattered through the codebase, so nothing gets
missed by omission. State tables remain the source of truth and are
updated directly (this is not event-sourcing — state is never *derived*
by replaying the log); the log exists to make "what happened, when, and
who did it" fully reconstructable after the fact, which is most of the
practical value of a full replay log at a fraction of the architectural
complexity and risk.

## 9. Plugin compliance, checksums, and capability declaration

A CLI tool, `tm test-plugin <path>`, run by a plugin author before
distributing a zip:

1. Runs a conformance test suite against the plugin's implementation of
   its declared contract (game or scheduler): schema shape, deterministic
   scoring, ranking behavior on edge cases (ties, no-shows, DQs).
2. Statically scans the plugin's source for imports/usages indicating
   network access, subprocess execution, or filesystem access outside its
   own folder (e.g. `requests`, `socket`, `subprocess`), and cross-checks
   the result against a `capabilities:` block the plugin's manifest must
   declare (e.g. `network: false`). A plugin whose code uses a capability
   its manifest denies **fails** compliance.
3. On a full pass, computes a SHA-256 checksum per file plus one aggregate
   checksum, embeds them in the package, and produces the distributable
   zip.

When a server receives a plugin zip, it recomputes those checksums against
the actual file bytes before ever activating the plugin, and shows the
organizer the compliance report — pass/fail, when it was tested, and its
declared capabilities — as part of installing it. A checksum mismatch
("modified since compliance was last run") requires an explicit override
to proceed.

**Explicit limitation, stated on purpose rather than left implicit**: this
is tamper-evidence and informed consent, not a security sandbox. The
checksum proves the distributed bytes are exactly what passed testing; it
does not vouch for the original author's intent, and the static capability
scan is inherently beatable by anyone determined to obfuscate a network
call in dynamic Python (`getattr`, `eval`, `ctypes`, and similar). What it
reliably delivers is the actual goal: an organizer who receives a plugin
zip from a stranger has something concrete to check before trusting it,
and it catches every honest mistake. True isolation (running plugin code
in a sandboxed, network-namespaced subprocess) is a credible future
addition if this ever grows into an ecosystem of plugins from untrusted
third parties — deliberately deferred, not accidentally omitted.

## 10. Open items for the next spec(s)

- Admin UI, scorer/tablet UI, and Pi display client implementations.
- The first real game's plugin (scoring rules, once the target game's
  rules are in hand).
- Whether/when to build the deferred live-score-preview feature (§6).
- Whether to eventually add cryptographic plugin signing or OS-level
  sandboxing (§9) if a third-party plugin ecosystem emerges.
- **A new subsystem, not decomposed here yet: a read-only
  participant/attendee SPA plus a small hosted publishing relay.**
  Captured now, to be fully brainstormed and speced when its turn comes:
  - Purpose: parents/students/spectators need to see a team's schedule,
    check-in status, match and skills scores, and rankings without being
    on the venue's local network (the venue WiFi shouldn't have to carry
    spectator traffic alongside scoring/field devices). Read-only, no
    write path.
  - Shape: a small hosted relay service (separate from, and much
    simpler than, the core server) holds a *live* copy of one event's
    published data only while that event's local server is up and
    actively pushing to it. The local server is the one that connects
    outbound to the relay and publishes updates — the relay never needs
    an inbound path into the venue's LAN, which fits a server that's
    likely behind NAT with no port-forwarding. When the local server
    stops publishing (event's over, admin closes it), the relay
    discards that event's data — it's explicitly an ephemeral cache,
    not a permanent hosted database per event.
  - Event codes: when a local server first starts publishing an event,
    the relay issues a short, human-shareable code (e.g. `TJDR-DKEL`
    style). A code is never reused for a *different* event once
    retired. A multi-session league — one Event, many Sessions, per
    this spec's data model (§2–§3) — keeps the *same* code across every
    session, since it's the same underlying Event the whole time; the
    code is tied to the Event, not to any one Session.
  - Participant site: a public site (domain already secured:
    `tournamentadmin.net`, e.g. a `scores.tournamentadmin.net`
    subdomain) where a visitor enters the event code, picks their team
    from a list, and sees that team's read-only data.
  - The Audience Display (part of the later display-client spec) should
    be able to show the event's current code on-screen, so spectators
    can read it off the projector/monitor and visit the site from their
    own phones.
  - Open questions for that future spec: the relay's own hosting/
    architecture, the exact publish protocol between the local server
    and the relay (what gets pushed, how often, how much of it reuses
    the core server's existing REST/WebSocket shapes vs. needing a
    purpose-built relay-facing API), and event-code security (e.g.
    guessability, whether a still-open event's code should ever expire
    from inactivity even though the event itself hasn't ended).
- **Port/host binding and discoverability is currently hardcoded and,
  as written, actually broken for this project's own architecture**
  (`main.py` binds `127.0.0.1:8000`) — loopback-only, so no other
  device (scorer tablet, Pi display) could ever reach it regardless of
  port, directly contradicting the LAN-connected-devices design this
  whole project is built around. Also fragile even for the admin's own
  machine: if 8000 is taken by something else, the server fails to
  start with a raw `OSError`/traceback, not a friendly message. Needs a
  real design pass in the packaging phase (spec §7), covering:
  - Bind to `0.0.0.0` (or the detected LAN interface address) rather
    than `127.0.0.1`, so other devices on the venue network can
    actually connect at all.
  - Auto-probe for a free port if the configured default (e.g. 8000)
    is taken — try 8001, 8002, etc. — rather than crashing.
  - The apparent chicken-and-egg problem ("you need the Admin UI to
    learn the address, but need the address to open the Admin UI")
    only exists for *other* devices, not the admin: the executable can
    auto-open the system's default browser to `localhost:<port>` (or
    `127.0.0.1:<port>`) at startup, since the admin is always on the
    same machine as the server — no IP or port needs to be typed or
    even known by them for their own access.
  - The real discoverability problem is *other* devices (scorer
    tablets, spectators) finding the address to connect to. The Admin
    UI should prominently display its own LAN-reachable IP address(es)
    and port — ideally as a QR code, since typing an IP:port on a
    phone is painful — for the admin to relay verbally or project on a
    shared screen. This is the same underlying need as the event-code
    idea above (§10, participant SPA) and the "audience display shows
    the code" requirement — worth designing these together rather than
    as separate mechanisms.
  - A machine can have multiple network interfaces (WiFi, Ethernet, a
    VPN adapter) with different IPs — naive detection could show the
    wrong one (e.g. a VPN's address instead of the venue WiFi's),
    stranding every other device. Needs sane filtering/detection, and
    probably a way for the admin to pick manually if more than one
    plausible LAN address is found.
  - Same family of problem, found during Phase 2's review: `plugins_root`
    (like the database path) defaults to a relative path (`./plugins`),
    resolved against whatever directory the process happened to be
    launched from — harmless today since discovery is fail-soft on a
    missing directory, but a real wart for the standalone-executable
    story, where "launched from" won't be an obvious, stable location
    a non-technical user controls.
- **Role-based passwords + token-based admin authentication** (a real
  design for the "auth is a known gap" item already called out
  repeatedly in this spec and in `server/CLAUDE.md`). Captured now from
  a concrete direction the project owner gave, to be fully designed
  when its turn comes:
  - Different passwords for different roles (at minimum Admin; likely
    also a Scorer-type role, possibly others) — set via event
    configuration, not baked into the software.
  - **No password is required or enforced until one is explicitly
    set.** A freshly created event has no auth barrier at all, matching
    the zero-friction "download and try it" experience this project
    prioritizes — but setting the Admin password (and any other role
    passwords) should be one of the first prompts in event setup, so a
    real event doesn't stay wide open by accident.
  - Only an already-authenticated Admin can set or change any role's
    password, including the Admin's own.
  - The Admin's own session should work via a token (the project
    owner's direction: a JWT) issued after presenting the Admin
    password, rather than resending the password on every request;
    admin-privileged endpoints — the plugin-install endpoint being the
    motivating example (§7, §9) — check that token instead.
  - This is a distinct, complementary concern from the Device/
    ScoringDevice admission flow already designed in §4, not a
    replacement for it: role passwords gate *whether you can access a
    given surface at all* (e.g. "do you know the Scorer password"),
    while device admission (friendly names, explicit admit) handles
    *attribution* once inside (e.g. "which specific tablet submitted
    this score") — a future spec should design how the two layer
    together, e.g. whether reaching the scoring UI at all requires the
    Scorer password before a device even gets to the friendly-name/
    admit flow.
  - Open question for that future spec: does a role password also
    gate the admin UI's own web pages (session-cookie-based), or only
    the API layer (bearer-token-based), or both — and how a JWT's
    signing key gets managed for a single-instance local server with
    no separate secrets infrastructure.
