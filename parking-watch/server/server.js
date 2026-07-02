const express = require("express");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { readCollection, writeCollection, appendOrReplace, withCollection } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ---------- Email (OTP delivery) ----------
// Uses a free Gmail account via SMTP + an App Password (not your normal
// Gmail password — generate one at myaccount.google.com/apppasswords after
// enabling 2-Step Verification). Set these as env vars, never commit them.

const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

async function sendOtpEmail(to, code) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    // Fail loudly in logs but don't crash the request — lets you test the
    // rest of the flow locally before wiring up real credentials.
    console.warn(`GMAIL_USER/GMAIL_APP_PASSWORD not set — would have sent code ${code} to ${to}`);
    return;
  }
  await mailer.sendMail({
    from: `"Parking Watch — Orchid Park" <${process.env.GMAIL_USER}>`,
    to,
    subject: `Your Parking Watch code: ${code}`,
    text: `Your verification code is ${code}. It expires in 5 minutes. If you didn't request this, ignore this email.`,
  });
}

// ---------- Minimal in-memory rate limiting ----------
// Not a substitute for real OTP verification, but it stops trivial
// scripted guessing of phone numbers or plates from this endpoint.
const hits = new Map(); // ip -> [timestamps]
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      return res.status(429).json({ error: "Too many attempts. Wait a bit and try again." });
    }
    arr.push(now);
    hits.set(ip, arr);
    next();
  };
}

const clean = (s) => (s || "").toString().trim();
const cleanPlate = (s) => clean(s).toUpperCase().replace(/\s+/g, "");
const cleanPhone = (s) => clean(s).replace(/[^0-9+]/g, "");

// Never send this field to any client, under any circumstance.
const publicResident = (r) => ({ slot: r.slot, flat: r.flat, name: r.name, carNumbers: r.carNumbers || [] });

async function isAdmin(phone) {
  const admins = await readCollection("admins.json");
  return admins.includes(phone);
}

// ---------- Sessions ----------

const sessions = new Map(); // token -> { slot, flat, name, phone, email, expires }
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function requireAuth(req, res, next) {
  const token = req.headers["x-session-token"];
  const session = token && sessions.get(token);
  if (!session || session.expires < Date.now()) {
    return res.status(401).json({ error: "Please verify your email to continue." });
  }
  req.resident = session;
  next();
}

const cleanEmail = (s) => clean(s).toLowerCase();

// ---------- Email OTP ----------

const otps = new Map(); // email -> { code, expires, attempts }
const OTP_TTL_MS = 1000 * 60 * 5; // 5 minutes
const OTP_MAX_ATTEMPTS = 5;

app.post("/api/otp/request", rateLimit(6, 60_000), async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    const residents = await readCollection("residents.json");
    const match = residents.find((r) => r.email === email);
    // Same response whether or not the email is registered — avoids leaking
    // which emails are in the directory to someone probing the endpoint.
    if (match) {
      const code = String(crypto.randomInt(100000, 999999));
      otps.set(email, { code, expires: Date.now() + OTP_TTL_MS, attempts: 0 });
      await sendOtpEmail(email, code);
    }
    res.json({ ok: true, message: "If that email is registered, a code was sent." });
  } catch (err) {
    res.status(500).json({ error: "Could not send code. Try again." });
  }
});

app.post("/api/otp/verify", rateLimit(10, 60_000), async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const code = clean(req.body?.code);
    const record = otps.get(email);

    if (!record || record.expires < Date.now()) {
      return res.status(400).json({ error: "Code expired or not found. Request a new one." });
    }
    record.attempts += 1;
    if (record.attempts > OTP_MAX_ATTEMPTS) {
      otps.delete(email);
      return res.status(429).json({ error: "Too many attempts. Request a new code." });
    }
    if (code !== record.code) {
      return res.status(400).json({ error: "Incorrect code." });
    }

    otps.delete(email);
    const residents = await readCollection("residents.json");
    const resident = residents.find((r) => r.email === email);
    if (!resident) {
      return res.status(404).json({ error: "No resident registered with that email." });
    }

    const token = crypto.randomUUID();
    sessions.set(token, {
      slot: resident.slot, flat: resident.flat, name: resident.name,
      phone: resident.phone, email: resident.email, expires: Date.now() + SESSION_TTL_MS,
    });
    const admin = await isAdmin(resident.phone);
    res.json({ token, resident: publicResident(resident), isAdmin: admin });
  } catch (err) {
    res.status(500).json({ error: "Could not verify. Try again." });
  }
});

// ---------- Admin management ----------
// No UI for this yet — promote a committee member's phone to admin by
// calling this once, with ADMIN_SETUP_KEY set as a Railway env var (not
// committed to the repo). Without that env var set, this route refuses
// everything, so it's safe to leave deployed.

app.post("/api/admins", async (req, res) => {
  const setupKey = process.env.ADMIN_SETUP_KEY;
  if (!setupKey) return res.status(403).json({ error: "Admin setup is disabled (no ADMIN_SETUP_KEY configured)." });
  if (req.headers["x-admin-setup-key"] !== setupKey) {
    return res.status(403).json({ error: "Invalid setup key." });
  }
  const phone = cleanPhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: "Phone required." });
  const admins = await readCollection("admins.json");
  if (!admins.includes(phone)) admins.push(phone);
  await writeCollection("admins.json", admins);
  res.json({ ok: true, admins });
});
// Requires a session. Phone numbers are stripped from every response —
// there is no code path that sends a resident's number to another client
// except the one-time WhatsApp redirect below.

