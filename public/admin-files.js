import { apiGet, apiPost, qs, escapeHtml, uiConfirm, busyStart } from "/app.js";

const elOut = qs("#out");
const elReload = qs("#btnReload");
const elListeningList = qs("#listeningList");
const elSnapshotsList = qs("#snapshotsList");
const elSnapFolders = qs("#snapFolders");
const elSnapSearch = qs("#snapSearch");
const elSnapSortBy = qs("#snapSortBy");
const elSnapExamPeriod = qs("#snapExamPeriod");
const elSnapPrev = qs("#snapPrev");
const elSnapNext = qs("#snapNext");
const elSnapPageInfo = qs("#snapPageInfo");
const elUploadListeningFile = qs("#uploadListeningFile");
const tabButtons = Array.from(document.querySelectorAll("button.admin-q-tab[data-ftab]"));
const panels = Array.from(document.querySelectorAll(".admin-q-panel[data-fpanel]"));

let _tab = "listening";
let _data = null;
let _pendingUploadExamPeriodId = null;
let _snapQuery = "";
let _snapSortBy = "latest";
let _snapFolderKey = "all";
let _snapExamPeriodId = null;
let _snapPage = 1;
const SNAP_PAGE_SIZE = 20;
let _snapshotsCache = new Map(); // sessionId -> snapshots[]

function setOut(msg, ok = true) {
  if (!elOut) return;
  elOut.innerHTML = ok ? `<span class="ok">${escapeHtml(msg)}</span>` : `<span class="bad">${escapeHtml(msg)}</span>`;
}

