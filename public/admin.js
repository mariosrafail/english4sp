import { apiGet, apiPost, qs, escapeHtml, uiConfirm, uiPrompt } from "/app.js";

const elOut = qs("#out");

const elDrop = qs("#dropZone");
const elBrowse = qs("#btnBrowse");
const elFile = qs("#fileInput");
const elFileName = qs("#fileName");
const elImport = qs("#btnImport");
const elSingleName = qs("#singleName");
const elSingleEmail = qs("#singleEmail");
const elSingleCountry = qs("#singleCountry");
const elCreateSingle = qs("#btnCreateSingle");
const elSingleOut = qs("#singleOut");

const elExamPeriodTop = qs("#examPeriodSelectTop");
const elCreate = qs("#btnCreateExamPeriod");
const elDelete = qs("#btnDeleteExamPeriod");
const elOpenDT = qs("#openDT");
const elOpenUtcPreview = qs("#openUtcPreview");
const elDurMin = qs("#durationMin");
const elSave = qs("#btnSaveExamPeriod");
const elCfgOut = qs("#cfgOut");

const elServerNow = qs("#serverNow");
const elWindowLine = qs("#windowLine");

const elDeleteAll = qs("#btnDeleteAllData");
const elDeleteAllOut = qs("#deleteAllOut");
const elImportPeriodOverlay = qs("#importPeriodOverlay");
const elImportPeriodSelect = qs("#importPeriodSelect");
const elImportPeriodCancel = qs("#btnImportPeriodCancel");
const elImportPeriodConfirm = qs("#btnImportPeriodConfirm");
const elImportPeriodTitle = elImportPeriodOverlay ? elImportPeriodOverlay.querySelector("h2") : null;
const elImportPeriodSubtitle = elImportPeriodOverlay ? elImportPeriodOverlay.querySelector("p.muted") : null;
const elAdminBusyOverlay = qs("#adminBusyOverlay");
const elAdminBusyText = qs("#adminBusyText");
const elAdminBusyBarFill = qs("#adminBusyBarFill");
const elAdminBusyPct = qs("#adminBusyPct");
const elReloadSpeakingSlots = qs("#btnReloadSpeakingSlots");
const elSpeakingSlotsOut = qs("#speakingSlotsOut");
const elSpeakingSlotsBody = qs("#speakingSlotsBody");
let _busyCount = 0;
let _speakingSlots = [];

const ATHENS_TZ = "Europe/Athens";
const COUNTRY_CODES = [
  "AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR","AS","AT","AU","AW","AX","AZ",
  "BA","BB","BD","BE","BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ","BR","BS",
  "BT","BV","BW","BY","BZ","CA","CC","CD","CF","CG","CH","CI","CK","CL","CM","CN",
  "CO","CR","CU","CV","CW","CX","CY","CZ","DE","DJ","DK","DM","DO","DZ","EC","EE",
  "EG","EH","ER","ES","ET","FI","FJ","FK","FM","FO","FR","GA","GB","GD","GE","GF",
  "GG","GH","GI","GL","GM","GN","GP","GQ","GR","GS","GT","GU","GW","GY","HK","HM",
  "HN","HR","HT","HU","ID","IE","IL","IM","IN","IO","IQ","IR","IS","IT","JE","JM",
  "JO","JP","KE","KG","KH","KI","KM","KN","KP","KR","KW","KY","KZ","LA","LB","LC",
  "LI","LK","LR","LS","LT","LU","LV","LY","MA","MC","MD","ME","MF","MG","MH","MK",
  "ML","MM","MN","MO","MP","MQ","MR","MS","MT","MU","MV","MW","MX","MY","MZ","NA",
  "NC","NE","NF","NG","NI","NL","NO","NP","NR","NU","NZ","OM","PA","PE","PF","PG",
  "PH","PK","PL","PM","PN","PR","PS","PT","PW","PY","QA","RE","RO","RS","RU","RW",
  "SA","SB","SC","SD","SE","SG","SH","SI","SJ","SK","SL","SM","SN","SO","SR","SS",
  "ST","SV","SX","SY","SZ","TC","TD","TF","TG","TH","TJ","TK","TL","TM","TN","TO",
  "TR","TT","TV","TW","TZ","UA","UG","UM","US","UY","UZ","VA","VC","VE","VG","VI",
  "VN","VU","WF","WS","YE","YT","ZA","ZM","ZW"
];
const COUNTRY_CODES_SET = new Set(COUNTRY_CODES);

