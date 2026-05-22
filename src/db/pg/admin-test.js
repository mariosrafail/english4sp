function createAdminTestHelpers(deps) {
  const { normalizeGradeWeights } = require("../../utils/grading_weights");
  const {
    getTestPayloadFull,
  } = deps || {};

  function getConfig(getProctoringConfig) {
    const p = typeof getProctoringConfig === "function" ? getProctoringConfig() : {};
    return {
      serverNow: Date.now(),
      proctoring: p,
    };
  }

  function normalizeAdminTest(test) {
    const p = test && typeof test === "object" ? test : {};
    const sectionsRaw = Array.isArray(p.sections) ? p.sections : [];
    const sections = sectionsRaw.slice(0, 8).map((sec, secIdx) => {
      const s = sec && typeof sec === "object" ? sec : {};
      const id = String(s.id || "").trim().slice(0, 40) || `sec_${secIdx + 1}`;
      const title = String(s.title || "").trim().slice(0, 120) || "Section";
      const description = String(s.description || "").trim().slice(0, 600);
      const rules = s.rules && typeof s.rules === "object" ? s.rules : null;
      const itemsRaw = Array.isArray(s.items) ? s.items : [];
      const items = itemsRaw.slice(0, 400).map((it, iIdx) => {
        const it0 = it && typeof it === "object" ? it : {};
        const type = String(it0.type || "").trim() || "mcq";
        const itemId = String(it0.id || "").trim().slice(0, 80) || `${id}_${iIdx + 1}`;
        const prompt = String(it0.prompt || "").trim().slice(0, 2500);
        const audioUrl = String(it0.audioUrl || "").trim().slice(0, 1200);
        const points = Number(it0.points ?? 1);
        const choicesRaw = Array.isArray(it0.choices) ? it0.choices : [];
        const choices = choicesRaw.slice(0, 12).map((c) => String(c || "").trim().slice(0, 240));
        const correctIndexRaw = Number(it0.correctIndex ?? 0);
        const correctIndex = Number.isFinite(correctIndexRaw)
          ? Math.max(0, Math.min(Math.floor(correctIndexRaw), Math.max(0, choices.length - 1)))
          : 0;

        if (type === "drag-words") {
          const title = String(it0.title || "").trim().slice(0, 180);
          const instructions = String(it0.instructions || "").trim().slice(0, 2000);
          const text = String(it0.text || "").trim().slice(0, 12000);
          const extraWords = String(it0.extraWords || "").trim().slice(0, 4000);
          const bankWordsRaw = Array.isArray(it0.bankWords) ? it0.bankWords : [];
          const bankWords = bankWordsRaw
            .slice(0, 40)
            .map((w) => String(w || "").trim().slice(0, 80))
            .filter(Boolean);
          const ppg = Number(it0.pointsPerGap ?? 1);
          const pointsPerGap = Number.isFinite(ppg) ? Math.max(0, Math.min(Math.round(ppg), 10)) : 1;
          return { id: itemId, type: "drag-words", title, instructions, text, extraWords, bankWords, pointsPerGap, points: 0 };
        }
        if (type === "info") return { id: itemId, type: "info", prompt, points: 0 };
        if (type === "writing") return { id: itemId, type: "writing", prompt, points: 0 };
        if (type === "tf") return { id: itemId, type: "tf", prompt, correct: !!it0.correct, points: Number.isFinite(points) ? Math.max(0, Math.min(points, 10)) : 1 };

        const out = {
          id: itemId,
          type: type === "listening-mcq" ? "listening-mcq" : "mcq",
          prompt,
          choices,
          correctIndex,
          points: Number.isFinite(points) ? Math.max(0, Math.min(points, 10)) : 1,
        };
        if (type === "listening-mcq" && audioUrl) out.audioUrl = audioUrl;
        return out;
      });
      return { id, title, description, rules, items };
    });

    return {
      version: Number(p.version || 1) || 1,
      randomize: !!p.randomize,
      gradeWeights: normalizeGradeWeights(p.gradeWeights),
      sections,
    };
  }

  function defaultAdminTestFromConfig() {
    return getTestPayloadFull();
  }

  function coerceLegacyAdminTestToPayload(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (Array.isArray(obj.sections)) return obj;
    if (!Array.isArray(obj.questions)) return null;

    const qs = obj.questions.slice(0, 200).map((q, idx) => {
      const qq = q && typeof q === "object" ? q : {};
      const id = String(qq.id || "").trim().slice(0, 80) || `r_${idx + 1}`;
      const prompt = String(qq.text || "").trim().slice(0, 800);
      const choicesRaw = Array.isArray(qq.choices) ? qq.choices : [];
      const choices = choicesRaw.slice(0, 6).map((c) => String(c || "").trim().slice(0, 240));
      const correctIndexRaw = Number(qq.correctIndex ?? 0);
      const correctIndex = Number.isFinite(correctIndexRaw)
        ? Math.max(0, Math.min(Math.floor(correctIndexRaw), Math.max(0, choices.length - 1)))
        : 0;
      return { id, type: "mcq", prompt, choices, correctIndex, points: 1 };
    });

    const base = defaultAdminTestFromConfig();
    const sections = Array.isArray(base.sections) ? base.sections.slice() : [];
    const reading = sections.find((s) => String(s.id || "").includes("read")) || sections[1] || null;
    if (reading && reading.items) reading.items = qs;
    else sections.push({ id: "reading", title: "Part 2: Reading", items: qs });
    return { ...base, sections };
  }

  function adminTestHasAnyRealItems(payload) {
    const p = payload && typeof payload === "object" ? payload : null;
    if (!p || !Array.isArray(p.sections)) return false;
    for (const sec of p.sections || []) {
      for (const item of sec?.items || []) {
        if (!item || !item.type) continue;
        if (item.type === "info") continue;
        if (item.type === "mcq" || item.type === "listening-mcq" || item.type === "tf" || item.type === "short") return true;
        if (item.type === "drag-words") {
          const t = String(item.text || "").trim();
          if (/\*\*[^*]+?\*\*/.test(t)) return true;
        }
      }
    }
    return false;
  }

  return {
    getConfig,
    normalizeAdminTest,
    defaultAdminTestFromConfig,
    coerceLegacyAdminTestToPayload,
    adminTestHasAnyRealItems,
  };
}

module.exports = {
  createAdminTestHelpers,
};
