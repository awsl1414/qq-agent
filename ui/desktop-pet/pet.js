import { createPetActionController } from './action-controller.js';
import { createDaiMeowEffects } from './daimeow-effects.js';
import { buildModelProfile, createLive2DPlayback, enableMotionTransitions } from './model-profile.js';
import { createRemotePetSpeechController } from './speech-controller.js';

const api = window.qqDesktopPet;
const pet = document.getElementById('pet');
const stage = document.getElementById('stage');
const canvas = document.getElementById('model');
const placeholder = document.getElementById('placeholder');
const placeholderTitle = document.getElementById('placeholder-title');
const placeholderDetail = document.getElementById('placeholder-detail');
const status = document.getElementById('status');
const observe = document.getElementById('observe');
let state = { settings: {} };
let application = null;
let rendererSizeKey = '';
let model = null;
let loadedModelId = '';
let naturalSize = null;
let requestedModel = '';
let modelFailure = null;
// 单击 / 双击的判定窗口（毫秒）：单击必须等这么久才能确认"不是双击"，
// 否则双击会先弹一次用量卡片再开工单窗。
const TAP_DELAY_MS = 260;
let tapTimer = null;
let lastSpeechAt = -Infinity;
let loadVersion = 0;
let visible = true;
let effects = null;
let modelProfile = buildModelProfile();
let defaultPreserveExpression = false;
let statusTimer = null;
let motionSettingsKey = '';
let pointer = null;
let dragFrame = null;
let observing = false;
let replyResetTimer = null;
let currentStatus = 'idle';
let statusVersion = 0;
let lastCursor = null;
let previewTimer = null;
const previewAttempts = new Map();
const unsubscribers = [];
let frameLayout = null;
const sceneBounds = () => frameLayout?.scene || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
const speechController = createRemotePetSpeechController({ api });
const playback = createLive2DPlayback({
  getModel: () => loadedModelId === state.activeModel?.id ? model : null,
  getActive: () => state.activeModel,
  getProfile: () => modelProfile,
  isVisible: () => visible,
  effects: { start: (name) => effects?.start(name), stop: () => effects?.stop() },
  reportActivity: (value) => api?.reportActivity?.(value),
});

const actions = createPetActionController({
  play: playback.playMotion,
  playExpression: playback.playExpression,
  setPosture: playback.setPosture,
  isPlaying: () => {
    const manager = model?.internalModel?.motionManager;
    return manager && typeof manager.isFinished === 'function' ? !manager.isFinished() : false;
  },
});

function showStatus(text, duration = 5000) {
  clearTimeout(statusTimer);
  status.textContent = text;
  status.hidden = !text;
  if (text && duration) statusTimer = setTimeout(() => { status.hidden = true; }, duration);
}

function showSpeech(value) {
  const text = String(value ?? '').trim();
  if (!text) return;
  // A manual observation can arrive through both the host speech event and
  // invoke's result. Whichever arrives first should display it exactly once.
  if (speechController.isCurrent(text) && Date.now() - lastSpeechAt < 750) return;
  lastSpeechAt = Date.now();
  speechController.show(text);
}

function destroyModel() {
  playback.invalidate();
  effects?.configure(null);
  clearTimeout(previewTimer);
  previewTimer = null;
  if (!model) return;
  try { application?.stage.removeChild(model); model.destroy({ children: true }); } catch { /* a failed model may already have disposed itself */ }
  model = null;
  loadedModelId = '';
  naturalSize = null;
}

