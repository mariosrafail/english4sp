import { renderWritingDragTasks } from "/exam/renderers-writing-drag.js";

export function countWritingWords(value){
  const text = String(value || "").trim();
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

export function hardenWritingTextarea(textarea){
  if (!textarea) return null;
  // These browser attributes are only hints. They reduce browser-level assistance,
  // but cannot fully disable every OS keyboard, extension, or AI input feature.
  textarea.spellcheck = false;
  textarea.autocomplete = "off";
  textarea.setAttribute("spellcheck", "false");
  textarea.setAttribute("autocorrect", "off");
  textarea.setAttribute("autocapitalize", "off");
  textarea.setAttribute("autocomplete", "off");
  textarea.setAttribute("inputmode", "text");
  textarea.setAttribute("data-gramm", "false");
  textarea.setAttribute("data-gramm_editor", "false");
  textarea.setAttribute("data-enable-grammarly", "false");
  textarea.setAttribute("translate", "no");
  textarea.classList.add("writingTextarea");

  const form = textarea.closest("form");
  if (form) {
    form.setAttribute("autocomplete", "off");
    form.setAttribute("spellcheck", "false");
  }
  return textarea;
}

function showWritingSecurityWarning(textarea, message){
  let box = document.querySelector(".writingSecurityToast");
  if (!box) {
    box = document.createElement("div");
    box.className = "writingSecurityToast";
    box.setAttribute("role", "status");
    document.body.appendChild(box);
  }
  box.textContent = String(message || "");
  positionWritingSecurityToast(box);
  box.classList.add("show");
  clearTimeout(box._hideTimer);
  box._hideTimer = setTimeout(()=> {
    box.classList.remove("show");
  }, 2600);
}

function positionWritingSecurityToast(box){
  if (!box) return;
  try {
    const vv = window.visualViewport;
    if (!vv) {
      box.style.top = "18px";
      box.style.bottom = "auto";
      return;
    }

    const top = Math.max(12, Math.round(vv.offsetTop + 14));
    box.style.top = `${top}px`;
    box.style.bottom = "auto";
  } catch {
    box.style.top = "18px";
    box.style.bottom = "auto";
  }
}

function repositionVisibleWritingSecurityToast(){
  const box = document.querySelector(".writingSecurityToast.show");
  if (box) positionWritingSecurityToast(box);
}

try {
  window.visualViewport?.addEventListener("resize", repositionVisibleWritingSecurityToast);
  window.visualViewport?.addEventListener("scroll", repositionVisibleWritingSecurityToast);
  window.addEventListener("resize", repositionVisibleWritingSecurityToast);
} catch {}

function isNormalTypingInputType(inputType){
  const t = String(inputType || "");
  return t === "insertText" ||
    t === "insertLineBreak" ||
    t === "insertParagraph" ||
    t === "insertCompositionText" ||
    t === "deleteContentBackward" ||
    t === "deleteContentForward" ||
    t === "deleteByCut" ||
    t === "historyUndo" ||
    t === "historyRedo";
}

export function attachWritingSecurityGuards(textarea, item, deps = {}){
  if (!textarea || textarea._writingSecurityGuardsAttached) return textarea;
  textarea._writingSecurityGuardsAttached = true;
  const logSecurityEvent = typeof deps.logSecurityEvent === "function" ? deps.logSecurityEvent : null;
  const qid = String(item?.id || textarea.name || "");
  const warnPaste = "Pasting is not allowed during the exam.";
  const warnDrop = "Drag and drop text is not allowed during the exam.";
  const warnSelection = "Text selection is not allowed during the exam.";

  const log = (eventType, payload = {}) => {
    if (!logSecurityEvent) return;
    logSecurityEvent(eventType, {
      ...payload,
      qid,
      fieldName: String(textarea.name || ""),
      timestamp: Date.now(),
    });
  };

  textarea.addEventListener("paste", (e)=> {
    e.preventDefault();
    showWritingSecurityWarning(textarea, warnPaste);
    log("paste_blocked");
  });

  textarea.addEventListener("drop", (e)=> {
    e.preventDefault();
    showWritingSecurityWarning(textarea, warnDrop);
    log("drop_blocked");
  });
  textarea.addEventListener("dragover", (e)=> {
    e.preventDefault();
  });

  textarea.addEventListener("contextmenu", (e)=> {
    e.preventDefault();
    log("context_menu_blocked");
  });

  const collapseSelection = (reason) => {
    try {
      const start = Number(textarea.selectionStart || 0);
      const end = Number(textarea.selectionEnd || 0);
      if (start === end) return false;
      const caret = Math.max(start, end);
      textarea.setSelectionRange(caret, caret);
      showWritingSecurityWarning(textarea, warnSelection);
      log("text_selection_blocked", { reason, previousSelectionStart: start, previousSelectionEnd: end });
      return true;
    } catch {
      return false;
    }
  };

  textarea.addEventListener("select", ()=> {
    setTimeout(()=> collapseSelection("select_event"), 0);
  });

  textarea.addEventListener("pointerdown", (e)=> {
    if (Number(e?.detail || 0) > 1) {
      e.preventDefault();
      showWritingSecurityWarning(textarea, warnSelection);
      log("text_selection_blocked", { reason: "multi_click" });
    }
  });

  textarea.addEventListener("pointermove", (e)=> {
    if (Number(e?.buttons || 0) === 1) {
      e.preventDefault();
      collapseSelection("pointer_drag");
    }
  });

  textarea.addEventListener("mouseup", ()=> {
    setTimeout(()=> collapseSelection("mouse_up"), 0);
  });

  textarea.addEventListener("keyup", ()=> {
    setTimeout(()=> collapseSelection("key_up"), 0);
  });

  textarea.addEventListener("keydown", (e)=> {
    const key = String(e?.key || "");
    const isSelectAll = (e.ctrlKey || e.metaKey) && key.toLowerCase() === "a";
    const selectionKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
    if (isSelectAll || (e.shiftKey && selectionKeys.has(key))) {
      e.preventDefault();
      showWritingSecurityWarning(textarea, warnSelection);
      log("text_selection_blocked", { reason: isSelectAll ? "select_all_shortcut" : "shift_navigation", key });
    }
  });

  let previousLength = String(textarea.value || "").length;
  textarea.addEventListener("input", (e)=> {
    const newLength = String(textarea.value || "").length;
    const addedCharacterCount = newLength - previousLength;
    const inputType = String(e?.inputType || "");
    if (e?.isTrusted !== false && addedCharacterCount > 30 && !isNormalTypingInputType(inputType)) {
      log("suspicious_text_insert", {
        previousLength,
        newLength,
        addedCharacterCount,
        inputType,
      });
    }
    previousLength = newLength;
  });

  textarea.addEventListener("change", ()=> {
    previousLength = String(textarea.value || "").length;
  });

  return textarea;
}

export function attachWritingWordCounter(textarea, item, deps = {}){
  if (!textarea) return null;
  hardenWritingTextarea(textarea);
  attachWritingSecurityGuards(textarea, item, deps);

  const counter = document.createElement("div");
  counter.className = "writingWordCounter";
  const minWords = Number(item?.minWords || item?.minimumWords || item?.wordMinimum || 0);
  const hasMin = Number.isFinite(minWords) && minWords > 0;

  const update = ()=> {
    const words = countWritingWords(textarea.value);
    counter.textContent = hasMin ? `Words: ${words} / minimum ${minWords}` : `Words: ${words}`;
  };

  textarea.addEventListener("input", update);
  textarea.addEventListener("change", update);
  update();
  textarea._updateWritingWordCounter = update;
  return counter;
}

export function hardenAllWritingTextareas(root = document){
  try {
    (root || document).querySelectorAll("textarea.writingTextarea, textarea[data-writing-textarea='true']").forEach((textarea)=> {
      hardenWritingTextarea(textarea);
      if (typeof textarea._updateWritingWordCounter === "function") textarea._updateWritingWordCounter();
    });
  } catch {}
}

export function renderWritingSection(sec, secEl, deps){
  return renderWritingDragTasks(sec, secEl, deps);
}
