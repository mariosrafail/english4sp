export function createExamFlowHelpers(ctx){
  const {
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
    applyProctoringConfig,
    hardenCameraVideoEl,
    enableCamMiniDrag,
    armPreStartTranslationGuard,
    readPreferredCameraId,
    readPreferredSpeakerId,
    listVideoInputs,
    listAudioOutputs,
    writePreferredCameraId,
    writePreferredSpeakerId,
    playGateTestSound,
    showTestSoundStatus,
    requestFullscreen,
    isFullscreen,
    pingPresence,
    detectTranslationViolation,
    getPreStartTranslationBlockMessage,
    hasExtendedDisplay,
    ensureProctoringAckRecorded,
    armAntiResetAndTabLock,
    renderTest,
    wireAutosave,
    armTranslationGuard,
    startCameraPresenceProctoring,
    captureAndUploadSnapshot,
    stopCamera,
    initCamera,
    startFaceGate,
    clearReturnSnapshotTimer,
    hideLock,
    stopTranslationGuard,
    stopPreStartTranslationGuard,
    stopCameraPresenceProctoring,
    exitFullscreen,
    buildRandomizedPayload,
    collectAnswers,
    getAutoReason,
    setAutoReason,
    getSessionData,
    setSessionData,
    getRandomizedPayload,
    setRandomizedPayload,
    getSubmitInFlight,
    setSubmitInFlight,
    getExamStarted,
    setExamStarted,
    getTimerId,
    setTimerId,
    getTimerAutoSubmit,
    setTimerAutoSubmit,
    getPreferredCameraId,
    setPreferredCameraId,
    getPreferredSpeakerId,
    setPreferredSpeakerId,
    getProctoringAckedServer,
    setProctoringAckedServer,
    isProctoringAckSatisfied,
    fullscreenRequired,
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
  } = ctx || {};

  function showFinalScreen(disqualified){
    setExamStarted(false);

    try{
      const timerId = getTimerId();
      if (timerId) clearInterval(timerId);
    }catch(e){}
    try{ exitFullscreen(); }catch(e){}

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

  function startTimerAbsolute(endAtUtcMs, nowServer){
    const targetEnd = Number(endAtUtcMs || 0);
    localStorage.setItem(LS_KEY("endAt"), String(targetEnd));

    const tick = async ()=>{
      const left = Math.max(0, Math.ceil((targetEnd - nowServer()) / 1000));
      elTimer.textContent = fmtTime(left);

      if (left <= 0){
        const timerId = getTimerId();
        clearInterval(timerId);
        if (getTimerAutoSubmit()){
          showStatus("Time is up. Submitting...", "bad");
          setAutoReason("time_up");
          try{ await ctx.doSubmitRef.current(true); }catch(e){ showStatus(String(e.message || e), "bad"); }
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
    const timerId = getTimerId();
    if (timerId) clearInterval(timerId);
    setTimerId(setInterval(tick, 250));
  }

  async function doSubmit(auto = false){
    if (getSubmitInFlight()) return;
    setSubmitInFlight(true);
    if (localStorage.getItem(LS_KEY("submitted")) === "1"){
      showStatus("Already submitted.", "ok");
      elSubmit.style.display = "none";
      setSubmitInFlight(false);
      return;
    }
    const answers = collectAnswers();
    const clientMeta = { userAgent: navigator.userAgent, auto, ts: Date.now() };
    if (auto && getAutoReason()) clientMeta.reason = getAutoReason();
    try{
      const r = await apiPost(`/api/session/${encodeURIComponent(token)}/submit`, { answers, clientMeta });
      localStorage.setItem(LS_KEY("submitted"), "1");
      elSubmit.style.display = "none";
      const disqualified = !!(r && r.disqualified) || /disqual/i.test(String(getAutoReason() || ""));
      showFinalScreen(disqualified);
      hideLock();
      clearReturnSnapshotTimer();
      try{ stopCameraPresenceProctoring(); }catch(e){}
      try{ if (stopPreStartTranslationGuard) stopPreStartTranslationGuard(); }catch(e){}
      try{ if (stopTranslationGuard) stopTranslationGuard(); }catch(e){}
      stopCamera();
      if (elCamMini) elCamMini.style.display = "none";
    } finally {
      setSubmitInFlight(false);
    }
  }

  async function boot(){
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

    setProctoringAckedServer(!!(first && first.session && first.session.proctoringAcked));
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

      setSessionData(await apiGet(`/api/session/${encodeURIComponent(token)}`));
    } else {
      setSessionData(first);
    }

    const sessionData = getSessionData();
    if (sessionData && sessionData.session && sessionData.session.submitted){
      showFinalScreen(!!sessionData.session.disqualified);
      return;
    }

    setRandomizedPayload(buildRandomizedPayload(sessionData.test.payload));
    const randomizedPayload = getRandomizedPayload();

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

    setTimerAutoSubmit(false);
    if (endAt) startTimerAbsolute(endAt, nowServer);

    if (localStorage.getItem(LS_KEY("submitted")) === "1"){
      showStatus("This device already submitted this token.", "bad");
    }

    let stopGateLoop = null;
    armPreStartTranslationGuard();
    setPreferredCameraId(readPreferredCameraId());
    setPreferredSpeakerId(readPreferredSpeakerId());
    await listVideoInputs(false).catch(()=>[]);
    await listAudioOutputs(false).catch(()=>[]);
    if (elCamSelect) elCamSelect.value = getPreferredCameraId() || "";
    if (elSpeakerSelect && !elSpeakerSelect.disabled) elSpeakerSelect.value = getPreferredSpeakerId() || "";

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
        setPreferredCameraId(String(elCamSelect.value || ""));
        writePreferredCameraId(getPreferredCameraId());

        if (!ctx.getStream()) return;
        try{
          if (stopGateLoop) stopGateLoop();
          await initCamera(getPreferredCameraId());
          stopGateLoop = await startFaceGate();
          showGateNotice("Camera switched.", "ok");
        }catch(e){
          showGateNotice("Could not switch camera. Try another device.", "bad");
        }
      });
    }

    if (elSpeakerSelect){
      elSpeakerSelect.addEventListener("change", ()=>{
        setPreferredSpeakerId(String(elSpeakerSelect.value || ""));
        writePreferredSpeakerId(getPreferredSpeakerId());
      });
    }

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
    window.addEventListener("resize", onFsChange);

    elEnableCam.addEventListener("click", async ()=>{
      elEnableCam.disabled = true;
      try{
        const camId = elCamSelect ? String(elCamSelect.value || getPreferredCameraId() || "") : getPreferredCameraId();
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
        setTimerAutoSubmit(true);

        await apiPost(`/api/session/${encodeURIComponent(token)}/start`, {});
        await pingPresence("exam_started");

        elGate.style.display = "none";
        elContent.style.display = "block";
        elSubmit.style.display = "block";
        setExamStarted(true);
        armAntiResetAndTabLock();
        renderTest(getRandomizedPayload());
        wireAutosave();
        armTranslationGuard();
        await startCameraPresenceProctoring();
        setTimeout(() => { void captureAndUploadSnapshot("exam_start"); }, 5000);
        startTimerAbsolute(endAt, nowServer);
      }catch(e){
        showGateNotice(String(e.message || e), "bad");
        elStartExam.disabled = false;
      }
    });

    showGateNotice("Disable any translation program or extension for this site, then click Enable camera. Time is already running.", "");
  }

  return {
    showFinalScreen,
    startTimerAbsolute,
    doSubmit,
    boot,
  };
}
