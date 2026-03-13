export function createQuestionsListHelpers(ctx) {
  const {
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
    getPayload,
    getBuilderLocked,
    getEditingReadingTextId,
    setEditingReadingTextId,
    getEditingMcq,
    setEditingMcq,
    getListeningModalState,
    getLastItemIdBySection,
    setLastItemIdForSection,
    getDndState,
    setDndState,
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
  } = ctx || {};

  function deleteItem(sectionId, itemId) {
    const payload = getPayload();
    const sec = ensureSection(payload, sectionId, sectionId);
    sec.items = (sec.items || []).filter((it) => String(it?.id || "") !== String(itemId));
    if (String(sectionId) === "reading" && String(getEditingReadingTextId() || "") === String(itemId)) clearReadingTextForm();
    if (String(sectionId) === "listening") {
      if (String(getListeningModalState()?.itemId || "") === String(itemId)) showListeningModal(false);
      if (String(getLastItemIdBySection().listening || "") === String(itemId)) setLastItemIdForSection("listening", null);
    }
    if (String(sectionId) === "reading") {
      if (String(getListeningModalState()?.itemId || "") === String(itemId)) showListeningModal(false);
      if (String(getLastItemIdBySection().reading || "") === String(itemId)) setLastItemIdForSection("reading", null);
    }
    const editingMcq = getEditingMcq();
    if (String(editingMcq.sectionId) === String(sectionId) && String(editingMcq.itemId || "") === String(itemId)) clearMcqForm();
    renderQuestionsList();
  }

  function moveItem(sectionId, itemId, dir) {
    const payload = getPayload();
    const sec = ensureSection(payload, sectionId, sectionId);
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

  function moveItemTo(sectionId, itemId, targetItemId, after = false) {
    const payload = getPayload();
    const sec = ensureSection(payload, sectionId, sectionId);
    const items = Array.isArray(sec.items) ? sec.items.slice() : [];
    const fromId = String(itemId || "");
    const toId = String(targetItemId || "");
    if (!fromId || !toId || fromId === toId) return false;

    const fromIdx = items.findIndex((it) => String(it?.id || "") === fromId);
    const toIdxRaw = items.findIndex((it) => String(it?.id || "") === toId);
    if (fromIdx < 0 || toIdxRaw < 0) return false;

    const [moved] = items.splice(fromIdx, 1);
    let toIdx = toIdxRaw;
    if (fromIdx < toIdx) toIdx -= 1;
    if (after) toIdx += 1;
    toIdx = Math.max(0, Math.min(items.length, toIdx));
    items.splice(toIdx, 0, moved);
    sec.items = items;
    renderQuestionsList();
    return true;
  }

  function loadItemIntoEditor(sectionId, itemId) {
    const payload = getPayload();
    const sec = ensureSection(payload, sectionId, sectionId);
    const it = (sec.items || []).find((x) => String(x?.id || "") === String(itemId));
    if (!it) return;

    if (sectionId === "listening") {
      setQuestionsTab("listening");
      setLastItemIdForSection("listening", String(itemId || ""));
      openListeningModal({ sectionId: "listening", mode: it.type === "info" ? "info" : "mcq", itemId: String(itemId || "") });
      return;
    }
    if (sectionId === "reading") {
      setQuestionsTab("reading");
      setLastItemIdForSection("reading", String(itemId || ""));
      openListeningModal({ sectionId: "reading", mode: it.type === "info" ? "info" : "mcq", itemId: String(itemId || "") });
      return;
    }
    if (sectionId === "writing") setQuestionsTab("writing");

    if (it.type === "info") {
      if (elReadingText) elReadingText.value = String(it.prompt || "");
      setEditingReadingTextId(String(it.id || itemId));
      scrollToEl(elReadingTextEditor);
      return;
    }
    setEditingMcq({ sectionId, itemId: String(it.id) });
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

  function renderQuestionsList() {
    const payload = getPayload();
    if (!payload) return;
    ensureWritingDefaults();

    const listening = ensureSection(payload, "listening", "Part 1: Listening");
    const reading = ensureSection(payload, "reading", "Part 2: Reading");
    const writing = ensureSection(payload, "writing", "Part 3: Writing");

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
                  <button class="btn btn-outline-secondary btn-sm testsDragHandle" data-action="drag" data-section="${escapeHtml(sec.id)}" data-qid="${id}" type="button" draggable="true" aria-label="Drag to reorder" title="Drag to reorder">↕</button>
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
            const preview = escapeHtml(txt.length > 220 ? `${txt.slice(0, 220)}...` : txt);
            return `
              <div class="qCard" data-section="reading" data-qid="${id}" style="cursor:pointer;">
                <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
                  <div style="min-width:0;">
                    <div class="small muted">Reading · Text block</div>
                    <div class="small muted" style="margin-top:6px; white-space:pre-wrap;">${preview || "(empty)"}</div>
                  </div>
                  <div class="qActions">
                    <button class="btn btn-outline-secondary btn-sm" data-action="edit" data-section="reading" data-qid="${id}" type="button">Edit</button>
                    <button class="btn btn-outline-secondary btn-sm testsDragHandle" data-action="drag" data-section="reading" data-qid="${id}" type="button" draggable="true" aria-label="Drag to reorder" title="Drag to reorder">↕</button>
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
                  <button class="btn btn-outline-secondary btn-sm testsDragHandle" data-action="drag" data-section="reading" data-qid="${id}" type="button" draggable="true" aria-label="Drag to reorder" title="Drag to reorder">↕</button>
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

    const renderListeningMixed = () => {
      const secId = "listening";
      const items = (listening.items || []).filter((it) => it && (it.type === "info" || it.type === "listening-mcq" || it.type === "tf"));
      if (!items.length) return `<div class="muted">No listening items.</div>`;

      const renderInfoCard = (it) => {
        const id = escapeHtml(String(it.id || ""));
        const txt = String(it.prompt || "");
        const preview = escapeHtml(txt.length > 220 ? `${txt.slice(0, 220)}...` : txt);
        return `
          <div class="qCard" data-section="${secId}" data-qid="${id}" style="cursor:pointer;">
            <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
              <div style="min-width:0;">
                <div class="small muted">Listening &middot; Text block</div>
                <div class="small muted" style="margin-top:6px; white-space:pre-wrap;">${preview || "(empty)"}</div>
              </div>
              <div class="qActions">
                <button class="btn btn-outline-secondary btn-sm" data-action="edit" data-section="${secId}" data-qid="${id}" type="button">Edit</button>
                <button class="btn btn-outline-secondary btn-sm testsDragHandle" data-action="drag" data-section="${secId}" data-qid="${id}" type="button" draggable="true" aria-label="Drag to reorder" title="Drag to reorder">↕</button>
                <button class="btn btn-outline-secondary btn-sm" data-action="up" data-section="${secId}" data-qid="${id}" type="button">Up</button>
                <button class="btn btn-outline-secondary btn-sm" data-action="down" data-section="${secId}" data-qid="${id}" type="button">Down</button>
                <button class="btn btn-outline-danger btn-sm" data-action="delete" data-section="${secId}" data-qid="${id}" type="button">Delete</button>
              </div>
            </div>
          </div>
        `;
      };

      const renderMcqCard = (it, qNo) => {
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
          <div class="qCard" data-section="${secId}" data-qid="${id}" style="cursor:pointer;">
            <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
              <div style="min-width:0;">
                <div class="small muted">Listening &middot; Question ${escapeHtml(String(qNo))}</div>
                <div class="qCardTitle">${prompt || "(empty)"}</div>
              </div>
              <div class="qActions">
                <button class="btn btn-outline-secondary btn-sm" data-action="edit" data-section="${secId}" data-qid="${id}" type="button">Edit</button>
                <button class="btn btn-outline-secondary btn-sm testsDragHandle" data-action="drag" data-section="${secId}" data-qid="${id}" type="button" draggable="true" aria-label="Drag to reorder" title="Drag to reorder">↕</button>
                <button class="btn btn-outline-secondary btn-sm" data-action="up" data-section="${secId}" data-qid="${id}" type="button">Up</button>
                <button class="btn btn-outline-secondary btn-sm" data-action="down" data-section="${secId}" data-qid="${id}" type="button">Down</button>
                <button class="btn btn-outline-danger btn-sm" data-action="delete" data-section="${secId}" data-qid="${id}" type="button">Delete</button>
              </div>
            </div>
            <div class="qPreview">${preview}</div>
          </div>
        `;
      };

      let qNo = 0;
      const body = items.map((it) => {
        if (it.type === "info") return renderInfoCard(it);
        qNo += 1;
        return renderMcqCard(it, qNo);
      }).join("");

      return `<h3 style="margin:14px 0 8px 0;">Listening</h3>${body}`;
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

    if (elQuestionsListening) elQuestionsListening.innerHTML = renderListeningMixed();
    if (elQuestionsReading) elQuestionsReading.innerHTML = renderReading();
    if (elQuestionsWriting) elQuestionsWriting.innerHTML = writingSummary;
  }

  function wireQuestionListEvents() {
    elQuestionsList?.addEventListener("click", async (e) => {
      if (getBuilderLocked()) {
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
        if (act === "drag") return;
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

      const qEl = e.target?.closest?.(".qCard[data-qid][data-section]");
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

    const clearDndVisuals = () => {
      try {
        for (const c of Array.from(elQuestionsList?.querySelectorAll(".qCard") || [])) {
          c.classList.remove("qCard--drop-before", "qCard--drop-after", "qCard--dragging");
        }
      } catch {}
      setDndState({ dragging: false, sectionId: "", itemId: "", overCard: null, overAfter: false });
    };

    elQuestionsList?.addEventListener("dragstart", (e) => {
      const handle = e.target?.closest?.('button[data-action="drag"][draggable="true"]');
      if (!handle) return;
      if (getBuilderLocked()) {
        try { e.preventDefault(); } catch {}
        return setOut("Locked: test has started.", false);
      }

      const card = handle.closest?.(".qCard[data-section][data-qid]");
      if (!card) return;
      const sectionId = String(card.dataset.section || "");
      const itemId = String(card.dataset.qid || "");
      if (!sectionId || !itemId) return;

      setDndState({ dragging: true, sectionId, itemId, overCard: null, overAfter: false });
      try { card.classList.add("qCard--dragging"); } catch {}
      try {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", JSON.stringify({ sectionId, itemId }));
        try { e.dataTransfer.setDragImage(card, 24, 18); } catch {}
      } catch {}
    });

    elQuestionsList?.addEventListener("dragover", (e) => {
      const dndState = getDndState();
      if (!dndState.dragging) return;
      const card = e.target?.closest?.(".qCard[data-section][data-qid]");
      if (!card) return;
      const sectionId = String(card.dataset.section || "");
      if (sectionId !== dndState.sectionId) return;

      try { e.preventDefault(); } catch {}
      try { e.dataTransfer.dropEffect = "move"; } catch {}

      const rect = card.getBoundingClientRect();
      const after = (e.clientY - rect.top) > (rect.height / 2);
      if (dndState.overCard !== card || dndState.overAfter !== after) {
        try {
          if (dndState.overCard) dndState.overCard.classList.remove("qCard--drop-before", "qCard--drop-after");
        } catch {}
        setDndState({ ...dndState, overCard: card, overAfter: after });
        try { card.classList.add(after ? "qCard--drop-after" : "qCard--drop-before"); } catch {}
      }
    });

    elQuestionsList?.addEventListener("drop", async (e) => {
      const dndState = getDndState();
      if (!dndState.dragging) return;
      const card = e.target?.closest?.(".qCard[data-section][data-qid]");
      if (!card) return clearDndVisuals();
      const sectionId = String(card.dataset.section || "");
      const targetId = String(card.dataset.qid || "");
      if (sectionId !== dndState.sectionId) return clearDndVisuals();
      if (!targetId || targetId === dndState.itemId) return clearDndVisuals();

      try { e.preventDefault(); } catch {}
      const rect = card.getBoundingClientRect();
      const after = (e.clientY - rect.top) > (rect.height / 2);

      const moved = moveItemTo(sectionId, dndState.itemId, targetId, after);
      clearDndVisuals();
      if (!moved) return;
      try { await saveTest(); } catch (e2) { return setOut(e2?.message || "Save failed.", false); }
      setOut("Saved.", true);
    });

    elQuestionsList?.addEventListener("dragend", () => {
      const dndState = getDndState();
      if (!dndState.dragging) return;
      clearDndVisuals();
    });
  }

  return {
    deleteItem,
    moveItem,
    moveItemTo,
    loadItemIntoEditor,
    renderQuestionsList,
    wireQuestionListEvents,
  };
}
