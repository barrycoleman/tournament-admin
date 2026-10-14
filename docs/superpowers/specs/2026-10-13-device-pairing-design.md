# Device Pairing — Design

**Status:** approved in brainstorming 2026-10-13.

**Builds on:** the core architecture spec (§3 `Device`, §4 "Device admission", §10 gap review), the scoring device admission design (`2026-09-08-scoring-device-admission-design.md`), real authentication (`2026-09-03-real-authentication-design.md`) and the realtime design (`2026-09-11-realtime-websockets-design.md`).

**Replaces:** the self-registering `ScoringDevice` flow (`POST /api/devices/register`, admit, revoke, the `X-Device-Token` header) and the core spec's Pi display found by IP. Every device that is not the admin's own browser joins by pairing.

**Leads to:** display groups and screens, queueing, and the scorer app. This project builds the pairing and the device list only; a paired device shows a placeholder home page.

## 1. Problem

Scorer tablets must type the scorer password and then wait for an admin to admit them; the admit endpoints have no UI. Displays have no way in at all, and a TV can't type a password. The event needs one way for any browser (Smart TV, laptop, phone, tablet) to become a trusted device with a role, set up by an admin in a few seconds.

## 2. Goals

- Any browser opens the server address and shows a short pairing code and a QR code; an admin enters or scans the code and picks the device's role.
- Pairing grants the role. The device never types a password.
- The device stays paired across reloads and reboots.
- Admins can rename a device, change its role, disable, enable and delete it.
- Operator devices are disabled after an idle period that the admin sets; displays never are.
- Scores stay attributed to a named device.

### Non-goals

- What a paired display or scorer shows beyond a placeholder (later display-groups and scorer specs).
- Pairing the admin role. Admins sign in with the admin password, as today.
- Pairing the attendee role (read-only; the public participant app covers spectators later).
- Showing the server's LAN address as a QR code in the admin app (a separate gap, §10).

## 3. Roles and passwords

- **Pairable roles:** `scorer`, `referee`, `judge`, `front_desk` (shown as "Check-in") and `display_device` (shown as "Display").
- **Role passwords stay** for anyone who signs in on an ordinary browser without pairing: the admin, or a judge on their own laptop. Nothing about password sign-in changes.
- **Scoring needs a paired device.** `POST /api/matches/{id}/alliances/{id}/score` and `POST /api/sessions/{id}/skills/attempts` need a request from an active paired device with a scorer or referee role, or an admin (who needs no device). Someone signed in with the scorer password on an unpaired browser gets 403 "Only a paired device can submit scores." This is today's rule with pairing in place of admission.
- **Attribution:** `ScoreRecord.submitted_by_device` holds the device's name at the moment of the submission, as today. Renaming a device doesn't rewrite old records.

## 4. Pairing flow

### 4.1 Pairing codes

