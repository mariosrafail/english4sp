import { apiGet, apiPost, qs, qsa, uiAlert, uiConfirm } from "./app.js";

const elQ = qs("#q");
const elClear = qs("#clear");
const elOnlyDone = qs("#onlyDone");
const elOnlyDisq = qs("#onlyDisq");
const elExamPeriod = qs("#examPeriod");

const elTbody = qs("#tbody");
const elPageNum = qs("#pageNum");
const elPageMax = qs("#pageMax");
const elPrev = qs("#prev");
const elNext = qs("#next");
const elKpiTotal = qs("#kpiTotal");
const elKpiFiltered = qs("#kpiFiltered");
const elExportXls = qs("#exportXls");
const elSwitchExaminer = qs("#switchExaminer");

let allRows = [];
let allPeriods = [];
let speakingBySession = new Map();
let filtered = [];
let page = 1;
const PAGE_SIZE = 16;

let applyTimer = null;
let isApplying = false;
let pendingApply = false;

function scheduleApply() {
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    if (isApplying) {
      pendingApply = true;
      return;
    }
    try {
      isApplying = true;
      applyFilters(false);
    } catch (e) {
      elTbody.innerHTML = `<tr><td colspan="7" class="bad">Search error: ${escapeHtml(e?.message || String(e))}</td></tr>`;
    } finally {
      isApplying = false;
      if (pendingApply) {
        pendingApply = false;
        scheduleApply();
      }
    }
  }, 60);
}

function normalize(x) {
  return String(x || "").trim().toLowerCase();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function submittedFmt(submitted) {
  return submitted ? '<span class="ok">Yes</span>' : '<span class="muted">No</span>';
}

function formatLocalDateTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    return new Date(n).toLocaleString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

function chooseBestSpeakingSlot(slots) {
  const now = Date.now();
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const s of slots || []) {
    const start = Number(s?.startUtcMs || 0);
    const end = Number(s?.endUtcMs || 0);
    if (!Number.isFinite(start) || start <= 0) continue;
    const inWindow = Number.isFinite(end) && end > start && now >= start && now <= end;
    const dist = inWindow ? 0 : Math.abs(start - now);
    if (!best || dist < bestScore) {
      best = s;
      bestScore = dist;
    }
  }
  return best;
}

function rebuildSpeakingIndex(slots) {
  const groups = new Map();
  for (const s of (Array.isArray(slots) ? slots : [])) {
    const sid = Number(s?.sessionId || 0);
    if (!Number.isFinite(sid) || sid <= 0) continue;
    if (!groups.has(sid)) groups.set(sid, []);
    groups.get(sid).push(s);
  }
  const idx = new Map();
  for (const [sid, list] of groups.entries()) {
    const chosen = chooseBestSpeakingSlot(list);
    if (chosen) idx.set(sid, chosen);
  }
  speakingBySession = idx;
}

function mergeRowsWithSpeaking(rows) {
  const src = Array.isArray(rows) ? rows : [];
  return src.map((r) => {
    const sid = Number(r?.sessionId || 0);
    const s = speakingBySession.get(sid);
    return {
      ...r,
      speakingStartUtcMs: Number(s?.startUtcMs || 0) || null,
      speakingJoinUrl: String(s?.joinUrl || "").trim(),
      speakingGateUrl: String(s?.speakingUrl || "").trim(),
    };
  });
}

function applySort(rows) {
  // Always sort by ascending ID.
  const out = [...rows];
  out.sort((a, b) => Number(a.sessionId || 0) - Number(b.sessionId || 0));
  return out;
}

function getExamPeriodName(id) {
  const n = Number(id);
  const p = (allPeriods || []).find((x) => Number(x.id) === n);
  if (p && String(p.name || "").trim()) return String(p.name).trim();
  const row = (allRows || []).find((r) => Number(r.examPeriodId) === n && String(r.examPeriodName || "").trim());
  const name = String(row?.examPeriodName || "").trim();
  return name || `Exam Period ${n}`;
}

