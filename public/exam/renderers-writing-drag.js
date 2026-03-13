import { renderLegacyWritingDragTask } from "/exam/renderers-writing-legacy.js";
import { renderRichWritingDragTask } from "/exam/renderers-writing-rich.js";

export function renderWritingDragTasks(sec, secEl, deps){
  const rich = renderRichWritingDragTask(sec, secEl, deps);
  if (rich?.rendered) {
    return { writingDragId: String(rich.writingDragId || "") };
  }

  renderLegacyWritingDragTask(sec, secEl, deps);
  return { writingDragId: String(rich?.writingDragId || "") };
}
