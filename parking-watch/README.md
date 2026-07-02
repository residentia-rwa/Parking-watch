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
[{ "slot": "B-114", "flat": "A-204", "name": "...", "phone": "+91...", "email": "...", "carNumbers": ["KA05MN1234", "KA05ZZ9999"], "updatedAt": 1234 }]
```

`server/data/violations.json`
```json
[{ "id": 1234, "ts": 1234, "mySlot": "B-114", "reporterFlat": "A-204", "reporterName": "...", "carSeen": "KA05MN1234", "violatorFlat": "A-204", "violatorName": "...", "status": "reported" }]
```

Writes are queued per-file to avoid corruption from concurrent requests, and
saves are atomic (write to a temp file, then rename).

## Login: email OTP

Login now sends a real one-time code by email instead of just checking a
phone number:

1. Resident enters the email they registered with.
2. Server generates a 6-digit code, emails it, and stores it server-side
   (in memory) for 5 minutes.
3. Resident types the code back in. Server checks it matches and hasn't
   expired, then issues a session token — same as before from here.

This is real proof of access to the account (the inbox), not just knowledge
of a number — closes the gap where anyone who knew a resident's phone
number could log in as them.

**Setup (required before residents can log in for real):**

1. Get or create a Gmail account for the app (e.g. `orchidparkwatch@gmail.com`).
2. Turn on 2-Step Verification on that account (Google Account → Security).
3. Generate an **App Password**: Google Account → Security → App Passwords
   → select "Mail" → generate. Copy the 16-character password.
4. Set these as environment variables (Railway: **Settings → Variables**):
   - `GMAIL_USER` = the Gmail address
   - `GMAIL_APP_PASSWORD` = the app password from step 3 (not your normal
     Gmail password — that won't work for SMTP)

Without these set, the server logs the code to the console instead of
emailing it — useful for local testing, but residents obviously can't log in
for real until they're set.

**Limits:** Gmail SMTP caps around 500 emails/day on a free account —
nowhere close to a problem at 147 units. Rate limiting on `/api/otp/request`
(6/minute/IP) and `/api/otp/verify` (10/minute/IP, 5 wrong-code attempts per
outstanding code) guards against abuse.

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

- Phone numbers and emails are **never sent to the browser** in any listing
  or match response — `publicResident()` in `server.js` strips both from
  every payload except your own session's login response.
- The directory (`GET /api/residents`) and reporting (`POST /api/violations`)
  both **require a session**, obtained by proving access to a registered
  email via a one-time code. Someone with just the link and no registered
  email can't browse the directory or file reports.
- When a report matches a violator, the response contains their name and
  flat — never their number. A **one-time token** is issued instead; hitting
  `/api/notify/:token` redirects to WhatsApp exactly once and expires in 15
  minutes. The number only ever appears at the moment WhatsApp itself opens,
  for the resident who filed that specific report.
- The OTP request endpoint gives the same response whether or not an email
  is registered, so it can't be used to check who's in the directory.
  Rate limiting on `/api/otp/request` and `/api/otp/verify` slows down
  guessing and brute-forcing codes.

**What this protects against now:** unlike the old phone-lookup login,
someone who merely *knows* a resident's phone number or email can no longer
get in — they'd need actual access to that inbox. The gold-standard next
step for this whole app is sending the violation message from a
server-controlled WhatsApp Business number instead of the reporter's own
WhatsApp, so residents never see each other's numbers *at all*, even
momentarily. Worth doing if this becomes a permanent CommUnity module.

## Notes / next steps

- **A slot supports multiple cars.** Registering the same slot again with
  the same email or phone *adds* a plate instead of replacing the old one —
  handles one owner with two cars who parks them one at a time.
- **A slot can change hands.** Registering an already-claimed slot with a
  *different* email/phone is treated as a transfer: the record is replaced
  entirely (new owner's name/flat/cars), the old owner's plates are dropped
  rather than lingering attached to someone else's slot, and any active
  session the old owner had is revoked immediately so they can't keep
  reporting/appearing as that slot's resident. This is self-service by
  design (matching the open-registration model below) — anyone who knows a
  slot number can currently claim it. Fine for a trust-based rollout; add
  committee approval before transfers if that becomes a problem.
- **Unregistered / unmatched plates** (visitors, deliveries, not-yet-registered
  residents) still get logged when reported, but there's no owner to message
  automatically — the reporter sees a "not in directory" message. Worth
  adding an admin-facing "unmatched reports" view or an auto-escalation to
  security's WhatsApp for these, if it becomes a recurring pattern.
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
