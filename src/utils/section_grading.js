const { normalizeGradeWeights } = require("./grading_weights");

function norm(value) {
  return String(value ?? "").trim().toLowerCase();
}

function gradeObjectiveItem({ item, answers, answerToText }) {
  if (!item || !item.id) return null;
  const type = String(item.type || "");
  if (!(type === "mcq" || type === "listening-mcq" || type === "tf" || type === "short")) return null;

  const pts = Number(item.points || 0);
  if (pts <= 0) return null;

  let expected = "";
  if (type === "mcq" || type === "listening-mcq") expected = answerToText(item, item.correctIndex);
  else if (type === "tf") expected = answerToText(item, item.correct);
  else if (type === "short") expected = answerToText(item, item.correctText);
  if (!expected) return null;

  const got = answers?.[item.id];
  return {
    earned: norm(got) === norm(expected) ? pts : 0,
    max: pts,
  };
}

function calculateWeightedGrade({ payload, answers, answerToText, speakingGrade, writingGrade }) {
  const p = payload && typeof payload === "object" ? payload : {};
  const weights = normalizeGradeWeights(p.gradeWeights);
  const ansObj = answers && typeof answers === "object" ? answers : {};

  const sections = new Map();
  for (const sec of p.sections || []) {
    const id = String(sec?.id || "").trim().toLowerCase();
    if (!id) continue;
    sections.set(id, sec);
  }

  function objectiveSectionPercent(sectionId) {
    const sec = sections.get(sectionId);
    let earned = 0;
    let max = 0;
    for (const item of sec?.items || []) {
      const g = gradeObjectiveItem({ item, answers: ansObj, answerToText });
      if (!g) continue;
      earned += g.earned;
      max += g.max;
    }
    return { earned, max, percent: max > 0 ? (earned / max) * 100 : 0 };
  }

  function writingSectionPercent() {
    const sec = sections.get("writing");
    let earned = 0;
    let max = 0;
    let manualMax = 0;

    for (const item of sec?.items || []) {
      const type = String(item?.type || "");
      if (type === "writing") {
        manualMax += 1;
        continue;
      }
      const g = gradeObjectiveItem({ item, answers: ansObj, answerToText });
      if (!g) continue;
      earned += g.earned;
      max += g.max;
    }

    if (manualMax > 0) {
      const wr = Number(writingGrade);
      const wrPercent = Number.isFinite(wr) ? Math.max(0, Math.min(100, wr)) : 0;
      earned += (wrPercent / 100) * manualMax;
      max += manualMax;
    } else if (max <= 0) {
      const wr = Number(writingGrade);
      return {
        earned: Number.isFinite(wr) ? Math.max(0, Math.min(100, wr)) : 0,
        max: 100,
        percent: Number.isFinite(wr) ? Math.max(0, Math.min(100, wr)) : 0,
        manualMax,
      };
    }

    return { earned, max, percent: max > 0 ? (earned / max) * 100 : 0, manualMax };
  }

  const listening = objectiveSectionPercent("listening");
  const reading = objectiveSectionPercent("reading");
  const writing = writingSectionPercent();
  const sp = Number(speakingGrade);
  const speakingPercent = Number.isFinite(sp) ? Math.max(0, Math.min(100, sp)) : 0;

  const totalRaw =
    (listening.percent * weights.listening / 100) +
    (reading.percent * weights.reading / 100) +
    (writing.percent * weights.writing / 100) +
    (speakingPercent * weights.speaking / 100);

  return {
    weights,
    listening,
    reading,
    writing,
    speakingPercent,
    totalGrade: Math.round(totalRaw),
  };
}

module.exports = { calculateWeightedGrade };
