# Real Authentication — Design Spec

Status: approved for planning
Date: 2026-09-03

## 0. Project constraint

Nothing in this project's code, comments, documentation, file names, or
user-facing text may reference any real-world competition brand or product
name. All descriptions in this spec are written in neutral/generic terms for
that reason, even where they describe a specific closed-source reference
product's behavior.

## 1. Purpose & scope

Every prior phase has explicitly deferred real authentication: an
`X-Actor-Name` request header lets any caller claim to be anyone (used only
for audit-log attribution, never as a security boundary), and the
plugin-install endpoints execute arbitrary uploaded Python code with no gate
at all. This was an accepted risk for a local-LAN, single-admin-in-the-room
threat model, but it blocks any real multi-role or less-trusted deployment.

`docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md`
("the master spec") already captured a concrete direction from the project
owner for this: role-based passwords, a JWT for the Admin's own session, "no
password enforced until one is set," and an explicit note that this is
complementary to (not a replacement for) the `Device`/`ScoringDevice`
admission flow already designed in that spec's §4. This spec is that
promised future spec, refined and expanded through further discussion with
the project owner into a materially larger and more concrete design than the
master spec's own sketch:

- **Six roles**, not "Admin and maybe Scorer": `admin`, `scorer`, `judge`,
  `referee`, `attendee`, `display_device`.
- **Every event requires a password from the moment it's created** — not
  "no friction until you bother to set one." Creating an event requires one
  password, which becomes every role's password until the Admin
  differentiates them.
- **Every API endpoint requires authentication.** No more anonymous access
  anywhere, for any role.
- A default authorization shape (writes are Admin-only unless stated
  otherwise; reads are open to any authenticated role, not the public) plus
  named exceptions.
- Access + refresh tokens, with server-tracked sessions the Admin can list
  and individually revoke — not just password rotation as the only
  revocation lever.

In scope:
- `RoleCredential` and `AuthSession` data models, plus a persisted JWT
  signing key.
- `POST /api/event` requiring a password; the new `auth` router (login,
  refresh, logout, password-change, session list/revoke).
- A `require_role(...)` dependency applied to every existing endpoint across
  every router, per the authorization table in §4.
- The existing test suite's fixtures updated so all 236 pre-existing tests
  keep passing unchanged (§6) — the actual authorization behavior itself is
  new coverage, not a like-for-like port of existing tests.

Explicitly out of scope / deferred (see §7):
- `Device`/`ScoringDevice` admission (friendly names, pending/admitted
  status, admin accept/reject) — already designed in the master spec's §4,
  still entirely unbuilt (no `Device` or `ScoringDevice` model exists in the
  codebase). Explicitly decided during this phase's brainstorm to stay a
  separate future phase: this spec's password/JWT/role-gating layer is
  designed so a later phase can require an *additionally admitted device*
  on top of a role's session, without changing anything built here.
- "Inspection" and "judged awards" role rules — the project owner named
  these as a future Referee exception (read/write on inspection and
  scoring, but not on judged awards), but neither concept exists as an
  endpoint anywhere in the codebase yet. Whenever they're built, they use
  the same `require_role` mechanism this spec introduces.
- Password complexity requirements, brute-force/rate-limiting protection on
  login — not requested; the project's threat model has consistently been
  local-LAN/single-instance.
- Any UI or cookie-based session — moot today, since this project has no
  server-rendered pages at all (confirmed: no template rendering or HTML
  responses anywhere in the codebase). Every existing endpoint is a JSON
  API, so bearer-token-only auth is the only mechanism that applies right
  now. This also resolves one of the master spec's own open questions (does
  a role password gate cookie-based web pages, the API layer, or both) —
  there are no cookie-based pages to gate.

## 2. Data model

- **`RoleCredential`** (new table, one row per role): `id`, `role: str`
  (one of the six role names), `password_hash: str`. All six rows are
  created together, sharing one hash, the moment `POST /api/event`
  succeeds. Each row's hash can later be changed independently.
- **`AuthSession`** (new table, one row per issued refresh token): `id`,
  `role: str`, `refresh_token_hash: str` (only the hash is ever stored —
  same principle as the password; the raw refresh token is returned to the
  caller exactly once, at login or refresh), `issued_at`, `expires_at`,
  `revoked_at: datetime | None`, `label: str | None` (an optional
  free-text hint the login request can supply, e.g. "scoring tablet, Field
  3" — purely for making the Admin's session list legible; not tied to real
  device admission, which stays deferred per §1). Access tokens (JWTs) are
  never persisted anywhere — they're stateless, verified only by signature
  and expiry, never looked up in the database.
