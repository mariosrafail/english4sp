import { qs, qsa, apiGet, apiPost, fmtTime, escapeHtml, nowMs, uiConfirm } from "/app.js";
import { hardenNoTranslateTree, registerCanvasTextBlock, clearCanvasTextBlocks, queueCanvasTextRender, installCanvasTextAutoResize } from "/exam/text-canvas.js";
import { renderExamTest } from "/exam/renderers.js";
import { createExamStateHelpers } from "/exam/state.js";
import { createExamProctoringHelpers } from "/exam/proctoring.js";
import { createExamLockdownHelpers } from "/exam/lockdown.js";
import { createExamCameraHelpers } from "/exam/camera.js";
import { createExamTranslationHelpers } from "/exam/translation.js";
import { createExamFlowHelpers } from "/exam/flow.js";
import { createExamFocusHelpers } from "/exam/focus.js";
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
  let preferredCameraId = "";
  let preferredSpeakerId = "";
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
  let readPreferredCameraId = ()=> "";
  let writePreferredCameraId = ()=> {};
  let readPreferredSpeakerId = ()=> "";
  let writePreferredSpeakerId = ()=> {};
  let listVideoInputs = async ()=> [];
  let listAudioOutputs = async ()=> [];
  let playGateTestSound = async ()=> {};
  let startFaceGate = async ()=> ()=>{};
  let initCamera = async ()=> {};
  let stopCamera = ()=> {};
  let enableCamMiniDrag = ()=> {};
  let startCameraPresenceProctoring = async ()=> {};
  let stopCameraPresenceProctoring = ()=> {};
  let detectTranslationViolation = ()=> "";
  let triggerTranslationViolation = async ()=> {};
  let getPreStartTranslationBlockMessage = ()=> "";
  let armTranslationGuard = ()=> {};
  let armPreStartTranslationGuard = ()=> {};
  let showFinalScreen = ()=> {};
  let startTimerAbsolute = ()=> {};
  let doSubmit = async ()=> {};
  let boot = async ()=> {};
  let armFocusMonitoring = ()=> {};

  const startTimerAbsoluteRef = { current: (...args)=> startTimerAbsolute(...args) };
  const doSubmitRef = { current: (...args)=> doSubmit(...args) };


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

  ({
    readPreferredCameraId,
    writePreferredCameraId,
    readPreferredSpeakerId,
    writePreferredSpeakerId,
    listVideoInputs,
    listAudioOutputs,
    playGateTestSound,
    startFaceGate,
    initCamera,
    stopCamera,
    enableCamMiniDrag,
    startCameraPresenceProctoring,
    stopCameraPresenceProctoring,
  } = createExamCameraHelpers({
    LS_KEY,
    escapeHtml,
    nowMs,
    pingPresence,
    showGateNotice,
    getPreStartTranslationBlockMessage,
    detectTranslationViolation,
    isProctoringAckSatisfied: ()=> isProctoringAckSatisfied(),
    fullscreenRequired: ()=> fullscreenRequired,
    isFullscreen: ()=> isFullscreen(),
    hasExtendedDisplay: ()=> hasExtendedDisplay(),
    clearReturnSnapshotTimer: ()=> clearReturnSnapshotTimer(),
    scheduleReturnSnapshot: (reason, delayMs)=> scheduleReturnSnapshot(reason, delayMs),
    showLock: (msg, detail, opts)=> showLock(msg, detail, opts),
    hideLock: ()=> hideLock(),
    captureAndUploadSnapshot: (reason)=> captureAndUploadSnapshot(reason),
    doSubmit: (auto)=> doSubmit(auto),
    getExamStarted: ()=> examStarted,
    setAutoReason: (value)=> { autoReason = value; },
    getStream: ()=> stream,
    setStream: (value)=> { stream = value; },
    getPresenceInterval: ()=> presenceInterval,
    setPresenceInterval: (value)=> { presenceInterval = value; },
    getFaceViolations: ()=> faceViolations,
    setFaceViolations: (value)=> { faceViolations = value; },
    FACE_MISSING_AUTO_SUBMIT_MS,
    FULLSCREEN_MISSING_AUTO_SUBMIT_MS,
    elStartExam,
    elFaceHint,
    elFaceOverlay,
    elCamSelect,
    elSpeakerSelect,
    elVideo,
    elVideoMini,
    elCamMini,
    elCamMiniDot,
    elCamMiniText,
  }));

  ({
    detectTranslationViolation,
    triggerTranslationViolation,
    getPreStartTranslationBlockMessage,
    armTranslationGuard,
    armPreStartTranslationGuard,
    stopTranslationGuard,
    stopPreStartTranslationGuard,
  } = createExamTranslationHelpers({
    getExamStarted: ()=> examStarted,
    getTranslationViolationTriggered: ()=> translationViolationTriggered,
    setTranslationViolationTriggered: (value)=> { translationViolationTriggered = value; },
    pingPresence,
    captureAndUploadSnapshot: (reason)=> captureAndUploadSnapshot(reason),
    showLock: (msg, detail, opts)=> showLock(msg, detail, opts),
    setAutoReason: (value)=> { autoReason = value; },
    doSubmit: (auto)=> doSubmit(auto),
    elGate,
    elStartExam,
    showGateNotice,
  }));

  ({
    showFinalScreen,
    startTimerAbsolute,
    doSubmit,
    boot,
  } = createExamFlowHelpers({
    token,
    qs,
    qsa,
    apiGet,
    apiPost,
    fmtTime,
    fmtLocalStamp,
    hardenNoTranslateTree,
    installCanvasTextAutoResize,
    showStatus,
    showGateNotice,
    showTestSoundStatus,
    applyProctoringConfig,
    hardenCameraVideoEl,
    enableCamMiniDrag: ()=> enableCamMiniDrag(),
    armPreStartTranslationGuard: ()=> armPreStartTranslationGuard(),
    readPreferredCameraId: ()=> readPreferredCameraId(),
    readPreferredSpeakerId: ()=> readPreferredSpeakerId(),
    listVideoInputs: (keepSelection)=> listVideoInputs(keepSelection),
    listAudioOutputs: (keepSelection)=> listAudioOutputs(keepSelection),
    writePreferredCameraId: (value)=> writePreferredCameraId(value),
    writePreferredSpeakerId: (value)=> writePreferredSpeakerId(value),
    playGateTestSound: ()=> playGateTestSound(),
    showTestSoundStatus,
    requestFullscreen: ()=> requestFullscreen(),
    isFullscreen: ()=> isFullscreen(),
    pingPresence,
    detectTranslationViolation: ()=> detectTranslationViolation(),
    getPreStartTranslationBlockMessage: (reason)=> getPreStartTranslationBlockMessage(reason),
    hasExtendedDisplay: ()=> hasExtendedDisplay(),
    ensureProctoringAckRecorded: ()=> ensureProctoringAckRecorded(),
    armAntiResetAndTabLock: ()=> armAntiResetAndTabLock(),
    renderTest: (payload)=> renderTest(payload),
    wireAutosave: ()=> wireAutosave(),
    armTranslationGuard: ()=> armTranslationGuard(),
    startCameraPresenceProctoring: ()=> startCameraPresenceProctoring(),
    captureAndUploadSnapshot: (reason)=> captureAndUploadSnapshot(reason),
    stopCamera: ()=> stopCamera(),
    initCamera: (deviceId)=> initCamera(deviceId),
    startFaceGate: ()=> startFaceGate(),
    clearReturnSnapshotTimer: ()=> clearReturnSnapshotTimer(),
    hideLock: ()=> hideLock(),
    stopTranslationGuard: ()=> stopTranslationGuard(),
    stopPreStartTranslationGuard: ()=> stopPreStartTranslationGuard(),
    stopCameraPresenceProctoring: ()=> stopCameraPresenceProctoring(),
    exitFullscreen: ()=> exitFullscreen(),
    buildRandomizedPayload: (payload)=> buildRandomizedPayload(payload),
    collectAnswers: ()=> collectAnswers(),
    getAutoReason: ()=> autoReason,
    setAutoReason: (value)=> { autoReason = value; },
    getSessionData: ()=> sessionData,
    setSessionData: (value)=> { sessionData = value; },
    getRandomizedPayload: ()=> randomizedPayload,
    setRandomizedPayload: (value)=> { randomizedPayload = value; },
    getSubmitInFlight: ()=> submitInFlight,
    setSubmitInFlight: (value)=> { submitInFlight = value; },
    getExamStarted: ()=> examStarted,
    setExamStarted: (value)=> { examStarted = value; },
    getTimerId: ()=> timerId,
    setTimerId: (value)=> { timerId = value; },
    getTimerAutoSubmit: ()=> timerAutoSubmit,
    setTimerAutoSubmit: (value)=> { timerAutoSubmit = value; },
    getPreferredCameraId: ()=> preferredCameraId,
    setPreferredCameraId: (value)=> { preferredCameraId = value; },
    getPreferredSpeakerId: ()=> preferredSpeakerId,
    setPreferredSpeakerId: (value)=> { preferredSpeakerId = value; },
    getProctoringAckedServer: ()=> proctoringAckedServer,
    setProctoringAckedServer: (value)=> { proctoringAckedServer = value; },
    isProctoringAckSatisfied: ()=> isProctoringAckSatisfied(),
    fullscreenRequired,
    getStream: ()=> stream,
    doSubmitRef,
    elTitle,
    elExamFlowText,
    elCandidate,
    elTimer,
    elContent,
    elSubmit,
    elStatus,
    elGate,
    elEnableCam,
    elTestSound,
    elGoFullscreen,
    elStartExam,
    elFaceHint,
    elCamSelect,
    elSpeakerSelect,
    elRefreshCams,
    elProctoringReadMore,
    elProctoringLongNotice,
    elProctoringAck,
    elVideo,
    elVideoMini,
    elCamMini,
    LS_KEY,
  }));

  ({
    armFocusMonitoring,
  } = createExamFocusHelpers({
    LS_KEY,
    getExamStarted: ()=> examStarted,
    getTabViolations: ()=> tabViolations,
    setTabViolations: (value)=> { tabViolations = value; },
    MAX_TAB_VIOLATIONS,
    pingPresence,
    scheduleReturnSnapshot: (reason, delayMs)=> scheduleReturnSnapshot(reason, delayMs),
    clearReturnSnapshotTimer: ()=> clearReturnSnapshotTimer(),
    showTabToast: (title, body, ms)=> showTabToast(title, body, ms),
    setAutoReason: (value)=> { autoReason = value; },
    doSubmit: (auto)=> doSubmit(auto),
  }));

  armFocusMonitoring();

  // when auto-submitting, include a simple reason tag for the server logs
  let autoReason = "";

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

  boot().catch((e)=>{
    elTitle.textContent = "Cannot load exam";
    showStatus(String(e.message || e), "bad");
  });


