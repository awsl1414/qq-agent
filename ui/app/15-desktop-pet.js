// 桌宠管理页（经典脚本）。只消费脱敏状态；截图、API 凭据与模型请求留在后端。
'use strict';

let dpData = null;
let dpTimer = null;
let dpLoadSeq = 0;
let dpLoading = false;
let dpBusy = false;
let dpObservePending = false;
let dpLibraryKey = '';
let dpPreviewController = null;
const dpPreviewCache = new Map();
const dpDirtySections = new Set();
const dpQ = (s) => document.querySelector(s);
const dpQa = (s, root = document) => [...root.querySelectorAll(s)];
const dpEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dpNum = (n) => Number.isFinite(Number(n)) ? Number(n) : 0;
const dpCount = (n) => dpNum(n).toLocaleString('zh-CN');
const dpPct = (a, b) => b > 0 ? Math.min(100, Math.max(0, 100 * dpNum(a) / b)) : 0;
const dpSceneName = (s) => ({ work: '工作', entertainment: '娱乐', other: '日常', rest: '休息' }[s] || '日常');
const dpMotionName = (motion) => String(motion?.name || motion?.id || '').replace(/（基础曲线）/g, '');

function dpDuration(seconds) {
  const n = Math.max(0, Math.floor(dpNum(seconds)));
  if (n >= 3600) return `${Math.floor(n / 3600)} 小时 ${Math.floor(n % 3600 / 60)} 分`;
  return n >= 60 ? `${Math.floor(n / 60)} 分` : `${n} 秒`;
}