function queueModelPreview() {
  const active = state.activeModel;
  if (!api?.reportPreview || !model || !application || loadedModelId !== active?.id || active.previewUrl || previewTimer !== null) return;
  if (Date.now() - (previewAttempts.get(active.id) ?? -Infinity) < 30000) return;
  const target = model;
  const modelId = active.id;
  previewAttempts.set(modelId, Date.now());
  // Allow the regular renderer to draw its first frame. Extraction also draws
  // once when hidden, without starting a ticker or changing the visible model.
  previewTimer = setTimeout(() => {
    previewTimer = null;
    if (target !== model || modelId !== loadedModelId || state.activeModel?.previewUrl) return;
    try {
      application.renderer.render(application.stage);
      const extractor = application.renderer.plugins?.extract || application.renderer.extract;
      // Extract the rendered frame, not the transformed model. Rendering a
      // scaled/anchored model into its local bounds can shrink and clip it.
      const source = extractor.canvas();
      const width = source.width;
      const height = source.height;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 8 * 1024 * 1024) throw new Error('角色预览尺寸无效或像素过多');
      const sourceContext = source.getContext('2d', { willReadFrequently: true });
      if (!sourceContext) throw new Error('无法读取角色预览画布');
      const pixels = sourceContext.getImageData(0, 0, width, height).data;
      let left = width, top = height, right = -1, bottom = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0, offset = (y * width * 4) + 3; x < width; x++, offset += 4) {
          if (!pixels[offset]) continue;
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
      if (right < left || bottom < top) throw new Error('角色首帧尚未绘制，稍后重试预览');
      const cropWidth = right - left + 1;
      const cropHeight = bottom - top + 1;
      const factor = Math.min(256 / cropWidth, 384 / cropHeight);
      const thumbnail = document.createElement('canvas');
      thumbnail.width = Math.max(1, Math.round(cropWidth * factor));
      thumbnail.height = Math.max(1, Math.round(cropHeight * factor));
      const context = thumbnail.getContext('2d');
      if (!context) throw new Error('无法创建角色预览画布');
      context.drawImage(source, left, top, cropWidth, cropHeight, 0, 0, thumbnail.width, thumbnail.height);
      const dataUrl = thumbnail.toDataURL('image/png');
      if (dataUrl.length > Math.ceil(512 * 1024 / 3) * 4 + 22) throw new Error('角色预览超过512KB');
      Promise.resolve(api.reportPreview({ modelId, dataUrl })).catch((error) => api.reportError(`角色预览生成失败：${error?.message || error}`));
    } catch (error) { api.reportError(`角色预览生成失败：${error?.message || error}`); }
  }, 120);
}

function layout() {
  if (!application) return;
  const { left, top, width, height } = sceneBounds();
  const resolution = Math.min(2, window.devicePixelRatio || 1);
  const sizeKey = `${width}|${height}|${resolution}`;
  // Repeated host synchronization must not clear an unchanged canvas.
  if (rendererSizeKey !== sizeKey) {
    application.renderer.resolution = resolution;
    application.renderer.resize(width, height);
    rendererSizeKey = sizeKey;
  }
  if (!model || !naturalSize) return;
  const factor = Math.min(width * 0.94 / naturalSize.width, height * 0.73 / naturalSize.height);
  model.scale.set(factor);
  model.position.set(width / 2, height - Math.min(38, height * .1));
  // Preserve the 50% reference layout in model coordinates. The native window
  // may be fitted to the screen, so use the rendered model's scale, not the
  // requested setting. Anchoring to the stage's bottom would drift at >50%.
  const referenceFactor = Math.min(180 * .94 / naturalSize.width, 240 * .73 / naturalSize.height);
  const statusScale = factor / referenceFactor;
  status.style.left = `${model.position.x}px`;
  status.style.bottom = `${height - model.position.y + 23 * statusScale}px`;
  status.style.setProperty('--status-scale', statusScale);
  speechController.setAnchor({ left: left + width / 2 - model.width / 2, top: top + model.position.y - model.height, width: model.width, height: model.height });
  if (state.settings?.gazeTracking !== false && lastCursor) focus(lastCursor);
}

function applyFrameLayout(value) {
  const scene = value?.scene;
  if (!scene || !['left', 'top', 'width', 'height'].every((key) => Number.isFinite(scene[key])) || scene.width <= 0 || scene.height <= 0) return;
  frameLayout = value;
  stage.style.left = `${scene.left}px`;
  stage.style.top = `${scene.top}px`;
  stage.style.width = `${scene.width}px`;
  stage.style.height = `${scene.height}px`;
  layout();
  speechController.layout?.();
}

