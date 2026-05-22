const DEFAULT_GRADE_WEIGHTS = Object.freeze({
  listening: 20,
  reading: 20,
  writing: 20,
  speaking: 40,
});

const GRADE_WEIGHT_KEYS = Object.freeze(["listening", "reading", "writing", "speaking"]);

function clampWeight(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.round(n);
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

function normalizeGradeWeights(input, opts = {}) {
  const src = input && typeof input === "object" ? input : {};
  const out = {};
  for (const key of GRADE_WEIGHT_KEYS) {
    out[key] = clampWeight(src[key], DEFAULT_GRADE_WEIGHTS[key]);
  }

  const total = gradeWeightsTotal(out);
  if (opts.requireTotal === true && total !== 100) {
    throw new Error("Grade weights must add up to 100");
  }
  return out;
}

function gradeWeightsTotal(weights) {
  const src = weights && typeof weights === "object" ? weights : {};
  return GRADE_WEIGHT_KEYS.reduce((sum, key) => sum + (Number(src[key]) || 0), 0);
}

function gradeWeightsAreValid(weights) {
  const total = gradeWeightsTotal(weights);
  return total === 100 && GRADE_WEIGHT_KEYS.every((key) => {
    const n = Number(weights?.[key]);
    return Number.isInteger(n) && n >= 0 && n <= 100;
  });
}

module.exports = {
  DEFAULT_GRADE_WEIGHTS,
  GRADE_WEIGHT_KEYS,
  normalizeGradeWeights,
  gradeWeightsTotal,
  gradeWeightsAreValid,
};
