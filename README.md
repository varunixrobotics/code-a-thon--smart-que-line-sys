# SmartQueue — Smart Public Service Queue Management System

Digital tokens, appointments and live queues for government offices, hospitals,
banks and company front desks. **Skip the queue. Not the service.**

## Quick start

```bash
npm install
npm start            # http://localhost:3000
npm test             # 40 unit, service and API tests
```

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`, so no native build tools are needed).

On first start the console prints a one-time **admin password** for
`admin@smartqueue.local`. Sign in at `/login.html` and link an authenticator
app. Admin and staff accounts always need one. The dashboard is at `/admin.html`.

Copy `.env.example` to `.env` to configure Google sign-in, the admin account and production settings.

## What's inside

| Feature | How it works |
|---|---|
| **Token generation** | `token = slot × capacity + seat + 1`, so the number depends only on *your* time slot. Walk-ins get the next free seat today. |
| **Appointments** | Book up to 14 days ahead. Rescheduling changes **only your token**, and everyone else keeps theirs. |
| **Live queue** | Server-Sent Events push a per-centre snapshot (counters, waiting list, KPIs) the instant anything changes. |
| **Counter assignment** | Only **checked-in** tokens are called, earliest slot first. Auto-assign fills free counters, least-busy first. |
| **Geofenced check-in** | The browser's location is compared to the centre's geofence (radius + GPS accuracy, capped). Inside means checked in, and leaving puts the token on hold. |
| **Absent users** | Reminder 15 min before the slot. 10 min after the slot, if not checked in, the token **moves to a later free slot** without shifting anyone else. After 2 moves it expires and counts as a no-show strike. |
| **Notifications** | In-app feed and toasts over SSE, plus browser notifications when allowed. The "your turn" alert also vibrates the phone. |
| **Admin dashboard** | Counters (call, complete, recall, no-show, pause), today's queue with desk check-in, hourly and status charts, geofence editor, bot signals and audit log. |

## Security & abuse prevention

- **Two-factor sign-in:** Google Identity Services (ID token verified server-side, email must be verified), or email and password plus an **authenticator app (TOTP)**. Codes can't be replayed. TOTP seeds are **AES-256-GCM encrypted at rest**, and passwords are hashed with **scrypt**.
- **Sessions:** random 256-bit IDs; only their SHA-256 is stored. Cookies are `HttpOnly; SameSite=Strict` (plus `Secure` and `__Host-` in production). The session ID is rotated after the second factor.
- **Bot detection:** the browser sends raw pointer and typing-*timing* telemetry, and the **server** scores it (speed variance, straightness, jitter, repeated steps, timing regularity, click approach). Automation flags and synthetic events are blocked. Unclear cases get a press-and-hold check that is **timed by the server**, so scripts can't skip the wait.
- **Abuse limits:** honeypot field; rate limits for sign-in, codes, bookings and location updates; one live token per place per day; at most 3 active tokens; 3 no-shows pause booking for 7 days.
- **Web hardening:** strict CSP (no inline scripts), JSON-only writes and an Origin check (CSRF), zod validation on every input, escaped rendering, and generic error messages.

## Concurrency & scaling

- Every token is issued inside a `BEGIN IMMEDIATE` transaction, and a **partial unique index** on `(service, date, slot, seat)` makes double-issuing a seat impossible, even across processes.
- SQLite in WAL mode handles a single busy centre comfortably. To scale out, swap the in-process SSE hub (`server/lib/events.js`) for Redis pub/sub and move to Postgres. The service layer doesn't change.

## Project layout

```
server/
  app.js, index.js      Express app & entry point (monitor job, demo simulator)
  services/             booking, presence (geofence), counters, stats, notifier
  routes/               auth, public, bookings, admin
  middleware/           sessions, human check, CSRF / rate limits / audit
  lib/                  slots, geo, botScore (shared with browser), crypto, SSE hub
public/
  index.html            landing page with live widgets (10 sections)
  login.html app.html admin.html
  css/tokens.css        light / neutral gray / dark design tokens
tests/                  node:test suites
```

## Demo tips

- `DEMO_MODE` (on by default in development) simulates walk-ins and counters, so the live screens keep moving.
- To demo geofencing from your own location, open **Admin → Geofence → Use my current location → Save**, then book a token for that centre and tap **Check in with location**.
- The **Abuse Prevention** section on the landing page shows a live human-signal score for your own cursor.