function ensureApplication() {
  if (application) return;
  if (!window.PIXI?.Application || !window.PIXI?.live2d?.Live2DModel || !window.Live2DCubismCore) throw new Error('Live2D 运行库尚未就绪，请检查桌宠组件文件');
  window.PIXI.live2d.Live2DModel.registerTicker(window.PIXI.Ticker);
  const scene = sceneBounds();
  application = new window.PIXI.Application({ view: canvas, width: scene.width, height: scene.height, backgroundAlpha: 0, transparent: true, antialias: true, autoDensity: true, resolution: Math.min(2, window.devicePixelRatio || 1), clearBeforeRender: true });
  rendererSizeKey = `${scene.width}|${scene.height}|${Math.min(2, window.devicePixelRatio || 1)}`;
  application.ticker.maxFPS = 30;
  // Own the model update loop so hiding the window stops both rendering and
  // Cubism physics. Live2D's default autoUpdate uses PIXI's shared ticker.
  application.ticker.add(() => { if (visible && model) model.update(application.ticker.deltaMS); });
  // Live2D updates its vertices during Pixi's render callback (-25), not in
  // model.update(). Read those vertices afterwards to avoid one-frame lag.
  application.ticker.add(() => { if (visible && model) effects?.update(); }, null, -26);
  window.PIXI.Ticker.shared.maxFPS = 30;
  window.PIXI.Ticker.shared.autoStart = false;
  window.PIXI.Ticker.shared.stop();
  defaultPreserveExpression = !!window.PIXI.live2d.config?.preserveExpressionOnMotion;
  setVisibility(visible);
}

