import { apiGet, apiPost, qs, escapeHtml, busyStart } from "/app.js";
import { createListeningModalHelpers } from "/admin-tests/listening-modal.js";
import { createWritingEditorHelpers } from "/admin-tests/writing.js";
import { createQuestionsListHelpers } from "/admin-tests/questions.js";

const elExamPeriod = qs("#examPeriod");
const elWeightListening = qs("#weightListening");
const elWeightReading = qs("#weightReading");
const elWeightWriting = qs("#weightWriting");
const elWeightSpeaking = qs("#weightSpeaking");
const elWeightTotal = qs("#weightTotal");
const elSaveWeights = qs("#btnSaveWeights");
const elGradeWeightsBar = qs(".gradeWeightsBar");

const elMcqEditor = qs("#mcqEditor");
const elReadingTextEditor = qs("#readingTextEditor");
const elDragEditor = qs("#dragEditor");
const elWritingEditor = qs("#writingEditor");

const elListeningToolbar = qs("#listeningToolbar");
const elListeningNewQuestion = qs("#btnListeningNewQuestion");
const elListeningNewText = qs("#btnListeningNewText");

const elReadingToolbar = qs("#readingToolbar");
const elReadingNewText = qs("#btnReadingNewText");
const elReadingNewQuestion = qs("#btnReadingNewQuestion");

const elListeningModalOverlay = qs("#listeningModalOverlay");
const elListeningModalWindow = qs("#listeningModalWindow");
const elListeningModalTitle = qs("#listeningModalTitle");
const elListeningModalClose = qs("#btnListeningModalClose");
const elListeningModalSave = qs("#btnListeningModalSave");
const elListeningModalCancel = qs("#btnListeningModalCancel");
const elListeningModalMcq = qs("#listeningModalMcq");
const elListeningModalInfo = qs("#listeningModalInfo");
const elListeningModalQText = qs("#listeningModalQText");
const elListeningModalOptionsBox = qs("#listeningModalOptionsBox");
const elListeningModalAddOption = qs("#btnListeningModalAddOption");
const elListeningModalRemoveOption = qs("#btnListeningModalRemoveOption");
const elListeningModalInfoText = qs("#listeningModalInfoText");
const elListeningModalBold = qs("#btnListeningModalBold");

const elMcqFields = qs("#mcqFields");

const elQText = qs("#qText");
const elOptionsBox = qs("#optionsBox");
const elAddOption = qs("#btnAddOption");
const elRemoveOption = qs("#btnRemoveOption");
const elSaveItem = qs("#btnAddQuestion");
const elNewQuestion = qs("#btnNewQuestion");
const elClearItem = qs("#btnClearQuestion");

const elReadingText = qs("#readingText");
const elSaveReadingText = qs("#btnSaveReadingText");
const elClearReadingText = qs("#btnClearReadingText");

const elDragInstructions = qs("#dragInstructions");
const elDragText = qs("#dragText");
const elDragExtras = qs("#dragExtras");
const elDragPreview = qs("#dragPreview");
const elSaveDrag = qs("#btnSaveDrag");
const elResetDrag = qs("#btnResetDrag");
const elDragTitle = qs("#dragTitle");

const elWritingPrompt = qs("#writingPrompt");
const elSaveWriting = qs("#btnSaveWriting");
const elResetWriting = qs("#btnResetWriting");

const elSavePreview = qs("#btnSavePreview");

const elQuestionsList = qs("#questionsList");
const elQTabs = Array.from(document.querySelectorAll("button.admin-q-tab[data-qtab]"));
const elQPanels = Array.from(document.querySelectorAll(".admin-q-panel[data-qpanel]"));
const elQuestionsListening = qs("#questionsListening");
const elQuestionsReading = qs("#questionsReading");
const elQuestionsWriting = qs("#questionsWriting");
const elOut = qs("#out");
const elTestLockBanner = qs("#testLockBanner");

