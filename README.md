# Parking Watch — Orchid Park

A slot directory + one-tap parking violation reporting app. Installable as a
PWA on any phone, no app store needed. Data is stored in plain JSON files on
the server (`server/data/residents.json`, `server/data/violations.json`) —
no database to provision.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000` on your phone (same wifi network — use your
computer's local IP, e.g. `http://192.168.1.23:3000`) or on your laptop
browser to test.

## Install as an app on a phone

1. Open the deployed URL in Chrome (Android) or Safari (iOS).
2. Android: tap the menu (⋮) → **Add to Home screen**.
   iOS: tap the Share icon → **Add to Home Screen**.
3. It now opens full-screen with its own icon, like a native app.

## Deploy to Railway

1. Push this folder to a GitHub repo (or use `railway up` directly from here).
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
3. Railway auto-detects Node and runs `npm install && npm start`. No env
   vars are required — it just needs a writable filesystem, which Railway
   provides.
4. **Important:** Railway's filesystem is ephemeral on redeploys unless you
   attach a **Volume**. In your Railway project: **Settings → Volumes →
   New Volume**, mount it at `/app/server/data`. Without this, a redeploy
   wipes the JSON data.
5. Once deployed, share the Railway URL (or your custom domain, similar to
   how `orchidpayfees.in` is set up) with residents — they install it from
   the browser as above.

## How it works

- **Directory tab** — residents self-register their slot, flat, name,
  WhatsApp number, and plate once.
- **Report tab** — enter your slot and the plate blocking it. If that plate
  is registered, the server matches it to an owner and the app gives you a
  pre-filled WhatsApp link — one tap, no typing.
- **Log tab** — every report is timestamped and kept, with a "repeat flats"
  list so the committee can spot chronic offenders.

## Data model

`server/data/residents.json`
```json
[{ "slot": "B-114", "flat": "A-204", "name": "...", "phone": "+91...", "carNumber": "KA05MN1234", "updatedAt": 1234 }]
```

`server/data/violations.json`
```json
[{ "id": 1234, "ts": 1234, "mySlot": "B-114", "reporterFlat": "A-204", "reporterName": "...", "carSeen": "KA05MN1234", "violatorFlat": "A-204", "violatorName": "...", "status": "reported" }]
```

Writes are queued per-file to avoid corruption from concurrent requests, and
saves are atomic (write to a temp file, then rename).

## Committee / admin access

The Log tab shows different things depending on who's looking:

- **Regular residents** see only the reports *they* filed — useful for
  checking "did this get resolved," nothing about anyone else's history.
- **Admins** (committee members) see the full log across the community,
  plus the repeat-offender list by flat.

There's no admin UI yet — promote someone by setting an `ADMIN_SETUP_KEY`
environment variable on Railway (any random string, not committed to the
repo), then calling once:

```bash
curl -X POST https://your-app.up.railway.app/api/admins \
  -H "Content-Type: application/json" \
  -H "x-admin-setup-key: YOUR_ADMIN_SETUP_KEY" \
  -d '{"phone": "+919876543210"}'
```

That phone number (must match how they registered) becomes an admin. If
`ADMIN_SETUP_KEY` isn't set, this route refuses everything — safe to leave
deployed. Repeat for each committee member.

## Privacy model

- Phone numbers are **never sent to the browser** in any listing or match
  response — `publicResident()` in `server.js` strips it from every payload
  except the login flow itself.
- The directory (`GET /api/residents`) and reporting (`POST /api/violations`)
  both **require a session**, obtained by verifying a phone number that's
  already registered. Someone with just the link and no registered phone
  can't browse the directory or file reports.
- When a report matches a violator, the response contains their name and
  flat — never their number. A **one-time token** is issued instead; hitting
  `/api/notify/:token` redirects to WhatsApp exactly once and expires in 15
  minutes. The number only ever appears at the moment WhatsApp itself opens,
  for the resident who filed that specific report.
- Basic rate limiting on `/api/verify` (10 attempts/minute/IP) to slow down
  guessing.

**What this does *not* protect against:** "verify by phone" isn't real
authentication — anyone who already knows a resident's phone number could
type it in and get a session as them. That's an acceptable tradeoff for an
internal 147-unit app with no password/OTP infra, but if you want it
tightened, the real fix is a WhatsApp OTP at verification time — which needs
the WhatsApp Business API (similar to what you built for UnifiedInbox). The
gold-standard version of this whole app sends the violation message from a
server-controlled WhatsApp Business number instead of the reporter's own
WhatsApp, so residents never see each other's numbers *at all*, even
momentarily. Worth doing if this becomes a permanent CommUnity module.

## Notes / next steps

- No push notifications (JSON-file PWAs can't do iOS push reliably) — the
  one-time WhatsApp link is the notification channel for now.
- Registration itself is still open (anyone can add a slot/phone/plate) —
  low risk since residents are only adding their own info, but nothing stops
  someone entering a slot that isn't theirs. Fine for a trust-based rollout;
  add committee approval or OTP-verified registration if that becomes an
  issue.
- If you want to fold this into CommUnity later, the `residents.json`
  structure maps directly onto a `residents` table — swapping the file-based
  `db.js` for a real DB, and sessions for a proper auth table, is a contained
  change; the API routes don't need to move.
