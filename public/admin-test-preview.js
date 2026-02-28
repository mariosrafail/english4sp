import { apiGet, qs, qsa, escapeHtml } from "/app.js";

const elEpName = qs("#epName");
const elTitle = qs("#title");
const elStatus = qs("#status");
const elContent = qs("#content");
const elClose = qs("#btnClose");

function richTextHtml(raw) {
  const src = String(raw || "");
  const parts = src.split("**");
  // Unbalanced markers -> treat literally.
  if (parts.length < 3 || parts.length % 2 === 0) return escapeHtml(src).replace(/\r?\n/g, "<br>");
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const seg = escapeHtml(parts[i]).replace(/\r?\n/g, "<br>");
    out += i % 2 === 1 ? `<b>${seg}</b>` : seg;
  }
  return out;
}

function showStatus(text, cls) {
  if (!elStatus) return;
  elStatus.style.display = "block";
  elStatus.textContent = String(text || "");
  elStatus.className = "notice " + (cls || "");
}

function hideStatus() {
  if (!elStatus) return;
  elStatus.style.display = "none";
}

function getExamPeriodId() {
  const params = new URLSearchParams(location.search);
  const ep = Number(params.get("examPeriodId") || 0);
  return Number.isFinite(ep) && ep > 0 ? ep : 1;
}

function getSectionKind(sec) {
  const id = String(sec?.id || "").toLowerCase();
  const title = String(sec?.title || "").toLowerCase();
  if (id.includes("listen") || title.includes("listen")) return "listening";
  if (id.includes("read") || title.includes("read")) return "reading";
  if (id.includes("writ") || title.includes("writ")) return "writing";
  return "other";
}

let sectionViews = [];
let currentSectionIdx = 0;

function wireChoiceSelectedState() {
  if (!elContent) return;
  elContent.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || !t.matches?.("input[type=radio]")) return;
    const q = t.closest(".q");
    if (!q) return;
    const choices = Array.from(q.querySelectorAll(".choice") || []);
    for (const c of choices) {
      const i = c.querySelector("input[type=radio]");
      c.classList.toggle("selected", !!i && i.checked);
    }
  });
}

function showSection(index) {
  if (!sectionViews.length) return;
  const clamped = Math.max(0, Math.min(Number(index) || 0, sectionViews.length - 1));
  currentSectionIdx = clamped;
  sectionViews.forEach((v, i) => {
    v.el.style.display = i === clamped ? "block" : "none";
  });
  try { window.scrollTo(0, 0); } catch {}
}

