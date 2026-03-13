const canvasTextBlocks = [];
let canvasTextResizeObserver = null;

export function hardenNoTranslateTree(root){
  if (!root) return;
  try {
    if (root.nodeType === 1) {
      root.setAttribute("translate", "no");
      root.setAttribute("lang", "en");
      root.classList.add("notranslate");
    }
  } catch {}
  try {
    const nodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
    nodes.forEach((el)=>{
      try { el.setAttribute("translate", "no"); } catch {}
      try {
        const existingLang = String(el.getAttribute("lang") || "").trim();
        if (!existingLang) el.setAttribute("lang", "en");
      } catch {}
      try { el.classList.add("notranslate"); } catch {}
    });
  } catch {}
}

function tokenizeText(raw, richText){
  const src = String(raw || "").replace(/\r\n?/g, "\n");
  const parts = richText ? src.split("**") : [src];
  const tokens = [];
  for (let i = 0; i < parts.length; i++){
    const text = String(parts[i] || "");
    const bold = richText ? (i % 2 === 1) : false;
    const lines = text.split("\n");
    for (let j = 0; j < lines.length; j++){
      const line = lines[j];
      const pieces = line.match(/\S+\s*/g) || [];
      pieces.forEach((piece)=> tokens.push({ text: piece, bold }));
      if (j < lines.length - 1) tokens.push({ newline: true });
    }
  }
  return tokens;
}

function getContentBoxWidth(el){
  if (!el) return 0;
  const rectWidth = Number(el.getBoundingClientRect?.().width || 0);
  const clientWidth = Number(el.clientWidth || 0);
  const rawWidth = rectWidth || clientWidth || 0;
  if (!rawWidth) return 0;
  try{
    const style = window.getComputedStyle(el);
    const pl = parseFloat(style.paddingLeft || "0") || 0;
    const pr = parseFloat(style.paddingRight || "0") || 0;
    return Math.max(0, rawWidth - pl - pr);
  }catch{
    return rawWidth;
  }
}

function getBlockWidth(entry, host){
  const mode = String(entry?.widthMode || "host");
  const hostWidth = getContentBoxWidth(host);
  if (mode === "container"){
    const parentWidth = getContentBoxWidth(host.parentElement);
    const closestWidth = entry.closestSelector ? getContentBoxWidth(host.closest?.(entry.closestSelector)) : 0;
    return Math.max(hostWidth, parentWidth, closestWidth, 0);
  }
  return hostWidth;
}

