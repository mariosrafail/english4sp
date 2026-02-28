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
const elAudioSink = qs("#audioSink");

const params = new URLSearchParams(location.search);
const roomName = String(params.get("room") || "").trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120);
const displayName = String(params.get("name") || "").trim().slice(0, 80) || "Participant";

let room = null;
let micEnabled = true;
let camEnabled = true;

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
  elMic.textContent = micEnabled ? "Mute Mic" : "Unmute Mic";
}

function setCamText() {
  elCam.textContent = camEnabled ? "Turn Camera Off" : "Turn Camera On";
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
    room = new Room();

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === Track.Kind.Video) {
        attachTrack(elRemote, track);
        updateRemoteLabel(participant?.identity || "Remote participant");
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
      updateRemoteLabel("Waiting for second participant...");
    });

    room.on(RoomEvent.Disconnected, () => {
      setButtons(false);
      hideStatus();
      if (elAudioSink) elAudioSink.innerHTML = "";
      if (elRemote) {
        elRemote.srcObject = null;
        elRemote.removeAttribute("src");
      }
      updateRemoteLabel("Waiting for second participant...");
    });

    await room.connect(String(auth.wsUrl || ""), String(auth.token || ""));
    await room.localParticipant.setMicrophoneEnabled(true);
    await room.localParticipant.setCameraEnabled(true);
    micEnabled = true;
    camEnabled = true;
    setMicText();
    setCamText();

    const localPub = Array.from(room.localParticipant.videoTrackPublications.values())[0];
    if (localPub?.track) attachTrack(elLocal, localPub.track);

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
      room.disconnect(true);
      room = null;
    }
  } finally {
    setButtons(false);
    hideStatus();
    updateRemoteLabel("Waiting for second participant...");
  }
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

if (elRoomInfo) {
  elRoomInfo.innerHTML = `Room: <span class="mono">${escapeHtml(roomName || "-")}</span>`;
}
setMicText();
setCamText();
setButtons(false);