function rebuildExamPeriodOptions() {
  if (!elExamPeriod) return;

  const current = String(elExamPeriod.value || "");
  let ids = Array.from(
    new Set(
      (allPeriods || [])
        .map((p) => Number(p.id))
        .filter((n) => Number.isFinite(n))
    )
  ).sort((a, b) => a - b);
  if (!ids.length) {
    ids = Array.from(
      new Set(
        (allRows || [])
          .map((r) => Number(r.examPeriodId))
          .filter((n) => Number.isFinite(n))
      )
    ).sort((a, b) => a - b);
  }

  // Keep first option (All)
  const keepAll = `<option value="">All exam periods</option>`;
  const opts = ids.map((id) => `<option value="${id}">${escapeHtml(getExamPeriodName(id))}</option>`).join("");
  elExamPeriod.innerHTML = keepAll + opts;

  // Restore previous selection if still available
  if (current && ids.includes(Number(current))) {
    elExamPeriod.value = current;
  } else {
    elExamPeriod.value = "";
  }
}

function applyFilters(resetPage = true) {
  const qRaw = String(elQ?.value || "");
  const q = normalize(qRaw);
  const qKey = q.replace(/[^a-z0-9]/g, "");
  let rows = allRows;

  // Completed only
  if (elOnlyDone?.checked) {
    rows = rows.filter((r) => !!r.submitted);
  }

  // By default hide disqualified. If checked, include them.
  if (!elOnlyDisq?.checked) {
    rows = rows.filter((r) => !r.disqualified);
  }

  // Exam period filter
  const epVal = String(elExamPeriod?.value || "").trim();
  if (epVal) {
    const ep = Number(epVal);
    rows = rows.filter((r) => Number(r.examPeriodId) === ep);
  }

  // Search
  if (q) {
    rows = rows.filter((r) => {
      const sid = String(r.sessionId || "");
      const sidPad = sid.padStart(6, "0");
      const idLabel = `s-${sidPad}`;
      const ep = String(r.examPeriodId ?? "");
      const epName = normalize(r.examPeriodName || getExamPeriodName(r.examPeriodId));

      const hay = `${sid} ${sidPad} ${idLabel} s${sidPad} ${ep} ${epName}`;
      if (hay.includes(q)) return true;

      if (!qKey) return false;
      const hayKey = hay.replace(/[^a-z0-9]/g, "");
      return hayKey.includes(qKey);
    });
  }

  rows = applySort(rows);
  filtered = rows;

  elKpiTotal.textContent = String(allRows.length);
  elKpiFiltered.textContent = String(filtered.length);

  if (resetPage) page = 1;
  render();
}

function render() {
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  page = Math.min(page, totalPages);

  const start = (page - 1) * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);

  if (!slice.length) {
    elTbody.innerHTML = `<tr><td colspan="7" class="muted">No results</td></tr>`;
  } else {
    elTbody.innerHTML = slice
      .map((r) => {
        const id = Number(r.sessionId || 0);
        const idLabel = `S-${String(id).padStart(6, "0")}`;
        const isDisq = !!r.disqualified;
        const lockAttr = (r.submitted && !isDisq) ? "" : "disabled";
        const speakingTime = formatLocalDateTime(r.speakingStartUtcMs);
        const meetingUrl = String(r.speakingJoinUrl || "").trim();
        const gateUrl = String(r.speakingGateUrl || "").trim();
        const linkUrl = gateUrl || meetingUrl;
        const linkHtml = linkUrl
          ? `<a class="mono" href="${escapeHtml(linkUrl)}" target="_blank" rel="noopener">Open</a>`
          : `<span class="muted">-</span>`;
        return `
          <tr>
            <td><span class="pill mono">${escapeHtml(idLabel)}</span></td>
            <!-- <td>${submittedFmt(!!r.submitted)}</td> -->
            <td><span class="mono">${escapeHtml(speakingTime || "-")}</span></td>
            <td>${linkHtml}</td>
            <td><pre class="writingBox">${escapeHtml(r.qWriting || "")}</pre></td>
            <td>
              <input class="miniInput" type="number" min="1" max="100" step="1" value="${escapeHtml(String(isDisq ? 0 : (r.writingGrade ?? "")))}" data-role="writing" data-sid="${id}" ${lockAttr} />
            </td>
            <td>
              <input class="miniInput" type="number" min="1" max="100" step="1" value="${escapeHtml(String(isDisq ? 0 : (r.speakingGrade ?? "")))}" data-role="speaking" data-sid="${id}" ${lockAttr} />
            </td>

            <td>
              <button class="gradeBtn" data-action="finalize" data-sid="${id}" ${lockAttr}>${isDisq ? "Locked" : "Save"}</button>
            </td>
            <!-- <td><span class="mono">${escapeHtml(String(r.examPeriodId ?? ""))}</span></td> -->
          </tr>
        `;
      })
      .join("");
  }

  elPageNum.textContent = String(page);
  elPageMax.textContent = String(totalPages);
  elPrev.disabled = page <= 1;
  elNext.disabled = page >= totalPages;
}




