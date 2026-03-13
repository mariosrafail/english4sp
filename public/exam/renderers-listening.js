export function renderListeningSection(sec, secEl, deps){
  const {
    token,
    LS_KEY,
    showStatus,
    showSection,
    getCurrentSectionIdx,
  } = deps || {};

  const firstAudioItem = (sec.items || []).find((it)=> it?.type === "listening-mcq");
  if (!firstAudioItem) return;

  const maxPlays = (sec.rules && Number(sec.rules.audioPlaysAllowed)) || 1;
  const playKey = LS_KEY(`play_sec_${sec.id || "listening"}`);
  const endedKey = LS_KEY(`play_sec_${sec.id || "listening"}_ended`);
  const getPlayCount = ()=> Number(localStorage.getItem(playKey) || "0");
  const setPlayCount = (n)=> localStorage.setItem(playKey, String(Math.max(0, Number(n) || 0)));

  const audioWrap = document.createElement("div");
  audioWrap.className = "q";

  const audio = document.createElement("audio");
  audio.src = "";
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

  const audioMsg = document.createElement("div");
  audioMsg.className = "small";
  audioMsg.textContent = "Listening starts automatically. It can be played once.";

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

  const startListeningPlayback = async ()=>{
    const plays = getPlayCount();
    if (plays >= maxPlays){
      showStatus("Audio can only be played once.", "bad");
      lockAudio();
      return;
    }
    if (started) return;
    started = true;
    playBtn.disabled = true;
    playBtn.textContent = "Now playing";
    audioMsg.textContent = "Listening in progress...";
    try{
      const r = await fetch(`/api/session/${encodeURIComponent(token)}/listening-ticket`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const j = await r.json().catch(()=> ({}));
      if (!r.ok) throw new Error(String(j?.error || j?.message || `Listening unavailable (${r.status})`));
      const url = String(j?.url || "").trim();
      if (!url) throw new Error("Listening unavailable.");
      setPlayCount(plays + 1);
      audio.src = url;
      audio.currentTime = 0;
      await audio.play();
    }catch(e){
      started = false;
      playBtn.disabled = false;
      playBtn.textContent = "Play Listening";
      const msg = String(e?.message || "");
      if (msg.includes("listening_denied") || msg.includes("denied")) {
        audioMsg.textContent = "Listening audio is locked.";
        lockAudio();
      } else {
        audioMsg.textContent = msg || "Unable to play audio on this browser/device.";
      }
    }
  };

  playBtn.addEventListener("click", ()=>{
    void startListeningPlayback();
  });

  audio.addEventListener("ended", ()=>{
    localStorage.setItem(endedKey, "1");
    lockAudio();
    audioMsg.textContent = "Listening complete. Moving to the next part...";
    setTimeout(()=> showSection(getCurrentSectionIdx() + 1), 250);
  });

  controlsRow.appendChild(playBtn);
  controlsRow.appendChild(audioMsg);
  audioWrap.appendChild(controlsRow);
  audioWrap.appendChild(audio);
  secEl.appendChild(audioWrap);

  secEl._autoStartListening = ()=> {
    if (localStorage.getItem(endedKey) === "1") return;
    if (getPlayCount() >= maxPlays) return;
    void startListeningPlayback();
  };
}
