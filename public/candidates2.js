import { apiGet, apiPost, qs, qsa } from "./app.js";

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
      elTbody.innerHTML = `<tr><td colspan="5" class="bad">Search error: ${escapeHtml(e?.message || String(e))}</td></tr>`;
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

function applySort(rows) {
  // Always sort by ascending ID.
  const out = [...rows];
  out.sort((a, b) => Number(a.sessionId || 0) - Number(b.sessionId || 0));
  return out;
}

function rebuildExamPeriodOptions() {
  if (!elExamPeriod) return;

  const current = String(elExamPeriod.value || "");
  const ids = Array.from(
    new Set(
      (allRows || [])
        .map((r) => Number(r.examPeriodId))
        .filter((n) => Number.isFinite(n))
    )
  ).sort((a, b) => a - b);

  // Keep first option (All)
  const keepAll = `<option value="">All exam periods</option>`;
  const opts = ids.map((id) => `<option value="${id}">${id}</option>`).join("");
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

      const hay = `${sid} ${sidPad} ${idLabel} s${sidPad} ${ep}`;
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
    elTbody.innerHTML = `<tr><td colspan="5" class="muted">No results</td></tr>`;
  } else {
    elTbody.innerHTML = slice
      .map((r) => {
        const id = Number(r.sessionId || 0);
        const idLabel = `S-${String(id).padStart(6, "0")}`;
        const isDisq = !!r.disqualified;
        const lockAttr = (r.submitted && !isDisq) ? "" : "disabled";
        return `
          <tr>
            <td><span class="pill mono">${escapeHtml(idLabel)}</span></td>
            <!-- <td>${submittedFmt(!!r.submitted)}</td> -->
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
      alert(String(err?.message || err));
    } finally {
      elExportXls.disabled = false;
    }
  });
}

if (elSwitchExaminer) {
  elSwitchExaminer.addEventListener("click", async () => {
    const ok = confirm("Log out and sign in as another examiner?");
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
    alert(String(e.message || e));
  } finally {
    btn.disabled = false;
  }
});

async function load() {
  elTbody.innerHTML = `<tr><td colspan="5" class="muted">Loading...</td></tr>`;
  allRows = await apiGet("/api/examiner/candidates");
  if (!Array.isArray(allRows)) allRows = [];
  rebuildExamPeriodOptions();
  applyFilters(false);
}

async function autoRefresh() {
  try {
    const fresh = await apiGet("/api/examiner/candidates");
    if (!Array.isArray(fresh)) return;
    let changed = false;

    if (!Array.isArray(allRows) || fresh.length !== allRows.length || fresh[0]?.sessionId !== allRows[0]?.sessionId) {
      changed = true;
    } else {
      // Detect in-place changes (e.g. grades) without forcing a full page refresh.
      // Compare a small window from the top; this covers the typical "recent" view and keeps it cheap.
      const N = Math.min(200, fresh.length);
      for (let i = 0; i < N; i++) {
        const a = allRows[i];
        const b = fresh[i];
        if (!a || !b) { changed = true; break; }
        if (
          Number(a.sessionId) !== Number(b.sessionId) ||
          (a.speakingGrade ?? null) !== (b.speakingGrade ?? null) ||
          (a.writingGrade ?? null) !== (b.writingGrade ?? null) ||
          String(a.qWriting ?? "") !== String(b.qWriting ?? "")
        ) {
          changed = true;
          break;
        }
      }
    }

    if (changed) {
      allRows = fresh;
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
  elTbody.innerHTML = `<tr><td colspan="6" class="bad">Failed to load: ${escapeHtml(e?.message || String(e))}</td></tr>`;
});