function fmtAthensStamp(ms) {
  const d = new Date(Number(ms));
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: ATHENS_TZ,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return fmt.format(d);
}

function toDatetimeLocalValue(ms) {
  const d = new Date(Number(ms));
  const pad = (n) => String(n).padStart(2, "0");
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  return `${y}-${m}-${day}T${hh}:${mm}`;
}

function parseDatetimeLocalToMs(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  const d = new Date(s);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  return ms;
}

function setupCountryCodesList() {
  if (!elSingleCountry) return;
  let dn = null;
  try {
    dn = new Intl.DisplayNames(["en"], { type: "region" });
  } catch {}
  const keep = `<option value="">Select country code</option>`;
  const opts = COUNTRY_CODES.map((c) => {
    const country = dn ? String(dn.of(c) || c) : c;
    return `<option value="${c}">${c} (${escapeHtml(country)})</option>`;
  }).join("");
  elSingleCountry.innerHTML = keep + opts;
}

function setFile(f) {
  if (!f) {
    elFileName.textContent = "No file selected";
    return;
  }
  elFileName.textContent = f.name || "selected";
}

function buildSelect(el, periods, selectedId) {
  const id = Number(selectedId);
  el.innerHTML = "";
  for (const p of periods) {
    const opt = document.createElement("option");
    opt.value = String(p.id);
    const name = String(p.name || "").trim() || `Exam period ${p.id}`;
    opt.textContent = name;
    if (Number(p.id) === id) opt.selected = true;
    el.appendChild(opt);
  }
}

let _periods = [];