function dpTime(value) {
  if (!value) return '刚刚';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

async function dpRequest(path, body) {
  const result = await api(`/api/desktop-pet/${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  if (result?.ok === false && !result.skipped && !result.cancelled && !result.canceled) throw new Error(result.error || result.reason || '操作未完成');
  return result;
}

function dpHint(text, error = false) {
  const target = dpQ('#dp-hint');
  if (!target) return;
  target.textContent = text || '';
  target.classList.toggle('err', error);
}

function initDesktopPetPage() {
  const root = dpQ('#desktop-pet-page');
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = 'true';
  /* 整页重设计：外壳走全站设计语言（.snowluma-page-card / .sl-* / .btn / .field），
     与「连接」「自检」页同宽同款。所有 ID 与 data-dp-* 钩子原样保留，JS 逻辑不动。
     旧版这里是一套 dp-card/dp-btn 私有组件，引用的令牌已在扁平化时改名，
     var() 取不到值，边框/圆角/配色整页失效（IACVT），详见 desktop-pet-panel.css 顶部注释。 */
  root.innerHTML = `<div class="dp-wrap snowluma-page-card">
    <div class="sl-head">
      <div class="sl-head-main">
        <h2>桌面伙伴</h2>
        <div class="sl-head-sub">你的角色住进桌面，和你一起看见日常。</div>
      </div>
      <div class="dp-head-tools">
        <button class="btn btn-small" id="dp-toggle-visible" data-dp-action="toggle-visible" disabled>显示桌宠</button>
        <button class="btn btn-small" data-dp-action="refresh" title="重新读取一次桌面伙伴状态">刷新状态</button>
        <button class="btn btn-small btn-ghost" data-dp-action="plugins">插件管理</button>
      </div>
    </div>

    <div class="dp-status" id="dp-status" aria-live="polite">
      <span class="dp-seg"><span class="dot dot-wait"></span><span class="dp-seg-k">插件</span><span class="dp-seg-v">读取中</span></span><span class="dp-seg"><span class="dot dot-wait"></span><span class="dp-seg-k">桌面窗口</span><span class="dp-seg-v">读取中</span></span><span class="dp-seg dp-seg-grow"><span class="dot dot-wait"></span><span class="dp-seg-k">当前角色</span><span class="dp-seg-v">读取中</span></span><span class="dp-seg"><span class="dot dot-wait"></span><span class="dp-seg-k">桌宠</span><span class="dp-seg-v">读取中</span></span>
    </div>

    <div id="dp-hint" class="dp-alert" role="status" aria-live="polite"></div>

    <nav class="dp-nav" aria-label="桌宠设置区域">
      <button type="button" data-dp-scroll="dp-character">角色与显示</button><button type="button" data-dp-scroll="dp-motion">动作控制台</button><button type="button" data-dp-scroll="dp-companion">屏幕陪伴</button><button type="button" data-dp-scroll="dp-life">生活与成就</button>
    </nav>

    <section class="dp-card sl-section" id="dp-character" data-dp-section="display">
      <div class="sl-section-title">角色与显示<span class="sl-section-sub">外观来自 Live2D 文件，AI 能力沿用 QQ Agent 的模型配置</span></div>
      <div class="sl-panel">
        <div class="sl-panel-head">
          <span class="sl-panel-title">角色库</span>
          <span class="dp-count-badge" id="dp-model-count">0 个</span>
          <span class="sl-panel-tools">
            <button class="btn btn-small" data-dp-action="reset-position">找回桌宠位置</button>
            <button class="btn btn-small btn-primary" data-dp-action="import">导入角色模型</button>
          </span>
        </div>
        <div class="dp-panel-body">
          <div id="dp-model-library" class="dp-model-library" aria-label="已有 Live2D 角色"></div>
          <div id="dp-model-note" class="dp-inline-note"></div>
        </div>
      </div>
      <div class="sl-panel">
        <div class="sl-panel-head">
          <span class="sl-panel-title">桌面显示</span>
          <span class="sl-panel-tools">
            <button class="btn btn-small" data-dp-action="preview-speech" id="dp-preview-speech">预览文字气泡</button>
            <button class="btn btn-small btn-primary" data-dp-action="save" data-dp-save="display">保存显示设置</button>
          </span>
        </div>
        <div class="dp-panel-body">
          <div class="dp-field-grid">
            <label class="dp-field dp-range-field"><span>角色大小 <output id="dp-scale-output"></output></span><input id="dp-scale" type="range" min="0.5" max="3" step="0.05" data-dp-field="scale" aria-label="角色大小"></label>
            <label class="dp-field dp-range-field"><span>窗口不透明度 <output id="dp-opacity-output"></output></span><input id="dp-opacity" type="range" min="0.2" max="1" step="0.05" data-dp-field="opacity" aria-label="窗口不透明度"></label>
          </div>
          <div class="dp-checks">
            <label class="dp-check"><input id="dp-visible" type="checkbox" class="sw" data-dp-field="visible">显示桌宠</label>
            <label class="dp-check"><input id="dp-top" type="checkbox" class="sw" data-dp-field="alwaysOnTop">保持置顶</label>
            <label class="dp-check"><input id="dp-through" type="checkbox" class="sw" data-dp-field="mouseThrough">鼠标穿透</label>
            <label class="dp-check"><input id="dp-gaze" type="checkbox" class="sw" data-dp-field="gazeTracking">视线跟随鼠标</label>
            <label class="dp-check"><input id="dp-lock" type="checkbox" class="sw" data-dp-field="positionLocked">锁定位置</label>
          </div>
          <p class="hint">按住角色即可拖动，位置自动保存。鼠标穿透后仍可在本页关闭穿透、隐藏桌宠。高 DPI 和多屏位置由桌面窗口处理。</p>
        </div>
      </div>
    </section>

    <section class="dp-card sl-section" id="dp-motion" data-dp-section="motion">
      <div class="sl-section-title">动作控制台<span class="sl-section-sub">预览当前角色真实支持的动作，并安排触发时机</span></div>
      <div class="sl-panel">
        <div class="sl-panel-head">
          <span class="sl-panel-title">自主行为</span>
          <span class="sl-panel-meta" id="dp-motion-count">等待角色</span>
        </div>
        <div class="dp-panel-body">
          <div class="dp-checks">
            <label class="dp-check"><input id="dp-random-motion" type="checkbox" class="sw" data-dp-field="randomEnabled">自主随机动作</label>
            <label class="dp-check"><input id="dp-random-expression" type="checkbox" class="sw" data-dp-field="expressionEnabled">自主切换表情</label>
            <label class="dp-check"><input id="dp-auto-posture" type="checkbox" class="sw" data-dp-field="postureEnabled">自然坐下 / 站起</label>
          </div>
          <p class="hint">坐姿会避开不适合坐着播放的动作；每 60–120 秒决定坐站，约 70% 站立、30% 坐下。没有坐姿资源的角色会保持站姿。</p>
          <div id="dp-animation-status" class="dp-inline-note" aria-live="polite"></div>
          <div class="dp-field-grid">
            <div class="field"><label for="dp-idle-interval">随机动作间隔上限（秒）</label><input id="dp-idle-interval" type="number" min="5" max="600" step="1" data-dp-field="idleIntervalSeconds"></div>
            <div class="field"><label for="dp-click-cooldown">点击动作冷却（秒）</label><input id="dp-click-cooldown" type="number" min="0.2" max="60" step="0.1" data-dp-field="clickCooldownSeconds"></div>
          </div>
        </div>
      </div>
      <div class="sl-panel">
        <div class="sl-panel-head">
          <span class="sl-panel-title">状态与动作的对应关系</span>
          <span class="sl-panel-meta">权重越大越容易被选中</span>
        </div>
        <div class="dp-panel-body">
          <div class="dp-field-grid three" id="dp-bindings"></div>
          <p class="hint">随机间隔在 5 秒到上限之间变化，默认 5–20 秒。待机绑定只影响进入待机时的动作，后续仍从随机池选择；连续随机会避免重复。</p>
        </div>
      </div>
      <div class="sl-panel">
        <div class="sl-panel-head">
          <span class="sl-panel-title">动作与表情</span>
          <span class="sl-panel-tools">
            <button class="btn btn-small btn-primary" data-dp-action="save" data-dp-save="motion">保存动作设置</button>
          </span>
        </div>
        <div class="dp-panel-body">
          <div id="dp-motions"></div>
          <h4 class="dp-sub-title">表情列表</h4>
          <div id="dp-expressions"></div>
        </div>
      </div>
    </section>

    <section class="dp-card sl-section" id="dp-companion" data-dp-section="companion">
      <div class="sl-section-title">屏幕陪伴<span class="sl-section-sub">看懂当前画面，再按照角色人设简短接话</span></div>
      <div class="sl-panel">
        <div class="sl-panel-head">
          <span class="sl-panel-title">观察设置</span>
          <span class="dp-count-badge" id="dp-observe-status">未开启自动观察</span>
          <span class="sl-panel-tools">
            <button class="btn btn-small" data-dp-action="save" data-dp-save="companion">保存陪伴设置</button>
            <button class="btn btn-small" data-dp-action="cancel-observe" id="dp-cancel-observe" hidden>取消本次观察</button>
            <button class="btn btn-small btn-primary" data-dp-action="observe" id="dp-observe">看看屏幕</button>
          </span>
        </div>
        <div class="dp-panel-body">
          <div class="dp-field-grid">
            <div class="field"><label for="dp-provider">已有 API 配置</label><select id="dp-provider" data-dp-field="providerId"></select></div>
            <div class="field"><label for="dp-ai-model">AI 模型</label><select id="dp-ai-model" data-dp-field="model"></select></div>
          </div>
          <div id="dp-vision-note" class="dp-inline-note"></div>
          <div class="dp-field-grid three">
            <div class="field"><label for="dp-observe-interval">自动观察间隔（秒）</label><input id="dp-observe-interval" type="number" min="10" max="3600" step="1" data-dp-field="intervalSeconds"></div>
            <div class="field"><label for="dp-hour-limit">自动每小时请求上限</label><input id="dp-hour-limit" type="number" min="1" max="500" step="1" data-dp-field="maxPerHour"></div>
            <div class="field"><label for="dp-day-limit">自动每日请求上限</label><input id="dp-day-limit" type="number" min="1" max="5000" step="1" data-dp-field="maxPerDay"></div>
          </div>
          <div class="dp-field-grid">
            <div class="field"><label for="dp-display">观察显示器</label><select id="dp-display" data-dp-field="displayId"><option value="">桌宠所在屏幕</option></select></div>
            <div class="field"><label for="dp-idle-pause">无操作后暂停（秒）</label><input id="dp-idle-pause" type="number" min="60" max="3600" step="1" data-dp-field="idlePauseSeconds"></div>
          </div>
          <label class="dp-field"><span>桌宠补充人设（可选）</span><textarea id="dp-persona" maxlength="4000" data-dp-field="persona" placeholder="例如：像朋友一样简短陪伴，偶尔俏皮吐槽。留空沿用当前角色人设。"></textarea></label>
          <div class="dp-checks"><label class="dp-check"><input id="dp-auto" type="checkbox" class="sw" data-dp-field="enabled">开启自动屏幕陪伴</label></div>
          <p class="hint">开启后按间隔检查画面，有明显变化才请求模型。截图会发送至你选择的 API 服务，仅用于本次理解；桌面观察不会发送到 QQ 群。切换设置后请先保存，再开始观察。</p>
          <p class="hint">上述次数上限仅适用于自动观察。手动“看看屏幕”不受这些次数上限限制，也不占用自动观察额度；同一时间只运行一次观察，避免重复请求。手动和自动观察都仍按所选 API 服务的规则计费。</p>
          <div id="dp-runtime-note" class="dp-alert" aria-live="polite"></div>
        </div>
      </div>
      <div class="sl-panel">
        <div class="sl-panel-head"><span class="sl-panel-title">最近动态</span></div>
        <div class="dp-panel-body">
          <h4 class="dp-sub-title">最近一句</h4>
          <div class="dp-reply" id="dp-last-reply">还没有屏幕回复，点击“看看屏幕”开始一次观察。</div>
          <div class="dp-stats" id="dp-usage" style="grid-template-columns:repeat(auto-fit,minmax(145px,1fr))"></div>
          <details class="dp-details"><summary>最近观察记录</summary><div class="dp-history" id="dp-history"></div></details>
        </div>
      </div>
    </section>

    <section class="dp-card sl-section" id="dp-life">
      <div class="sl-section-title">生活与成就<span class="sl-section-sub">陪伴慢慢积累，日常也有值得记住的小事</span></div>
      <div class="sl-panel">
        <div class="sl-panel-head"><span class="sl-panel-title">陪伴统计</span></div>
        <div class="dp-panel-body">
          <div class="dp-stats" id="dp-life-stats"></div>
          <div class="dp-inline-note" id="dp-time-slots"></div>
          <h4 class="dp-sub-title">一起经历的场景</h4>
          <div class="dp-scene" id="dp-scenes"></div>
          <p class="hint">场景比例来自观察画面的分类次数，用于陪伴词条，不代表精确的工作或娱乐时长。</p>
        </div>
      </div>
      <div class="sl-panel">
        <div class="sl-panel-head"><span class="sl-panel-title">成就进度</span></div>
        <div class="dp-panel-body"><div class="dp-achievements" id="dp-achievements"></div></div>
      </div>
    </section>

    <div class="dp-savebar" id="dp-savebar" hidden><span>有未保存的设置</span><div class="dp-savebar-tools"><button class="btn btn-small" data-dp-action="discard">撤销改动</button><button class="btn btn-small btn-primary" data-dp-action="save" data-dp-save="all">保存全部设置</button></div></div>
  </div>`;
  root.addEventListener('input', dpInputChanged);
  root.addEventListener('change', dpInputChanged);
  root.addEventListener('click', dpClick);
  root.addEventListener('error', (event) => {
    const image = event.target;
    if (image?.matches?.('[data-dp-preview]')) dpHidePreview(image);
  }, true);
  dpStartSpy();
  dpSetActiveNav('dp-character');
}

/* 页内导航高亮：哪一区滚进视口上方就点亮哪一项。
   用 IntersectionObserver 而不是 scroll 事件：轮询每 4 秒拉一次状态、
   用户也可能一边滚动一边编辑表单，监听器只切 class，不碰任何数据。 */
let dpSpy = null;
function dpNavButtons() { return dpQa('.dp-nav [data-dp-scroll]'); }
function dpSetActiveNav(id) {
  for (const button of dpNavButtons()) button.classList.toggle('is-active', button.dataset.dpScroll === id);
}
function dpStartSpy() {
  dpStopSpy();
  const root = dpQ('#desktop-pet-page');
  const links = dpNavButtons();
  if (!root || !links.length || typeof IntersectionObserver !== 'function') return;
  const seen = new Map();
  dpSpy = new IntersectionObserver((entries) => {
    for (const entry of entries) seen.set(entry.target.id, entry);
    let best = null;
    for (const entry of seen.values()) {
      if (!entry.isIntersecting) continue;
      if (!best || entry.boundingClientRect.top < best.boundingClientRect.top) best = entry;
    }
    if (best) dpSetActiveNav(best.target.id);
  }, { root, rootMargin: '-64px 0px -60% 0px', threshold: 0 });
  for (const button of links) {
    const section = dpQ(`#${button.dataset.dpScroll}`);
    if (section) dpSpy.observe(section);
  }
}
function dpStopSpy() {
  if (dpSpy) { dpSpy.disconnect(); dpSpy = null; }
}

function dpInputChanged(event) {
  const target = event.target;
  if (target.id === 'dp-provider') dpFillAiModelOptions(target.value, '');
  const section = target.closest('[data-dp-section]')?.dataset.dpSection;
  if (section) dpDirtySections.add(section);
  dpUpdateOutputs();
  dpUpdateDirty();
  if (target.id === 'dp-provider' || target.id === 'dp-ai-model') dpUpdateVisionNote();
}

function dpUpdateOutputs() {
  if (dpQ('#dp-scale-output')) dpQ('#dp-scale-output').textContent = `${Math.round(dpNum(dpQ('#dp-scale').value) * 100)}%`;
  if (dpQ('#dp-opacity-output')) dpQ('#dp-opacity-output').textContent = `${Math.round(dpNum(dpQ('#dp-opacity').value) * 100)}%`;
  for (const id of ['dp-scale', 'dp-opacity']) {
    const input = dpQ(`#${id}`);
    if (input?.style) input.style.setProperty('--dp-range-fill', `${dpPct(dpNum(input.value) - dpNum(input.min), dpNum(input.max) - dpNum(input.min))}%`);
  }
}

function dpUpdateDirty() {
  const bar = dpQ('#dp-savebar');
  if (bar) bar.hidden = dpDirtySections.size === 0;
  const observe = dpQ('#dp-observe');
  if (observe) {
    const item = dpSelectedAi();
    observe.disabled = dpBusy || dpObservePending || !!dpData?.runtime?.observing || dpDirtySections.has('companion') || !item || item.vision === 'no' || item.configured === false || !dpData?.runtime?.hostAvailable || dpData?.runtime?.active === false;
    observe.title = dpDirtySections.has('companion') ? '请先保存陪伴设置' : '';
  }
}

function dpFillOptions(target, items, selected, fallback) {
  if (!target) return;
  target.innerHTML = (fallback ? `<option value="">${dpEsc(fallback)}</option>` : '') + items.map((item) => `<option value="${dpEsc(item.value)}"${String(item.value) === String(selected ?? '') ? ' selected' : ''}${item.disabled ? ' disabled' : ''}>${dpEsc(item.label)}</option>`).join('');
  if (selected != null) target.value = String(selected);
}

function dpFillAiModelOptions(providerId, selectedModel) {
  const items = (dpData?.aiModels || []).filter((m) => String(m.providerId) === String(providerId));
  dpFillOptions(dpQ('#dp-ai-model'), items.map((m) => ({ value: m.model, label: `${m.name || m.model} · ${m.vision === 'yes' ? '支持看图' : m.vision === 'no' ? '不支持看图' : '看图能力待确认'}`, disabled: m.configured === false || m.vision === 'no' })), selectedModel, '请选择已有视觉模型');
}

function dpSelectedAi() {
  return (dpData?.aiModels || []).find((m) => String(m.providerId) === String(dpQ('#dp-provider')?.value) && String(m.model) === String(dpQ('#dp-ai-model')?.value));
}

function dpUpdateVisionNote() {
  const item = dpSelectedAi();
  const target = dpQ('#dp-vision-note');
  if (!target) return;
  target.classList.toggle('warn', !item || item.vision !== 'yes');
  target.textContent = !dpData?.aiModels?.length ? '还没有可用的 API 模型，请先到 QQ Agent「设置」页配置。这里直接复用已有配置，无需填写 API Key。' : !item ? '请从已有 API 配置中选择支持图片输入的模型；不支持看图的模型无法用于屏幕陪伴。' : item.vision === 'yes' ? '此模型已标记支持图片输入。调用沿用现有 API 配置，费用按该服务的计费规则产生。' : item.vision === 'no' ? '此模型不支持看图，请选择视觉模型。' : '模型目录尚未确认看图能力。可手动观察验证；若服务不支持图片，错误会直接显示在这里。';
}

function dpFillForms(sections = ['display', 'motion', 'companion']) {
  const settings = dpData?.settings || {};
  const active = dpData?.activeModel;
  if (sections.includes('display')) {
    for (const [id, value] of Object.entries({ 'dp-scale': settings.scale ?? 1, 'dp-opacity': settings.opacity ?? 1 })) dpQ(`#${id}`).value = value;
    for (const [id, value] of Object.entries({ 'dp-visible': settings.visible, 'dp-top': settings.alwaysOnTop, 'dp-through': settings.mouseThrough, 'dp-gaze': settings.gazeTracking, 'dp-lock': settings.positionLocked })) dpQ(`#${id}`).checked = !!value;
  }
  if (sections.includes('motion')) {
    const motion = settings.motion || {};
    const motions = active?.motions || [];
    dpQ('#dp-idle-interval').value = motion.idleIntervalSeconds ?? 20;
    dpQ('#dp-click-cooldown').value = motion.clickCooldownSeconds ?? 1.5;
    dpQ('#dp-random-motion').checked = motion.randomEnabled !== false;
    dpQ('#dp-random-expression').checked = motion.expressionEnabled !== false;
    dpQ('#dp-auto-posture').checked = motion.postureEnabled !== false;
    dpQ('#dp-bindings').innerHTML = [['idle', '待机'], ['click', '点击角色'], ['thinking', '思考 / 处理中'], ['reply', '回复完成'], ['error', '出错 / 断线']].map(([key, name]) => `<label class="dp-field"><span>${name}</span><select data-dp-binding="${key}" aria-label="${name}动作"><option value="">自动 / 待机回退</option>${motions.map((m) => `<option value="${dpEsc(m.id)}"${motion.stateMap?.[key] === m.id ? ' selected' : ''}>${dpEsc(dpMotionName(m))}</option>`).join('')}</select></label>`).join('');
    dpQ('#dp-motion-count').textContent = `${motions.length} 个动作 · ${(active?.expressions || []).length} 个表情`;
    dpQ('#dp-motions').innerHTML = motions.length ? `<div class="dp-table-wrap"><table class="dp-table"><thead><tr><th>动作</th><th>允许随机播放</th><th>随机权重</th><th>预览</th></tr></thead><tbody>${motions.map((m) => `<tr><td>${dpEsc(dpMotionName(m))}<div class="dp-muted">${dpEsc(String(m.group || '默认动作组').replace(/（基础曲线）/g, ''))}</div></td><td><input type="checkbox" class="sw" data-dp-motion-enabled="${dpEsc(m.id)}" aria-label="启用 ${dpEsc(dpMotionName(m))}"${!(motion.disabled || []).includes(m.id) ? ' checked' : ''}></td><td><input type="number" min="0" max="100" step="0.1" value="${dpEsc(motion.weights?.[m.id] ?? 1)}" data-dp-motion-weight="${dpEsc(m.id)}" aria-label="${dpEsc(dpMotionName(m))} 随机权重"></td><td><button class="btn btn-small" data-dp-action="preview-motion" data-dp-id="${dpEsc(m.id)}">播放</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="dp-empty">此角色没有提供独立动作文件。仍可使用基础待机、视线追踪和回复气泡。</div>';
    dpQ('#dp-expressions').innerHTML = active?.expressions?.length ? `<div class="dp-chip-row">${active.expressions.map((e) => `<button class="btn btn-small" data-dp-action="preview-expression" data-dp-id="${dpEsc(e.id)}">${dpEsc(e.name || e.id)}</button>`).join('')}<button class="btn btn-small btn-ghost" data-dp-action="reset-expression">恢复默认表情</button></div>` : '<div class="dp-muted">此角色没有单独的表情文件。</div>';
  }
  if (sections.includes('companion')) {
    const cfg = settings.companion || {};
    const providerId = cfg.providerId || dpData.defaultAi?.providerId || '';
    const model = cfg.model || dpData.defaultAi?.model || '';
    const providers = [...new Map((dpData.aiModels || []).map((m) => [m.providerId, { value: m.providerId, label: m.providerName || m.providerId || '当前 API 配置' }])).values()];
    dpFillOptions(dpQ('#dp-provider'), providers, providerId, providers.some((p) => p.value === '') ? '' : '请选择已有配置');
    dpFillAiModelOptions(providerId, model);
    for (const [id, value] of Object.entries({ 'dp-observe-interval': cfg.intervalSeconds ?? 30, 'dp-hour-limit': cfg.maxPerHour ?? 60, 'dp-day-limit': cfg.maxPerDay ?? 200, 'dp-idle-pause': cfg.idlePauseSeconds ?? 180, 'dp-persona': cfg.persona || '' })) dpQ(`#${id}`).value = value;
    dpQ('#dp-auto').checked = !!cfg.enabled;
    const displays = (dpData.displays || dpData.runtime?.displays || []).map((d) => ({ value: String(d.id), label: d.name || d.label || `显示器 ${d.id}` }));
    if (cfg.displayId && !displays.some((d) => d.value === String(cfg.displayId))) displays.push({ value: String(cfg.displayId), label: `显示器 ${cfg.displayId}` });
    dpFillOptions(dpQ('#dp-display'), displays, cfg.displayId || '', '桌宠所在屏幕');
    dpUpdateVisionNote();
  }
  dpUpdateOutputs();
  dpUpdateDirty();
}

function dpStat(label, value) { return `<div class="dp-stat"><span>${dpEsc(label)}</span><strong>${dpEsc(value)}</strong></div>`; }

function dpModelPreviewUrl(model) {
  const expected = `/api/desktop-pet/model/${encodeURIComponent(model.id)}/__qqa_preview.png`;
  const url = String(model.previewUrl || '');
  const version = url.startsWith(`${expected}?v=`) ? url.slice(expected.length + 3) : '';
  return model.previewKind === 'render' && (url === expected || /^\d{1,20}$/.test(version)) ? url : '';
}

function dpHidePreview(image) {
  image.hidden = true;
  image.closest('.dp-model-visual')?.classList.remove('has-preview');
}

// Fetch previews through the same console header as other API calls. Credentials
// never appear in image URLs; object URLs are released when leaving the page.
function dpLoadPreviews() {
  if (state.tab !== 'desktop-pet') return;
  const images = dpQa('[data-dp-preview]');
  if (!images.length) return;
  if (!dpPreviewController || dpPreviewController.signal.aborted) dpPreviewController = new AbortController();
  const controller = dpPreviewController;
  for (const image of images) {
    const url = image.dataset.dpPreview;
    if (!(dpData.models || []).some((model) => dpModelPreviewUrl(model) === url)) continue;
    let record = dpPreviewCache.get(url);
    if (!record) {
      record = { objectUrl: '', promise: null };
      dpPreviewCache.set(url, record);
      record.promise = (async () => {
        // 这里能带请求头（fetch），所以用 x-console-token 而不是 withToken()。
        // 必须是 CONSOLE_AUTH_TOKEN || CONSOLE_MARKER：CONSOLE_MARKER 只是
        // Electron 下由主进程换成真凭据的占位符；浏览器/headless 里没人替换它，
        // 配置了 server.token 时只发 marker 会恒 401（预览图全部消失）。
        const response = await fetch(url, { headers: { 'x-console-token': CONSOLE_AUTH_TOKEN || CONSOLE_MARKER }, signal: controller.signal, credentials: 'same-origin' });
        if (!response.ok || !/^image\/png(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('角色预览暂不可用');
        const blob = await response.blob();
        if (blob.size > 512 * 1024 || controller.signal.aborted) throw new Error('角色预览无效');
        record.objectUrl = URL.createObjectURL(blob);
        return record.objectUrl;
      })().catch(() => {
        if (dpPreviewCache.get(url) === record) dpPreviewCache.delete(url);
        return '';
      });
    }
    void record.promise.then((objectUrl) => {
      if (!image.isConnected || controller !== dpPreviewController || controller.signal.aborted) return;
      if (!objectUrl) { dpHidePreview(image); return; }
      image.src = objectUrl;
      image.hidden = false;
      image.closest('.dp-model-visual')?.classList.add('has-preview');
    });
  }
}

function dpRenderLibrary() {
  const library = dpQ('#dp-model-library');
  if (!library || !dpData) return;
  const models = (dpData.models || []).filter(Boolean);
  const activeId = dpData.activeModel?.id || dpData.settings?.activeModelId;
  const runtime = dpData.runtime || {};
  dpQ('#dp-model-count').textContent = `${models.length} 个`;
  // Keep card DOM and keyboard focus stable during routine status polling.
  const key = JSON.stringify([models.map((m) => [m.id, m.name, m.bytes, m.previewUrl, m.previewKind, m.motions?.length, m.expressions?.length]), activeId, runtime.modelLoaded, !!runtime.modelError, runtime.hostAvailable, runtime.active, dpBusy]);
  if (key === dpLibraryKey) return;
  const focusedModelId = document.activeElement?.closest?.('[data-dp-model-card]')?.dataset.dpModelCard;
  dpLibraryKey = key;
  library.innerHTML = models.length ? models.map((model) => {
    const current = model.id === activeId;
    const loaded = current && runtime.modelLoaded && !runtime.modelError;
    const preview = dpModelPreviewUrl(model);
    const label = current ? loaded ? '正在使用' : runtime.modelError ? '加载未完成' : runtime.hostAvailable ? '正在加载' : '当前选择' : '可切换';
    const bytes = dpNum(model.bytes);
    return `<article class="dp-model-card${current ? ' is-current' : ''}" data-dp-model-card="${dpEsc(model.id)}" tabindex="-1" aria-label="${dpEsc(model.name || model.id)}${current ? '，当前角色' : ''}">
      <div class="dp-model-visual"><span class="dp-model-state${loaded ? ' ok' : ''}">${dpEsc(label)}</span>
        <div class="dp-model-placeholder"><svg viewBox="0 0 80 92" fill="none" aria-hidden="true"><circle cx="40" cy="28" r="16"/><path d="M12 84v-9c0-17 12-28 28-28s28 11 28 28v9"/><path d="M30 27h1m18 0h1M35 35c3 3 7 3 10 0"/></svg><span>暂无角色预览</span><small>${current && !runtime.modelError ? '角色加载后自动生成' : '使用一次后自动生成'}</small></div>
        ${preview ? `<img class="dp-model-image" data-dp-preview="${dpEsc(preview)}" alt="${dpEsc(model.name || model.id)}的角色预览" hidden decoding="async">` : ''}
      </div>
      <div class="dp-model-info"><h5 title="${dpEsc(model.name || model.id)}">${dpEsc(model.name || model.id)}</h5><p>${dpCount(model.motions?.length)} 个动作 <span>·</span> ${dpCount(model.expressions?.length)} 个表情</p><div class="dp-model-footer"><span class="dp-model-meta">Live2D${bytes ? ` · ${(bytes / 1024 / 1024).toFixed(1)} MB` : ''}</span><button type="button" class="btn btn-small${current ? '' : ' btn-primary'}" data-dp-action="select" data-dp-id="${dpEsc(model.id)}" aria-label="${current ? '当前角色：' : '使用角色：'}${dpEsc(model.name || model.id)}"${dpBusy || current || !runtime.hostAvailable || runtime.active === false ? ' disabled' : ''}>${current ? loaded ? '正在使用' : '已选择' : '使用此角色'}</button></div></div>
    </article>`;
  }).join('') + `<button type="button" class="dp-model-add" data-dp-action="import"${dpBusy || !runtime.hostAvailable ? ' disabled' : ''}><span aria-hidden="true">＋</span><strong>添加新角色</strong><small>导入本地 Live2D 模型</small></button>` : '<div class="dp-library-empty"><strong>还没有角色</strong><p>导入完整 Live2D 模型后，就能在这里查看和切换。</p><button type="button" class="btn btn-small btn-primary" data-dp-action="import">导入第一个角色</button></div>';
  dpLoadPreviews();
  if (focusedModelId) dpQa('[data-dp-model-card]', library).find((card) => card.dataset.dpModelCard === focusedModelId)?.focus({ preventScroll: true });
}

function dpRenderDynamic() {
  if (state.tab !== 'desktop-pet' || !dpData || !dpQ('#dp-status')) return;
  const runtime = dpData.runtime || {};
  const settings = dpData.settings || {};
  const active = dpData.activeModel;
  const animation = runtime.animation;
  dpQ('#dp-animation-status').textContent = animation?.modelId === active?.id ? `当前姿态：${animation.posture === 'sit' ? '坐下' : '站立'} · 最近动作：${dpMotionName(active.motions?.find((m) => m.id === animation.motionId)) || active.expressions?.find((e) => e.id === animation.expressionId)?.name || '自然待机'} · 本次自主活动 ${dpCount(animation.automaticCount)} 次${animation.error ? ` · ${animation.error}` : ''}` : '角色加载完成后会自主活动；正在播放的动作和姿态会显示在这里。';
  dpQ('#dp-animation-status').classList.toggle('warn', !!animation?.error);
  const stats = dpData.stats || {};
  const observing = dpObservePending || runtime.observing;
  // 状态条：一行四段（插件 / 桌面窗口 / 当前角色 / 桌宠）。
  // 刻意不用四张卡片：四个几乎等重的绿框会把页面顶部堆成一坨，还抢下面分区面板的层级；
  // 一切正常时它就该安静，只有插件没开 / 窗口没连 / 角色加载失败时才追加一行说明。
  const dpFacts = [
    { k: '插件', v: runtime.active === false ? '未启用' : '已启用', ok: runtime.active !== false },
    { k: '桌面窗口', v: runtime.hostAvailable ? '已连接' : '未连接', ok: !!runtime.hostAvailable },
    { k: '当前角色', v: active?.name || '尚未选择', ok: !!active, grow: true },
    { k: '桌宠', v: settings.visible ? '显示中' : '已隐藏', ok: !!settings.visible },
  ];
  const dpProblems = [];
  if (runtime.active === false) dpProblems.push('桌面伙伴插件未启用 —— 到右上角「插件管理」里启用，再点「刷新状态」。');
  if (!runtime.hostAvailable) dpProblems.push('桌面窗口没连上 —— 需要 QQ Agent 桌面程序；透明桌宠与屏幕观察暂不可用。');
  if (runtime.modelError) dpProblems.push(`角色加载失败：${runtime.modelError}。可重新导入完整角色模型，或换一个角色。`);
  dpQ('#dp-status').innerHTML = dpFacts.map((f) => `<span class="dp-seg${f.ok ? ' is-on' : ''}${f.grow ? ' dp-seg-grow' : ''}"><span class="dot ${f.ok ? 'dot-on' : 'dot-off'}"></span><span class="dp-seg-k">${dpEsc(f.k)}</span><span class="dp-seg-v" title="${dpEsc(f.v)}">${dpEsc(f.v)}</span></span>`).join('')
    + (dpProblems.length ? `<span class="dp-status-note">⚠️ ${dpEsc(dpProblems.join(' '))}</span>` : '');
  dpQ('#dp-model-note').classList.toggle('warn', !active || !!runtime.modelError);
  dpQ('#dp-model-note').textContent = runtime.modelError ? `角色加载失败：${runtime.modelError}。可重新导入完整角色模型，或使用其他角色。` : active ? `当前角色：${active.name || active.id} · ${runtime.modelLoaded ? settings.visible ? '已加载，桌面显示中' : '已加载，桌宠已隐藏' : runtime.hostAvailable ? '等待窗口加载' : '等待桌面窗口连接'}。导入新角色时，选择完整模型文件夹里的 .model3.json 文件。` : '点击“导入角色模型”，选择完整模型文件夹里的 .model3.json 文件；模型、贴图和动作文件需保留原目录结构。';
  dpRenderLibrary();
  dpQ('#dp-toggle-visible').disabled = dpBusy || !runtime.hostAvailable || runtime.active === false;
  dpQ('#dp-toggle-visible').textContent = settings.visible ? '隐藏桌宠' : '显示桌宠';
  dpQ('#dp-preview-speech').disabled = dpBusy || !runtime.hostAvailable || runtime.active === false || !settings.visible;
  dpQ('#dp-preview-speech').title = settings.visible ? '显示一段示例文字，查看气泡效果' : '先显示桌宠，再预览气泡';
  const status = dpQ('#dp-observe-status');
  status.textContent = observing ? '正在观察并生成回复…' : settings.companion?.enabled ? '自动观察已开启' : '自动观察已关闭';
  status.className = `dp-count-badge${observing || settings.companion?.enabled ? ' ok' : ''}`;
  dpQ('#dp-cancel-observe').hidden = !observing;
  let runtimeText = '';
  if (!runtime.hostAvailable) runtimeText = '屏幕观察与透明桌宠需要桌面窗口连接；请使用 QQ Agent 桌面程序。';
  if (runtime.active === false) runtimeText = '桌面伙伴插件当前未启用，可从右上角“插件管理”中启用。';
  if (runtime.pausedReason) runtimeText = String(runtime.pausedReason);
  if (runtime.backoffUntil && new Date(runtime.backoffUntil).getTime() > Date.now()) runtimeText = `请求暂缓至 ${dpTime(runtime.backoffUntil)}，稍后会自动恢复。`;
  if (runtime.lastError) runtimeText = `最近一次错误：${typeof runtime.lastError === 'string' ? runtime.lastError : runtime.lastError.message || JSON.stringify(runtime.lastError)}`;
  dpQ('#dp-runtime-note').textContent = runtimeText;
  dpQ('#dp-runtime-note').classList.toggle('err', !!runtime.lastError);
  const lastReply = typeof runtime.lastReply === 'object' ? runtime.lastReply?.reply || runtime.lastReply?.text : runtime.lastReply;
  dpQ('#dp-last-reply').textContent = lastReply || '还没有屏幕回复，点击“看看屏幕”开始一次观察。';
  const usage = stats.usage || {};
  const cost = typeof usage.cost === 'number' && usage.cost > 0 ? `¥${usage.cost.toFixed(4)}` : usage.calls ? '价格未匹配' : '—';
  const todayAutoCalls = stats.today?.autoCalls ?? stats.today?.calls;
  dpQ('#dp-usage').innerHTML = dpStat('今日自动请求', dpCount(todayAutoCalls)) + dpStat('今日总请求', dpCount(stats.today?.calls)) + dpStat('累计请求', dpCount(usage.calls || stats.observations)) + dpStat('累计 Token', dpCount(usage.totalTokens)) + dpStat('估算费用', cost);
  const history = [...(dpData.history || [])].sort((a, b) => new Date(b.at || b.createdAt || b.timestamp || 0) - new Date(a.at || a.createdAt || a.timestamp || 0)).slice(0, 30);
  dpQ('#dp-history').innerHTML = history.length ? history.map((item) => `<div class="dp-history-item"><div class="dp-history-meta">${dpEsc(dpTime(item.at || item.createdAt || item.timestamp))} · ${dpEsc(dpSceneName(item.scene))} · ${item.source === 'auto' ? '自动观察' : '手动观察'}${item.usage?.totalTokens ? ` · ${dpCount(item.usage.totalTokens)} Token` : ''}</div><p>${dpEsc(item.reply || item.text || item.content || item.error || '')}</p></div>`).join('') : '<div class="dp-empty">还没有观察记录。</div>';
  dpQ('#dp-life-stats').innerHTML = dpStat('陪伴天数', `${dpCount(stats.days)} 天`) + dpStat('有效陪伴', dpDuration(stats.activeSeconds)) + dpStat('点击互动', `${dpCount(stats.interactions)} 次`) + dpStat('屏幕观察', `${dpCount(stats.observations)} 次`);
  const scenes = stats.sceneCounts || {};
  const total = dpNum(scenes.work) + dpNum(scenes.entertainment) + dpNum(scenes.other);
  dpQ('#dp-scenes').innerHTML = [['work', '工作搭子'], ['entertainment', '娱乐搭子'], ['other', '日常陪伴']].map(([key, label]) => `<div class="dp-scene-row"><span>${label}</span><div class="dp-progress"><i style="width:${dpPct(scenes[key], total)}%"></i></div><span class="dp-muted">${Math.round(dpPct(scenes[key], total))}% · ${dpCount(scenes[key])} 次</span></div>`).join('');
  const slots = stats.timeSlots || stats.activePeriods;
  const hours = stats.hourCounts;
  let slotText = '活跃时段会随着有效陪伴逐渐积累。';
  if (slots && typeof slots === 'object') slotText = '活跃时段：' + Object.entries(slots).map(([key, n]) => `${({ morning: '早晨', afternoon: '午后', evening: '傍晚', night: '夜间', daytime: '白天' }[key] || key)} ${dpCount(n)}`).join(' · ');
  else if (Array.isArray(hours) && hours.some((n) => n > 0)) { const top = hours.map((n, h) => ({ n: dpNum(n), h })).sort((a, b) => b.n - a.n).slice(0, 3).filter((x) => x.n > 0); slotText = `常见陪伴时段：${top.map((x) => `${x.h}:00–${x.h + 1}:00`).join('、')}`; }
  dpQ('#dp-time-slots').textContent = slotText;
  dpQ('#dp-achievements').innerHTML = (dpData.achievements || []).length ? dpData.achievements.map((item) => `<article class="dp-achievement${item.unlocked ? ' unlocked' : ''}"><strong>${item.unlocked ? '✓ ' : ''}${dpEsc(item.name)}</strong><p>${dpEsc(item.description)}</p><div class="dp-progress"><i style="width:${item.unlocked ? 100 : dpPct(item.progress, item.target)}%"></i></div><span class="dp-muted">${item.unlocked ? `已解锁${item.unlockedAt ? ` · ${dpTime(item.unlockedAt)}` : ''}` : `${dpCount(item.progress)} / ${dpCount(item.target)}`}</span></article>`).join('') : '<div class="dp-empty">和角色开始相处后，这里会记录你的成就。</div>';
  dpUpdateDirty();
}

function dpReadNumber(id, label) {
  const input = dpQ(`#${id}`);
  const n = Number(input.value);
  if (input.value === '' || !Number.isFinite(n) || (input.min !== '' && n < Number(input.min)) || (input.max !== '' && n > Number(input.max))) {
    input.focus();
    throw new Error(`${label}需要填写 ${input.min}–${input.max} 范围内的数字。`);
  }
  return n;
}

function dpCollect(sections) {
  const settings = {};
  if (sections.includes('display')) {
    for (const [key, id] of Object.entries({ visible: 'dp-visible', alwaysOnTop: 'dp-top', mouseThrough: 'dp-through', gazeTracking: 'dp-gaze', positionLocked: 'dp-lock' })) settings[key] = dpQ(`#${id}`).checked;
    settings.scale = dpReadNumber('dp-scale', '角色大小');
    settings.opacity = dpReadNumber('dp-opacity', '不透明度');
  }
  if (sections.includes('motion')) {
    const weights = {};
    for (const input of dpQa('[data-dp-motion-weight]')) {
      const n = Number(input.value);
      if (input.value === '' || !Number.isFinite(n) || n < 0 || n > 100) { input.focus(); throw new Error('动作权重需要填写 0–100 范围内的数字。'); }
      weights[input.dataset.dpMotionWeight] = n;
    }
    settings.motion = { ...(dpData.settings.motion || {}), randomEnabled: dpQ('#dp-random-motion').checked, expressionEnabled: dpQ('#dp-random-expression').checked, postureEnabled: dpQ('#dp-auto-posture').checked, idleIntervalSeconds: dpReadNumber('dp-idle-interval', '待机间隔'), clickCooldownSeconds: dpReadNumber('dp-click-cooldown', '点击冷却'), disabled: dpQa('[data-dp-motion-enabled]').filter((el) => !el.checked).map((el) => el.dataset.dpMotionEnabled), weights, stateMap: Object.fromEntries(dpQa('[data-dp-binding]').map((el) => [el.dataset.dpBinding, el.value])) };
  }
  if (sections.includes('companion')) {
    const enabled = dpQ('#dp-auto').checked;
    const selected = dpSelectedAi();
    if (enabled && (!selected || selected.vision === 'no' || selected.configured === false)) throw new Error('开启自动陪伴前，请选择已配置且支持看图的 AI 模型。');
    settings.companion = { ...(dpData.settings.companion || {}), enabled, providerId: dpQ('#dp-provider').value, model: dpQ('#dp-ai-model').value, intervalSeconds: dpReadNumber('dp-observe-interval', '自动观察间隔'), maxPerHour: dpReadNumber('dp-hour-limit', '自动每小时请求上限'), maxPerDay: dpReadNumber('dp-day-limit', '自动每日请求上限'), idlePauseSeconds: dpReadNumber('dp-idle-pause', '空闲暂停时间'), displayId: dpQ('#dp-display').value, persona: dpQ('#dp-persona').value.trim() };
  }
  return settings;
}

async function dpRefresh({ fill = false, sections } = {}) {
  const seq = dpLoadSeq;
  const data = await dpRequest('state');
  if (seq !== dpLoadSeq || state.tab !== 'desktop-pet') return data;
  const first = !dpData;
  dpData = data;
  if (fill || first) dpFillForms(sections);
  dpRenderDynamic();
  return data;
}

async function loadDesktopPetPage() {
  initDesktopPetPage();
  stopDesktopPetPage();
  const seq = ++dpLoadSeq;
  try {
    const data = await dpRequest('state');
    if (seq !== dpLoadSeq || state.tab !== 'desktop-pet') return;
    const first = !dpData;
    dpData = data;
    dpFillForms(first ? undefined : ['display', 'motion', 'companion'].filter((s) => !dpDirtySections.has(s)));
    dpRenderDynamic();
    dpTimer = setInterval(async () => {
      if (dpLoading || state.tab !== 'desktop-pet' || document.hidden) return;
      dpLoading = true;
      try {
        const fresh = await dpRequest('state');
        if (seq !== dpLoadSeq || state.tab !== 'desktop-pet') return;
        const oldActive = dpData?.activeModel?.id;
        dpData = fresh;
        // 轮询只更新动态状态；不重建正在编辑的表单、动作行或下拉列表。
        if (oldActive !== fresh.activeModel?.id && !dpDirtySections.has('motion')) dpFillForms(['motion']);
        dpRenderDynamic();
      } catch (e) { if (seq === dpLoadSeq) dpHint(`读取桌宠状态失败：${e.message}`, true); }
      finally { dpLoading = false; }
    }, 4000);
  } catch (e) {
    if (seq === dpLoadSeq) {
      dpHint(`桌面伙伴暂时不可用：${e.message}`, true);
      if (!dpData) dpQ('#dp-status').innerHTML = '<span class="dp-seg"><span class="dot dot-off"></span><span class="dp-seg-k">桌面伙伴</span><span class="dp-seg-v">尚未连接</span></span><span class="dp-status-note">可前往插件管理检查“桌面伙伴”，再点「刷新状态」。</span>';
    }
  }
}

function stopDesktopPetPage() {
  if (dpTimer) clearInterval(dpTimer);
  dpTimer = null;
  dpLoadSeq += 1;
  dpStopSpy();
  dpPreviewController?.abort();
  dpPreviewController = null;
  for (const record of dpPreviewCache.values()) if (record.objectUrl) URL.revokeObjectURL(record.objectUrl);
  dpPreviewCache.clear();
  dpLibraryKey = '';
}

async function dpSave(sections) {
  const settings = dpCollect(sections);
  await dpRequest('settings', { settings });
  sections.forEach((s) => dpDirtySections.delete(s));
  await dpRefresh({ fill: true, sections });
  dpHint('设置已保存，桌宠会立即使用新设置。');
}

async function dpClick(event) {
  const nav = event.target.closest('[data-dp-scroll]');
  if (nav) { dpSetActiveNav(nav.dataset.dpScroll); dpQ(`#${nav.dataset.dpScroll}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const button = event.target.closest('[data-dp-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.dpAction;
  if (action === 'plugins') { switchTab('plugins'); return; }
  if (action === 'cancel-observe') {
    try { await dpRequest('command', { type: 'cancel-observe' }); dpHint('已取消本次观察。'); await dpRefresh(); }
    catch (e) { dpHint(e.message, true); }
    return;
  }
  if (dpBusy) return;
  if (!dpData && action !== 'refresh') { dpHint('桌面伙伴状态尚未加载，请先刷新状态，或前往插件管理检查桌面伙伴是否已启用。', true); return; }
  dpBusy = true;
  button.disabled = true;
  try {
    if (action === 'save') await dpSave(button.dataset.dpSave === 'all' ? ['display', 'motion', 'companion'] : [button.dataset.dpSave]);
    else if (action === 'refresh') { await dpRefresh(); dpHint('状态已更新，未保存的设置已保留。'); }
    else if (action === 'discard') { await dpRefresh({ fill: true }); dpDirtySections.clear(); dpUpdateDirty(); dpHint('已恢复已保存的设置。'); }
    else if (action === 'import') {
      if (dpDirtySections.has('motion')) throw new Error('导入角色前，请先保存动作设置或撤销改动。');
      const result = await dpRequest('import', {});
      if (result.canceled || result.cancelled) dpHint('已取消导入。');
      else { await dpRefresh({ fill: true, sections: ['display', 'motion'].filter((s) => !dpDirtySections.has(s)) }); dpHint('角色模型已导入并应用，请查看桌面窗口。'); }
    }
    else if (action === 'select') {
      const modelId = button.dataset.dpId;
      const selected = (dpData.models || []).find((model) => model?.id === modelId);
      if (!selected) throw new Error('此角色已不在列表中，请刷新后重新选择。');
      if (modelId === dpData.activeModel?.id) return;
      if (dpDirtySections.has('motion')) throw new Error('切换角色前，请先保存动作设置或撤销改动。');
      dpRenderLibrary();
      await dpRequest('select', { modelId });
      await dpRefresh({ fill: true, sections: ['motion', ...(!dpDirtySections.has('display') ? ['display'] : [])] });
      dpHint(`已选择「${selected.name || selected.id}」，桌面窗口会自动加载。`);
    }
    else if (action === 'toggle-visible') {
      await dpRequest('settings', { settings: { visible: !dpData.settings.visible } });
      await dpRefresh();
      if (!dpDirtySections.has('display')) dpQ('#dp-visible').checked = !!dpData.settings.visible;
      dpHint(dpData.settings.visible ? '桌宠已显示。' : '桌宠已隐藏，可随时在此恢复。');
    }
    else if (action === 'reset-position') {
      await dpRequest('command', { type: 'reset-position' });
      await dpRefresh();
      dpHint('桌宠已移回可见屏幕范围。');
    }
    else if (action === 'preview-motion' || action === 'preview-expression') {
      await dpRequest('command', { type: action === 'preview-motion' ? 'motion' : 'expression', id: button.dataset.dpId });
      dpHint('动作已开始播放，请查看桌面上的角色。');
    }
    else if (action === 'reset-expression') {
      await dpRequest('command', { type: 'reset-expression' });
      dpHint('已恢复默认表情与站姿。');
    }
    else if (action === 'preview-speech') {
      await dpRequest('command', { type: 'preview-speech' });
      dpHint('示例气泡已显示。长文会自动展开，鼠标停在气泡上可慢慢阅读，点击 × 可关闭。');
    }
    else if (action === 'observe') {
      if (dpDirtySections.has('companion')) throw new Error('请先保存陪伴设置，再开始观察。');
      dpObservePending = true;
      dpRenderDynamic();
      dpHint('正在理解屏幕画面并生成回复…');
      const result = await dpRequest('observe', {});
      await dpRefresh();
      dpHint(result.skipped ? (result.reason || '画面没有明显变化，本次跳过模型请求。') : result.canceled || result.cancelled ? '本次观察已取消。' : '屏幕观察已完成。');
    }
  } catch (e) { dpHint(e.message || String(e), true); }
  finally {
    dpBusy = false;
    if (action === 'observe') dpObservePending = false;
    if (button.isConnected) button.disabled = false;
    dpRenderDynamic();
  }
}

// 被隐藏的页面不发轮询请求；重新可见后由现有计时器恢复。
window.addEventListener('beforeunload', stopDesktopPetPage);
// 桌宠双击 / 右键菜单打开控制台时直接进入本页。
// 桥名按宿主：electron/preload.cjs 暴露的是 qqaDesktop（不是 qqAgentShell）。
let dpConsoleUnsubscribe = null;
try {
  dpConsoleUnsubscribe = window.qqaDesktop?.onPetOpenConsole?.(() => switchTab('desktop-pet'));
} catch { /* 网页控制台没有桌面桥时仍可正常管理设置。 */ }
window.addEventListener('beforeunload', () => { if (typeof dpConsoleUnsubscribe === 'function') dpConsoleUnsubscribe(); });
