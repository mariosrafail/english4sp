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

      if (secKind === "writing"){
        const writingItems = Array.isArray(sec.items) ? sec.items : [];
        let rendered = false;
        const dragCfg = writingItems.find((it)=> it && String(it.type || "") === "drag-words" && String(it.text || "").trim());
        if (dragCfg && /\*\*[^*]+?\*\*/.test(String(dragCfg.text || ""))){
          writingDragId = String(dragCfg.id || "drag1") || "drag1";
          const rawText = String(dragCfg.text || "");
          const rawExtras = String(dragCfg.extraWords || "");

          const gapWords = [];
          rawText.replace(/\*\*([^*]+?)\*\*/g, (_, w)=> { gapWords.push(String(w || "").trim()); return ""; });
          const extraWords = [];
          rawExtras.replace(/\*([^*]+?)\*/g, (_, w)=> { extraWords.push(String(w || "").trim()); return ""; });

          const uniq = (arr)=>{
            const out = [];
            const seen = new Set();
            for (const x of arr || []){
              const v = String(x || "").trim();
              if (!v) continue;
              const k = v.toLowerCase();
              if (seen.has(k)) continue;
              seen.add(k);
              out.push(v);
            }
            return out;
          };
          const bankWords = Array.isArray(dragCfg.bankWords) && dragCfg.bankWords.length
            ? uniq(dragCfg.bankWords)
            : uniq([...gapWords, ...extraWords]);

          const shuffled = (arr)=>{
            const a = (arr || []).slice();
            for (let i = a.length - 1; i > 0; i--){
              const j = Math.floor(Math.random() * (i + 1));
              const t = a[i]; a[i] = a[j]; a[j] = t;
            }
            return a;
          };

          if (gapWords.length && bankWords.length){
            const choiceIndexByWord = new Map(bankWords.map((w, i)=> [String(w).toLowerCase(), i]));

            const gapCard = document.createElement("div");
            gapCard.className = "q";

            const gapTitle = document.createElement("div");
            gapTitle.className = "q-title canvas-text-host";
            registerCanvasTextBlock(gapTitle, String(dragCfg.title || "Task 1: Drag the correct words into the gaps."), {
              minWidth: 220,
              closestSelector: ".q",
              widthMode: "container",
              canvasClassName: "question-text-canvas",
            });
            gapCard.appendChild(gapTitle);

            if (String(dragCfg.instructions || "").trim()){
              const inst = document.createElement("div");
              inst.className = "small canvas-text-host";
              inst.style.whiteSpace = "pre-wrap";
              inst.style.marginTop = "6px";
              registerCanvasTextBlock(inst, String(dragCfg.instructions || ""), {
                richText: true,
                minWidth: 220,
                closestSelector: ".q",
                widthMode: "container",
                canvasClassName: "instruction-text-canvas",
              });
              gapCard.appendChild(inst);
            }

            const gapText = document.createElement("div");
            gapText.style.lineHeight = "1.8";
            gapText.style.marginTop = "8px";
            gapText.style.whiteSpace = "pre-wrap";

            const choiceValuesJson = (()=>{
              try { return JSON.stringify(bankWords); } catch { return "[]"; }
            })();

            const rx = /\*\*([^*]+?)\*\*/g;
            let last = 0;
            let idx = 0;
            let m;
            while ((m = rx.exec(rawText))){
              appendCanvasInlineText(gapText, rawText.slice(last, m.index));
              idx += 1;
              const gap = document.createElement("span");
              gap.className = "gap-blank";
              gap.dataset.index = String(idx);
              gap.dataset.qid = `${writingDragId}_g${idx}`;
              gap.dataset.choiceValues = choiceValuesJson;
              gap.textContent = `(${idx})`;
              gapText.appendChild(gap);
              last = m.index + m[0].length;
            }
            appendCanvasInlineText(gapText, rawText.slice(last));
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

            const bankWordsDisplay = shuffled(bankWords);
            for (const word of bankWordsDisplay){
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
            registerCanvasTextBlock(tip, "Tip: double-click a gap to clear it.", {
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

            if (enableTapMode) {
              // Disable HTML5 drag on mobile; rely on tap-to-fill for reliability (iOS Safari).
              chips.forEach((chip)=> { try{ chip.draggable = false; }catch(e){} });
              gaps.forEach((gap)=> { try{ gap.draggable = false; }catch(e){} });
            }

            chips.forEach((chip)=>{
              try { chip.setAttribute("aria-pressed", "false"); } catch {}
              chip.addEventListener("dragstart", (e)=>{
                if (enableTapMode) return;
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
              if (enableTapMode) {
                chip.addEventListener("click", ()=> selectChip(chip));
                chip.addEventListener("keydown", (e)=>{
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  selectChip(chip);
                });
              }
            });

            // Allow dragging a filled gap back to the word bank.
            gaps.forEach((gap)=>{
              gap.addEventListener("dragstart", (e)=>{
                if (enableTapMode) return;
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
              if (enableTapMode) return;
              e.preventDefault();
              bank.classList.add("bank-over");
            });
            bank.addEventListener("dragleave", ()=> bank.classList.remove("bank-over"));
            bank.addEventListener("drop", (e)=>{
              if (enableTapMode) return;
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

              gaps.forEach((gap)=>{
                try{
                  gap.setAttribute("role", "button");
                  gap.setAttribute("tabindex", "0");
                  gap.setAttribute("aria-label", `Gap ${String(gap.dataset.index || "").trim() || ""}`.trim());
                } catch {}
              });

              gaps.forEach((gap)=>{
                const activate = ()=>{
                  if (selectedChip) {
                    placeWordInGap(gap, selectedChip);
                    clearSelectedChip();
                    saveAnswers();
                    return;
                  }
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

                placeWordInGap(gap, draggedChip);
                saveAnswers();
              });
              gap.addEventListener("dblclick", ()=>{
                clearGap(gap);
                saveAnswers();
              });
            });

            rendered = true;
          }
        }

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
      }

      // Listening section: one shared audio player (as in the original flow).
      if (secKind === "listening"){
        const firstAudioItem = (sec.items || []).find((it)=> it?.type === "listening-mcq");
        if (firstAudioItem){
          const maxPlays = (sec.rules && Number(sec.rules.audioPlaysAllowed)) || 1;
          const playKey = LS_KEY(`play_sec_${sec.id || "listening"}`);
          const endedKey = LS_KEY(`play_sec_${sec.id || "listening"}_ended`);
          const getPlayCount = ()=> Number(localStorage.getItem(playKey) || "0");
          const setPlayCount = (n)=> localStorage.setItem(playKey, String(Math.max(0, Number(n) || 0)));

          const audioWrap = document.createElement("div");
          audioWrap.className = "q";

          const audio = document.createElement("audio");
          audio.src = "";
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

          const audioMsg = document.createElement("div");
          audioMsg.className = "small";
          audioMsg.textContent = "Listening starts automatically. It can be played once.";

          let started = false;
          let noteAdded = false;
          const addLockedNote = ()=>{
            if (noteAdded) return;
            noteAdded = true;
            const note = document.createElement("div");
            note.className = "small";
            note.textContent = "Listening audio is locked.";
            audioWrap.appendChild(note);
          };
          const lockAudio = ()=>{
            playBtn.disabled = true;
            playBtn.textContent = "Listening completed";
            addLockedNote();
          };

          if (localStorage.getItem(endedKey) === "1" || getPlayCount() >= maxPlays){
            lockAudio();
          }

          const startListeningPlayback = async ()=>{
            const plays = getPlayCount();
            if (plays >= maxPlays){
              showStatus("Audio can only be played once.", "bad");
              lockAudio();
              return;
            }
            if (started) return;
            started = true;
            playBtn.disabled = true;
            playBtn.textContent = "Now playing";
            audioMsg.textContent = "Listening in progress...";
            try{
              const r = await fetch(`/api/session/${encodeURIComponent(token)}/listening-ticket`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              });
              const j = await r.json().catch(()=> ({}));
              if (!r.ok) throw new Error(String(j?.error || j?.message || `Listening unavailable (${r.status})`));
              const url = String(j?.url || "").trim();
              if (!url) throw new Error("Listening unavailable.");
              setPlayCount(plays + 1);
              audio.src = url;
              audio.currentTime = 0;
              await audio.play();
            }catch(e){
              started = false;
              playBtn.disabled = false;
              playBtn.textContent = "Play Listening";
              const msg = String(e?.message || "");
              if (msg.includes("listening_denied") || msg.includes("denied")) {
                audioMsg.textContent = "Listening audio is locked.";
                lockAudio();
              } else {
                audioMsg.textContent = msg || "Unable to play audio on this browser/device.";
              }
            }
          };

          playBtn.addEventListener("click", ()=>{
            void startListeningPlayback();
          });

          audio.addEventListener("ended", ()=>{
            localStorage.setItem(endedKey, "1");
            lockAudio();
            audioMsg.textContent = "Listening complete. Moving to the next part...";
            setTimeout(()=> showSection(getCurrentSectionIdx() + 1), 250);
          });

          controlsRow.appendChild(playBtn);
          controlsRow.appendChild(audioMsg);
          audioWrap.appendChild(controlsRow);
          audioWrap.appendChild(audio);
          secEl.appendChild(audioWrap);

          secEl._autoStartListening = ()=> {
            if (localStorage.getItem(endedKey) === "1") return;
            if (getPlayCount() >= maxPlays) return;
            void startListeningPlayback();
          };
        }
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

