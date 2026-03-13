import { qs, qsa, apiGet, apiPost, fmtTime, escapeHtml, nowMs, uiConfirm } from "/app.js";
import { hardenNoTranslateTree, registerCanvasTextBlock, clearCanvasTextBlocks, queueCanvasTextRender, installCanvasTextAutoResize } from "/exam/text-canvas.js";
import { renderExamTest } from "/exam/renderers.js";
import { createExamStateHelpers } from "/exam/state.js";
import { createExamProctoringHelpers } from "/exam/proctoring.js";
import { createExamLockdownHelpers } from "/exam/lockdown.js";
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
  const elTestSound = qs("#testSound");
  const elGoFullscreen = qs("#goFullscreen");
  const elStartExam = qs("#startExam");
  const elGateNotice = qs("#gateNotice");
  const elTestSoundStatus = qs("#testSoundStatus");
  const elVideo = qs("#video");
  const elFaceOverlay = qs("#faceOverlay");
  const elFaceHint = qs("#faceHint");
  const elCamSelect = qs("#camSelect");
  const elSpeakerSelect = qs("#speakerSelect");
  const elRefreshCams = qs("#refreshCams");
  const elCameraCheckText = qs("#cameraCheckText");

  // Proctoring notice + acknowledgement (GDPR notice on candidate link)
  const elProctoringNoticeText = qs("#proctoringNoticeText");
  const elProctoringMeta = qs("#proctoringMeta");
  const elProctoringController = qs("#proctoringController");
  const elProctoringRetention = qs("#proctoringRetention");
  const elProctoringPrivacyLink = qs("#proctoringPrivacyLink");
  const elProctoringReadMore = qs("#proctoringReadMore");
  const elProctoringLongNotice = qs("#proctoringLongNotice");
  const elProctoringControllerLong = qs("#proctoringControllerLong");
  const elProctoringRetentionLong = qs("#proctoringRetentionLong");
  const elProctoringAck = qs("#proctoringAck");
  const elProctoringAckLabel = qs("#proctoringAckLabel");
  const elReqFullscreen = qs("#reqFullscreen");

  // Mini camera preview (during exam)
  const elCamMini = qs("#camMini");
  const elVideoMini = qs("#videoMini");
  const elCamMiniDot = qs("#camMiniDot");
  const elCamMiniText = qs("#camMiniText");

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

  function richTextHtml(raw){
    const src = String(raw || "");
    const parts = src.split("**");
    // Unbalanced markers -> treat literally.
    if (parts.length < 3 || parts.length % 2 === 0) return escapeHtml(src).replace(/\r?\n/g, "<br>");
    let out = "";
    for (let i = 0; i < parts.length; i++){
      const seg = escapeHtml(parts[i]).replace(/\r?\n/g, "<br>");
      out += (i % 2 === 1) ? `<b>${seg}</b>` : seg;
    }
    return out;
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
  function showTestSoundStatus(text, cls){
    if (!elTestSoundStatus) return;
    elTestSoundStatus.textContent = text;
    elTestSoundStatus.className = "small " + (cls || "muted");
  }

  let clearReturnSnapshotTimer = ()=>{};
  let scheduleReturnSnapshot = ()=>{};
  let hardenCameraVideoEl = ()=>{};
  let applyProctoringConfig = ()=>{};
  let isProctoringAckSatisfied = ()=> true;
  let ensureProctoringAckRecorded = async ()=>{};
  let captureAndUploadSnapshot = async ()=>{};

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
  let proctoringAckedServer = false;
  let proctoringAckRequired = true;
  let proctoringNoticeVersion = "2026-02-26_v1";
  let proctoringMode = "presence"; // presence | recording
  let snapshotsTaken = 0;
  const MAX_SNAPSHOTS = 10;
  let snapshotInFlight = false;
  let lastSnapshotAt = 0;
  let antiResetArmed = false;
  let tabViolations = Number(localStorage.getItem(LS_KEY("tabViolations")) || "0");
  // Face violations must be scoped to the current attempt only.
  // Persisting across refreshes can cause premature disqualification.
  let faceViolations = 0;
  let stopTranslationGuard = null;
  let translationViolationTriggered = false;
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
  let buildRandomizedPayload = null;
  let saveAnswers = null;
  let restoreAnswers = null;
  let wireAutosave = null;

  ({
    clearReturnSnapshotTimer,
    scheduleReturnSnapshot,
    hardenCameraVideoEl,
    applyProctoringConfig,
    isProctoringAckSatisfied,
    ensureProctoringAckRecorded,
    captureAndUploadSnapshot,
  } = createExamProctoringHelpers({
    token,
    apiPost,
    getExamStarted: ()=> examStarted,
    getProctoringMode: ()=> proctoringMode,
    setProctoringMode: (value)=> { proctoringMode = value; },
    getProctoringAckRequired: ()=> proctoringAckRequired,
    setProctoringAckRequired: (value)=> { proctoringAckRequired = value; },
    getProctoringNoticeVersion: ()=> proctoringNoticeVersion,
    setProctoringNoticeVersion: (value)=> { proctoringNoticeVersion = value; },
    getProctoringAckedServer: ()=> proctoringAckedServer,
    setProctoringAckedServer: (value)=> { proctoringAckedServer = value; },
    getSnapshotsTaken: ()=> snapshotsTaken,
    setSnapshotsTaken: (value)=> { snapshotsTaken = value; },
    getSnapshotInFlight: ()=> snapshotInFlight,
    setSnapshotInFlight: (value)=> { snapshotInFlight = value; },
    getLastSnapshotAt: ()=> lastSnapshotAt,
    setLastSnapshotAt: (value)=> { lastSnapshotAt = value; },
    MAX_SNAPSHOTS,
    elProctoringNoticeText,
    elProctoringMeta,
    elProctoringController,
    elProctoringRetention,
    elProctoringPrivacyLink,
    elProctoringControllerLong,
    elProctoringRetentionLong,
    elProctoringAck,
    elProctoringAckLabel,
    elCameraCheckText,
    elVideo,
    elVideoMini,
  }));

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
    try{
      const current = sectionViews[clamped];
      if (current && current.kind === "listening" && typeof current.autoStart === "function"){
        current.autoStart();
      }
    } catch {}
    try { localStorage.setItem(LS_KEY("sectionIdx"), String(clamped)); } catch(e){}
    setSubmitVisibility();
    try { window.scrollTo(0, 0); } catch(e){}
  }

  let faceOkSince = 0;
  let stopFaceLoop = null;
  let preferredCameraId = "";
  let preferredSpeakerId = "";
  const PREF_CAM_KEY = "exam_preferred_camera";
  const PREF_SPK_KEY = "exam_preferred_speaker";
  let stopPreStartTranslationGuard = null;

  let fullscreenRequired = false;
  let isFullscreen = ()=> false;
  let requestFullscreen = async ()=>{};
  let exitFullscreen = async ()=>{};
  let showLock = ()=>{};
  let hideLock = ()=>{};
  let showTabToast = ()=>{};
  let armAntiResetAndTabLock = ()=>{};

  async function pingPresence(status){
    try { await apiPost(`/api/session/${encodeURIComponent(token)}/presence`, { status }); } catch(e){}
  }

  let hasExtendedDisplay = ()=> false;

  function detectTranslationViolation(){
    const html = document.documentElement;
    const body = document.body;
    const lang = String(html?.getAttribute("lang") || "").trim().toLowerCase();
    const htmlClass = String(html?.className || "");
    const bodyClass = String(body?.className || "");

    if (lang && lang !== "en") return `html_lang_${lang}`;
    if (/\btranslated-(ltr|rtl)\b/i.test(htmlClass)) return "html_translated_class";
    if (/\btranslated-(ltr|rtl)\b/i.test(bodyClass)) return "body_translated_class";
    if (document.querySelector(".goog-te-banner-frame, .skiptranslate, .goog-te-menu-frame, .goog-tooltip")) return "google_translate_dom";

    const bodyTop = String(body?.style?.top || "").trim();
    if (bodyTop && bodyTop !== "0px" && bodyTop !== "auto") return "body_top_shift";

    const notranslateOk = !!(html?.classList?.contains("notranslate") && body?.classList?.contains("notranslate"));
    if (!notranslateOk) return "notranslate_removed";

    return "";
  }

  async function triggerTranslationViolation(reason){
    if (translationViolationTriggered || !examStarted) return;
    translationViolationTriggered = true;
    try{ await pingPresence(`translation_detected_${String(reason || "unknown")}`); }catch(e){}
    void captureAndUploadSnapshot(`translation_detected_${String(reason || "unknown")}`);
    showLock(
      "Translation tools are not allowed during the exam.",
      "Your exam is being submitted and marked as disqualified.",
      { minMs: 1500 }
    );
    autoReason = `disqual_translation_${String(reason || "unknown")}`;
    await doSubmit(true);
  }

  function getPreStartTranslationBlockMessage(reason){
    const suffix = reason ? ` (${String(reason).replace(/_/g, " ")})` : "";
    return `Disable translation/browser extensions for this site before starting the exam${suffix}.`;
  }

  function armTranslationGuard(){
    if (stopTranslationGuard) return;

    const check = ()=>{
      if (!examStarted || translationViolationTriggered) return;
      const reason = detectTranslationViolation();
      if (reason) void triggerTranslationViolation(reason);
    };

    const observer = new MutationObserver(()=>{ check(); });
    try{
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["class", "lang", "style", "translate"],
      });
    }catch(e){}

    const id = setInterval(check, 1000);
    check();

    stopTranslationGuard = ()=>{
      clearInterval(id);
      try{ observer.disconnect(); }catch(e){}
      stopTranslationGuard = null;
    };
  }

  function armPreStartTranslationGuard(){
    if (stopPreStartTranslationGuard) return;

    const check = ()=>{
      if (examStarted) return;
      if (!elGate || elGate.style.display === "none") return;
      const reason = detectTranslationViolation();
      if (!reason) return;
      if (elStartExam) elStartExam.disabled = true;
      showGateNotice(getPreStartTranslationBlockMessage(reason), "bad");
    };

    const observer = new MutationObserver(()=>{ check(); });
    try{
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["class", "lang", "style", "translate"],
      });
    }catch(e){}

    const id = setInterval(check, 1000);
    check();

    stopPreStartTranslationGuard = ()=>{
      clearInterval(id);
      try{ observer.disconnect(); }catch(e){}
      stopPreStartTranslationGuard = null;
    };
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
  function readPreferredSpeakerId(){
    try { return String(localStorage.getItem(PREF_SPK_KEY) || "").trim(); } catch { return ""; }
  }
  function writePreferredSpeakerId(id){
    try {
      const v = String(id || "").trim();
      if (v) localStorage.setItem(PREF_SPK_KEY, v);
      else localStorage.removeItem(PREF_SPK_KEY);
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

  async function listAudioOutputs(keepSelection){
    if (!navigator.mediaDevices?.enumerateDevices || !elSpeakerSelect) return [];
    const canRouteAudio = !!(window.HTMLMediaElement && HTMLMediaElement.prototype && "setSinkId" in HTMLMediaElement.prototype);
    if (!canRouteAudio){
      elSpeakerSelect.innerHTML = `<option value="">Default output (browser controlled)</option>`;
      elSpeakerSelect.value = "";
      elSpeakerSelect.disabled = true;
      return [];
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const outs = (devices || []).filter((d)=> d.kind === "audiooutput");
    const prev = keepSelection ? String(elSpeakerSelect.value || preferredSpeakerId || "") : String(preferredSpeakerId || "");
    const opts = [`<option value="">Default output</option>`];
    outs.forEach((d, i)=>{
      const label = String(d.label || "").trim() || `Speaker ${i + 1}`;
      opts.push(`<option value="${escapeHtml(String(d.deviceId || ""))}">${escapeHtml(label)}</option>`);
    });
    elSpeakerSelect.innerHTML = opts.join("");

    if (prev && outs.some((d)=> String(d.deviceId || "") === prev)) {
      elSpeakerSelect.value = prev;
    } else {
      elSpeakerSelect.value = "";
    }
    elSpeakerSelect.disabled = false;
    preferredSpeakerId = String(elSpeakerSelect.value || "");
    return outs;
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

  let gateAudioCtx = null;
  let gateTestAudioEl = null;
  function ensureGateTestAudioEl(){
    if (gateTestAudioEl) return gateTestAudioEl;
    const el = document.createElement("audio");
    el.preload = "auto";
    el.autoplay = false;
    el.style.display = "none";
    document.body.appendChild(el);
    gateTestAudioEl = el;
    return gateTestAudioEl;
  }
  async function playGateTestSound(){
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error("This browser does not support the sound test.");
    if (!gateAudioCtx) gateAudioCtx = new AudioCtx();
    if (gateAudioCtx.state === "suspended") await gateAudioCtx.resume();

    const audioEl = ensureGateTestAudioEl();
    const sinkId = String(elSpeakerSelect?.value || preferredSpeakerId || "").trim();
    if (sinkId && typeof audioEl.setSinkId === "function") {
      await audioEl.setSinkId(sinkId);
    }

    const dest = gateAudioCtx.createMediaStreamDestination();
    audioEl.srcObject = dest.stream;
    audioEl.muted = false;
    audioEl.volume = 1;
    await audioEl.play().catch(()=>{});

    const now = gateAudioCtx.currentTime;
    const gain = gateAudioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    gain.connect(dest);

    const osc = gateAudioCtx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.linearRampToValueAtTime(660, now + 0.22);
    osc.frequency.linearRampToValueAtTime(440, now + 0.45);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 0.6);
  }

  ({ buildRandomizedPayload, saveAnswers, restoreAnswers, wireAutosave } = createExamStateHelpers({
    token,
    LS_KEY,
    elContent,
    qsa,
    collectAnswers: ()=> collectAnswers(),
    choiceOrderByQ,
    itemOrderBySection,
  }));

  ({
    fullscreenRequired,
    isFullscreen,
    requestFullscreen,
    exitFullscreen,
    hasExtendedDisplay,
    showLock,
    hideLock,
    showTabToast,
    armAntiResetAndTabLock,
  } = createExamLockdownHelpers({
    qs,
    qsa,
    LS_KEY,
    getExamStarted: ()=> examStarted,
    getAntiResetArmed: ()=> antiResetArmed,
    setAntiResetArmed: (value)=> { antiResetArmed = value; },
    getTabViolations: ()=> tabViolations,
    setTabViolations: (value)=> { tabViolations = value; },
    MAX_TAB_VIOLATIONS,
    getAutoReason: ()=> autoReason,
    setAutoReason: (value)=> { autoReason = value; },
    pingPresence,
    captureAndUploadSnapshot: (reason)=> captureAndUploadSnapshot(reason),
    saveAnswers: ()=> saveAnswers(),
    doSubmit: (auto)=> doSubmit(auto),
  }));

  // Tab/window/app focus detection.
  // We count a violation when the user returns (tab becomes visible OR window regains focus)
  // so the warning is visible to them.
  let lastHiddenAt = 0;
  let lastBlurAt = 0;
  let lastViolationAt = 0; // debounce duplicate signals (e.g., blur + visibilitychange)

  async function registerFocusViolation(reason, awayMs){
    if (!examStarted) return;
    const now = Date.now();
    if (lastViolationAt && (now - lastViolationAt) < 600) return;
    lastViolationAt = now;

    tabViolations++;
    localStorage.setItem(LS_KEY("tabViolations"), String(tabViolations));
    try{ await pingPresence(reason || "focus_violation"); }catch(e){}
    scheduleReturnSnapshot(`return_after_${String(reason || "focus_violation")}`, 1000);

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
      clearReturnSnapshotTimer();
      lastHiddenAt = Date.now();
      await pingPresence("tab_hidden");
    }else{
      const awayMs = lastHiddenAt ? (Date.now() - lastHiddenAt) : 0;
      lastHiddenAt = 0;
      await registerFocusViolation("tab_visible", awayMs);
    }
  });

  window.addEventListener("blur", async ()=>{
    if (!examStarted) return;
    clearReturnSnapshotTimer();
    lastBlurAt = Date.now();
    await pingPresence("window_blur");
  });
  window.addEventListener("focus", async ()=>{
    if (!examStarted) return;
    const awayMs = lastBlurAt ? (Date.now() - lastBlurAt) : 0;
    lastBlurAt = 0;
    if (awayMs > 0 && !document.hidden){
      await pingPresence("window_focus_warning");
      showTabToast(
        "Keep the exam on your active screen.",
        "If you are using a second monitor, disconnect it and continue on one display only.",
        3000
      );
    }
  });

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
    if (e && (e.relatedTarget || e.toElement)) return;
    clearMouseOutTimer();
    mouseOutTimer = setTimeout(async ()=>{
      if (!examStarted) return;
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
 
           const fsOk = fullscreenRequired ? isFullscreen() : true;
           const displayOk = !hasExtendedDisplay();
           const ackOk = isProctoringAckSatisfied();
           const translationReason = detectTranslationViolation();
           const translationOk = !translationReason;
           if (stableMs >= 2000 && ratioOk && fsOk && ackOk && displayOk && translationOk){
              elStartExam.disabled = false;
              showGateNotice("Checks passed. You can start the exam.", "ok");
            }else{
              elStartExam.disabled = true;
             if (!ackOk){
               showGateNotice("Please acknowledge the Remote Proctoring Notice to start the exam.", "bad");
             } else if (!translationOk){
               showGateNotice(getPreStartTranslationBlockMessage(translationReason), "bad");
             } else if (!displayOk){
               showGateNotice("Please disconnect any second monitor and use one display only.", "bad");
             } else if (!fsOk){
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

  function enableCamMiniDrag() {
    if (!elCamMini) return;
    const header = elCamMini.querySelector(".camMiniHeader");
    if (!header) return;

    const POS_KEY = LS_KEY("camMini_pos_v1");

    const clamp = (v, min, max)=> Math.max(min, Math.min(max, v));

    const applyPos = (left, top)=>{
      const pad = 8;
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const rect = elCamMini.getBoundingClientRect();
      const maxLeft = Math.max(pad, vw - rect.width - pad);
      const maxTop = Math.max(pad, vh - rect.height - pad);

      const l = clamp(Math.round(left), pad, maxLeft);
      const t = clamp(Math.round(top), pad, maxTop);

      elCamMini.style.left = `${l}px`;
      elCamMini.style.top = `${t}px`;
      elCamMini.style.right = "auto";
      elCamMini.style.bottom = "auto";

      try{ localStorage.setItem(POS_KEY, JSON.stringify({ left: l, top: t })); }catch(e){}
    };

    const restorePos = ()=>{
      let obj = null;
      try { obj = JSON.parse(String(localStorage.getItem(POS_KEY) || "")); } catch {}
      if (!obj || !Number.isFinite(Number(obj.left)) || !Number.isFinite(Number(obj.top))) return;
      applyPos(Number(obj.left), Number(obj.top));
    };

    restorePos();

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    const onDown = (e)=>{
      if (!e) return;
      if (e.button !== undefined && e.button !== 0) return;

      const rect = elCamMini.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      startX = Number(e.clientX || 0);
      startY = Number(e.clientY || 0);
      dragging = true;

      try{ header.setPointerCapture?.(e.pointerId); }catch(e2){}
      try{ e.preventDefault(); }catch(e2){}
    };

    const onMove = (e)=>{
      if (!dragging) return;
      const x = Number(e.clientX || 0);
      const y = Number(e.clientY || 0);
      const dx = x - startX;
      const dy = y - startY;
      applyPos(startLeft + dx, startTop + dy);
    };

    const onUp = (e)=>{
      if (!dragging) return;
      dragging = false;
      try{ header.releasePointerCapture?.(e.pointerId); }catch(e2){}
    };

    header.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("resize", ()=>{
      const rect = elCamMini.getBoundingClientRect();
      applyPos(rect.left, rect.top);
    });
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
    if (elCamMiniText) elCamMiniText.textContent = "Checking...";
    if (elCamMiniDot) elCamMiniDot.classList.remove("ok");

    let missingSince = 0;
    let fsMissingSince = 0;
    let lastViolationAt = 0;
    let camWasOff = false;
    let fsWasOff = false;
    let faceWasMissing = false;
    let faceReturnSnapshotTimer = null;
    let captureFaceReturnSnapshot = false;

    // IMPORTANT: after the candidate clicks "Start exam", the gate block is hidden.
    // Many browsers reduce or stop frame updates for videos that are display:none.
    // Use the always-visible mini preview for reliable face detection during the exam.
    const detectVideoEl = elVideoMini || elVideo;
    try{ await detectVideoEl.play?.(); }catch(e){}
    const detector = await createFaceDetector(detectVideoEl);
    await pingPresence(`proctoring_on_${detector.type}`);

    const loop = async ()=>{
      if (!examStarted) return;

      // Fullscreen enforcement during the exam (desktop only)
      if (fullscreenRequired) {
        const fsOk = isFullscreen();
        if (!fsOk){
          if (!fsWasOff) {
            fsWasOff = true;
            clearReturnSnapshotTimer();
          }
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
        if (fsWasOff) scheduleReturnSnapshot("return_after_fullscreen_off_during_exam", 1000);
        fsWasOff = false;
        fsMissingSince = 0;

        // If we were showing a fullscreen warning, clear it immediately when fullscreen is back.
        try{
          if (lockOverlay && lockOverlay.style.display !== "none"){
            const msg = (lockMsgEl?.textContent || "").toLowerCase();
            if (msg.includes("fullscreen is required")) hideLock();
          }
        }catch(e){}
      }

      const track = stream?.getVideoTracks?.()[0];
      const camLive = track && track.readyState === "live" && track.enabled !== false;
      if (!camLive){
        camWasOff = true;
        captureFaceReturnSnapshot = true;
        if (faceReturnSnapshotTimer) {
          clearTimeout(faceReturnSnapshotTimer);
          faceReturnSnapshotTimer = null;
        }
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
          const shouldScheduleReturnShot = captureFaceReturnSnapshot || faceWasMissing || camWasOff;
          faceWasMissing = false;
          if (elCamMiniText) elCamMiniText.textContent = "Face detected";
          if (elCamMiniDot) elCamMiniDot.classList.add("ok");
          hideLock();
          if (camWasOff){
            camWasOff = false;
          }
          if (shouldScheduleReturnShot && !faceReturnSnapshotTimer){
            faceReturnSnapshotTimer = setTimeout(()=>{
              faceReturnSnapshotTimer = null;
              if (!examStarted) return;
              captureFaceReturnSnapshot = false;
              void captureAndUploadSnapshot("face_return_after_missing");
            }, 2000);
          }
          return;
        }
        if (!faceWasMissing) {
          faceWasMissing = true;
          captureFaceReturnSnapshot = true;
          if (faceReturnSnapshotTimer) {
            clearTimeout(faceReturnSnapshotTimer);
            faceReturnSnapshotTimer = null;
          }
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
      if (faceReturnSnapshotTimer) clearTimeout(faceReturnSnapshotTimer);
      try{ detector.stop(); }catch(e){}
      stopProctoring = null;
    };
  }

  function renderTest(payload){
    renderExamTest(payload, {
      token,
      LS_KEY,
      elContent,
      showStatus,
      hardenNoTranslateTree,
      registerCanvasTextBlock,
      clearCanvasTextBlocks,
      queueCanvasTextRender,
      getSectionKind,
      showSection,
      saveAnswers,
      restoreAnswers,
      resetSectionViews: ()=>{
        sectionViews = [];
        currentSectionIdx = 0;
      },
      appendSectionView: (view)=>{
        sectionViews.push(view);
      },
      getCurrentSectionIdx: ()=> currentSectionIdx,
    });
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
      clearReturnSnapshotTimer();
      try{ if (stopProctoring) stopProctoring(); }catch(e){}
      try{ if (stopPreStartTranslationGuard) stopPreStartTranslationGuard(); }catch(e){}
      try{ if (stopTranslationGuard) stopTranslationGuard(); }catch(e){}
      stopCamera();
      if (elCamMini) elCamMini.style.display = "none";
    } finally {
      submitInFlight = false;
    }
  }

  elSubmit.addEventListener("click", async ()=>{
    const ok = await uiConfirm("Are you sure you want to submit your test?", {
      title: "Submit Test",
      yesText: "OK",
      noText: "Cancel",
    });
    if (!ok) return;
    elSubmit.disabled = true;
    try{ await doSubmit(false); }
    finally{ elSubmit.disabled = false; }
  });

  async function boot(){
    // Gate + session come from the token endpoint (per exam period).
    const first = await apiGet(`/api/session/${encodeURIComponent(token)}`);
    const cfg = await apiGet("/api/config").catch(()=> ({}));
    applyProctoringConfig(cfg && cfg.proctoring ? cfg.proctoring : null);
    hardenCameraVideoEl(elVideo);
    hardenCameraVideoEl(elVideoMini);
    installCanvasTextAutoResize();
    hardenNoTranslateTree(document.documentElement);
    hardenNoTranslateTree(document.body);
    hardenNoTranslateTree(elGate);
    hardenNoTranslateTree(elContent);
    enableCamMiniDrag();

    proctoringAckedServer = !!(first && first.session && first.session.proctoringAcked);
    if (elProctoringAck){
      try { elProctoringAck.checked = false; elProctoringAck.disabled = false; } catch {}
    }

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
    armPreStartTranslationGuard();
    preferredCameraId = readPreferredCameraId();
    preferredSpeakerId = readPreferredSpeakerId();
    await listVideoInputs(false).catch(()=>[]);
    await listAudioOutputs(false).catch(()=>[]);
    if (elCamSelect) elCamSelect.value = preferredCameraId || "";
    if (elSpeakerSelect && !elSpeakerSelect.disabled) elSpeakerSelect.value = preferredSpeakerId || "";

    if (elRefreshCams){
      elRefreshCams.addEventListener("click", async ()=>{
        try{
          elRefreshCams.disabled = true;
          await listVideoInputs(true);
          await listAudioOutputs(true);
          showGateNotice("Camera list refreshed.", "");
        }catch{
          showGateNotice("Could not read device list.", "bad");
        }finally{
          elRefreshCams.disabled = false;
        }
      });
    }

    if (elProctoringReadMore && elProctoringLongNotice){
      const setLongOpen = (open)=>{
        elProctoringLongNotice.style.display = open ? "block" : "none";
        elProctoringReadMore.textContent = open ? "Hide details" : "Read here";
      };
      setLongOpen(false);
      elProctoringReadMore.addEventListener("click", ()=>{
        const open = elProctoringLongNotice.style.display !== "none";
        setLongOpen(!open);
      });
    }

    if (elProctoringAck){
      elProctoringAck.addEventListener("change", ()=>{
        if (!isProctoringAckSatisfied()) {
          elStartExam.disabled = true;
          showGateNotice("Please acknowledge the Remote Proctoring Notice to start the exam.", "bad");
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

    if (elSpeakerSelect){
      elSpeakerSelect.addEventListener("change", ()=>{
        preferredSpeakerId = String(elSpeakerSelect.value || "");
        writePreferredSpeakerId(preferredSpeakerId);
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

    const onFsChange = ()=>{
      if (!elGate || elGate.style.display === "none") return;
      if (!fullscreenRequired) return;
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
        await listAudioOutputs(true).catch(()=>[]);
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

    elTestSound?.addEventListener("click", async ()=>{
      if (elTestSound) elTestSound.disabled = true;
      try{
        await playGateTestSound();
        const speakerName = (()=> {
          const opt = elSpeakerSelect?.options?.[elSpeakerSelect.selectedIndex];
          return String(opt?.textContent || "selected output").trim();
        })();
        showTestSoundStatus(`Sound test played on ${speakerName}. If you did not hear it, check your speakers or headphones.`, "ok");
      }catch(e){
        showTestSoundStatus(String(e?.message || e || "Sound test failed."), "bad");
      }finally{
        if (elTestSound) {
          setTimeout(()=>{ elTestSound.disabled = false; }, 250);
        }
      }
    });

    elStartExam.addEventListener("click", async ()=>{
      elStartExam.disabled = true;
      try{
        const translationReason = detectTranslationViolation();
        if (translationReason){
          showGateNotice(getPreStartTranslationBlockMessage(translationReason), "bad");
          return;
        }
        if (hasExtendedDisplay()){
          showGateNotice("Please disconnect any second monitor and use one display only.", "bad");
          return;
        }
        if (fullscreenRequired && !isFullscreen()){
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

        await ensureProctoringAckRecorded();

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
        armTranslationGuard();
        await startCameraPresenceProctoring();
        // First frame is often black immediately after starting; delay snapshot slightly.
        setTimeout(() => { void captureAndUploadSnapshot("exam_start"); }, 5000);
        startTimerAbsolute(endAt, nowServer);
      }catch(e){
        showGateNotice(String(e.message || e), "bad");
        elStartExam.disabled = false;
      }
    });

    showGateNotice("Disable any translation program or extension for this site, then click Enable camera. Time is already running.", "");
  }

  boot().catch((e)=>{
    elTitle.textContent = "Cannot load exam";
    showStatus(String(e.message || e), "bad");
  });