function uniqPreserve(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const v = String(x || "").trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function renderDragWords({ secEl, cfg }) {
  const rawText = String(cfg?.text || "");
  const rawExtras = String(cfg?.extraWords || "");

  const gapWords = [];
  rawText.replace(/\*\*([^*]+?)\*\*/g, (_, w) => {
    gapWords.push(String(w || "").trim());
    return "";
  });
  const extraWords = [];
  rawExtras.replace(/\*([^*]+?)\*/g, (_, w) => {
    extraWords.push(String(w || "").trim());
    return "";
  });

  const bankWords = Array.isArray(cfg?.bankWords) && cfg.bankWords.length
    ? uniqPreserve(cfg.bankWords)
    : uniqPreserve([...gapWords, ...extraWords]);

  if (!gapWords.length || !bankWords.length) return { rendered: false, dragId: "" };

  const dragId = String(cfg?.id || "drag1") || "drag1";
  const choiceIndexByWord = new Map(bankWords.map((w, i) => [String(w).toLowerCase(), i]));

  const gapCard = document.createElement("div");
  gapCard.className = "q";

  const gapTitle = document.createElement("div");
  gapTitle.className = "q-title";
  gapTitle.textContent = String(cfg?.title || "Task 1: Drag the correct words into the gaps.");
  gapCard.appendChild(gapTitle);

  if (String(cfg?.instructions || "").trim()) {
    const inst = document.createElement("div");
    inst.className = "small";
    inst.style.whiteSpace = "pre-wrap";
    inst.style.marginTop = "6px";
    inst.textContent = String(cfg.instructions || "");
    gapCard.appendChild(inst);
  }

  const gapText = document.createElement("div");
  gapText.style.lineHeight = "1.8";
  gapText.style.marginTop = "8px";
  gapText.style.whiteSpace = "pre-wrap";

  const choiceValuesJson = (() => {
    try { return JSON.stringify(bankWords); } catch { return "[]"; }
  })();

  const rx = /\*\*([^*]+?)\*\*/g;
  let last = 0;
  let idx = 0;
  let m;
  while ((m = rx.exec(rawText))) {
    gapText.appendChild(document.createTextNode(rawText.slice(last, m.index)));
    idx += 1;
    const gap = document.createElement("span");
    gap.className = "gap-blank";
    gap.dataset.index = String(idx);
    gap.dataset.qid = `${dragId}_g${idx}`;
    gap.dataset.choiceValues = choiceValuesJson;
    gap.textContent = `(${idx})`;
    gapText.appendChild(gap);
    last = m.index + m[0].length;
  }
  gapText.appendChild(document.createTextNode(rawText.slice(last)));
  gapCard.appendChild(gapText);

  const bankTitle = document.createElement("div");
  bankTitle.className = "small";
  bankTitle.style.marginTop = "10px";
  bankTitle.textContent = "Word bank:";
  gapCard.appendChild(bankTitle);

  const bank = document.createElement("div");
  bank.className = "word-bank";
  bank.style.display = "flex";
  bank.style.flexWrap = "wrap";
  bank.style.gap = "8px";
  bank.style.marginTop = "8px";

  for (const word of bankWords) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "word-chip";
    chip.draggable = true;
    chip.dataset.word = word;
    chip.textContent = word;
    bank.appendChild(chip);
  }
  gapCard.appendChild(bank);

  const tip = document.createElement("div");
  tip.className = "small";
  tip.style.marginTop = "8px";
  tip.textContent = "Tip: drag words into gaps. Drag back to the word bank (or double-click a gap) to clear it.";
  gapCard.appendChild(tip);

  secEl.appendChild(gapCard);

  const gaps = [...gapCard.querySelectorAll(".gap-blank[data-qid]")];
  const chips = [...gapCard.querySelectorAll(".word-chip")];
  let draggedChip = null;

  const clearGap = (gap) => {
    const prevWord = String(gap.dataset.word || "");
    if (prevWord) {
      const prevChip = chips.find((ch) => String(ch.dataset.word || "") === prevWord);
      if (prevChip) prevChip.classList.remove("in-gap");
    }
    gap.textContent = `(${gap.dataset.index || ""})`;
    gap.dataset.word = "";
    gap.dataset.choiceIndex = "";
    gap.classList.remove("filled");
    gap.draggable = false;
  };

  const setDragImageFromChip = (e, chip) => {
    try {
      if (!e?.dataTransfer || !chip) return;
      const ghost = chip.cloneNode(true);
      ghost.style.position = "fixed";
      ghost.style.left = "-9999px";
      ghost.style.top = "-9999px";
      ghost.style.pointerEvents = "none";
      ghost.classList.add("dragging");
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 16, 16);
      setTimeout(() => { try { ghost.remove(); } catch {} }, 0);
    } catch {}
  };

  chips.forEach((chip) => {
    chip.addEventListener("dragstart", (e) => {
      draggedChip = chip;
      chip.classList.add("dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", String(chip.dataset.word || "")); } catch {}
      }
      setDragImageFromChip(e, chip);
    });
    chip.addEventListener("dragend", () => {
      draggedChip = null;
      chip.classList.remove("dragging");
    });
  });

  // Allow dragging a filled gap back to the word bank.
  gaps.forEach((gap) => {
    gap.addEventListener("dragstart", (e) => {
      const w = String(gap.dataset.word || "");
      if (!w) return;
      const chip = chips.find((ch) => String(ch.dataset.word || "") === w) || null;
      if (!chip) return;
      draggedChip = chip;
      chip.classList.add("dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", w); } catch {}
      }
      setDragImageFromChip(e, chip);
    });
    gap.addEventListener("dragend", () => {
      if (draggedChip) draggedChip.classList.remove("dragging");
      draggedChip = null;
    });
  });

  // Dropping on the bank removes the word from the sentence (returns it).
  bank.addEventListener("dragover", (e) => {
    e.preventDefault();
    bank.classList.add("bank-over");
  });
  bank.addEventListener("dragleave", () => bank.classList.remove("bank-over"));
  bank.addEventListener("drop", (e) => {
    e.preventDefault();
    bank.classList.remove("bank-over");
    if (!draggedChip) return;
    const w = String(draggedChip.dataset.word || "");
    const existingGap = gaps.find((g) => String(g.dataset.word || "") === w);
    if (existingGap) clearGap(existingGap);
  });

  gaps.forEach((gap) => {
    gap.addEventListener("dragover", (e) => {
      e.preventDefault();
      gap.classList.add("drag-over");
    });
    gap.addEventListener("dragleave", () => gap.classList.remove("drag-over"));
    gap.addEventListener("drop", (e) => {
      e.preventDefault();
      gap.classList.remove("drag-over");
      if (!draggedChip) return;

      const draggedWord = String(draggedChip.dataset.word || "");
      const existingGap = gaps.find((g) => String(g.dataset.word || "") === draggedWord);
      if (existingGap && existingGap !== gap) clearGap(existingGap);

      clearGap(gap);

      gap.textContent = draggedWord;
      gap.dataset.word = draggedWord;
      gap.dataset.choiceIndex = String(
        choiceIndexByWord.has(draggedWord.toLowerCase()) ? choiceIndexByWord.get(draggedWord.toLowerCase()) : ""
      );
      gap.classList.add("filled");
      gap.draggable = true;
      draggedChip.classList.add("in-gap");
    });
    gap.addEventListener("dblclick", () => clearGap(gap));
  });

  return { rendered: true, dragId };
}

