import { qs, escapeHtml } from "./app.js";

const elFrame = qs("#meetingFrame");
const elInfo = qs("#meetingInfo");
const elErr = qs("#meetingError");
const elOpenExternal = qs("#openExternal");

function safeRoom(raw) {
  const room = String(raw || "").trim();
  if (!room) return "";
  return room.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120);
}

function showError(msg) {
  if (elErr) {
    elErr.style.display = "block";
    elErr.textContent = String(msg || "Unable to open meeting.");
  }
  if (elFrame) elFrame.style.display = "none";
}

const params = new URLSearchParams(location.search);
const room = safeRoom(params.get("room"));

function isLocalHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function deriveMeetingBase() {
  const explicit = String(params.get("base") || "").trim().replace(/\/+$/, "");
  const host = String(location.hostname || "").trim().toLowerCase();

  // Local development: always target local Jitsi by default.
  if (isLocalHost(host)) {
    return "http://localhost:8000";
  }

  // Production/staging: explicit base wins if present.
  if (explicit) return explicit;

  // Default production rule: meet.<current-app-host>
  return `https://meet.${host}`;
}

const base = deriveMeetingBase();

if (!room) {
  showError("Missing or invalid room id.");
} else {
  const url = `${base}/${encodeURIComponent(room)}`;
  if (elFrame) elFrame.src = url;
  if (elInfo) elInfo.innerHTML = `Room: <span class="mono">${escapeHtml(room)}</span>`;
  if (elOpenExternal) elOpenExternal.href = url;
}
