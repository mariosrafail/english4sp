import { apiGet, apiPost, qs, escapeHtml, busyStart } from "/app.js";

const elExamPeriod = qs("#examPeriod");

const elMcqEditor = qs("#mcqEditor");
const elReadingTextEditor = qs("#readingTextEditor");
const elDragEditor = qs("#dragEditor");
const elWritingEditor = qs("#writingEditor");

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

const elListeningAudioBox = qs("#listeningAudioBox");
const elListeningAudioFile = qs("#listeningAudioFile");
const elUploadListeningAudio = qs("#btnUploadListeningAudio");
const elListeningAudioStatus = qs("#listeningAudioStatus");

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
let _mcqLockMode = ""; // "", "tf"
let _builderLocked = false;
let _builderLockMeta = null;

function setOut(msg, ok = true) {
  if (!elOut) return;
  elOut.innerHTML = ok ? `<span class="ok">${escapeHtml(msg)}</span>` : `<span class="bad">${escapeHtml(msg)}</span>`;
}

function cloneJson(x) {
  return JSON.parse(JSON.stringify(x || {}));
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
    elUploadListeningAudio,
    elSaveDrag,
    elResetDrag,
    elSaveWriting,
    elResetWriting,
  ];
  for (const b of buttons) {
    try { if (b) b.disabled = locked; } catch {}
  }

  const inputs = [
    elQText,
    elReadingText,
    elListeningAudioFile,
    elDragInstructions,
    elDragText,
    elDragExtras,
    elDragTitle,
    elWritingPrompt,
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

  if (elReadingTextEditor) elReadingTextEditor.style.display = showReading ? "" : "none";
  if (elMcqEditor) elMcqEditor.style.display = (showListening || showReading) ? "" : "none";
  if (elDragEditor) elDragEditor.style.display = showWriting ? "" : "none";
  if (elWritingEditor) elWritingEditor.style.display = showWriting ? "" : "none";
  if (elListeningAudioBox) elListeningAudioBox.style.display = showListening ? "" : "none";

  if (showListening) renderListeningAudioStatus();
  if (showWriting && _payload) renderWritingEditorsFromPayload();
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
  if (k === "listening") return { id: "listening", type: "listening-mcq", prefix: "l" };
  if (k === "reading") return { id: "reading", type: "mcq", prefix: "r" };
  if (k === "readingText") return { id: "reading", type: "info", prefix: "rt" };
  return { id: "reading", type: "mcq", prefix: "r" };
}

function getFirstListeningAudioUrl(payload) {
  const p = payload && typeof payload === "object" ? payload : null;
  const sec = p ? ensureSection(p, "listening", "Part 1: Listening") : null;
  const item = sec ? (sec.items || []).find((it) => it && it.type === "listening-mcq" && String(it.audioUrl || "").trim()) : null;
  return item ? String(item.audioUrl || "").trim() : "";
}

function setListeningAudioUrl(url) {
  if (!_payload) return;
  const v = String(url || "").trim();
  const sec = ensureSection(_payload, "listening", "Part 1: Listening");
  const first = (sec.items || []).find((it) => it && it.type === "listening-mcq") || null;
  if (first) {
    first.audioUrl = v;
  } else {
    sec.items = sec.items || [];
    sec.items.unshift({
      id: "l1",
      type: "listening-mcq",
      audioUrl: v,
      prompt: "1. (Add your first listening question)",
      choices: ["Option A", "Option B"],
      correctIndex: 0,
      points: 1,
    });
  }
}

function renderListeningAudioStatus() {
  if (!elListeningAudioStatus || !_payload) return;
  const url = getFirstListeningAudioUrl(_payload);
  if (!url) {
    elListeningAudioStatus.innerHTML = `<span class="muted">No audio uploaded yet.</span>`;
    return;
  }
  elListeningAudioStatus.innerHTML =
    `Current audio: ` +
    `<a class="mono" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" ` +
    `style="word-break:break-all; overflow-wrap:anywhere; display:inline-block; max-width:100%;">` +
    `${escapeHtml(url)}` +
    `</a>`;
}

