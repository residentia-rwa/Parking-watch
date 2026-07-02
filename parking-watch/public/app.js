const state = {
  tab: "report",
  residents: [],
  violations: [],
  loading: true,
  reportResult: null,
  session: null, // { token, resident: { slot, flat, name, carNumber }, isAdmin }
};

const contentEl = document.getElementById("content");
const toastEl = document.getElementById("toast");
const tabsEl = document.getElementById("tabs");

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  setTimeout(() => { toastEl.hidden = true; }, 2500);
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (state.session) headers["X-Session-Token"] = state.session.token;
  const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // Session expired or invalid — drop it and show the login screen again.
    state.session = null;
    localStorage.removeItem("pw_session");
    render();
    throw new Error(data.error || "Please verify again.");
  }
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function escapeHtml(str) {
  return (str ?? "").toString().replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- Session bootstrap ----------

function loadSession() {
  try {
    const raw = localStorage.getItem("pw_session");
    if (raw) state.session = JSON.parse(raw);
  } catch { /* ignore corrupt local storage */ }
}

function saveSession(session) {
  state.session = session;
  localStorage.setItem("pw_session", JSON.stringify(session));
}

function logout() {
  state.session = null;
  localStorage.removeItem("pw_session");
  render();
}

async function loadData() {
  state.loading = true;
  render();
  try {
    const [residents, violationsRes] = await Promise.all([
      api("/api/residents"),
      api("/api/violations"),
    ]);
    state.residents = residents;
    state.violations = violationsRes.violations;
    if (state.session) {
      state.session.isAdmin = violationsRes.isAdmin;
      localStorage.setItem("pw_session", JSON.stringify(state.session));
    }
  } catch (err) {
    if (state.session) showToast(err.message);
  }
  state.loading = false;
  render();
}

function setTab(tab) {
  state.tab = tab;
  state.reportResult = null;
  document.querySelectorAll(".tab").forEach((el) => {
    el.classList.toggle("active", el.dataset.tab === tab);
  });
  render();
}

document.querySelectorAll(".tab").forEach((el) => {
  el.addEventListener("click", () => setTab(el.dataset.tab));
});

// ---------- Login / verify screen ----------

function renderLogin() {
  tabsEl.style.display = "none";
  contentEl.innerHTML = `
    <p class="hint">Enter the email you registered with — we'll send a 6-digit code. This keeps the directory and reports visible only to verified residents.</p>
    <form id="otp-request-form">
      <label class="field-label">Your email</label>
      <input type="email" id="v-email" placeholder="you@example.com" />
      <div id="verify-error" class="error-text" hidden></div>
      <button type="submit" class="btn btn-amber">Send code</button>
    </form>
    <button class="btn btn-outline" id="go-register" style="margin-top:10px;">Not registered yet? Register your slot</button>
  `;

  document.getElementById("otp-request-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("v-email").value.trim();
    const errEl = document.getElementById("verify-error");
    errEl.hidden = true;
    try {
      await api("/api/otp/request", { method: "POST", body: JSON.stringify({ email }) });
      renderOtpVerify(email);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  document.getElementById("go-register").addEventListener("click", () => {
    renderRegisterOnly();
  });
}

function renderOtpVerify(email) {
  tabsEl.style.display = "none";
  contentEl.innerHTML = `
    <p class="hint">Code sent to <strong>${escapeHtml(email)}</strong>. It expires in 5 minutes.</p>
    <form id="otp-verify-form">
      <label class="field-label">6-digit code</label>
      <input type="text" inputmode="numeric" maxlength="6" id="v-code" placeholder="123456" />
      <div id="otp-error" class="error-text" hidden></div>
      <button type="submit" class="btn btn-amber">Verify</button>
    </form>
    <button class="btn btn-outline" id="back-to-email" style="margin-top:10px;">Use a different email</button>
  `;

  document.getElementById("otp-verify-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = document.getElementById("v-code").value.trim();
    const errEl = document.getElementById("otp-error");
    errEl.hidden = true;
    try {
      const data = await api("/api/otp/verify", { method: "POST", body: JSON.stringify({ email, code }) });
      saveSession(data);
      showToast(`Welcome, ${data.resident.name.split(" ")[0]}.`);
      tabsEl.style.display = "";
      loadData();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  document.getElementById("back-to-email").addEventListener("click", renderLogin);
}

function renderRegisterOnly() {
  tabsEl.style.display = "none";
  contentEl.innerHTML = `
    <p class="hint">Register your slot, flat, name, email, WhatsApp number, and plate. Your email is used only to send you a login code — it's never shown to other residents in the app.</p>
    ${registerFormHtml()}
    <button class="btn btn-outline" id="back-to-login" style="margin-top:10px;">Already registered? Log in instead</button>
  `;
  wireRegisterForm(() => renderLogin());
  document.getElementById("back-to-login").addEventListener("click", renderLogin);
}

function registerFormHtml() {
  return `
    <form id="reg-form">
      <div class="grid-2">
        <div>
          <label class="field-label">Slot</label>
          <input type="text" id="r-slot" placeholder="B-114" />
        </div>
        <div>
          <label class="field-label">Flat</label>
          <input type="text" id="r-flat" placeholder="A-204" />
        </div>
      </div>
      <label class="field-label">Name</label>
      <input type="text" id="r-name" placeholder="Full name" />
      <label class="field-label">Email</label>
      <input type="email" id="r-email" placeholder="you@example.com" />
      <label class="field-label">WhatsApp number</label>
      <input type="tel" id="r-phone" placeholder="+91 98765 43210" />
      <label class="field-label">Car number plate</label>
      <input type="text" id="r-plate" placeholder="KA05MN1234" />
      <div class="muted" style="margin:-6px 0 10px; font-size:11px;">Have a second car for the same slot? Submit this form again with the same slot number — it adds the plate instead of replacing the old one.</div>
      <div id="reg-error" class="error-text" hidden></div>
      <button type="submit" class="btn btn-ink">Save to directory</button>
    </form>
  `;
}

function wireRegisterForm(onSuccess) {
  document.getElementById("reg-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      slot: document.getElementById("r-slot").value.trim(),
      flat: document.getElementById("r-flat").value.trim(),
      name: document.getElementById("r-name").value.trim(),
      email: document.getElementById("r-email").value.trim(),
      phone: document.getElementById("r-phone").value.trim(),
      carNumber: document.getElementById("r-plate").value.trim(),
    };
    const errEl = document.getElementById("reg-error");
    errEl.hidden = true;
    if (Object.values(payload).some((v) => !v)) {
      errEl.textContent = "Fill in every field so the directory stays useful.";
      errEl.hidden = false;
      return;
    }
    try {
      await fetch("/api/residents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
      });
      showToast("Registered. Now log in with your email to start using the app.");
      onSuccess();
    } catch (err) {
      errEl.textContent = err.message || "Could not save. Try again.";
      errEl.hidden = false;
    }
  });
}

// ---------- Renderers (require session) ----------

function renderReportTab() {
  const me = state.session.resident;

  if (state.reportResult) {
    const { entry, violator, notifyToken } = state.reportResult;
    contentEl.innerHTML = `
      <div class="ticket">
        <div class="ticket-eyebrow">Violation logged</div>
        <div class="ticket-slot">Slot ${escapeHtml(entry.mySlot)}</div>
        <div class="ticket-sub">Blocked by ${escapeHtml(entry.carSeen || "unknown plate")}</div>
        ${violator ? `
          <div class="ticket-divider">
            <div style="font-size:13px;">Matched to <strong>${escapeHtml(violator.name)}</strong>, flat ${escapeHtml(violator.flat)}.</div>
            <a class="btn btn-teal" style="margin-top:12px;" target="_blank" rel="noopener noreferrer"
               href="/api/notify/${notifyToken}">
              Send WhatsApp request
            </a>
            <div class="muted" style="margin-top:8px;">This link opens WhatsApp once, then expires — it's not stored or shown anywhere else.</div>
          </div>` : `
          <div class="ticket-divider muted">
            This car isn't in the directory yet, so there's no owner to message automatically. The report is still logged for the committee — worth flagging to security in the meantime.
          </div>`}
      </div>
      <button class="btn btn-outline" id="report-again" style="margin-top:16px;">Report another</button>
    `;
    document.getElementById("report-again").onclick = () => {
      state.reportResult = null;
      render();
    };
    return;
  }

  contentEl.innerHTML = `
    <p class="hint">Reporting as <strong>${escapeHtml(me.name)}</strong>, slot <strong>${escapeHtml(me.slot)}</strong>. Enter the plate parked there — if it's in the directory, you'll get a ready-to-send message.</p>
    <form id="report-form">
      <label class="field-label">Number plate parked in your slot</label>
      <input type="text" id="f-plate" placeholder="e.g. KA05MN1234" />
      <div class="muted" style="margin:-10px 0 14px;">Skip this if you can't read the plate — the report is still logged.</div>
      <div id="report-error" class="error-text" hidden></div>
      <button type="submit" class="btn btn-amber">Find owner &amp; report</button>
    </form>
  `;

  document.getElementById("report-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const carSeen = document.getElementById("f-plate").value.trim();
    const errEl = document.getElementById("report-error");
    errEl.hidden = true;
    try {
      const data = await api("/api/violations", { method: "POST", body: JSON.stringify({ carSeen }) });
      state.violations.unshift(data.entry);
      state.reportResult = data;
      render();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });
}

function renderDirectoryTab() {
  contentEl.innerHTML = `
    <p class="hint">Register a car (or add another one to your existing slot), or browse who's registered. Phone numbers are never shown here.</p>
    ${registerFormHtml()}
    <div class="section-label" style="margin-top:24px;">${state.residents.length} registered</div>
    <div id="dir-list"></div>
  `;
  wireRegisterForm(async () => {
    const residents = await api("/api/residents");
    state.residents = residents;
    render();
  });

  const listEl = document.getElementById("dir-list");
  if (state.residents.length === 0) {
    listEl.innerHTML = `<div class="empty">No one's registered yet — be the first.</div>`;
  } else {
    listEl.innerHTML = state.residents.map((r) => `
      <div class="dir-row">
        <div>
          <div class="dir-slot">${escapeHtml(r.slot)}</div>
          <div class="dir-meta">${escapeHtml(r.name)} · Flat ${escapeHtml(r.flat)}</div>
        </div>
        <div class="dir-plate">${(r.carNumbers || []).map(escapeHtml).join(", ")}</div>
      </div>
    `).join("");
  }
}

function renderLogTab() {
  const isAdmin = !!state.session.isAdmin;

  if (!isAdmin) {
    const mine = state.violations; // server already filtered to reporterFlat === me
    let html = `<p class="hint">Your filed reports. The full committee log (with repeat-offender tracking) is only visible to committee admins.</p>`;
    html += `<div class="section-label">Your reports (${mine.length})</div>`;
    if (mine.length === 0) {
      html += `<div class="empty">You haven't filed any reports yet.</div>`;
    } else {
      html += mine.map((v) => `
        <div class="log-row">
          <div class="log-top">
            <span class="log-slot">Slot ${escapeHtml(v.mySlot)}</span>
            <span class="log-time">${new Date(v.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
          </div>
          <div class="log-meta">${escapeHtml(v.carSeen || "no plate entered")} ${v.violatorFlat ? `· Flat ${escapeHtml(v.violatorFlat)}` : "· not in directory"}</div>
        </div>
      `).join("");
    }
    html += `<button class="btn btn-outline" id="logout-btn" style="margin-top:20px;">Log out</button>`;
    contentEl.innerHTML = html;
    document.getElementById("logout-btn").addEventListener("click", logout);
    return;
  }

  const counts = {};
  state.violations.forEach((v) => {
    if (v.violatorFlat) counts[v.violatorFlat] = (counts[v.violatorFlat] || 0) + 1;
  });
  const offenders = Object.entries(counts)
    .map(([flat, count]) => {
      const r = state.residents.find((res) => res.flat === flat);
      return { flat, count, name: r ? r.name : "Unknown" };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  let html = `<div class="section-label" style="margin-bottom:2px;">Committee view</div><p class="hint" style="margin-top:2px;">Visible to admins only.</p>`;
  if (offenders.length > 0) {
    html += `<div class="section-label">Repeat flats</div>`;
    html += offenders.map((o) => `
      <div class="offender-row">
        <span class="offender-name">Flat ${escapeHtml(o.flat)} — ${escapeHtml(o.name)}</span>
        <span class="offender-count">${o.count}×</span>
      </div>
    `).join("");
  }

  html += `<div class="section-label" style="margin-top:${offenders.length ? 20 : 0}px;">All reports (${state.violations.length})</div>`;
  if (state.violations.length === 0) {
    html += `<div class="empty">No reports yet.</div>`;
  } else {
    html += state.violations.map((v) => `
      <div class="log-row">
        <div class="log-top">
          <span class="log-slot">Slot ${escapeHtml(v.mySlot)}</span>
          <span class="log-time">${new Date(v.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        <div class="log-meta">${escapeHtml(v.carSeen || "no plate entered")} ${v.violatorFlat ? `· Flat ${escapeHtml(v.violatorFlat)}` : "· not in directory"} · reported by ${escapeHtml(v.reporterName)}</div>
      </div>
    `).join("");
  }
  html += `<button class="btn btn-outline" id="logout-btn" style="margin-top:20px;">Log out</button>`;

  contentEl.innerHTML = html;
  document.getElementById("logout-btn").addEventListener("click", logout);
}

function render() {
  if (!state.session) {
    renderLogin();
    return;
  }
  tabsEl.style.display = "";
  if (state.loading) {
    contentEl.innerHTML = `<div class="muted">Loading directory…</div>`;
    return;
  }
  if (state.tab === "report") renderReportTab();
  else if (state.tab === "directory") renderDirectoryTab();
  else renderLogTab();
}

// ---------- Boot ----------

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  });
}

loadSession();
if (state.session) loadData();
else render();

