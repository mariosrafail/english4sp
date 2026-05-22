export function createExamLockdownHelpers(ctx){
  const {
    qs,
    qsa,
    LS_KEY,
    getExamStarted,
    getAntiResetArmed,
    setAntiResetArmed,
    getTabViolations,
    setTabViolations,
    MAX_TAB_VIOLATIONS,
    getAutoReason,
    setAutoReason,
    pingPresence,
    captureAndUploadSnapshot,
    saveAnswers,
    doSubmit,
  } = ctx || {};

  let lockOverlay = null;
  let lockMsgEl = null;
  let lockDetailEl = null;
  let lockBtnEl = null;
  let lockMinUntil = 0;
  let lockBtnMode = "dismiss";

  let tabToastEl = null;
  let tabToastTimer = null;
  let orientationGraceUntil = 0;
  let orientationGraceTimer = null;

  const fullscreenRequired = (()=> {
    const ua = String(navigator.userAgent || "");
    const mobileUa = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    const ipadDesktopUa = /Macintosh/i.test(ua) && Number(navigator.maxTouchPoints || 0) > 1;
    let coarse = false;
    try { coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches); } catch {}

    const screenW = Number(screen.width || window.innerWidth || 0);
    const screenH = Number(screen.height || window.innerHeight || 0);
    const shortEdge = Math.min(screenW || 0, screenH || 0);
    const mobileLikeTouch = coarse && Number(navigator.maxTouchPoints || 0) > 0 && shortEdge > 0 && shortEdge <= 900;

    return !(mobileUa || ipadDesktopUa || mobileLikeTouch);
  })();

  const isFullscreen = ()=>{
    const apiFs = !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement
    );
    if (apiFs) return true;

    const tol = 10;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const sw1 = screen.width || window.outerWidth || w;
    const sh1 = screen.height || window.outerHeight || h;
    const sw2 = screen.availWidth || sw1;
    const sh2 = screen.availHeight || sh1;

    const wOk = (Math.abs(w - sw1) <= tol) || (Math.abs(w - sw2) <= tol);
    const hOk = (Math.abs(h - sh1) <= tol) || (Math.abs(h - sh2) <= tol);
    return wOk && hOk;
  };

  async function requestFullscreen(){
    const el = document.documentElement;
    try{
      if (el.requestFullscreen) return await el.requestFullscreen();
      if (el.webkitRequestFullscreen) return await el.webkitRequestFullscreen();
      if (el.mozRequestFullScreen) return await el.mozRequestFullScreen();
      if (el.msRequestFullscreen) return await el.msRequestFullscreen();
    } catch {}
  }

  async function exitFullscreen(){
    try{
      if (document.exitFullscreen) return await document.exitFullscreen();
      if (document.webkitExitFullscreen) return await document.webkitExitFullscreen();
      if (document.mozCancelFullScreen) return await document.mozCancelFullScreen();
      if (document.msExitFullscreen) return await document.msExitFullscreen();
    } catch {}
  }

  function hasExtendedDisplay(){
    try { return screen && screen.isExtended === true; } catch {}
    return false;
  }

  function markOrientationOrResizeGrace(){
    // Mobile/tablet browsers can emit transient resize/fullscreen changes while
    // rotating the device or while camera orientation settles. Re-check after a
    // short grace period instead of treating the flicker as a fullscreen exit.
    orientationGraceUntil = Math.max(orientationGraceUntil, Date.now() + 3000);
    if (orientationGraceTimer) clearTimeout(orientationGraceTimer);
    orientationGraceTimer = setTimeout(()=> {
      orientationGraceTimer = null;
    }, 3100);
  }

  function isFullscreenGraceActive(){
    return Date.now() < orientationGraceUntil;
  }

  function setLockButton(mode, label){
    lockBtnMode = mode || "dismiss";
    if (!lockBtnEl) return;
    lockBtnEl.textContent = label || (lockBtnMode === "fullscreen" ? "Enter fullscreen mode" : "Return to exam");
  }

  async function onLockBtnClick(){
    if (lockBtnMode === "fullscreen"){
      await requestFullscreen();
      if (isFullscreen()) hideLock(true);
      return;
    }
    hideLock();
  }

  function ensureLockOverlay(){
    if (lockOverlay) return;
    lockOverlay = document.createElement("div");
    lockOverlay.className = "lockOverlay";
    lockOverlay.innerHTML = `
      <div class="lockCard">
        <div class="lockTitle">Attention required</div>
        <div class="lockMsg" id="lockMsg"></div>
        <div class="lockDetail small" id="lockDetail"></div>
        <div style="margin-top:12px">
          <button class="primary" id="lockBtn" type="button">Return to exam</button>
        </div>
      </div>
    `;
    document.body.appendChild(lockOverlay);
    lockMsgEl = lockOverlay.querySelector("#lockMsg");
    lockDetailEl = lockOverlay.querySelector("#lockDetail");
    lockBtnEl = lockOverlay.querySelector("#lockBtn");
    lockBtnEl.addEventListener("click", ()=> { void onLockBtnClick(); });
    setLockButton("dismiss", "Return to exam");
  }

  function showLock(msg, detail, opts){
    ensureLockOverlay();
    lockMsgEl.textContent = msg || "";
    lockDetailEl.textContent = detail || "";
    if (opts && (opts.buttonMode || opts.buttonLabel)){
      setLockButton(opts.buttonMode || "dismiss", opts.buttonLabel);
    } else {
      setLockButton("dismiss", "Return to exam");
    }
    if (opts && typeof opts.minMs === "number" && opts.minMs > 0){
      lockMinUntil = Math.max(lockMinUntil, Date.now() + opts.minMs);
    }
    lockOverlay.classList.add("show");
  }

  function hideLock(force){
    if (!lockOverlay) return;
    if (!force){
      const now = Date.now();
      if (lockMinUntil && now < lockMinUntil){
        const wait = Math.min(2000, lockMinUntil - now);
        setTimeout(()=> hideLock(true), wait);
        return;
      }
    }
    lockOverlay.classList.remove("show");
    setLockButton("dismiss", "Return to exam");
  }

  function ensureTabToast(){
    if (tabToastEl) return;
    tabToastEl = document.createElement("div");
    tabToastEl.className = "toast tabToast";
    tabToastEl.innerHTML = `<div class="toastTitle" id="tabToastTitle"></div><div class="toastBody" id="tabToastBody"></div>`;
    document.body.appendChild(tabToastEl);
  }

  function showTabToast(title, body, ms){
    ensureTabToast();
    const t = tabToastEl.querySelector("#tabToastTitle");
    const b = tabToastEl.querySelector("#tabToastBody");
    if (t) t.textContent = title || "";
    if (b) b.textContent = body || "";
    tabToastEl.classList.add("show");
    if (tabToastTimer) clearTimeout(tabToastTimer);
    tabToastTimer = setTimeout(()=>{
      try { tabToastEl.classList.remove("show"); } catch {}
    }, Math.max(500, Number(ms || 3000)));
  }

  function armAntiResetAndTabLock(){
    if (getAntiResetArmed()) return;
    setAntiResetArmed(true);

    try{
      history.pushState({ exam:true }, "", location.href);
    } catch {}

    window.addEventListener("popstate", async ()=>{
      if (!getExamStarted()) return;
      try { history.pushState({ exam:true }, "", location.href); } catch {}
      const nextViolations = getTabViolations() + 1;
      setTabViolations(nextViolations);
      localStorage.setItem(LS_KEY("tabViolations"), String(nextViolations));
      await pingPresence("nav_back_blocked");
      void captureAndUploadSnapshot("nav_back_blocked");
      showTabToast(
        "Back navigation is disabled during the exam.",
        `Violations: ${nextViolations}/${MAX_TAB_VIOLATIONS}`,
        3000
      );
      if (nextViolations >= MAX_TAB_VIOLATIONS){
        setAutoReason("tab_violations_max");
        await doSubmit(true);
      }
    });

    window.addEventListener("beforeunload", (e)=>{
      if (!getExamStarted()) return;
      if (typeof saveAnswers === "function") saveAnswers();
      e.preventDefault();
      e.returnValue = "";
      return "";
    });
  }

  window.addEventListener("orientationchange", markOrientationOrResizeGrace);
  window.addEventListener("resize", markOrientationOrResizeGrace);

  return {
    fullscreenRequired,
    isFullscreen,
    requestFullscreen,
    exitFullscreen,
    hasExtendedDisplay,
    isFullscreenGraceActive,
    showLock,
    hideLock,
    showTabToast,
    armAntiResetAndTabLock,
  };
}
