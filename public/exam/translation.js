export function createExamTranslationHelpers(ctx){
  const {
    getExamStarted,
    getTranslationViolationTriggered,
    setTranslationViolationTriggered,
    pingPresence,
    captureAndUploadSnapshot,
    showLock,
    setAutoReason,
    doSubmit,
    elGate,
    elStartExam,
    showGateNotice,
  } = ctx || {};

  let stopTranslationGuard = null;
  let stopPreStartTranslationGuard = null;

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

  function getPreStartTranslationBlockMessage(reason){
    const suffix = reason ? ` (${String(reason).replace(/_/g, " ")})` : "";
    return `Disable translation/browser extensions for this site before starting the exam${suffix}.`;
  }

  async function triggerTranslationViolation(reason){
    if (getTranslationViolationTriggered() || !getExamStarted()) return;
    setTranslationViolationTriggered(true);
    try{ await pingPresence(`translation_detected_${String(reason || "unknown")}`); }catch(e){}
    void captureAndUploadSnapshot(`translation_detected_${String(reason || "unknown")}`);
    showLock(
      "Translation tools are not allowed during the exam.",
      "Your exam is being submitted and marked as disqualified.",
      { minMs: 1500 }
    );
    setAutoReason(`disqual_translation_${String(reason || "unknown")}`);
    await doSubmit(true);
  }

  function armTranslationGuard(){
    if (stopTranslationGuard) return;

    const check = ()=>{
      if (!getExamStarted() || getTranslationViolationTriggered()) return;
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
      if (getExamStarted()) return;
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

  return {
    detectTranslationViolation,
    triggerTranslationViolation,
    getPreStartTranslationBlockMessage,
    armTranslationGuard,
    armPreStartTranslationGuard,
    stopTranslationGuard: ()=> {
      if (stopTranslationGuard) stopTranslationGuard();
    },
    stopPreStartTranslationGuard: ()=> {
      if (stopPreStartTranslationGuard) stopPreStartTranslationGuard();
    },
  };
}
