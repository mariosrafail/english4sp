import { qs, escapeHtml } from "./app.js";
import { Room, RoomEvent, Track } from "https://cdn.jsdelivr.net/npm/livekit-client@2.15.6/dist/livekit-client.esm.mjs";

const elRoomInfo = qs("#roomInfo");
const elErr = qs("#meetingError");
const elStatus = qs("#meetingStatus");
const elJoin = qs("#joinBtn");
const elMic = qs("#micBtn");
const elCam = qs("#camBtn");
const elLeave = qs("#leaveBtn");
const elLocal = qs("#localVideo");
const elRemote = qs("#remoteVideo");
const elRemoteLabel = qs("#remoteLabel");
const elLocalLabel = qs("#localLabel");
const elAudioSink = qs("#audioSink");
const elCamSelect = qs("#camSelect");
const elMicSelect = qs("#micSelect");

const params = new URLSearchParams(location.search);
const roomName = String(params.get("room") || "").trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120);
const displayName = String(params.get("name") || "").trim().slice(0, 80) || "Participant";

let room = null;
let micEnabled = true;
let camEnabled = true;
let selectedCamId = "";
let selectedMicId = "";
let localParticipantNumber = 0;

function showError(msg) {
  elErr.style.display = "block";
  elErr.innerHTML = escapeHtml(String(msg || "Unknown error"));
}

function clearError() {
  elErr.style.display = "none";
  elErr.textContent = "";
}

function showStatus(msg) {
  elStatus.style.display = "block";
  elStatus.innerHTML = escapeHtml(String(msg || ""));
}

function hideStatus() {
  elStatus.style.display = "none";
  elStatus.textContent = "";
}

function setButtons(isConnected) {
  elJoin.disabled = isConnected || !roomName;
  elMic.disabled = !isConnected;
  elCam.disabled = !isConnected;
  elLeave.disabled = !isConnected;
}

function setMicText() {
  const icon = micEnabled
    ? `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0a1 1 0 1 0-2 0a7 7 0 0 0 6 6.92V21a1 1 0 1 0 2 0v-3.08A7 7 0 0 0 19 11a1 1 0 1 0-2 0Z"/></svg>`
    : `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M19 11a1 1 0 1 1-2 0a5 5 0 0 1-.34 1.82l-1.53-1.53A2.99 2.99 0 0 0 15 11V9.83l-2-2V11a1 1 0 0 1-1 1h-.17l-1.4-1.4A3 3 0 0 1 9 11V5c0-.35.06-.69.17-1L7.7 2.53A1 1 0 0 1 9.1 1.1l13.8 13.8a1 1 0 1 1-1.41 1.41l-2.06-2.06A6.98 6.98 0 0 1 13 17.92V21a1 1 0 1 1-2 0v-3.08A7 7 0 0 1 5 11a1 1 0 1 1 2 0a5 5 0 0 0 7.07 4.57l-1.62-1.62A3 3 0 0 1 12 14a3 3 0 0 1-3-3v-.17l-2-2V11a7 7 0 0 0 7 7c1.05 0 2.04-.23 2.93-.64l-1.5-1.5A4.98 4.98 0 0 1 12 16a5 5 0 0 1-5-5a1 1 0 1 1-2 0a7 7 0 0 0 6 6.92v.03l-1.01-1.01A6.98 6.98 0 0 1 7 11a1 1 0 1 1 2 0a5 5 0 0 0 5 5c.76 0 1.48-.17 2.12-.47l-1.52-1.52A2.99 2.99 0 0 1 12 14Z"/></svg>`;
  const label = micEnabled ? "Mute Mic" : "Unmute Mic";
  elMic.innerHTML = `<span style="display:inline-flex; align-items:center; gap:8px;">${icon}<span>${escapeHtml(label)}</span></span>`;
}

function setCamText() {
  const icon = camEnabled
    ? `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M14 8H6a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-1.38l3.5 2.1A1 1 0 0 0 21 15.86V8.14a1 1 0 0 0-1.5-.86L16 9.38V10a2 2 0 0 0-2-2Z"/></svg>`
    : `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M2.1 3.51a1 1 0 0 1 1.41 0l17 17a1 1 0 1 1-1.41 1.41l-1.7-1.7A1.99 1.99 0 0 1 14 16H6a2 2 0 0 1-2-2v-4c0-.8.47-1.48 1.15-1.82L2.1 5a1 1 0 0 1 0-1.49ZM16 10.62l3.5-2.1A1 1 0 0 1 21 9.38v5.24a1 1 0 0 1-1.5.86L16 13.38v-2.76ZM6 8h5.17l-2-2H6a2 2 0 0 0-2 2v.17l2 2V8Zm8-2c.35 0 .69.07 1 .2V8a2 2 0 0 0-1-2Z"/></svg>`;
  const label = camEnabled ? "Turn Camera Off" : "Turn Camera On";
  elCam.innerHTML = `<span style="display:inline-flex; align-items:center; gap:8px;">${icon}<span>${escapeHtml(label)}</span></span>`;
}

