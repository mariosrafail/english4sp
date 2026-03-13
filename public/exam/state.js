function hash32(str){
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function makeRng(seed){
  let x = (seed >>> 0) || 1;
  return ()=>{
    x ^= (x << 13);
    x ^= (x >>> 17);
    x ^= (x << 5);
    return (x >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rng){
  for (let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

export function createExamStateHelpers(ctx){
  const {
    token,
    LS_KEY,
    elContent,
    qsa,
    collectAnswers,
    choiceOrderByQ,
    itemOrderBySection,
  } = ctx || {};

  function buildRandomizedPayload(payload){
    const out = JSON.parse(JSON.stringify(payload || {}));
    if (out && out.randomize === false){
      for (const sec of out.sections || []){
        for (const item of sec.items || []){
          if (item && Array.isArray(item.choices)){
            choiceOrderByQ.set(item.id, item.choices.map((_, i)=> i));
          }
        }
        itemOrderBySection.set(sec.id || sec.title || "section", (sec.items || []).map((x)=> x.id));
      }
      return out;
    }
    for (const sec of out.sections || []){
      const secSeed = hash32(`${token}|sec|${sec.id || sec.title || ""}`);
      const rng = makeRng(secSeed);
      const items = Array.isArray(sec.items) ? sec.items : [];
      shuffleInPlace(items, rng);
      itemOrderBySection.set(sec.id || sec.title || "section", items.map((x)=> x.id));

      for (const item of items){
        if (!item || !Array.isArray(item.choices) || item.choices.length < 2) continue;
        const qSeed = hash32(`${token}|q|${item.id}`);
        const qRng = makeRng(qSeed);
        const order = item.choices.map((_, i)=> i);
        shuffleInPlace(order, qRng);
        choiceOrderByQ.set(item.id, order.slice());
        item.choices = order.map((i)=> item.choices[i]);
      }
    }
    return out;
  }

  function saveAnswers(){
    try{
      const a = collectAnswers();
      localStorage.setItem(LS_KEY("answers"), JSON.stringify(a));
    } catch {}
  }

  function restoreAnswers(){
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_KEY("answers")) || "null"); } catch {}
    if (!saved || typeof saved !== "object") return;

    qsa("input[type=radio]").forEach((r)=>{
      const name = r.getAttribute("name");
      if (!name) return;
      if (!(name in saved)) return;

      const want = saved[name];
      if (want === "true" || want === "false"){
        r.checked = (r.value === want);
        return;
      }

      const order = choiceOrderByQ.get(name);
      if (!order){
        r.checked = (Number(r.value) === Number(want));
        return;
      }
      const shuffledIdx = order.indexOf(Number(want));
      r.checked = (Number(r.value) === shuffledIdx);
    });

    qsa(".q").forEach((q)=>{
      const choices = Array.from(q.querySelectorAll(".choice") || []);
      for (const c of choices){
        const i = c.querySelector("input[type=radio]");
        c.classList.toggle("selected", !!i && i.checked);
      }
    });

    qsa("textarea").forEach((t)=>{
      if (!t.name) return;
      if (typeof saved[t.name] === "string") t.value = saved[t.name];
    });

    qsa(".gap-blank[data-qid]").forEach((gap)=>{
      const qid = String(gap.dataset.qid || "");
      if (!qid || !(qid in saved)) return;

      const raw = saved[qid];
      const idx = Number(raw);
      const choicesRaw = String(gap.dataset.choiceValues || "");
      let choices = [];
      try { choices = JSON.parse(choicesRaw); } catch {}
      if (!Array.isArray(choices) || !Number.isFinite(idx) || idx < 0 || idx >= choices.length) return;

      const word = String(choices[idx] || "");
      if (!word) return;

      const section = gap.closest(".section") || document;
      const chips = [...section.querySelectorAll(".word-chip")];
      const chip = chips.find((ch)=> String(ch.dataset.word || "") === word);
      if (!chip) return;

      const prevGap = chips.length
        ? [...section.querySelectorAll(".gap-blank[data-qid]")].find((g)=> String(g.dataset.word || "") === word)
        : null;
      if (prevGap && prevGap !== gap){
        prevGap.textContent = `(${prevGap.dataset.index || ""})`;
        prevGap.dataset.word = "";
        prevGap.dataset.choiceIndex = "";
        prevGap.classList.remove("filled");
      }

      gap.textContent = word;
      gap.dataset.word = word;
      gap.dataset.choiceIndex = String(idx);
      gap.classList.add("filled");
      chip.classList.add("in-gap");
    });
  }

  function wireAutosave(){
    elContent.addEventListener("change", (e)=>{
      const t = e.target;
      if (!t) return;
      if (t.matches("input[type=radio]")){
        const q = t.closest(".q");
        if (q){
          qsa(".choice").forEach((c)=>{
            if (c.closest(".q") !== q) return;
            const i = c.querySelector("input[type=radio]");
            c.classList.toggle("selected", !!i && i.checked);
          });
        }
        saveAnswers();
        return;
      }
      if (t.matches("textarea")) saveAnswers();
    });
    elContent.addEventListener("input", (e)=>{
      const t = e.target;
      if (!t) return;
      if (t.matches("textarea")) saveAnswers();
    });
  }

  return {
    buildRandomizedPayload,
    saveAnswers,
    restoreAnswers,
    wireAutosave,
  };
}
