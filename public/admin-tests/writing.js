export function createWritingEditorHelpers(ctx) {
  const {
    escapeHtml,
    ensureSection,
    cloneJson,
    renderQuestionsList,
    saveTest,
    setOut,
    getPayload,
    setPayload,
    getPayloadInitial,
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
  } = ctx || {};

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
    const words = idxs
      .map((i) => (Number.isFinite(i) && i >= 0 && i < bank.length ? String(bank[i]) : ""))
      .filter(Boolean);
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
    const payload = getPayload();
    const writing = ensureSection(payload, "writing", "Part 3: Writing");

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
    const payload = getPayload();
    const writing = ensureSection(payload, "writing", "Part 3: Writing");

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
    const payload = getPayload();
    const writing = ensureSection(payload, "writing", "Part 3: Writing");

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

    writing.items = (writing.items || []).filter((it) => {
      const id = String(it?.id || "");
      if (id === "w_intro" || id === "w1" || id === "w2" || id === "w3" || id === "w4") return false;
      if (String(it?.dragParentId || "") === dragId) return false;
      if (id.startsWith(`${dragId}_g`)) return false;
      return true;
    });

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
    const payload = getPayload();
    const writing = ensureSection(payload, "writing", "Part 3: Writing");
    const idx = (writing.items || []).findIndex((it) => String(it?.id || "") === "q4");
    if (idx < 0) return { ok: false, error: "Missing writing item." };
    const prompt = String(elWritingPrompt?.value || "").trim();
    if (!prompt) return { ok: false, error: "Writing prompt is required." };
    writing.items[idx] = { ...writing.items[idx], type: "writing", prompt };
    renderQuestionsList();
    return { ok: true };
  }

  function wireWritingEditorEvents() {
    const onDragInput = () => {
      try { renderDragPreview(); } catch {}
    };

    elDragInstructions?.addEventListener("input", onDragInput);
    elDragText?.addEventListener("input", onDragInput);
    elDragExtras?.addEventListener("input", onDragInput);

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
      const initial = getPayloadInitial();
      if (initial) {
        setPayload(cloneJson(initial));
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
      const initial = getPayloadInitial();
      if (initial) {
        setPayload(cloneJson(initial));
        renderWritingEditorsFromPayload();
        renderQuestionsList();
        setOut("Reset writing prompt.", true);
      }
    });
  }

  return {
    buildDragPreview,
    ensureWritingDefaults,
    renderWritingEditorsFromPayload,
    renderDragPreview,
    saveDragFromEditor,
    saveWritingPromptFromEditor,
    wireWritingEditorEvents,
  };
}
