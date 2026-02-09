import { apiGet, qs, uiAlert, uiConfirm } from "./app.js";

const elQ = qs("#q");
const elClear = qs("#clear");
const elSort = qs("#sort");
const elOnlyDone = qs("#onlyDone");
const elOnlyDisq = qs("#onlyDisq");
const elExamPeriod = qs("#examPeriod");
const elExaminerFilter = qs("#examinerFilter");
const elBtnSelectVisible = qs("#btnSelectVisible");
const elBtnClearSelection = qs("#btnClearSelection");
const elBtnExportSelected = qs("#btnExportSelected");
const elChkAll = qs("#chkAll");

const elTbody = qs("#tbody");
const elPageNum = qs("#pageNum");
const elPageMax = qs("#pageMax");
const elPrev = qs("#prev");
const elNext = qs("#next");
const elKpiTotal = qs("#kpiTotal");
const elKpiFiltered = qs("#kpiFiltered");
const elKpiSelected = qs("#kpiSelected");
const elReviewOverlay = qs("#reviewOverlay");
const elReviewClose = qs("#reviewClose");
const elReviewTitle = qs("#reviewTitle");
const elReviewMeta = qs("#reviewMeta");
const elReviewBody = qs("#reviewBody");
const elExportDetailsOverlay = qs("#exportDetailsOverlay");
const elExportDetailsYes = qs("#btnExportDetailsYes");
const elExportDetailsNo = qs("#btnExportDetailsNo");
const elExportDetailsCancel = qs("#btnExportDetailsCancel");
const elCandidatesBusyOverlay = qs("#candidatesBusyOverlay");
const elCandidatesBusyText = qs("#candidatesBusyText");

let allRows = [];
let filtered = [];
let page = 1;
const PAGE_SIZE = 20;

let allPeriods = [];
const selectedIds = new Set();

let applyTimer = null;
let isApplying = false;
let pendingApply = false;
let _busyCount = 0;

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

function gradeFmt(grade) {
  if (grade == null) return '<span class="muted">-</span>';
  return `<span class="mono">${escapeHtml(String(grade))}</span><span class="muted">%</span>`;
}

function answerFmt(s) {
  const v = String(s || "").trim();
  return v ? escapeHtml(v) : '<span class="muted">-</span>';
}
function cleanPromptText(s) {
  const v = String(s || "").trim();
  // Remove leading numbering like "1. " / "12) " from prompt display.
  return v.replace(/^\s*\d+\s*[.)]\s*/, "");
}

function closeReviewModal() {
  if (!elReviewOverlay) return;
  elReviewOverlay.style.display = "none";
}

function openReviewModal() {
  if (!elReviewOverlay) return;
  elReviewOverlay.style.display = "flex";
}

function showCandidatesBusy(message) {
  _busyCount += 1;
  if (elCandidatesBusyText) {
    elCandidatesBusyText.textContent = String(message || "Processing. Don't close this page. Please wait...");
  }
  if (elCandidatesBusyOverlay) elCandidatesBusyOverlay.style.display = "flex";
}

function hideCandidatesBusy() {
  _busyCount = Math.max(0, _busyCount - 1);
  if (_busyCount === 0 && elCandidatesBusyOverlay) {
    elCandidatesBusyOverlay.style.display = "none";
  }
}

function askIncludeDetailedGrades() {
  return new Promise((resolve) => {
    if (!elExportDetailsOverlay || !elExportDetailsYes || !elExportDetailsNo || !elExportDetailsCancel) {
      resolve(false);
      return;
    }

    elExportDetailsOverlay.style.display = "flex";

    const cleanup = () => {
      elExportDetailsOverlay.style.display = "none";
      elExportDetailsYes.removeEventListener("click", onYes);
      elExportDetailsNo.removeEventListener("click", onNo);
      elExportDetailsCancel.removeEventListener("click", onCancel);
      elExportDetailsOverlay.removeEventListener("click", onOverlayClick);
    };
    const onYes = () => { cleanup(); resolve(true); };
    const onNo = () => { cleanup(); resolve(false); };
    const onCancel = () => { cleanup(); resolve(null); };
    const onOverlayClick = (e) => {
      if (e.target === elExportDetailsOverlay) onCancel();
    };

    elExportDetailsYes.addEventListener("click", onYes);
    elExportDetailsNo.addEventListener("click", onNo);
    elExportDetailsCancel.addEventListener("click", onCancel);
    elExportDetailsOverlay.addEventListener("click", onOverlayClick);
  });
}

