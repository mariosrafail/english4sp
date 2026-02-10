import { apiGet, qs, escapeHtml } from "/app.js";

const elExamPeriod = qs("#examPeriod");
const elExaminer = qs("#examinerFilter");
const elReload = qs("#btnReload");
const elRecreateZoom = qs("#btnRecreateZoom");
const elQ = qs("#q");
const elClear = qs("#clear");
const elFrom = qs("#fromDT");
const elTo = qs("#toDT");
const elPageSize = qs("#pageSize");
const elOut = qs("#out");
const elTbody = qs("#tbody");
const elPrev = qs("#prev");
const elNext = qs("#next");
const elPageNum = qs("#pageNum");
const elPageMax = qs("#pageMax");

let _rows = [];
let _view = [];
let _page = 1;

function toDatetimeLocalValue(ms) {
  const d = new Date(Number(ms));
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseDatetimeLocalToMs(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  const d = new Date(s);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function pageSize() {
  const n = Number(elPageSize?.value || 20);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

function selectedExamPeriodId() {
  const n = Number(elExamPeriod?.value || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function saveSpeakingStart(slotId) {
  const sid = Number(slotId);
  if (!Number.isFinite(sid) || sid <= 0) return;
  const startEl = document.querySelector(`input.speaking-start-input[data-slot-id="${sid}"]`);
  const startUtcMs = parseDatetimeLocalToMs(startEl?.value || "");
  if (!Number.isFinite(startUtcMs) || startUtcMs <= 0) throw new Error("Invalid date/time");
  const endUtcMs = startUtcMs + (60 * 60 * 1000);
  const r = await fetch(`/api/admin/speaking-slots/${encodeURIComponent(sid)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ startUtcMs, endUtcMs }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${r.status}`);
  }
  return r.json();
}

function hydrateExaminerFilter(rows) {
  const current = String(elExaminer?.value || "");
  const names = Array.from(
    new Set((rows || []).map((r) => String(r.examinerUsername || "").trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));
  if (!elExaminer) return;
  elExaminer.innerHTML = `<option value="">All examiners</option>` + names.map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join("");
  if (names.includes(current)) elExaminer.value = current;
}

function applyFilters() {
  const q = String(elQ?.value || "").trim().toLowerCase();
  const ex = String(elExaminer?.value || "").trim().toLowerCase();
  const fromMs = parseDatetimeLocalToMs(elFrom?.value || "");
  const toMs = parseDatetimeLocalToMs(elTo?.value || "");

  _view = (_rows || []).filter((r) => {
    if (ex) {
      const rx = String(r.examinerUsername || "").trim().toLowerCase();
      if (rx !== ex) return false;
    }
    if (Number.isFinite(fromMs) && Number(r.startUtcMs || 0) < fromMs) return false;
    if (Number.isFinite(toMs) && Number(r.startUtcMs || 0) > toMs) return false;
    if (!q) return true;
    const blob = [
      String(r.candidateName || ""),
      String(r.sessionToken || ""),
      String(r.examinerUsername || ""),
    ].join(" ").toLowerCase();
    return blob.includes(q);
  });
  const max = Math.max(1, Math.ceil(_view.length / pageSize()));
  if (_page > max) _page = max;
  renderTable();
}

function renderTable() {
  const size = pageSize();
  const max = Math.max(1, Math.ceil(_view.length / size));
  if (!Number.isFinite(_page) || _page < 1) _page = 1;
  if (_page > max) _page = max;
  const start = (_page - 1) * size;
  const part = _view.slice(start, start + size);

  if (!part.length) {
    elTbody.innerHTML = `<tr><td colspan="5" class="muted">No rows</td></tr>`;
  } else {
    elTbody.innerHTML = part.map((r) => {
      const id = Number(r.id || 0);
      const candidate = escapeHtml(String(r.candidateName || ""));
      const examiner = escapeHtml(String(r.examinerUsername || ""));
      const gateUrlRaw = String(r.speakingUrl || "").trim() || (r.sessionToken
        ? `${location.origin}/speaking.html?token=${encodeURIComponent(String(r.sessionToken || ""))}`
        : "");
      const gateUrl = escapeHtml(gateUrlRaw);
      const shortLink = gateUrlRaw
        ? escapeHtml(gateUrlRaw.length > 34 ? `${gateUrlRaw.slice(0, 34)}...` : gateUrlRaw)
        : "-";
      const startValue = Number.isFinite(Number(r.startUtcMs)) ? toDatetimeLocalValue(Number(r.startUtcMs)) : "";
      return `
        <tr data-slot-id="${id}">
          <td>
            <div style="display:flex; gap:8px; align-items:center;">
              <input class="input mono speaking-start-input" data-slot-id="${id}" type="datetime-local" step="60" value="${escapeHtml(startValue)}" style="min-width:178px;" />
              <button class="btn speaking-time-save-btn" data-slot-id="${id}" type="button" style="width:auto; min-width:62px; padding:8px 10px;">Save</button>
            </div>
          </td>
          <td>${candidate}</td>
          <td>${examiner || "-"}</td>
          <td>${gateUrlRaw ? `<a href="${gateUrl}" target="_blank" rel="noopener" class="mono">${shortLink}</a>` : "-"}</td>
          <td><button class="btn speaking-show-zoom-btn" data-slot-id="${id}" type="button" style="width:auto; min-width:92px;">Show</button></td>
        </tr>
      `;
    }).join("");
  }

  if (elPageNum) elPageNum.textContent = String(_page);
  if (elPageMax) elPageMax.textContent = String(max);
  if (elPrev) elPrev.disabled = _page <= 1;
  if (elNext) elNext.disabled = _page >= max;
}

async function autoGenerate(examPeriodId) {
  const ep = Number(examPeriodId);
  if (!Number.isFinite(ep) || ep <= 0) return null;
  const r = await fetch("/api/admin/speaking-slots/auto-generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ examPeriodId: ep }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${r.status}`);
  }
  return r.json();
}

async function recreateZoomLinks(examPeriodId) {
  const body = {};
  const ep = Number(examPeriodId || 0);
  if (Number.isFinite(ep) && ep > 0) body.examPeriodId = ep;
  const r = await fetch("/api/admin/speaking-slots/recreate-zoom-links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${r.status}`);
  }
  return r.json();
}

async function loadRows() {
  const ep = selectedExamPeriodId();
  if (elOut) elOut.textContent = "Loading...";
  let auto = null;
  let autoErr = "";
  if (ep) {
    try {
      auto = await autoGenerate(ep);
    } catch (e) {
      autoErr = String(e?.message || "auto-generate failed");
    }
  }

  const rowsUrl = ep
    ? `/api/admin/speaking-slots?examPeriodId=${encodeURIComponent(ep)}&limit=50000`
    : `/api/admin/speaking-slots?limit=50000`;
  const rows = await apiGet(rowsUrl);
  _rows = Array.isArray(rows) ? rows : [];
  hydrateExaminerFilter(_rows);
  _page = 1;
  applyFilters();

  if (elOut) {
    const created = Number(auto?.created || 0);
    const failed = Number(auto?.failed || 0);
    const part1 = created > 0 ? ` Auto-generated ${created} new slot(s).` : "";
    const part2 = failed > 0 ? ` ${failed} failed.` : "";
    const part3 = autoErr ? ` Auto-generate skipped: ${escapeHtml(autoErr)}.` : "";
    elOut.innerHTML = `<span class="ok">Loaded ${_rows.length} slot(s).${part1}${part2}${part3}</span>`;
  }
}

async function init() {
  const periods = await apiGet("/api/admin/exam-periods");
  const list = Array.isArray(periods) ? periods : [];
  if (elExamPeriod) {
    elExamPeriod.innerHTML =
      `<option value="">All exam periods</option>` +
      list.map((p) => `<option value="${Number(p.id)}">${escapeHtml(String(p.name || `Exam Period ${p.id}`))}</option>`).join("");
  }
  await loadRows();
}

if (elReload) elReload.addEventListener("click", () => { loadRows().catch((e) => { if (elOut) elOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`; }); });
if (elRecreateZoom) {
  elRecreateZoom.addEventListener("click", async () => {
    try {
      elRecreateZoom.disabled = true;
      if (elOut) elOut.textContent = "Recreating Zoom links...";
      const ep = selectedExamPeriodId();
      const out = await recreateZoomLinks(ep);
      const done = Number(out?.updated || 0);
      const failed = Number(out?.failed || 0);
      const scope = Number(out?.examPeriodId || 0) > 0 ? `exam period ${Number(out.examPeriodId)}` : "all exam periods";
      if (elOut) elOut.innerHTML = `<span class="ok">Recreated ${done} Zoom link(s) for ${escapeHtml(scope)}.</span>${failed > 0 ? ` <span class="bad">${failed} failed.</span>` : ""}`;
      await loadRows();
    } catch (e) {
      if (elOut) elOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
    } finally {
      elRecreateZoom.disabled = false;
    }
  });
}
if (elExamPeriod) elExamPeriod.addEventListener("change", () => { loadRows().catch((e) => { if (elOut) elOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`; }); });
if (elExaminer) elExaminer.addEventListener("change", () => { _page = 1; applyFilters(); });
if (elFrom) elFrom.addEventListener("change", () => { _page = 1; applyFilters(); });
if (elTo) elTo.addEventListener("change", () => { _page = 1; applyFilters(); });
if (elQ) elQ.addEventListener("input", () => { _page = 1; applyFilters(); });
if (elPageSize) elPageSize.addEventListener("change", () => { _page = 1; applyFilters(); });
if (elClear) elClear.addEventListener("click", () => {
  if (elQ) elQ.value = "";
  if (elExaminer) elExaminer.value = "";
  if (elFrom) elFrom.value = "";
  if (elTo) elTo.value = "";
  _page = 1;
  applyFilters();
});
if (elPrev) elPrev.addEventListener("click", () => { _page = Math.max(1, _page - 1); renderTable(); });
if (elNext) elNext.addEventListener("click", () => { _page += 1; renderTable(); });

if (elTbody) {
  elTbody.addEventListener("click", async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    const saveBtn = target.closest(".speaking-time-save-btn");
    if (saveBtn) {
      const slotId = Number(saveBtn.getAttribute("data-slot-id") || 0);
      try {
        if (elOut) elOut.textContent = "Saving...";
        const updated = await saveSpeakingStart(slotId);
        _rows = (_rows || []).map((x) => (Number(x.id) === slotId ? updated : x));
        _view = (_view || []).map((x) => (Number(x.id) === slotId ? updated : x));
        renderTable();
        if (elOut) elOut.innerHTML = `<span class="ok">Slot ${slotId} updated.</span>`;
      } catch (err) {
        if (elOut) elOut.innerHTML = `<span class="bad">Error: ${escapeHtml(err.message || String(err))}</span>`;
      }
      return;
    }

    const showZoomBtn = target.closest(".speaking-show-zoom-btn");
    if (showZoomBtn) {
      const slotId = Number(showZoomBtn.getAttribute("data-slot-id") || 0);
      const row = (_rows || []).find((x) => Number(x.id) === slotId);
      const zoomUrl = String(row?.joinUrl || "").trim();
      if (!zoomUrl) {
        if (elOut) elOut.innerHTML = `<span class="bad">No Zoom URL found for slot ${slotId}.</span>`;
        return;
      }
      try {
        await navigator.clipboard.writeText(zoomUrl);
        if (elOut) elOut.innerHTML = `<span class="ok">Zoom URL copied for slot ${slotId}.</span><br><a class="mono" href="${escapeHtml(zoomUrl)}" target="_blank" rel="noopener">${escapeHtml(zoomUrl)}</a>`;
      } catch {
        if (elOut) elOut.innerHTML = `<span class="ok">Zoom URL for slot ${slotId}:</span><br><a class="mono" href="${escapeHtml(zoomUrl)}" target="_blank" rel="noopener">${escapeHtml(zoomUrl)}</a>`;
      }
    }
  });
}

init().catch((e) => {
  if (elOut) elOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
});
