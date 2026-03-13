export function createAdminExamPeriodHelpers(deps) {
  const {
    apiGet,
    apiPost,
    escapeHtml,
    uiPrompt,
    uiConfirm,
    fmtAthensStamp,
    parseDatetimeLocalToMs,
    toDatetimeLocalValue,
    buildSelect,
    getSelectedExamPeriodId,
    getPeriodById,
    showAdminBusy,
    hideAdminBusy,
    loadSpeakingSlots,
    elExamPeriodTop,
    elCreate,
    elRename,
    elDuplicate,
    elDelete,
    elOpenDT,
    elOpenUtcPreview,
    elDurMin,
    elSave,
    elCfgOut,
    elServerNow,
    elWindowLine,
    elSpeakingSlotsBody,
    state,
  } = deps;

  function updateOpenPreview() {
    const ms = parseDatetimeLocalToMs(elOpenDT.value);
    elOpenUtcPreview.textContent = ms == null ? "-" : fmtAthensStamp(ms);
  }

  function renderSelectedPeriod() {
    const id = getSelectedExamPeriodId();
    const p = getPeriodById(id);
    if (!p) return;

    elOpenDT.value = toDatetimeLocalValue(p.openAtUtc);
    updateOpenPreview();
    elDurMin.value = String(p.durationMinutes || 60);

    const endAt = Number(p.openAtUtc) + Number(p.durationMinutes) * 60 * 1000;
    elWindowLine.textContent = `${fmtAthensStamp(p.openAtUtc)}  to  ${fmtAthensStamp(endAt)}`;
  }

  async function loadExamPeriods(selectedId) {
    const cfg = await apiGet("/api/config");
    elServerNow.textContent = fmtAthensStamp(cfg.serverNow);

    state.periods = await apiGet("/api/admin/exam-periods");
    if (!Array.isArray(state.periods) || !state.periods.length) {
      state.periods = [{ id: 1, name: "Default", openAtUtc: Date.now(), durationMinutes: 60 }];
    }

    const pick = Number(selectedId) || Number(state.periods[0].id) || 1;
    buildSelect(elExamPeriodTop, state.periods, pick);
    elExamPeriodTop.value = String(pick);
    renderSelectedPeriod();
    if (elSpeakingSlotsBody) await loadSpeakingSlots().catch(() => {});
  }

  function wireExamPeriods() {
    elOpenDT.addEventListener("input", updateOpenPreview);

    elExamPeriodTop.addEventListener("change", () => {
      renderSelectedPeriod();
      if (elSpeakingSlotsBody) loadSpeakingSlots().catch(() => {});
    });

    elCreate.addEventListener("click", async () => {
      try {
        elCreate.disabled = true;
        elCfgOut.innerHTML = "";

        const nameRaw = await uiPrompt("Enter exam period name.", "", { title: "Create Exam Period" });
        if (nameRaw === null) return;

        const name = nameRaw && String(nameRaw).trim() ? String(nameRaw).trim() : undefined;
        const out = await apiPost("/api/admin/exam-periods", { name });

        await loadExamPeriods(out?.id || getSelectedExamPeriodId());
        elCfgOut.innerHTML = `<span class="ok">Created.</span>`;
      } catch (e) {
        elCfgOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
      } finally {
        elCreate.disabled = false;
      }
    });

    elRename.addEventListener("click", async () => {
      try {
        elRename.disabled = true;
        elCfgOut.innerHTML = "";

        const id = getSelectedExamPeriodId();
        const p = getPeriodById(id);
        const currentName = String(p?.name || "").trim() || `Exam period ${id}`;

        const nextRaw = await uiPrompt("Enter new exam period name.", currentName, { title: "Rename Exam Period" });
        if (nextRaw === null) return;
        const nextName = String(nextRaw || "").trim();
        if (!nextName) throw new Error("Name is required");

        const openMsFromPeriod = Number(p?.openAtUtc);
        const durFromPeriod = Number(p?.durationMinutes);
        const openMs = Number.isFinite(openMsFromPeriod) ? openMsFromPeriod : parseDatetimeLocalToMs(elOpenDT.value);
        const durMinutes = Number.isFinite(durFromPeriod) && durFromPeriod > 0 ? Math.round(durFromPeriod) : Math.round(Number(elDurMin.value || 0));
        if (openMs === null || !Number.isFinite(Number(openMs))) throw new Error("Invalid open date/time");
        if (!Number.isFinite(durMinutes) || durMinutes <= 0) throw new Error("Invalid duration");

        const r = await fetch(`/api/admin/exam-periods/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: nextName, openAtUtc: Number(openMs), durationMinutes: durMinutes }),
          credentials: "same-origin",
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${r.status}`);
        }

        await loadExamPeriods(id);
        elCfgOut.innerHTML = `<span class="ok">Renamed.</span>`;
      } catch (e) {
        elCfgOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
      } finally {
        elRename.disabled = false;
      }
    });

    elDuplicate.addEventListener("click", async () => {
      let createdId = null;
      try {
        elDuplicate.disabled = true;
        elCfgOut.innerHTML = "";

        const srcId = getSelectedExamPeriodId();
        const src = getPeriodById(srcId);
        const srcLabel = String(src?.name || "").trim() || `Exam period ${srcId}`;

        const defaultName = `${srcLabel} (copy)`;
        const nextRaw = await uiPrompt("Enter new exam period name.", defaultName, { title: "Duplicate Exam Period" });
        if (nextRaw === null) return;
        const nextName = String(nextRaw || "").trim();
        if (!nextName) throw new Error("Name is required");

        const now = Date.now();
        const openSrc = Number(src?.openAtUtc);
        const durSrc = Number(src?.durationMinutes);
        const openAtUtc = Number.isFinite(openSrc) && openSrc > 0 ? Math.max(openSrc, now + 60 * 60 * 1000) : undefined;
        const durationMinutes = Number.isFinite(durSrc) && durSrc > 0 ? Math.round(durSrc) : undefined;

        const created = await apiPost("/api/admin/exam-periods", {
          name: nextName,
          ...(openAtUtc === undefined ? {} : { openAtUtc }),
          ...(durationMinutes === undefined ? {} : { durationMinutes }),
        });
        createdId = Number(created?.id || 0);
        if (!Number.isFinite(createdId) || createdId <= 0) throw new Error("Duplicate failed (missing new exam period id)");

        const srcTestResp = await apiGet(`/api/admin/tests?examPeriodId=${encodeURIComponent(String(srcId))}`, { busy: false }).catch(() => null);
        const srcTest = srcTestResp?.test || srcTestResp?.payload || null;
        if (srcTest && typeof srcTest === "object") {
          await apiPost(`/api/admin/tests?examPeriodId=${encodeURIComponent(String(createdId))}`, { test: srcTest }, { busy: false });
        }

        await loadExamPeriods(createdId);
        elCfgOut.innerHTML = `<span class="ok">Duplicated.</span>`;
      } catch (e) {
        if (createdId && Number.isFinite(Number(createdId))) {
          try {
            await fetch(`/api/admin/exam-periods/${encodeURIComponent(String(createdId))}`, { method: "DELETE", credentials: "same-origin" });
          } catch {}
        }
        elCfgOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
      } finally {
        elDuplicate.disabled = false;
      }
    });

    elDelete.addEventListener("click", async () => {
      let didBusy = false;
      let shouldReload = false;
      try {
        elDelete.disabled = true;
        elCfgOut.innerHTML = "";

        const id = getSelectedExamPeriodId();
        const p = getPeriodById(id);
        const label = String(p?.name || "").trim() || `Exam period ${id}`;
        const ok = await uiConfirm(`Delete "${label}" (ID ${id}) and all its sessions?`, { title: "Delete Exam Period", yesText: "Delete", noText: "Cancel", danger: true });
        if (!ok) return;

        showAdminBusy("Deleting exam period. Please wait...");
        didBusy = true;
        const r = await fetch(`/api/admin/exam-periods/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "same-origin",
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${r.status}`);
        }

        elCfgOut.innerHTML = `<span class="ok">Deleted.</span>`;
        shouldReload = true;
      } catch (e) {
        elCfgOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
      } finally {
        try { if (didBusy) hideAdminBusy(); } catch {}
        elDelete.disabled = false;
        if (shouldReload) {
          setTimeout(() => {
            try { location.reload(); } catch {}
          }, 50);
        }
      }
    });

    elSave.addEventListener("click", async () => {
      let didBusy = false;
      try {
        elSave.disabled = true;
        elCfgOut.innerHTML = "";

        const id = getSelectedExamPeriodId();
        const p = getPeriodById(id);
        const name = String(p?.name || "").trim();

        const openMs = parseDatetimeLocalToMs(elOpenDT.value);
        if (openMs === null) throw new Error("Invalid open date/time");

        const durMinutes = Number(elDurMin.value || 0);
        if (!Number.isFinite(durMinutes) || durMinutes <= 0) throw new Error("Invalid duration");

        showAdminBusy("Saving exam period. Please wait...");
        didBusy = true;
        const r = await fetch(`/api/admin/exam-periods/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, openAtUtc: openMs, durationMinutes: Math.round(durMinutes) }),
          credentials: "same-origin",
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${r.status}`);
        }

        await loadExamPeriods(id);
        elCfgOut.innerHTML = `<span class="ok">Saved.</span>`;
      } catch (e) {
        elCfgOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
      } finally {
        try { if (didBusy) hideAdminBusy(); } catch {}
        elSave.disabled = false;
      }
    });
  }

  return {
    updateOpenPreview,
    renderSelectedPeriod,
    loadExamPeriods,
    wireExamPeriods,
  };
}
