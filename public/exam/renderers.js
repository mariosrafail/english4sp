import { renderWritingSection } from "/exam/renderers-writing.js";
import { renderListeningSection } from "/exam/renderers-listening.js";
export function renderExamTest(payload, ctx){
  const {
    token,
    LS_KEY,
    elContent,
    showStatus,
    hardenNoTranslateTree,
    registerCanvasTextBlock,
    clearCanvasTextBlocks,
    queueCanvasTextRender,
    getSectionKind,
    showSection,
    saveAnswers,
    restoreAnswers,
    resetSectionViews,
    appendSectionView,
    getCurrentSectionIdx,
  } = ctx || {};

    const appendCanvasInlineText = (parent, raw, { richText = false } = {})=>{
      const text = String(raw || "");
      if (!text) return;
      const host = document.createElement("span");
      host.className = "canvas-text-host canvas-inline-host";
      registerCanvasTextBlock(host, text, {
        richText,
        minWidth: 1,
        widthMode: "natural",
        canvasClassName: "inline-text-canvas",
      });
      parent.appendChild(host);
    };

    elContent.innerHTML = "";
    hardenNoTranslateTree(elContent);
    clearCanvasTextBlocks();
    resetSectionViews();

    const sections = Array.isArray(payload.sections) ? payload.sections : [];
    for (let secIdx = 0; secIdx < sections.length; secIdx++){
      const sec = sections[secIdx];
      const secKind = getSectionKind(sec);
      let writingDragId = "";
      const secEl = document.createElement("div");
      secEl.className = "section";
      const secTitleEl = document.createElement("h2");
      secTitleEl.className = "canvas-text-host";
      registerCanvasTextBlock(secTitleEl, String(sec.title || "Section"), {
        minWidth: 220,
        closestSelector: ".section",
        widthMode: "natural",
        canvasClassName: "section-text-canvas",
      });
      secEl.appendChild(secTitleEl);
      if (sec.description){
        const intro = document.createElement("div");
        intro.className = "small canvas-text-host";
        registerCanvasTextBlock(intro, String(sec.description), {
          richText: true,
          minWidth: 220,
          closestSelector: ".section",
          widthMode: "container",
          canvasClassName: "instruction-text-canvas",
        });
        secEl.appendChild(intro);
      }

      const writingResult = secKind === "writing"
        ? renderWritingSection(sec, secEl, {
            registerCanvasTextBlock,
            appendCanvasInlineText,
            saveAnswers,
          })
        : null;
      if (writingResult?.writingDragId) writingDragId = writingResult.writingDragId;

      if (secKind === "listening"){
        renderListeningSection(sec, secEl, {
          token,
          LS_KEY,
          showStatus,
          showSection,
          getCurrentSectionIdx,
        });
      }

      for (const item of sec.items || []){
        if (secKind === "writing"){
          const id = String(item?.id || "");
          if (item?.type === "drag-words") continue;
          if (writingDragId && (id === writingDragId || id.startsWith(`${writingDragId}_g`))) continue;
          if (id === "w_intro" || id === "w1" || id === "w2" || id === "w3" || id === "w4") continue;
        }
        if (item.type === "info"){
          const info = document.createElement("div");
          info.className = secKind === "reading" ? "q reading-passage" : "q";
          const raw = String(item.prompt || "");
          const p = document.createElement("div");
          p.className = "small canvas-text-host";
          registerCanvasTextBlock(p, raw, {
            richText: true,
            minWidth: secKind === "reading" ? 240 : 220,
            closestSelector: secKind === "reading" ? ".reading-passage" : ".q",
            widthMode: "container",
            canvasClassName: secKind === "reading" ? "reading-canvas" : "instruction-text-canvas",
          });
          info.appendChild(p);
          secEl.appendChild(info);
          continue;
        }

        const q = document.createElement("div");
        q.className = "q";
        q.dataset.qid = item.id;

        const header = document.createElement("div");
        header.className = "q-title canvas-text-host";
        registerCanvasTextBlock(header, String(item.prompt || ""), {
          minWidth: 220,
          closestSelector: ".q",
          canvasClassName: "question-text-canvas",
        });
        if (item.type === "writing"){
          header.style.whiteSpace = "pre-wrap";
          header.style.lineHeight = "1.5";
        }
        q.appendChild(header);

        if (item.type === "mcq" || item.type === "listening-mcq"){
          (item.choices || []).forEach((c, idx)=>{
            const row = document.createElement("label");
            row.className = "choice";
            const input = document.createElement("input");
            input.type = "radio";
            input.name = item.id;
            input.value = String(idx);
            const labelText = document.createElement("div");
            labelText.className = "canvas-text-host";
            registerCanvasTextBlock(labelText, String(c || ""), {
              minWidth: 120,
              closestSelector: ".choice",
              canvasClassName: "choice-text-canvas",
            });
            row.appendChild(input);
            row.appendChild(labelText);
            q.appendChild(row);
          });

        } else if (item.type === "tf"){
          ["true","false"].forEach((val)=>{
            const row = document.createElement("label");
            row.className = "choice";
            const input = document.createElement("input");
            input.type = "radio";
            input.name = item.id;
            input.value = val;
            const labelText = document.createElement("div");
            labelText.className = "canvas-text-host";
            registerCanvasTextBlock(labelText, val === "true" ? "True" : "False", {
              minWidth: 120,
              closestSelector: ".choice",
              canvasClassName: "choice-text-canvas",
            });
            row.appendChild(input);
            row.appendChild(labelText);
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

      // Section navigation (listening auto-advances on audio ended).
      const nav = document.createElement("div");
      nav.style.display = "flex";
      nav.style.justifyContent = "space-between";
      nav.style.gap = "10px";
      nav.style.marginTop = "12px";
      let hasBack = false;
      let hasNext = false;

      if (secIdx > 0 && secKind !== "listening" && secKind !== "reading"){
        const back = document.createElement("button");
        back.type = "button";
        back.className = "primary";
        back.textContent = "Back";
        back.addEventListener("click", ()=> showSection(getCurrentSectionIdx() - 1));
        nav.appendChild(back);
        hasBack = true;
      } else {
        const spacer = document.createElement("div");
        nav.appendChild(spacer);
      }

      if (secIdx < sections.length - 1 && secKind !== "listening"){
        const next = document.createElement("button");
        next.type = "button";
        next.className = "primary";
        next.textContent = "Continue";
        next.addEventListener("click", ()=> showSection(getCurrentSectionIdx() + 1));
        nav.appendChild(next);
        hasNext = true;
      }

      if (hasBack || hasNext) secEl.appendChild(nav);
      hardenNoTranslateTree(secEl);
      elContent.appendChild(secEl);
      appendSectionView({ el: secEl, kind: secKind, autoStart: secEl._autoStartListening });
    }
    queueCanvasTextRender();

    // Re-apply any saved answers after rendering
    restoreAnswers();
    const savedIdx = Number(localStorage.getItem(LS_KEY("sectionIdx")) || "0");
    showSection(Number.isFinite(savedIdx) ? savedIdx : 0);
  }

