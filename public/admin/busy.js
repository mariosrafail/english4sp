export function createAdminBusyHelpers(deps) {
  const {
    elAdminBusyOverlay,
    elAdminBusyText,
    elAdminBusyBarFill,
    elAdminBusyPct,
    state,
  } = deps;

  function showAdminBusy(message) {
    state.busyCount += 1;
    if (elAdminBusyText) {
      elAdminBusyText.textContent = String(message || "Processing. Don't close this page. Please wait...");
    }
    setAdminBusyProgress(null, null);
    if (elAdminBusyOverlay) elAdminBusyOverlay.style.display = "flex";
  }

  function hideAdminBusy() {
    state.busyCount = Math.max(0, state.busyCount - 1);
    if (state.busyCount === 0 && elAdminBusyOverlay) {
      elAdminBusyOverlay.style.display = "none";
    }
  }

  function setAdminBusyText(message) {
    if (elAdminBusyText) {
      elAdminBusyText.textContent = String(message || "Processing. Don't close this page. Please wait...");
    }
  }

  function fmtEtaSeconds(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  function setAdminBusyProgress(pct, etaSeconds) {
    if (!elAdminBusyBarFill && !elAdminBusyPct) return;
    if (pct === null || pct === undefined) {
      try { if (elAdminBusyBarFill) elAdminBusyBarFill.style.width = "0%"; } catch {}
      try { if (elAdminBusyPct) elAdminBusyPct.textContent = ""; } catch {}
      return;
    }
    const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    try { if (elAdminBusyBarFill) elAdminBusyBarFill.style.width = `${v}%`; } catch {}
    if (elAdminBusyPct) {
      const eta = Number.isFinite(Number(etaSeconds)) && Number(etaSeconds) > 0 ? ` | ETA ${fmtEtaSeconds(etaSeconds)}` : "";
      elAdminBusyPct.textContent = `${v}%${eta}`;
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  return {
    showAdminBusy,
    hideAdminBusy,
    setAdminBusyText,
    setAdminBusyProgress,
    delay,
  };
}