function renderTest(payload) {
  elContent.innerHTML = "";
  sectionViews = [];
  currentSectionIdx = 0;

  const sections = Array.isArray(payload?.sections) ? payload.sections : [];

  for (let secIdx = 0; secIdx < sections.length; secIdx++) {
    const sec = sections[secIdx];
    const secKind = getSectionKind(sec);
    const secEl = document.createElement("div");
    secEl.className = "section";
    secEl.innerHTML = `<h2>${escapeHtml(sec.title || "Section")}</h2>`;

    if (sec.description) {
      const intro = document.createElement("div");
      intro.className = "small";
      intro.textContent = String(sec.description);
      secEl.appendChild(intro);
    }

    let writingDragId = "";

    if (secKind === "writing") {
      const writingItems = Array.isArray(sec.items) ? sec.items : [];
      const dragCfg = writingItems.find((it) => it && String(it.type || "") === "drag-words" && String(it.text || "").trim());
      if (dragCfg) {
        const out = renderDragWords({ secEl, cfg: dragCfg });
        if (out.rendered) writingDragId = out.dragId;
      }
    }

    // Listening: shared audio player (play once), then auto-advance.
    if (secKind === "listening") {
      const firstAudioItem = (sec.items || []).find((it) => it?.type === "listening-mcq" && it?.audioUrl);
      if (firstAudioItem?.audioUrl) {
        const audioWrap = document.createElement("div");
        audioWrap.className = "q";

        const audio = document.createElement("audio");
        audio.src = String(firstAudioItem.audioUrl);
        audio.preload = "auto";
        audio.controls = false;

        const controlsRow = document.createElement("div");
        controlsRow.style.display = "flex";
        controlsRow.style.alignItems = "center";
        controlsRow.style.gap = "10px";
        controlsRow.style.flexWrap = "wrap";

        const playBtn = document.createElement("button");
        playBtn.type = "button";
        playBtn.className = "primary";
        playBtn.textContent = "Play Listening";

        const skipBtn = document.createElement("button");
        skipBtn.type = "button";
        skipBtn.className = "primary";
        skipBtn.textContent = "Skip to end (preview)";

        const audioMsg = document.createElement("div");
        audioMsg.className = "small";
        audioMsg.textContent = "Press Play to start the listening section. It can be played once in preview.";

        let started = false;
        let ended = false;
        const lockAudio = () => {
          playBtn.disabled = true;
          playBtn.textContent = "Listening completed";
        };
        if (ended) lockAudio();

        playBtn.addEventListener("click", () => {
          if (ended) return;
          if (started) return;
          started = true;
          playBtn.disabled = true;
          playBtn.textContent = "Now playing";
          audioMsg.textContent = "Listening in progress...";
          audio.currentTime = 0;
          audio.play().catch(() => {
            started = false;
            playBtn.disabled = false;
            playBtn.textContent = "Play Listening";
            audioMsg.textContent = "Unable to play audio on this browser/device.";
          });
        });

        skipBtn.addEventListener("click", () => {
          const jumpToEnd = () => {
            const d = Number(audio.duration || 0);
            if (!Number.isFinite(d) || d <= 0) return;
            audio.currentTime = Math.max(0, d - 0.05);
            if (audio.paused) audio.play().catch(() => {});
          };
          if (!Number.isFinite(Number(audio.duration)) || Number(audio.duration) <= 0) {
            audio.addEventListener("loadedmetadata", jumpToEnd, { once: true });
            audio.load();
            return;
          }
          jumpToEnd();
        });

        audio.addEventListener("ended", () => {
          ended = true;
          lockAudio();
          audioMsg.textContent = "Listening complete. Moving to the next part...";
          setTimeout(() => showSection(currentSectionIdx + 1), 250);
        });

        controlsRow.appendChild(playBtn);
        controlsRow.appendChild(skipBtn);
        controlsRow.appendChild(audioMsg);
        audioWrap.appendChild(controlsRow);
        audioWrap.appendChild(audio);
        secEl.appendChild(audioWrap);
      }
    }

    for (const item of sec.items || []) {
      if (!item || !item.type || !item.id) continue;

      if (secKind === "writing") {
        const id = String(item.id || "");
        if (item.type === "drag-words") continue;
        if (writingDragId && (id === writingDragId || id.startsWith(`${writingDragId}_g`))) continue;
        if (id === "w_intro" || id === "w1" || id === "w2" || id === "w3" || id === "w4") continue;
      }

      if (item.type === "info") {
        const info = document.createElement("div");
        info.className = secKind === "reading" ? "q reading-passage" : "q";
        const raw = String(item.prompt || "");
        const p = document.createElement("div");
        p.className = "small";
        p.innerHTML = richTextHtml(raw);
        info.appendChild(p);
        secEl.appendChild(info);
        continue;
      }

      const q = document.createElement("div");
      q.className = "q";
      q.dataset.qid = item.id;

      const header = document.createElement("div");
      header.className = "q-title";
      header.textContent = item.prompt || "";
      q.appendChild(header);

      if (item.type === "mcq" || item.type === "listening-mcq") {
        (item.choices || []).forEach((c, idx) => {
          const row = document.createElement("label");
          row.className = "choice";
          row.innerHTML = `
            <input type="radio" name="${escapeHtml(item.id)}" value="${idx}">
            <div>${escapeHtml(c)}</div>
          `;
          q.appendChild(row);
        });
      } else if (item.type === "tf") {
        ["true", "false"].forEach((val) => {
          const row = document.createElement("label");
          row.className = "choice";
          row.innerHTML = `
            <input type="radio" name="${escapeHtml(item.id)}" value="${val}">
            <div>${val === "true" ? "True" : "False"}</div>
          `;
          q.appendChild(row);
        });
      } else {
        const ta = document.createElement("textarea");
        ta.name = item.id;
        ta.rows = item.type === "writing" ? 10 : 3;
        ta.placeholder = item.type === "writing" ? "Write your text here..." : "Type your answer...";
        q.appendChild(ta);
      }

      secEl.appendChild(q);
    }

    // Navigation
    const nav = document.createElement("div");
    nav.style.display = "flex";
    nav.style.justifyContent = "space-between";
    nav.style.gap = "10px";
    nav.style.marginTop = "12px";

    if (secIdx > 0 && secKind !== "listening") {
      const back = document.createElement("button");
      back.type = "button";
      back.className = "primary";
      back.textContent = "Back";
      back.addEventListener("click", () => showSection(currentSectionIdx - 1));
      nav.appendChild(back);
    } else {
      nav.appendChild(document.createElement("div"));
    }

    if (secIdx < sections.length - 1 && secKind !== "listening") {
      const next = document.createElement("button");
      next.type = "button";
      next.className = "primary";
      next.textContent = "Continue";
      next.addEventListener("click", () => showSection(currentSectionIdx + 1));
      nav.appendChild(next);
    } else {
      const done = document.createElement("button");
      done.type = "button";
      done.className = "primary";
      done.textContent = "Finish preview";
      done.addEventListener("click", () => {
        showStatus("Preview finished. Nothing was submitted or saved.", "ok");
        try { window.scrollTo(0, 0); } catch {}
      });
      nav.appendChild(done);
    }

    secEl.appendChild(nav);
    elContent.appendChild(secEl);
    sectionViews.push({ el: secEl, kind: secKind });
  }

  showSection(0);
}

async function main() {
  hideStatus();
  const examPeriodId = getExamPeriodId();

  elClose?.addEventListener("click", () => {
    try { window.close(); } catch {}
  });

  try {
    const r = await apiGet(`/api/admin/tests-bootstrap?examPeriodId=${encodeURIComponent(String(examPeriodId))}`);
    const eps = Array.isArray(r?.examPeriods) ? r.examPeriods : [];
    const ep = eps.find((p) => Number(p?.id || 0) === examPeriodId) || null;
    const epName = String(ep?.name || `Exam period ${examPeriodId}`);
    if (elEpName) elEpName.textContent = epName;
    if (elTitle) elTitle.textContent = `Test Preview — ${epName}`;

    // Re-apply the preview title using a real em dash (some environments saved a mojibake dash).
    if (elTitle) elTitle.textContent = `Test Preview — ${epName}`;

    const test = r?.test || null;
    if (!test || typeof test !== "object") throw new Error("Failed to load test payload.");

    renderTest(test);
    wireChoiceSelectedState();
  } catch (e) {
    showStatus(String(e?.message || e), "bad");
  }
}

main();