function getSectionItems(sectionId) {
  const sec = ensureSection(_payload, sectionId, sectionId);
  return sec.items;
}

function upsertMcqFromForm() {
  const defaultSectionId = _qTab === "listening" ? "listening" : "reading";
  const sectionId = _editingMcq?.itemId ? String(_editingMcq.sectionId || defaultSectionId) : defaultSectionId;
  const type = sectionId === "listening" ? "listening-mcq" : "mcq";
  const prefix = sectionId === "listening" ? "l" : "r";
  const sec = ensureSection(_payload, sectionId, sectionId === "listening" ? "Part 1: Listening" : "Part 2: Reading");

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
  if (type === "listening-mcq" && existing?.audioUrl) item.audioUrl = String(existing.audioUrl);

  const idx = sec.items.findIndex((it) => String(it?.id || "") === String(itemId));
  if (idx >= 0) sec.items[idx] = item;
  else sec.items.push(item);

  _editingMcq = { sectionId, itemId };
  renderQuestionsList();
  return { ok: true };
}

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

function deleteItem(sectionId, itemId) {
  const sec = ensureSection(_payload, sectionId, sectionId);
  sec.items = (sec.items || []).filter((it) => String(it?.id || "") !== String(itemId));
  if (String(sectionId) === "reading" && String(_editingReadingTextId || "") === String(itemId)) clearReadingTextForm();
  if (String(_editingMcq.sectionId) === String(sectionId) && String(_editingMcq.itemId || "") === String(itemId)) clearMcqForm();
  renderQuestionsList();
}

function moveItem(sectionId, itemId, dir) {
  const sec = ensureSection(_payload, sectionId, sectionId);
  const items = Array.isArray(sec.items) ? sec.items : [];
  const idx = items.findIndex((it) => String(it?.id || "") === String(itemId));
  if (idx < 0) return;
  const j = idx + (dir === "up" ? -1 : 1);
  if (j < 0 || j >= items.length) return;
  const next = items.slice();
  const tmp = next[idx];
  next[idx] = next[j];
  next[j] = tmp;
  sec.items = next;
  renderQuestionsList();
}

function loadItemIntoEditor(sectionId, itemId) {
  const sec = ensureSection(_payload, sectionId, sectionId);
  const it = (sec.items || []).find((x) => String(x?.id || "") === String(itemId));
  if (!it) return;

  if (sectionId === "listening") setQuestionsTab("listening");
  else if (sectionId === "reading") setQuestionsTab("reading");
  else if (sectionId === "writing") setQuestionsTab("writing");

  if (it.type === "info") {
    if (elReadingText) elReadingText.value = String(it.prompt || "");
    _editingReadingTextId = String(it.id || itemId);
    scrollToEl(elReadingTextEditor);
    return;
  }
  _editingMcq = { sectionId, itemId: String(it.id) };
  if (elQText) elQText.value = String(it.prompt || "");
  if (it.type === "tf") {
    renderOptions(["True", "False"], it.correct ? 0 : 1);
    setMcqLockMode("tf");
  } else {
    renderOptions(Array.isArray(it.choices) ? it.choices : [], Number(it.correctIndex || 0));
    setMcqLockMode("");
  }
  scrollToEl(elMcqEditor);
}

function uniqPreserve(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const v = String(x || "").trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function extractMarkedWords(text, marker) {
  const t = String(text || "");
  const m = String(marker || "");
  if (!t || !m) return [];
  const escaped = m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`${escaped}([^*]+?)${escaped}`, "g");
  const out = [];
  let match;
  while ((match = rx.exec(t))) {
    const w = String(match[1] || "").trim();
    if (w) out.push(w);
  }
  return out;
}

