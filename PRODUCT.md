# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React + Vite. Each surface builds to static assets served by the same
Python (FastAPI) server process — no runtime CDN dependency, so the
build works fully offline once packaged. Chosen over Svelte/vanilla for
ecosystem breadth and component-library availability, given three
separate UIs to build.

## Users

- **Event organizer / admin** — sets up and runs a tournament event:
  configures the event, installs/selects a game plugin, manages divisions,
  teams, scheduling, finals brackets, and device admission. Desktop-class,
  config-heavy workflows. Runs on the same machine as the server.
- **Scorer** — enters match scores on a tablet at the field, under time
  pressure between matches. Needs offline-tolerant submission (on-device
  log of every attempt, idempotency keys so a retried request never
  double-applies) since venue WiFi can be unreliable.
- **Pi kiosk display ("Audience Display")** — a passive, large-screen
  view for spectators in the venue (current match, live scores once
  built, rankings, event join code). No input; read-only.
- Auth also defines `judge`, `referee`, and `attendee` roles, but none of
  the three UI surfaces above are scoped for them yet — undecided whether
  they get dedicated interfaces or share an existing one.
- **Deferred, not in scope now:** a read-only, hosted (off-LAN)
  participant/spectator SPA (planned subdomain of `tournamentadmin.net`)
  for parents/students to check a team's schedule and scores from their
  own phone via a short event code, without needing venue network access.
  Captured in the master spec as a future subsystem, to be brainstormed
  and speced separately when its turn comes.

## Product Purpose

A free, self-hostable tournament management system for small
robotics-style head-to-head competitions, with an optional individual
skills-challenge track. Runs from one process against one SQLite file per
event; a "league" is just an event with more than one session.

## Positioning

Game rules and match-scheduling logic are plugin-driven (folder-based,
distributed as zips, discovered/installed at runtime) rather than
hardcoded, because the rules of the underlying competitions change every
season. Free and self-hostable — no vendor lock-in, no required hosted
service for core operation — as the differentiator from closed-source,
subscription/hosted competition-management products.

## Operating Context

- **Venue-local architecture**: the server runs on the admin's own
  machine; other devices (scorer tablets, Pi displays) connect over the
  venue's local WiFi/LAN, which must not depend on internet access to
  function during an event.
- **Real-time updates**: two WebSocket channel kinds — `active-session`
  (followed by Pi displays, scoring devices, and the admin UI by
  default: match start/pause/resume/end, score saved, new match created,
  ranking updated, active-session changes) and `session:<id>` (admin UI
  only, for working on a specific/inactive session without affecting
  what field devices see). Clients resync full state on reconnect, not
  just missed deltas.
- **Device trust**: a `ScoringDevice` admission layer (separate from
  role-based auth) gates score-submission attribution; a similar
  Pi-display admission concept is planned but not yet built.
- **Packaging**: primary distribution is a standalone PyInstaller
  executable per OS (Windows/Mac/Linux); Docker is a secondary option.
  Automatic timestamped SQLite backups on an interval and before risky
  transitions (switching active session, generating an elimination
  bracket), with crash-recovery prompting to restore from the latest
  backup.
- **Plugin installation**: an organizer uploads a plugin zip through the
  admin UI (or drops it into a watched folder); the server validates and
  installs it — the admin UI must support this upload flow.
- **Known, not-yet-fixed gap**: the server currently binds
  loopback-only (`127.0.0.1`), which breaks the very LAN-connected-device
  model this project is built around; a real fix (bind to LAN interface,
  auto-probe free ports, admin UI showing its own LAN IP/QR code for
  other devices to connect to) is planned for the packaging phase, not
  yet built.

## Capabilities and Constraints

- **Hard constraint, binding on every surface**: never reference any
  real-world competition brand or product name anywhere — not in code,
  copy, UI text, or documentation, even when describing behavior that
  happens to match a closed-source reference product. Describe such
  behavior in neutral, generic terms instead.
- Six auth roles exist: `admin`, `scorer`, `judge`, `referee`,
  `attendee`, `display_device`. `admin` always has full access
  regardless of an endpoint's declared allowed-roles list.
- The UI must render dynamically from plugin-declared scoresheet
  schemas (each field carries an explicit key set, including `None`
  values) — never hardcode one game's fields, since the installed game
  plugin can change per event/season.
- A game plugin declares its match model (`head_to_head` or
  `cooperative_score`), alliance count, alliance-selection style, and
  finals format — UI must adapt scoring/ranking/finals displays to
  whichever the active plugin declares, not assume one shape.
- Undecided: whether `judge`, `referee`, and `attendee` roles get
  dedicated UI surfaces of their own, or use existing ones with adjusted
  permissions.
- **Internationalization is a launch requirement, not a later add-on**:
  every UI surface (admin, scorer, and Pi display) must be built
  translation-ready from the start (no hardcoded/concatenated UI
  strings), shipping with English and Chinese translations at launch —
  the two largest target markets. Additional languages are expected
  later but not yet specified. This constrains the stack choice above:
  the React build should use a standard i18n library (e.g.
  `react-i18next` or `react-intl`) rather than ad hoc string handling,
  decided when the first surface's implementation begins.

## Brand Commitments

Product name/domain already secured: `tournamentadmin.net` (with a
planned `scores.tournamentadmin.net`-style subdomain for the future
participant SPA). MIT-licensed, open source. No logo or visual identity
confirmed yet — that's a design decision for later work, not recorded
here.

## Evidence on Hand

No real deployed events, user data, testimonials, case studies, or press
exist yet — this is a pre-launch, greenfield product. Future design work
must not fabricate customer quotes, usage stats, or screenshots of real
events; use clearly-labeled placeholder/sample data instead.

## Product Principles

1. Plugin-driven flexibility over hardcoded game rules — every surface
   renders from what the active plugin declares, not assumptions baked
   into the UI.
2. Local-first, offline-tolerant — no feature may require live internet
   access to function during an event; degrade gracefully on a flaky
   venue network.
3. Right tool per audience, not one UI reused three ways — admin
   (config-heavy, desktop), scorer (touch, time-pressured, must never
   silently lose a submission), and display (passive, distance-readable)
   are genuinely different design problems.
4. Free and self-hostable, no vendor lock-in — never assume a hosted
   service dependency for core operation.
5. Never name a real-world competition brand, anywhere, in any surface's
   copy or code.
6. Translation-ready from day one — no surface ships with hardcoded UI
   strings; English and Chinese are launch requirements, not a later
   retrofit.

## Accessibility & Inclusion

WCAG 2.1 AA required for the admin and scorer UIs (user-confirmed). The
Pi kiosk display's accessibility bar is not yet specified — it's a
passive, distance-viewed screen with no input, a different mode from the
other two; treat as undecided rather than assuming the same standard
applies unchanged.