function getPeriodById(id) {
  return (allPeriods || []).find((p) => Number(p.id) === Number(id)) || null;
}

function getPeriodName(id) {
  const p = getPeriodById(id);
  return String(p?.name || `Period ${id}`);
}

function rebuildExamPeriodOptions() {
  if (!elExamPeriod) return;
  const current = String(elExamPeriod.value || "");
  const ids = (allPeriods || [])
    .map((p) => Number(p.id))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  const keepAll = `<option value="">All exam periods</option>`;
  const opts = ids
    .map((id) => `<option value="${id}">${escapeHtml(getPeriodName(id))}</option>`)
    .join("");
  elExamPeriod.innerHTML = keepAll + opts;
  if (current && ids.includes(Number(current))) elExamPeriod.value = current;
  else elExamPeriod.value = "";
}

function applySort(rows) {
  const mode = elSort.value;
  const out = [...rows];

  if (mode === "grade") {
    out.sort((a, b) => {
      const ra = Number(a.totalGrade ?? -1);
      const rb = Number(b.totalGrade ?? -1);
      if (rb !== ra) return rb - ra;
      return Number(b.sessionId || 0) - Number(a.sessionId || 0);
    });
    return out;
  }

  if (mode === "name") {
    out.sort((a, b) => normalize(a.candidateName).localeCompare(normalize(b.candidateName)) || (Number(a.sessionId || 0) - Number(b.sessionId || 0)));
    return out;
  }

  out.sort((a, b) => Number(b.sessionId || 0) - Number(a.sessionId || 0));
  return out;
}

function getCurrentSlice() {
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const p = Math.min(page, totalPages);
  const start = (p - 1) * PAGE_SIZE;
  return filtered.slice(start, start + PAGE_SIZE);
}

function updateSelectionKpi() {
  if (elKpiSelected) elKpiSelected.textContent = String(selectedIds.size);
}

function updateHeaderCheckbox() {
  if (!elChkAll) return;
  const slice = getCurrentSlice();
  if (!slice.length) {
    elChkAll.checked = false;
    elChkAll.indeterminate = false;
    return;
  }
  const selectedCount = slice.filter((r) => selectedIds.has(Number(r.sessionId))).length;
  elChkAll.checked = selectedCount === slice.length;
  elChkAll.indeterminate = selectedCount > 0 && selectedCount < slice.length;
}

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
      elTbody.innerHTML = `<tr><td colspan="9" class="bad">Search error: ${escapeHtml(e?.message || String(e))}</td></tr>`;
    } finally {
      isApplying = false;
      if (pendingApply) {
        pendingApply = false;
        scheduleApply();
      }
    }
  }, 60);
}

function applyFilters(resetPage = true) {
  const qRaw = String(elQ.value || "");
  const q = normalize(qRaw);
  const qKey = q.replace(/[^a-z0-9]/g, "");
  let rows = allRows;

  if (elOnlyDone?.checked) rows = rows.filter((r) => !!r.submitted);
  if (!elOnlyDisq?.checked) rows = rows.filter((r) => !r.disqualified);

  const epVal = String(elExamPeriod?.value || "").trim();
  if (epVal) {
    const ep = Number(epVal);
    rows = rows.filter((r) => Number(r.examPeriodId) === ep);
  }

  const exVal = normalize(elExaminerFilter?.value || "");
  if (exVal) {
    rows = rows.filter((r) => normalize(r.assignedExaminer || "") === exVal);
  }

  if (q) {
    rows = rows.filter((r) => {
      const name = normalize(r.candidateName);
      const sid = String(r.sessionId || "");
      const token = normalize(r.token || "");
      const sidPad = sid.padStart(6, "0");
      const idLabel = `s-${sidPad}`;
      const period = normalize(getPeriodName(r.examPeriodId));
      const hay = `${name} ${token} ${sid} ${sidPad} ${idLabel} s${sidPad} ${period}`;
      if (hay.includes(q)) return true;
      if (!qKey) return false;
      const hayKey = hay.replace(/[^a-z0-9]/g, "");
      return hayKey.includes(qKey);
    });
  }

  filtered = applySort(rows);
  elKpiTotal.textContent = String(allRows.length);
  elKpiFiltered.textContent = String(filtered.length);

  if (resetPage) page = 1;
  render();
}