function buildDragPreview({ instructions, text, extraWords }) {
  const gapWords = extractMarkedWords(text, "**");
  const extras = extractMarkedWords(extraWords, "*");
  const bank = uniqPreserve([...gapWords, ...extras]).slice(0, 40);

  const previewText = (() => {
    let idx = 0;
    return String(text || "").replace(/\*\*([^*]+?)\*\*/g, () => {
      idx += 1;
      return `(${idx})`;
    });
  })();

  return {
    gapWords,
    extras,
    bank,
    previewText,
    instructions: String(instructions || "").trim(),
    text: String(text || "").trim(),
    extraWords: String(extraWords || "").trim(),
  };
}

function getLegacyWritingDraft(writing) {
  const w1 = (writing.items || []).find((it) => String(it?.id || "") === "w1");
  const w2 = (writing.items || []).find((it) => String(it?.id || "") === "w2");
  const w3 = (writing.items || []).find((it) => String(it?.id || "") === "w3");
  const w4 = (writing.items || []).find((it) => String(it?.id || "") === "w4");
  const gaps = [w1, w2, w3, w4].filter(Boolean);
  if (gaps.length !== 4) return null;

  const bank = Array.isArray(w1?.choices) ? w1.choices.map((x) => String(x || "").trim()).filter(Boolean) : [];
  const idxs = [
    Number(w1?.correctIndex ?? 0),
    Number(w2?.correctIndex ?? 0),
    Number(w3?.correctIndex ?? 0),
    Number(w4?.correctIndex ?? 0),
  ];
  const words = idxs.map((i) => (Number.isFinite(i) && i >= 0 && i < bank.length ? String(bank[i]) : "")).filter(Boolean);
  if (words.length !== 4) return null;

  const usedLower = new Set(words.map((w) => w.toLowerCase()));
  const extras = bank.filter((w) => !usedLower.has(String(w || "").toLowerCase()));
  const extrasFmt = extras.map((w) => `*${w}*`).join(" ");

  const text =
    `Rain makes the **${words[0]}** shine. The air smells clean and **${words[1]}**. ` +
    `I put on my **${words[2]}** and boots. I feel calm and happy. ` +
    `I like rain because it helps **${words[3]}** grow and makes trees look fresh.`;

  return { instructions: "", text, extraWords: extrasFmt };
}

function ensureWritingDefaults() {
  const writing = ensureSection(_payload, "writing", "Part 3: Writing");

  const hasWriting = (writing.items || []).some((it) => String(it?.id || "") === "q4" && String(it?.type || "") === "writing");
  if (!hasWriting) {
    writing.items.push({
      id: "q4",
      type: "writing",
      prompt:
        "Task 2: Write a 50-word email to a guest confirming their reservation. Include guest name, check-in date, number of nights, and a special diet request.",
      points: 0,
    });
  }

  const hasDrag = (writing.items || []).some((it) => String(it?.type || "") === "drag-words" && String(it?.id || "") === "drag1");
  if (!hasDrag) {
    const draft = getLegacyWritingDraft(writing);
    if (draft) {
      writing.items.unshift({
        id: "drag1",
        type: "drag-words",
        title: "Task 1: Drag the correct words into the gaps.",
        instructions: draft.instructions,
        text: draft.text,
        extraWords: draft.extraWords,
        bankWords: buildDragPreview(draft).bank,
        pointsPerGap: 1,
      });
    } else {
      writing.items.unshift({
        id: "drag1",
        type: "drag-words",
        title: "Task 1: Drag the correct words into the gaps.",
        instructions: "",
        text: "",
        extraWords: "",
        bankWords: [],
        pointsPerGap: 1,
      });
    }
  }
}

function renderWritingEditorsFromPayload() {
  ensureWritingDefaults();
  const writing = ensureSection(_payload, "writing", "Part 3: Writing");

  const drag = (writing.items || []).find((it) => String(it?.type || "") === "drag-words" && String(it?.id || "") === "drag1");
  if (drag) {
    if (elDragTitle) elDragTitle.value = String(drag.title || "Task 1: Drag the correct words into the gaps.");
    if (elDragInstructions) elDragInstructions.value = String(drag.instructions || "");
    if (elDragText) elDragText.value = String(drag.text || "");
    if (elDragExtras) elDragExtras.value = String(drag.extraWords || "");
  }

  const wp = (writing.items || []).find((it) => String(it?.id || "") === "q4");
  if (elWritingPrompt) elWritingPrompt.value = String(wp?.prompt || "");

  renderDragPreview();
}

