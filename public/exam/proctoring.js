export function createExamProctoringHelpers(ctx){
  const {
    token,
    apiPost,
    getExamStarted,
    getProctoringMode,
    setProctoringMode,
    getProctoringAckRequired,
    setProctoringAckRequired,
    getProctoringNoticeVersion,
    setProctoringNoticeVersion,
    getProctoringAckedServer,
    setProctoringAckedServer,
    getSnapshotsTaken,
    setSnapshotsTaken,
    getSnapshotInFlight,
    setSnapshotInFlight,
    getLastSnapshotAt,
    setLastSnapshotAt,
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
  } = ctx || {};

  let returnSnapshotTimer = null;

  function clearReturnSnapshotTimer(){
    if (!returnSnapshotTimer) return;
    clearTimeout(returnSnapshotTimer);
    returnSnapshotTimer = null;
  }

  function hardenCameraVideoEl(videoEl){
    if (!videoEl) return;
    try { videoEl.disablePictureInPicture = true; } catch {}
    try { videoEl.setAttribute("disablePictureInPicture", ""); } catch {}
    try { videoEl.disableRemotePlayback = true; } catch {}
    try { videoEl.setAttribute("disableRemotePlayback", ""); } catch {}
    try { videoEl.setAttribute("controlslist", "nofullscreen noremoteplayback nodownload"); } catch {}
  }

  function applyProctoringConfig(cfg) {
    const c = cfg && typeof cfg === "object" ? cfg : {};

    const modeRaw = String(c.mode || "").trim().toLowerCase();
    setProctoringMode((modeRaw === "recording" || modeRaw === "record") ? "recording" : "presence");

    const requireAckRaw = c.requireAck;
    setProctoringAckRequired(requireAckRaw === undefined ? true : !!requireAckRaw);

    const v = String(c.noticeVersion || "").trim();
    if (v) setProctoringNoticeVersion(v);

    const controllerName = String(c.controllerName || "").trim() || "the educational organization running this exam";
    const retentionDaysNum = Number(c.retentionDays || 0);
    const retentionDays = Number.isFinite(retentionDaysNum) && retentionDaysNum > 0 ? Math.round(retentionDaysNum) : 30;
    const privacyUrl = String(c.privacyNoticeUrl || "").trim();

    if (elProctoringController) elProctoringController.textContent = `Data controller: ${controllerName}. `;
    if (elProctoringRetention) elProctoringRetention.textContent = `Retention: up to ${retentionDays} days. `;
    if (elProctoringControllerLong) elProctoringControllerLong.textContent = controllerName;
    if (elProctoringRetentionLong) elProctoringRetentionLong.textContent = String(retentionDays);

    if (elProctoringPrivacyLink) {
      if (privacyUrl) {
        elProctoringPrivacyLink.href = privacyUrl;
        elProctoringPrivacyLink.style.display = "inline";
      } else {
        elProctoringPrivacyLink.style.display = "none";
      }
    }

    if (elProctoringNoticeText) {
      if (getProctoringMode() === "recording") {
        elProctoringNoticeText.textContent =
          "During this exam, we will record video and capture periodic photos using your device camera for invigilation and identity verification (human review).";
      } else {
        elProctoringNoticeText.textContent =
          "During this exam, your device camera will be used to monitor your presence and verify your identity (human review). This exam uses camera presence checks and proctoring event logs (no stored video recording).";
      }
    }

    if (elCameraCheckText) {
      elCameraCheckText.textContent =
        getProctoringMode() === "recording"
          ? "Camera access is required to start the exam. Keep your face visible. Video and periodic photos may be captured for review."
          : "Camera access is required to start the exam. The system checks that your face is visible.";
    }

    if (!getProctoringAckRequired()) {
      try { if (elProctoringAckLabel) elProctoringAckLabel.style.display = "none"; } catch {}
      try { if (elProctoringMeta) elProctoringMeta.style.display = "none"; } catch {}
      try { if (elProctoringAck) { elProctoringAck.checked = true; elProctoringAck.disabled = true; } } catch {}
    }
  }

  function isProctoringAckSatisfied() {
    if (!getProctoringAckRequired()) return true;
    return !!(elProctoringAck && elProctoringAck.checked);
  }

  async function ensureProctoringAckRecorded() {
    if (!getProctoringAckRequired()) return;
    if (getProctoringAckedServer()) return;
    if (!elProctoringAck || !elProctoringAck.checked) throw new Error("Please acknowledge the Remote Proctoring Notice to start the exam.");
    await apiPost(`/api/session/${encodeURIComponent(token)}/proctoring-ack`, { noticeVersion: getProctoringNoticeVersion() });
    setProctoringAckedServer(true);
  }

  function pickSnapshotVideoEl() {
    if (elVideoMini && elVideoMini.srcObject) return elVideoMini;
    if (elVideo && elVideo.srcObject) return elVideo;
    return null;
  }

  async function makeSnapshotPngBlob(videoEl, maxW) {
    const vw = Number(videoEl?.videoWidth || 0);
    const vh = Number(videoEl?.videoHeight || 0);
    if (!vw || !vh) return null;

    const canvas = document.createElement("canvas");
    const limitW = Math.max(160, Math.floor(Number(maxW || 640)));
    const scale = vw > limitW ? (limitW / vw) : 1;
    const tw = Math.max(1, Math.round(vw * scale));
    const th = Math.max(1, Math.round(vh * scale));
    canvas.width = tw;
    canvas.height = th;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return null;
    ctx2d.drawImage(videoEl, 0, 0, tw, th);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }

  async function buildAdaptiveSnapshotBlob(videoEl) {
    const COMPRESS_TRIGGER_BYTES = 1024 * 1024;
    const TARGET_BYTES = 900 * 1024;

    const first = await makeSnapshotPngBlob(videoEl, 640);
    if (!first) return null;
    if (first.size <= COMPRESS_TRIGGER_BYTES) return first;

    const widths = [560, 520, 480, 440, 400, 360, 320, 280, 240, 220, 200];
    let last = first;
    for (const w of widths) {
      const blob = await makeSnapshotPngBlob(videoEl, w);
      if (!blob) continue;
      last = blob;
      if (blob.size <= TARGET_BYTES) return blob;
    }
    return last;
  }

  async function captureAndUploadSnapshot(reason) {
    if (getSnapshotInFlight()) return;
    if (getSnapshotsTaken() >= MAX_SNAPSHOTS) return;

    const now = Date.now();
    if (getLastSnapshotAt() && (now - getLastSnapshotAt()) < 700) return;

    const r0 = String(reason || "unknown").trim() || "unknown";
    const titlePrefix = (() => {
      const r = r0.toLowerCase();
      if (r === "exam_start") return "START_EXAM";
      if (r.includes("fullscreen")) return "EXIT_FULLSCREEN";
      if (r.includes("face") || r.includes("camera")) return "FACE_NOTONCAMERA";
      if (
        r.includes("tab_") ||
        r.includes("window_") ||
        r.includes("pointer_") ||
        r.includes("nav_") ||
        r.includes("focus")
      ) return "CHANGED_WINDOW";
      return "SNAPSHOT";
    })();

    const stamp = (() => {
      const d = new Date();
      const HH = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      const ss = String(d.getSeconds()).padStart(2, "0");
      const DD = String(d.getDate()).padStart(2, "0");
      const MM = String(d.getMonth() + 1).padStart(2, "0");
      const YYYY = String(d.getFullYear());
      return `${HH}${mm}${ss}_${DD}${MM}_${YYYY}`;
    })();

    const videoEl = pickSnapshotVideoEl();
    if (!videoEl) return;
    const vw = Number(videoEl.videoWidth || 0);
    const vh = Number(videoEl.videoHeight || 0);
    if (!vw || !vh) return;

    setSnapshotInFlight(true);
    setLastSnapshotAt(now);
    try {
      const blob = await buildAdaptiveSnapshotBlob(videoEl);
      if (!blob) return;

      const fd = new FormData();
      fd.append("reason", r0);
      fd.append("titlePrefix", titlePrefix);
      fd.append("stamp", stamp);
      fd.append("image", blob, "snapshot.png");

      let r = await fetch(`/api/session/${encodeURIComponent(token)}/snapshot`, {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      });
      let j = await r.json().catch(() => ({}));
      if (!r.ok && r.status === 413) {
        const retryBlob = await makeSnapshotPngBlob(videoEl, 240);
        if (retryBlob) {
          const fd2 = new FormData();
          fd2.append("reason", r0);
          fd2.append("titlePrefix", titlePrefix);
          fd2.append("stamp", stamp);
          fd2.append("image", retryBlob, "snapshot.png");
          r = await fetch(`/api/session/${encodeURIComponent(token)}/snapshot`, {
            method: "POST",
            body: fd2,
            credentials: "same-origin",
          });
          j = await r.json().catch(() => ({}));
        }
      }
      if (!r.ok) {
        if (r.status === 429 || j?.error === "snapshot_limit_reached") setSnapshotsTaken(MAX_SNAPSHOTS);
        return;
      }

      const c = Number(j?.count || 0);
      setSnapshotsTaken(Number.isFinite(c) && c > 0 ? c : (getSnapshotsTaken() + 1));
    } catch {}
    finally {
      setSnapshotInFlight(false);
    }
  }

  function scheduleReturnSnapshot(reason, delayMs){
    clearReturnSnapshotTimer();
    returnSnapshotTimer = setTimeout(()=>{
      returnSnapshotTimer = null;
      if (!getExamStarted()) return;
      void captureAndUploadSnapshot(String(reason || "return_to_exam"));
    }, Math.max(0, Number(delayMs || 1000)));
  }

  return {
    clearReturnSnapshotTimer,
    scheduleReturnSnapshot,
    hardenCameraVideoEl,
    applyProctoringConfig,
    isProctoringAckSatisfied,
    ensureProctoringAckRecorded,
    captureAndUploadSnapshot,
  };
}