let _payload = null; // full payload (includes correctIndex)
let _payloadInitial = null; // for reset actions
let _qTab = "listening";
let _editingMcq = { sectionId: "listening", itemId: null };
let _editingReadingTextId = null;
let _editingInfo = { sectionId: "listening", itemId: null };
let _editorMode = "mcq"; // "mcq" | "info"
let _mcqLockMode = ""; // "", "tf"
let _builderLocked = false;
let _builderLockMeta = null;
let _lastItemIdBySection = { listening: null, reading: null };
let _listeningModalState = { open: false, sectionId: "listening", mode: "mcq", itemId: null, afterItemId: null };
let _dndState = { dragging: false, sectionId: "", itemId: "", overCard: null, overAfter: false };
const DEFAULT_GRADE_WEIGHTS = { listening: 20, reading: 20, writing: 20, speaking: 40 };
let showListeningModal = () => {};
let setListeningModalMode = () => {};
let renderListeningModalOptions = () => {};
let readListeningModalMcqForm = () => ({ prompt: "", choices: [], correctIdx: -1, nonEmpty: 0 });
let openListeningModal = () => {};
let saveListeningModal = async () => {};
let wireListeningModalEvents = () => {};
let buildDragPreview = () => ({ gapWords: [], extras: [], bank: [], previewText: "", instructions: "", text: "", extraWords: "" });
let ensureWritingDefaults = () => {};
let renderWritingEditorsFromPayload = () => {};
let renderDragPreview = () => {};
let saveDragFromEditor = () => ({ ok: false, error: "Unavailable." });
let saveWritingPromptFromEditor = () => ({ ok: false, error: "Unavailable." });
let wireWritingEditorEvents = () => {};
let deleteItem = () => {};
let moveItem = () => {};
let moveItemTo = () => false;
let loadItemIntoEditor = () => {};
let renderQuestionsList = () => {};
let wireQuestionListEvents = () => {};