function renderDragPreview() {
  if (!elDragPreview) return;
  const p = buildDragPreview({
    instructions: elDragInstructions?.value || "",
    text: elDragText?.value || "",
    extraWords: elDragExtras?.value || "",
  });
  const gaps = p.gapWords.length;
  const bank = p.bank.length;

  const bankHtml = bank
    ? p.bank.map((w) => `<span class="badge mono" style="margin:4px 6px 0 0;">${escapeHtml(w)}</span>`).join("")
    : `<span class="muted small">No words detected yet.</span>`;

  elDragPreview.innerHTML = `
    <div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center;">
      <div class="small muted">Gaps: <span class="mono" style="color:var(--text)">${escapeHtml(String(gaps))}</span></div>
      <div class="small muted">Bank: <span class="mono" style="color:var(--text)">${escapeHtml(String(bank))}</span></div>
    </div>
    <div class="small muted" style="margin-top:10px; white-space:pre-wrap;">${escapeHtml(p.previewText || "")}</div>
    <div style="margin-top:10px;">${bankHtml}</div>
  `;
}

function saveDragFromEditor() {
  ensureWritingDefaults();
  const writing = ensureSection(_payload, "writing", "Part 3: Writing");

  const title = String(elDragTitle?.value || "").trim() || "Task 1: Drag the correct words into the gaps.";
  const instructions = String(elDragInstructions?.value || "").trim();
  const text = String(elDragText?.value || "").trim();
  const extraWords = String(elDragExtras?.value || "").trim();

  const p = buildDragPreview({ instructions, text, extraWords });
  if (!p.text) return { ok: false, error: "Text is required." };
  if (!p.gapWords.length) return { ok: false, error: "Add at least one **word** gap in the text." };
  if (!p.bank.length) return { ok: false, error: "No words detected for the word bank." };
  if (p.gapWords.length > 25) return { ok: false, error: "Too many gaps (max 25)." };

  const dragId = "drag1";
  const bank = p.bank.slice(0, 40);

  // Remove legacy gap items (w_intro/w1..w4) if they exist, since they would be graded but not shown.
  writing.items = (writing.items || []).filter((it) => {
    const id = String(it?.id || "");
    if (id === "w_intro" || id === "w1" || id === "w2" || id === "w3" || id === "w4") return false;
    if (String(it?.dragParentId || "") === dragId) return false;
    if (id.startsWith(`${dragId}_g`)) return false;
    return true;
  });

  // Upsert the drag-words config item.
  writing.items.unshift({
    id: dragId,
    type: "drag-words",
    title,
    instructions,
    text,
    extraWords,
    bankWords: bank.slice(),
    pointsPerGap: 1,
  });

  // Add derived gap items for grading (hidden in UI, used by the drag exercise).
  const pts = 1;
  const gapItems = p.gapWords.map((w, i) => {
    const correctIndex = bank.findIndex((x) => x.toLowerCase() === String(w || "").trim().toLowerCase());
    return {
      id: `${dragId}_g${i + 1}`,
      type: "mcq",
      prompt: `Gap ${i + 1}`,
      choices: bank.slice(),
      correctIndex: correctIndex >= 0 ? correctIndex : 0,
      points: pts,
      dragParentId: dragId,
    };
  });
  writing.items.push(...gapItems);

  renderQuestionsList();
  return { ok: true };
}

function saveWritingPromptFromEditor() {
  ensureWritingDefaults();
  const writing = ensureSection(_payload, "writing", "Part 3: Writing");
  const idx = (writing.items || []).findIndex((it) => String(it?.id || "") === "q4");
  if (idx < 0) return { ok: false, error: "Missing writing item." };
  const prompt = String(elWritingPrompt?.value || "").trim();
  if (!prompt) return { ok: false, error: "Writing prompt is required." };
  writing.items[idx] = { ...writing.items[idx], type: "writing", prompt };
  renderQuestionsList();
  return { ok: true };
}

