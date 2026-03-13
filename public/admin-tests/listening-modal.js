export function createListeningModalHelpers(ctx) {
  const {
    escapeHtml,
    optionLabel,
    postParentFullscreen,
    normalizeText,
    ensureSection,
    nextId,
    renderQuestionsList,
    saveTest,
    setOut,
    getPayload,
    getBuilderLocked,
    getListeningModalState,
    setListeningModalState,
    getLastItemIdBySection,
    setLastItemIdForSection,
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
    getQuestionsTab,
  } = ctx || {};

  let listeningModalLockMode = "";

  function showListeningModal(show) {
    const on = !!show;
    const nextState = { ...(getListeningModalState() || {}), open: on };
    setListeningModalState(nextState);
    try { if (elListeningModalOverlay) elListeningModalOverlay.style.display = on ? "flex" : "none"; } catch {}
    try { postParentFullscreen(on); } catch {}
    if (!on) return;
    try { elListeningModalWindow?.focus?.(); } catch {}
  }

  function setListeningModalMode(mode) {
    const m = String(mode || "").trim() === "info" ? "info" : "mcq";
    const nextState = { ...(getListeningModalState() || {}), mode: m };
    setListeningModalState(nextState);
    listeningModalLockMode = "";
    try {
      if (elListeningModalMcq) elListeningModalMcq.style.display = m === "mcq" ? "" : "none";
      if (elListeningModalInfo) elListeningModalInfo.style.display = m === "info" ? "" : "none";
    } catch {}
  }

  function renderListeningModalOptions(choices = [], correctIndex = 0) {
    const arr = Array.isArray(choices) ? choices : [];
    const n = Math.max(2, Math.min(12, arr.length || 4));
    const corr = Number.isFinite(Number(correctIndex)) ? Number(correctIndex) : 0;
    const groupName = "listeningModalCorrectOpt";

    const rows = [];
    for (let i = 0; i < n; i++) {
      const checked = i === corr;
      const val = String(arr[i] || "");
      const rid = `listeningModalCorrectOpt_${i}`;
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
    if (elListeningModalOptionsBox) elListeningModalOptionsBox.innerHTML = rows.join("");

    const locked = listeningModalLockMode === "tf";
    try {
      for (const inp of Array.from(elListeningModalOptionsBox?.querySelectorAll("input.optionText") || [])) {
        inp.readOnly = locked;
        inp.classList.toggle("mono", locked);
      }
      if (elListeningModalAddOption) elListeningModalAddOption.disabled = locked;
      if (elListeningModalRemoveOption) elListeningModalRemoveOption.disabled = locked;
    } catch {}
  }

  function readListeningModalMcqForm() {
    const prompt = normalizeText(elListeningModalQText?.value, 800);
    const optRows = Array.from(elListeningModalOptionsBox?.querySelectorAll(".optionRow") || []);
    const optionTexts = optRows.map((row) => normalizeText(row.querySelector("input.optionText")?.value, 240));
    let correctIdx = optRows.findIndex((row) => row.querySelector("input.optionCorrect")?.checked);
    if (correctIdx < 0) correctIdx = optRows.findIndex((row) => String(row.getAttribute("data-correct") || "") === "1");
    const nonEmpty = optionTexts.filter((c) => c.trim()).length;
    return { prompt, choices: optionTexts, correctIdx, nonEmpty };
  }

  function openListeningModal({ sectionId, mode, itemId = null, afterItemId = null } = {}) {
    const payload = getPayload();
    if (!payload) return;
    if (getBuilderLocked()) return setOut("Locked: test has started.", false);

    const secId = String(sectionId || "listening");
    const secTitle = secId === "reading" ? "Part 2: Reading" : "Part 1: Listening";
    const sec = ensureSection(payload, secId, secTitle);
    sec.items = Array.isArray(sec.items) ? sec.items : [];

    const nextState = { open: true, sectionId: secId, mode: mode === "info" ? "info" : "mcq", itemId, afterItemId };
    setListeningModalState(nextState);
    setListeningModalMode(nextState.mode);

    if (nextState.mode === "mcq") {
      const existing = itemId ? sec.items.find((it) => String(it?.id || "") === String(itemId)) : null;
      const label = secId === "reading" ? "reading" : "listening";
      if (elListeningModalTitle) elListeningModalTitle.textContent = existing ? `Edit ${label} question` : `New ${label} question`;
      if (elListeningModalQText) elListeningModalQText.value = String(existing?.prompt || "");

      if (existing && String(existing.type || "") === "tf") {
        listeningModalLockMode = "tf";
        renderListeningModalOptions(["True", "False"], existing.correct ? 0 : 1);
      } else {
        listeningModalLockMode = "";
        renderListeningModalOptions(Array.isArray(existing?.choices) ? existing.choices : ["", "", "", ""], Number(existing?.correctIndex || 0));
      }
    } else {
      const existing = itemId ? sec.items.find((it) => String(it?.id || "") === String(itemId)) : null;
      const label = secId === "reading" ? "reading" : "listening";
      if (elListeningModalTitle) elListeningModalTitle.textContent = existing ? `Edit ${label} text box` : `New ${label} text box`;
      if (elListeningModalInfoText) elListeningModalInfoText.value = String(existing?.prompt || "");
    }

    showListeningModal(true);
  }

  async function saveListeningModal() {
    const payload = getPayload();
    if (!payload) return;
    const modalState = getListeningModalState() || {};
    const secId = String(modalState.sectionId || "listening");
    const secTitle = secId === "reading" ? "Part 2: Reading" : "Part 1: Listening";
    const sec = ensureSection(payload, secId, secTitle);
    sec.items = Array.isArray(sec.items) ? sec.items : [];

    const { mode, itemId, afterItemId } = modalState;

    if (mode === "info") {
      const prompt = String(elListeningModalInfoText?.value || "").trim();
      if (!prompt) throw new Error("Text box is required.");
      const id = itemId || nextId(secId === "reading" ? "rt" : "li", sec.items);
      const item = { id: String(id), type: "info", prompt, points: 0 };

      const idx = sec.items.findIndex((it) => String(it?.id || "") === String(id));
      if (idx >= 0) sec.items[idx] = item;
      else {
        const j = afterItemId ? sec.items.findIndex((it) => String(it?.id || "") === String(afterItemId)) : -1;
        if (j >= 0) sec.items.splice(j + 1, 0, item);
        else sec.items.push(item);
      }

      setLastItemIdForSection(secId, String(id));
    } else {
      const { prompt, choices, correctIdx, nonEmpty } = readListeningModalMcqForm();
      if (!prompt) throw new Error("Question prompt is required.");
      if (correctIdx < 0) throw new Error("Pick the correct option.");

      const id = itemId || nextId(secId === "reading" ? "r" : "l", sec.items);
      const existing = sec.items.find((it) => String(it?.id || "") === String(id)) || null;
      const isTf = String(existing?.type || "") === "tf" || listeningModalLockMode === "tf";

      let item = null;
      if (isTf) {
        const idx = Number(correctIdx);
        if (!(idx === 0 || idx === 1)) throw new Error("True/False questions must have exactly 2 options.");
        item = { id: String(id), type: "tf", prompt, correct: idx === 0, points: Number(existing?.points ?? 1) || 1 };
      } else {
        if (nonEmpty < 2) throw new Error("Add at least 2 options.");
        if (!choices[correctIdx] || !String(choices[correctIdx]).trim()) throw new Error("Correct option cannot be empty.");
        item = { id: String(id), type: secId === "reading" ? "mcq" : "listening-mcq", prompt, choices: choices.map((c) => c || ""), correctIndex: correctIdx, points: Number(existing?.points ?? 1) || 1 };
      }

      const idx = sec.items.findIndex((it) => String(it?.id || "") === String(id));
      if (idx >= 0) sec.items[idx] = item;
      else {
        const j = afterItemId ? sec.items.findIndex((it) => String(it?.id || "") === String(afterItemId)) : -1;
        if (j >= 0) sec.items.splice(j + 1, 0, item);
        else sec.items.push(item);
      }

      setLastItemIdForSection(secId, String(id));
    }

    renderQuestionsList();
    await saveTest();
    showListeningModal(false);
    setOut("Saved.", true);
  }

  function wireListeningModalEvents() {
    const closeListeningModal = () => {
      showListeningModal(false);
      setOut("Canceled.", true);
    };

    elListeningNewQuestion?.addEventListener("click", () => {
      if (getQuestionsTab() !== "listening") setQuestionsTab("listening");
      openListeningModal({ sectionId: "listening", mode: "mcq", itemId: null, afterItemId: getLastItemIdBySection().listening });
    });

    elListeningNewText?.addEventListener("click", () => {
      if (getQuestionsTab() !== "listening") setQuestionsTab("listening");
      openListeningModal({ sectionId: "listening", mode: "info", itemId: null, afterItemId: getLastItemIdBySection().listening });
    });

    elReadingNewText?.addEventListener("click", () => {
      if (getQuestionsTab() !== "reading") setQuestionsTab("reading");
      openListeningModal({ sectionId: "reading", mode: "info", itemId: null, afterItemId: getLastItemIdBySection().reading });
    });

    elReadingNewQuestion?.addEventListener("click", () => {
      if (getQuestionsTab() !== "reading") setQuestionsTab("reading");
      openListeningModal({ sectionId: "reading", mode: "mcq", itemId: null, afterItemId: getLastItemIdBySection().reading });
    });

    elListeningModalClose?.addEventListener("click", closeListeningModal);
    elListeningModalCancel?.addEventListener("click", closeListeningModal);

    document.addEventListener("keydown", (e) => {
      if (!getListeningModalState()?.open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeListeningModal();
      }
    });

    elListeningModalSave?.addEventListener("click", async () => {
      try {
        await saveListeningModal();
      } catch (e) {
        setOut(e?.message || "Save failed.", false);
      }
    });

    elListeningModalAddOption?.addEventListener("click", () => {
      const cur = readListeningModalMcqForm();
      const choices = Array.isArray(cur.choices) ? cur.choices.slice() : [];
      if (choices.length >= 12) return;
      choices.push("");
      renderListeningModalOptions(choices, Math.max(0, cur.correctIdx));
    });

    elListeningModalRemoveOption?.addEventListener("click", () => {
      const cur = readListeningModalMcqForm();
      const choices = Array.isArray(cur.choices) ? cur.choices.slice() : [];
      if (choices.length <= 2) return;
      choices.pop();
      const nextCorr = Math.max(0, Math.min(cur.correctIdx, choices.length - 1));
      renderListeningModalOptions(choices, nextCorr);
    });

    elListeningModalOptionsBox?.addEventListener("change", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const radio = target.closest("input.optionCorrect");
      if (!radio) return;

      const rows = Array.from(elListeningModalOptionsBox.querySelectorAll(".optionRow"));
      for (const row of rows) row.setAttribute("data-correct", "0");
      const parent = radio.closest(".optionRow");
      if (parent) parent.setAttribute("data-correct", "1");
    });

    elListeningModalOptionsBox?.addEventListener("click", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest("input.optionText")) return;

      const row = target.closest(".optionRow");
      if (!row || !elListeningModalOptionsBox.contains(row)) return;
      const radio = row.querySelector("input.optionCorrect");
      if (!(radio instanceof HTMLInputElement)) return;
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    });

    elListeningModalBold?.addEventListener("click", () => {
      const ta = elListeningModalInfoText;
      if (!(ta instanceof HTMLTextAreaElement)) return;
      if (getBuilderLocked()) return;
      const start = Number.isFinite(Number(ta.selectionStart)) ? ta.selectionStart : 0;
      const end = Number.isFinite(Number(ta.selectionEnd)) ? ta.selectionEnd : start;
      const src = String(ta.value || "");
      const before = src.slice(0, start);
      const sel = src.slice(start, end);
      const after = src.slice(end);
      if (!sel) {
        ta.value = before + "****" + after;
        const pos = start + 2;
        try { ta.setSelectionRange(pos, pos); } catch {}
        try { ta.focus(); } catch {}
        return;
      }
      ta.value = before + `**${sel}**` + after;
      try { ta.setSelectionRange(start + 2, end + 2); } catch {}
      try { ta.focus(); } catch {}
    });
  }

  return {
    showListeningModal,
    setListeningModalMode,
    renderListeningModalOptions,
    readListeningModalMcqForm,
    openListeningModal,
    saveListeningModal,
    wireListeningModalEvents,
  };
}