- **A signing-key row** (new tiny singleton table, mirroring the existing
  `Event` singleton pattern): a randomly-generated key created the first
  time it's needed, persisted in the same SQLite database, reused across
  restarts. This needs no separate secrets infrastructure for a
  single-instance local server, and it resets along with everything else
  if the `.db` file is ever deleted — this project's existing convention
  for every prior schema change (§8).
- `Event` gains no new columns. Password state lives entirely in
  `RoleCredential`, decoupled from the `Event` row.

## 3. Auth endpoints

- **`POST /api/event`** — request body gains a required `password: str`.
  On success, creates the `Event` row and all six `RoleCredential` rows
  (hashed from that one password) together, in the same transaction.
- **`POST /api/auth/login`** — body `{role: str, password: str, label:
  str | None}` → `{access_token: str, refresh_token: str, expires_in:
  int}`. Validates `role` is one of the six known names (422 otherwise),
  checks the password hash (401 on mismatch), issues a short-lived JWT
  access token (claims: `role`, `exp`, `iat` only — nothing else, and
  never looked up against the database to verify) and a longer-lived
  refresh token recorded as a new `AuthSession` row.
- **`POST /api/auth/refresh`** — body `{refresh_token: str}` → a new
  `{access_token, refresh_token, expires_in}`. Validates the token against
  `AuthSession` (hash match, `revoked_at IS NULL`, not expired — 401
  otherwise), then **rotates** it: the old `AuthSession` row is marked
  revoked and a new one is created for the new refresh token. This makes
  replaying an old, already-rotated refresh token fail immediately rather
  than silently succeed.
- **`POST /api/auth/logout`** — revokes the caller's own current
  `AuthSession` (identified by the refresh token supplied in the request
  body, `{refresh_token: str}`). Any authenticated role may call this for
  itself.
- **`PATCH /api/auth/passwords/{role}`** — **Admin-only.** Body
  `{password: str}`. Updates that role's `password_hash` and, in the same
  transaction, sets `revoked_at` on every currently-active `AuthSession`
  row for that role. This is what makes "rotate the password" actually
  mean "everyone currently using it is logged out," not merely "new
  logins need the new password" — the revocation guarantee the project
  owner specifically asked for.
- **`GET /api/auth/sessions`** — **Admin-only.** Lists active (not
  revoked, not expired) sessions: `id`, `role`, `issued_at`, `label`. What
  the Admin reviews before deciding what to revoke.
- **`DELETE /api/auth/sessions/{id}`** — **Admin-only.** Revokes one
  specific session (404 if it doesn't exist). The "kick this one rogue
  device" action, independent of the shared role password and every other
  session on that role.

Revoking a refresh token does not retroactively invalidate an
already-issued access token — it only prevents that refresh token from
being renewed. The exposure window after a revocation is bounded to that
access token's own short remaining lifetime (§5). This is a deliberate,
standard access/refresh-token trade-off, not a gap: verifying every access
token against the database on every request would defeat the point of a
stateless token.

`POST /api/event`, `GET /api/event` (when no event exists yet), `POST
/api/auth/login`, and `POST /api/auth/refresh` are the only endpoints that
ever run with no `Authorization` header at all — they are the bootstrap
surface itself. Nothing else can require auth before an event and its
`RoleCredential` rows exist.

New dependencies: `PyJWT` (token issuance/verification) and `bcrypt`
(password hashing) — both small, single-purpose, widely-used libraries;
no broader framework (e.g. `passlib`) is needed since only one hashing
algorithm is ever used.

## 4. Enforcement & per-endpoint authorization

A `require_role(*allowed_roles)` FastAPI dependency, applied explicitly via
`Depends(...)` on every endpoint — the same way `Depends(get_db)` already is
everywhere in this codebase. Explicit per-endpoint declaration (not an
implicit default keyed off HTTP method) is a deliberate choice: a
security-relevant requirement should be visible and auditable at the
endpoint that has it, not inferred from a convention that could silently be
wrong for some future endpoint that doesn't fit the GET-vs-write pattern.

The dependency: extracts and validates the `Authorization: Bearer <JWT>`
header (401 if missing, malformed, expired, or signature-invalid), then
checks the token's `role` claim is a member of `allowed_roles` (403
otherwise). **`admin` always passes**, regardless of what `allowed_roles`
lists — it is the superuser role by definition, so no exception list ever
needs to spell out `admin` explicitly.