function render() {
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  page = Math.min(page, totalPages);

  const slice = getCurrentSlice();
  if (!slice.length) {
    elTbody.innerHTML = `<tr><td colspan="9" class="muted">No results</td></tr>`;
  } else {
    elTbody.innerHTML = slice.map((r) => {
      const id = Number(r.sessionId || 0);
      const idLabel = `S-${String(id).padStart(6, "0")}`;
      const isDisq = !!r.disqualified;
      const totalShown = isDisq ? 0 : r.totalGrade;
      const checked = selectedIds.has(id) ? "checked" : "";
      const nameCell = r.submitted
        ? `<button class="candidateOpenBtn mono" type="button" data-action="open-review" data-sid="${id}">${escapeHtml(r.candidateName || "")}</button>`
        : `<span class="mono muted" title="Not submitted yet">${escapeHtml(r.candidateName || "")}</span>`;
      return `
        <tr>
          <td><input type="checkbox" data-role="pick" data-sid="${id}" ${checked} /></td>
          <td><span class="pill mono">${escapeHtml(idLabel)}</span></td>
          <td>${nameCell}</td>
          <td><span class="mono">${escapeHtml(getPeriodName(r.examPeriodId))}</span></td>
          <td><span class="mono">${escapeHtml(String(r.assignedExaminer || "-"))}</span></td>
          <td><span class="mono">${escapeHtml(r.token || "")}</span></td>
          <td>${submittedFmt(!!r.submitted)}</td>
          <td>${isDisq ? '<span class="pill" title="Disqualified">DISQ</span> ' : ""}${gradeFmt(totalShown)}</td>
          <td>
            <button class="trashBtn" title="Delete candidate" data-action="delete" data-sid="${id}">
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M9 3h6l1 2h5v2H3V5h5l1-2zm1 7h2v9h-2v-9zm4 0h2v9h-2v-9zM7 10h2v9H7v-9zm-1-1h12l-1 12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9z"/>
              </svg>
            </button>
          </td>
        </tr>
      `;
    }).join("");
  }

  elPageNum.textContent = String(page);
  elPageMax.textContent = String(totalPages);
  elPrev.disabled = page <= 1;
  elNext.disabled = page >= totalPages;
  updateSelectionKpi();
  updateHeaderCheckbox();
}

async function exportRows(rows, scopeLabel, includeDetailed = false) {
  if (!rows.length) throw new Error("No rows to export");
  const payloadRows = rows.map((r) => {
    const sid = Number(r.sessionId || 0);
    return {
      sessionId: sid,
      examPeriodId: r.examPeriodId ?? "",
      examPeriodName: getPeriodName(r.examPeriodId),
      candidateCode: `S-${String(sid).padStart(6, "0")}`,
      candidateName: r.candidateName || "",
      token: r.token || "",
      submitted: !!r.submitted,
      totalGrade: r.totalGrade ?? "",
      disqualified: !!r.disqualified,
    };
  });

  const r = await fetch("/api/admin/export-candidates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ scope: scopeLabel, includeDetailed: !!includeDetailed, rows: payloadRows }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${r.status}`);
  }
  const blob = await r.blob();
  const cd = r.headers.get("content-disposition") || "";
  const m = /filename=\"?([^\";]+)\"?/i.exec(cd);
  const filename = m?.[1] || "admin_candidates.xlsx";

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function load() {
  elTbody.innerHTML = `<tr><td colspan="8" class="muted">Loading...</td></tr>`;
  const [rows, periods] = await Promise.all([
    apiGet("/api/admin/candidates"),
    apiGet("/api/admin/exam-periods").catch(() => []),
  ]);
  allRows = Array.isArray(rows) ? rows : [];
  allPeriods = Array.isArray(periods) ? periods : [];
  rebuildExamPeriodOptions();
  applyFilters(false);
}

async function autoRefresh() {
  try {
    const fresh = await apiGet("/api/admin/candidates");
    if (!Array.isArray(allRows) || fresh.length !== allRows.length || (fresh[0]?.sessionId !== allRows[0]?.sessionId)) {
      allRows = fresh;
      const keep = new Set((allRows || []).map((r) => Number(r.sessionId)));
      for (const sid of Array.from(selectedIds)) if (!keep.has(Number(sid))) selectedIds.delete(Number(sid));
      rebuildExamPeriodOptions();
      applyFilters(false);
    }
  } catch (e) {
    console.warn("autoRefresh failed:", e);
  }
}

setInterval(autoRefresh, 5000);
window.addEventListener("focus", autoRefresh);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) autoRefresh();
});