function exportFilteredToXls() {
  // Ensure filters are applied to current UI state
  try { applyFilters(false); } catch (e) {}

  const epVal = String(elExamPeriod?.value || "").trim();
  const label = epVal ? `EP-${epVal}` : "ALL";
  const payloadRows = (filtered || []).map((r) => {
    const sid = Number(r.sessionId || 0);
    const sidLabel = `S-${String(sid).padStart(6, "0")}`;
    return {
      candidateCode: sidLabel,
      qWriting: r.qWriting || "",
    };
  });

  return fetch("/api/examiner/export-excel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ label, rows: payloadRows }),
  })
    .then(async (r) => {
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const cd = r.headers.get("content-disposition") || "";
      const m = /filename=\"?([^\";]+)\"?/i.exec(cd);
      const filename = m?.[1] || `candidates_${label}.xlsx`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
}

if (elExportXls) {
  elExportXls.addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      elExportXls.disabled = true;
      await exportFilteredToXls();
    } catch (err) {
      await uiAlert(String(err?.message || err), { title: "Export Error" });
    } finally {
      elExportXls.disabled = false;
    }
  });
}

if (elSwitchExaminer) {
  elSwitchExaminer.addEventListener("click", async () => {
    const ok = await uiConfirm("Log out and sign in as another examiner?", { title: "Switch Examiner" });
    if (!ok) return;

    try {
      elSwitchExaminer.disabled = true;
      await apiPost("/api/examiner/logout", {});
    } catch {
      // Even if API call fails, proceed to login page.
    } finally {
      location.href = "/examiners.html";
    }
  });
}

// Examiner grading: save speaking+writing and compute final grade
elTbody.addEventListener("click", async (ev) => {
  const btn = ev.target && ev.target.closest ? ev.target.closest("button[data-action='finalize']") : null;
  if (!btn) return;
  const sid = Number(btn.dataset.sid || 0);
  if (!sid) return;

  const spEl = qs(`input[data-role='speaking'][data-sid='${sid}']`);
  const wrEl = qs(`input[data-role='writing'][data-sid='${sid}']`);
  const speaking = spEl ? spEl.value : "";
  const writing = wrEl ? wrEl.value : "";

  btn.disabled = true;
  btn.classList.remove("error");
  try {
    const out = await apiPost(`/api/examiner/sessions/${sid}/finalize-grade`, {
      speaking_grade: speaking,
      writing_grade: writing,
    });

    // keep in-memory rows in sync so pagination/sorting/search won't overwrite the new value
    const row = (allRows || []).find((r) => Number(r.sessionId) === sid);
    if (row) {
      row.speakingGrade = out?.speakingGrade ?? row.speakingGrade;
      row.writingGrade = out?.writingGrade ?? row.writingGrade;
    }
    btn.classList.add("saved");
  } catch (e) {
    btn.classList.add("error");
    await uiAlert(String(e.message || e), { title: "Save Error" });
  } finally {
    btn.disabled = false;
  }
});