function fmtBytes(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x) || x <= 0) return "-";
  const u = ["B", "KB", "MB", "GB"];
  let v = x;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${Math.round(v * 10) / 10} ${u[i]}`;
}

function fmtDate(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return "-";
  try { return new Date(n).toLocaleString(); } catch { return String(n); }
}

function setTab(id) {
  const want = String(id || "").trim() || "listening";
  _tab = want;
  for (const b of tabButtons) b.setAttribute("aria-selected", b.dataset.ftab === want ? "true" : "false");
  for (const p of panels) {
    const on = p.dataset.fpanel === want;
    if (on) p.removeAttribute("hidden");
    else p.setAttribute("hidden", "");
  }
  try { localStorage.setItem("admin_files_tab", want); } catch {}
  if (_data) renderAll();
}

function readTab() {
  try {
    const v = String(localStorage.getItem("admin_files_tab") || "").trim();
    return v === "snapshots" ? "snapshots" : "listening";
  } catch {
    return "listening";
  }
}

function readSnapPrefs() {
  try { _snapQuery = String(localStorage.getItem("admin_files_snap_q") || ""); } catch {}
  try {
    const s = String(localStorage.getItem("admin_files_snap_sort") || "");
    _snapSortBy = s === "name" ? "name" : "latest";
  } catch {}
  try {
    const ep = String(localStorage.getItem("admin_files_snap_ep") || "").trim();
    const n = ep ? Number(ep) : 0;
    _snapExamPeriodId = Number.isFinite(n) && n > 0 ? n : null;
  } catch {}
  try { _snapFolderKey = String(localStorage.getItem("admin_files_snap_folder") || "") || "all"; } catch {}
  try {
    const p = Number(localStorage.getItem("admin_files_snap_page") || "1");
    _snapPage = Number.isFinite(p) && p > 0 ? Math.round(p) : 1;
  } catch {}
}

function persistSnapPrefs() {
  try { localStorage.setItem("admin_files_snap_q", String(_snapQuery || "")); } catch {}
  try { localStorage.setItem("admin_files_snap_sort", String(_snapSortBy || "latest")); } catch {}
  try { localStorage.setItem("admin_files_snap_ep", _snapExamPeriodId ? String(_snapExamPeriodId) : ""); } catch {}
  try { localStorage.setItem("admin_files_snap_folder", String(_snapFolderKey || "all")); } catch {}
  try { localStorage.setItem("admin_files_snap_page", String(_snapPage || 1)); } catch {}
}

function normStr(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function yyyymmFromUtcMs(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    const d = new Date(n);
    const y = String(d.getFullYear()).padStart(4, "0");
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  } catch {
    return "";
  }
}

function snapCandidateTitle(r) {
  const name = String(r?.candidateName || "").trim();
  if (name) return name;
  const tok = String(r?.token || "").trim();
  if (tok) return `Token ${tok}`;
  const sid = Number(r?.sessionId || 0);
  if (Number.isFinite(sid) && sid > 0) return `Session ${sid}`;
  return "Unknown";
}

function snapSessionKey(r) {
  const sid = Number(r?.sessionId || 0);
  if (Number.isFinite(sid) && sid > 0) return `sid:${sid}`;
  const tok = String(r?.token || "").trim();
  return tok ? `tok:${tok}` : "unknown";
}

function matchesSnapQuery(r, q) {
  const qq = normStr(q);
  if (!qq) return true;
  const hay = [
    r?.candidateName,
    r?.token,
    r?.reason,
    r?.relPath,
    r?.examPeriodName,
    r?.examPeriodId,
    r?.sessionId,
  ].map((x) => normStr(x)).join(" | ");
  return hay.includes(qq);
}

function matchesSessionQuery(s, q) {
  const qq = normStr(q);
  if (!qq) return true;
  const hay = [
    s?.candidateName,
    s?.token,
    s?.examPeriodName,
    s?.examPeriodId,
    s?.sessionId,
  ].map((x) => normStr(x)).join(" | ");
  return hay.includes(qq);
}

function clampPage(p, max) {
  const n = Number(p || 1);
  const m = Number(max || 1);
  if (!Number.isFinite(n) || n < 1) return 1;
  if (!Number.isFinite(m) || m < 1) return 1;
  return Math.max(1, Math.min(Math.round(n), Math.round(m)));
}

function setPageInfo(page, max, total) {
  if (elSnapPageInfo) {
    elSnapPageInfo.textContent = `${page}/${max} · ${String(total || 0)} candidates`;
  }
  if (elSnapPrev) elSnapPrev.disabled = page <= 1;
  if (elSnapNext) elSnapNext.disabled = page >= max;
}

function renderCandidatesList(rows, { selectedKey } = {}) {
  if (!elSnapFolders) return;
  const parts = rows.map((c) => {
    const key = String(c.key || "");
    const on = key === String(selectedKey || "");
    const title = escapeHtml(String(c.title || ""));
    const sub = c.submitted ? `<span class="candBadge ok">Submitted</span>` : `<span class="candBadge muted">Not submitted</span>`;
    const cnt = escapeHtml(String(c.count || 0));
    const latest = c.latestMs ? escapeHtml(fmtDate(c.latestMs)) : "-";
    const ep = escapeHtml(String(c.examPeriodName || ""));
    return `
      <button class="candRow" type="button" data-action="snap_pick" data-key="${escapeHtml(key)}" aria-selected="${on ? "true" : "false"}">
        <div class="candRowTop">
          <div class="candName" title="${title}">${title}</div>
          <div class="candMetaRight">${sub}</div>
        </div>
        <div class="candRowBottom small muted">
          <span>${ep ? `EP: <span class="mono">${ep}</span>` : ""}</span>
          <span>${latest}</span>
          <span class="candCount mono">${cnt}</span>
        </div>
      </button>
    `;
  }).join("");
  elSnapFolders.innerHTML = parts || `<div class="muted">No candidates match.</div>`;
}

function renderSnapCard(r) {
  const id = Number(r.id || 0) || 0;
  const when = escapeHtml(fmtDate(r.createdAtUtcMs));
  const url = String(r.url || "");
  const exists = !!r.exists;
  const epName = escapeHtml(String(r.examPeriodName || (r.examPeriodId ? `Exam period ${r.examPeriodId}` : "")));
  const tok = escapeHtml(String(r.token || ""));
  const reason = escapeHtml(String(r.reason || ""));
  const title = escapeHtml(snapCandidateTitle(r));

  return `
    <div class="snapCard">
      <a class="snapMedia" href="${escapeHtml(url || "#")}" ${url ? `target="_blank" rel="noopener noreferrer"` : ""} aria-label="Open snapshot">
        ${
          exists && url
            ? `<img class="snapThumb" src="${escapeHtml(url)}" loading="lazy" decoding="async" alt="Snapshot"/>`
            : `<div class="snapMissing">Missing</div>`
        }
      </a>
      <div class="snapBody">
        <div class="snapTitle" title="${title}">${title}</div>
        <div class="snapMeta small muted">
          <div>${when}</div>
          ${epName ? `<div>EP: <span class="mono">${epName}</span></div>` : ""}
          ${reason ? `<div><span class="mono">${reason}</span></div>` : ""}
          ${tok ? `<div>Token: <span class="mono">${tok}</span></div>` : ""}
        </div>
        <div class="snapActions">
          ${url ? `<a class="btnSmall btnGhost" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open</a>` : ""}
        </div>
      </div>
    </div>
  `;
}

function renderListening() {
  const rows = Array.isArray(_data?.listening) ? _data.listening : [];
  if (!rows.length) {
    elListeningList.innerHTML = `<div class="muted">No exam periods.</div>`;
    return;
  }

  const html = rows.map((r) => {
    const name = escapeHtml(String(r.examPeriodName || `Exam period ${r.examPeriodId}`));
    const exists = !!r.exists;
    const url = String(r.url || "");
    const ep = escapeHtml(String(r.examPeriodId || ""));
    return `
      <div class="q" style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
        <div style="min-width:0;">
          <div style="font-weight:900; color:var(--text)">${name}</div>
          <div class="small muted" style="margin-top:6px;">
            ${exists ? `Size: <span class="mono">${escapeHtml(fmtBytes(r.size))}</span> · Updated: <span class="mono">${escapeHtml(fmtDate(r.mtimeMs))}</span>` : "No listening file uploaded."}
          </div>
          ${exists ? `<div class="small muted mono" style="margin-top:6px; word-break:break-all; overflow-wrap:anywhere;">${escapeHtml(String(r.relPath || ""))}</div>` : ""}
        </div>
        <div class="fileActions">
          ${exists ? `<a class="btnSmall btnGhost" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open</a>` : ""}
          <button class="btnSmall btnPrimarySmall" data-action="upload_listening" data-ep="${ep}" type="button">${exists ? "Replace" : "Upload"}</button>
          ${exists ? `<button class="btnSmall btnDanger" data-action="del_listening" data-ep="${ep}" type="button">Delete</button>` : ""}
        </div>
      </div>
    `;
  }).join("");
  elListeningList.innerHTML = html;
}

function renderSnapshots() {
  const rows = Array.isArray(_data?.snapshots) ? _data.snapshots : [];
  if (!rows.length) {
    elSnapshotsList.innerHTML = `<div class="muted">No snapshots yet.</div>`;
    return;
  }

  const html = rows.map((r) => {
    const id = Number(r.id || 0) || 0;
    const who = escapeHtml(String(r.candidateName || `Session ${r.sessionId || ""}`));
    const when = escapeHtml(fmtDate(r.createdAtUtcMs));
    const reason = escapeHtml(String(r.reason || ""));
    const url = String(r.url || "");
    const rel = escapeHtml(String(r.relPath || ""));
    const exists = !!r.exists;
    return `
      <div class="q" style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
        <div style="min-width:0;">
          <div style="font-weight:900; color:var(--text)">${who}</div>
          <div class="small muted" style="margin-top:6px;">
            ${when}${reason ? ` · <span class="mono">${reason}</span>` : ""}
            ${exists ? "" : ` · <span class="bad">Missing file</span>`}
          </div>
          ${rel ? `<div class="small muted mono" style="margin-top:6px; word-break:break-all; overflow-wrap:anywhere;">${rel}</div>` : ""}
        </div>
        <div class="fileActions">
          ${url ? `<a class="btnSmall btnGhost" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open</a>` : ""}
        </div>
      </div>
    `;
  }).join("");
  elSnapshotsList.innerHTML = html;
}

async function loadSnapshotsForSession(sessionId) {
  const sid = Number(sessionId || 0);
  if (!Number.isFinite(sid) || sid <= 0) return [];
  if (_snapshotsCache && _snapshotsCache.has(sid)) return _snapshotsCache.get(sid) || [];
  const j = await apiGet(`/api/admin/files/snapshots?sessionId=${encodeURIComponent(String(sid))}&limit=2000`);
  const rows = Array.isArray(j?.snapshots) ? j.snapshots : [];
  if (!_snapshotsCache) _snapshotsCache = new Map();
  _snapshotsCache.set(sid, rows);
  return rows;
}

function renderSnapshotsV2() {
  const sessionsRaw = Array.isArray(_data?.snapshotSessions) ? _data.snapshotSessions : [];
  if (!sessionsRaw.length) {
    elSnapshotsList.innerHTML = `<div class="muted">No candidates yet.</div>`;
    if (elSnapFolders) elSnapFolders.innerHTML = "";
    setPageInfo(1, 1, 0);
    return;
  }

  const sessions = sessionsRaw.filter((s) => {
    if (!s?.submitted) return false; // always submitted only
    if (_snapExamPeriodId && Number(s?.examPeriodId || 0) !== Number(_snapExamPeriodId)) return false;
    return matchesSessionQuery(s, _snapQuery);
  });

  const candidates = sessions.map((s) => ({
    key: `sid:${Number(s.sessionId || 0) || 0}`,
    sessionId: Number(s.sessionId || 0) || 0,
    title: String(s.candidateName || "").trim() || (s.token ? `Token ${String(s.token)}` : `Session ${s.sessionId}`),
    token: String(s.token || ""),
    submitted: !!s.submitted,
    examPeriodName: String(s.examPeriodName || "").trim(),
    latestMs: Number(s.latestSnapshotUtcMs || 0) || 0,
    count: Number(s.snapshotCount || 0) || 0,
  }));

  candidates.sort((a, b) => {
    if (_snapSortBy === "name") return normStr(a.title).localeCompare(normStr(b.title));
    return Number(b.latestMs || 0) - Number(a.latestMs || 0);
  });

  const maxPage = Math.max(1, Math.ceil(candidates.length / SNAP_PAGE_SIZE));
  _snapPage = clampPage(_snapPage, maxPage);
  setPageInfo(_snapPage, maxPage, candidates.length);
  const start = (_snapPage - 1) * SNAP_PAGE_SIZE;
  const pageRows = candidates.slice(start, start + SNAP_PAGE_SIZE);

  if (_snapFolderKey !== "all" && !candidates.some((c) => c.key === _snapFolderKey)) _snapFolderKey = "all";
  if (_snapFolderKey === "all") {
    const firstSubmitted = candidates.find((c) => c.submitted);
    _snapFolderKey = firstSubmitted ? firstSubmitted.key : "all";
  }

  persistSnapPrefs();
  renderCandidatesList(pageRows, { selectedKey: _snapFolderKey });

  const sel = candidates.find((c) => c.key === _snapFolderKey) || null;
  if (!sel) {
    elSnapshotsList.innerHTML = `<div class="muted">Select a submitted candidate to view snapshots.</div>`;
    return;
  }

  // Render from cache if present; otherwise, prompt user to select (and we'll load on click).
  const cached = _snapshotsCache && _snapshotsCache.has(sel.sessionId) ? (_snapshotsCache.get(sel.sessionId) || []) : null;
  if (!cached) {
    elSnapshotsList.innerHTML = `<div class="muted">Select a candidate to load snapshots.</div>`;
    return;
  }
  const list = Array.isArray(cached) ? cached : [];
  elSnapshotsList.innerHTML = list.length ? `<div class="snapGrid">${list.map(renderSnapCard).join("")}</div>` : `<div class="muted">No snapshots for this candidate.</div>`;
}

function renderAll() {
  renderListening();
  renderSnapshotsV2();
}

async function loadIndex() {
  _data = await apiGet("/api/admin/files/index");
  try { _snapshotsCache = new Map(); } catch { _snapshotsCache = new Map(); }
  try {
    const eps = Array.isArray(_data?.listening) ? _data.listening : [];
    const uniq = new Map();
    for (const r of eps) {
      const id = Number(r?.examPeriodId || 0);
      if (!Number.isFinite(id) || id <= 0) continue;
      const name = String(r?.examPeriodName || `Exam period ${id}`).trim() || `Exam period ${id}`;
      if (!uniq.has(id)) uniq.set(id, name);
    }
    // Keep DB order (exam period id order) instead of alphabetical.
    const entries = Array.from(uniq.entries());
    if (elSnapExamPeriod) {
      const current = _snapExamPeriodId ? String(_snapExamPeriodId) : "";
      elSnapExamPeriod.innerHTML =
        `<option value="">All exam periods</option>` +
        entries.map(([id, name]) => `<option value="${String(id)}">${escapeHtml(String(name))}</option>`).join("");
      elSnapExamPeriod.value = current;
    }
  } catch {}
  renderAll();
}

async function deleteListening(examPeriodId) {
  await apiPost("/api/admin/files/delete", { kind: "listening", examPeriodId: Number(examPeriodId) });
}

async function uploadListening(examPeriodId, file) {
  const ep = Number(examPeriodId || 0);
  if (!Number.isFinite(ep) || ep <= 0) throw new Error("Invalid exam period.");
  const f = file || null;
  if (!f) throw new Error("Pick an MP3 file first.");

  const fd = new FormData();
  fd.append("audio", f, f.name || "listening.mp3");

  const stop = busyStart("Uploading…");
  try {
    const r = await fetch(`/api/admin/listening-audio?examPeriodId=${encodeURIComponent(String(ep))}`, {
      method: "POST",
      body: fd,
      credentials: "same-origin",
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(String(j?.message || j?.error || `Upload failed (${r.status})`));
    return j;
  } finally {
    stop();
  }
}

function openUploadPickerForExamPeriod(examPeriodId) {
  const ep = Number(examPeriodId || 0);
  if (!Number.isFinite(ep) || ep <= 0) return;
  _pendingUploadExamPeriodId = ep;
  if (!elUploadListeningFile) return;
  elUploadListeningFile.value = "";
  elUploadListeningFile.click();
}

function wire() {
  readSnapPrefs();
  setTab(readTab());
  for (const b of tabButtons) {
    b.addEventListener("click", () => setTab(String(b.dataset.ftab || "listening")));
  }

  elReload?.addEventListener("click", async () => {
    try {
      await loadIndex();
      setOut("Reloaded.", true);
    } catch (e) {
      setOut(e?.message || "Reload failed.", false);
    }
  });

  if (elSnapSearch) {
    elSnapSearch.value = _snapQuery;
    elSnapSearch.addEventListener("input", () => {
      _snapQuery = String(elSnapSearch.value || "");
      _snapFolderKey = "all";
      _snapPage = 1;
      persistSnapPrefs();
      if (_data) renderSnapshotsV2();
    });
  }

  if (elSnapSortBy) {
    elSnapSortBy.value = _snapSortBy;
    elSnapSortBy.addEventListener("change", () => {
      _snapSortBy = String(elSnapSortBy.value || "") === "name" ? "name" : "latest";
      _snapFolderKey = "all";
      _snapPage = 1;
      persistSnapPrefs();
      if (_data) renderSnapshotsV2();
    });
  }

  if (elSnapExamPeriod) {
    elSnapExamPeriod.addEventListener("change", () => {
      const v = Number(elSnapExamPeriod.value || 0);
      _snapExamPeriodId = Number.isFinite(v) && v > 0 ? v : null;
      _snapFolderKey = "all";
      _snapPage = 1;
      persistSnapPrefs();
      if (_data) renderSnapshotsV2();
    });
  }

  elSnapPrev?.addEventListener("click", () => {
    _snapPage = Math.max(1, Number(_snapPage || 1) - 1);
    persistSnapPrefs();
    if (_data) renderSnapshotsV2();
  });
  elSnapNext?.addEventListener("click", () => {
    _snapPage = Number(_snapPage || 1) + 1;
    persistSnapPrefs();
    if (_data) renderSnapshotsV2();
  });

  elUploadListeningFile?.addEventListener("change", async () => {
    const ep = Number(_pendingUploadExamPeriodId || 0);
    _pendingUploadExamPeriodId = null;
    const f = elUploadListeningFile?.files && elUploadListeningFile.files[0] ? elUploadListeningFile.files[0] : null;
    if (!ep || !f) return;
    try {
      setOut("Uploading...", true);
      await uploadListening(ep, f);
      await loadIndex();
      setOut("Uploaded listening audio.", true);
    } catch (e) {
      setOut(e?.message || "Upload failed.", false);
    }
  });

  document.addEventListener("click", async (e) => {
    const btn = e.target?.closest?.("button[data-action]");
    if (!btn) return;
    const act = String(btn.dataset.action || "");
    try {
      if (act === "del_listening") {
        const ep = Number(btn.dataset.ep || 0);
        if (!ep) return;
        const ok = await uiConfirm("Delete listening.mp3 for this exam period?", { title: "Delete Listening Audio", yesText: "Delete", noText: "Cancel", danger: true });
        if (!ok) return;
        await deleteListening(ep);
        await loadIndex();
        setOut("Deleted listening audio.", true);
      } else if (act === "upload_listening") {
        const ep = Number(btn.dataset.ep || 0);
        if (!ep) return;
        openUploadPickerForExamPeriod(ep);
      } else if (act === "snap_pick") {
        const key = String(btn.dataset.key || "").trim() || "all";
        _snapFolderKey = key;
        persistSnapPrefs();
        if (_data) {
          // Load snapshots for the selected session (if submitted).
          const m = key.match(/^sid:(\d+)$/);
          const sid = m ? Number(m[1]) : 0;
          const sess = (Array.isArray(_data?.snapshotSessions) ? _data.snapshotSessions : []).find((s) => Number(s?.sessionId) === sid) || null;
          if (sess && sess.submitted) {
            elSnapshotsList.innerHTML = `<div class="muted">Loading snapshots…</div>`;
            try { await loadSnapshotsForSession(sid); } catch {}
          }
          renderSnapshotsV2();
        }
      }
    } catch (err) {
      setOut(err?.message || "Action failed.", false);
    }
  });
}

async function main() {
  try {
    readSnapPrefs();
    await loadIndex();
  } catch (e) {
    const msg = String(e?.message || e);
    if (elListeningList) elListeningList.innerHTML = `<div class="bad">Failed to load: ${escapeHtml(msg)}</div>`;
    if (elSnapshotsList) elSnapshotsList.innerHTML = `<div class="bad">Failed to load: ${escapeHtml(msg)}</div>`;
  }
  wire();
}

main();