app.get("/api/residents", requireAuth, async (req, res) => {
  try {
    const residents = await readCollection("residents.json");
    res.json(residents.map(publicResident));
  } catch (err) {
    res.status(500).json({ error: "Could not read the directory." });
  }
});

app.post("/api/residents", async (req, res) => {
  try {
    const { slot, flat, name, phone, carNumber, email } = req.body || {};
    if (![slot, flat, name, phone, carNumber, email].every((v) => clean(v))) {
      return res.status(400).json({ error: "All fields are required." });
    }
    const cleanedEmail = cleanEmail(email);
    if (!cleanedEmail.includes("@")) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    const newPlate = cleanPlate(carNumber);
    const slotKey = clean(slot).toLowerCase();

    const all = await withCollection("residents.json", async (residents) => {
      const idx = residents.findIndex((r) => r.slot.toLowerCase() === slotKey);

      if (idx < 0) {
        // Brand new slot.
        residents.push({
          slot: clean(slot), flat: clean(flat), name: clean(name),
          phone: cleanPhone(phone), email: cleanedEmail, carNumbers: [newPlate],
          updatedAt: Date.now(),
        });
        return residents;
      }

      const existing = residents[idx];
      const samePerson = existing.email === cleanedEmail || existing.phone === cleanPhone(phone);

      if (samePerson) {
        // Same resident registering again — add the car, keep the others.
        const carNumbers = Array.from(new Set([...(existing.carNumbers || []), newPlate]));
        residents[idx] = {
          slot: clean(slot), flat: clean(flat), name: clean(name),
          phone: cleanPhone(phone), email: cleanedEmail, carNumbers,
          updatedAt: Date.now(),
        };
      } else {
        // Different email/phone claiming an already-registered slot — treat
        // as the slot changing hands. Replace the record entirely so the
        // previous owner's cars don't linger attached to the new owner.
        residents[idx] = {
          slot: clean(slot), flat: clean(flat), name: clean(name),
          phone: cleanPhone(phone), email: cleanedEmail, carNumbers: [newPlate],
          updatedAt: Date.now(),
        };
        // Sessions are a snapshot taken at login — without this, a previous
        // owner with an active session would keep acting as this slot's
        // resident until their 30-day token happened to expire.
        for (const [token, session] of sessions) {
          if (session.email === existing.email) sessions.delete(token);
        }
      }
      return residents;
    });

    res.json({ ok: true, residents: all.map(publicResident) });
  } catch (err) {
    res.status(500).json({ error: "Could not save. Try again." });
  }
});

// ---------- Violations (the reports) ----------
// Auth required: the reporter must be a verified resident. Their own slot
// comes from the session, not a free-text field, so no one can probe slots
// that aren't theirs. The response never contains the violator's phone —
// instead it returns a one-time token that redirects to WhatsApp exactly
// once, so the number only surfaces at the moment of an actual, logged report.

const notifyTokens = new Map(); // token -> { phone, message, expires, used }
const NOTIFY_TTL_MS = 1000 * 60 * 15; // 15 minutes

app.get("/api/violations", requireAuth, async (req, res) => {
  try {
    const violations = await readCollection("violations.json");
    const admin = await isAdmin(req.resident.phone);
    const visible = admin
      ? violations
      : violations.filter((v) => v.reporterFlat === req.resident.flat);
    res.json({ violations: visible, isAdmin: admin });
  } catch (err) {
    res.status(500).json({ error: "Could not read the log." });
  }
});

app.post("/api/violations", requireAuth, async (req, res) => {
  try {
    const { carSeen } = req.body || {};
    const mySlot = req.resident.slot; // from session, not client input
    const plate = cleanPlate(carSeen);

    const residents = await readCollection("residents.json");
    const violator = plate ? residents.find((r) => (r.carNumbers || []).includes(plate)) : null;

    const entry = {
      id: Date.now(),
      ts: Date.now(),
      mySlot,
      reporterFlat: req.resident.flat,
      reporterName: req.resident.name,
      carSeen: plate || null,
      violatorFlat: violator ? violator.flat : null,
      violatorName: violator ? violator.name : null,
      status: "reported",
    };

    const violations = await readCollection("violations.json");
    await writeCollection("violations.json", [entry, ...violations]);

    let notifyToken = null;
    if (violator) {
      notifyToken = crypto.randomUUID();
      const message = `Hi, this is regarding slot ${mySlot} at Orchid Park. Your car (${plate}) is currently parked there — could you please move it when you get a chance? Thanks! — ${req.resident.name}`;
      notifyTokens.set(notifyToken, { phone: violator.phone, message, expires: Date.now() + NOTIFY_TTL_MS, used: false });
    }

    res.json({ ok: true, entry, violator: violator ? { name: violator.name, flat: violator.flat } : null, notifyToken });
  } catch (err) {
    res.status(500).json({ error: "Could not log the report. Try again." });
  }
});

// One-time redirect: the only place a phone number ever appears client-side,
// and only for the resident who just filed this specific report.
app.get("/api/notify/:token", (req, res) => {
  const record = notifyTokens.get(req.params.token);
  if (!record || record.used || record.expires < Date.now()) {
    return res.status(410).send("This link has expired or was already used.");
  }
  record.used = true;
  res.redirect(`https://wa.me/${record.phone.replace(/[^0-9]/g, "")}?text=${encodeURIComponent(record.message)}`);
});

// ---------- Static PWA ----------

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Parking Watch running on port ${PORT}`);
});
