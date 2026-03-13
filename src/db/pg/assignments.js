function createPgAssignmentHelpers(deps) {
  const { q, q1 } = deps;

  async function assignSessionsToLeastLoadedExaminers({ sessionIds, examPeriodId, client = null }) {
    const sids = Array.from(
      new Set((sessionIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))
    );
    const ep = Number(examPeriodId);
    if (!sids.length || !Number.isFinite(ep) || ep <= 0) return { assigned: 0 };

    const qf = (text, params = []) => (client ? client.query(text, params) : q(text, params));

    const ex = await qf(`SELECT id, username FROM public.examiners ORDER BY id ASC;`);
    if (!ex.rows.length) return { assigned: 0 };

    const existing = await qf(
      `SELECT session_id FROM public.examiner_assignments WHERE session_id = ANY($1::int[]);`,
      [sids]
    );
    const assignedSet = new Set(existing.rows.map((r) => Number(r.session_id)));
    const toAssign = sids.filter((sid) => !assignedSet.has(sid));
    if (!toAssign.length) return { assigned: 0 };

    const countsRes = await qf(
      `SELECT e.id AS examiner_id, COALESCE(c.cnt, 0) AS cnt
       FROM public.examiners e
       LEFT JOIN (
         SELECT a.examiner_id, COUNT(*)::int AS cnt
         FROM public.examiner_assignments a
         JOIN public.sessions s ON s.id = a.session_id
         WHERE s.exam_period_id = $1
         GROUP BY a.examiner_id
       ) c ON c.examiner_id = e.id
       ORDER BY e.id ASC;`,
      [ep]
    );

    const counts = new Map(countsRes.rows.map((r) => [Number(r.examiner_id), Number(r.cnt) || 0]));
    const examinerIds = ex.rows.map((r) => Number(r.id));
    let assigned = 0;

    for (const sid of toAssign.sort((a, b) => a - b)) {
      let pick = examinerIds[0];
      let min = counts.get(pick) ?? 0;
      for (const exid of examinerIds) {
        const c = counts.get(exid) ?? 0;
        if (c < min || (c === min && exid < pick)) {
          pick = exid;
          min = c;
        }
      }

      const ins = await qf(
        `INSERT INTO public.examiner_assignments (session_id, examiner_id, assigned_at_utc_ms)
         VALUES ($1, $2, $3)
         ON CONFLICT (session_id) DO NOTHING;`,
        [sid, pick, Date.now()]
      );
      const changed = Number(ins?.rowCount || 0);
      if (changed > 0) {
        assigned += 1;
        counts.set(pick, (counts.get(pick) || 0) + 1);
      }
    }

    return { assigned };
  }

  async function assignSessionsBalancedAcrossExaminers({ sessionIds, examPeriodId, client = null }) {
    const sids = Array.from(
      new Set((sessionIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))
    );
    const ep = Number(examPeriodId);
    if (!sids.length || !Number.isFinite(ep) || ep <= 0) return { assigned: 0 };

    const qf = (text, params = []) => (client ? client.query(text, params) : q(text, params));

    const ex = await qf(`SELECT id FROM public.examiners ORDER BY id ASC;`);
    const examinerIds = (ex.rows || []).map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
    if (!examinerIds.length) return { assigned: 0 };

    const existing = await qf(
      `SELECT session_id FROM public.examiner_assignments WHERE session_id = ANY($1::int[]);`,
      [sids]
    );
    const assignedSet = new Set((existing.rows || []).map((r) => Number(r.session_id)));
    const toAssign = sids.filter((sid) => !assignedSet.has(sid)).sort((a, b) => a - b);
    if (!toAssign.length) return { assigned: 0 };

    const order = [...examinerIds];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    let assigned = 0;
    for (let i = 0; i < toAssign.length; i++) {
      const sid = toAssign[i];
      const pick = order[i % order.length];
      const ins = await qf(
        `INSERT INTO public.examiner_assignments (session_id, examiner_id, assigned_at_utc_ms)
         VALUES ($1, $2, $3)
         ON CONFLICT (session_id) DO NOTHING;`,
        [sid, pick, Date.now()]
      );
      assigned += Number(ins?.rowCount || 0);
    }
    return { assigned };
  }

  async function assignSingleToLeastLoadedRandomTie({ sessionId, examPeriodId, client = null }) {
    const sid = Number(sessionId);
    const ep = Number(examPeriodId);
    if (!Number.isFinite(sid) || sid <= 0 || !Number.isFinite(ep) || ep <= 0) return { assigned: 0 };

    const qf = (text, params = []) => (client ? client.query(text, params) : q(text, params));

    const already = await qf(`SELECT 1 FROM public.examiner_assignments WHERE session_id = $1 LIMIT 1;`, [sid]);
    if (already.rows?.length) return { assigned: 0 };

    const countsRes = await qf(
      `SELECT e.id AS examiner_id, COALESCE(c.cnt, 0) AS cnt
       FROM public.examiners e
       LEFT JOIN (
         SELECT a.examiner_id, COUNT(*)::int AS cnt
         FROM public.examiner_assignments a
         JOIN public.sessions s ON s.id = a.session_id
         WHERE s.exam_period_id = $1
         GROUP BY a.examiner_id
       ) c ON c.examiner_id = e.id
       ORDER BY e.id ASC;`,
      [ep]
    );
    const rows = countsRes.rows || [];
    if (!rows.length) return { assigned: 0 };

    let min = Number(rows[0].cnt || 0);
    for (const r of rows) {
      const c = Number(r.cnt || 0);
      if (c < min) min = c;
    }
    const candidates = rows
      .filter((r) => Number(r.cnt || 0) === min)
      .map((r) => Number(r.examiner_id))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!candidates.length) return { assigned: 0 };

    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const ins = await qf(
      `INSERT INTO public.examiner_assignments (session_id, examiner_id, assigned_at_utc_ms)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id) DO NOTHING;`,
      [sid, pick, Date.now()]
    );
    return { assigned: Number(ins?.rowCount || 0) };
  }

  async function autoAssignUnassignedSessions() {
    const periods = await q(
      `SELECT DISTINCT exam_period_id
       FROM public.sessions
       WHERE exam_period_id IS NOT NULL
       ORDER BY exam_period_id ASC;`
    );
    for (const pr of periods.rows || []) {
      const ep = Number(pr.exam_period_id);
      if (!Number.isFinite(ep) || ep <= 0) continue;
      const un = await q(
        `SELECT s.id
         FROM public.sessions s
         LEFT JOIN public.examiner_assignments a ON a.session_id = s.id
         WHERE s.exam_period_id = $1
           AND a.session_id IS NULL
         ORDER BY s.id ASC
         LIMIT 50000;`,
        [ep]
      );
      const sids = (un.rows || []).map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
      if (sids.length) {
        await assignSessionsToLeastLoadedExaminers({ sessionIds: sids, examPeriodId: ep });
      }
    }
  }

  async function ensureSessionAssignedExaminer({ sessionId, examPeriodId } = {}) {
    const sid = Number(sessionId);
    if (!Number.isFinite(sid) || sid <= 0) return "";

    let ep = Number(examPeriodId);
    if (!Number.isFinite(ep) || ep <= 0) {
      const s = await q1(`SELECT exam_period_id FROM public.sessions WHERE id = $1 LIMIT 1;`, [sid]);
      ep = Number(s?.exam_period_id);
    }
    if (!Number.isFinite(ep) || ep <= 0) return "";

    await assignSingleToLeastLoadedRandomTie({ sessionId: sid, examPeriodId: ep });

    const row = await q1(
      `SELECT e.username
       FROM public.examiner_assignments a
       JOIN public.examiners e ON e.id = a.examiner_id
       WHERE a.session_id = $1
       LIMIT 1;`,
      [sid]
    );
    return String(row?.username || "");
  }

  return {
    assignSessionsToLeastLoadedExaminers,
    assignSessionsBalancedAcrossExaminers,
    assignSingleToLeastLoadedRandomTie,
    autoAssignUnassignedSessions,
    ensureSessionAssignedExaminer,
  };
}

module.exports = { createPgAssignmentHelpers };
