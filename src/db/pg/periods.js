function createPgPeriodsHelpers(deps) {
  const {
    q,
    q1,
    defaultOpenAtUtcMs,
    defaultDurationMinutes,
    normalizeAdminTest,
    defaultAdminTestFromConfig,
    coerceLegacyAdminTestToPayload,
    adminTestHasAnyRealItems,
  } = deps || {};

  async function getAdminTest(examPeriodId = 1) {
    const ep = Number(examPeriodId);
    const id = Number.isFinite(ep) && ep > 0 ? ep : 1;
    const row = await q1(
      `SELECT payload_json AS payload_json
       FROM public.admin_tests_by_period
       WHERE exam_period_id = $1
       LIMIT 1;`,
      [id]
    );
    if (!row || !row.payload_json) return defaultAdminTestFromConfig();
    const coerced = coerceLegacyAdminTestToPayload(row.payload_json) || row.payload_json;
    const norm = normalizeAdminTest(coerced);
    if (!adminTestHasAnyRealItems(norm)) return defaultAdminTestFromConfig();
    return norm;
  }

  async function setAdminTest(examPeriodId = 1, test) {
    const ep = Number(examPeriodId);
    const id = Number.isFinite(ep) && ep > 0 ? ep : 1;
    const payload = normalizeAdminTest(test);
    const now = Date.now();
    await q(
      `INSERT INTO public.admin_tests_by_period (exam_period_id, payload_json, updated_at_utc_ms)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (exam_period_id) DO UPDATE SET
         payload_json = EXCLUDED.payload_json,
         updated_at_utc_ms = EXCLUDED.updated_at_utc_ms;`,
      [id, JSON.stringify(payload || {}), now]
    );
    return { ok: true, updatedAtUtcMs: now };
  }

  async function listExamPeriods() {
    const r = await q(
      `SELECT id, name,
              COALESCE(open_at_utc_ms, $1) AS open_at_utc_ms,
              COALESCE(duration_minutes, $2) AS duration_minutes
       FROM public.exam_periods
       ORDER BY id ASC;`,
      [defaultOpenAtUtcMs, defaultDurationMinutes]
    );
    return r.rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      openAtUtc: Number(row.open_at_utc_ms),
      durationMinutes: Number(row.duration_minutes),
    }));
  }

  async function createExamPeriod({ id, name, openAtUtc, durationMinutes } = {}) {
    let newId = Number(id);
    if (!Number.isFinite(newId) || newId <= 0) {
      const r = await q(`SELECT COALESCE(MAX(id), 0) AS max_id FROM public.exam_periods;`);
      newId = Number(r.rows?.[0]?.max_id || 0) + 1;
    }
    const nm = String(name || `Exam Period ${newId}`).trim() || `Exam Period ${newId}`;
    const open = Number(openAtUtc);
    const dur = Math.round(Number(durationMinutes));
    const openVal = Number.isFinite(open) ? open : defaultOpenAtUtcMs;
    const durVal = Number.isFinite(dur) && dur > 0 ? dur : defaultDurationMinutes;

    await q(
      `INSERT INTO public.exam_periods (id, name, open_at_utc_ms, duration_minutes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING;`,
      [newId, nm, openVal, durVal]
    );
    return { id: newId };
  }

  async function updateExamPeriod({ id, name, openAtUtc, durationMinutes }) {
    const ep = Number(id);
    if (!Number.isFinite(ep) || ep <= 0) throw new Error("Invalid exam period id");
    const nm = String(name || "").trim();
    const open = Number(openAtUtc);
    const dur = Math.round(Number(durationMinutes));
    if (!Number.isFinite(open) || open < 0) throw new Error("Invalid open time");
    if (!Number.isFinite(dur) || dur <= 0) throw new Error("Invalid duration");

    await q(
      `UPDATE public.exam_periods
       SET name = COALESCE(NULLIF($2, ''), name),
           open_at_utc_ms = $3,
           duration_minutes = $4
       WHERE id = $1;`,
      [ep, nm, open, dur]
    );
    return { ok: true };
  }

  async function deleteExamPeriod(id) {
    const ep = Number(id);
    if (!Number.isFinite(ep) || ep <= 0) throw new Error("Invalid exam period id");
    await q(`DELETE FROM public.question_grades WHERE exam_period_id = $1;`, [ep]);
    await q(`DELETE FROM public.sessions WHERE exam_period_id = $1;`, [ep]);
    await q(`DELETE FROM public.exam_periods WHERE id = $1;`, [ep]);
    return { ok: true };
  }

  return {
    getAdminTest,
    setAdminTest,
    listExamPeriods,
    createExamPeriod,
    updateExamPeriod,
    deleteExamPeriod,
  };
}

module.exports = {
  createPgPeriodsHelpers,
};
