import { createPetSpeechController } from './speech-controller.js';

const api = window.qqPetSpeech;
const speech = document.getElementById('speech');
let revision = -1;
let limits = { width: 420, height: 800 };
let disposed = false;
// Chromium may suspend rAF in a fully hidden native window. A bounded fallback
// lets the first reply become visible instead of waiting forever for that frame.
const nextFrame = () => new Promise((resolve) => {
  const timer = setTimeout(resolve, 40);
  requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
});
function applyTail(value) {
  if (value?.revision === revision && Number.isFinite(value.tail)) speech.style.setProperty('--speech-tail-x', `${value.tail}px`);
}
const controller = createPetSpeechController({
  speech, text: document.getElementById('speech-text'), close: document.getElementById('speech-close'), detached: true,
  getViewport: () => ({ width: limits.width + 12, height: limits.height + 12, speechLimit: limits }),
  async requestSpace(size) {
    const expected = revision;
    const layout = await api.measure({ ...size, revision: expected });
    if (!layout || disposed || expected !== revision || speech.hidden) return;
    applyTail(layout);
    // Present only after the new-sized surface has painted. This handshake
    // cannot move the character window, including if a stale reply finishes.
    await nextFrame();
    await nextFrame();
    if (!disposed && expected === revision && !speech.hidden) await api.present(expected);
  },
});
function update(value) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < revision) return;
  revision = value.revision;
  if (value.speechLimit) limits = value.speechLimit;
  if (value.text) controller.show(value.text);
  else controller.close();
}
const unsubscribers = api ? [
  api.onUpdate(update), api.onLayout(applyTail),
  api.onReset((value) => { revision = value.revision; controller.close(); }),
  api.onLimits((value) => { limits = value; controller.layout(); }),
] : [];
if (api) update(await api.ready());
window.addEventListener('beforeunload', () => { disposed = true; for (const unsubscribe of unsubscribers) unsubscribe(); controller.destroy(); });