function renderCanvasTextBlock(entry){
  const host = entry?.host;
  if (!host) return;

  const widthMode = String(entry.widthMode || "");
  const measuredWidth = getBlockWidth(entry, host);
  const fallbackContainerWidth = Math.floor(getBlockWidth({ ...entry, widthMode: "container" }, host) || 0);
  const cssWidth = Math.floor(measuredWidth || (widthMode === "natural" ? fallbackContainerWidth : 0));
  if (!cssWidth) return;

  const style = window.getComputedStyle(host);
  const fontSize = Math.max(14, Math.round(parseFloat(style.fontSize || "16") || 16));
  const parsedLineHeight = parseFloat(style.lineHeight || "");
  const lineHeight = Math.max(fontSize * 1.35, Number.isFinite(parsedLineHeight) ? parsedLineHeight : (fontSize * 1.6));
  const color = style.color || "#111827";
  const fontFamily = style.fontFamily || "system-ui, sans-serif";
  const fontWeight = String(style.fontWeight || "400");
  const boldWeight = String(entry.boldWeight || "700");
  const padX = Number(entry.padX ?? 0);
  const padY = Number(entry.padY ?? 0);
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

  const canvas = host._canvasTextEl || document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const setFont = (bold)=>{
    ctx.font = `${bold ? boldWeight : fontWeight} ${fontSize}px ${fontFamily}`;
  };

  const tokens = tokenizeText(entry.raw, !!entry.richText);
  if (widthMode === "natural"){
    const naturalLines = [[]];
    tokens.forEach((token)=>{
      if (token.newline){
        naturalLines.push([]);
        return;
      }
      naturalLines[naturalLines.length - 1].push(token);
    });
    let naturalMax = 0;
    naturalLines.forEach((line)=>{
      let sum = 0;
      line.forEach((part)=>{
        setFont(!!part.bold);
        sum += ctx.measureText(String(part.text || "")).width;
      });
      naturalMax = Math.max(naturalMax, sum);
    });
    const capWidth = fallbackContainerWidth || cssWidth;
    const naturalWidth = Math.ceil(naturalMax + padX * 2);
    if (naturalWidth > 0 && capWidth > 0) {
      entry._naturalWidth = Math.min(capWidth, naturalWidth);
    }
  }
  const effectiveWidth = Math.max(1, Math.floor(entry._naturalWidth || cssWidth));
  const lines = [];
  let currentLine = [];
  let currentWidth = 0;

  const pushLine = ()=>{
    lines.push(currentLine);
    currentLine = [];
    currentWidth = 0;
  };

  tokens.forEach((token)=>{
    if (token.newline){
      pushLine();
      return;
    }
    const piece = String(token.text || "");
    if (!piece) return;
    setFont(!!token.bold);
    const pieceWidth = ctx.measureText(piece).width;
      const effectiveMaxTextWidth = Math.max(80, effectiveWidth - padX * 2);
      if (currentLine.length && (currentWidth + pieceWidth) > effectiveMaxTextWidth){
        pushLine();
      }
      currentLine.push({ text: piece, bold: !!token.bold, width: pieceWidth });
    currentWidth += pieceWidth;
  });
  if (currentLine.length || !lines.length) pushLine();

  const cssHeight = Math.max(fontSize + padY * 2, Math.ceil(lines.length * lineHeight + padY * 2));
  canvas.width = Math.max(1, Math.round(effectiveWidth * dpr));
  canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  canvas.style.width = `${effectiveWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.style.display = "block";
  canvas.style.maxWidth = "100%";
  try { canvas.setAttribute("translate", "no"); } catch {}
  try { canvas.classList.add("notranslate", "text-canvas"); } catch {}
  if (entry.canvasClassName) {
    String(entry.canvasClassName).split(/\s+/).filter(Boolean).forEach((cls)=>{
      try { canvas.classList.add(cls); } catch {}
    });
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, effectiveWidth, cssHeight);
  ctx.textBaseline = "top";
  ctx.fillStyle = color;

  let y = padY;
  lines.forEach((line)=>{
    let x = padX;
    line.forEach((part)=>{
      setFont(!!part.bold);
      ctx.fillText(part.text, x, y);
      x += Number(part.width || 0);
    });
    y += lineHeight;
  });

  if (!host._canvasTextEl){
    host.textContent = "";
    host.appendChild(canvas);
    host._canvasTextEl = canvas;
  }
  host.classList.remove("canvas-text-pending");
  host.classList.add("canvas-text-ready");
}

export function clearCanvasTextBlocks(){
  canvasTextBlocks.forEach((entry)=>{
    try{ entry?._observed?.forEach((el)=> canvasTextResizeObserver?.unobserve?.(el)); }catch{}
  });
  canvasTextBlocks.length = 0;
}

export function registerCanvasTextBlock(host, raw, options = {}){
  if (!host) return;
  for (let i = canvasTextBlocks.length - 1; i >= 0; i--){
    const existing = canvasTextBlocks[i];
    if (!existing || existing.host !== host) continue;
    try{ existing?._observed?.forEach((el)=> canvasTextResizeObserver?.unobserve?.(el)); }catch{}
    canvasTextBlocks.splice(i, 1);
  }
  try { host.classList.add("canvas-text-host", "canvas-text-pending", "notranslate"); } catch {}
  try { host.classList.remove("canvas-text-ready"); } catch {}
  try { host.setAttribute("translate", "no"); } catch {}
  const entry = {
    host,
    raw: String(raw || ""),
    richText: !!options.richText,
    minWidth: Number(options.minWidth || 0) || 0,
    padX: options.padX,
    padY: options.padY,
    boldWeight: options.boldWeight,
    closestSelector: options.closestSelector || "",
    widthMode: options.widthMode || "",
    canvasClassName: options.canvasClassName || "",
    _observed: [],
  };
  canvasTextBlocks.push(entry);
  if (canvasTextResizeObserver){
    const observed = [host, host.parentElement, entry.closestSelector ? host.closest(entry.closestSelector) : null].filter(Boolean);
    observed.forEach((el)=>{
      try{ canvasTextResizeObserver.observe(el); }catch{}
      entry._observed.push(el);
    });
  }
}

export function queueCanvasTextRender(){
  if (queueCanvasTextRender._id) cancelAnimationFrame(queueCanvasTextRender._id);
  queueCanvasTextRender._id = requestAnimationFrame(()=>{
    queueCanvasTextRender._id = 0;
    canvasTextBlocks.forEach((entry)=>{
      if (!entry || !entry.host || !entry.host.isConnected) return;
      renderCanvasTextBlock(entry);
    });
  });
  clearTimeout(queueCanvasTextRender._tid);
  queueCanvasTextRender._tid = setTimeout(()=>{
    canvasTextBlocks.forEach((entry)=>{
      if (!entry || !entry.host || !entry.host.isConnected) return;
      renderCanvasTextBlock(entry);
    });
  }, 60);
}

export function installCanvasTextAutoResize(){
  if (installCanvasTextAutoResize._installed) return;
  installCanvasTextAutoResize._installed = true;
  if (window.ResizeObserver){
    canvasTextResizeObserver = new ResizeObserver(()=>{
      queueCanvasTextRender();
    });
  }
  window.addEventListener("resize", queueCanvasTextRender);
}