function getSelectedExamPeriodId() {
  const v = Number(elExamPeriodTop.value || 1);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function getPeriodById(id) {
  return _periods.find((p) => Number(p.id) === Number(id)) || null;
}

function updateOpenPreview() {
  const ms = parseDatetimeLocalToMs(elOpenDT.value);
  elOpenUtcPreview.textContent = ms == null ? "-" : fmtAthensStamp(ms);
}

function renderSelectedPeriod() {
  const id = getSelectedExamPeriodId();
  const p = getPeriodById(id);
  if (!p) return;

  elOpenDT.value = toDatetimeLocalValue(p.openAtUtc);
  updateOpenPreview();
  elDurMin.value = String(p.durationMinutes || 60);

  const endAt = Number(p.openAtUtc) + Number(p.durationMinutes) * 60 * 1000;
  elWindowLine.textContent = `${fmtAthensStamp(p.openAtUtc)}  to  ${fmtAthensStamp(endAt)}`;
}

function renderSpeakingSlots() {
  if (!elSpeakingSlotsBody) return;
  const rows = Array.isArray(_speakingSlots) ? _speakingSlots : [];
  if (!rows.length) {
    elSpeakingSlotsBody.innerHTML = `<tr><td colspan="5" class="muted">No slots</td></tr>`;
    return;
  }

  elSpeakingSlotsBody.innerHTML = rows.map((r) => {
    const id = Number(r.id || 0);
    const candidate = escapeHtml(String(r.candidateName || ""));
    const examiner = escapeHtml(String(r.examinerUsername || ""));
    const gateUrlRaw = String(r.speakingUrl || "").trim() || (r.sessionToken
      ? `${location.origin}/speaking.html?token=${encodeURIComponent(String(r.sessionToken || ""))}`
      : "");
    const gateUrl = escapeHtml(gateUrlRaw);
    const startValue = Number.isFinite(Number(r.startUtcMs)) ? toDatetimeLocalValue(Number(r.startUtcMs)) : "";

    return `
      <tr data-slot-id="${id}">
        <td>
          <div style="display:flex; gap:8px; align-items:center;">
            <input
              class="input mono speaking-start-input"
              data-slot-id="${id}"
              type="datetime-local"
              step="60"
              value="${escapeHtml(startValue)}"
              style="min-width:178px;"
            />
            <button class="btn speaking-time-save-btn" data-slot-id="${id}" type="button" style="width:auto; min-width:62px; padding:8px 10px;">Save</button>
          </div>
        </td>
        <td>${candidate}</td>
        <td>${examiner || "-"}</td>
        <td>${gateUrlRaw ? `<a href="${gateUrl}" target="_blank" rel="noopener" class="mono">Open</a>` : "-"}</td>
        <td>
          <button class="btn speaking-show-meeting-btn" data-slot-id="${id}" type="button" style="width:auto; min-width:92px;">Show</button>
        </td>
      </tr>
    `;
  }).join("");
}

async function loadSpeakingSlots() {
  if (!elSpeakingSlotsBody) return;
  const ep = getSelectedExamPeriodId();
  if (!Number.isFinite(ep) || ep <= 0) return;
  try {
    await autoGenerateSpeakingSlots(ep);
  } catch {}
  const rows = await apiGet(`/api/admin/speaking-slots?examPeriodId=${encodeURIComponent(ep)}&limit=2000`);
  _speakingSlots = Array.isArray(rows) ? rows : [];
  renderSpeakingSlots();
}

async function autoGenerateSpeakingSlots(examPeriodId) {
  const ep = Number(examPeriodId);
  if (!Number.isFinite(ep) || ep <= 0) return { created: 0, skipped: 0 };
  showAdminBusy("Auto-generating speaking slots. Please wait...");
  try {
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
  } finally {
    hideAdminBusy();
  }
}

async function saveSpeakingSlotDateTime(slotId) {
  const sid = Number(slotId);
  if (!Number.isFinite(sid) || sid <= 0) return;
  const startEl = document.querySelector(`input.speaking-start-input[data-slot-id="${sid}"]`);
  const startUtcMs = parseDatetimeLocalToMs(startEl?.value || "");
  if (!Number.isFinite(startUtcMs) || startUtcMs <= 0) throw new Error("Invalid date/time");
  const endUtcMs = startUtcMs + (60 * 60 * 1000);
  showAdminBusy("Saving speaking slot. Please wait...");
  try {
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
    const updated = await r.json();
    _speakingSlots = (_speakingSlots || []).map((x) => (Number(x.id) === sid ? updated : x));
    renderSpeakingSlots();
  } finally {
    hideAdminBusy();
  }
}

function showAdminBusy(message) {
  _busyCount += 1;
  if (elAdminBusyText) {
    elAdminBusyText.textContent = String(message || "Processing. Don't close this page. Please wait...");
  }
  setAdminBusyProgress(null, null);
  if (elAdminBusyOverlay) elAdminBusyOverlay.style.display = "flex";
}

function hideAdminBusy() {
  _busyCount = Math.max(0, _busyCount - 1);
  if (_busyCount === 0 && elAdminBusyOverlay) {
    elAdminBusyOverlay.style.display = "none";
  }
}

function setAdminBusyText(message) {
  if (elAdminBusyText) {
    elAdminBusyText.textContent = String(message || "Processing. Don't close this page. Please wait...");
  }
}

function fmtEtaSeconds(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function setAdminBusyProgress(pct, etaSeconds) {
  if (!elAdminBusyBarFill && !elAdminBusyPct) return;
  if (pct === null || pct === undefined) {
    try { if (elAdminBusyBarFill) elAdminBusyBarFill.style.width = "0%"; } catch {}
    try { if (elAdminBusyPct) elAdminBusyPct.textContent = ""; } catch {}
    return;
  }
  const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  try { if (elAdminBusyBarFill) elAdminBusyBarFill.style.width = `${v}%`; } catch {}
  if (elAdminBusyPct) {
    const eta = Number.isFinite(Number(etaSeconds)) && Number(etaSeconds) > 0 ? ` · ETA ${fmtEtaSeconds(etaSeconds)}` : "";
    elAdminBusyPct.textContent = `${v}%${eta}`;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function apiGetNoBusy(url) {
  const r = await fetch(String(url || ""), { method: "GET", credentials: "same-origin" });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && String(url || "").startsWith("/api/admin")) {
    location.href = "/index.html";
    throw new Error("Not authenticated");
  }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

let _adminUiCfg = null;
async function getAdminUiCfg() {
  if (_adminUiCfg) return _adminUiCfg;
  try {
    const cfg = await apiGetNoBusy("/api/config");
    _adminUiCfg = (cfg && typeof cfg === "object" && cfg.adminUi && typeof cfg.adminUi === "object") ? cfg.adminUi : {};
  } catch {
    _adminUiCfg = {};
  }
  return _adminUiCfg;
}

function askImportExamPeriodId(defaultId, mode = "candidates") {
  return new Promise((resolve) => {
    const periods = Array.isArray(_periods) ? _periods : [];
    if (!elImportPeriodOverlay || !elImportPeriodSelect || !periods.length) {
      resolve(Number(defaultId) || 1);
      return;
    }

    const pick = Number(defaultId) || Number(periods[0]?.id) || 1;
    buildSelect(elImportPeriodSelect, periods, pick);
    elImportPeriodSelect.value = String(pick);
    const singular = String(mode || "").toLowerCase() === "candidate";
    if (elImportPeriodTitle) {
      elImportPeriodTitle.textContent = singular ? "Select Exam Period for Candidate" : "Select Exam Period for Candidates";
    }
    if (elImportPeriodSubtitle) {
      elImportPeriodSubtitle.textContent = singular
        ? "Select where this candidate should be placed."
        : "Select where imported candidates should be placed.";
    }
    elImportPeriodOverlay.style.display = "flex";

    const cleanup = () => {
      elImportPeriodOverlay.style.display = "none";
      elImportPeriodConfirm?.removeEventListener("click", onConfirm);
      elImportPeriodCancel?.removeEventListener("click", onCancel);
      elImportPeriodOverlay.removeEventListener("click", onOverlayClick);
    };
    const onConfirm = () => {
      const v = Number(elImportPeriodSelect.value || pick);
      cleanup();
      resolve(Number.isFinite(v) && v > 0 ? v : pick);
    };
    const onCancel = () => {
      cleanup();
      resolve(null);
    };
    const onOverlayClick = (e) => {
      if (e.target === elImportPeriodOverlay) onCancel();
    };

    elImportPeriodConfirm?.addEventListener("click", onConfirm);
    elImportPeriodCancel?.addEventListener("click", onCancel);
    elImportPeriodOverlay.addEventListener("click", onOverlayClick);
  });
}

async function loadExamPeriods(selectedId) {
  const cfg = await apiGet("/api/config");
  elServerNow.textContent = fmtAthensStamp(cfg.serverNow);

  _periods = await apiGet("/api/admin/exam-periods");
  if (!Array.isArray(_periods) || !_periods.length) {
    _periods = [{ id: 1, name: "Default", openAtUtc: Date.now(), durationMinutes: 60 }];
  }

  const pick = Number(selectedId) || Number(_periods[0].id) || 1;
  buildSelect(elExamPeriodTop, _periods, pick);
  elExamPeriodTop.value = String(pick);
  renderSelectedPeriod();
  if (elSpeakingSlotsBody) await loadSpeakingSlots().catch(() => {});
}

elOpenDT.addEventListener("input", updateOpenPreview);

elExamPeriodTop.addEventListener("change", () => {
  renderSelectedPeriod();
  if (elSpeakingSlotsBody) loadSpeakingSlots().catch(() => {});
});

elCreate.addEventListener("click", async () => {
  try {
    elCreate.disabled = true;
    elCfgOut.innerHTML = "";

    const nameRaw = await uiPrompt("Enter exam period name.", "", { title: "Create Exam Period" });
    if (nameRaw === null) return;

    const name = nameRaw && String(nameRaw).trim() ? String(nameRaw).trim() : undefined;

    const out = await apiPost("/api/admin/exam-periods", {
      name,
    });

    await loadExamPeriods(out?.id || getSelectedExamPeriodId());
    elCfgOut.innerHTML = `<span class="ok">Created.</span>`;
  } catch (e) {
    elCfgOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
  } finally {
    elCreate.disabled = false;
  }
});

elDelete.addEventListener("click", async () => {
  let didBusy = false;
  let shouldReload = false;
  try {
    elDelete.disabled = true;
    elCfgOut.innerHTML = "";

    const id = getSelectedExamPeriodId();
    const p = getPeriodById(id);
    const label = String(p?.name || "").trim() || `Exam period ${id}`;
    const ok = await uiConfirm(`Delete "${label}" (ID ${id}) and all its sessions?`, { title: "Delete Exam Period", yesText: "Delete", noText: "Cancel", danger: true });
    if (!ok) return;

    showAdminBusy("Deleting exam period. Please wait...");
    didBusy = true;
    const r = await fetch(`/api/admin/exam-periods/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }

    elCfgOut.innerHTML = `<span class="ok">Deleted.</span>`;
    // Hard refresh so embedded tools/iframes re-fetch dropdowns and state.
    shouldReload = true;
  } catch (e) {
    elCfgOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
  } finally {
    try { if (didBusy) hideAdminBusy(); } catch {}
    elDelete.disabled = false;
    if (shouldReload) {
      setTimeout(() => {
        try { location.reload(); } catch {}
      }, 50);
    }
  }
});

elSave.addEventListener("click", async () => {
  let didBusy = false;
  try {
    elSave.disabled = true;
    elCfgOut.innerHTML = "";

    const id = getSelectedExamPeriodId();
    const p = getPeriodById(id);
    const name = String(p?.name || "").trim();

    const openMs = parseDatetimeLocalToMs(elOpenDT.value);
    if (openMs === null) throw new Error("Invalid open date/time");

    const durMinutes = Number(elDurMin.value || 0);
    if (!Number.isFinite(durMinutes) || durMinutes <= 0) throw new Error("Invalid duration");

    showAdminBusy("Saving exam period. Please wait...");
    didBusy = true;
    const r = await fetch(`/api/admin/exam-periods/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, openAtUtc: openMs, durationMinutes: Math.round(durMinutes) }),
      credentials: "same-origin",
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }

    await loadExamPeriods(id);
    elCfgOut.innerHTML = `<span class="ok">Saved.</span>`;
  } catch (e) {
    elCfgOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
  } finally {
    try { if (didBusy) hideAdminBusy(); } catch {}
    elSave.disabled = false;
  }
});

elBrowse.addEventListener("click", () => elFile.click());
elFile.addEventListener("change", () => {
  const f = elFile.files && elFile.files[0];
  setFile(f);
});

["dragenter", "dragover"].forEach((evt) => {
  elDrop.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    elDrop.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((evt) => {
  elDrop.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    elDrop.classList.remove("dragover");
  });
});

elDrop.addEventListener("drop", (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  try {
    const dt = new DataTransfer();
    dt.items.add(f);
    elFile.files = dt.files;
  } catch {}
  setFile(f);
});

elImport.addEventListener("click", async () => {
  try {
    elImport.disabled = true;
    elOut.textContent = "Processing...";

    const f = elFile.files && elFile.files[0];
    if (!f) throw new Error("Select an Excel file first");

    const defaultEp = getSelectedExamPeriodId();
    const ep = await askImportExamPeriodId(defaultEp, "candidates");
    if (!ep) {
      elOut.innerHTML = `<span class="muted">Import cancelled.</span>`;
      return;
    }
    if (!Number.isFinite(ep) || ep <= 0) throw new Error("Invalid exam period id");

    const fd = new FormData();
    fd.append("file", f);
    fd.append("examPeriodId", String(ep));

    showAdminBusy("Processing... Importing. Loaded 0/0");
    const r = await fetch("/api/admin/import-excel/job/start", {
      method: "POST",
      body: fd,
      credentials: "same-origin",
    });

    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }

    const start = await r.json().catch(() => ({}));
    let job = start?.job || null;
    const jobId = String(job?.jobId || "").trim();
    if (!jobId) throw new Error("Import job did not start.");

    // Show initial progress immediately (before first poll), so it doesn't jump to 114/114.
    const initialTotal = Math.max(0, Number(job?.total || 0));
    if (initialTotal > 0) setAdminBusyText(`Processing... Importing. Loaded 0/${initialTotal}`);
    setAdminBusyProgress(0, null);

    const phaseLabel = (p) => {
      const ph = String(p || "").trim().toLowerCase();
      if (ph === "candidates") return "Upserting candidates";
      if (ph === "lookup") return "Reading candidates";
      if (ph === "sessions_lookup") return "Checking existing sessions";
      if (ph === "sessions") return "Creating sessions";
      if (ph === "assigning") return "Assigning examiners";
      if (ph === "speaking") return "Speaking slots";
      if (ph === "exporting") return "Preparing export";
      if (ph === "done") return "Finalizing";
      if (ph === "queued") return "Starting";
      return "Importing";
    };

    const phaseWeights = {
      queued: 0.00,
      candidates: 0.20,
      lookup: 0.06,
      sessions_lookup: 0.06,
      sessions: 0.20,
      assigning: 0.05,
      speaking: 0.38,
      exporting: 0.05,
      done: 0.00,
      error: 0.00,
    };
    const phaseOrder = ["queued", "candidates", "lookup", "sessions_lookup", "sessions", "assigning", "speaking", "exporting", "done"];

    const computePercent = (phaseRaw, processed, total) => {
      const ph = String(phaseRaw || "").trim().toLowerCase();
      if (ph === "done") return 100;
      if (ph === "error") return 100;

      const idx = phaseOrder.indexOf(ph);
      const curW = Number(phaseWeights[ph] || 0);
      const curP = (Number(total) > 0) ? Math.max(0, Math.min(1, Number(processed) / Number(total))) : 0;

      let base = 0;
      if (idx > 0) {
        for (let i = 0; i < idx; i++) base += Number(phaseWeights[phaseOrder[i]] || 0);
      }
      const pct = (base + (curW * curP)) * 100;
      return Math.max(0, Math.min(99.9, pct));
    };

    let lastText = "";
    let lastPct = null;
    let lastPctAt = 0;
    let lastEta = null;
    for (let i = 0; i < 1800; i++) {
      if (!job || !job.done) {
        const st = await apiGetNoBusy(`/api/admin/import-excel/job/${encodeURIComponent(jobId)}`);
        job = st?.job || job;
      }

      const processed = Number(job?.processed || 0);
      const total = Number(job?.total || 0);
      const phaseRaw = String(job?.phase || "").trim().toLowerCase();
      const ph = phaseLabel(phaseRaw);
      const verb = phaseRaw === "speaking"
        ? "Speaking"
        : (phaseRaw === "sessions" ? "Created" : "Progress");

      let text = "";
      text = total > 0
        ? `Processing... ${ph}. ${verb} ${Math.min(processed, total)}/${total}`
        : `Processing... ${ph}`;

      if (text !== lastText) {
        setAdminBusyText(text);
        lastText = text;
      }

      const pct = computePercent(phaseRaw, processed, total);
      let eta = null;
      const now = Date.now();
      if (lastPct !== null && lastPctAt > 0 && now > lastPctAt) {
        const dt = (now - lastPctAt) / 1000;
        const dp = pct - lastPct;
        const rate = dt > 0 ? (dp / dt) : 0;
        if (rate > 0.05) {
          const remain = Math.max(0, 100 - pct);
          eta = Math.min(12 * 3600, Math.round(remain / rate));
        }
      }
      lastPct = pct;
      lastPctAt = now;
      if (eta === null && lastEta != null) eta = lastEta;
      lastEta = eta;
      setAdminBusyProgress(pct, eta);

      if (job && job.done) break;
      const wait = phaseRaw === "speaking" ? 250 : 160;
      await delay(wait);
    }

    if (!job) throw new Error("Import status unavailable.");
    if (String(job.error || "").trim()) throw new Error(String(job.error));
    if (String(job.phase || "") === "error") throw new Error("Import failed.");

    setAdminBusyText("Downloading export...");
    const dl = await fetch(`/api/admin/import-excel/job/${encodeURIComponent(jobId)}/download`, {
      method: "GET",
      credentials: "same-origin",
    });
    if (!dl.ok) {
      const j = await dl.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${dl.status}`);
    }

    const blob = await dl.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sessions_examperiod_${ep}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    const speakingCreated = Number(job?.speakingCreated || 0);
    const speakingFailed = Number(job?.speakingFailed || 0);
    const speakingErr = String(job?.speakingError || "").trim();

    const speakingNote = (speakingCreated > 0 || speakingFailed > 0 || speakingErr)
      ? ` Speaking slots: created ${Math.max(0, speakingCreated)}, failed ${Math.max(0, speakingFailed)}.${speakingErr ? ` Error: ${escapeHtml(speakingErr)}` : ""}`
      : "";
    elOut.innerHTML = `<span class="ok">Done. Download started.</span>${speakingNote ? `<br><span class="${speakingFailed > 0 || speakingErr ? "bad" : "ok"}">${speakingNote}</span>` : ""}`;
  } catch (e) {
    elOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
  } finally {
    hideAdminBusy();
    elImport.disabled = false;
  }
});

if (elReloadSpeakingSlots) {
  elReloadSpeakingSlots.addEventListener("click", async () => {
    try {
      elReloadSpeakingSlots.disabled = true;
      if (elSpeakingSlotsOut) elSpeakingSlotsOut.textContent = "Loading...";
      const ep = getSelectedExamPeriodId();
      let auto = null;
      let autoErr = "";
      try {
        auto = await autoGenerateSpeakingSlots(ep);
      } catch (e) {
        autoErr = String(e?.message || "auto-generate failed");
      }
      const rows = await apiGet(`/api/admin/speaking-slots?examPeriodId=${encodeURIComponent(ep)}&limit=2000`);
      _speakingSlots = Array.isArray(rows) ? rows : [];
      renderSpeakingSlots();
      if (elSpeakingSlotsOut) {
        const created = Number(auto?.created || 0);
        const failed = Number(auto?.failed || 0);
        const note = created > 0
          ? ` Auto-generated ${created} new slot(s).`
          : "";
        const failNote = failed > 0
          ? ` ${failed} failed.`
          : "";
        const autoMsg = autoErr ? ` Auto-generate skipped: ${escapeHtml(autoErr)}.` : "";
        elSpeakingSlotsOut.innerHTML = `<span class="ok">Loaded ${_speakingSlots.length} slot(s).${note}${failNote}${autoMsg}</span>`;
      }
    } catch (e) {
      if (elSpeakingSlotsOut) elSpeakingSlotsOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
    } finally {
      elReloadSpeakingSlots.disabled = false;
    }
  });
}

if (elSpeakingSlotsBody) {
  elSpeakingSlotsBody.addEventListener("click", async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    const saveBtn = target.closest(".speaking-time-save-btn");
    if (saveBtn) {
      const slotId = Number(saveBtn.getAttribute("data-slot-id") || 0);
      try {
        if (elSpeakingSlotsOut) elSpeakingSlotsOut.textContent = "Saving...";
        await saveSpeakingSlotDateTime(slotId);
        if (elSpeakingSlotsOut) elSpeakingSlotsOut.innerHTML = `<span class="ok">Slot ${slotId} updated.</span>`;
      } catch (err) {
        if (elSpeakingSlotsOut) elSpeakingSlotsOut.innerHTML = `<span class="bad">Error: ${escapeHtml(err.message || String(err))}</span>`;
      }
      return;
    }

    const showMeetingBtn = target.closest(".speaking-show-meeting-btn");
    if (showMeetingBtn) {
      const slotId = Number(showMeetingBtn.getAttribute("data-slot-id") || 0);
      const row = (_speakingSlots || []).find((x) => Number(x.id) === slotId);
      const meetingUrl = String(row?.joinUrl || "").trim();
      if (!meetingUrl) {
        if (elSpeakingSlotsOut) elSpeakingSlotsOut.innerHTML = `<span class="bad">No meeting URL found for slot ${slotId}.</span>`;
        return;
      }
      try {
        await navigator.clipboard.writeText(meetingUrl);
        if (elSpeakingSlotsOut) {
          elSpeakingSlotsOut.innerHTML = `<span class="ok">Meeting URL copied for slot ${slotId}.</span><br><a class="mono" href="${escapeHtml(meetingUrl)}" target="_blank" rel="noopener">${escapeHtml(meetingUrl)}</a>`;
        }
      } catch {
        if (elSpeakingSlotsOut) {
          elSpeakingSlotsOut.innerHTML = `<span class="ok">Meeting URL for slot ${slotId}:</span><br><a class="mono" href="${escapeHtml(meetingUrl)}" target="_blank" rel="noopener">${escapeHtml(meetingUrl)}</a>`;
        }
      }
      return;
    }
  });
}

if (elCreateSingle) {
  elCreateSingle.addEventListener("click", async () => {
    try {
      elCreateSingle.disabled = true;
      if (elSingleOut) elSingleOut.textContent = "Creating...";

      const defaultEp = getSelectedExamPeriodId();
      const ep = await askImportExamPeriodId(defaultEp, "candidate");
      if (!ep) {
        if (elSingleOut) elSingleOut.innerHTML = `<span class="muted">Creation cancelled.</span>`;
        return;
      }
      if (!Number.isFinite(ep) || ep <= 0) throw new Error("Invalid exam period id");

      const name = String(elSingleName?.value || "").trim();
      const email = String(elSingleEmail?.value || "").trim();
      const country = String(elSingleCountry?.value || "").trim().toUpperCase();
      if (!email) throw new Error("Email is required");
      if (country && !COUNTRY_CODES_SET.has(country)) {
        throw new Error("Invalid country code. Use ISO alpha-2 (e.g. GR, US, DE).");
      }

      showAdminBusy("Creating candidate link. Don't close this page. Please wait...");
      const out = await apiPost("/api/admin/create-candidate", {
        name,
        email,
        country,
        examPeriodId: ep,
      });

      if (elSingleOut) {
        const status = out?.reused ? "Existing candidate/session reused." : "Candidate created.";
        const link = String(out?.url || "").trim();
        const speakingLink = String(out?.speakingUrl || "").trim();
        const speakingErr = String(out?.speakingAutoError || "").trim();
        const speakingLine = speakingLink
          ? `<br>Speaking: <a class="mono" href="${escapeHtml(speakingLink)}" target="_blank" rel="noopener">Open</a>`
          : "";
        const errLine = speakingErr ? `<br><span class="bad">Speaking link auto-generation failed: ${escapeHtml(speakingErr)}</span>` : "";
        const examLine = link
          ? `<a class="mono" href="${escapeHtml(link)}" target="_blank" rel="noopener">Open</a>`
          : `<span class="muted">-</span>`;
        elSingleOut.innerHTML = `<span class="ok">${escapeHtml(status)}</span><br>Exam: ${examLine}${speakingLine}${errLine}`;
      }
    } catch (e) {
      if (elSingleOut) {
        elSingleOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
      }
    } finally {
      hideAdminBusy();
      elCreateSingle.disabled = false;
    }
  });
}

setupCountryCodesList();

loadExamPeriods(1).catch((e) => {
  elCfgOut.innerHTML = `<span class="bad">Failed to load: ${escapeHtml(e.message || String(e))}</span>`;
});

if (elDeleteAll) {
  elDeleteAll.addEventListener("click", async () => {
    try {
      const ok = await uiConfirm(
        "Are you sure? This will permanently delete ALL data from question_grades, sessions, and candidates.",
        { title: "Delete All Data" }
      );
      if (!ok) return;

      elDeleteAll.disabled = true;
      if (elDeleteAllOut) elDeleteAllOut.innerHTML = "Deleting...";

      await apiPost("/api/admin/delete-all-data", {});

      if (elDeleteAllOut) elDeleteAllOut.innerHTML = `<span class="ok">Deleted.</span>`;
      elOut.innerHTML = "";
      elCfgOut.innerHTML = "";
    } catch (e) {
      if (elDeleteAllOut) {
        elDeleteAllOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
      }
    } finally {
      if (elDeleteAll) elDeleteAll.disabled = false;
    }
  });
}
