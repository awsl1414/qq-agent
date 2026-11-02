import { BrowserWindow, Menu, dialog, ipcMain, screen, desktopCapturer, powerMonitor, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { petSize, restorePetBounds, dragPetBounds, layoutPetSpeechWindow, layoutDetachedPetSpeech } from './desktop-pet-geometry.js';

const directory = path.dirname(fileURLToPath(import.meta.url));

// 用量卡片（2026-10-24 起是一式两行的一行式用量串，窗口随之收窄）
const USAGE_CARD_SIZE = Object.freeze({ width: 380, height: 84 });
// 卡片可见期间的数据刷新间隔：与 buildUsageStats 的 5 秒微缓存同一拍，
// 既能让「搜索：N 次」这类下面那串跟着动，又不会触发全量重算风暴。
const USAGE_REFRESH_MS = 5000;

export function createDesktopPetHost({ getMainWindow, showMainWindow, getService, getUsageToday = null, devApi = null, log = console.log }) {
  let petWindow = null;
  let state = null;
  let started = false;
  let closed = false;
  let rendererReady = false;
  let origin = '';
  let petSession = null;
  let cursorTimer = null;
  let serviceTimer = null;
  let boundService = null;
  let dragTimer = null;
  let drag = null;
  let saveTimer = null;
  let applyingBounds = false;
  let baseBounds = null;
  let speechWindow = null;
  let speechReady = false;
  let speechText = '';
  let speechRevision = 0;
  let speechSize = { width: 0, height: 0 };
  let speechAnchor = null;
  let speechLayout = null;
  let usageWindow = null;
  let usageReady = false;
  let usageData = null;
  let usageRevision = 0;
  let usageTimer = null;
  let usageRefreshTimer = null;
  let devWindow = null;
  let devReady = false;
  let windowLayout = null;
  let captureInProgress = false;
  const ipcListeners = [];
  const ipcHandlers = [];
  const pendingCommands = [];
  const previews = new Map();
  let previewSerial = 0;

  function cancelPreviews(reason) {
    for (const pending of previews.values()) { clearTimeout(pending.timer); pending.resolve({ ok: false, error: reason }); }
    previews.clear();
  }

  const service = () => getService?.();
  const settings = () => state?.settings || {};
  const alive = () => petWindow && !petWindow.isDestroyed();
  const send = (channel, value) => { if (alive() && rendererReady) petWindow.webContents.send(channel, value); };
  const report = (error) => log(`[desktop-pet] ${error?.message || error}`);
  function validPet(event) {
    if (!alive() || event.sender !== petWindow.webContents || event.senderFrame !== petWindow.webContents.mainFrame) return false;
    try { return new URL(event.senderFrame.url).origin === origin && new URL(event.senderFrame.url).pathname === '/desktop-pet/pet.html'; } catch { return false; }
  }
  function validSpeech(event) {
    if (!speechWindow || speechWindow.isDestroyed() || event.sender !== speechWindow.webContents || event.senderFrame !== speechWindow.webContents.mainFrame) return false;
    try { const url = new URL(event.senderFrame.url); return url.origin === origin && url.pathname === '/desktop-pet/speech.html'; } catch { return false; }
  }
  const speechAlive = () => speechWindow && !speechWindow.isDestroyed();
  const sendSpeech = (channel, value) => { if (speechAlive() && speechReady) speechWindow.webContents.send(channel, value); };
  // ── 单击用量卡片 / 双击开发工单对话框 ────────────────────────────────
  // 两个窗口都是 petWindow 的子窗：随桌宠显示/隐藏、随宿主关闭一起销毁。
  // 页面同样走同源 HTTP（受统一 CSP 管），preload 只给固定几个方法。
  const usageAlive = () => usageWindow && !usageWindow.isDestroyed();
  const devAlive = () => devWindow && !devWindow.isDestroyed();
  const sendUsage = (channel, value) => { if (usageAlive() && usageReady) usageWindow.webContents.send(channel, value); };
  const sendDev = (channel, value = {}) => { if (devAlive() && devReady) devWindow.webContents.send(channel, value); };
  function validUsage(event) {
    if (!usageAlive() || event.sender !== usageWindow.webContents || event.senderFrame !== usageWindow.webContents.mainFrame) return false;
    try { const url = new URL(event.senderFrame.url); return url.origin === origin && url.pathname === '/desktop-pet/usage-card.html'; } catch { return false; }
  }
  function validDev(event) {
    if (!devAlive() || event.sender !== devWindow.webContents || event.senderFrame !== devWindow.webContents.mainFrame) return false;
    try { const url = new URL(event.senderFrame.url); return url.origin === origin && url.pathname === '/desktop-pet/dev-chat.html'; } catch { return false; }
  }
  /** 把浮窗贴到桌宠旁边（上方优先，放不下就夹进工作区）。 */
  function anchorNearPet(win, size, place = 'above') {
    const display = baseBounds ? screen.getDisplayMatching(baseBounds) : screen.getPrimaryDisplay();
    const area = display.workArea;
    const pet = baseBounds || { x: area.x + Math.round(area.width / 2), y: area.y + Math.round(area.height / 2), width: 0, height: 0 };
    let x = Math.round(pet.x + pet.width / 2 - size.width / 2);
    let y = Math.round(pet.y - size.height - 10);
    if (place === 'right') {
      x = Math.round(pet.x + pet.width + 12);
      y = Math.round(pet.y + pet.height - size.height);
    }
    x = Math.min(Math.max(x, area.x + 8), area.x + area.width - size.width - 8);
    y = Math.min(Math.max(y, area.y + 8), area.y + area.height - size.height - 8);
    win.setBounds({ x, y, width: size.width, height: size.height });
  }
  function ensureUsageWindow() {
    if (usageAlive()) return usageWindow;
    usageWindow = new BrowserWindow({
      width: USAGE_CARD_SIZE.width, height: USAGE_CARD_SIZE.height, parent: petWindow || null, transparent: true, backgroundColor: '#00000000', frame: false,
      show: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: true, hasShadow: false, title: 'QQ Agent 今日用量', alwaysOnTop: true,
      webPreferences: { preload: path.join(directory, 'pet-usage-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, session: petSession, backgroundThrottling: false },
    });
    usageWindow.setContentProtection(true);
    usageWindow.setMenuBarVisibility(false);
    usageWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    usageWindow.webContents.on('will-navigate', (event, url) => { if (url !== `${origin}/desktop-pet/usage-card.html`) event.preventDefault(); });
    usageWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    usageWindow.webContents.on('did-start-loading', () => { usageReady = false; });
    usageWindow.webContents.on('render-process-gone', (_event, details) => { usageReady = false; report(`用量卡片渲染进程停止：${details.reason}`); });
    usageWindow.webContents.on('preload-error', (_event, _preloadPath, error) => report(`用量卡片 preload 加载失败：${error?.message || error}`));
    usageWindow.on('closed', () => { usageWindow = null; usageReady = false; });
    usageWindow.loadURL(`${origin}/desktop-pet/usage-card.html`).catch((error) => report(`用量卡片加载失败：${error?.message || error}`));
    return usageWindow;
  }
  function ensureDevWindow() {
    if (devAlive()) return devWindow;
    devWindow = new BrowserWindow({
      width: 452, height: 568, parent: petWindow || null, transparent: true, backgroundColor: '#00000000', frame: false,
      show: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: true, hasShadow: false, title: 'QQ Agent 开发工单', alwaysOnTop: true,
      webPreferences: { preload: path.join(directory, 'pet-devchat-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, session: petSession, backgroundThrottling: false },
    });
    devWindow.setContentProtection(true);
    devWindow.setMenuBarVisibility(false);
    devWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    devWindow.webContents.on('will-navigate', (event, url) => { if (url !== `${origin}/desktop-pet/dev-chat.html`) event.preventDefault(); });
    devWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    devWindow.webContents.on('did-start-loading', () => { devReady = false; });
    devWindow.webContents.on('render-process-gone', (_event, details) => { devReady = false; report(`开发工单窗渲染进程停止：${details.reason}`); });
    devWindow.webContents.on('preload-error', (_event, _preloadPath, error) => report(`开发工单窗 preload 加载失败：${error?.message || error}`));
    devWindow.on('close', (event) => { if (!closed) { event.preventDefault(); devWindow.hide(); } });
    devWindow.on('closed', () => { devWindow = null; devReady = false; });
    devWindow.loadURL(`${origin}/desktop-pet/dev-chat.html`).catch((error) => report(`开发工单窗加载失败：${error?.message || error}`));
    return devWindow;
  }
  function clearUsageTimers() {
    if (usageTimer) clearTimeout(usageTimer);
    usageTimer = null;
    if (usageRefreshTimer) clearInterval(usageRefreshTimer);
    usageRefreshTimer = null;
  }
  function hideUsageWindow() {
    clearUsageTimers();
    if (usageAlive()) usageWindow.hide();
  }
  function pushUsage(data) {
    usageData = {
      totals: data.totals || {},
      chats: Array.isArray(data.chats) ? data.chats.length : 0,
      models: Array.isArray(data.models) ? data.models.slice(0, 1) : [],
      range: data.range || 'today',
      // 卡片第二行「搜索：N 次」的数据口（2026-10-24 一行式用量串）
      searchCount: Number(data.searchCount) || 0,
    };
    usageRevision++;
    // 页面可能还没加载完：ready 时会主动来取一次（qqa-pet-usage:ready）。
    if (usageAlive() && !usageWindow.webContents.isLoading()) sendUsage('qqa-pet-usage:data', { data: usageData, revision: usageRevision });
  }
  async function refreshUsageData() {
    if (!usageAlive() || typeof getUsageToday !== 'function') return;
    let data;
    try { data = await getUsageToday(); }
    catch { return; }
    // 窗口可能在等待期间被收掉：晚到的数据不再推送
    if (!usageAlive() || !data || data.ok === false) return;
    pushUsage(data);
  }
  async function presentUsage() {
    if (!alive() || !baseBounds) return { ok: false, error: '桌宠窗口未就绪' };
    if (typeof getUsageToday !== 'function') return { ok: false, error: '用量统计暂不可用' };
    const data = await getUsageToday();
    if (!data || data.ok === false) return { ok: false, error: data?.error || '用量统计暂不可用' };
    const win = ensureUsageWindow();
    pushUsage(data);
    anchorNearPet(win, USAGE_CARD_SIZE, 'above');
    win.showInactive();
    clearUsageTimers();
    usageTimer = setTimeout(() => { if (usageAlive()) hideUsageWindow(); }, 16000);
    // 常驻期间定时重取统计：下面那串（搜索次数）和主串一起刷新，
    // 不停在单击那一刻的旧数字上。5 秒与统计微缓存同拍，不会加重算负担。
    usageRefreshTimer = setInterval(() => { void refreshUsageData(); }, USAGE_REFRESH_MS);
    return { ok: true };
  }
  function openDevChat() {
    if (!alive() || !baseBounds) return false;
    const win = ensureDevWindow();
    anchorNearPet(win, { width: 452, height: 568 }, 'right');
    win.show();
    win.focus();
    sendDev('qqa-dev:refresh');
    return true;
  }
  function layoutSpeech() {
    if (!speechAlive() || !baseBounds || !speechText || !speechSize.width) return null;
    const next = layoutDetachedPetSpeech(baseBounds, speechAnchor, speechSize, screen.getAllDisplays(), screen.getPrimaryDisplay().id);
    const old = speechWindow.getBounds();
    if (old.width !== next.bounds.width || old.height !== next.bounds.height) speechWindow.hide();
    if (Object.keys(next.bounds).some((key) => old[key] !== next.bounds[key])) speechWindow.setBounds(next.bounds);
    speechLayout = next;
    sendSpeech('qqa-pet-speech:layout', { revision: speechRevision, tail: next.tail });
    return { revision: speechRevision, tail: next.tail };
  }
  function presentSpeech(text) {
    if (!alive() || state?.enabled === false || settings().visible === false) return;
    const content = Array.from(String(text || '').trim()).slice(0, 1500).join('');
    if (!content) return;
    speechWindow?.hide();
    speechText = content;
    speechSize = { width: 0, height: 0 };
    speechLayout = null;
    speechRevision++;
    sendSpeech('qqa-pet-speech:update', { text: content, revision: speechRevision, speechLimit: publicLayout().speechLimit });
  }
  function handleSpeech(channel, callback) {
    ipcMain.handle(channel, async (event, value) => { if (!validSpeech(event)) throw new Error('桌宠气泡 IPC 来源无效'); return callback(value); });
    ipcHandlers.push(channel);
  }
  function handleUsage(channel, callback) {
    ipcMain.handle(channel, async (event, value) => { if (!validUsage(event)) throw new Error('用量卡片 IPC 来源无效'); return callback(value); });
    ipcHandlers.push(channel);
  }
  function listenUsage(channel, callback) {
    const wrapped = (event, value) => { if (validUsage(event)) { try { callback(value); } catch (error) { report(error); } } };
    ipcMain.on(channel, wrapped);
    ipcListeners.push([channel, wrapped]);
  }
  function handleDev(channel, callback) {
    ipcMain.handle(channel, async (event, value) => { if (!validDev(event)) throw new Error('开发工单窗 IPC 来源无效'); return callback(value); });
    ipcHandlers.push(channel);
  }
  function listenDev(channel, callback) {
    const wrapped = (event, value) => { if (validDev(event)) { try { callback(value); } catch (error) { report(error); } } };
    ipcMain.on(channel, wrapped);
    ipcListeners.push([channel, wrapped]);
  }
  function listen(channel, callback) {
    const wrapped = (event, value) => { if (validPet(event)) { try { callback(value); } catch (error) { report(error); } } };
    ipcMain.on(channel, wrapped);
    ipcListeners.push([channel, wrapped]);
  }
  function handle(channel, callback) {
    ipcMain.handle(channel, async (event, value) => { if (!validPet(event)) throw new Error('桌宠 IPC 来源无效'); return callback(value); });
    ipcHandlers.push(channel);
  }
  async function update(patch) {
    try { return await service()?.updateSettings?.(patch); } catch (error) { report(error); return null; }
  }
  function openConsole() {
    showMainWindow?.();
    const main = getMainWindow?.();
    if (main && !main.isDestroyed()) {
      const open = () => { if (!main.isDestroyed()) main.webContents.send('qqa-pet:open-console'); };
      if (main.webContents.isLoading()) main.webContents.once('did-finish-load', open);
      else open();
    }
  }
  function persistPosition() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (alive() && baseBounds) {
      const { x, y } = baseBounds;
      void update({ position: { x, y } });
    }
  }
  function publicLayout() {
    return windowLayout ? { scene: { ...windowLayout.scene }, speechLimit: { ...windowLayout.speechLimit } } : { scene: { left: 0, top: 0, ...petSize(settings().scale) }, speechLimit: { width: 1, height: 1 } };
  }
  function applyWindowGeometry(force = false) {
    if (!alive() || !baseBounds || drag) return publicLayout();
    const next = layoutPetSpeechWindow(baseBounds, {}, screen.getAllDisplays(), screen.getPrimaryDisplay().id);
    const changed = JSON.stringify(next) !== JSON.stringify(windowLayout);
    windowLayout = next;
    const old = petWindow.getBounds();
    if (Object.keys(next.bounds).some((key) => old[key] !== next.bounds[key])) {
      applyingBounds = true;
      try { petWindow.setBounds(next.bounds); } finally { applyingBounds = false; }
    }
    if (changed || force) {
      send('qqa-pet:layout', publicLayout());
      sendSpeech('qqa-pet-speech:limits', publicLayout().speechLimit);
    }
    layoutSpeech();
    return publicLayout();
  }
  function clearSpeechSize() {
    speechSize = { width: 0, height: 0 };
    speechText = '';
    speechLayout = null;
    speechRevision++;
    if (speechAlive()) speechWindow.hide();
    sendSpeech('qqa-pet-speech:reset', { revision: speechRevision });
    return publicLayout();
  }
  function endDrag() {
    if (!drag) return;
    drag = null;
    clearInterval(dragTimer);
    dragTimer = null;
    if (alive()) {
      baseBounds = restorePetBounds(baseBounds, petSize(settings().scale), screen.getAllDisplays(), screen.getPrimaryDisplay().id);
      applyWindowGeometry();
      persistPosition();
    }
  }
  function tickDrag() {
    if (!drag || !alive()) return;
    drag.lastTick = Date.now();
    const next = dragPetBounds(screen.getCursorScreenPoint(), drag.offset, drag.size);
    // Always write width and height with position: fractional DPI must not grow it.
    baseBounds = { x: next.x + drag.scene.left, y: next.y + drag.scene.top, width: drag.scene.width, height: drag.scene.height };
    windowLayout = { ...windowLayout, bounds: next };
    petWindow.setBounds(next);
    layoutSpeech();
  }
  function beginDrag() {
    if (drag || !alive() || settings().positionLocked || settings().mouseThrough) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = petWindow.getBounds();
    drag = { offset: { x: cursor.x - bounds.x, y: cursor.y - bounds.y }, size: { width: bounds.width, height: bounds.height }, scene: { ...publicLayout().scene }, lastTick: Date.now() };
    dragTimer = setInterval(() => { if (drag && Date.now() - drag.lastTick > 80) tickDrag(); }, 32);
  }
  async function importModel() {
    const filename = await host.pickModel();
    if (filename) { try { await service()?.importModel?.(filename); } catch (error) { report(error); host.command({ type: 'speech', text: `导入失败：${error.message}` }); } }
  }
  function contextMenu() {
    if (!alive()) return;
    const cfg = settings();
    Menu.buildFromTemplate([
      { label: '打开桌宠控制台', click: openConsole },
      { label: '导入 Live2D 角色模型…', click: () => void importModel() },
      { type: 'separator' },
      { label: '看看当前屏幕', enabled: state?.enabled !== false, click: () => void service()?.observeNow?.({ manual: true }).catch(report) },
      { label: '视线跟随鼠标', type: 'checkbox', checked: cfg.gazeTracking !== false, click: (item) => void update({ gazeTracking: item.checked }) },
      { label: '固定位置', type: 'checkbox', checked: !!cfg.positionLocked, click: (item) => void update({ positionLocked: item.checked }) },
      { label: '始终置顶', type: 'checkbox', checked: cfg.alwaysOnTop !== false, click: (item) => void update({ alwaysOnTop: item.checked }) },
      { label: '鼠标穿透（从控制台关闭）', type: 'checkbox', checked: !!cfg.mouseThrough, click: (item) => void update({ mouseThrough: item.checked }) },
      { type: 'separator' },
      { label: '隐藏桌宠', click: () => void update({ visible: false }) },
    ]).popup({ window: petWindow });
  }
  function applyState() {
    if (!alive() || !state) return;
    const cfg = settings();
    if (cfg.positionLocked || cfg.mouseThrough) endDrag();
    petWindow.setAlwaysOnTop(cfg.alwaysOnTop !== false, 'floating');
    petWindow.setOpacity(Math.min(1, Math.max(0.2, Number(cfg.opacity) || 1)));
    petWindow.setIgnoreMouseEvents(!!cfg.mouseThrough, { forward: true });
    const visible = state.enabled !== false && cfg.visible !== false;
    if (!visible) clearSpeechSize();
    if (speechAlive()) {
      speechWindow.setAlwaysOnTop(cfg.alwaysOnTop !== false, 'floating');
      speechWindow.setOpacity(Math.min(1, Math.max(0.2, Number(cfg.opacity) || 1)));
      speechWindow.setIgnoreMouseEvents(!!cfg.mouseThrough, { forward: true });
    }
    if (!drag) {
      baseBounds = restorePetBounds(cfg.position, petSize(cfg.scale), screen.getAllDisplays(), screen.getPrimaryDisplay().id);
      applyWindowGeometry();
    }
    if (visible && rendererReady) petWindow.showInactive();
    else petWindow.hide();
    // 桌宠隐藏 = 它的两个子窗也一起收起（用量卡片 / 开发工单对话框）
    if (!visible) {
      hideUsageWindow();
      if (devAlive()) devWindow.hide();
    }
    send('qqa-pet:state-update', state);
    send('qqa-pet:visibility', visible);
  }
  function displaysChanged() {
    if (!alive() || drag) return;
    baseBounds = restorePetBounds(baseBounds, petSize(settings().scale), screen.getAllDisplays(), screen.getPrimaryDisplay().id);
    applyWindowGeometry(true);
    persistPosition();
  }
  function reconcileService() {
    if (closed) return;
    try {
      const next = service();
      if (!next) {
        if (boundService) {
          boundService = null;
          state = { ...state, enabled: false };
          applyState();
        }
        return;
      }
      const changed = next !== boundService;
      if (changed) cancelPreviews('桌宠插件已重新加载，请重新预览动作');
      boundService = next;
      // bindHost is idempotent. Also call it for the same instance: disabling a
      // plugin detaches its host, and re-enabling need not recreate the service.
      next.bindHost?.(host);
      if (changed) {
        state = next.getState?.() || state;
        applyState();
      }
    } catch (error) { report(error); }
  }

  const host = {
    // ⚠️ 必须是**严格布尔**。原来写的是 `started && !closed && Boolean(alive())`，
    //    未启动时整个表达式是 undefined；而 service 侧判的是
    //    `Boolean(host && host.available !== false)` —— `undefined !== false` 为真，
    //    于是「桌宠窗口根本没建起来」会被当成「可用」。后果有两层：
    //    界面上一直显示「正在加载」而不是本该显示的「请通过 QQ Agent 桌面程序
    //    打开桌宠」，排障时方向直接跑偏；send() 也会往一个不存在的窗口发命令。
    get available() { return Boolean(started && !closed && alive()); },
    async start({ port, consoleToken = '' }) {
      if (started && !closed) return host;
      if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('桌宠服务端口无效');
      started = true;
      closed = false;
      origin = `http://127.0.0.1:${Number(port)}`;
      petSession = session.fromPartition('qqa-desktop-pet');
      petSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      petSession.setPermissionCheckHandler(() => false);
      petSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/api/desktop-pet/model/*`] }, (details, callback) => {
        let permitted = false;
        try { const url = new URL(details.url); permitted = url.origin === origin && url.pathname.startsWith('/api/desktop-pet/model/'); } catch { /* reject token injection */ }
        const requestHeaders = { ...details.requestHeaders };
        if (permitted && consoleToken) requestHeaders['x-console-token'] = String(consoleToken);
        callback({ requestHeaders });
      });
      petWindow = new BrowserWindow({
        ...petSize(1), transparent: true, backgroundColor: '#00000000', frame: false,
        show: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
        skipTaskbar: true, hasShadow: false, title: 'QQ Agent 桌宠', alwaysOnTop: true,
        webPreferences: { preload: path.join(directory, 'pet-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, session: petSession, backgroundThrottling: true },
      });
      // Windows excludes our overlay from the image observed by the companion.
      petWindow.setContentProtection(true);
      petWindow.setMenuBarVisibility(false);
      petWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      petWindow.webContents.on('will-navigate', (event, url) => { if (url !== `${origin}/desktop-pet/pet.html`) event.preventDefault(); });
      petWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
      petWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        const details = typeof level === 'object' && level ? level : { level, message, lineNumber: line, sourceId };
        const source = String(details.sourceId || '').split(/[?#]/)[0].slice(-160);
        log(`[desktop-pet renderer:${details.level ?? 'log'}] ${String(details.message || '').slice(0, 1800)}${source ? ` (${source}:${details.lineNumber || 0})` : ''}`);
      });
      petWindow.webContents.on('preload-error', (_event, _preloadPath, error) => report(`桌宠 preload 加载失败：${error?.message || error}`));
      petWindow.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => report(`桌宠${isMainFrame ? '页面' : '资源'}加载失败（${code}）：${description}`));
      petWindow.webContents.on('did-start-loading', () => { rendererReady = false; endDrag(); clearSpeechSize(); cancelPreviews('桌宠页面已重新加载，请稍后重试'); });
      petWindow.webContents.on('render-process-gone', (_event, details) => { rendererReady = false; endDrag(); clearSpeechSize(); cancelPreviews('桌宠渲染进程已停止'); report(`桌宠渲染进程停止：${details.reason}`); });
      petWindow.on('show', () => send('qqa-pet:visibility', true));
      petWindow.on('hide', () => { endDrag(); clearSpeechSize(); cancelPreviews('桌宠已隐藏，预览已停止'); send('qqa-pet:visibility', false); });
      petWindow.on('move', () => {
        if (applyingBounds || drag || !baseBounds || !windowLayout) return;
        const actual = petWindow.getBounds(), expected = windowLayout.bounds;
        if (actual.x === expected.x && actual.y === expected.y) return;
        baseBounds = { ...baseBounds, x: baseBounds.x + actual.x - expected.x, y: baseBounds.y + actual.y - expected.y };
        windowLayout = { ...windowLayout, bounds: actual };
        layoutSpeech();
        clearTimeout(saveTimer); saveTimer = setTimeout(persistPosition, 500);
      });
      petWindow.on('close', (event) => {
        if (closed) return;
        event.preventDefault();
        void update({ visible: false });
      });
      petWindow.on('closed', () => { if (!closed) host.close(); petWindow = null; rendererReady = false; speechSize = { width: 0, height: 0 }; baseBounds = null; windowLayout = null; });
      handle('qqa-pet:state', () => state || service()?.getState?.() || {});
      handle('qqa-pet:observe', () => service()?.observeNow?.({ manual: true }));
      handle('qqa-pet:speech', (value) => { presentSpeech(value?.text); return { ok: true }; });
      listen('qqa-pet:speech-close', clearSpeechSize);
      listen('qqa-pet:speech-anchor', (value) => {
        if (!value || !['left', 'top', 'width', 'height'].every((key) => Number.isFinite(value[key]) && Math.abs(value[key]) <= 32768) || value.width < 0 || value.height < 0) return;
        speechAnchor = { left: value.left, top: value.top, width: value.width, height: value.height };
        layoutSpeech();
      });
      handleSpeech('qqa-pet-speech:ready', () => {
        speechReady = true;
        return { text: speechText, revision: speechRevision, speechLimit: publicLayout().speechLimit };
      });
      handleSpeech('qqa-pet-speech:measure', (value) => {
        if (!value || !Number.isFinite(value.width) || !Number.isFinite(value.height) || value.width < 0 || value.height < 0 || value.width > 32768 || value.height > 32768 || ((value.width === 0) !== (value.height === 0))) throw new Error('桌宠气泡尺寸无效');
        if (value.revision !== speechRevision || !speechText) return null;
        if (!value.width) { clearSpeechSize(); return null; }
        speechSize = { width: Math.ceil(value.width), height: Math.ceil(value.height) };
        return layoutSpeech();
      });
      handleSpeech('qqa-pet-speech:present', (revision) => {
        if (revision !== speechRevision || !speechText || !speechLayout || !speechReady || !alive() || !petWindow.isVisible() || state?.enabled === false || settings().visible === false) return false;
        speechWindow.showInactive();
        return true;
      });
      handle('qqa-pet:preview', (value) => {
        if (!value || typeof value.modelId !== 'string' || !/^pet-[a-f0-9-]{36}$/.test(value.modelId)) throw new Error('角色预览标识无效');
        if (typeof value.dataUrl !== 'string' || !value.dataUrl.startsWith('data:image/png;base64,') || value.dataUrl.length > Math.ceil(512 * 1024 / 3) * 4 + 22) throw new Error('角色预览必须是512KB以内的PNG图片');
        return service()?.cacheModelPreview?.(value.modelId, value.dataUrl) || { ok: false, skipped: true };
      });
      listen('qqa-pet:ready', () => {
        rendererReady = true;
        applyState();
        applyWindowGeometry(true);
        for (const command of pendingCommands.splice(0)) send('qqa-pet:command', command);
      });
      listen('qqa-pet:open-console', openConsole);
      listen('qqa-pet:menu', contextMenu);
      listen('qqa-pet:drag-start', beginDrag);
      listen('qqa-pet:drag-tick', tickDrag);
      listen('qqa-pet:drag-end', endDrag);
      listen('qqa-pet:interact', () => { if (Date.now() - (host.lastInteraction || 0) >= 500) { host.lastInteraction = Date.now(); service()?.recordInteraction?.('click'); } });
      // 单击：今日用量卡片（数据由主进程现算，渲染进程拿不到任何密钥/文件能力）
      handle('qqa-pet:usage-today', () => presentUsage());
      listen('qqa-pet:usage-close', () => hideUsageWindow());
      handleUsage('qqa-pet-usage:ready', () => { usageReady = true; return { data: usageData, revision: usageRevision }; });
      listenUsage('qqa-pet-usage:close', () => hideUsageWindow());
      // 双击：开发工单对话框
      listen('qqa-pet:dev-open', () => { openDevChat(); });
      handleDev('qqa-dev:snapshot', (selected) => devApi?.()?.snapshot?.(String(selected || '').slice(0, 120)) || { ok: false, available: false, error: '开发工单不可用' });
      handleDev('qqa-dev:detail', (value) => {
        const id = String(value?.id || '').slice(0, 120);
        if (!id) throw new Error('会话标识无效');
        const from = Number(value?.from);
        return devApi?.()?.detail?.(id, Number.isFinite(from) && from > 0 ? from : 0) || { ok: false, error: '开发工单不可用' };
      });
      handleDev('qqa-dev:send', (value) => {
        const id = String(value?.id || '').slice(0, 120);
        const text = String(value?.text || '').slice(0, 8000);
        if (!id || !text.trim()) throw new Error('会话或消息为空');
        return devApi?.()?.send?.(id, text) || { ok: false, error: '开发工单不可用' };
      });
      handleDev('qqa-dev:new', (text) => devApi?.()?.newSession?.(String(text || '').slice(0, 8000)) || { ok: false, error: '开发工单不可用' });
      handleDev('qqa-dev:close-session', (id) => devApi?.()?.closeSession?.(String(id || '').slice(0, 120)) || { ok: false, error: '开发工单不可用' });
      listenDev('qqa-dev:ready', () => { devReady = true; });
      listenDev('qqa-dev:hide', () => { if (devAlive()) devWindow.hide(); });
      listen('qqa-pet:model-loaded', (value) => {
        if (!value || !value.id) return;
        const svc = service();
        // ⚠️ 2026-10-24：这里原来只拿本模块的 `state` 缓存比对，缓存是 null 或旧值时
        //    上报会被**静默丢掉** —— 表现就是"桌面上已经有角色，控制台一直显示正在加载"，
        //    而且失败路径同样被吞，连 modelError 都没有。现在以服务端实时状态为准，
        //    并且不一致时写日志，别再让它无声消失。
        const activeId = svc?.getState?.()?.activeModel?.id || state?.activeModel?.id || '';
        if (!activeId) {
          report(`桌宠上报模型已加载（${value.id}），但主进程拿不到当前角色（service=${Boolean(svc)}）`);
          return;
        }
        if (value.id !== activeId) {
          report(`桌宠上报的模型（${value.id}）与当前角色（${activeId}）不一致，已忽略`);
          return;
        }
        svc?.onModelLoaded?.({ id: value.id, error: String(value.error || '').slice(0, 700) });
      });
      listen('qqa-pet:error', (value) => report(String(value).slice(0, 700)));
      listen('qqa-pet:command-result', (value) => {
        if (!value || typeof value.requestId !== 'string') return;
        const pending = previews.get(value.requestId);
        if (!pending) return;
        previews.delete(value.requestId);
        clearTimeout(pending.timer);
        if (pending.modelId !== state?.activeModel?.id) { pending.resolve({ ok: false, error: '角色已切换，请重新选择动作' }); return; }
        pending.resolve(value.ok === true ? { ok: true } : { ok: false, error: String(value.error || '动作未开始，请检查模型与动作文件').slice(0, 500) });
      });
      listen('qqa-pet:activity', (value) => {
        if (!value || value.modelId !== state?.activeModel?.id) return;
        service()?.onAnimationState?.(value);
      });
      cursorTimer = setInterval(() => {
        if (!alive() || !petWindow.isVisible() || settings().gazeTracking === false) return;
        const position = screen.getCursorScreenPoint();
        const bounds = petWindow.getBounds();
        send('qqa-pet:cursor', { x: position.x - bounds.x, y: position.y - bounds.y });
      }, 50);
      screen.on('display-removed', displaysChanged);
      screen.on('display-metrics-changed', displaysChanged);
      reconcileService();
      // Plugin hot reload is independent of whether its management page is open.
      serviceTimer = setInterval(reconcileService, 1000);
      serviceTimer.unref?.();
      state = service()?.getState?.() || state || { enabled: false, settings: {} };
      speechWindow = new BrowserWindow({
        width: 160, height: 64, parent: petWindow, transparent: true, backgroundColor: '#00000000', frame: false,
        show: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
        skipTaskbar: true, hasShadow: false, title: 'QQ Agent 桌宠回复', alwaysOnTop: true,
        webPreferences: { preload: path.join(directory, 'pet-speech-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, session: petSession, backgroundThrottling: false },
      });
      speechWindow.setContentProtection(true);
      speechWindow.setMenuBarVisibility(false);
      speechWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      speechWindow.webContents.on('will-navigate', (event, url) => { if (url !== `${origin}/desktop-pet/speech.html`) event.preventDefault(); });
      speechWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
      speechWindow.webContents.on('did-start-loading', () => { speechReady = false; if (speechAlive()) speechWindow.hide(); });
      speechWindow.webContents.on('render-process-gone', (_event, details) => { speechReady = false; clearSpeechSize(); report(`桌宠气泡渲染进程停止：${details.reason}`); });
      speechWindow.webContents.on('preload-error', (_event, _preloadPath, error) => report(`桌宠气泡 preload 加载失败：${error?.message || error}`));
      speechWindow.on('close', (event) => { if (!closed) { event.preventDefault(); clearSpeechSize(); } });
      speechWindow.on('closed', () => { speechWindow = null; speechReady = false; });
      applyState();
      await Promise.all([petWindow.loadURL(`${origin}/desktop-pet/pet.html`), speechWindow.loadURL(`${origin}/desktop-pet/speech.html`)]);
      return host;
    },
    sync(nextState) {
      if (nextState?.enabled === false) cancelPreviews('桌宠插件已停用');
      if (state?.activeModel?.id !== nextState?.activeModel?.id) cancelPreviews('角色已切换，请重新选择动作');
      state = nextState;
      applyState();
    },
    previewCommand(value = {}) {
      if (!['motion', 'expression', 'reset-expression'].includes(value.type)) return Promise.resolve({ ok: false, error: '预览类型无效' });
      if (!alive() || !rendererReady || !state?.runtime?.modelLoaded) return Promise.resolve({ ok: false, error: '角色尚未加载完成，请稍后重试' });
      if (!petWindow.isVisible()) return Promise.resolve({ ok: false, error: '桌宠当前已隐藏，请先显示桌宠再预览' });
      if (previews.size >= 8) return Promise.resolve({ ok: false, error: '正在加载其他动作，请稍后重试' });
      const requestId = `pet-${Date.now().toString(36)}-${++previewSerial}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => { previews.delete(requestId); resolve({ ok: false, error: '动作加载超过15秒，请检查模型资源或重试' }); }, 15000);
        timer.unref?.();
        previews.set(requestId, { resolve, timer, modelId: state.activeModel?.id });
        send('qqa-pet:command', { type: value.type, id: String(value.id || '').slice(0, 220), requestId });
      });
    },
    async capturePetPreview() {
      if (!alive() || !rendererReady || !petWindow.isVisible()) throw new Error('请先显示桌宠再取得桌宠快照');
      let frame = await petWindow.webContents.capturePage();
      if (frame.isEmpty()) throw new Error('桌宠画面尚未绘制');
      const size = frame.getSize();
      if (size.width > 720 || size.height > 960) frame = frame.resize({ height: Math.round(size.height * Math.min(720 / size.width, 960 / size.height)) });
      return { ok: true, dataUrl: frame.toDataURL() };
    },
    command(value = {}) {
      if (!['motion', 'expression', 'speech', 'status'].includes(value.type)) return false;
      const command = { type: value.type, id: String(value.id || '').slice(0, 220), text: String(value.text || '').slice(0, 1500), state: String(value.state || '').slice(0, 40) };
      if (rendererReady) send('qqa-pet:command', command);
      else { pendingCommands.push(command); if (pendingCommands.length > 8) pendingCommands.shift(); }
      return true;
    },
    async pickModel() {
      const owner = getMainWindow?.();
      const options = { title: '选择 Live2D 模型入口（.model3.json）', properties: ['openFile'], filters: [{ name: 'Live2D 模型入口', extensions: ['json'] }] };
      const result = owner && !owner.isDestroyed() ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) return null;
      const filename = path.resolve(result.filePaths[0]);
      if (!filename.toLowerCase().endsWith('.model3.json')) throw new Error('请选择完整模型文件夹中的 .model3.json 文件');
      return filename;
    },
    async captureScreen({ displayId = '', signal } = {}) {
      if (signal?.aborted) throw new Error('屏幕观察已取消');
      if (captureInProgress) throw new Error('已有屏幕截图进行中');
      captureInProgress = true;
      try {
        let display;
        if (displayId) display = screen.getAllDisplays().find((d) => String(d.id) === String(displayId));
        if (displayId && !display) throw new Error('所选屏幕已断开，请重新选择屏幕');
        display ||= alive() ? screen.getDisplayMatching(baseBounds || petWindow.getBounds()) : screen.getPrimaryDisplay();
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 }, fetchWindowIcons: false });
        if (signal?.aborted) throw new Error('屏幕观察已取消');
        const source = sources.find((item) => String(item.display_id) === String(display.id)) || (sources.length === 1 ? sources[0] : null);
        if (!source || source.thumbnail.isEmpty()) throw new Error('无法读取所选屏幕，请检查系统屏幕录制权限');
        const image = source.thumbnail;
        const bitmap = image.resize({ width: 16, height: 9, quality: 'good' }).toBitmap({ scaleFactor: 1 });
        const fingerprint = [];
        for (let i = 0; i + 3 < bitmap.length; i += 4) fingerprint.push(Math.round(bitmap[i] * 0.114 + bitmap[i + 1] * 0.587 + bitmap[i + 2] * 0.299));
        return { dataUrl: `data:image/jpeg;base64,${image.toJPEG(70).toString('base64')}`, fingerprint, idleSeconds: powerMonitor.getSystemIdleTime() };
      } finally { captureInProgress = false; }
    },
    getDisplays() { return screen.getAllDisplays().map((d) => ({ id: String(d.id), name: d.label || `屏幕 ${d.id}`, width: d.size.width, height: d.size.height, primary: d.id === screen.getPrimaryDisplay().id })); },
    getIdleSeconds() { return powerMonitor.getSystemIdleTime(); },
    close() {
      if (closed) return;
      closed = true;
      cancelPreviews('桌宠窗口已关闭');
      const previousService = boundService;
      if (previousService) previousService.bindHost?.(null);
      endDrag();
      speechSize = { width: 0, height: 0 };
      clearInterval(cursorTimer);
      clearInterval(serviceTimer);
      clearTimeout(saveTimer);
      cursorTimer = null;
      serviceTimer = null;
      boundService = null;
      saveTimer = null;
      for (const [channel, listener] of ipcListeners.splice(0)) ipcMain.removeListener(channel, listener);
      for (const channel of ipcHandlers.splice(0)) ipcMain.removeHandler(channel);
      screen.removeListener('display-removed', displaysChanged);
      screen.removeListener('display-metrics-changed', displaysChanged);
      if (petSession) petSession.webRequest.onBeforeSendHeaders(null);
      clearUsageTimers();
      if (devAlive()) devWindow.destroy();
      devWindow = null;
      devReady = false;
      if (usageAlive()) usageWindow.destroy();
      usageWindow = null;
      usageReady = false;
      usageData = null;
      if (speechAlive()) speechWindow.destroy();
      speechWindow = null;
      speechReady = false;
      if (alive()) petWindow.destroy();
      petWindow = null;
      rendererReady = false;
      pendingCommands.length = 0;
    },
    shutdown() { host.close(); },
  };
  return host;
}