function renderQuestionsList() {
  if (!_payload) return;
  ensureWritingDefaults();

  const listening = ensureSection(_payload, "listening", "Part 1: Listening");
  const reading = ensureSection(_payload, "reading", "Part 2: Reading");
  const writing = ensureSection(_payload, "writing", "Part 3: Writing");

  const renderSection = (sec, label) => {
    const items = (sec.items || []).filter((it) => it && (it.type === "mcq" || it.type === "listening-mcq" || it.type === "tf"));
    const body = items.length
      ? items.map((it, idx) => {
        const id = escapeHtml(String(it.id || ""));
        const prompt = escapeHtml(String(it.prompt || ""));
        const isTf = it.type === "tf";
        const choices = isTf ? ["True", "False"] : (Array.isArray(it.choices) ? it.choices : []);
        const corr = isTf ? (it.correct ? 0 : 1) : (Number.isFinite(Number(it.correctIndex)) ? Number(it.correctIndex) : -1);
        const preview = choices.slice(0, 6).map((c, i) => {
          const isC = i === corr;
          const cl = isC ? "ok" : "muted";
          return `<div class="${cl} small mono">${escapeHtml(optionLabel(i))}. ${escapeHtml(String(c || ""))}</div>`;
        }).join("");

        return `
          <div class="qCard" data-section="${escapeHtml(sec.id)}" data-qid="${id}" style="cursor:pointer;">
            <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
              <div style="min-width:0;">
                <div class="small muted">${escapeHtml(label)} · Question ${idx + 1}</div>
                <div class="qCardTitle">${prompt || "(empty)"}</div>
              </div>
              <div class="qActions">
                <button class="btn btn-outline-secondary btn-sm" data-action="edit" data-section="${escapeHtml(sec.id)}" data-qid="${id}" type="button">Edit</button>
                <button class="btn btn-outline-secondary btn-sm" data-action="up" data-section="${escapeHtml(sec.id)}" data-qid="${id}" type="button">Up</button>
                <button class="btn btn-outline-secondary btn-sm" data-action="down" data-section="${escapeHtml(sec.id)}" data-qid="${id}" type="button">Down</button>
                <button class="btn btn-outline-danger btn-sm" data-action="delete" data-section="${escapeHtml(sec.id)}" data-qid="${id}" type="button">Delete</button>
              </div>
            </div>
            <div class="qPreview">${preview}</div>
          </div>
        `;
      }).join("")
      : `<div class="muted">No questions.</div>`;

    return `<h3 style="margin:14px 0 8px 0;">${escapeHtml(label)}</h3>${body}`;
  };

  const renderReading = () => {
    const items = (reading.items || []).filter((it) => it && (it.type === "info" || it.type === "mcq" || it.type === "tf"));
    const body = items.length
      ? items.map((it, idx) => {
        const id = escapeHtml(String(it.id || ""));
        const isInfo = it.type === "info";
        if (isInfo) {
          const txt = String(it.prompt || "");
          const preview = escapeHtml(txt.length > 220 ? `${txt.slice(0, 220)}…` : txt);
          return `
            <div class="qCard" data-section="reading" data-qid="${id}" style="cursor:pointer;">
              <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
                <div style="min-width:0;">
                  <div class="small muted">Reading · Text block</div>
                  <div class="small muted" style="margin-top:6px; white-space:pre-wrap;">${preview || "(empty)"}</div>
                </div>
                <div class="qActions">
                  <button class="btn btn-outline-secondary btn-sm" data-action="edit" data-section="reading" data-qid="${id}" type="button">Edit</button>
                  <button class="btn btn-outline-secondary btn-sm" data-action="up" data-section="reading" data-qid="${id}" type="button">Up</button>
                  <button class="btn btn-outline-secondary btn-sm" data-action="down" data-section="reading" data-qid="${id}" type="button">Down</button>
                  <button class="btn btn-outline-danger btn-sm" data-action="delete" data-section="reading" data-qid="${id}" type="button">Delete</button>
                </div>
              </div>
            </div>
          `;
        }

        const prompt = escapeHtml(String(it.prompt || ""));
        const isTf = it.type === "tf";
        const choices = isTf ? ["True", "False"] : (Array.isArray(it.choices) ? it.choices : []);
        const corr = isTf ? (it.correct ? 0 : 1) : (Number.isFinite(Number(it.correctIndex)) ? Number(it.correctIndex) : -1);
        const preview = choices.slice(0, 6).map((c, i) => {
          const isC = i === corr;
          const cl = isC ? "ok" : "muted";
          return `<div class="${cl} small mono">${escapeHtml(optionLabel(i))}. ${escapeHtml(String(c || ""))}</div>`;
        }).join("");

        return `
          <div class="qCard" data-section="reading" data-qid="${id}" style="cursor:pointer;">
            <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
              <div style="min-width:0;">
                <div class="small muted">Reading · Question ${idx + 1}</div>
                <div class="qCardTitle">${prompt || "(empty)"}</div>
              </div>
              <div class="qActions">
                <button class="btn btn-outline-secondary btn-sm" data-action="edit" data-section="reading" data-qid="${id}" type="button">Edit</button>
                <button class="btn btn-outline-secondary btn-sm" data-action="up" data-section="reading" data-qid="${id}" type="button">Up</button>
                <button class="btn btn-outline-secondary btn-sm" data-action="down" data-section="reading" data-qid="${id}" type="button">Down</button>
                <button class="btn btn-outline-danger btn-sm" data-action="delete" data-section="reading" data-qid="${id}" type="button">Delete</button>
              </div>
            </div>
            <div class="qPreview">${preview}</div>
          </div>
        `;
      }).join("")
      : `<div class="muted">No reading items.</div>`;

    return `<h3 style="margin:14px 0 8px 0;">Reading</h3>${body}`;
  };

  const writingSummary = (() => {
    const wp = (writing.items || []).find((it) => String(it?.id || "") === "q4");
    const drag = (writing.items || []).find((it) => String(it?.type || "") === "drag-words" && String(it?.id || "") === "drag1");
    const dp = drag ? buildDragPreview({ text: drag.text || "", extraWords: drag.extraWords || "", instructions: drag.instructions || "" }) : null;
    const gaps = dp ? dp.gapWords.length : 0;
    const bank = drag && Array.isArray(drag.bankWords) ? drag.bankWords : (dp ? dp.bank : []);
    return `
      <h3 style="margin:14px 0 8px 0;">Writing</h3>
      <div class="qCard" data-section="writing" data-qid="drag1" style="cursor:pointer;">
        <div class="qCardTitle">${escapeHtml(String(drag?.title || "Task 1: Drag words"))}</div>
        <div class="small muted" style="margin-top:6px;">
          Gaps: <span class="mono">${escapeHtml(String(gaps))}</span> · Word bank: <span class="mono">${escapeHtml(String(Array.isArray(bank) ? bank.length : 0))}</span>
        </div>
        <div class="small muted" style="margin-top:6px; white-space:pre-wrap;">${escapeHtml(String(drag?.instructions || ""))}</div>
      </div>
      <div class="qCard" data-section="writing" data-qid="q4" style="margin-top:10px; cursor:pointer;">
        <div class="qCardTitle">Task 2: Writing prompt</div>
        <div class="small muted" style="margin-top:6px; white-space:pre-wrap;">${escapeHtml(String(wp?.prompt || ""))}</div>
      </div>
    `;
  })();

  if (elQuestionsListening) elQuestionsListening.innerHTML = renderSection(listening, "Listening");
  if (elQuestionsReading) elQuestionsReading.innerHTML = renderReading();
  if (elQuestionsWriting) elQuestionsWriting.innerHTML = writingSummary;
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
  ensureSection(_payload, "listening", "Part 1: Listening");
  ensureSection(_payload, "reading", "Part 2: Reading");
  ensureSection(_payload, "writing", "Part 3: Writing");
  ensureWritingDefaults();
  _payloadInitial = cloneJson(_payload);
  renderWritingEditorsFromPayload();
  renderListeningAudioStatus();
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
  ensureSection(_payload, "listening", "Part 1: Listening");
  ensureSection(_payload, "reading", "Part 2: Reading");
  ensureSection(_payload, "writing", "Part 3: Writing");
  ensureWritingDefaults();
  _payloadInitial = cloneJson(_payload);
  renderWritingEditorsFromPayload();
  renderListeningAudioStatus();
  renderQuestionsList();
  applyEditorsForTab(_qTab || "listening");
  applyBuilderLocked();
  if (!_builderLocked) setOut("Loaded.", true);
}

