export function createAdminSpeakingHelpers(deps) {
  const {
    apiGet,
    escapeHtml,
    getSelectedExamPeriodId,
    toDatetimeLocalValue,
    parseDatetimeLocalToMs,
    showAdminBusy,
    hideAdminBusy,
    elSpeakingSlotsBody,
    elSpeakingSlotsOut,
    state,
  } = deps;

  function renderSpeakingSlots() {
    if (!elSpeakingSlotsBody) return;
    const rows = Array.isArray(state.speakingSlots) ? state.speakingSlots : [];
    if (!rows.length) {
      elSpeakingSlotsBody.innerHTML = `<tr><td colspan="5" class="muted">No slots</td></tr>`;
      return;
    }

    elSpeakingSlotsBody.innerHTML = rows.map((r) => {
      const id = Number(r.id || 0);
      const candidate = escapeHtml(String(r.candidateName || ""));
      const examiner = escapeHtml(String(r.examinerUsername || ""));
      const gateUrlRaw = String(r.speakingUrl || "").trim() || (r.sessionToken
        ? `${location.origin}/speaking/?token=${encodeURIComponent(String(r.sessionToken || ""))}`
        : "");
      const gateUrl = escapeHtml(gateUrlRaw);
      const startValue = Number.isFinite(Number(r.startUtcMs)) ? toDatetimeLocalValue(Number(r.startUtcMs)) : "";

      return `
        <tr data-slot-id="${id}">
          <td>
            <div style="display:flex; gap:8px; align-items:center;">
              <input
                class="input mono speaking-start-input"
                data-slot-id="${id}"
                type="datetime-local"
                step="60"
                value="${escapeHtml(startValue)}"
                style="min-width:178px;"
              />
              <button class="btn speaking-time-save-btn" data-slot-id="${id}" type="button" style="width:auto; min-width:62px; padding:8px 10px;">Save</button>
            </div>
          </td>
          <td>${candidate}</td>
          <td>${examiner || "-"}</td>
          <td>${gateUrlRaw ? `<a href="${gateUrl}" target="_blank" rel="noopener" class="mono">Open</a>` : "-"}</td>
          <td>
            <button class="btn speaking-show-meeting-btn" data-slot-id="${id}" type="button" style="width:auto; min-width:92px;">Show</button>
          </td>
        </tr>
      `;
    }).join("");
  }

  async function autoGenerateSpeakingSlots(examPeriodId) {
    const ep = Number(examPeriodId);
    if (!Number.isFinite(ep) || ep <= 0) return { created: 0, skipped: 0 };
    showAdminBusy("Auto-generating speaking slots. Please wait...");
    try {
      const r = await fetch("/api/admin/speaking-slots/auto-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ examPeriodId: ep }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      return r.json();
    } finally {
      hideAdminBusy();
    }
  }

  async function loadSpeakingSlots() {
    if (!elSpeakingSlotsBody) return;
    const ep = getSelectedExamPeriodId();
    if (!Number.isFinite(ep) || ep <= 0) return;
    try {
      await autoGenerateSpeakingSlots(ep);
    } catch {}
    const rows = await apiGet(`/api/admin/speaking-slots?examPeriodId=${encodeURIComponent(ep)}&limit=2000`);
    state.speakingSlots = Array.isArray(rows) ? rows : [];
    renderSpeakingSlots();
  }

  async function saveSpeakingSlotDateTime(slotId) {
    const sid = Number(slotId);
    if (!Number.isFinite(sid) || sid <= 0) return;
    const startEl = document.querySelector(`input.speaking-start-input[data-slot-id="${sid}"]`);
    const startUtcMs = parseDatetimeLocalToMs(startEl?.value || "");
    if (!Number.isFinite(startUtcMs) || startUtcMs <= 0) throw new Error("Invalid date/time");
    const endUtcMs = startUtcMs + (60 * 60 * 1000);
    showAdminBusy("Saving speaking slot. Please wait...");
    try {
      const r = await fetch(`/api/admin/speaking-slots/${encodeURIComponent(sid)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ startUtcMs, endUtcMs }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const updated = await r.json();
      state.speakingSlots = (state.speakingSlots || []).map((x) => (Number(x.id) === sid ? updated : x));
      renderSpeakingSlots();
    } finally {
      hideAdminBusy();
    }
  }

  function wireSpeakingSlots() {
    if (!elSpeakingSlotsBody) return;
    elSpeakingSlotsBody.addEventListener("click", async (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;

      const saveBtn = target.closest(".speaking-time-save-btn");
      if (saveBtn) {
        const slotId = Number(saveBtn.getAttribute("data-slot-id") || 0);
        try {
          if (elSpeakingSlotsOut) elSpeakingSlotsOut.textContent = "Saving...";
          await saveSpeakingSlotDateTime(slotId);
          if (elSpeakingSlotsOut) elSpeakingSlotsOut.innerHTML = `<span class="ok">Slot ${slotId} updated.</span>`;
        } catch (err) {
          if (elSpeakingSlotsOut) elSpeakingSlotsOut.innerHTML = `<span class="bad">Error: ${escapeHtml(err.message || String(err))}</span>`;
        }
        return;
      }

      const showMeetingBtn = target.closest(".speaking-show-meeting-btn");
      if (showMeetingBtn) {
        const slotId = Number(showMeetingBtn.getAttribute("data-slot-id") || 0);
        const row = (state.speakingSlots || []).find((x) => Number(x.id) === slotId);
        const meetingUrl = String(row?.joinUrl || "").trim();
        if (!meetingUrl) {
          if (elSpeakingSlotsOut) elSpeakingSlotsOut.innerHTML = `<span class="bad">No meeting URL found for slot ${slotId}.</span>`;
          return;
        }
        try {
          await navigator.clipboard.writeText(meetingUrl);
          if (elSpeakingSlotsOut) {
            elSpeakingSlotsOut.innerHTML = `<span class="ok">Meeting URL copied for slot ${slotId}.</span><br><a class="mono" href="${escapeHtml(meetingUrl)}" target="_blank" rel="noopener">${escapeHtml(meetingUrl)}</a>`;
          }
        } catch {
          if (elSpeakingSlotsOut) {
            elSpeakingSlotsOut.innerHTML = `<span class="ok">Meeting URL for slot ${slotId}:</span><br><a class="mono" href="${escapeHtml(meetingUrl)}" target="_blank" rel="noopener">${escapeHtml(meetingUrl)}</a>`;
          }
        }
      }
    });
  }

  return {
    renderSpeakingSlots,
    autoGenerateSpeakingSlots,
    loadSpeakingSlots,
    saveSpeakingSlotDateTime,
    wireSpeakingSlots,
  };
}
