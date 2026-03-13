import { apiGet, apiPost, qs, escapeHtml, uiConfirm, uiPrompt } from "/app.js";
import { createAdminBootstrapHelpers } from "/admin/bootstrap.js";
import { createAdminBusyHelpers } from "/admin/busy.js";
import { createAdminExamPeriodHelpers } from "/admin/exam-periods.js";
import { createAdminImportHelpers } from "/admin/imports.js";
import { createAdminSpeakingHelpers } from "/admin/speaking.js";

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
const elRename = qs("#btnRenameExamPeriod");
const elDuplicate = qs("#btnDuplicateExamPeriod");
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
const adminState = {
  get busyCount() { return _busyCount; },
  set busyCount(value) { _busyCount = value; },
  get periods() { return _periods; },
  set periods(value) { _periods = value; },
  get speakingSlots() { return _speakingSlots; },
  set speakingSlots(value) { _speakingSlots = value; },
};

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

async function apiGetNoBusy(url) {
  const r = await fetch(String(url || ""), { method: "GET", credentials: "same-origin" });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && String(url || "").startsWith("/api/admin")) {
    location.href = "/admin/login.html";
    throw new Error("Not authenticated");
  }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

const { showAdminBusy, hideAdminBusy, setAdminBusyText, setAdminBusyProgress, delay } = createAdminBusyHelpers({
  elAdminBusyOverlay,
  elAdminBusyText,
  elAdminBusyBarFill,
  elAdminBusyPct,
  state: adminState,
});

const { renderSpeakingSlots, autoGenerateSpeakingSlots, loadSpeakingSlots, saveSpeakingSlotDateTime, wireSpeakingSlots } = createAdminSpeakingHelpers({
  apiGet,
  escapeHtml,
  getSelectedExamPeriodId,
  toDatetimeLocalValue,
  parseDatetimeLocalToMs,
  showAdminBusy,
  hideAdminBusy,
  elSpeakingSlotsBody,
  elSpeakingSlotsOut,
  state: adminState,
});

const { updateOpenPreview, renderSelectedPeriod, loadExamPeriods, wireExamPeriods } = createAdminExamPeriodHelpers({
  apiGet,
  apiPost,
  escapeHtml,
  uiPrompt,
  uiConfirm,
  fmtAthensStamp,
  parseDatetimeLocalToMs,
  toDatetimeLocalValue,
  buildSelect,
  getSelectedExamPeriodId,
  getPeriodById,
  showAdminBusy,
  hideAdminBusy,
  loadSpeakingSlots,
  elExamPeriodTop,
  elCreate,
  elRename,
  elDuplicate,
  elDelete,
  elOpenDT,
  elOpenUtcPreview,
  elDurMin,
  elSave,
  elCfgOut,
  elServerNow,
  elWindowLine,
  elSpeakingSlotsBody,
  state: adminState,
});

const { wireImports } = createAdminImportHelpers({
  apiGetNoBusy,
  apiPost,
  escapeHtml,
  getSelectedExamPeriodId,
  buildSelect,
  showAdminBusy,
  hideAdminBusy,
  setAdminBusyText,
  setAdminBusyProgress,
  delay,
  countryCodesSet: COUNTRY_CODES_SET,
  elDrop,
  elBrowse,
  elFile,
  elFileName,
  elImport,
  elOut,
  elSingleName,
  elSingleEmail,
  elSingleCountry,
  elCreateSingle,
  elSingleOut,
  elImportPeriodOverlay,
  elImportPeriodSelect,
  elImportPeriodCancel,
  elImportPeriodConfirm,
  elImportPeriodTitle,
  elImportPeriodSubtitle,
  state: adminState,
});

const { bootstrapAdmin } = createAdminBootstrapHelpers({
  apiGet,
  apiPost,
  escapeHtml,
  uiConfirm,
  autoGenerateSpeakingSlots,
  renderSpeakingSlots,
  loadExamPeriods,
  getSelectedExamPeriodId,
  elReloadSpeakingSlots,
  elSpeakingSlotsOut,
  elDeleteAll,
  elDeleteAllOut,
  elOut,
  elCfgOut,
  elSingleCountry,
  countryCodes: COUNTRY_CODES,
  state: adminState,
});

wireExamPeriods();
wireImports();

wireSpeakingSlots();
bootstrapAdmin();