async function saveTest() {
  if (_builderLocked) throw new Error("Locked: test has started.");
  const ep = getSelectedExamPeriodId();
  if (!ep) throw new Error("Select an exam period first.");
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
        `/admin-test-preview.html?examPeriodId=${encodeURIComponent(String(ep))}`,
        "_blank",
        "noopener,noreferrer"
      );
      if (!w) setOut("Popup blocked. Allow popups for this site.", false);
      else setOut("Saved. Opening preview...", true);
    } catch (e) {
      setOut(e?.message || "Save failed.", false);
    }
  });

  const onDragInput = () => {
    try { renderDragPreview(); } catch {}
  };
  elDragInstructions?.addEventListener("input", onDragInput);
  elDragText?.addEventListener("input", onDragInput);
  elDragExtras?.addEventListener("input", onDragInput);

  elUploadListeningAudio?.addEventListener("click", async () => {
    try {
      if (_builderLocked) throw new Error("Locked: test has started.");
      const ep = getSelectedExamPeriodId();
      if (!ep) throw new Error("Select an exam period first.");
      const f = elListeningAudioFile?.files && elListeningAudioFile.files[0] ? elListeningAudioFile.files[0] : null;
      if (!f) throw new Error("Pick an MP3 file first.");
      const stop = busyStart("Uploading...");
      const j = await (async () => {
        async function uploadChunked(chunkBytes) {
          const init = await fetch(`/api/admin/listening-audio/chunk/init?examPeriodId=${encodeURIComponent(String(ep))}`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: f.name || "listening.mp3", size: Number(f.size || 0), chunkBytes }),
          });
          const ij = await init.json().catch(() => ({}));
          if (!init.ok) throw new Error(String(ij?.message || ij?.error || `Init failed (${init.status})`));
          const uploadId = String(ij?.uploadId || "").trim();
          const negotiated = Number(ij?.chunkBytes || chunkBytes);
          if (!uploadId) throw new Error("Chunk init failed (missing uploadId).");

          const totalBytes = Number(f.size || 0);
          const chunkSize = Math.max(64 * 1024, Number.isFinite(negotiated) ? negotiated : chunkBytes);
          const totalChunks = Math.max(1, Math.ceil(totalBytes / chunkSize));

          for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const end = Math.min(totalBytes, start + chunkSize);
            const blob = f.slice(start, end);
            const r = await fetch(`/api/admin/listening-audio/chunk/part?uploadId=${encodeURIComponent(uploadId)}&index=${encodeURIComponent(String(i))}`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/octet-stream" },
              body: blob,
            });
            if (r.status === 413) throw Object.assign(new Error("Chunk too large (413)"), { code: "chunk_413" });
            const pj = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(String(pj?.message || pj?.error || `Chunk failed (${r.status})`));
          }

          const fin = await fetch(`/api/admin/listening-audio/chunk/complete`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uploadId, totalChunks, totalBytes }),
          });
          const fj = await fin.json().catch(() => ({}));
          if (!fin.ok) throw new Error(String(fj?.message || fj?.error || `Complete failed (${fin.status})`));
          return fj;
        }

        const sizes = [900 * 1024, 512 * 1024, 256 * 1024, 128 * 1024];
        let lastErr = null;
        for (const sz of sizes) {
          try {
            return await uploadChunked(sz);
          } catch (e) {
            lastErr = e;
            if (String(e?.code || "") === "chunk_413") continue;
            throw e;
          }
        }
        throw lastErr || new Error("Upload failed.");
      })().finally(() => stop());
      const url = String(j?.url || "").trim();
      if (!url) throw new Error("Upload succeeded but no URL was returned.");

      setListeningAudioUrl(url);
      await saveTest();
      renderListeningAudioStatus();
      if (elListeningAudioFile) elListeningAudioFile.value = "";
      setOut(`Audio uploaded (${String(j?.provider || "ok")}).`, true);
    } catch (e) {
      setOut(e?.message || "Upload failed.", false);
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

  elSaveDrag?.addEventListener("click", async () => {
    try {
      const r = saveDragFromEditor();
      if (!r.ok) return setOut(r.error, false);
      await saveTest();
      setOut("Saved.", true);
    } catch (e) {
      setOut(e?.message || "Save failed.", false);
    }
  });

  elResetDrag?.addEventListener("click", () => {
    if (_payloadInitial) {
      _payload = cloneJson(_payloadInitial);
      renderWritingEditorsFromPayload();
      renderQuestionsList();
      setOut("Reset drag exercise.", true);
    }
  });

  elSaveWriting?.addEventListener("click", async () => {
    try {
      const r = saveWritingPromptFromEditor();
      if (!r.ok) return setOut(r.error, false);
      await saveTest();
      setOut("Saved.", true);
    } catch (e) {
      setOut(e?.message || "Save failed.", false);
    }
  });

  elResetWriting?.addEventListener("click", () => {
    if (_payloadInitial) {
      _payload = cloneJson(_payloadInitial);
      renderWritingEditorsFromPayload();
      renderQuestionsList();
      setOut("Reset writing prompt.", true);
    }
  });

  elQuestionsList?.addEventListener("click", async (e) => {
    if (_builderLocked) {
      const btn = e.target?.closest?.("button[data-action]");
      if (btn) {
        e.preventDefault();
        return setOut("Locked: test has started.", false);
      }
    }
    const btn = e.target?.closest?.("button[data-action]");
    if (btn) {
      e.preventDefault();
      const act = btn.dataset.action;
      const sectionId = btn.dataset.section;
      const qid = btn.dataset.qid;
      if (act === "edit") {
        loadItemIntoEditor(sectionId, qid);
        setOut("Loaded into editor.", true);
        return;
      }
      if (act === "delete") {
        deleteItem(sectionId, qid);
        try { await saveTest(); } catch (e2) { return setOut(e2?.message || "Save failed.", false); }
        setOut("Saved.", true);
        return;
      }
      if (act === "up" || act === "down") {
        moveItem(sectionId, qid, act);
        try { await saveTest(); } catch (e2) { return setOut(e2?.message || "Save failed.", false); }
        setOut("Saved.", true);
        return;
      }
    }

    const qEl = e.target?.closest?.("[data-qid][data-section]");
    if (qEl) {
      const sectionId = String(qEl.dataset.section || "");
      const qid = String(qEl.dataset.qid || "");
      if (sectionId === "writing" && qid === "drag1") {
        setQuestionsTab("writing");
        applyEditorsForTab("writing");
        scrollToEl(elDragEditor);
        setOut("Loaded drag exercise into editor.", true);
        return;
      }
      if (sectionId === "writing" && qid === "q4") {
        setQuestionsTab("writing");
        applyEditorsForTab("writing");
        scrollToEl(elWritingEditor);
        setOut("Loaded writing prompt into editor.", true);
        return;
      }

      loadItemIntoEditor(sectionId, qid);
      setOut("Loaded into editor.", true);
    }
  });
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