- **Requesting:** `POST /api/pairing` (no login) returns `{id, code, poll_key, expires_at, expires_in}`. The device counts down from `expires_in` (seconds), not `expires_at`, because a TV's clock is often wrong.
- **Code:** 6 characters from `ACDEFGHJKMNPQRTUVWXY34679` (no `0`/`O`, `1`/`I`/`L`, `2`/`Z`, `5`/`S`, `8`/`B`), shown as two groups of three (`KX4 9TM`). A code is unique among open codes.
- **Expiry:** 5 minutes. The device requests a new one by itself when it expires.
- **Storage:** in server memory only (`app.state.pairing`), never in the tournament file, so pairing traffic never takes a backup or writes the audit log. A restart drops open codes; the device just shows a new one.
- **Cap:** at most 50 open codes; a new request past that drops the oldest open code.
- **Suggested name:** each code carries a suggested adjective-animal name (today's word lists), unique among existing devices and open codes.

### 4.2 Admin pairs the code

- **Checking a code:** `GET /api/pairing/codes/{code}` (admin) returns `{code, suggested_name, expires_at}`, or 404 "That code isn't valid or has expired." The code is matched ignoring case, spaces and dashes.
- **Pairing:** `POST /api/devices/pair` (admin) with `{code, role, name}`:
  - 404 for an unknown or expired code (same message);
  - 422 for a role that can't be paired, or a blank name or one over 100 characters;
  - 409 "A device with that name already exists." for a duplicate name (names are unique, compared case-insensitively);
  - otherwise creates the `Device`, attaches a new device token to the open code, and returns the `DeviceRead` (201).

### 4.3 The device collects its token

- **Polling:** the device calls `GET /api/pairing/{id}` with header `X-Pairing-Key: <poll_key>` every 2 seconds. It returns `{status: "waiting"}`, `{status: "paired", device_token}` or `{status: "expired"}`. A wrong key or unknown id is 404, and the device treats a 404 like `expired`: it asks for a new code. A paired code stays collectable for 60 seconds past its expiry, so a pairing made in the last seconds isn't lost.
- **Exactly once:** the first `paired` response hands over the token and removes the code; a later poll is 404.
- **Storage on the device:** the device token is kept in `localStorage`.

### 4.4 The device signs in

- **`POST /api/auth/device`** (no login) with `{device_token}`:
  - unknown token (never existed, or deleted): 401;
  - disabled or idle: 403 `{detail, status, name}` where `status` is `disabled` or `idle`;
  - active: 200 with the usual access token (30 minutes), whose claims carry the device's `role` and a `device_id`.
- **Refreshing:** the device swaps its device token again before the access token expires. There is no refresh token for devices.
- **Every request is checked:** when an access token carries `device_id`, `require_role` loads that device and refuses the request (401 if deleted, 403 if disabled or idle) and uses the device's current role, not the role in the token. Disabling, deleting or changing a role therefore takes effect on the very next request.
- **WebSockets:** the same check runs when a socket connects. The connection registry records each socket's `device_id`; disabling, deleting or changing a device's role closes its open sockets (close code 4403), so the device reconnects and sees its new state.

## 5. Devices

### 5.1 The `devices` table (replaces `scoring_devices`)

| Column | Notes |
|---|---|
| `id` | |
| `name` | unique, case-insensitive (stored with a `name_key` lower-case unique column) |
| `role` | one of the pairable roles |
| `token_hash` | SHA-256 of the device token, unique |
| `paired_at`, `paired_by` | |
| `last_seen_at` | |
| `disabled_at` | null unless an admin disabled it |

The baseline migration is edited in place: `scoring_devices` goes, `devices` comes in, and `events` gains `device_idle_minutes` (integer, default 240).

### 5.2 Status

Worked out when read, never stored:

- **Disabled:** `disabled_at` is set.
- **Idle:** the role isn't `display_device` and `now - last_seen_at` is at least the event's `device_idle_minutes`.
- **Active:** otherwise.

`last_seen_at` is refreshed by any successful request from an active device, at most once a minute (so a busy display doesn't write on every request). An idle device's requests never refresh it, so idle stays idle until an admin enables it (today's one-way rule).

### 5.3 Admin API (admin only; any other role gets 403)

- `GET /api/devices`: every device as `DeviceRead {id, name, role, status, paired_at, paired_by, last_seen_at, disabled_at}`, by name.
- `PATCH /api/devices/{id}`: `{name?, role?}`, the same name and role rules as pairing.
- `POST /api/devices/{id}/disable`, `POST /api/devices/{id}/enable`: enable clears `disabled_at` and refreshes `last_seen_at` (which also clears idle).
- `DELETE /api/devices/{id}`: 204; the device's next request is 401 and it goes back to pairing.
- `GET`/`PUT /api/devices/settings`: `{idle_minutes}`, 15 to 1440.
- `GET /api/devices/me` (any paired device): its own `{id, name, role, status}`.

### 5.4 Audit and realtime

- `devices` stays out of the generic audit hook (so `token_hash` never reaches the log). Pair, rename, role change, disable, enable, delete and the idle setting each write one curated `AuditLog` entry with the name and role before and after.
- Each of those writes broadcasts `devices_changed {}` on the active-session channel. The admin Devices page refetches on it and when the window regains focus (idle status and last seen change without an event).

### 5.5 Removed

`POST /api/devices/register`, `.../admit`, `.../revoke`, the `X-Device-Token` header and its middleware, `TOURNAMENT_DEVICE_IDLE_TIMEOUT_MINUTES` and `require_admitted_device` (replaced by a `require_paired_scoring_device` dependency with the rule in §3).

### 5.6 Backups

A restore brings the device list back to the backup's moment (already stated in the backups spec). A device paired after the backup gets 401 and pairs again.

## 6. Admin app: Devices page

- **Navigation:** a new admin-only item **Devices** at `/devices`.
- **Pair a device:** a code input (any case; spaces and dashes ignored), a role select, a name input filled with the suggested name once the code checks out, and **Pair**. Errors show inline (unknown or expired code, duplicate name). `/devices?pair=<code>` fills in the code and checks it; an admin who isn't signed in signs in first and returns to that URL.
- **Device table:** name, role, status badge (Active, Idle, Disabled), last seen (relative, e.g. "3 min ago"), and per row **Edit** (name and role in a dialog), **Disable** or **Enable**, and **Delete** (`ConfirmDialog`: "Delete {name}? It will need to be paired again.").
- **Idle setting:** "Disable operator devices after [240] minutes without activity. Displays are never disabled for inactivity."
- **Strings:** English and Chinese.

## 7. Device app

A new Vite app, `frontend/apps/device`, in the existing npm workspace, using `frontend/packages/shared` (for i18n setup), React, react-i18next and `qrcode`. React Router and TanStack Query join when the scorer and display screens need them. The device keeps its own storage key (`tournament-admin.device.v1`) and its own small fetch helper, because it shares an origin with the admin app and must never read or overwrite the admin's sign-in.

### 7.1 Serving

- The device app is built with `base: "/device/"`. The server serves its `dist/` under `/device/` with its own SPA fallback, registered before the admin app's catch-all.
- `GET /pair` redirects (307) to `/device/`, so a TV only needs to type `<address>/pair`.
- The admin sign-in page gains a **Pair this device** button linking to `/pair`.

### 7.2 Screens

- **Pairing** (no device token stored):
  - the code in very large type, sized to read from 3 metres on a TV;
  - a QR code encoding `<server origin>/devices?pair=<code>`;
  - "In the admin app, open Devices and enter this code.";
  - a countdown to expiry and a new code requested automatically;
  - nothing to click, so a TV remote isn't needed.
- **Home** (paired and active): "Paired as **{name}** — {role}. Ready." The later scorer and display projects replace this screen. It keeps a live connection open; when the server closes it with 4403 (disabled, deleted or role changed) it signs in again at once and shows the result. It renews its access token a minute before it expires.
- **Disabled or idle:** "This device is disabled. Ask an admin to enable **{name}**." It retries `POST /api/auth/device` every 30 seconds (a disabled device can't open a live connection) and returns home when it succeeds.
- **Deleted or unknown token:** clears the stored token and shows a new pairing code.
- **Server unreachable:** "Can't reach the server. Retrying…", keeping the current screen underneath and resuming when the server answers.
- **Strings:** English and Chinese, with the same language selection as the admin app.

## 8. Testing

### Server (pytest)

- **Codes:** the alphabet and format; uniqueness among open codes; expiry; the 50-code cap dropping the oldest; matching ignoring case, spaces and dashes.
- **Polling:** waiting, paired then gone (token handed over once), expired, wrong key 404.
- **Pairing:** each pairable role; `admin` and `attendee` refused; duplicate names (case-insensitive); blank and overlong names.
- **Device sign-in:** active, disabled, idle and deleted tokens; the issued token's role and `device_id`.
- **Per-request check:** disable, delete and role change take effect on the next request; sockets are closed on each.
- **Status:** idle after the timeout for operator roles, never for displays; idle requests don't refresh `last_seen_at`; enable clears idle; `last_seen_at` written at most once a minute.
- **Scoring:** scores and skills attempts from an active paired scorer or referee (attributed to its name), refused for an unpaired password sign-in, an idle or disabled device and a paired judge; admin still needs no device.
- **Admin API:** rename, role change, disable, enable, delete, settings bounds; 403 for every non-admin role; one audit entry per action without the token hash; `devices_changed` broadcast.
- **Serving:** `/pair` redirects; `/device/...` serves the device app and falls back to its `index.html`; the admin fallback is unchanged.

### Vitest

- Admin: the Devices page (pair form states and errors, table, edit, disable/enable, delete confirm, idle setting, `?pair=` prefill).
- Device: pairing screen (code, QR, countdown, renewal), home, disabled, deleted, unreachable.

### Playwright

Two browser contexts (admin and device) on their own ports:

- **Golden path:** the device shows a code; the admin pairs it as a scorer; the device shows its home page and stays paired after a reload.
- **Disable and enable:** disabling shows the disabled screen; enabling returns it home.
- **Delete:** the device goes back to a new pairing code.
- **QR link:** opening `/devices?pair=<code>` fills in and checks the code.
- **Expired code:** the admin's pair attempt shows the expired-code error.
