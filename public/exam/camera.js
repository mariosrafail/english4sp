export function createExamCameraHelpers(ctx){
  const {
    LS_KEY,
    escapeHtml,
    nowMs,
    pingPresence,
    showGateNotice,
    getPreStartTranslationBlockMessage,
    detectTranslationViolation,
    isProctoringAckSatisfied,
    fullscreenRequired,
    isFullscreen,
    isFullscreenGraceActive,
    hasExtendedDisplay,
    clearReturnSnapshotTimer,
    scheduleReturnSnapshot,
    showLock,
    hideLock,
    captureAndUploadSnapshot,
    doSubmit,
    getExamStarted,
    setAutoReason,
    getStream,
    setStream,
    getPresenceInterval,
    setPresenceInterval,
    getFaceViolations,
    setFaceViolations,
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
  } = ctx || {};

  const PREF_CAM_KEY = "exam_preferred_camera";
  const PREF_SPK_KEY = "exam_preferred_speaker";

  let preferredCameraId = "";
  let preferredSpeakerId = "";
  let gateAudioCtx = null;
  let gateTestAudioEl = null;
  let stopFaceLoop = null;
  let stopProctoring = null;

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

  async function createFaceDetector(videoEl){
    if ("FaceDetector" in window){
      try{
        const fd = new FaceDetector({ fastMode:true, maxDetectedFaces: 1 });
        await fd.detect(videoEl);
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
      } catch {}
    }

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
        await new Promise((r)=> setTimeout(r, 160));
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
        const ratio = Math.max(0, w * h);
        return { ok:true, ratio };
      },
      stop: ()=>{
        running = false;
        try{ faceDetection.close(); }catch(e){}
      }
    };
  }

  async function initCamera(deviceId){
    const existingPresence = getPresenceInterval();
    if (existingPresence) clearInterval(existingPresence);
    try{ getStream()?.getTracks?.().forEach((t)=> t.stop()); }catch(e){}
    setStream(null);

    const id = String(deviceId || "").trim();
    let constraints = { video: true, audio: false };
    if (id) constraints = { video: { deviceId: { exact: id } }, audio: false };

    let nextStream;
    try{
      nextStream = await navigator.mediaDevices.getUserMedia(constraints);
    }catch(e){
      if (!id) throw e;
      nextStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:false });
    }

    setStream(nextStream);
    elVideo.srcObject = nextStream;
    if (elVideoMini) elVideoMini.srcObject = nextStream;
    await pingPresence("camera_on");
    await listVideoInputs(true).catch(()=> []);

    const intervalId = setInterval(async ()=>{
      const track = getStream()?.getVideoTracks?.()[0];
      const on = track && track.readyState === "live";
      await pingPresence(on ? "camera_on" : "camera_off");
    }, 15000);
    setPresenceInterval(intervalId);
  }

  async function startFaceGate(){
    elStartExam.disabled = true;
    let faceOkSince = 0;

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
          const fsOk = fullscreenRequired() ? isFullscreen() : true;
          const displayOk = !hasExtendedDisplay();
          const ackOk = isProctoringAckSatisfied();
          const translationReason = detectTranslationViolation();
          const translationOk = !translationReason;
          if (stableMs >= 2000 && ratioOk && fsOk && ackOk && displayOk && translationOk){
            elStartExam.disabled = false;
            showGateNotice("Checks passed. You can start the exam.", "ok");
          } else {
            elStartExam.disabled = true;
            if (!ackOk){
              showGateNotice("Please acknowledge the Remote Proctoring Notice to start the exam.", "bad");
            } else if (!translationOk){
              showGateNotice(getPreStartTranslationBlockMessage(translationReason), "bad");
            } else if (!displayOk){
              showGateNotice("Please disconnect any second monitor and use one display only.", "bad");
            } else if (!fsOk){
              showGateNotice("Please enter fullscreen to start the exam.", "bad");
            } else {
              showGateNotice("Hold still. Keep your face closer to the camera.", "");
            }
          }
        } else {
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

  function stopCamera(){
    const existingPresence = getPresenceInterval();
    if (existingPresence) clearInterval(existingPresence);
    setPresenceInterval(null);
    try{ getStream()?.getTracks?.().forEach((t)=> t.stop()); }catch(e){}
    setStream(null);
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

  async function startCameraPresenceProctoring(){
    if (!getStream()) return;
    if (stopProctoring) return;

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

    const detectVideoEl = elVideoMini || elVideo;
    try{ await detectVideoEl.play?.(); }catch(e){}
    const detector = await createFaceDetector(detectVideoEl);
    await pingPresence(`proctoring_on_${detector.type}`);

    const loop = async ()=>{
      if (!getExamStarted()) return;

      if (fullscreenRequired()) {
        const fsOk = isFullscreen();
        if (!fsOk){
          if (typeof isFullscreenGraceActive === "function" && isFullscreenGraceActive()){
            fsMissingSince = 0;
            fsWasOff = false;
            if (elCamMiniText) elCamMiniText.textContent = "Checking...";
            if (elCamMiniDot) elCamMiniDot.classList.remove("ok");
            hideLock(true);
            return;
          }
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
            setAutoReason("disqual_fullscreen_10s");
            await doSubmit(true);
          }
          return;
        }
        if (fsWasOff) scheduleReturnSnapshot("return_after_fullscreen_off_during_exam", 1000);
        fsWasOff = false;
        fsMissingSince = 0;
      }

      const track = getStream()?.getVideoTracks?.()[0];
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
              if (!getExamStarted()) return;
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
        if (elCamMiniText) elCamMiniText.textContent = `Look at screen (${leftS}s)`;
        if (elCamMiniDot) elCamMiniDot.classList.remove("ok");
        showLock(
          "Look at the screen.",
          `Please keep your face inside the camera frame. Time remaining: ${leftS} seconds`
        );

        if (missMs >= 3000 && (Date.now() - lastViolationAt) > 4000){
          lastViolationAt = Date.now();
          setFaceViolations(getFaceViolations() + 1);
          await pingPresence("face_missing_during_exam");
        }

        if (missMs >= FACE_MISSING_AUTO_SUBMIT_MS){
          await pingPresence("face_missing_auto_submit");
          setAutoReason("face_missing_10s");
          await doSubmit(true);
        }
      }
    };

    const id = setInterval(loop, 180);
    await loop();

    stopProctoring = ()=>{
      clearInterval(id);
      if (faceReturnSnapshotTimer) clearTimeout(faceReturnSnapshotTimer);
      try{ detector.stop(); }catch(e){}
      stopProctoring = null;
    };
  }

  function stopCameraPresenceProctoring(){
    if (!stopProctoring) return;
    stopProctoring();
  }

  function getPreferredCameraId(){
    return preferredCameraId;
  }

  function setPreferredCameraId(value){
    preferredCameraId = String(value || "");
  }

  function getPreferredSpeakerId(){
    return preferredSpeakerId;
  }

  function setPreferredSpeakerId(value){
    preferredSpeakerId = String(value || "");
  }

  return {
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
    getPreferredCameraId,
    setPreferredCameraId,
    getPreferredSpeakerId,
    setPreferredSpeakerId,
  };
}