function isEmbedded() {
  try {
    const sp = new URLSearchParams(location.search || "");
    if (sp.get("embed") === "1") return true;
  } catch {}
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function postParentFullscreen(on) {
  try {
    // Disabled: parent-level fullscreen/backdrop was darkening the whole admin UI.
    void on;
    return false;
  } catch {
    return false;
  }
}

function setOut(msg, ok = true) {
  if (!elOut) return;
  elOut.innerHTML = ok ? `<span class="ok">${escapeHtml(msg)}</span>` : `<span class="bad">${escapeHtml(msg)}</span>`;
}

function cloneJson(x) {
  return JSON.parse(JSON.stringify(x || {}));
}

function normalizeWeightValue(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function ensureGradeWeights(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const src = p.gradeWeights && typeof p.gradeWeights === "object" ? p.gradeWeights : {};
  p.gradeWeights = {
    listening: normalizeWeightValue(src.listening, DEFAULT_GRADE_WEIGHTS.listening),
    reading: normalizeWeightValue(src.reading, DEFAULT_GRADE_WEIGHTS.reading),
    writing: normalizeWeightValue(src.writing, DEFAULT_GRADE_WEIGHTS.writing),
    speaking: normalizeWeightValue(src.speaking, DEFAULT_GRADE_WEIGHTS.speaking),
  };
  return p.gradeWeights;
}

function readGradeWeightsInputs() {
  return {
    listening: normalizeWeightValue(elWeightListening?.value, DEFAULT_GRADE_WEIGHTS.listening),
    reading: normalizeWeightValue(elWeightReading?.value, DEFAULT_GRADE_WEIGHTS.reading),
    writing: normalizeWeightValue(elWeightWriting?.value, DEFAULT_GRADE_WEIGHTS.writing),
    speaking: normalizeWeightValue(elWeightSpeaking?.value, DEFAULT_GRADE_WEIGHTS.speaking),
  };
}

function gradeWeightsTotal(weights) {
  const w = weights || {};
  return (Number(w.listening) || 0) + (Number(w.reading) || 0) + (Number(w.writing) || 0) + (Number(w.speaking) || 0);
}

function renderGradeWeights() {
  if (!_payload) return;
  const w = ensureGradeWeights(_payload);
  try { if (elWeightListening) elWeightListening.value = String(w.listening); } catch {}
  try { if (elWeightReading) elWeightReading.value = String(w.reading); } catch {}
  try { if (elWeightWriting) elWeightWriting.value = String(w.writing); } catch {}
  try { if (elWeightSpeaking) elWeightSpeaking.value = String(w.speaking); } catch {}
  updateGradeWeightTotal();
}

function updateGradeWeightTotal() {
  const w = readGradeWeightsInputs();
  const total = gradeWeightsTotal(w);
  try { if (elWeightTotal) elWeightTotal.textContent = `${total}%`; } catch {}
  try { if (elGradeWeightsBar) elGradeWeightsBar.classList.toggle("is-invalid", total !== 100); } catch {}
  return total;
}

function applyGradeWeightsFromInputs() {
  if (!_payload || typeof _payload !== "object") _payload = { version: 1, randomize: false, sections: [] };
  const weights = readGradeWeightsInputs();
  const total = gradeWeightsTotal(weights);
  if (total !== 100) throw new Error(`Grade weights must add up to 100. Current total: ${total}%.`);
  _payload.gradeWeights = weights;
  updateGradeWeightTotal();
}

function fmtLocal(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  try { return new Date(n).toLocaleString(); } catch { return ""; }
}

function setBuilderLocked(locked, meta) {
  _builderLocked = !!locked;
  _builderLockMeta = meta && typeof meta === "object" ? meta : null;
  applyBuilderLocked();
}

function applyBuilderLocked() {
  const locked = !!_builderLocked;
  try { if (elTestLockBanner) elTestLockBanner.style.display = locked ? "" : "none"; } catch {}

  if (locked && elTestLockBanner) {
    const openAt = _builderLockMeta?.openAtUtc;
    const when = fmtLocal(openAt);
    const parts = [];
    parts.push(`<div class="fw-bold">Test is locked</div>`);
    parts.push(`<div class="small">The exam has already started, so changes are disabled.</div>`);
    if (when) parts.push(`<div class="small text-muted mt-1">Started: <span class="mono">${escapeHtml(when)}</span></div>`);
    elTestLockBanner.innerHTML = parts.join("");
  }

  const buttons = [
    elSavePreview,
    elSaveItem,
    elNewQuestion,
    elClearItem,
    elAddOption,
    elRemoveOption,
    elSaveReadingText,
    elClearReadingText,
    elSaveDrag,
    elResetDrag,
    elSaveWriting,
    elResetWriting,
    elListeningNewQuestion,
    elListeningNewText,
    elListeningModalClose,
    elListeningModalSave,
    elListeningModalCancel,
    elListeningModalAddOption,
    elListeningModalRemoveOption,
    elListeningModalBold,
    elSaveWeights,
  ];
  for (const b of buttons) {
    try { if (b) b.disabled = locked; } catch {}
  }

  const inputs = [
    elQText,
    elReadingText,
    elDragInstructions,
    elDragText,
    elDragExtras,
    elDragTitle,
    elWritingPrompt,
    elListeningModalQText,
    elListeningModalInfoText,
    elWeightListening,
    elWeightReading,
    elWeightWriting,
    elWeightSpeaking,
  ];
  for (const el of inputs) {
    try {
      if (!el) continue;
      if (el instanceof HTMLInputElement) el.disabled = locked;
      if (el instanceof HTMLTextAreaElement) el.readOnly = locked;
    } catch {}
  }

  try {
    const optInputs = Array.from(elOptionsBox?.querySelectorAll("input.optionText, input.optionCorrect") || []);
    for (const el of optInputs) {
      if (el instanceof HTMLInputElement) el.disabled = locked;
    }
  } catch {}

  try {
    const lockableListButtons = Array.from(elQuestionsList?.querySelectorAll("button[data-action]") || []);
    for (const b of lockableListButtons) {
      if (b instanceof HTMLButtonElement) b.disabled = locked;
    }
  } catch {}

  if (locked) {
    const openAt = _builderLockMeta?.openAtUtc;
    const when = fmtLocal(openAt);
    setOut(when ? `Locked (test started: ${when}).` : "Locked (test started).", false);
  }

  try {
    for (const el of [elWeightListening, elWeightReading, elWeightWriting, elWeightSpeaking]) {
      if (el instanceof HTMLInputElement) el.disabled = locked;
    }
  } catch {}
}

function setEditorMode(mode) {
  const m = String(mode || "").trim() === "info" ? "info" : "mcq";
  _editorMode = m;

  const isListening = _qTab === "listening";
  const isInfo = isListening && m === "info"; // kept for compatibility with older state
  const isReading = _qTab === "reading";

  // Listening uses a modal editor; keep the inline editor for Reading only.
  try { if (elListeningToolbar) elListeningToolbar.style.display = isListening ? "" : "none"; } catch {}
  try { if (elReadingToolbar) elReadingToolbar.style.display = isReading ? "" : "none"; } catch {}
  try {
    // Hide inline editors for Listening/Reading (modal-only).
    if (elReadingTextEditor) elReadingTextEditor.style.display = "none";
    if (elMcqEditor) elMcqEditor.style.display = "none";
  } catch {}

  try {
    // Options are irrelevant in info mode.
    if (elAddOption) elAddOption.style.display = isInfo ? "none" : "";
    if (elRemoveOption) elRemoveOption.style.display = isInfo ? "none" : "";
  } catch {}

  try {
    if (elSaveItem) elSaveItem.style.display = isInfo ? "none" : "";
    if (elNewQuestion) elNewQuestion.style.display = isInfo ? "none" : "";
    if (elClearItem) elClearItem.style.display = isInfo ? "none" : "";
  } catch {}
}

function normalizeText(s, maxLen) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.slice(0, maxLen);
}

function ensureSection(payload, id, fallbackTitle) {
  const p = payload && typeof payload === "object" ? payload : { version: 1, randomize: false, sections: [] };
  if (!Array.isArray(p.sections)) p.sections = [];
  let sec = p.sections.find((s) => String(s?.id || "") === id);
  if (!sec) {
    sec = { id, title: fallbackTitle || id, description: "", rules: null, items: [] };
    p.sections.push(sec);
  }
  if (!Array.isArray(sec.items)) sec.items = [];
  if (typeof sec.title !== "string" || !sec.title.trim()) sec.title = fallbackTitle || id;
  return sec;
}

function getSelectedExamPeriodId() {
  const v = Number(elExamPeriod?.value || 0);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function optionLabel(i) {
  const n = Number(i);
  if (!Number.isFinite(n) || n < 0) return "?";
  return String.fromCharCode(65 + (n % 26));
}

function scrollToEl(target) {
  try {
    (target || document.body).scrollIntoView({ behavior: "smooth", block: "start" });
  } catch {
    try { window.scrollTo(0, 0); } catch {}
  }
}

function setQuestionsTab(id) {
  const want = String(id || "").trim() || "listening";
  _qTab = want;
  try { localStorage.setItem("admin_tests_qtab", want); } catch {}
  for (const b of elQTabs) {
    b.setAttribute("aria-selected", b.dataset.qtab === want ? "true" : "false");
  }
  for (const p of elQPanels) {
    const on = p.dataset.qpanel === want;
    if (on) p.removeAttribute("hidden");
    else p.setAttribute("hidden", "");
  }
  applyEditorsForTab(want);
  // Avoid editing the wrong section when switching tabs.
  if (want === "listening") {
    clearMcqForm();
  } else if (want === "reading") {
    clearReadingTextForm();
    clearMcqForm();
  }
}

function readQuestionsTab() {
  try {
    const v = String(localStorage.getItem("admin_tests_qtab") || "").trim();
    return v === "reading" || v === "writing" || v === "listening" ? v : "listening";
  } catch {
    return "listening";
  }
}

function tabForKind(kind) {
  const k = String(kind || "").trim();
  if (k === "listening") return "listening";
  if (k === "reading" || k === "readingText") return "reading";
  if (k === "drag" || k === "writing") return "writing";
  return "listening";
}

function applyEditorsForTab(tab) {
  const t = String(tab || "listening");
  const showListening = t === "listening";
  const showReading = t === "reading";
  const showWriting = t === "writing";

  if (elReadingTextEditor) elReadingTextEditor.style.display = "none";
  if (elMcqEditor) elMcqEditor.style.display = "none";
  if (elDragEditor) elDragEditor.style.display = showWriting ? "" : "none";
  if (elWritingEditor) elWritingEditor.style.display = showWriting ? "" : "none";

  if (showWriting && _payload) renderWritingEditorsFromPayload();
  setEditorMode(_editorMode);
}

function renderOptions(choices = [], correctIndex = 0) {
  const arr = Array.isArray(choices) ? choices : [];
  const n = Math.max(2, Math.min(12, arr.length || 4));
  const corr = Number.isFinite(Number(correctIndex)) ? Number(correctIndex) : 0;
  const groupName = "correctOpt";

  const rows = [];
  for (let i = 0; i < n; i++) {
    const checked = i === corr;
    const val = String(arr[i] || "");
    const rid = `correctOpt_${i}`;
    rows.push(`
      <div class="optionRow" data-opt-idx="${i}" data-correct="${checked ? "1" : "0"}" style="margin-top:${i === 0 ? 0 : 8}px;">
        <div class="input-group input-group-sm" style="flex:1 1 auto;">
          <span class="input-group-text mono">${escapeHtml(optionLabel(i))}</span>
          <input class="form-control optionText" type="text" placeholder="Option ${escapeHtml(optionLabel(i))}" value="${escapeHtml(val)}"/>
        </div>
        <div class="form-check m-0" style="flex:0 0 auto;">
          <input class="form-check-input optionCorrect" id="${escapeHtml(rid)}" type="radio" name="${escapeHtml(groupName)}" ${checked ? "checked" : ""}/>
          <label class="form-check-label small muted" for="${escapeHtml(rid)}" style="user-select:none; cursor:pointer;">Correct</label>
          <span class="correctPill" aria-hidden="true">Selected</span>
        </div>
      </div>
    `);
  }
  elOptionsBox.innerHTML = rows.join("");
}

function setMcqLockMode(mode) {
  _mcqLockMode = String(mode || "").trim();
  const locked = _mcqLockMode === "tf";
  try {
    if (elAddOption) elAddOption.disabled = locked;
    if (elRemoveOption) elRemoveOption.disabled = locked;
  } catch {}
  try {
    const optInputs = Array.from(elOptionsBox?.querySelectorAll("input.optionText") || []);
    for (const inp of optInputs) {
      inp.readOnly = locked;
      inp.classList.toggle("mono", locked);
    }
  } catch {}
}

function readMcqForm() {
  const prompt = normalizeText(elQText?.value, 800);
  const optRows = Array.from(elOptionsBox?.querySelectorAll(".optionRow") || []);
  const optionTexts = optRows.map((row) => normalizeText(row.querySelector("input.optionText")?.value, 240));
  let correctIdx = optRows.findIndex((row) => row.querySelector("input.optionCorrect")?.checked);
  if (correctIdx < 0) correctIdx = optRows.findIndex((row) => String(row.getAttribute("data-correct") || "") === "1");
  const nonEmpty = optionTexts.filter((c) => c.trim()).length;
  return { prompt, choices: optionTexts, correctIdx, nonEmpty };
}

function clearMcqForm() {
  _editingMcq = { sectionId: _qTab === "listening" ? "listening" : "reading", itemId: null };
  if (elQText) elQText.value = "";
  renderOptions(["", "", "", ""], 0);
  setMcqLockMode("");
  if (_qTab === "listening") setEditorMode("mcq");
}

function nextId(prefix, items) {
  const used = new Set((items || []).map((it) => String(it?.id || "")));
  for (let i = 1; i < 10000; i++) {
    const id = `${prefix}${i}`;
    if (!used.has(id)) return id;
  }
  return `${prefix}${Date.now()}`;
}

function sectionForKind(kind) {
  const k = String(kind || "").trim();
  if (k === "reading") return { id: "reading", type: "mcq", prefix: "r" };
  if (k === "readingText") return { id: "reading", type: "info", prefix: "rt" };
  return { id: "reading", type: "mcq", prefix: "r" };
}

function getSectionItems(sectionId) {
  const sec = ensureSection(_payload, sectionId, sectionId);
  return sec.items;
}

function upsertMcqFromForm() {
  const sectionId = "reading";
  const type = "mcq";
  const prefix = "r";
  const sec = ensureSection(_payload, sectionId, "Part 2: Reading");

  const { prompt, choices, correctIdx, nonEmpty } = readMcqForm();
  if (!prompt) return { ok: false, error: "Question prompt is required." };
  if (correctIdx < 0) return { ok: false, error: "Pick the correct option." };

  const itemId = _editingMcq.itemId || nextId(prefix, sec.items);
  const existing = sec.items.find((it) => String(it?.id || "") === String(itemId)) || null;
  const isTf = String(existing?.type || "") === "tf" || _mcqLockMode === "tf";

  if (isTf) {
    // Save as a True/False item, but edit it using the same MCQ editor.
    const idx = Number(correctIdx);
    if (!(idx === 0 || idx === 1)) return { ok: false, error: "True/False questions must have exactly 2 options." };
    const item = {
      id: itemId,
      type: "tf",
      prompt,
      correct: idx === 0,
      points: Number(existing?.points ?? 1) || 1,
    };
    const exIdx = sec.items.findIndex((it) => String(it?.id || "") === String(itemId));
    if (exIdx >= 0) sec.items[exIdx] = item;
    else sec.items.push(item);
    _editingMcq = { sectionId, itemId };
    renderQuestionsList();
    return { ok: true };
  }

  if (nonEmpty < 2) return { ok: false, error: "Add at least 2 options." };
  if (!choices[correctIdx] || !String(choices[correctIdx]).trim()) return { ok: false, error: "Correct option cannot be empty." };

  const item = {
    id: itemId,
    type,
    prompt,
    choices: choices.map((c) => c || ""),
    correctIndex: correctIdx,
    points: Number(existing?.points ?? 1) || 1,
  };

  const idx = sec.items.findIndex((it) => String(it?.id || "") === String(itemId));
  if (idx >= 0) sec.items[idx] = item;
  else sec.items.push(item);

  _editingMcq = { sectionId, itemId };
  renderQuestionsList();
  return { ok: true };
}

({
  showListeningModal,
  setListeningModalMode,
  renderListeningModalOptions,
  readListeningModalMcqForm,
  openListeningModal,
  saveListeningModal,
  wireListeningModalEvents,
} = createListeningModalHelpers({
  escapeHtml,
  optionLabel,
  postParentFullscreen,
  normalizeText,
  ensureSection,
  nextId,
  renderQuestionsList: () => renderQuestionsList(),
  saveTest,
  setOut,
  getPayload: () => _payload,
  getBuilderLocked: () => _builderLocked,
  getListeningModalState: () => _listeningModalState,
  setListeningModalState: (value) => { _listeningModalState = value; },
  getLastItemIdBySection: () => _lastItemIdBySection,
  setLastItemIdForSection: (sectionId, itemId) => { _lastItemIdBySection[String(sectionId || "")] = itemId; },
  elListeningModalOverlay,
  elListeningModalWindow,
  elListeningModalTitle,
  elListeningModalClose,
  elListeningModalSave,
  elListeningModalCancel,
  elListeningModalMcq,
  elListeningModalInfo,
  elListeningModalQText,
  elListeningModalOptionsBox,
  elListeningModalAddOption,
  elListeningModalRemoveOption,
  elListeningModalInfoText,
  elListeningModalBold,
  elListeningNewQuestion,
  elListeningNewText,
  elReadingNewText,
  elReadingNewQuestion,
  setQuestionsTab,
  getQuestionsTab: () => _qTab,
}));

({
  buildDragPreview,
  ensureWritingDefaults,
  renderWritingEditorsFromPayload,
  renderDragPreview,
  saveDragFromEditor,
  saveWritingPromptFromEditor,
  wireWritingEditorEvents,
} = createWritingEditorHelpers({
  escapeHtml,
  ensureSection,
  cloneJson,
  renderQuestionsList: () => renderQuestionsList(),
  saveTest,
  setOut,
  getPayload: () => _payload,
  setPayload: (next) => { _payload = next; },
  getPayloadInitial: () => _payloadInitial,
  elDragInstructions,
  elDragText,
  elDragExtras,
  elDragPreview,
  elSaveDrag,
  elResetDrag,
  elDragTitle,
  elWritingPrompt,
  elSaveWriting,
  elResetWriting,
}));

({
  deleteItem,
  moveItem,
  moveItemTo,
  loadItemIntoEditor,
  renderQuestionsList,
  wireQuestionListEvents,
} = createQuestionsListHelpers({
  escapeHtml,
  optionLabel,
  ensureSection,
  ensureWritingDefaults,
  buildDragPreview,
  renderOptions,
  setMcqLockMode,
  setQuestionsTab,
  applyEditorsForTab,
  openListeningModal,
  showListeningModal,
  scrollToEl,
  clearReadingTextForm,
  clearMcqForm,
  setOut,
  saveTest,
  getPayload: () => _payload,
  getBuilderLocked: () => _builderLocked,
  getEditingReadingTextId: () => _editingReadingTextId,
  setEditingReadingTextId: (value) => { _editingReadingTextId = value; },
  getEditingMcq: () => _editingMcq,
  setEditingMcq: (value) => { _editingMcq = value; },
  getListeningModalState: () => _listeningModalState,
  getLastItemIdBySection: () => _lastItemIdBySection,
  setLastItemIdForSection: (sectionId, itemId) => { _lastItemIdBySection[String(sectionId || "")] = itemId; },
  getDndState: () => _dndState,
  setDndState: (value) => { _dndState = value; },
  elReadingText,
  elQText,
  elMcqEditor,
  elReadingTextEditor,
  elDragEditor,
  elWritingEditor,
  elQuestionsList,
  elQuestionsListening,
  elQuestionsReading,
  elQuestionsWriting,
}));

function clearReadingTextForm() {
  _editingReadingTextId = null;
  if (elReadingText) elReadingText.value = "";
}

function upsertReadingTextFromForm() {
  const { id: sectionId, prefix } = sectionForKind("readingText");
  const sec = ensureSection(_payload, sectionId, "Part 2: Reading");
  const prompt = String(elReadingText?.value || "").trim();
  if (!prompt) return { ok: false, error: "Reading text is required." };

  const itemId = _editingReadingTextId || nextId(prefix, sec.items);
  const item = { id: String(itemId), type: "info", prompt, points: 0 };

  const idx = sec.items.findIndex((it) => String(it?.id || "") === String(itemId));
  if (idx >= 0) sec.items[idx] = item;
  else sec.items.push(item);

  _editingReadingTextId = String(itemId);
  renderQuestionsList();
  return { ok: true };
}

function switchEditor() {
  // Backwards-compatible no-op: older code paths used to call this.
  applyEditorsForTab(_qTab || "listening");
}

async function loadExamPeriods() {
  const periods = await apiGet("/api/admin/exam-periods");
  const rows = Array.isArray(periods) ? periods : [];
  if (!rows.length) {
    elExamPeriod.innerHTML = `<option value="">No exam periods</option>`;
    elExamPeriod.value = "";
    return;
  }
  elExamPeriod.innerHTML = rows
    .map((p) => `<option value="${escapeHtml(String(p.id))}">${escapeHtml(String(p.name || `Exam period ${p.id}`))}</option>`)
    .join("");
  elExamPeriod.value = String(rows[0].id);
}

async function loadTest() {
  const ep = getSelectedExamPeriodId();
  const qs = ep ? `?examPeriodId=${encodeURIComponent(String(ep))}` : "";
  const r = await apiGet(`/api/admin/tests${qs}`);
  setBuilderLocked(!!r?.locked, { openAtUtc: r?.openAtUtc, serverNow: r?.serverNow, durationMinutes: r?.durationMinutes });
  _payload = r?.test || r?.payload || r || null;
  if (!_payload || typeof _payload !== "object") _payload = { version: 1, randomize: false, sections: [] };
  ensureGradeWeights(_payload);
  ensureSection(_payload, "listening", "Part 1: Listening");
  ensureSection(_payload, "reading", "Part 2: Reading");
  ensureSection(_payload, "writing", "Part 3: Writing");
  ensureWritingDefaults();
  _payloadInitial = cloneJson(_payload);
  renderGradeWeights();
  renderWritingEditorsFromPayload();
  renderQuestionsList();
  applyEditorsForTab(_qTab || "listening");
  applyBuilderLocked();
  if (!_builderLocked) setOut("Loaded.", true);
}

function persistSelectedExamPeriod(id) {
  try {
    const v = Number(id || 0);
    if (!Number.isFinite(v) || v <= 0) return;
    localStorage.setItem("admin_tests_examPeriodId", String(v));
  } catch {}
}

function readPersistedExamPeriodId() {
  try {
    const v = Number(localStorage.getItem("admin_tests_examPeriodId") || "0");
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

async function bootstrap() {
  const preferred = readPersistedExamPeriodId();
  const qsBoot = preferred ? `?examPeriodId=${encodeURIComponent(String(preferred))}` : "";
  const r = await apiGet(`/api/admin/tests-bootstrap${qsBoot}`);

  const rows = Array.isArray(r?.examPeriods) ? r.examPeriods : [];
  const epId = Number(r?.examPeriodId || 0);
  const test = r?.test || null;
  setBuilderLocked(!!r?.locked, { openAtUtc: r?.openAtUtc, serverNow: r?.serverNow, durationMinutes: r?.durationMinutes });

  if (!rows.length) {
    elExamPeriod.innerHTML = `<option value="">No exam periods</option>`;
  } else {
    elExamPeriod.innerHTML = rows
      .map((p) => `<option value="${escapeHtml(String(p.id))}">${escapeHtml(String(p.name || `Exam period ${p.id}`))}</option>`)
      .join("");
  }

  if (rows.length) {
    const want = preferred && rows.some((p) => Number(p?.id || 0) === preferred)
      ? preferred
      : (Number(rows[0].id) || epId || 1);
    elExamPeriod.value = String(want);
    persistSelectedExamPeriod(want);
  } else {
    elExamPeriod.value = "";
  }

  _payload = test && typeof test === "object" ? test : { version: 1, randomize: false, sections: [] };
  ensureGradeWeights(_payload);
  ensureSection(_payload, "listening", "Part 1: Listening");
  ensureSection(_payload, "reading", "Part 2: Reading");
  ensureSection(_payload, "writing", "Part 3: Writing");
  ensureWritingDefaults();
  _payloadInitial = cloneJson(_payload);
  renderGradeWeights();
  renderWritingEditorsFromPayload();
  renderQuestionsList();
  applyEditorsForTab(_qTab || "listening");
  applyBuilderLocked();
  if (!_builderLocked) setOut("Loaded.", true);
}

async function saveTest() {
  if (_builderLocked) throw new Error("Locked: test has started.");
  const ep = getSelectedExamPeriodId();
  if (!ep) throw new Error("Select an exam period first.");
  applyGradeWeightsFromInputs();
  ensureWritingDefaults();
  const qs = `?examPeriodId=${encodeURIComponent(String(ep))}`;
  await apiPost(`/api/admin/tests${qs}`, { test: _payload });
  _payloadInitial = cloneJson(_payload);
  setOut("Saved.", true);
}

function wireEvents() {
  // Right-side section tabs
  _qTab = readQuestionsTab();
  setQuestionsTab(_qTab);
  for (const b of elQTabs) {
    b.addEventListener("click", () => setQuestionsTab(String(b.dataset.qtab || "listening")));
  }

  elSavePreview?.addEventListener("click", async () => {
    try {
      const ep = getSelectedExamPeriodId();
      if (!ep) throw new Error("Select an exam period first.");
      await saveTest();
      const w = window.open(
        `/admin/test-preview.html?examPeriodId=${encodeURIComponent(String(ep))}`,
        "_blank",
        "noopener,noreferrer"
      );
      if (!w) setOut("Popup blocked. Allow popups for this site.", false);
      else setOut("Saved. Opening preview...", true);
    } catch (e) {
      setOut(e?.message || "Save failed.", false);
    }
  });

  wireWritingEditorEvents();

  for (const el of [elWeightListening, elWeightReading, elWeightWriting, elWeightSpeaking]) {
    el?.addEventListener("input", () => updateGradeWeightTotal());
  }

  elSaveWeights?.addEventListener("click", async () => {
    try {
      applyGradeWeightsFromInputs();
      await saveTest();
      setOut("Weights saved.", true);
    } catch (e) {
      setOut(e?.message || "Save failed.", false);
    }
  });

  elExamPeriod?.addEventListener("change", async () => {
    try {
      const ep = getSelectedExamPeriodId();
      persistSelectedExamPeriod(ep);
      await loadTest();
    } catch (e) {
      setOut(e?.message || "Load failed.", false);
    }
  });

  elAddOption?.addEventListener("click", () => {
    const optRows = Array.from(elOptionsBox?.querySelectorAll(".optionRow") || []);
    if (optRows.length >= 12) return setOut("Max 12 options.", false);
    const choices = optRows.map((r) => r.querySelector("input.optionText")?.value || "");
    const correctIdx = optRows.findIndex((r) => r.querySelector("input.optionCorrect")?.checked);
    choices.push("");
    renderOptions(choices, correctIdx < 0 ? 0 : correctIdx);
  });

  elRemoveOption?.addEventListener("click", () => {
    const optRows = Array.from(elOptionsBox?.querySelectorAll(".optionRow") || []);
    if (optRows.length <= 2) return setOut("Min 2 options.", false);
    const choices = optRows.map((r) => r.querySelector("input.optionText")?.value || "");
    let correctIdx = optRows.findIndex((r) => r.querySelector("input.optionCorrect")?.checked);
    choices.pop();
    if (correctIdx >= choices.length) correctIdx = Math.max(0, choices.length - 1);
    renderOptions(choices, correctIdx < 0 ? 0 : correctIdx);
  });

  elOptionsBox?.addEventListener("change", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const radio = target.closest("input.optionCorrect");
    if (!radio) return;

    const rows = Array.from(elOptionsBox.querySelectorAll(".optionRow"));
    for (const row of rows) row.setAttribute("data-correct", "0");
    const parent = radio.closest(".optionRow");
    if (parent) parent.setAttribute("data-correct", "1");
  });

  elOptionsBox?.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest("input.optionText")) return;

    const row = target.closest(".optionRow");
    if (!row || !elOptionsBox.contains(row)) return;
    const radio = row.querySelector("input.optionCorrect");
    if (!(radio instanceof HTMLInputElement)) return;
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
  });

  elSaveReadingText?.addEventListener("click", async () => {
    try {
      const r = upsertReadingTextFromForm();
      if (!r.ok) return setOut(r.error, false);
      await saveTest();
      setOut("Saved.", true);
    } catch (e) {
      setOut(e?.message || "Save failed.", false);
    }
  });

  elClearReadingText?.addEventListener("click", () => {
    clearReadingTextForm();
    setOut("Cleared.", true);
  });

  elSaveItem?.addEventListener("click", async () => {
    try {
      const r = upsertMcqFromForm();
      if (!r.ok) return setOut(r.error, false);
      await saveTest();
      setOut("Saved.", true);
    } catch (e) {
      setOut(e?.message || "Save failed.", false);
    }
  });

  elClearItem?.addEventListener("click", () => {
    clearMcqForm();
    setOut("Cleared.", true);
  });

  elNewQuestion?.addEventListener("click", () => {
    clearMcqForm();
    try { elQText?.focus(); } catch {}
    setOut("New question.", true);
  });

  wireListeningModalEvents();
  wireQuestionListEvents();
}

async function main() {
  try {
    await bootstrap();
  } catch (e) {
    const msg = String(e?.message || String(e));
    elQuestionsList.innerHTML = `<div class="bad">Failed to load: ${escapeHtml(msg)}</div>`;
  }
  wireEvents();
  applyBuilderLocked();
}

main();
