function toAnswerText(item, raw) {
  if (!item) return "";
  if (item.type === "mcq" || item.type === "listening-mcq") {
    const idx = Number(raw);
    if (!Number.isFinite(idx) || idx < 0) return "";
    const max = Array.isArray(item.choices) ? item.choices.length : Infinity;
    if (idx >= max) return "";
    return String.fromCharCode("a".charCodeAt(0) + idx);
  }
  if (item.type === "tf") {
    if (raw === "" || raw === null || raw === undefined) return "";
    const v = raw === true || raw === "true" || raw === "True" || raw === 1 || raw === "1";
    return v ? "true" : "false";
  }
  if (item.type === "short") return String(raw ?? "").trim();
  return "";
}

function parseAnswersJson(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const x = JSON.parse(String(raw));
    return x && typeof x === "object" ? x : {};
  } catch {
    return {};
  }
}

function buildReviewItems(payload, answersObj) {
  const items = [];
  let objectiveEarned = 0;
  let objectiveMax = 0;
  const sectionIdNorm = (sec) => String(sec?.id || "").trim().toLowerCase();
  for (const sec of payload.sections || []) {
    const sidNorm = sectionIdNorm(sec);
    const inObjectiveSection = sidNorm === "listening" || sidNorm === "reading" || sidNorm === "writing";
    let writingTask1Active = true;
    for (const item of sec.items || []) {
      if (!item || !item.id || item.type === "info" || item.type === "drag-words") continue;

      let countsInObjective = false;
      if (inObjectiveSection) {
        if (sidNorm !== "writing") {
          countsInObjective = true;
        } else {
          if (item.type === "writing") writingTask1Active = false;
          countsInObjective = writingTask1Active;
        }
      }

      const pts = Number(item.points || 0);
      const expected = toAnswerText(
        item,
        item.type === "short" ? item.correctText : (item.type === "tf" ? item.correct : item.correctIndex)
      );
      const got = String(answersObj[item.id] ?? "").trim();
      const autoScorable = pts > 0 && !!expected;
      const isCorrect = autoScorable ? (got.toLowerCase() === expected.toLowerCase()) : null;
      const earned = autoScorable ? (isCorrect ? pts : 0) : null;
      if (autoScorable && countsInObjective) {
        objectiveEarned += Number(earned || 0);
        objectiveMax += pts;
      }
      items.push({
        id: item.id,
        section: String(sec.title || sec.id || "Section"),
        prompt: String(item.prompt || ""),
        candidateAnswer: got,
        correctAnswer: expected,
        points: pts,
        earned,
        isCorrect,
      });
    }
  }
  return { items, objectiveEarned, objectiveMax };
}

module.exports = { toAnswerText, parseAnswersJson, buildReviewItems };