elQ.addEventListener("input", scheduleApply);
elQ.addEventListener("search", () => scheduleApply());
elSort.addEventListener("change", scheduleApply);
  elOnlyDone.addEventListener("change", scheduleApply);
  elOnlyDisq?.addEventListener("change", scheduleApply);
  elExamPeriod?.addEventListener("change", scheduleApply);
  elExaminerFilter?.addEventListener("change", scheduleApply);

elClear.addEventListener("click", () => {
  elQ.value = "";
  applyFilters(false);
  elQ.focus();
});

elPrev.addEventListener("click", () => { page = Math.max(1, page - 1); render(); });
elNext.addEventListener("click", () => { page = page + 1; render(); });

elBtnSelectVisible?.addEventListener("click", () => {
  for (const r of filtered) selectedIds.add(Number(r.sessionId));
  render();
});

elBtnClearSelection?.addEventListener("click", () => {
  selectedIds.clear();
  render();
});

elChkAll?.addEventListener("change", () => {
  const slice = getCurrentSlice();
  for (const r of slice) {
    const sid = Number(r.sessionId);
    if (elChkAll.checked) selectedIds.add(sid);
    else selectedIds.delete(sid);
  }
  render();
});

elBtnExportSelected?.addEventListener("click", async () => {
  try {
    elBtnExportSelected.disabled = true;
    const rows = allRows.filter((r) => selectedIds.has(Number(r.sessionId)));
    const includeDetailed = await askIncludeDetailedGrades();
    if (includeDetailed === null) return;
    showCandidatesBusy("Processing. Don't close this page. Please wait...");
    await exportRows(rows, "selected", includeDetailed);
  } catch (e) {
    await uiAlert(e?.message || String(e), { title: "Export Error" });
  } finally {
    hideCandidatesBusy();
    elBtnExportSelected.disabled = false;
  }
});

load().catch((e) => {
  elTbody.innerHTML = `<tr><td colspan="9" class="bad">Failed to load: ${escapeHtml(e.message || String(e))}</td></tr>`;
});

elReviewClose?.addEventListener("click", closeReviewModal);
elReviewOverlay?.addEventListener("click", (ev) => {
  if (ev.target === elReviewOverlay) closeReviewModal();
});

elTbody.addEventListener("change", (ev) => {
  const chk = ev.target?.closest?.("input[data-role='pick']");
  if (!chk) return;
  const sid = Number(chk.getAttribute("data-sid"));
  if (!Number.isFinite(sid) || sid <= 0) return;
  if (chk.checked) selectedIds.add(sid);
  else selectedIds.delete(sid);
  updateSelectionKpi();
  updateHeaderCheckbox();
});