function attachTrack(videoEl, track) {
  if (!videoEl || !track) return;
  const media = track.attach();
  videoEl.srcObject = media.srcObject || null;
  if (!videoEl.srcObject && media instanceof HTMLMediaElement) {
    videoEl.src = media.src || "";
  }
}

function attachRemoteAudio(track) {
  if (!elAudioSink || !track) return;
  const audioEl = track.attach();
  if (audioEl) elAudioSink.appendChild(audioEl);
}

function updateRemoteLabel(text) {
  elRemoteLabel.textContent = String(text || "Waiting for second participant...");
}

function labelForParticipantNumber(n) {
  const x = Number(n);
  if (x === 1) return "Participant 1";
  if (x === 2) return "Participant 2";
  return "Participant";
}

function updateLocalLabel() {
  if (!elLocalLabel) return;
  elLocalLabel.textContent = localParticipantNumber ? `You (${labelForParticipantNumber(localParticipantNumber)})` : "You";
}

function remoteParticipantNumber() {
  if (localParticipantNumber === 1) return 2;
  if (localParticipantNumber === 2) return 1;
  return 0;
}

function updateRemoteLabelFriendly(participant) {
  const remoteN = remoteParticipantNumber();
  const remoteName = remoteN
    ? labelForParticipantNumber(remoteN)
    : (String(participant?.name || "").trim() || "Remote participant");
  updateRemoteLabel(remoteName);
}

function clearRemoteMedia() {
  try {
    if (elAudioSink) elAudioSink.innerHTML = "";
  } catch {}
  try {
    stopMediaEl(elRemote);
  } catch {}
  try {
    updateRemoteLabel("Waiting for second participant...");
  } catch {}
}

function stopMediaEl(el) {
  try {
    const obj = el && el.srcObject ? el.srcObject : null;
    if (obj && typeof obj.getTracks === "function") {
      for (const t of obj.getTracks()) {
        try { t.stop(); } catch {}
      }
    }
  } catch {}
  try {
    if (el) {
      el.srcObject = null;
      el.removeAttribute("src");
    }
  } catch {}
}

function stopPublishedLocalTracks() {
  try {
    const lp = room?.localParticipant;
    if (!lp) return;
    const pubs = [
      ...Array.from(lp.audioTrackPublications?.values?.() || []),
      ...Array.from(lp.videoTrackPublications?.values?.() || []),
    ];
    for (const p of pubs) {
      const t = p?.track;
      if (!t) continue;
      try { t.stop?.(); } catch {}
      try { t.mediaStreamTrack?.stop?.(); } catch {}
    }
  } catch {}
}

async function stopLocalMedia() {
  const lp = room?.localParticipant;
  if (!lp) return;
  try { await lp.setMicrophoneEnabled(false); } catch {}
  try { await lp.setCameraEnabled(false); } catch {}
  stopPublishedLocalTracks();
  stopMediaEl(elLocal);
}

function deviceLabel(d, i) {
  const kind = d.kind === "videoinput" ? "Camera" : (d.kind === "audioinput" ? "Mic" : "Device");
  const base = String(d.label || "").trim();
  return base || `${kind} ${i + 1}`;
}

async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d && d.kind === "videoinput");
  const mics = devices.filter((d) => d && d.kind === "audioinput");

  const curCam = String(elCamSelect?.value || selectedCamId || "");
  const curMic = String(elMicSelect?.value || selectedMicId || "");

  if (elCamSelect) {
    elCamSelect.innerHTML = "";
    if (!cams.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Default camera";
      elCamSelect.appendChild(opt);
    } else {
      cams.forEach((d, i) => {
        const opt = document.createElement("option");
        opt.value = String(d.deviceId || "");
        opt.textContent = deviceLabel(d, i);
        elCamSelect.appendChild(opt);
      });
    }
    if (curCam && cams.some((d) => String(d.deviceId || "") === curCam)) elCamSelect.value = curCam;
    selectedCamId = String(elCamSelect.value || "");
  }

  if (elMicSelect) {
    elMicSelect.innerHTML = "";
    if (!mics.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Default microphone";
      elMicSelect.appendChild(opt);
    } else {
      mics.forEach((d, i) => {
        const opt = document.createElement("option");
        opt.value = String(d.deviceId || "");
        opt.textContent = deviceLabel(d, i);
        elMicSelect.appendChild(opt);
      });
    }
    if (curMic && mics.some((d) => String(d.deviceId || "") === curMic)) elMicSelect.value = curMic;
    selectedMicId = String(elMicSelect.value || "");
  }
}

function getCaptureOptions() {
  const camId = String(elCamSelect?.value || selectedCamId || "");
  const micId = String(elMicSelect?.value || selectedMicId || "");
  selectedCamId = camId;
  selectedMicId = micId;
  return { camId, micId };
}

