export function renderLegacyWritingDragTask(sec, secEl, deps){
  const { registerCanvasTextBlock, appendCanvasInlineText, saveAnswers } = deps || {};
  const writingItems = Array.isArray(sec.items) ? sec.items : [];
  let rendered = false;
if (!rendered){
  const gapIds = ["w1", "w2", "w3", "w4"];
const gapItems = gapIds
  .map((id)=> writingItems.find((it)=> String(it?.id || "") === id))
  .filter(Boolean);

if (gapItems.length === 4){
  const titleCfg = writingItems.find((it)=> it && String(it.type || "") === "drag-words" && String(it.title || "").trim());
  const titleText = String(titleCfg?.title || "Task 1: Drag the correct words into the gaps.");
  const bankWords = Array.isArray(gapItems[0].choices) ? gapItems[0].choices.map((x)=> String(x)) : [];
  const choiceIndexByWord = new Map(bankWords.map((w, i)=> [String(w).toLowerCase(), i]));

  const gapCard = document.createElement("div");
  gapCard.className = "q";

  const gapTitle = document.createElement("div");
  gapTitle.className = "q-title canvas-text-host";
  registerCanvasTextBlock(gapTitle, titleText, {
    minWidth: 220,
    closestSelector: ".q",
    widthMode: "container",
    canvasClassName: "question-text-canvas",
  });
  gapCard.appendChild(gapTitle);

  const gapText = document.createElement("div");
  gapText.style.lineHeight = "1.8";
  gapText.style.marginTop = "8px";
  appendCanvasInlineText(gapText, "Rain makes the ");
  (()=> {
    const gap = document.createElement("span");
    gap.className = "gap-blank";
    gap.dataset.index = "1";
    gap.dataset.qid = "w1";
    gap.textContent = "(1)";
    gapText.appendChild(gap);
  })();
  appendCanvasInlineText(gapText, " shine.\nThe air smells clean and ");
  (()=> {
    const gap = document.createElement("span");
    gap.className = "gap-blank";
    gap.dataset.index = "2";
    gap.dataset.qid = "w2";
    gap.textContent = "(2)";
    gapText.appendChild(gap);
  })();
  appendCanvasInlineText(gapText, ".\nI put on my ");
  (()=> {
    const gap = document.createElement("span");
    gap.className = "gap-blank";
    gap.dataset.index = "3";
    gap.dataset.qid = "w3";
    gap.textContent = "(3)";
    gapText.appendChild(gap);
  })();
  appendCanvasInlineText(gapText, " and boots.\nI feel calm and happy. I like rain because it helps ");
  (()=> {
    const gap = document.createElement("span");
    gap.className = "gap-blank";
    gap.dataset.index = "4";
    gap.dataset.qid = "w4";
    gap.textContent = "(4)";
    gapText.appendChild(gap);
  })();
  appendCanvasInlineText(gapText, " grow and makes trees look fresh.");
  gapCard.appendChild(gapText);

  const bankTitle = document.createElement("div");
  bankTitle.className = "small canvas-text-host";
  bankTitle.style.marginTop = "10px";
  registerCanvasTextBlock(bankTitle, "Word bank:", {
    minWidth: 120,
    closestSelector: ".q",
    widthMode: "natural",
    canvasClassName: "instruction-text-canvas",
  });
  gapCard.appendChild(bankTitle);

  const bank = document.createElement("div");
  bank.className = "word-bank";
  bank.style.display = "flex";
  bank.style.flexWrap = "wrap";
  bank.style.gap = "8px";
  bank.style.marginTop = "8px";

  for (const word of bankWords){
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "word-chip canvas-text-host";
    chip.draggable = true;
    chip.dataset.word = word;
    registerCanvasTextBlock(chip, word, {
      minWidth: 56,
      closestSelector: ".word-bank",
      widthMode: "natural",
      canvasClassName: "choice-text-canvas",
    });
    bank.appendChild(chip);
  }
  gapCard.appendChild(bank);

  const tip = document.createElement("div");
  tip.className = "small canvas-text-host";
  tip.style.marginTop = "8px";
  registerCanvasTextBlock(tip, "Tip: drag words into gaps. Drag back to the word bank (or double-click a gap) to clear it.", {
    minWidth: 180,
    closestSelector: ".q",
    widthMode: "container",
    canvasClassName: "instruction-text-canvas",
  });
  gapCard.appendChild(tip);

  secEl.appendChild(gapCard);

  const gaps = [...gapCard.querySelectorAll(".gap-blank[data-qid]")];
  const chips = [...gapCard.querySelectorAll(".word-chip")];
  let draggedChip = null;
  let selectedChip = null;
  const enableTapMode = (()=>{
    try{
      if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) return true;
    } catch {}
    try{
      if (navigator && Number(navigator.maxTouchPoints || 0) > 0) return true;
    } catch {}
    return window.innerWidth <= 820;
  })();

  const clearGap = (gap)=>{
    const prevWord = String(gap.dataset.word || "");
    if (prevWord){
      const prevChip = chips.find((ch)=> String(ch.dataset.word || "") === prevWord);
      if (prevChip) prevChip.classList.remove("in-gap");
    }
    gap.textContent = `(${gap.dataset.index || ""})`;
    gap.dataset.word = "";
    gap.dataset.choiceIndex = "";
    gap.classList.remove("filled");
    gap.draggable = false;
  };

  const clearSelectedChip = ()=>{
    if (!selectedChip) return;
    selectedChip.classList.remove("selected");
    selectedChip.setAttribute("aria-pressed", "false");
    selectedChip = null;
  };

  const selectChip = (chip)=>{
    if (!chip) return;
    if (selectedChip === chip) {
      clearSelectedChip();
      return;
    }
    clearSelectedChip();
    selectedChip = chip;
    chip.classList.add("selected");
    chip.setAttribute("aria-pressed", "true");
  };

  const placeWordInGap = (gap, chip)=>{
    if (!gap || !chip) return;
    const draggedWord = String(chip.dataset.word || "");
    if (!draggedWord) return;

    // If this word is already used in another gap, clear it there first.
    const existingGap = gaps.find((g)=> String(g.dataset.word || "") === draggedWord);
    if (existingGap && existingGap !== gap) clearGap(existingGap);

    clearGap(gap);
    gap.textContent = draggedWord;
    gap.dataset.word = draggedWord;
    gap.dataset.choiceIndex = String(
      choiceIndexByWord.has(draggedWord.toLowerCase())
        ? choiceIndexByWord.get(draggedWord.toLowerCase())
        : ""
    );
    gap.classList.add("filled");
    gap.draggable = true;
    chip.classList.add("in-gap");
  };

  const setDragImageFromChip = (e, chip)=>{
    try{
      if (!e?.dataTransfer || !chip) return;
      const ghost = chip.cloneNode(true);
      ghost.style.position = "fixed";
      ghost.style.left = "-9999px";
      ghost.style.top = "-9999px";
      ghost.style.pointerEvents = "none";
      ghost.classList.add("dragging");
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 16, 16);
      setTimeout(()=>{ try{ ghost.remove(); }catch(e2){} }, 0);
    }catch(e2){}
  };

  chips.forEach((chip)=>{
    chip.addEventListener("dragstart", (e)=>{
      draggedChip = chip;
      chip.classList.add("dragging");
      if (e.dataTransfer){
        e.dataTransfer.effectAllowed = "move";
        try{ e.dataTransfer.setData("text/plain", String(chip.dataset.word || "")); }catch(e2){}
      }
      setDragImageFromChip(e, chip);
    });
    chip.addEventListener("dragend", ()=>{
      draggedChip = null;
      chip.classList.remove("dragging");
    });
  });

  // Allow dragging a filled gap back to the word bank.
  gaps.forEach((gap)=>{
    gap.dataset.choiceValues = JSON.stringify(bankWords);
    gap.addEventListener("dragstart", (e)=>{
      const w = String(gap.dataset.word || "");
      if (!w) return;
      const chip = chips.find((ch)=> String(ch.dataset.word || "") === w) || null;
      if (!chip) return;
      draggedChip = chip;
      chip.classList.add("dragging");
      if (e.dataTransfer){
        e.dataTransfer.effectAllowed = "move";
        try{ e.dataTransfer.setData("text/plain", w); }catch(e2){}
      }
      setDragImageFromChip(e, chip);
    });
    gap.addEventListener("dragend", ()=>{
      if (draggedChip) draggedChip.classList.remove("dragging");
      draggedChip = null;
    });
  });

  // Dropping on the bank removes the word from the sentence (returns it).
  bank.addEventListener("dragover", (e)=>{
    e.preventDefault();
    bank.classList.add("bank-over");
  });
  bank.addEventListener("dragleave", ()=> bank.classList.remove("bank-over"));
  bank.addEventListener("drop", (e)=>{
    e.preventDefault();
    bank.classList.remove("bank-over");
    if (!draggedChip) return;
    const w = String(draggedChip.dataset.word || "");
    const existingGap = gaps.find((g)=> String(g.dataset.word || "") === w);
    if (existingGap){
      clearGap(existingGap);
      saveAnswers();
    }
  });

  if (enableTapMode) {
    registerCanvasTextBlock(tip, "Tip: tap a word, then tap a gap. Tap a filled gap to clear it.", {
      minWidth: 180,
      closestSelector: ".q",
      widthMode: "container",
      canvasClassName: "instruction-text-canvas",
    });

    // Make gaps focusable for accessibility and mobile keyboards.
    gaps.forEach((gap)=>{
      try{
        gap.setAttribute("role", "button");
        gap.setAttribute("tabindex", "0");
        gap.setAttribute("aria-label", `Gap ${String(gap.dataset.index || "").trim() || ""}`.trim());
      } catch {}
    });

    chips.forEach((chip)=>{
      try { chip.setAttribute("aria-pressed", "false"); } catch {}
      chip.addEventListener("click", ()=>{
        selectChip(chip);
      });
      chip.addEventListener("keydown", (e)=>{
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        selectChip(chip);
      });
    });

    gaps.forEach((gap)=>{
      const activate = ()=>{
        if (selectedChip) {
          placeWordInGap(gap, selectedChip);
          clearSelectedChip();
          saveAnswers();
          return;
        }
        // No word selected: tapping a filled gap clears it.
        if (gap.classList.contains("filled")) {
          clearGap(gap);
          saveAnswers();
        }
      };
      gap.addEventListener("click", activate);
      gap.addEventListener("keydown", (e)=>{
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        activate();
      });
    });

    // Tapping outside clears selection.
    gapCard.addEventListener("click", (e)=>{
      const t = e.target;
      if (!t) return;
      if (t.closest && (t.closest(".word-chip") || t.closest(".gap-blank"))) return;
      clearSelectedChip();
    });
  }

  gaps.forEach((gap)=>{
    gap.addEventListener("dragover", (e)=>{
      if (enableTapMode) return;
      e.preventDefault();
      gap.classList.add("drag-over");
    });
    gap.addEventListener("dragleave", ()=> gap.classList.remove("drag-over"));
    gap.addEventListener("drop", (e)=>{
      if (enableTapMode) return;
      e.preventDefault();
      gap.classList.remove("drag-over");
      if (!draggedChip) return;

      // If dropped chip already used in another gap, remove it there first.
      placeWordInGap(gap, draggedChip);
      saveAnswers();
    });
    gap.addEventListener("dblclick", ()=>{
      clearGap(gap);
      saveAnswers();
    });
  });
}
}

  return { rendered };
}
