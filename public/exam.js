import { qs, qsa, apiGet, apiPost, fmtTime, escapeHtml, nowMs } from "/app.js";

  const params = new URLSearchParams(location.search);
  const token = (params.get("token") || "").trim();

  const elTitle = qs("#title");
  const elCandidate = qs("#candidate");
  const elTimer = qs("#timer");
  const elContent = qs("#content");
  const elSubmit = qs("#submit");
  const elStatus = qs("#status");

  const elGate = qs("#gate");
  const elEnableCam = qs("#enableCam");
  const elStartExam = qs("#startExam");
  const elGateNotice = qs("#gateNotice");
  const elVideo = qs("#video");
  const elFaceOverlay = qs("#faceOverlay");
  const elFaceHint = qs("#faceHint");

  const LS_KEY = (k)=> `exam_${token}_${k}`;

  function fmtUtcStamp(ms){
    const d = new Date(Number(ms));
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const pad = (n)=> String(n).padStart(2,'0');
    const dd = pad(d.getUTCDate());
    const mon = months[d.getUTCMonth()];
    const yyyy = d.getUTCFullYear();
    const hh = pad(d.getUTCHours());
    const mm = pad(d.getUTCMinutes());
    return `${dd} ${mon} ${yyyy}, ${hh}:${mm} UTC`;
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

  let faceOkSince = 0;
  let stopFaceLoop = null;

  async function pingPresence(status){
    try { await apiPost(`/api/session/${encodeURIComponent(token)}/presence`, { status }); } catch(e){}
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

  async function initCamera(){
    stream = await navigator.mediaDevices.getUserMedia({ video:true, audio:false });
    elVideo.srcObject = stream;
    await pingPresence("camera_on");

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

          if (stableMs >= 2000 && ratioOk){
            elStartExam.disabled = false;
            showGateNotice("Checks passed. You can start the exam.", "ok");
          }else{
            elStartExam.disabled = true;
            showGateNotice("Hold still. Keep your face closer to the camera.", "");
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

  function stopCamera(){
    if (presenceInterval) clearInterval(presenceInterval);
    try{ stream?.getTracks?.().forEach(t=>t.stop()); }catch(e){}
    stream = null;
  }

  function renderTest(payload){
    elContent.innerHTML = "";
    for (const sec of payload.sections || []){
      const secEl = document.createElement("div");
      secEl.className = "section";
      secEl.innerHTML = `<h2>${escapeHtml(sec.title || "Section")}</h2>`;
      for (const item of sec.items || []){
        const q = document.createElement("div");
        q.className = "q";
        q.dataset.qid = item.id;

        const header = document.createElement("div");
        header.className = "q-title";
        header.textContent = item.prompt || "";
        q.appendChild(header);

        if (item.type === "mcq" || item.type === "listening-mcq"){
          if (item.type === "listening-mcq"){
            const audio = document.createElement("audio");
            audio.src = item.audioUrl;
            audio.preload = "auto";
            audio.controls = true;

            const maxPlays = (sec.rules && Number(sec.rules.audioPlaysAllowed)) || 1;

            const getPlayCount = ()=> Number(localStorage.getItem(LS_KEY(`play_${item.id}`)) || "0");
            const incPlayCount = ()=> {
              const n = getPlayCount() + 1;
              localStorage.setItem(LS_KEY(`play_${item.id}`), String(n));
              return n;
            };

            audio.addEventListener("play", ()=>{
              const plays = getPlayCount();
              if (plays >= maxPlays){
                audio.pause();
                audio.currentTime = 0;
                showStatus("Audio can only be played once.", "bad");
                return;
              }
              incPlayCount();
              const after = getPlayCount();
              if (after >= maxPlays){
                setTimeout(()=>{
                  audio.pause();
                  audio.currentTime = 0;
                  audio.controls = false;
                  const note = document.createElement("div");
                  note.className = "small";
                  note.textContent = "Audio locked (played once).";
                  q.insertBefore(note, q.children[1] || null);
                }, 50);
              }
            });

            q.appendChild(audio);
          }

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
          ta.rows = 3;
          ta.placeholder = "Type your answer...";
          q.appendChild(ta);
        }

        secEl.appendChild(q);
      }
      elContent.appendChild(secEl);
    }
  }

  function collectAnswers(){
    const out = {};
    qsa("input[type=radio]:checked").forEach((r)=>{
      const name = r.getAttribute("name");
      const val = r.value;
      out[name] = (val === "true" || val === "false") ? val : Number(val);
    });
    qsa("textarea").forEach((t)=>{
      if (t.name) out[t.name] = t.value;
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
    if (localStorage.getItem(LS_KEY("submitted")) === "1"){
      showStatus("Already submitted.", "ok");
      elSubmit.style.display = "none";
      return;
    }
    const answers = collectAnswers();
    const clientMeta = { userAgent: navigator.userAgent, auto, ts: Date.now() };
    const r = await apiPost(`/api/session/${encodeURIComponent(token)}/submit`, { answers, clientMeta });
    localStorage.setItem(LS_KEY("submitted"), "1");
    elSubmit.style.display = "none";
    showStatus(`Submitted. Score: ${r.score}/${r.maxScore}`, "ok");
    stopCamera();
  }

  elSubmit.addEventListener("click", async ()=>{
    elSubmit.disabled = true;
    try{ await doSubmit(false); }
    finally{ elSubmit.disabled = false; }
  });

  async function boot(){
    // Global gate: exam opens at a fixed UTC time (server-controlled)
    const cfg = await apiGet("/api/config");
    const openAt = Number(cfg.openAtUtc || 0);
    const serverNow = Number(cfg.serverNow || Date.now());
    const offset = serverNow - Date.now();
    const nowServer = () => Date.now() + offset;

    const durationSeconds = Number(cfg.durationSeconds || 0);
    const endAt = openAt + Math.max(0, durationSeconds) * 1000;

    if (openAt && durationSeconds && nowServer() > endAt) {
      const endIso = fmtUtcStamp(endAt);
      elGate.style.display = "none";
      elContent.style.display = "none";
      elSubmit.style.display = "none";
      elStartExam.disabled = true;
      elEnableCam.disabled = true;
      elTitle.textContent = "Exam ended";
      elTimer.textContent = "00:00";
      showStatus(`The exam has ended (ended at ${endIso}).`, "bad");
      return;
    }

    if (openAt && nowServer() < openAt){
      const openIso = fmtUtcStamp(openAt);

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
        elTitle.textContent = "Exam locked";
        elTimer.textContent = `${hh}:${mm}:${ss}`;
        showStatus(`The exam opens at ${openIso}. Countdown: ${hh}:${mm}:${ss}`, "");
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

      // Unlock
      elEnableCam.disabled = false;
      elStatus.style.display = "none";
    }

    sessionData = await apiGet(`/api/session/${encodeURIComponent(token)}`);
    elTitle.textContent = sessionData.test.title;
    elCandidate.textContent = sessionData.session.candidateName;

    elGate.style.display = "block";
    elContent.style.display = "none";
    elSubmit.style.display = "none";
    elStartExam.disabled = true;

    // Start showing the remaining time immediately, even before camera/start.
    // The duration is anchored to the global window (openAt -> openAt + duration).
    timerAutoSubmit = false;
    startTimerAbsolute(endAt, nowServer);

    if (localStorage.getItem(LS_KEY("submitted")) === "1"){
      showStatus("This device already submitted this token.", "bad");
    }

    let stopGateLoop = null;

    elEnableCam.addEventListener("click", async ()=>{
      elEnableCam.disabled = true;
      try{
        await initCamera();
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
        // Enforce that the duration is counted from the global open time.
        // If the candidate waits too long on the camera step, the exam may already be over.
        if (openAt && durationSeconds && nowServer() > endAt) {
          const endIso = fmtUtcStamp(endAt);
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
        renderTest(sessionData.test.payload);
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
