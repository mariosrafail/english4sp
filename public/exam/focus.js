export function createExamFocusHelpers(ctx){
  const {
    LS_KEY,
    getExamStarted,
    getTabViolations,
    setTabViolations,
    MAX_TAB_VIOLATIONS,
    pingPresence,
    logSecurityEvent,
    scheduleReturnSnapshot,
    clearReturnSnapshotTimer,
    showTabToast,
    setAutoReason,
    doSubmit,
  } = ctx || {};

  let armed = false;
  let lastHiddenAt = 0;
  let lastBlurAt = 0;
  let lastViolationAt = 0;
  let mouseOutTimer = null;
  let lastPointerViolationAt = 0;
  const POINTER_LEAVE_TRIGGER_MS = 900;

  async function registerFocusViolation(reason, awayMs){
    if (!getExamStarted()) return;
    const now = Date.now();
    if (lastViolationAt && (now - lastViolationAt) < 600) return;
    lastViolationAt = now;

    const nextViolations = getTabViolations() + 1;
    setTabViolations(nextViolations);
    localStorage.setItem(LS_KEY("tabViolations"), String(nextViolations));
    try{ await pingPresence(reason || "focus_violation"); }catch(e){}
    scheduleReturnSnapshot(`return_after_${String(reason || "focus_violation")}`, 1000);

    showTabToast(
      "Do not switch tabs, windows, or apps during the exam.",
      `${awayMs ? `Away for ${Math.ceil(awayMs / 1000)}s. ` : ""}Violations: ${nextViolations}/${MAX_TAB_VIOLATIONS}`,
      3000
    );

    if (nextViolations >= MAX_TAB_VIOLATIONS){
      setAutoReason("tab_violations_max");
      await doSubmit(true);
    }
  }

  function clearMouseOutTimer(){
    if (mouseOutTimer){
      clearTimeout(mouseOutTimer);
      mouseOutTimer = null;
    }
  }

  function armFocusMonitoring(){
    if (armed) return;
    armed = true;

    document.addEventListener("visibilitychange", async ()=>{
      if (!getExamStarted()) return;
      if (document.hidden){
        clearReturnSnapshotTimer();
        lastHiddenAt = Date.now();
        await pingPresence("tab_hidden");
        if (logSecurityEvent) await logSecurityEvent("tab_hidden", { timestamp: lastHiddenAt });
      }else{
        const awayMs = lastHiddenAt ? (Date.now() - lastHiddenAt) : 0;
        lastHiddenAt = 0;
        await registerFocusViolation("tab_visible", awayMs);
      }
    });

    window.addEventListener("blur", async ()=>{
      if (!getExamStarted()) return;
      clearReturnSnapshotTimer();
      lastBlurAt = Date.now();
      // Window blur/focus is noisy on mobile and with OS UI such as virtual keyboards.
      // Keep it as a lightweight presence ping, but do not warn/log it as a writing security event.
      await pingPresence("window_blur");
    });

    window.addEventListener("focus", async ()=>{
      if (!getExamStarted()) return;
      const awayMs = lastBlurAt ? (Date.now() - lastBlurAt) : 0;
      lastBlurAt = 0;
      if (awayMs > 0 && !document.hidden){
        await pingPresence("window_focus_warning");
      }
    });

    document.addEventListener("mouseout", (e)=>{
      if (!getExamStarted()) return;
      if (e && (e.relatedTarget || e.toElement)) return;
      clearMouseOutTimer();
      mouseOutTimer = setTimeout(async ()=>{
        if (!getExamStarted()) return;
        const now = Date.now();
        if (lastPointerViolationAt && (now - lastPointerViolationAt) < 1500) return;
        lastPointerViolationAt = now;

        try{ await pingPresence("pointer_left"); }catch(e){}

        showTabToast(
          "Keep your mouse inside the exam window.",
          "If you are using a second monitor, disconnect it and continue on one display only.",
          3000
        );
      }, POINTER_LEAVE_TRIGGER_MS);
    });

    document.addEventListener("mouseover", ()=>{
      clearMouseOutTimer();
    });
  }

  return {
    armFocusMonitoring,
  };
}
