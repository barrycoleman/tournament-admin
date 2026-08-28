# Project instructions for Claude Code

## What this project is

A free, self-hostable tournament management system for small robotics-style
head-to-head competitions with an optional individual skills-challenge
track. Single/multi-session events (a "league" is just an event with more
than one session) run from one process against one SQLite file. Game rules
change every season, so scoring is implemented as a plugin system rather
than hard-coded — the same is true of match scheduling.

The full architecture — data model, plugin contracts, real-time event
model, device admission, error handling, packaging, and the plugin
compliance tool — is written down in
`docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md`.
Read that before making any change that touches the data model, the
plugin interfaces, or the API/WebSocket contract. Later specs for the
admin UI, scorer/tablet UI, and Raspberry Pi display client live in the
same `docs/superpowers/specs/` directory as they're written.

## Hard constraint — read this first

**Never reference any real-world competition brand or product name**
anywhere in this repository: not in code, comments, docstrings, commit
messages, file/variable/class names, documentation, or user-facing text.
This applies even when describing behavior that happens to match a
closed-source reference product's behavior — describe it in neutral,
generic terms instead. This rule applies to every fork and every
contributor session, not just the original author's.

## Tech stack

- Server: Python, FastAPI + Uvicorn, SQLAlchemy over SQLite (one file per
  event).
- Real-time: WebSockets (native FastAPI support), not polling.
- Frontends: plain SPAs (admin, scorer/tablet, display) served as static
  assets by the same server process. Framework choice is decided in the
  UI-specific specs, not here.
- Plugins: folder-based, distributed as zip packages, discovered at
  runtime — see the design spec for the full contract.
- Packaging: standalone executable (PyInstaller) is the primary
  distribution target; a Docker image is secondary.

## Testing policy (mandatory, not optional)

- Every backend feature ships with **pytest unit tests** alongside it in
  the same change, not as follow-up work.
- Every API and WebSocket flow gets **integration tests** run against a
  real (test) FastAPI instance and a real (temp-file) SQLite database —
  not mocked at the HTTP/WebSocket boundary.
- Every plugin (game or scheduler) must pass the `tm test-plugin`
  conformance tool before it's considered done; when changing the plugin
  interface itself, update the conformance tool in the same change.
- Every piece of UI work (admin, scorer/tablet, display, or Pi client)
  requires **Playwright end-to-end tests** covering its golden path and
  its important edge cases (e.g. offline/reconnect behavior, out-of-range
  score entry, device admission) before being considered done — not just
  type-checking or a manual look. If Playwright genuinely doesn't fit a
  given surface (e.g. the Pi kiosk boot flow), use the closest equivalent
  UI-testing tool and say so explicitly rather than skipping UI testing.
- A change is not complete until its tests exist and pass, per this
  repo's testing policy — this overrides any general instinct to treat
  test-writing as optional polish.

## Workflow expectations for contributors using Claude Code

This project was designed using Claude Code's `superpowers` skill set:
brainstorm → write a spec → write an implementation plan → implement with
TDD. Forks and contributors are encouraged to follow the same shape for
non-trivial changes: read the relevant spec (or write one, for a new
subsystem) before writing code, and use test-driven development for
implementation. This keeps forks easy to reconcile with upstream and keeps
the plugin ecosystem's compliance guarantees meaningful.

## License

MIT — see `LICENSE`. Contributions are expected to remain under the same
license.