async function load() {
  elTbody.innerHTML = `<tr><td colspan="7" class="muted">Loading...</td></tr>`;
  const [rows, periods, speaking] = await Promise.all([
    apiGet("/api/examiner/candidates"),
    apiGet("/api/examiner/exam-periods").catch(() => []),
    apiGet("/api/examiner/speaking-slots?limit=50000").catch(() => []),
  ]);
  rebuildSpeakingIndex(speaking);
  allRows = mergeRowsWithSpeaking(rows);
  allPeriods = Array.isArray(periods) ? periods : [];
  rebuildExamPeriodOptions();
  applyFilters(false);
}

async function autoRefresh() {
  try {
    const [fresh, periods, speaking] = await Promise.all([
      apiGet("/api/examiner/candidates"),
      apiGet("/api/examiner/exam-periods").catch(() => []),
      apiGet("/api/examiner/speaking-slots?limit=50000").catch(() => []),
    ]);
    if (!Array.isArray(fresh)) return;
    rebuildSpeakingIndex(speaking);
    const mergedFresh = mergeRowsWithSpeaking(fresh);
    let changed = false;

    if (!Array.isArray(allRows) || mergedFresh.length !== allRows.length || mergedFresh[0]?.sessionId !== allRows[0]?.sessionId) {
      changed = true;
    } else {
      // Detect in-place changes (e.g. grades) without forcing a full page refresh.
      // Compare a small window from the top; this covers the typical "recent" view and keeps it cheap.
      const N = Math.min(200, mergedFresh.length);
      for (let i = 0; i < N; i++) {
        const a = allRows[i];
        const b = mergedFresh[i];
        if (!a || !b) { changed = true; break; }
        if (
          Number(a.sessionId) !== Number(b.sessionId) ||
          (a.speakingGrade ?? null) !== (b.speakingGrade ?? null) ||
          (a.writingGrade ?? null) !== (b.writingGrade ?? null) ||
          String(a.qWriting ?? "") !== String(b.qWriting ?? "") ||
          Number(a.speakingStartUtcMs || 0) !== Number(b.speakingStartUtcMs || 0) ||
          String(a.speakingJoinUrl || "") !== String(b.speakingJoinUrl || "")
        ) {
          changed = true;
          break;
        }
      }
    }

    const newPeriods = Array.isArray(periods) ? periods : [];
    if (!changed) {
      if (!Array.isArray(allPeriods) || newPeriods.length !== allPeriods.length) {
        changed = true;
      } else {
        for (let i = 0; i < newPeriods.length; i++) {
          const a = allPeriods[i];
          const b = newPeriods[i];
          if (!a || !b || Number(a.id) !== Number(b.id) || String(a.name || "") !== String(b.name || "")) {
            changed = true;
            break;
          }
        }
      }
    }

    if (changed) {
      allRows = mergedFresh;
      allPeriods = newPeriods;
      rebuildExamPeriodOptions();
      applyFilters(false);
    }
  } catch {
    // keep UI as-is
  }
}

setInterval(autoRefresh, 5000);
window.addEventListener("focus", autoRefresh);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) autoRefresh();
});

elQ.addEventListener("input", scheduleApply);
elQ.addEventListener("search", scheduleApply);
elOnlyDone?.addEventListener("change", scheduleApply);
elOnlyDisq?.addEventListener("change", scheduleApply);
elExamPeriod?.addEventListener("change", scheduleApply);

elClear.addEventListener("click", () => {
  elQ.value = "";
  applyFilters(false);
  elQ.focus();
});

elPrev.addEventListener("click", () => {
  page = Math.max(1, page - 1);
  render();
});
elNext.addEventListener("click", () => {
  page = page + 1;
  render();
});

load().catch((e) => {
  elTbody.innerHTML = `<tr><td colspan="7" class="bad">Failed to load: ${escapeHtml(e?.message || String(e))}</td></tr>`;
});