async function loadModel(active) {
  const key = active ? `${active.id}|${active.entryUrl}` : '';
  if (modelFailure?.key === key && Date.now() < modelFailure.retryAt) return;
  if (requestedModel === key) {
    // A hot-reloaded plugin has a fresh runtime although this renderer and its
    // successfully loaded model survive. Re-acknowledge without reloading it.
    if (model && loadedModelId === active?.id && state.runtime?.modelLoaded === false && !state.runtime?.modelError) api?.modelLoaded(active.id);
    return;
  }
  requestedModel = key;
  const version = ++loadVersion;
  if (!active) {
    destroyModel();
    placeholderTitle.textContent = '待导入 Live2D 模型';
    placeholderDetail.textContent = '右键打开菜单，选择桌宠控制台后导入角色模型';
    placeholder.hidden = false;
    return;
  }
  showStatus(`正在加载 ${active.name || '角色'}…`, 0);
  let candidate = null;
  let loadTimeout = null;
  try {
    const url = new URL(active.entryUrl, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/desktop-pet/model/')) throw new Error('角色资源地址无效');
    ensureApplication();
    candidate = await new Promise((resolve, reject) => {
      let expired = false;
      loadTimeout = setTimeout(() => { expired = true; reject(new Error('模型加载超过30秒，请检查模型文件与运行库是否完整')); }, 30000);
      Promise.resolve().then(() => window.PIXI.live2d.Live2DModel.from(url.href, { autoInteract: false, autoUpdate: false, motionPreload: 'NONE' })).then((next) => {
        if (expired) { try { next.destroy({ children: true }); } catch {} }
        else resolve(next);
      }, reject);
    });
    clearTimeout(loadTimeout);
    loadTimeout = null;
    if (version !== loadVersion) { candidate.destroy({ children: true }); return; }
    // The scheduler owns random idle selection, including disabled actions/weights.
    const manager = candidate.internalModel?.motionManager;
    if (manager?.groups) manager.groups.idle = '__qqa_no_automatic_idle__';
    const nextSize = { width: candidate.width, height: candidate.height };
    if (![nextSize.width, nextSize.height].every((value) => Number.isFinite(value) && value > 0)) throw new Error('模型尺寸无效');
    candidate.anchor.set(0.5, 1);
    const scene = sceneBounds();
    const factor = Math.min(scene.width * 0.94 / nextSize.width, scene.height * 0.73 / nextSize.height);
    candidate.scale.set(factor);
    candidate.position.set(scene.width / 2, scene.height - Math.min(38, scene.height * .1));
    // Fully prepare the replacement before disposing the last working model.
    application.stage.addChild(candidate);
    destroyModel();
    model = candidate;
    candidate = null;
    loadedModelId = active.id;
    naturalSize = nextSize;
    modelProfile = buildModelProfile(state.activeModel || active, model);
    if (modelProfile.daimeow) enableMotionTransitions(model);
    if (window.PIXI.live2d.config) window.PIXI.live2d.config.preserveExpressionOnMotion = modelProfile.daimeow || defaultPreserveExpression;
    if (modelProfile.daimeow && !effects) effects = createDaiMeowEffects({ container: document.getElementById('daimeow-props'), syncToModelFrame: true, report: (message) => api?.reportError(message) });
    effects?.configure(modelProfile.daimeow ? model : null);
    actions.configure(state.activeModel?.motions || [], state.settings?.motion || {}, modelProfile);
    placeholder.hidden = true;
    layout();
    setVisibility(visible);
    showStatus(active.name || '角色已加载', 2500);
    modelFailure = null;
    api?.modelLoaded(active.id);
    console.log(`[pet] 模型已加载并上报：${active.id}（${active.name || ''}）`);
    queueModelPreview();
    await actions.setState(currentStatus);
  } catch (error) {
    if (candidate) { try { application?.stage.removeChild(candidate); candidate.destroy({ children: true }); } catch {} }
    if (version !== loadVersion) return;
    // A failed request must not remain permanently deduplicated. State pushes
    // may retry it, with bounded backoff rather than a tight load/error loop.
    requestedModel = '';
    const attempts = modelFailure?.key === key ? modelFailure.attempts + 1 : 1;
    modelFailure = { key, attempts, retryAt: Date.now() + Math.min(300000, 30000 * 2 ** Math.min(attempts - 1, 4)) };
    // Keep the previous successful model visible if a replacement fails.
    if (!model) {
      placeholder.hidden = false;
      placeholderTitle.textContent = 'Live2D 模型加载失败';
      placeholderDetail.textContent = String(error?.message || error).slice(0, 220);
    }
    showStatus('加载失败，右键打开桌宠控制台查看', 12000);
    api?.modelLoaded(active.id, String(error?.message || error));
    console.log(`[pet] 模型加载失败：${String(error?.message || error)}`);
  } finally { clearTimeout(loadTimeout); }
}

function focus(position) {
  lastCursor = position;
  if (!visible || state.settings?.gazeTracking === false) return;
  const scene = sceneBounds();
  const localX = position.x - scene.left;
  const localY = position.y - scene.top;
  const x = Math.max(-1, Math.min(1, (localX - scene.width / 2) / (scene.width / 2)));
  const y = Math.max(-1, Math.min(1, (localY - scene.height / 2) / (scene.height / 2)));
  pet.style.setProperty('--eye-x', `${x * 6}px`);
  pet.style.setProperty('--eye-y', `${y * 4}px`);
  // focus() only affects parameters provided by this model; unsupported gaze is harmless.
  if (model?.focus) { try { model.focus(localX, localY); } catch { /* model has no gaze parameters */ } }
}

function setVisibility(value) {
  visible = !!value;
  document.body.classList.toggle('paused', !visible);
  actions.setVisible(visible);
  effects?.setVisible(visible);
  if (model) model.autoUpdate = false;
  if (application) { if (visible) application.start(); else application.stop(); }
  if (!visible) {
    statusVersion++;
    clearTimeout(replyResetTimer);
    replyResetTimer = null;
    currentStatus = 'idle';
    void actions.setState('idle');
    speechController.close(); playback.invalidate(); model?.internalModel?.motionManager?.stopAllMotions?.(); finishDrag(false);
  }
}

function renderState(next) {
  state = next || { settings: {} };
  const active = state.activeModel || null;
  const cfg = state.settings || {};
  const key = JSON.stringify([active?.id, active?.motions, cfg.motion]);
  if (key !== motionSettingsKey) {
    motionSettingsKey = key;
    actions.configure(active?.motions || [], cfg.motion || {}, loadedModelId === active?.id ? modelProfile : buildModelProfile(active || {}));
  }
  pet.classList.toggle('position-locked', !!cfg.positionLocked);
  if (cfg.gazeTracking === false) {
    pet.style.setProperty('--eye-x', '0px');
    pet.style.setProperty('--eye-y', '0px');
    if (model?.focus) { const scene = sceneBounds(); model.focus(scene.width / 2, scene.height * 0.55, true); }
  }
  observe.hidden = cfg.mouseThrough === true;
  void loadModel(active);
  queueModelPreview();
}

async function command(value) {
  if (value?.type === 'speech') showSpeech(value.text);
  else if (['motion', 'expression', 'reset-expression'].includes(value?.type)) {
    let ok = false, error = '';
    try {
      if (value.type === 'motion') ok = await actions.preview(value.id);
      else if (value.type === 'expression') ok = await actions.expression(value.id);
      else ok = modelProfile.daimeow ? await actions.setPosture('stand') : playback.resetExpression({ trigger: 'manual' });
      if (!ok) error = actions.getState().lastRejectedReason || '当前模型暂时无法执行此操作';
    } catch (cause) { error = cause?.message || String(cause); }
    if (error) showStatus(error);
    api?.commandResult?.({ requestId: value.requestId, ok: !!ok, error });
  } else if (value?.type === 'status') {
    if (!visible) return;
    const next = ['idle', 'thinking', 'reply', 'error'].includes(value.state) ? value.state : 'idle';
    // Host synchronization can repeat a status while its motion is loading.
    // Its original command still owns readiness and the reply lifetime.
    if (next === currentStatus) return;
    const version = ++statusVersion;
    clearTimeout(replyResetTimer);
    replyResetTimer = null;
    currentStatus = next;
    await actions.setState(next);
    if (version !== statusVersion || !visible) return;
    if (next === 'reply' || next === 'error') replyResetTimer = setTimeout(() => {
      if (version !== statusVersion || currentStatus !== next || !visible) return;
      replyResetTimer = null;
      currentStatus = 'idle';
      void actions.setState('idle');
    }, 6000);
  }
}

function tickDrag() {
  if (!pointer?.dragging) { dragFrame = null; return; }
  api?.tickDrag();
  dragFrame = requestAnimationFrame(tickDrag);
}

function finishDrag(react = false) {
  if (!pointer) return;
  const previous = pointer;
  pointer = null;
  if (dragFrame !== null) cancelAnimationFrame(dragFrame);
  dragFrame = null;
  pet.classList.remove('dragging');
  if (previous.dragging) api?.endDrag();
  else if (react) {
    api?.interact();
    // 点击动作照旧立刻播（手感不能等 260ms），
    // 「弹什么」交给 tap 判定：单击=今日用量，双击=开发工单。
    if (model) void actions.click();
    else {
      placeholder.classList.remove('reacting');
      void placeholder.offsetWidth;
      placeholder.classList.add('reacting');
    }
    handleTap();
  }
}

/** 单击/双击判定：260ms 内第二次点击 = 双击。 */
function handleTap() {
  if (tapTimer) {
    clearTimeout(tapTimer);
    tapTimer = null;
    // 先把可能已经弹出来的用量卡片收掉，再开对话框（双击不该留下两层窗）。
    api?.closeUsage?.();
    api?.openDevChat?.();
    return;
  }
  tapTimer = setTimeout(() => {
    tapTimer = null;
    void showUsage();
  }, TAP_DELAY_MS);
}

/** 今日用量：主进程现算后弹出卡片；失败才用气泡说明。 */
async function showUsage() {
  if (typeof api?.usageToday !== 'function') {
    showSpeech('用量卡片只在桌面版可用。');
    return;
  }
  try {
    const result = await api.usageToday();
    if (result && result.ok === false) showSpeech(result.error || '暂时拿不到今日用量。');
  } catch (error) {
    showSpeech(`读取今日用量失败：${error?.message || error}`);
  }
}

pet.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('button, .speech')) return;
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
  pet.setPointerCapture(event.pointerId);
});
pet.addEventListener('pointermove', (event) => {
  if (!pointer || pointer.id !== event.pointerId || state.settings?.positionLocked) return;
  if (!pointer.dragging && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5) {
    pointer.dragging = true;
    pet.classList.add('dragging');
    api?.beginDrag();
    dragFrame = requestAnimationFrame(tickDrag);
  }
});
pet.addEventListener('pointerup', (event) => { if (pointer?.id === event.pointerId) finishDrag(true); });
pet.addEventListener('pointercancel', () => finishDrag(false));
pet.addEventListener('lostpointercapture', () => finishDrag(false));
window.addEventListener('blur', () => finishDrag(false));
// A double click consists of two pointer-up interactions. The action cooldown
// handles repetition; it must never bring the main console to the foreground.
pet.addEventListener('contextmenu', (event) => { if (event.target.closest('.speech')) return; event.preventDefault(); finishDrag(false); api?.openMenu(); });
observe.addEventListener('click', async () => {
  if (observing) return;
  observing = true;
  observe.disabled = true;
  observe.textContent = '正在观察…';
  showStatus('正在读取当前屏幕，等待模型回复…', 0);
  try {
    const result = await api?.observeNow();
    if (!result) showSpeech('桌宠服务暂时未就绪，请稍后再试。');
    else if (result.cancelled || result.canceled) showSpeech('本次观察已取消。');
    else if (result.skipped) showSpeech(result.reason || '本次观察暂未开始，请稍后再试。');
    else if (result.error || result.ok === false) showSpeech(result.error || result.reason || '屏幕观察未完成，请稍后再试。');
    else if (result.reply || result.text) showSpeech(result.reply || result.text);
    else showSpeech('本次观察没有收到回复，请稍后重试。');
  } catch (error) { showSpeech(`屏幕观察失败：${error?.message || error}`); }
  finally { observing = false; observe.disabled = false; observe.textContent = '看看屏幕'; showStatus('', 0); }
});
window.addEventListener('resize', layout);
window.addEventListener('error', (event) => {
  api?.reportError(event.message || '桌宠脚本加载失败');
});
window.addEventListener('unhandledrejection', (event) => {
  api?.reportError(event.reason?.message || event.reason || '桌宠渲染异常');
});
window.addEventListener('beforeunload', () => {
  statusVersion++;
  loadVersion++;
  actions.stop();
  finishDrag(false);
  speechController.destroy();
  effects?.destroy();
  clearTimeout(statusTimer);
  clearTimeout(replyResetTimer);
  clearTimeout(previewTimer);
  for (const unsubscribe of unsubscribers) unsubscribe();
  destroyModel();
  application?.destroy(false);
});

if (api) {
  if (typeof api.onLayout === 'function') unsubscribers.push(api.onLayout(applyFrameLayout));
  unsubscribers.push(api.onState(renderState), api.onCommand((value) => void command(value)), api.onCursor(focus), api.onVisibility(setVisibility));
  try { renderState(await api.getState()); api.ready(); } catch (error) { showSpeech(`桌宠初始化失败：${error.message}`); }
} else {
  placeholderTitle.textContent = '请从 QQ Agent 启动桌宠';
  placeholderDetail.textContent = '桌宠窗口需要桌面程序提供的交互接口';
  observe.hidden = true;
}