async function applySelectedDevices() {
  if (!room) return;
  const { camId, micId } = getCaptureOptions();

  // Only switch what is enabled; if disabled, we just remember selection.
  if (micEnabled) {
    try {
      await room.localParticipant.setMicrophoneEnabled(false);
      await room.localParticipant.setMicrophoneEnabled(true, micId ? { deviceId: micId } : undefined);
    } catch (e) {
      // Fallback: re-enable default device if switching fails.
      try { await room.localParticipant.setMicrophoneEnabled(true); } catch {}
    }
  }

  if (camEnabled) {
    try {
      await room.localParticipant.setCameraEnabled(false);
      await room.localParticipant.setCameraEnabled(true, camId ? { deviceId: camId } : undefined);
    } catch (e) {
      try { await room.localParticipant.setCameraEnabled(true); } catch {}
    }

    const localPub = Array.from(room.localParticipant.videoTrackPublications.values())[0];
    if (localPub?.track) attachTrack(elLocal, localPub.track);
  }
}

async function fetchJoinToken() {
  const r = await fetch("/api/meeting/livekit-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room: roomName, name: displayName }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = String(j?.message || j?.error || `HTTP ${r.status}`);
    throw new Error(msg);
  }
  return j;
}

async function join() {
  clearError();
  hideStatus();
  if (!roomName) {
    showError("Missing or invalid room id.");
    return;
  }

  try {
    elJoin.disabled = true;
    showStatus("Joining...");
    const auth = await fetchJoinToken();
    localParticipantNumber = Math.max(0, Math.min(2, Number(auth?.participantNumber || 0) || 0));
    updateLocalLabel();
    room = new Room();

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === Track.Kind.Video) {
        attachTrack(elRemote, track);
        updateRemoteLabelFriendly(participant);
        return;
      }
      if (track.kind === Track.Kind.Audio) attachRemoteAudio(track);
    });

    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((el) => el.remove());
      if (track.kind === Track.Kind.Video && elRemote) {
        elRemote.srcObject = null;
        elRemote.removeAttribute("src");
        updateRemoteLabel("Waiting for second participant...");
      }
    });

    room.on(RoomEvent.ParticipantDisconnected, () => {
      clearRemoteMedia();
    });

    room.on(RoomEvent.Disconnected, () => {
      setButtons(false);
      hideStatus();
      clearRemoteMedia();
    });

    await room.connect(String(auth.wsUrl || ""), String(auth.token || ""));

    const { camId, micId } = getCaptureOptions();
    await room.localParticipant.setMicrophoneEnabled(true, micId ? { deviceId: micId } : undefined);
    await room.localParticipant.setCameraEnabled(true, camId ? { deviceId: camId } : undefined);
    micEnabled = true;
    camEnabled = true;
    setMicText();
    setCamText();

    const localPub = Array.from(room.localParticipant.videoTrackPublications.values())[0];
    if (localPub?.track) attachTrack(elLocal, localPub.track);

    // After permissions are granted, device labels become available in most browsers.
    await listDevices().catch(() => {});

    showStatus("Connected. Max 2 participants in this call.");
    setButtons(true);
  } catch (e) {
    showError(e?.message || "Failed to join meeting.");
    setButtons(false);
  }
}

async function leave() {
  try {
    if (room) {
      // Behave like pressing "Leave": stop capture so devices are released immediately.
      await stopLocalMedia();
      room.disconnect(true);
      room = null;
    }
  } finally {
    setButtons(false);
    hideStatus();
    updateRemoteLabel("Waiting for second participant...");
  }
}

function leaveOnExit() {
  // Best-effort cleanup when tab is closed/navigated away.
  try {
    // Avoid awaiting anything here (the page can be killed quickly).
    try { room?.localParticipant?.setMicrophoneEnabled(false); } catch {}
    try { room?.localParticipant?.setCameraEnabled(false); } catch {}
    stopPublishedLocalTracks();
    try { room?.disconnect(true); } catch {}
    room = null;
  } catch {}
  try {
    if (elAudioSink) elAudioSink.innerHTML = "";
  } catch {}
  try {
    stopMediaEl(elLocal);
  } catch {}
  try {
    stopMediaEl(elRemote);
  } catch {}
  try { setButtons(false); } catch {}
}

elJoin.addEventListener("click", () => {
  void join();
});

elLeave.addEventListener("click", () => {
  void leave();
});

elMic.addEventListener("click", async () => {
  if (!room) return;
  micEnabled = !micEnabled;
  await room.localParticipant.setMicrophoneEnabled(micEnabled);
  setMicText();
});

elCam.addEventListener("click", async () => {
  if (!room) return;
  camEnabled = !camEnabled;
  await room.localParticipant.setCameraEnabled(camEnabled);
  setCamText();
});

elCamSelect?.addEventListener("change", () => {
  void applySelectedDevices();
});
elMicSelect?.addEventListener("change", () => {
  void applySelectedDevices();
});

if (elRoomInfo) {
  elRoomInfo.innerHTML = `Room: <span class="mono">${escapeHtml(roomName || "-")}</span>`;
}
updateLocalLabel();
setMicText();
setCamText();
setButtons(false);
void listDevices().catch(() => {});

// Ensure we disconnect cleanly if the user closes the tab or navigates away.
// Use pagehide for mobile Safari reliability; beforeunload as a fallback.
window.addEventListener("pagehide", leaveOnExit);
window.addEventListener("beforeunload", leaveOnExit);
