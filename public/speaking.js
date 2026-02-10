import { qs, escapeHtml } from "/app.js";

const elSubtitle = qs("#subtitle");
const elCountdown = qs("#countdown");
const elWindow = qs("#window");
const elMsg = qs("#msg");
const elJoinBtn = qs("#joinBtn");

const params = new URLSearchParams(location.search);
const token = String(params.get("token") || "").trim();

let serverOffsetMs = 0;
let activeRedirectUrl = "";
let pollTimer = null;
let tickTimer = null;

function nowMs() {
  return Date.now() + serverOffsetMs;
}

function fmt(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return "-";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function showMsg(text, cls = "") {
  elMsg.style.display = "block";
  elMsg.className = `notice ${cls}`.trim();
  elMsg.innerHTML = escapeHtml(String(text || ""));
}

function secondsToHms(totalSec) {
  const sec = Math.max(0, Math.floor(Number(totalSec || 0)));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

async function fetchGate() {
  if (!token) throw new Error("Missing token");
  const r = await fetch(`/api/speaking/${encodeURIComponent(token)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function renderCountdown(targetMs) {
  const leftSec = Math.ceil((Number(targetMs || 0) - nowMs()) / 1000);
  elCountdown.textContent = secondsToHms(leftSec);
}

function stopTimers() {
  if (pollTimer) clearInterval(pollTimer);
  if (tickTimer) clearInterval(tickTimer);
  pollTimer = null;
  tickTimer = null;
}

async function refresh() {
  try {
    const gate = await fetchGate();
    const serverNow = Number(gate.serverNow || Date.now());
    serverOffsetMs = serverNow - Date.now();
    const startUtcMs = Number(gate.startUtcMs || 0);
    const endUtcMs = Number(gate.endUtcMs || 0);
    elWindow.textContent = `${fmt(startUtcMs)}  to  ${fmt(endUtcMs)}`;

    if (gate.status === "countdown") {
      activeRedirectUrl = "";
      elJoinBtn.disabled = true;
      elSubtitle.textContent = `Session for ${String(gate.candidateName || "candidate")} starts in:`;
      renderCountdown(startUtcMs);
      showMsg("The meeting link will activate automatically at the scheduled time.", "ok");
      return;
    }

    if (gate.status === "open") {
      activeRedirectUrl = String(gate.redirectUrl || "").trim();
      elJoinBtn.disabled = !activeRedirectUrl;
      elSubtitle.textContent = "Session is now open.";
      elCountdown.textContent = "00:00:00";
      if (activeRedirectUrl) {
        showMsg("Redirecting to meeting...", "ok");
        location.href = activeRedirectUrl;
      } else {
        showMsg("Meeting is not available yet. Please try again shortly.", "bad");
      }
      return;
    }

    if (gate.status === "ended") {
      activeRedirectUrl = "";
      elJoinBtn.disabled = true;
      elSubtitle.textContent = "Session has ended.";
      elCountdown.textContent = "00:00:00";
      showMsg("The scheduled time window for this session is closed.", "bad");
      stopTimers();
      return;
    }

    showMsg("Unknown session state.", "bad");
  } catch (e) {
    showMsg(e?.message || String(e), "bad");
  }
}

elJoinBtn.addEventListener("click", () => {
  if (activeRedirectUrl) location.href = activeRedirectUrl;
});

if (!token) {
  showMsg("Missing token in URL.", "bad");
  elJoinBtn.disabled = true;
} else {
  refresh().catch(() => {});
  pollTimer = setInterval(() => { refresh().catch(() => {}); }, 5000);
  tickTimer = setInterval(() => {
    const txt = String(elCountdown.textContent || "");
    if (/^\d{2}:\d{2}:\d{2}$/.test(txt)) {
      const [h, m, s] = txt.split(":").map((x) => Number(x));
      const left = h * 3600 + m * 60 + s;
      elCountdown.textContent = secondsToHms(left - 1);
    }
  }, 1000);
}