Applying the project owner's stated default (writes Admin-only, reads open
to any authenticated role) across every existing router, with two named
exceptions:

| Router(s) | Writes (POST/PATCH/DELETE) | Reads (GET) |
|---|---|---|
| `event`, `sessions`, `divisions`, `field_sets`, `fields`, `teams`, `participation`, `matches`, `ranking_configuration`, `schedule`, `finals` | `admin` only | any authenticated role |
| `scores` | `admin`, **`scorer`, `referee`** | any authenticated role |
| `audit_log` | *(read-only router)* | **`admin` only** — operational/sensitive, not event-day data |
| `plugins` | `admin` only | **`admin` only** — operational/config surface, not event-day data |
| `auth` | `login`/`refresh`: no token required; `logout`: any authenticated role; `passwords/{role}`, `sessions` (list/revoke): `admin` only | — |

## 5. Token lifetimes

Access tokens: 30 minutes. Refresh tokens: 14 days. Both are ordinary
configuration values, not load-bearing design decisions — they can be
tuned during implementation or afterward without any structural change to
this design.

## 6. Testing

**Existing suite compatibility.** 236 pre-existing tests never send an
`Authorization` header, and dozens create their own event inline (several
duplicated `_setup_ready_session`/`_make_session`-style helpers, plus many
raw inline `POST /api/event` calls scattered directly across roughly 15
test files). Rewriting all of them to log in and attach a token would be a
large, error-prone mechanical migration for no real benefit — none of them
are testing authentication, they're testing the behavior auth now wraps.

Instead: the shared `client`/`cooperative_client`/`captain_pick_client`
fixtures in `conftest.py` use a thin `TestClient` subclass that intercepts
`POST /api/event` specifically — if the request body has no `password`, it
injects a fixed test password before sending; immediately after a
successful (201) creation, it transparently calls `POST /api/auth/login`
as `admin` with that same password and sets `Authorization: Bearer
<token>` as a default header for every subsequent request that client
instance makes. Every one of the 236 existing tests keeps passing
completely unchanged, always implicitly acting as Admin — exactly what
they already assumed before this phase existed. A test that specifically
wants to exercise another role, a missing/invalid token, or the bootstrap
flow itself constructs its own raw, unwrapped client rather than using the
auto-authenticating fixture.

**New coverage:**
- `auth` module: login for each of the six roles; wrong password; unknown
  role name; refresh (success, rotation, and that replaying the
  now-rotated old refresh token fails); logout; admin-only
  password-change, verified to actually revoke every existing session on
  that role (a session's refresh token stops working after the change);
  admin-only session list/revoke; a non-admin attempting the admin-only
  auth endpoints gets 403.
- Event creation: requires `password` (422 if omitted); creates all six
  `RoleCredential` rows sharing one hash; changing one role's password
  later does not affect the others.
- A handful of representative 401 (no token) / 403 (wrong role) checks
  spread across a few different existing routers (not every endpoint) to
  prove the `require_role` wiring is actually active everywhere — the
  mechanism itself is uniform and only needs to be proven correct once
  per distinct role-set shape (Admin-only write, any-role read, the
  `scores` exception, the `audit_log`/`plugins` read exception).

## 7. Deferred / open items

- `Device`/`ScoringDevice` admission — a separate future phase, per §1.
  This design leaves the seam for it: a later phase can require a
  session's underlying device to *also* be admitted, layered on top of
  the role check this phase builds, without changing anything here.
- "Inspection" and "judged awards" role rules — no such endpoints exist
  yet; use `require_role` the same way when they're built.
- Password complexity requirements — unenforced for v1 (any non-empty
  string), matching the zero-friction "download and try it" philosophy
  this project has consistently prioritized; easy to add later without
  restructuring anything.
- Brute-force/rate-limiting protection on login — not requested, and this
  project's threat model has consistently been local-LAN/single-instance
  through every prior phase; a real gap if that threat model ever changes,
  not built now.
- Tuning access/refresh token lifetimes (§5) — ordinary configuration, not
  a structural decision.

## 8. Migration note

This is a schema change (two new tables, one new singleton table) on top
of every prior phase's own schema changes — same situation as always: no
real deployed event data exists yet, so a pre-this-phase database is
recreated (delete the `.db` file), not migrated.