elTbody.addEventListener("click", async (ev) => {
  const openBtn = ev.target?.closest?.("button[data-action='open-review']");
  if (openBtn) {
    const sid = Number(openBtn.getAttribute("data-sid"));
    if (!Number.isFinite(sid) || sid <= 0) return;
    const row = (allRows || []).find((r) => Number(r.sessionId) === sid);

    try {
      openBtn.disabled = true;
      const r = await fetch(`/api/admin/candidates/${sid}/details`, { credentials: "same-origin" });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) {
        location.href = "/index.html";
        return;
      }
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);

      if (elReviewTitle) {
        const name = String(row?.candidateName || "").trim() || `Candidate ${sid}`;
        elReviewTitle.textContent = `Review: ${name}`;
      }
      const writingGradeText = (j.writingGrade === null || j.writingGrade === undefined || j.writingGrade === "")
        ? "Not entered yet"
        : `${Number(j.writingGrade)}%`;
      const speakingGradeText = (j.speakingGrade === null || j.speakingGrade === undefined || j.speakingGrade === "")
        ? "Not entered yet"
        : `${Number(j.speakingGrade)}%`;
      if (elReviewMeta) {
        const total = j.totalGrade == null ? "-" : `${j.totalGrade}%`;
        const objective = `${Number(j.objectiveEarned || 0)}/${Number(j.objectiveMax || 0)}`;
        elReviewMeta.innerHTML = `Session: <span class="mono">S-${String(sid).padStart(6, "0")}</span> | Objective: <span class="mono">${escapeHtml(objective)}</span> | Writing: <span class="mono">${escapeHtml(writingGradeText)}</span> | Speaking: <span class="mono">${escapeHtml(speakingGradeText)}</span> | Total: <span class="mono">${escapeHtml(total)}</span>`;
      }

      const items = Array.isArray(j.items) ? j.items : [];
      const tableItems = items.filter((it) => String(it?.id || "") !== "q4");
      const rowsHtml = tableItems.map((it) => {
        let status = '<span class="muted">N/A</span>';
        if (it.isCorrect === true) status = '<span class="ok">Correct</span>';
        if (it.isCorrect === false) status = '<span class="bad">Wrong</span>';
        return `
          <tr>
            <td>${escapeHtml(String(it.section || ""))}</td>
            <td>${escapeHtml(cleanPromptText(it.prompt || ""))}</td>
            <td>${answerFmt(it.candidateAnswer)}</td>
            <td>${answerFmt(it.correctAnswer)}</td>
            <td>${status}</td>
          </tr>
        `;
      }).join("");

      if (elReviewBody) {
        elReviewBody.innerHTML = `
          <div style="overflow:auto">
            <table class="table">
              <thead>
                <tr>
                  <th>Section</th>
                  <th>Question</th>
                  <th>Candidate</th>
                  <th>Correct</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>${rowsHtml || `<tr><td colspan="5" class="muted">No details</td></tr>`}</tbody>
            </table>
          </div>
          <div class="hr"></div>
          <h3 style="margin:0 0 8px 0">Writing Review</h3>
          <pre class="writingBox">${escapeHtml(String(j.qWriting || ""))}</pre>
          <div class="small" style="margin-top:8px">
            Writing grade: <span class="mono">${escapeHtml(writingGradeText)}</span>
          </div>
          <div class="small" style="margin-top:4px">
            Speaking grade: <span class="mono">${escapeHtml(speakingGradeText)}</span>
          </div>
        `;
      }
      openReviewModal();
    } catch (e) {
      await uiAlert(e?.message || String(e), { title: "Load Error" });
    } finally {
      openBtn.disabled = false;
    }
    return;
  }

  const btn = ev.target?.closest?.("button[data-action='delete']");
  if (!btn) return;
  const sid = Number(btn.getAttribute("data-sid"));
  if (!Number.isFinite(sid) || sid <= 0) return;

  const ok = await uiConfirm(
    "Delete this candidate completely? This will remove them from candidates, sessions, and question_grades.",
    { title: "Delete Candidate" }
  );
  if (!ok) return;

  btn.disabled = true;
  try {
    const r = await fetch(`/api/admin/candidates/${sid}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) {
      location.href = "/index.html";
      return;
    }
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);

    selectedIds.delete(sid);
    const fresh = await apiGet("/api/admin/candidates");
    allRows = fresh;
    rebuildExamPeriodOptions();
    applyFilters(false);
  } catch (e) {
    await uiAlert(e?.message || String(e), { title: "Delete Error" });
    btn.disabled = false;
  }
});
