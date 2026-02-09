import { qs, qsa, apiGet, apiPost, fmtTime, escapeHtml, nowMs } from "/app.js";

  const params = new URLSearchParams(location.search);
  const token = (params.get("token") || "").trim();

  const elTitle = qs("#title");
  const elExamFlowText = qs("#examFlowText");
  const elCandidate = qs("#candidate");
  const elTimer = qs("#timer");
  const elContent = qs("#content");
  const elSubmit = qs("#submit");
  const elStatus = qs("#status");

  const elGate = qs("#gate");
  const elEnableCam = qs("#enableCam");
  const elGoFullscreen = qs("#goFullscreen");
  const elStartExam = qs("#startExam");
  const elGateNotice = qs("#gateNotice");
  const elVideo = qs("#video");
  const elFaceOverlay = qs("#faceOverlay");
  const elFaceHint = qs("#faceHint");
  const elCamSelect = qs("#camSelect");
  const elRefreshCams = qs("#refreshCams");

  // Mini camera preview (during exam)
  const elCamMini = qs("#camMini");
  const elVideoMini = qs("#videoMini");
  const elCamMiniDot = qs("#camMiniDot");
  const elCamMiniText = qs("#camMiniText");
  const elFsBtnMini = qs("#fsBtnMini");

  const LS_KEY = (k)=> `exam_${token}_${k}`;

  function fmtLocalStamp(ms){
    const d = new Date(Number(ms));
    const fmt = new Intl.DateTimeFormat("en-GB", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    });
    return fmt.format(d);
  }

  function showStatus(text, cls){
    elStatus.style.display = "block";
    elStatus.textContent = text;
    elStatus.className = "notice " + (cls || "");
  }
  function showGateNotice(text, cls){
    elGateNotice.textContent = text;
    elGateNotice.className = "notice " + (cls || "");
  }

  function showFinalScreen(disqualified){
    examStarted = false;

    try{ if (timerId) clearInterval(timerId); }catch(e){}
    try{ exitFullscreen(); }catch(e){}

    // Hide all exam UI
    try{ qsa(".hr").forEach((h)=> h.style.display = "none"); }catch(e){}
    try{ elGate.style.display = "none"; }catch(e){}
    try{ elContent.style.display = "none"; }catch(e){}
    try{ elSubmit.style.display = "none"; }catch(e){}
    try{ if (elCamMini) elCamMini.style.display = "none"; }catch(e){}
    try{ const top = qs(".topbar"); if (top) top.style.display = "none"; }catch(e){}

    elStatus.style.display = "block";
    elStatus.className = "notice final " + (disqualified ? "bad" : "ok");

    if (disqualified){
      elTitle.textContent = "DISQUALIFIED";
      elStatus.textContent = "DISQUALIFIED. Your exam was cancelled due to a rule violation.";
    } else {
      elTitle.textContent = "Submitted";
      elStatus.textContent = "Your answers were submitted successfully. Please wait for your results soon.";
    }
  }

  if (!token){
    elTitle.textContent = "Missing token";
    showStatus("Open this page with ?token=XXXX", "bad");
    throw new Error("Missing token");
  }

  let sessionData = null;
  let endAt = null;
  let timerId = null;
  let timerAutoSubmit = false;

  let stream = null;
  let presenceInterval = null;

  // Security / proctoring state
  let examStarted = false;
  let antiResetArmed = false;
  let tabViolations = Number(localStorage.getItem(LS_KEY("tabViolations")) || "0");
  // Face violations must be scoped to the current attempt only.
  // Persisting across refreshes can cause premature disqualification.
  let faceViolations = 0;
  const MAX_TAB_VIOLATIONS = 3;
  const FACE_MISSING_AUTO_SUBMIT_MS = 10000;
  const FULLSCREEN_MISSING_AUTO_SUBMIT_MS = 10000;

  // Prevent double-submit (auto submit + manual submit, or multiple proctor triggers).
  let submitInFlight = false;

  // Randomization maps
  const choiceOrderByQ = new Map(); // qid -> [originalIndex,...] in shown order
  const itemOrderBySection = new Map(); // sectionId -> [qid,...] in shown order
  let randomizedPayload = null;
  let sectionViews = []; // [{el, kind}]
  let currentSectionIdx = 0;

  function getSectionKind(sec){
    const id = String(sec?.id || "").toLowerCase();
    const title = String(sec?.title || "").toLowerCase();
    if (id.includes("listen") || title.includes("listen")) return "listening";
    if (id.includes("read") || title.includes("read")) return "reading";
    if (id.includes("writ") || title.includes("writ")) return "writing";
    return "other";
  }

  function setSubmitVisibility(){
    if (!elSubmit) return;
    const last = Math.max(0, sectionViews.length - 1);
    elSubmit.style.display = currentSectionIdx >= last ? "block" : "none";
  }

  function showSection(index){
    if (!sectionViews.length) return;
    const clamped = Math.max(0, Math.min(Number(index) || 0, sectionViews.length - 1));
    currentSectionIdx = clamped;
    sectionViews.forEach((v, i)=>{
      v.el.style.display = i === clamped ? "block" : "none";
    });
    try { localStorage.setItem(LS_KEY("sectionIdx"), String(clamped)); } catch(e){}
    setSubmitVisibility();
    try { window.scrollTo(0, 0); } catch(e){}
  }

  // UI lock overlay (used for tab switches / camera missing)
  let lockOverlay = null;
  let lockMsgEl = null;
  let lockDetailEl = null;
  let lockBtnEl = null;
  let lockMinUntil = 0;
  let lockBtnMode = "dismiss"; // dismiss | fullscreen

  async function onLockBtnClick(){
    if (lockBtnMode === "fullscreen"){
      await requestFullscreen();
      // If fullscreen is back, immediately return to the test.
      if (isFullscreen()) hideLock(true);
      return;
    }
    hideLock();
  }

  function setLockButton(mode, label){
    lockBtnMode = mode || "dismiss";
    if (!lockBtnEl) return;
    lockBtnEl.textContent = label || (lockBtnMode === "fullscreen" ? "Enter fullscreen mode" : "Return to exam");
  }

  let faceOkSince = 0;
  let stopFaceLoop = null;
  let preferredCameraId = "";
  const PREF_CAM_KEY = "exam_preferred_camera";

  // Fullscreen requirement (block start until enabled)
  // Candidates can toggle fullscreen either via the Fullscreen API (Esc exits),
  // or via browser fullscreen (F11). The latter does not set document.fullscreenElement,
  // so we also detect it via viewport vs screen size.
  const isFullscreen = ()=>{
    const apiFs = !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement
    );
    if (apiFs) return true;

    // Heuristic for F11 fullscreen: viewport approximately equals screen size.
    // Use a small tolerance to account for device pixel ratios and OS UI.
    // Tolerance must be generous because F11 fullscreen can differ by a few px
    // depending on OS UI, zoom, and device pixel ratio.
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
    }catch(e){}
  }
  async function exitFullscreen(){
    try{
      if (document.exitFullscreen) return await document.exitFullscreen();
      if (document.webkitExitFullscreen) return await document.webkitExitFullscreen();
      if (document.mozCancelFullScreen) return await document.mozCancelFullScreen();
      if (document.msExitFullscreen) return await document.msExitFullscreen();
    }catch(e){}
  }

  async function pingPresence(status){
    try { await apiPost(`/api/session/${encodeURIComponent(token)}/presence`, { status }); } catch(e){}
  }

  function readPreferredCameraId(){
    try { return String(localStorage.getItem(PREF_CAM_KEY) || "").trim(); } catch { return ""; }
  }
  function writePreferredCameraId(id){
    try {
      const v = String(id || "").trim();
      if (v) localStorage.setItem(PREF_CAM_KEY, v);
      else localStorage.removeItem(PREF_CAM_KEY);
    } catch {}
  }

  async function listVideoInputs(keepSelection){
    if (!navigator.mediaDevices?.enumerateDevices || !elCamSelect) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    const vids = (devices || []).filter((d)=> d.kind === "videoinput");

    const prev = keepSelection ? String(elCamSelect.value || preferredCameraId || "") : String(preferredCameraId || "");
    const opts = [`<option value="">Default camera</option>`];
    vids.forEach((d, i)=>{
      const label = String(d.label || "").trim() || `Camera ${i + 1}`;
      opts.push(`<option value="${escapeHtml(String(d.deviceId || ""))}">${escapeHtml(label)}</option>`);
    });
    elCamSelect.innerHTML = opts.join("");

    if (prev && vids.some((d)=> String(d.deviceId) === prev)) {
      elCamSelect.value = prev;
    } else {
      elCamSelect.value = "";
    }
    preferredCameraId = String(elCamSelect.value || "");
    return vids;
  }

  function loadScript(url){
    return new Promise((resolve, reject)=>{
      const s = document.createElement("script");
      s.src = url;
      s.async = true;
      s.onload = ()=> resolve(true);
      s.onerror = ()=> reject(new Error("Failed to load: " + url));
      document.head.appendChild(s);
    });
  }

  // -------- Randomization (deterministic per token) --------
  function hash32(str){
    // FNV-1a 32-bit
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++){
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  function makeRng(seed){
    // xorshift32
    let x = (seed >>> 0) || 1;
    return ()=>{
      x ^= (x << 13);
      x ^= (x >>> 17);
      x ^= (x << 5);
      return (x >>> 0) / 4294967296;
    };
  }
  function shuffleInPlace(arr, rng){
    for (let i = arr.length - 1; i > 0; i--){
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  function buildRandomizedPayload(payload){
    const out = JSON.parse(JSON.stringify(payload || {}));
    if (out && out.randomize === false){
      // Keep author-defined order when randomization is disabled.
      for (const sec of out.sections || []){
        for (const item of sec.items || []){
          if (item && Array.isArray(item.choices)){
            choiceOrderByQ.set(item.id, item.choices.map((_, i)=>i));
          }
        }
        itemOrderBySection.set(sec.id || sec.title || "section", (sec.items || []).map(x=>x.id));
      }
      return out;
    }
    for (const sec of out.sections || []){
      const secSeed = hash32(`${token}|sec|${sec.id || sec.title || ""}`);
      const rng = makeRng(secSeed);

      // Shuffle items (questions) order
      const items = Array.isArray(sec.items) ? sec.items : [];
      const ids = items.map(x=>x.id);
      shuffleInPlace(items, rng);
      itemOrderBySection.set(sec.id || sec.title || "section", items.map(x=>x.id));

      // Shuffle choices per mcq
      for (const item of items){
        if (!item || !Array.isArray(item.choices) || item.choices.length < 2) continue;
        const qSeed = hash32(`${token}|q|${item.id}`);
        const qRng = makeRng(qSeed);

        const order = item.choices.map((_, i)=>i);
        shuffleInPlace(order, qRng);
        choiceOrderByQ.set(item.id, order.slice());

        item.choices = order.map(i => item.choices[i]);
      }
    }
    return out;
  }

  // -------- Answer persistence (prevents refresh reset) --------
  function saveAnswers(){
    try{
      const a = collectAnswers();
      localStorage.setItem(LS_KEY("answers"), JSON.stringify(a));
    }catch(e){}
  }

  function restoreAnswers(){
    let saved = null;
    try{ saved = JSON.parse(localStorage.getItem(LS_KEY("answers")) || "null"); }catch(e){}
    if (!saved || typeof saved !== "object") return;

    // Radios
    qsa("input[type=radio]").forEach((r)=>{
      const name = r.getAttribute("name");
      if (!name) return;
      if (!(name in saved)) return;

      const want = saved[name];
      if (want === "true" || want === "false"){
        r.checked = (r.value === want);
        return;
      }

      // MCQ: saved is originalIndex; UI value is shuffledIndex
      const order = choiceOrderByQ.get(name);
      if (!order){
        r.checked = (Number(r.value) === Number(want));
        return;
      }
      const shuffledIdx = order.indexOf(Number(want));
      r.checked = (Number(r.value) === shuffledIdx);
    });

    // Textareas
    qsa("textarea").forEach((t)=>{
      if (!t.name) return;
      if (typeof saved[t.name] === "string") t.value = saved[t.name];
    });

    // Writing drag-and-drop gaps (w1..w4)
    qsa(".gap-blank[data-qid]").forEach((gap)=>{
      const qid = String(gap.dataset.qid || "");
      if (!qid || !(qid in saved)) return;

      const raw = saved[qid];
      const idx = Number(raw);
      const choicesRaw = String(gap.dataset.choiceValues || "");
      let choices = [];
      try { choices = JSON.parse(choicesRaw); } catch {}
      if (!Array.isArray(choices) || !Number.isFinite(idx) || idx < 0 || idx >= choices.length) return;

      const word = String(choices[idx] || "");
      if (!word) return;

      const section = gap.closest(".section") || document;
      const chips = [...section.querySelectorAll(".word-chip")];
      const chip = chips.find((ch)=> String(ch.dataset.word || "") === word);
      if (!chip) return;

      // If this chip is currently used elsewhere, clear that gap first.
      const prevGap = chips.length
        ? [...section.querySelectorAll(".gap-blank[data-qid]")]
            .find((g)=> String(g.dataset.word || "") === word)
        : null;
      if (prevGap && prevGap !== gap){
        prevGap.textContent = `(${prevGap.dataset.index || ""})`;
        prevGap.dataset.word = "";
        prevGap.dataset.choiceIndex = "";
        prevGap.classList.remove("filled");
      }

      gap.textContent = word;
      gap.dataset.word = word;
      gap.dataset.choiceIndex = String(idx);
      gap.classList.add("filled");
      chip.classList.add("in-gap");
    });
  }

  function wireAutosave(){
    elContent.addEventListener("change", (e)=>{
      const t = e.target;
      if (!t) return;
      if (t.matches("input[type=radio]")){
        // Toggle selected state for nicer UX
        const q = t.closest(".q");
        if (q){
          qsa(".choice").forEach((c)=>{
            // scope by question
            if (c.closest(".q") !== q) return;
            const i = c.querySelector("input[type=radio]");
            c.classList.toggle("selected", !!i && i.checked);
          });
        }
        saveAnswers();
        return;
      }
      if (t.matches("textarea")) saveAnswers();
    });
    elContent.addEventListener("input", (e)=>{
      const t = e.target;
      if (!t) return;
      if (t.matches("textarea")) saveAnswers();
    });
  }

  // -------- UI Lock Overlay --------
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
    lockBtnEl.addEventListener("click", ()=> { onLockBtnClick(); });
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
    // Reset button state when lock is hidden.
    setLockButton("dismiss", "Return to exam");
  }

  // -------- Tab violation toast (separate from fullscreen/camera lock) --------
  let tabToastEl = null;
  let tabToastTimer = null;
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
      try{ tabToastEl.classList.remove("show"); }catch(e){}
    }, Math.max(500, Number(ms || 3000)));
  }

  // -------- Anti-reset (refresh/back) + tab lock --------
  function armAntiResetAndTabLock(){
    if (antiResetArmed) return;
    antiResetArmed = true;

    // Prevent back navigation: keep user on the exam page.
    try{
      history.pushState({ exam:true }, "", location.href);
    }catch(e){}

    window.addEventListener("popstate", async ()=>{
      if (!examStarted) return;
      try{ history.pushState({ exam:true }, "", location.href); }catch(e){}
      tabViolations++;
      localStorage.setItem(LS_KEY("tabViolations"), String(tabViolations));
      await pingPresence("nav_back_blocked");
      showTabToast(
        "Back navigation is disabled during the exam.",
        `Violations: ${tabViolations}/${MAX_TAB_VIOLATIONS}`,
        3000
      );
      if (tabViolations >= MAX_TAB_VIOLATIONS){
        autoReason = "tab_violations_max";
        await doSubmit(true);
      }
    });

    // Attempt to block refresh/close with a confirmation dialog.
    window.addEventListener("beforeunload", (e)=>{
      if (!examStarted) return;
      saveAnswers();
      e.preventDefault();
      e.returnValue = "";
      return "";
    });

    // Tab/window/app focus detection.
    // We count a violation when the user returns (tab becomes visible OR window regains focus)
    // so the warning is visible to them.
    let lastHiddenAt = 0;
    let lastBlurAt = 0;
    let lastViolationAt = 0; // debounce duplicate signals (e.g., blur + visibilitychange)

    async function registerFocusViolation(reason, awayMs){
      if (!examStarted) return;
      const now = Date.now();
      // Debounce: some actions can trigger multiple events.
      if (lastViolationAt && (now - lastViolationAt) < 600) return;
      lastViolationAt = now;

      tabViolations++;
      localStorage.setItem(LS_KEY("tabViolations"), String(tabViolations));
      try{ await pingPresence(reason || "focus_violation"); }catch(e){}

      showTabToast(
        "Do not switch tabs, windows, or apps during the exam.",
        `${awayMs ? `Away for ${Math.ceil(awayMs/1000)}s. ` : ""}Violations: ${tabViolations}/${MAX_TAB_VIOLATIONS}`,
        3000
      );

      if (tabViolations >= MAX_TAB_VIOLATIONS){
        autoReason = "tab_violations_max";
        await doSubmit(true);
      }
    }
    document.addEventListener("visibilitychange", async ()=>{
      if (!examStarted) return;
      if (document.hidden){
        lastHiddenAt = Date.now();
        await pingPresence("tab_hidden");
      }else{
        const awayMs = lastHiddenAt ? (Date.now() - lastHiddenAt) : 0;
        lastHiddenAt = 0;
        await registerFocusViolation("tab_visible", awayMs);
      }
    });

    // Losing focus (Alt+Tab, clicking another app/window, multi-monitor, etc.)
    window.addEventListener("blur", async ()=>{
      if (!examStarted) return;
      lastBlurAt = Date.now();
      await pingPresence("window_blur");
    });
    window.addEventListener("focus", async ()=>{
      if (!examStarted) return;
      const awayMs = lastBlurAt ? (Date.now() - lastBlurAt) : 0;
      lastBlurAt = 0;
      // Only count if we actually had a blur.
      if (awayMs > 0) await registerFocusViolation("window_focus", awayMs);
    });

    // Pointer leaves the exam window (common with 2nd monitor usage).
    // We trigger a violation only if the pointer stays out for a short time.
    let mouseOutTimer = null;
    let lastPointerViolationAt = 0;
    const POINTER_LEAVE_TRIGGER_MS = 900;

    function clearMouseOutTimer(){
      if (mouseOutTimer){
        clearTimeout(mouseOutTimer);
        mouseOutTimer = null;
      }
    }

    document.addEventListener("mouseout", (e)=>{
      if (!examStarted) return;
      // Only trigger when the pointer actually leaves the window,
      // not when moving between elements.
      if (e && (e.relatedTarget || e.toElement)) return;
      clearMouseOutTimer();
      mouseOutTimer = setTimeout(async ()=>{
        if (!examStarted) return;
        const now = Date.now();
        // Prevent spamming if the user keeps the mouse outside.
        if (lastPointerViolationAt && (now - lastPointerViolationAt) < 1500) return;
        lastPointerViolationAt = now;

        tabViolations++;
        localStorage.setItem(LS_KEY("tabViolations"), String(tabViolations));
        try{ await pingPresence("pointer_left"); }catch(e){}

        showTabToast(
          "Keep your mouse inside the exam window.",
          `Violations: ${tabViolations}/${MAX_TAB_VIOLATIONS}`,
          3000
        );

        if (tabViolations >= MAX_TAB_VIOLATIONS){
          autoReason = "tab_violations_max";
          await doSubmit(true);
        }
      }, POINTER_LEAVE_TRIGGER_MS);
    });
    document.addEventListener("mouseover", ()=>{
      clearMouseOutTimer();
    });
  }

  async function createFaceDetector(videoEl){
    // Native FaceDetector
    if ("FaceDetector" in window){
      try{
        const fd = new FaceDetector({ fastMode:true, maxDetectedFaces: 1 });
        await fd.detect(videoEl); // sanity check
        return {
          type: "native",
          detect: async ()=> {
            const faces = await fd.detect(videoEl);
            if (!Array.isArray(faces) || faces.length !== 1) return { ok:false };
            const bb = faces[0].boundingBox;
            const area = (bb?.width || 0) * (bb?.height || 0);
            const vidArea = (videoEl.videoWidth * videoEl.videoHeight) || 1;
            return { ok:true, ratio: area / vidArea };
          },
          stop: ()=>{}
        };
      }catch(e){}
    }

    // Fallback: MediaPipe Face Detection (client-side)
    await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/face_detection.js");
    await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js");

    const FaceDetection = window.FaceDetection;
    if (!FaceDetection) throw new Error("Face detection fallback not available");

    const faceDetection = new FaceDetection({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`
    });

    faceDetection.setOptions({ model: "short", minDetectionConfidence: 0.6 });

    let lastResult = null;
    faceDetection.onResults((res)=> { lastResult = res; });

    let running = true;
    (async ()=>{
      while (running){
        try{ await faceDetection.send({ image: videoEl }); }catch(e){}
        await new Promise(r=>setTimeout(r, 160)); // ~6 fps
      }
    })();

    return {
      type: "mediapipe",
      detect: async ()=>{
        const dets = lastResult?.detections || [];
        if (!Array.isArray(dets) || dets.length !== 1) return { ok:false };
        const b = dets[0].boundingBox;
        const w = b?.width || 0;
        const h = b?.height || 0;
        const ratio = Math.max(0, w*h); // relative area
        return { ok:true, ratio };
      },
      stop: ()=>{
        running = false;
        try{ faceDetection.close(); }catch(e){}
      }
    };
  }

  async function initCamera(deviceId){
    // Re-open stream with selected device when switching camera.
    if (presenceInterval) clearInterval(presenceInterval);
    try{ stream?.getTracks?.().forEach((t)=>t.stop()); }catch(e){}
    stream = null;

    const id = String(deviceId || "").trim();
    let constraints = { video: true, audio: false };
    if (id) constraints = { video: { deviceId: { exact: id } }, audio: false };

    try{
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    }catch(e){
      // Fallback to default camera if selected camera is unavailable.
      if (!id) throw e;
      stream = await navigator.mediaDevices.getUserMedia({ video:true, audio:false });
    }

    elVideo.srcObject = stream;
    if (elVideoMini) elVideoMini.srcObject = stream;
    await pingPresence("camera_on");
    await listVideoInputs(true).catch(()=>[]);

    presenceInterval = setInterval(async ()=>{
      const track = stream?.getVideoTracks?.()[0];
      const on = track && track.readyState === "live";
      await pingPresence(on ? "camera_on" : "camera_off");
    }, 15000);
  }

  async function startFaceGate(){
    elStartExam.disabled = true;
    faceOkSince = 0;

    elFaceHint.textContent = "Initializing face detection...";
    showGateNotice("Keep your face visible.", "");

    const detector = await createFaceDetector(elVideo);
    elFaceHint.textContent = `Face detection ready (${detector.type}).`;

    stopFaceLoop = ()=> { try{ detector.stop(); }catch(e){} };

    const loop = async ()=>{
      try{
        const r = await detector.detect();
        const ok = r.ok === true;
        const ratio = Number(r.ratio || 0);

        if (ok){
          elFaceOverlay.classList.add("ok");
          await pingPresence("face_ok");

          if (!faceOkSince) faceOkSince = nowMs();
          const stableMs = nowMs() - faceOkSince;

          const ratioOk = ratio >= 0.04;

          const fsOk = isFullscreen();
          if (stableMs >= 2000 && ratioOk && fsOk){
            elStartExam.disabled = false;
            showGateNotice("Checks passed. You can start the exam.", "ok");
          }else{
            elStartExam.disabled = true;
            if (!fsOk){
              showGateNotice("Please enter fullscreen to start the exam.", "bad");
            }else{
              showGateNotice("Hold still. Keep your face closer to the camera.", "");
            }
          }
        }else{
          elFaceOverlay.classList.remove("ok");
          faceOkSince = 0;
          elStartExam.disabled = true;
          elFaceHint.textContent = "No face detected.";
          showGateNotice("Make sure your face is visible (one person only).", "bad");
          await pingPresence("face_missing");
        }
      }catch(e){
        elStartExam.disabled = true;
        showGateNotice("Face detection error. Refresh the page.", "bad");
      }
    };

    const id = setInterval(loop, 220);
    await loop();

    return ()=> {
      clearInterval(id);
      if (stopFaceLoop) stopFaceLoop();
    };
  }

  // NOTE: fullscreen helpers are defined near the top of this file.

  function stopCamera(){
    if (presenceInterval) clearInterval(presenceInterval);
    try{ stream?.getTracks?.().forEach(t=>t.stop()); }catch(e){}
    stream = null;
    try{ if (elVideo) elVideo.srcObject = null; }catch(e){}
    try{ if (elVideoMini) elVideoMini.srcObject = null; }catch(e){}
    if (elCamMini) elCamMini.style.display = "none";
  }

  // -------- Continuous camera presence (no recording) --------
  let stopProctoring = null;

  // when auto-submitting, include a simple reason tag for the server logs
  let autoReason = "";

  async function startCameraPresenceProctoring(){
    if (!stream) return;
    if (stopProctoring) return;

    // show mini preview during the exam
    if (elCamMini) elCamMini.style.display = "block";
    if (elCamMiniText) elCamMiniText.textContent = "Checking…";
    if (elCamMiniDot) elCamMiniDot.classList.remove("ok");

    let missingSince = 0;
    let fsMissingSince = 0;
    let lastViolationAt = 0;

    // IMPORTANT: after the candidate clicks "Start exam", the gate block is hidden.
    // Many browsers reduce or stop frame updates for videos that are display:none.
    // Use the always-visible mini preview for reliable face detection during the exam.
    const detectVideoEl = elVideoMini || elVideo;
    try{ await detectVideoEl.play?.(); }catch(e){}
    const detector = await createFaceDetector(detectVideoEl);
    await pingPresence(`proctoring_on_${detector.type}`);

    const loop = async ()=>{
      if (!examStarted) return;

      // Fullscreen enforcement during the exam
      const fsOk = isFullscreen();
      if (!fsOk){
        if (!fsMissingSince) fsMissingSince = Date.now();
        const missMs = Date.now() - fsMissingSince;
        const leftS = Math.max(0, Math.ceil((FULLSCREEN_MISSING_AUTO_SUBMIT_MS - missMs) / 1000));

        if (elCamMiniText) elCamMiniText.textContent = `Fullscreen (${leftS}s)`;
        if (elCamMiniDot) elCamMiniDot.classList.remove("ok");

        showLock(
          "Fullscreen is required. You have 10 seconds.",
          `Time remaining: ${leftS} seconds`,
          { buttonMode: "fullscreen", buttonLabel: "Enter fullscreen mode and return to the test" }
        );

        await pingPresence("fullscreen_off_during_exam");

        if (missMs >= FULLSCREEN_MISSING_AUTO_SUBMIT_MS){
          await pingPresence("fullscreen_missing_auto_submit");
          autoReason = "disqual_fullscreen_10s";
          await doSubmit(true);
        }
        return;
      }
      fsMissingSince = 0;

      // If we were showing a fullscreen warning, clear it immediately when fullscreen is back.
      try{
        if (lockOverlay && lockOverlay.style.display !== "none"){
          const msg = (lockMsgEl?.textContent || "").toLowerCase();
          if (msg.includes("fullscreen is required")) hideLock();
        }
      }catch(e){}

      const track = stream?.getVideoTracks?.()[0];
      const camLive = track && track.readyState === "live" && track.enabled !== false;
      if (!camLive){
        if (!missingSince) missingSince = Date.now();
        if (elCamMiniText) elCamMiniText.textContent = "Camera off";
        if (elCamMiniDot) elCamMiniDot.classList.remove("ok");
        showLock("Camera is not active.", "Turn camera on to continue.");
        await pingPresence("camera_off_during_exam");
      } else {
        let ok = false;
        try{
          const r = await detector.detect();
          ok = r.ok === true;
        }catch(e){
          ok = false;
        }

        if (ok){
          missingSince = 0;
          if (elCamMiniText) elCamMiniText.textContent = "Face detected";
          if (elCamMiniDot) elCamMiniDot.classList.add("ok");
          hideLock();
          return;
        }

        if (!missingSince) missingSince = Date.now();
        const missMs = Date.now() - missingSince;
        const leftS = Math.max(0, Math.ceil((FACE_MISSING_AUTO_SUBMIT_MS - missMs) / 1000));
        if (elCamMiniText) elCamMiniText.textContent = `No face (${leftS}s)`;
        if (elCamMiniDot) elCamMiniDot.classList.remove("ok");
        showLock(
          "Please keep your face inside the camera frame. You have 10 seconds.",
          `Time remaining: ${leftS} seconds`
        );

        if (missMs >= 3000 && (Date.now() - lastViolationAt) > 4000){
          lastViolationAt = Date.now();
          faceViolations++;
          await pingPresence("face_missing_during_exam");
        }

        if (missMs >= FACE_MISSING_AUTO_SUBMIT_MS){
          await pingPresence("face_missing_auto_submit");
          autoReason = "face_missing_10s";
          await doSubmit(true);
        }
      }
    };

    // Keep the loop tight enough for near-immediate feedback.
    const id = setInterval(loop, 180);
    await loop();

    stopProctoring = ()=>{
      clearInterval(id);
      try{ detector.stop(); }catch(e){}
      stopProctoring = null;
    };
  }

  function renderTest(payload){
    elContent.innerHTML = "";
    sectionViews = [];
    currentSectionIdx = 0;

    const sections = Array.isArray(payload.sections) ? payload.sections : [];
    for (let secIdx = 0; secIdx < sections.length; secIdx++){
      const sec = sections[secIdx];
      const secKind = getSectionKind(sec);
      const secEl = document.createElement("div");
      secEl.className = "section";
      secEl.innerHTML = `<h2>${escapeHtml(sec.title || "Section")}</h2>`;
      if (sec.description){
        const intro = document.createElement("div");
        intro.className = "small";
        intro.textContent = String(sec.description);
        secEl.appendChild(intro);
      }

      if (secKind === "writing"){
        const writingItems = Array.isArray(sec.items) ? sec.items : [];
        const gapIds = ["w1", "w2", "w3", "w4"];
        const gapItems = gapIds
          .map((id)=> writingItems.find((it)=> String(it?.id || "") === id))
          .filter(Boolean);

        if (gapItems.length === 4){
          const bankWords = Array.isArray(gapItems[0].choices) ? gapItems[0].choices.map((x)=> String(x)) : [];
          const choiceIndexByWord = new Map(bankWords.map((w, i)=> [w, i]));

          const gapCard = document.createElement("div");
          gapCard.className = "q";

          const gapTitle = document.createElement("div");
          gapTitle.className = "q-title";
          gapTitle.textContent = "Task 1: Drag the correct words into the gaps.";
          gapCard.appendChild(gapTitle);

          const gapText = document.createElement("div");
          gapText.style.lineHeight = "1.8";
          gapText.style.marginTop = "8px";
          gapText.innerHTML = `
            Rain makes the <span class="gap-blank" data-index="1" data-qid="w1">(${1})</span> shine.
            The air smells clean and <span class="gap-blank" data-index="2" data-qid="w2">(${2})</span>.
            I put on my <span class="gap-blank" data-index="3" data-qid="w3">(${3})</span> and boots.
            I feel calm and happy. I like rain because it helps
            <span class="gap-blank" data-index="4" data-qid="w4">(${4})</span> grow and makes trees look fresh.
          `;
          gapCard.appendChild(gapText);

          const bankTitle = document.createElement("div");
          bankTitle.className = "small";
          bankTitle.style.marginTop = "10px";
          bankTitle.textContent = "Word bank:";
          gapCard.appendChild(bankTitle);

          const bank = document.createElement("div");
          bank.className = "word-bank";
          bank.style.display = "flex";
          bank.style.flexWrap = "wrap";
          bank.style.gap = "8px";
          bank.style.marginTop = "8px";

          for (const word of bankWords){
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "word-chip";
            chip.draggable = true;
            chip.dataset.word = word;
            chip.textContent = word;
            bank.appendChild(chip);
          }
          gapCard.appendChild(bank);

          const tip = document.createElement("div");
          tip.className = "small";
          tip.style.marginTop = "8px";
          tip.textContent = "Tip: double-click a gap to clear it.";
          gapCard.appendChild(tip);

          secEl.appendChild(gapCard);

          const gaps = [...gapCard.querySelectorAll(".gap-blank[data-qid]")];
          const chips = [...gapCard.querySelectorAll(".word-chip")];
          let draggedChip = null;

          const clearGap = (gap)=>{
            const prevWord = String(gap.dataset.word || "");
            if (prevWord){
              const prevChip = chips.find((ch)=> String(ch.dataset.word || "") === prevWord);
              if (prevChip) prevChip.classList.remove("in-gap");
            }
            gap.textContent = `(${gap.dataset.index || ""})`;
            gap.dataset.word = "";
            gap.dataset.choiceIndex = "";
            gap.classList.remove("filled");
          };

          chips.forEach((chip)=>{
            chip.addEventListener("dragstart", (e)=>{
              draggedChip = chip;
              chip.classList.add("dragging");
              if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
            });
            chip.addEventListener("dragend", ()=>{
              draggedChip = null;
              chip.classList.remove("dragging");
            });
          });

          gaps.forEach((gap)=>{
            gap.dataset.choiceValues = JSON.stringify(bankWords);
            gap.addEventListener("dragover", (e)=>{
              e.preventDefault();
              gap.classList.add("drag-over");
            });
            gap.addEventListener("dragleave", ()=> gap.classList.remove("drag-over"));
            gap.addEventListener("drop", (e)=>{
              e.preventDefault();
              gap.classList.remove("drag-over");
              if (!draggedChip) return;

              // If dropped chip already used in another gap, remove it there first.
              const draggedWord = String(draggedChip.dataset.word || "");
              const existingGap = gaps.find((g)=> String(g.dataset.word || "") === draggedWord);
              if (existingGap && existingGap !== gap) clearGap(existingGap);

              clearGap(gap);

              gap.textContent = draggedWord;
              gap.dataset.word = draggedWord;
              gap.dataset.choiceIndex = String(choiceIndexByWord.has(draggedWord) ? choiceIndexByWord.get(draggedWord) : "");
              gap.classList.add("filled");
              draggedChip.classList.add("in-gap");
              saveAnswers();
            });
            gap.addEventListener("dblclick", ()=>{
              clearGap(gap);
              saveAnswers();
            });
          });
        }
      }

      // Listening section: one shared audio player (as in the original flow).
      if (secKind === "listening"){
        const firstAudioItem = (sec.items || []).find((it)=> it?.type === "listening-mcq" && it?.audioUrl);
        if (firstAudioItem?.audioUrl){
          const maxPlays = (sec.rules && Number(sec.rules.audioPlaysAllowed)) || 1;
          const playKey = LS_KEY(`play_sec_${sec.id || "listening"}`);
          const endedKey = LS_KEY(`play_sec_${sec.id || "listening"}_ended`);
          const getPlayCount = ()=> Number(localStorage.getItem(playKey) || "0");
          const setPlayCount = (n)=> localStorage.setItem(playKey, String(Math.max(0, Number(n) || 0)));

          const audioWrap = document.createElement("div");
          audioWrap.className = "q";

          const audio = document.createElement("audio");
          audio.src = String(firstAudioItem.audioUrl);
          audio.preload = "auto";
          audio.controls = false;

          const controlsRow = document.createElement("div");
          controlsRow.style.display = "flex";
          controlsRow.style.alignItems = "center";
          controlsRow.style.gap = "10px";
          controlsRow.style.flexWrap = "wrap";

          const playBtn = document.createElement("button");
          playBtn.type = "button";
          playBtn.className = "primary";
          playBtn.textContent = "Play Listening";

          const skipBtn = document.createElement("button");
          skipBtn.type = "button";
          skipBtn.className = "primary";
          skipBtn.textContent = "Skip to end (testing)";

          const audioMsg = document.createElement("div");
          audioMsg.className = "small";
          audioMsg.textContent = "Press Play to start the listening section. It can be played once.";

          let started = false;
          let noteAdded = false;
          const addLockedNote = ()=>{
            if (noteAdded) return;
            noteAdded = true;
            const note = document.createElement("div");
            note.className = "small";
            note.textContent = "Listening audio is locked.";
            audioWrap.appendChild(note);
          };
          const lockAudio = ()=>{
            playBtn.disabled = true;
            playBtn.textContent = "Listening completed";
            addLockedNote();
          };

          if (localStorage.getItem(endedKey) === "1" || getPlayCount() >= maxPlays){
            lockAudio();
          }

          playBtn.addEventListener("click", ()=>{
            const plays = getPlayCount();
            if (plays >= maxPlays){
              showStatus("Audio can only be played once.", "bad");
              lockAudio();
              return;
            }
            if (started) return;
            started = true;
            setPlayCount(plays + 1);
            playBtn.disabled = true;
            playBtn.textContent = "Now playing";
            audioMsg.textContent = "Listening in progress...";
            audio.currentTime = 0;
            audio.play().catch(()=>{
              started = false;
              playBtn.disabled = false;
              playBtn.textContent = "Play Listening";
              audioMsg.textContent = "Unable to play audio on this browser/device.";
            });
          });

          skipBtn.addEventListener("click", ()=>{
            const jumpToEnd = ()=>{
              const d = Number(audio.duration || 0);
              if (!Number.isFinite(d) || d <= 0) return;
              audio.currentTime = Math.max(0, d - 0.05);
              if (audio.paused) {
                audio.play().catch(()=>{});
              }
            };
            if (!Number.isFinite(Number(audio.duration)) || Number(audio.duration) <= 0){
              audio.addEventListener("loadedmetadata", jumpToEnd, { once: true });
              audio.load();
              return;
            }
            jumpToEnd();
          });

          audio.addEventListener("ended", ()=>{
            localStorage.setItem(endedKey, "1");
            lockAudio();
            audioMsg.textContent = "Listening complete. Moving to the next part...";
            setTimeout(()=> showSection(currentSectionIdx + 1), 250);
          });

          controlsRow.appendChild(playBtn);
          controlsRow.appendChild(skipBtn);
          controlsRow.appendChild(audioMsg);
          audioWrap.appendChild(controlsRow);
          audioWrap.appendChild(audio);
          secEl.appendChild(audioWrap);
        }
      }

      for (const item of sec.items || []){
        if (secKind === "writing" && (item.id === "w_intro" || item.id === "w1" || item.id === "w2" || item.id === "w3" || item.id === "w4")){
          continue;
        }
        if (item.type === "info"){
          const info = document.createElement("div");
          info.className = "q";
          const p = document.createElement("div");
          p.className = "small";
          p.style.whiteSpace = "pre-wrap";
          p.textContent = String(item.prompt || "");
          info.appendChild(p);
          secEl.appendChild(info);
          continue;
        }

        const q = document.createElement("div");
        q.className = "q";
        q.dataset.qid = item.id;

        const header = document.createElement("div");
        header.className = "q-title";
        header.textContent = item.prompt || "";
        q.appendChild(header);

        if (item.type === "mcq" || item.type === "listening-mcq"){
          (item.choices || []).forEach((c, idx)=>{
            const row = document.createElement("label");
            row.className = "choice";
            row.innerHTML = `
              <input type="radio" name="${escapeHtml(item.id)}" value="${idx}">
              <div>${escapeHtml(c)}</div>
            `;
            q.appendChild(row);
          });

        } else if (item.type === "tf"){
          ["true","false"].forEach((val)=>{
            const row = document.createElement("label");
            row.className = "choice";
            row.innerHTML = `
              <input type="radio" name="${escapeHtml(item.id)}" value="${val}">
              <div>${val === "true" ? "True" : "False"}</div>
            `;
            q.appendChild(row);
          });
        } else {
          const ta = document.createElement("textarea");
          ta.name = item.id;
          ta.rows = item.type === "writing" ? 10 : 3;
          ta.placeholder = item.type === "writing" ? "Write your text here..." : "Type your answer...";
          q.appendChild(ta);
        }

        secEl.appendChild(q);
      }

      // Section navigation (listening auto-advances on audio ended).
      const nav = document.createElement("div");
      nav.style.display = "flex";
      nav.style.justifyContent = "space-between";
      nav.style.gap = "10px";
      nav.style.marginTop = "12px";
      let hasBack = false;
      let hasNext = false;

      if (secIdx > 0 && secKind !== "listening" && secKind !== "reading"){
        const back = document.createElement("button");
        back.type = "button";
        back.className = "primary";
        back.textContent = "Back";
        back.addEventListener("click", ()=> showSection(currentSectionIdx - 1));
        nav.appendChild(back);
        hasBack = true;
      } else {
        const spacer = document.createElement("div");
        nav.appendChild(spacer);
      }

      if (secIdx < sections.length - 1 && secKind !== "listening"){
        const next = document.createElement("button");
        next.type = "button";
        next.className = "primary";
        next.textContent = "Continue";
        next.addEventListener("click", ()=> showSection(currentSectionIdx + 1));
        nav.appendChild(next);
        hasNext = true;
      }

      if (hasBack || hasNext) secEl.appendChild(nav);
      elContent.appendChild(secEl);
      sectionViews.push({ el: secEl, kind: secKind });
    }

    // Re-apply any saved answers after rendering
    restoreAnswers();
    const savedIdx = Number(localStorage.getItem(LS_KEY("sectionIdx")) || "0");
    showSection(Number.isFinite(savedIdx) ? savedIdx : 0);
  }

  function collectAnswers(){
    const out = {};
    qsa("input[type=radio]:checked").forEach((r)=>{
      const name = r.getAttribute("name");
      const val = r.value;
      if (val === "true" || val === "false"){
        out[name] = val;
        return;
      }

      // MCQ: UI value is shuffledIndex, store originalIndex for server grading
      const shuffledIdx = Number(val);
      const order = choiceOrderByQ.get(name);
      out[name] = Array.isArray(order) ? Number(order[shuffledIdx]) : shuffledIdx;
    });
    qsa("textarea").forEach((t)=>{
      if (t.name) out[t.name] = t.value;
    });
    qsa(".gap-blank[data-qid]").forEach((gap)=>{
      const qid = String(gap.dataset.qid || "");
      if (!qid) return;
      const idxRaw = String(gap.dataset.choiceIndex || "").trim();
      if (!idxRaw) {
        out[qid] = "";
        return;
      }
      const idx = Number(idxRaw);
      out[qid] = Number.isFinite(idx) ? idx : "";
    });
    return out;
  }

  function startTimerAbsolute(endAtUtcMs, nowServer){
    // Timer must be anchored to the global exam window (openAt -> openAt + duration)
    // not to when the candidate clicks Start.
    const targetEnd = Number(endAtUtcMs || 0);
    endAt = targetEnd;
    localStorage.setItem(LS_KEY("endAt"), String(endAt));

    const tick = async ()=>{
      const left = Math.max(0, Math.ceil((endAt - nowServer())/1000));
      elTimer.textContent = fmtTime(left);

      if (left <= 0){
        clearInterval(timerId);
        // Before the exam starts (camera step), we only show that the exam ended.
        // After the exam starts, we auto-submit.
        if (timerAutoSubmit){
          showStatus("Time is up. Submitting...", "bad");
          autoReason = "time_up";
          try{ await doSubmit(true); }catch(e){ showStatus(String(e.message || e), "bad"); }
        } else {
          elGate.style.display = "none";
          elContent.style.display = "none";
          elSubmit.style.display = "none";
          elStartExam.disabled = true;
          elEnableCam.disabled = true;
          elTitle.textContent = "Exam ended";
          showStatus("The exam has ended.", "bad");
          stopCamera();
        }
      }
    };
    tick();
    if (timerId) clearInterval(timerId);
    timerId = setInterval(tick, 250);
  }

  async function doSubmit(auto=false){
    if (submitInFlight) return;
    submitInFlight = true;
    if (localStorage.getItem(LS_KEY("submitted")) === "1"){
      showStatus("Already submitted.", "ok");
      elSubmit.style.display = "none";
      submitInFlight = false;
      return;
    }
    const answers = collectAnswers();
    const clientMeta = { userAgent: navigator.userAgent, auto, ts: Date.now() };
    if (auto && autoReason) clientMeta.reason = autoReason;
    try{
      const r = await apiPost(`/api/session/${encodeURIComponent(token)}/submit`, { answers, clientMeta });
      localStorage.setItem(LS_KEY("submitted"), "1");
      elSubmit.style.display = "none";
      const disqualified = !!(r && r.disqualified) || /disqual/i.test(String(autoReason || ""));
      showFinalScreen(disqualified);
      hideLock();
      try{ if (stopProctoring) stopProctoring(); }catch(e){}
      stopCamera();
      if (elCamMini) elCamMini.style.display = "none";
    } finally {
      submitInFlight = false;
    }
  }

  elSubmit.addEventListener("click", async ()=>{
    elSubmit.disabled = true;
    try{ await doSubmit(false); }
    finally{ elSubmit.disabled = false; }
  });

  async function boot(){
    // Gate + session come from the token endpoint (per exam period).
    const first = await apiGet(`/api/session/${encodeURIComponent(token)}`);
    const serverNow = Number(first.serverNow || Date.now());
    const openAt = Number(first.openAtUtc || 0);
    const endAt = Number(first.endAtUtc || 0);
    const offset = serverNow - Date.now();
    const nowServer = () => Date.now() + offset;

    if (first.status === "ended") {
      const endIso = endAt ? fmtLocalStamp(endAt) : "";
      elGate.style.display = "none";
      elContent.style.display = "none";
      elSubmit.style.display = "none";
      elStartExam.disabled = true;
      elEnableCam.disabled = true;
      elTitle.textContent = "Exam ended";
      elTimer.textContent = "00:00";
      showStatus(endIso ? `The exam has ended (ended at ${endIso}).` : "The exam has ended.", "bad");
      return;
    }

    if (first.status === "countdown") {
      const openIso = openAt ? fmtLocalStamp(openAt) : "";
      elGate.style.display = "none";
      elContent.style.display = "none";
      elSubmit.style.display = "none";
      elStartExam.disabled = true;
      elEnableCam.disabled = true;

      const tick = ()=>{
        const left = Math.max(0, Math.ceil((openAt - nowServer()) / 1000));
        const hh = String(Math.floor(left / 3600)).padStart(2,"0");
        const mm = String(Math.floor((left % 3600) / 60)).padStart(2,"0");
        const ss = String(left % 60).padStart(2,"0");
        elTitle.textContent = "Exam starts in";
        elTimer.textContent = `${hh}:${mm}:${ss}`;
        showStatus(openIso ? `The exam opens at ${openIso}. Countdown: ${hh}:${mm}:${ss}` : `Countdown: ${hh}:${mm}:${ss}`, "");
      };

      await new Promise((resolve)=>{
        tick();
        const id = setInterval(()=>{
          if (nowServer() >= openAt){
            clearInterval(id);
            resolve(true);
          } else {
            tick();
          }
        }, 500);
      });

      // After countdown, fetch the real session payload
      sessionData = await apiGet(`/api/session/${encodeURIComponent(token)}`);
    } else {
      sessionData = first;
    }

    // If this token was already submitted, show only the final result message.
    if (sessionData && sessionData.session && sessionData.session.submitted){
      showFinalScreen(!!sessionData.session.disqualified);
      return;
    }

    // Deterministic randomization for questions + MCQ choices.
    randomizedPayload = buildRandomizedPayload(sessionData.test.payload);

    elTitle.textContent = sessionData.test.title;
    if (elExamFlowText) {
      const parts = (randomizedPayload.sections || []).map((s) => String(s.title || "").trim()).filter(Boolean);
      if (parts.length) {
        elExamFlowText.textContent = `Test flow: ${parts.join(" -> ")}`;
      }
    }
    elCandidate.textContent = sessionData.session.candidateName;

    elGate.style.display = "block";
    elContent.style.display = "none";
    elSubmit.style.display = "none";
    elStartExam.disabled = true;

    // Start showing the remaining time immediately, even before camera/start.
    timerAutoSubmit = false;
    if (endAt) startTimerAbsolute(endAt, nowServer);

    if (localStorage.getItem(LS_KEY("submitted")) === "1"){
      showStatus("This device already submitted this token.", "bad");
    }

    let stopGateLoop = null;
    preferredCameraId = readPreferredCameraId();
    await listVideoInputs(false).catch(()=>[]);
    if (elCamSelect) elCamSelect.value = preferredCameraId || "";

    if (elRefreshCams){
      elRefreshCams.addEventListener("click", async ()=>{
        try{
          elRefreshCams.disabled = true;
          await listVideoInputs(true);
          showGateNotice("Camera list refreshed.", "");
        }catch{
          showGateNotice("Could not read camera devices.", "bad");
        }finally{
          elRefreshCams.disabled = false;
        }
      });
    }

    if (elCamSelect){
      elCamSelect.addEventListener("change", async ()=>{
        preferredCameraId = String(elCamSelect.value || "");
        writePreferredCameraId(preferredCameraId);

        // If camera already enabled, apply switch immediately.
        if (!stream) return;
        try{
          if (stopGateLoop) stopGateLoop();
          await initCamera(preferredCameraId);
          stopGateLoop = await startFaceGate();
          showGateNotice("Camera switched.", "ok");
        }catch(e){
          showGateNotice("Could not switch camera. Try another device.", "bad");
        }
      });
    }

    // Fullscreen button + enforcement before start
    if (elGoFullscreen){
      elGoFullscreen.addEventListener("click", async ()=>{
        await requestFullscreen();
        if (isFullscreen()){
          showGateNotice("Fullscreen enabled. Complete the camera check to start.", "ok");
          await pingPresence("fullscreen_on");
        }else{
          showGateNotice("Please enter fullscreen to start the exam.", "bad");
        }
      });
    }

    // Mini button near the camera preview (during the exam)
    if (elFsBtnMini){
      elFsBtnMini.addEventListener("click", async ()=>{
        await requestFullscreen();
      });
    }

    const onFsChange = ()=>{
      if (!elGate || elGate.style.display === "none") return;
      if (!isFullscreen()){
        elStartExam.disabled = true;
        showGateNotice("Please enter fullscreen to start the exam.", "bad");
      }
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    // F11 browser fullscreen does not fire fullscreenchange, but it does trigger resize.
    window.addEventListener("resize", onFsChange);

    elEnableCam.addEventListener("click", async ()=>{
      elEnableCam.disabled = true;
      try{
        const camId = elCamSelect ? String(elCamSelect.value || preferredCameraId || "") : preferredCameraId;
        await initCamera(camId);
        stopGateLoop = await startFaceGate();
      }catch(e){
        await pingPresence("camera_denied");
        showGateNotice("Camera permission denied, or face detection could not start.", "bad");
        elFaceHint.textContent = String(e.message || e);
        elStartExam.disabled = true;
      }finally{
        elEnableCam.disabled = false;
      }
    });

    elStartExam.addEventListener("click", async ()=>{
      elStartExam.disabled = true;
      try{
        if (!isFullscreen()){
          showGateNotice("Please enter fullscreen to start the exam.", "bad");
          return;
        }
        // If the candidate waits too long on the camera step, the exam may already be over.
        if (endAt && nowServer() > endAt) {
          const endIso = fmtLocalStamp(endAt);
          elGate.style.display = "none";
          elContent.style.display = "none";
          elSubmit.style.display = "none";
          elTitle.textContent = "Exam ended";
          elTimer.textContent = "00:00";
          showStatus(`The exam has ended (ended at ${endIso}).`, "bad");
          stopCamera();
          return;
        }

        if (stopGateLoop) stopGateLoop();

        // From this point on, time reaching 0 should auto-submit.
        timerAutoSubmit = true;

        await apiPost(`/api/session/${encodeURIComponent(token)}/start`, {});
        await pingPresence("exam_started");

        elGate.style.display = "none";
        elContent.style.display = "block";
        elSubmit.style.display = "block";
        examStarted = true;
        armAntiResetAndTabLock();
        renderTest(randomizedPayload);
        wireAutosave();
        await startCameraPresenceProctoring();
        startTimerAbsolute(endAt, nowServer);
      }catch(e){
        showGateNotice(String(e.message || e), "bad");
        elStartExam.disabled = false;
      }
    });

    showGateNotice("Click Enable camera to continue. Time is already running.", "");
  }

  boot().catch((e)=>{
    elTitle.textContent = "Cannot load exam";
    showStatus(String(e.message || e), "bad");
  });
