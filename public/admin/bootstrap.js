export function createAdminBootstrapHelpers(deps) {
  const {
    apiGet,
    apiPost,
    escapeHtml,
    uiConfirm,
    autoGenerateSpeakingSlots,
    renderSpeakingSlots,
    loadExamPeriods,
    getSelectedExamPeriodId,
    elReloadSpeakingSlots,
    elSpeakingSlotsOut,
    elDeleteAll,
    elDeleteAllOut,
    elOut,
    elCfgOut,
    elSingleCountry,
    countryCodes,
    state,
  } = deps;

  function setupCountryCodesList() {
    if (!elSingleCountry) return;
    let dn = null;
    try {
      dn = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {}
    const keep = `<option value="">Select country code</option>`;
    const opts = countryCodes.map((c) => {
      const country = dn ? String(dn.of(c) || c) : c;
      return `<option value="${c}">${c} (${escapeHtml(country)})</option>`;
    }).join("");
    elSingleCountry.innerHTML = keep + opts;
  }

  function wireSpeakingReload() {
    if (!elReloadSpeakingSlots) return;
    elReloadSpeakingSlots.addEventListener("click", async () => {
      try {
        elReloadSpeakingSlots.disabled = true;
        if (elSpeakingSlotsOut) elSpeakingSlotsOut.textContent = "Loading...";
        const ep = getSelectedExamPeriodId();
        let auto = null;
        let autoErr = "";
        try {
          auto = await autoGenerateSpeakingSlots(ep);
        } catch (e) {
          autoErr = String(e?.message || "auto-generate failed");
        }
        const rows = await apiGet(`/api/admin/speaking-slots?examPeriodId=${encodeURIComponent(ep)}&limit=2000`);
        state.speakingSlots = Array.isArray(rows) ? rows : [];
        renderSpeakingSlots();
        if (elSpeakingSlotsOut) {
          const created = Number(auto?.created || 0);
          const failed = Number(auto?.failed || 0);
          const note = created > 0 ? ` Auto-generated ${created} new slot(s).` : "";
          const failNote = failed > 0 ? ` ${failed} failed.` : "";
          const autoMsg = autoErr ? ` Auto-generate skipped: ${escapeHtml(autoErr)}.` : "";
          elSpeakingSlotsOut.innerHTML = `<span class="ok">Loaded ${state.speakingSlots.length} slot(s).${note}${failNote}${autoMsg}</span>`;
        }
      } catch (e) {
        if (elSpeakingSlotsOut) elSpeakingSlotsOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
      } finally {
        elReloadSpeakingSlots.disabled = false;
      }
    });
  }

  function wireDeleteAll() {
    if (!elDeleteAll) return;
    elDeleteAll.addEventListener("click", async () => {
      try {
        const ok = await uiConfirm(
          "Are you sure? This will permanently delete ALL data from question_grades, sessions, and candidates.",
          { title: "Delete All Data" }
        );
        if (!ok) return;

        elDeleteAll.disabled = true;
        if (elDeleteAllOut) elDeleteAllOut.innerHTML = "Deleting...";

        await apiPost("/api/admin/delete-all-data", {});

        if (elDeleteAllOut) elDeleteAllOut.innerHTML = `<span class="ok">Deleted.</span>`;
        if (elOut) elOut.innerHTML = "";
        if (elCfgOut) elCfgOut.innerHTML = "";
      } catch (e) {
        if (elDeleteAllOut) {
          elDeleteAllOut.innerHTML = `<span class="bad">Error: ${escapeHtml(e.message || String(e))}</span>`;
        }
      } finally {
        if (elDeleteAll) elDeleteAll.disabled = false;
      }
    });
  }

  function bootstrapAdmin() {
    setupCountryCodesList();
    wireSpeakingReload();
    wireDeleteAll();
    loadExamPeriods(1).catch((e) => {
      if (elCfgOut) {
        elCfgOut.innerHTML = `<span class="bad">Failed to load: ${escapeHtml(e.message || String(e))}</span>`;
      }
    });
  }

  return {
    setupCountryCodesList,
    wireSpeakingReload,
    wireDeleteAll,
    bootstrapAdmin,
  };
}
