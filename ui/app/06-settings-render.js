// 〔设置渲染 / 模型目录 / 技能插件页〕——M9 拆分第 7 段
'use strict';
// ── 模型目录（多提供商；面板式选择 + 图片输入能力徽标） ──
function visionBadge(providerId, model) {
  const r = (state.visionResults || {})[`${providerId}|||${model}`];
  const src = r?.source === 'docs' ? '官方资料' : (r?.source === 'probe' ? '在线探测' : '');
  const show = state.config?.ui?.showVision !== false;
  const t = (cls, text) => `<span class="vbadge ${cls}" style="${show ? '' : 'display:none'}" title="${esc((src ? `【${src}】` : '') + (r?.note || ''))}">${text}</span>`;
  if (!r) return t('unk', '未检测');
  if (r.verdict === 'vision') return t('ok', '支持图片输入');
  if (r.verdict === 'no-vision') return t('no', '不支持图片输入');
  return t('unk', '无法判定');
}

// ── 两栏悬停下拉：左供应商 / 右模型 ──
function visionVerdictOf(providerId, model) {
  return (state.visionResults || {})[`${providerId}|||${model}`]?.verdict;
}

// 说明：这里曾经有一个 bindModelDdDismiss()，目标是 #model-dd / #model-pick-btn，
// 但真正的模型选择控件 id 是 #cfg-model-pick / #cfg-model（记忆页是 #cfg-mem-model-pick），
// 那两个 id 全项目从未被创建过 —— 函数也从未被调用，属于纯死代码，已删除。
// 若将来需要一个"点击外部/Esc 收起目录"的通用行为，请在 modelModalShell 里统一实现。




function renderSettingsSidebar() {
  const s = state.status;
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;
  // ── 分区合并（移植旧版）──
  // 9 项菜单太长，找东西靠扫两遍。按"用户脑子里的任务"合并成 5 项：
  //   模型与搜索（api+search）/ 人设与记忆（persona+memory）/ 聊天（allow+chat）/
  //   运行环境（onebot+desktop）/ 工具与技能（tools）。
  // 合并页 = 两个渲染函数直接字符串拼接（各自内部逻辑一行未动）。敢拼的前提：
  // 两两表单的元素 id 无交集（api∩search、persona∩memory、allow∩chat、onebot∩desktop
  // 全为空集），不会出现 getElementById 取错元素。
  // ⚠️ 被并掉的 id（search / memory / chat / onebot）不再出现在菜单里，但 saveConfig
  //    仍按这些 id 收集字段 —— 条件已放宽到合并后的宿主 id（见 08-modals.js saveConfig），
  //    否则合并页里另一半表单不会被保存（静默丢配置）。
  // 2026-09-20 二次重排：原「运行环境」(desktop) 一页塞了 OneBot 连接 + 桌面端 +
  //    界面 + 数据管理四类互不相关的内容，长滚动里主题混杂。拆成两页：
  //    「连接与启动」(onebot) = 机器人怎么连上 QQ；「界面与应用」(app) = 软件本身
  //    （主题/刷新/预览 → 自启/托盘 → 数据 → 更新）。'desktop' 保留为兼容别名。
  //    2026-09-21：页签名从「应用与界面」改为「**界面与应用**」，并同步把区块顺序调成
  //    界面 → 桌面端（按使用频率：主题是这页最常改的；自启/托盘装完设一次就基本不动）。
  // 第三列是图标 path，与原型 v2 的 NAV 逐字符相同（照原型 .sn-logo）
  // 2026-10-23：分区名从"实现模块"改成"我要做的事"，并把「连接 QQ」从第 5 提到第 2 ——
  // 新人的顺序是「填模型 → 连 QQ → 选群 → 调性格」，而不是"模型与搜索 / 人设与记忆"。
  // ⚠️ id 一个都不能改：settingsSection 的取值、hc-fix-btn 的 data-target、
  //    各分区 h3 的锚点（settings-api 等）全靠它。
  const menu = [
    ['api', '连接模型', 'M4 7h16M4 12h10M4 17h7'],
    ['onebot', '连接 QQ', 'M5 12h14M12 5l7 7-7 7'],
    ['allow', '聊天与权限', 'M4 5h16v11H8l-4 4z'],
    ['persona', '性格与记忆', 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M5 20a7 7 0 0 1 14 0'],
    ['tools', '能力与工具', 'M14 6l4 4-8 8H6v-4z'],
    // 2026-11-03：ffmpeg 不再随安装包分发，改为这里按需下载。
    // 放「能力与工具」之后 —— 它决定的正是"机器人能处理哪些媒体"。
    ['media', '媒体工具', 'M4 6h11v12H4z M15 10l5-3v10l-5-3z'],
    ['app', '外观与数据', 'M3 5h18v14H3z M3 9h18']
  ];
  // ── 快捷开关（r43，照原型 v2 设置左栏底部那 4 个，全部映射真实字段）──
  //   自动回复     = autoReply.enabled（r43 新增后端字段：关 = 只读模式，消息照常存档不回复）
  //   记忆功能     = memory.enabled（r43 新增：关 = 提示词不注入记忆 + memory_* 工具停 + 整理停）
  //   前缀缓存保活 = cacheWarm.enabled（与「模型与搜索」页的同名开关同一字段，两处联动）
  //   群聊 @ 才响应 = 全局响应档位是否为 1 档：开 = 拨到 1 档，关 = 回 3 档 50%
  //                  （写 store.contextSliderPos，后端保存时权威重算 contextTier）
  const qc = state.config || {};
  // 峰谷时段判定（r46 审查补）：与 src/config.js 的 peakWindowActive/parseHHMM 逐条镜像 ——
  // 峰谷开启时实际档位走 peak/valley 双点（storeConfigForChat 会覆盖全局滑条），
  // 开关初始态必须按"当前时刻实际生效的那个点"算，否则显示与行为不符。
  // 返回值：null = 峰谷没开（不参与）；true/false = 当前是否在高峰时段。
  const inPeakNow = (() => {
    const ps = qc.store?.peakSchedule;
    if (ps?.enabled !== true) return null;
    const parse = (raw) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
      if (!m) return null;
      const h = Number(m[1]), min = Number(m[2]);
      return (h >= 0 && h <= 23 && min >= 0 && min <= 59) ? h * 60 + min : null;
    };
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const s = parse(ps.peak?.start), e = parse(ps.peak?.end);
    if (s === null || e === null || s === e) return false;
    return s < e ? (minutes >= s && minutes < e) : (minutes >= s || minutes < e);
  })();
  const atOnlyOn = (() => {
    try {
      const st = qc.store || {};
      // 峰谷开 → 按当前时段取双点（缺省 sliderPos 钳到 100，与后端 clampSliderPos 同语义）；
      // 峰谷关 → 走全局滑条（老配置没有位置就从 tier/概率反推）。
      const ps = st.peakSchedule;
      if (inPeakNow !== null && ps) {
        const clamp = (p) => { const n = Number(p); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 100; };
        const pos = clamp(inPeakNow ? ps.peak?.sliderPos : ps.valley?.sliderPos);
        return sliderToTierUI(pos).tier === 1;
      }
      return sliderToTierUI(sliderToTierUI_tierToSlider(st)).tier === 1;
    } catch (e) { console.warn('[settings-quick] atOnly 初始态计算失败：', e && e.message); return false; }
  })();
  const quick = [
    { id: 'autoReply', label: '自动回复', on: qc.autoReply?.enabled !== false },
    { id: 'memory', label: '记忆功能', on: qc.memory?.enabled !== false },
    { id: 'cacheWarm', label: '前缀缓存保活', on: qc.cacheWarm?.enabled === true },
    { id: 'atOnly', label: '群聊 @ 才响应', on: atOnlyOn }
  ];
  // 2026-10-23：侧栏常驻"配置就绪"三枚小标 —— 体检卡只在未就绪时出现在页头，
  // 老用户不被打扰；但新人在任何分区都应该随时看到"还差哪一项"。
  // 口径与 assessReadiness 一致（地址+模型算「模型」一项）。
  const readyModel = !!String(qc.api?.baseUrl || '').trim() && !!String(qc.api?.model || '').trim();
  const readyAllow = !!(qc.allow?.groups?.length || qc.allow?.private?.length || qc.allowAllWhenEmpty);
  const readyQq = !!s?.onebot?.connected;
  sidebar.innerHTML = `
    <div class="settings-runstate">
      <div class="rs-title">机器人运行状态</div>
      <div class="rs-row"><span class="dot ${s?.onebot?.connected ? 'dot-on' : 'dot-off'}"></span><span>${s?.onebot?.connected ? '运行中' : '未就绪'}</span></div>
      <div class="rs-row muted">${state.paused ? '⏸ 已暂停' : (s?.orchestrator?.model ? `模型：${esc(s.orchestrator.model)}` : '模型：未设置')}</div>
      <div class="rs-ready" role="group" aria-label="配置就绪情况">
        ${[
          { k: 'api', t: '模型', ok: readyModel, tip: readyModel ? '接口地址与模型已配置' : '还缺接口地址或模型 —— 点这里去填' },
          { k: 'onebot', t: 'QQ', ok: readyQq, tip: readyQq ? 'QQ 已连上' : 'QQ 还没连上 —— 点这里去启动' },
          { k: 'allow', t: '白名单', ok: readyAllow, tip: readyAllow ? '已配置允许的群 / 好友' : '还没配白名单 —— 点这里去勾选' }
        ].map((x) => `<button type="button" class="rs-chip ${x.ok ? 'ok' : 'bad'}" data-rs-goto="${x.k}" title="${esc(x.tip)}"><span class="rs-dot"></span>${x.t}</button>`).join('')}
      </div>
    </div>
    <div class="settings-menu">
      ${menu.map(([id, label, ico]) => {
        // 2026-10-23 萌新化 P4：未配过的分区在菜单项上点小橙点，配好消失。
        // 口径与侧栏就绪标三枚 chip 完全一致（模型/QQ/白名单三项首次必配），
        // 不扩到全部六项 —— "配没配过"对 persona/tools/app 没有可靠判据，
        // 乱点圆点反而误导。老用户配好后菜单干净如初。
        const needDot = (id === 'api' && !readyModel) || (id === 'onebot' && !readyQq) || (id === 'allow' && !readyAllow);
        return `<button class="settings-menu-item ${state.settingsSection === id ? 'active' : ''}" data-section="${id}"><svg class="sm-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${ico}" stroke-linejoin="round" stroke-linecap="round"/></svg><span class="sm-t">${label}</span>${needDot ? '<span class="sm-dot" title="这项还没配置，点这里去设置"></span>' : ''}${id === 'app' && updateAvailable ? '<span class="update-dot" title="发现新版本"></span>' : ''}</button>`;
      }).join('')}
      <!-- 滑动高亮条：切分区时平滑滑到当前项（首次定位不加过渡） -->
      <span class="settings-menu-ind" aria-hidden="true"></span>
    </div>
    <!-- 使用引导（OOBE）手动入口：群友反馈"把说明书设置开屏弹出"之外，
         也要能随时回看。刻意**不带** data-section —— 下面的点击绑定靠它
         区分"分区项 / 功能项"，见该处 if (!el.dataset.section) 守卫。 -->
    <button class="settings-menu-item ob-entry" id="open-onboarding-btn" type="button" title="重新查看使用引导（怎么把这个机器人跑起来）">
      <svg class="sm-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7V3z M11 8h2v5h-2z M11 14h2v2h-2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/></svg>
      <span class="sm-t">使用引导</span>
    </button>
    <div class="settings-quick">
      <div class="sq-title">快捷开关</div>
      ${quick.map((q) => `<label class="sq-row"><span class="sq-t">${q.label}</span><input type="checkbox" class="sw" data-quick="${q.id}"${q.on ? ' checked' : ''} aria-label="${q.label}" /></label>`).join('')}
    </div>`;
  moveMenuInd(sidebar, false);
  // ── 快捷开关：即时保存（同 cfg-cachewarm 的模式），失败回滚勾选态 ──
  // 侧栏 innerHTML 每次重建，监听器在这里随重建重新挂，不会叠。
  sidebar.querySelectorAll('input[data-quick]').forEach((el) => {
    el.addEventListener('change', async () => {
      const on = !!el.checked;
      const kind = el.dataset.quick;
      let patch;
      if (kind === 'autoReply') patch = { autoReply: { enabled: on } };
      else if (kind === 'memory') patch = { memory: { enabled: on } };
      else if (kind === 'cacheWarm') patch = { cacheWarm: { enabled: on } };
      else {
        // 「群聊 @ 才响应」：开 = 拨到 1 档，关 = 回 3 档 50%。峰谷开启时实际档位走
        // 峰谷双点（config.js storeConfigForChat 会覆盖全局滑条），双点必须一起拨，
        // 否则开关拨了不动；峰谷关时只写全局滑条，不碰用户调好的峰谷曲线（r46 审查补）。
        const pos = on ? tierToSlider(1, 0) : tierToSlider(3, 50);
        patch = { store: { contextSliderPos: pos } };
        if (state.config?.store?.peakSchedule?.enabled === true) {
          patch.store.peakSchedule = { peak: { sliderPos: pos }, valley: { sliderPos: pos } };
        }
      }
      try {
        await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
        // 同步本地缓存：侧栏随后重建时开关不回跳；「模型与搜索」页的
        // cfg-cachewarm 勾选态也由同一份 state.config 驱动，自动跟手。
        if (kind === 'atOnly') {
          state.config = state.config || {};
          const pos = on ? tierToSlider(1, 0) : tierToSlider(3, 50);
          const prevStore = state.config.store || {};
          const nextStore = { ...prevStore, contextSliderPos: pos };
          // 与 patch 同步：峰谷开着时双点也记进本地缓存（侧栏重建时开关不回跳）
          if (prevStore.peakSchedule?.enabled === true) {
            nextStore.peakSchedule = {
              ...(prevStore.peakSchedule || {}),
              peak: { ...(prevStore.peakSchedule?.peak || {}), sliderPos: pos },
              valley: { ...(prevStore.peakSchedule?.valley || {}), sliderPos: pos }
            };
          }
          state.config.store = nextStore;
        } else if (kind === 'autoReply') {
          state.config = state.config || {};
          state.config.autoReply = { ...(state.config.autoReply || {}), enabled: on };
        } else if (kind === 'memory') {
          state.config = state.config || {};
          state.config.memory = { ...(state.config.memory || {}), enabled: on };
        } else {
          state.config = state.config || {};
          state.config.cacheWarm = { ...(state.config.cacheWarm || {}), enabled: on };
          // 双胞胎同步：设置页默认就停在「模型与搜索」区，表单里的 #cfg-cachewarm
          // 与本开关是同一字段 —— 点同区菜单项会早退不重渲染，必须在这里直接刷。
          const twin = document.querySelector('#cfg-cachewarm');
          if (twin && twin !== document.activeElement) twin.checked = on;
        }
      } catch (err) {
        el.checked = !on;
        qaAlert(`保存失败：${err.message}`);
      }
    });
  });
  // 就绪小标：点击跳到对应分区。走真实菜单项的 click —— 复用它的 flush + 入场动画 +
  // 重渲染，不另写一套切换逻辑（避免两条路径行为漂移）。
  sidebar.querySelectorAll('[data-rs-goto]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const sec = chip.dataset.rsGoto;
      const item = sidebar.querySelector(`.settings-menu-item[data-section="${sec}"]`);
      if (item && sec !== state.settingsSection) item.click();
    });
  });
  // 「使用引导」入口：手动重开 OOBE（18-onboarding.js 的 window.openOnboarding）。
  // 侧栏每次 renderSettingsSidebar 都重建，监听器随之重挂，不会叠。
  sidebar.querySelector('#open-onboarding-btn')?.addEventListener('click', () => {
    if (typeof window.openOnboarding === 'function') window.openOnboarding();
  });
  sidebar.querySelectorAll('.settings-menu-item').forEach((el) => {
    // 无 data-section 的是功能项（如「使用引导」入口），不走分区切换逻辑 ——
    // 没有这道守卫，state.settingsSection 会被写成 undefined，整页渲染崩掉。
    if (!el.dataset.section) return;
    el.addEventListener('click', () => {
      if (el.dataset.section === state.settingsSection) return;
      // 切区块 = 整页表单重建：先把防抖窗口内挂起的保存发出，
      // 否则刚输入的内容直接被重渲染吹掉（与切页签同一条防线）。
      flushSettingsSaves();
      state.settingsSection = el.dataset.section;
      // 只切换 active 类（不重建侧栏）→ 指示条平滑滑动、悬停态不闪断
      sidebar.querySelectorAll('.settings-menu-item').forEach((b) => b.classList.toggle('active', b === el));
      moveMenuInd(sidebar, true);
      // R123：① 先挂入场动画的欠条 —— 由下面"真正完成重建"的那一次 renderSettings
      //   兑现并播放（见其后的 if (pendingSwitchAnim)）。绝不在 click 里立刻播：
      //   一旦重建被推迟，动画就播在旧内容上，旧分区会半透明地"回来一下"再被
      //   整体换掉（用户报的"闪一下"）。
      pendingSwitchAnim = true;
      // R123：② 越过"自动保存在途"守卫，当场重建。
      //   不越过的话，flushSettingsSaves() 起的这次保存会把重建推迟到 POST 返回后
      //   （实测 DOM 在 +23ms 才掉包，后端忙时更久），换区变成"等网络"。
      //   安全性：saveConfig（08:1639）是**同步把表单读完**再 POST 的 ——
      //   flush 之后 DOM 已不再被保存流程需要；而新分区的字段不属于这次保存要
      //   写回的范围（响应写的是旧分区的字段），不会被陈旧 state.config 覆盖。
      settingsSwitchBypass = true;
      try {
        renderSettings();
      } finally {
        settingsSwitchBypass = false;
      }
      // R123：③ 撤掉"保存返回后再补一次重建"的待重绘。
      //   重建已经在上面完成，POST 返回时 endSettingsGuard 再重建一次 = 20ms 内
      //   两次全量 innerHTML 换血（第二次还会再播一遍动画）= 又闪一下。
      settingsGuard.needRerender = false;
    });
  });
}

/** 把菜单滑动指示条对齐到当前 active 项。
 *  animate=false 用于定位；但若记住了上一次的位置（menuIndPrevTop），
 *  即使是重建后的首次定位也从旧位置滑过去 —— 否则切换时挂起的自动保存
 *  完成后会重建侧栏，指示条瞬移，滑动动画被打断。 */
let menuIndPrevTop = null;
let settingsSwitchAnim = null;   // R107：分区切换入场动画的句柄，连点时先 cancel 上一条

/* R123：切分区的两条新契约 ——
     settingsSwitchBypass：允许这一次 renderSettings 越过"自动保存在途"守卫。
     pendingSwitchAnim：入场动画的**欠条**，由真正完成重建的那一次 renderSettings
     兑现并播放。

   为什么必须拆开：旧写法是 click → renderSettings() → form.animate() 三连，
   而 flushSettingsSaves()（07:27）对每个登记的 flushSave 都无条件 doSave()（07:294），
   于是每次切分区都会当场起一次保存 → 守卫 pending=1 → renderSettings 被挡下并
   推迟到 POST 返回之后（实测：DOM 在 +23ms 才掉包，真机后端忙时更长）。
   动画不等它：从 +0ms 起就在**旧分区**上把不透明度从 0 拉起来，旧内容以
   20%~50% 的半透明态回来一下、再被整体换掉 —— 用户眼里就是"闪一下"。
   现在：动画挂在"新建完成的那一刻"，谁建谁播；同时不再依赖网络往返。 */
let settingsSwitchBypass = false;
let pendingSwitchAnim = false;

/** 分区切换的入场过渡：Web Animations API，播完自动释放（不留合成层）。
 *  R107：从「单段淡入上移 7px」升级成 PCL2 MyPageRight 式**两段式弹出** ——
 *   0→62% 走 --ease-out-quart（OutFluent）快速到位，62%→100% 走 --ease-spring
 *   （OutBack）轻微过冲收尾。与 .view.active 的 pageIn、弹窗的 popIn 同一套手感。
 *  ⚠️ R127（2026-10-15 用户报「设置页动画有点卡顿」）：**去掉 scale**。
 *     本窗口 disableHardwareAcceleration() + --disable-gpu（electron/main.js 的 GPU 启动段），
 *     一切绘制走 CPU 光栅化。transform 的 translateY / opacity 提层后只搬层、
 *     不重画，软件渲染下也便宜；而 **scale 是唯一会迫使合成器每帧重光栅化**
 *     整个 #settings-form 的属性（工具页 = 30 张 tool-card、几百个节点），
 *     320ms 动画大面积掉帧 —— 用户看到的"卡顿"就是它。「被放下来」的到位感
 *     由 translateY + 两段 easing 保留（12px 仍比 pageIn 的 4px 强一个量级，
 *     不会和卡片阶梯打架），过冲收尾的"弹"由 translateY(-2px) 继承，
 *     只去掉缩放这一项。时长 320→240ms，少一帧是一帧。
 *  ⚠️ 卡片另有 .settings-pane > * 的阶梯 pageIn（每张 +25ms，位移只有 --shift-sm
 *     4px）—— 4px 与 12px 差一个量级，两层不会打架
 *     （R95 修掉的是同量级、同方向的"二次到位"顿挫）。
 *  ⚠️ WAAPI **不读 CSS 的 @media (prefers-reduced-motion)**：style.css 那条通配符
 *     只压 CSS animation/transition。所以这里必须自己判断，否则开了「减少动态效果」
 *     的用户照样看到 12px 位移。reduce 下退化成纯淡入、时长 1ms（与 CSS 一致）。
 *  ⚠️ 连点多个分区时先 cancel 上一条，避免两条动画叠着跑。 */
function playSwitchAnim() {
  const form = $('#settings-form');
  if (!form) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  if (settingsSwitchAnim) settingsSwitchAnim.cancel();
  settingsSwitchAnim = form.animate(
    reduce
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { opacity: 0, transform: 'translateY(12px)', offset: 0, easing: 'cubic-bezier(.25, 1, .5, 1)' },
          { opacity: 1, transform: 'translateY(-2px)', offset: .62, easing: 'cubic-bezier(.34, 1.56, .64, 1)' },
          { opacity: 1, transform: 'none', offset: 1 }
        ],
    { duration: reduce ? 1 : 240 }
  );
}
function moveMenuInd(sidebar, animate) {
  const ind = sidebar.querySelector('.settings-menu-ind');
  const act = sidebar.querySelector('.settings-menu-item.active');
  if (!ind) return;
  if (!act) { ind.style.opacity = '0'; menuIndPrevTop = null; return; }
  ind.style.opacity = '1';
  // r101：蓝条与「二级导航」的 .sn-bar 同款 —— 上下各内缩 6px（36 - 12 = 24）。
  //   top / height 是**内联**样式，CSS 覆盖不了，只能在这里算。
  const IND_IN = 6;
  const top = act.offsetTop + IND_IN;
  const h = Math.max(0, act.offsetHeight - IND_IN * 2);
  const slide = menuIndPrevTop != null && Math.abs(menuIndPrevTop - top) > 2;
  if (slide) {
    ind.classList.add('no-anim');
    ind.style.top = menuIndPrevTop + 'px';
    ind.style.height = h + 'px';
    void ind.offsetHeight;   // 强制回流：让起点先生效，再开过渡
    ind.classList.remove('no-anim');
  }
  ind.style.top = top + 'px';
  ind.style.height = h + 'px';
  menuIndPrevTop = top;
}

function renderSettings() {
  // 渲染守卫：自动保存进行中（表单正在被读取 / state.config 即将被覆盖）时
  // 不允许重建表单 DOM —— 会吹掉用户正在输入的未保存内容。
  // 拦下的请求由 endSettingsGuard() 在保存完成后补放。
  // ⚠️ R123：切分区**越过**守卫（settingsSwitchBypass）—— 见菜单项 click 处理里的
  //   说明。那是一次用户主动的全量换区，保存要读的值已被 flushSettingsSaves()
  //   读走并发出请求，重建不会丢数据；而落在守卫后面会把重建推迟到 POST 返回
  //   之后（真机 20~300ms），入场动画却已经播在旧内容上 = 用户看到的"闪一下"。
  if (settingsGuard.pending > 0 && !settingsSwitchBypass) {
    settingsGuard.needRerender = true;
    return;
  }
  // 焦点保护（2026-09-19 修"文本框偶发点不进/失焦"）：守卫只护住"保存进行中"的
  // 窗口，但守卫之外仍有一批异步重渲染（群名补底 / 视觉扫描完成 / 技能开关保存 /
  // 守卫补放的延迟渲染）会在用户打字途中重建 innerHTML —— 焦点、光标位置、
  // 未落盘的输入值全部被吹掉。这里在重建前后做"焦点与选区快照恢复"：
  //   ① 记下正在聚焦的输入框 id + 光标位置 + 当前值；
  //   ② 重建后按 id 找回元素，把值写回（渲染用的是 state.config，可能还没
  //      带上防抖窗口内的输入），恢复焦点与光标。
  //   ⚠️ 曾用 id 作唯一身份 —— 但**没有 id 的输入框**（如 `05-memory-settings.js` 的搜索框
  //      的批量价格 `.bp-in/.bp-out/.bp-cached`）会走 `querySelector('#')`，
  //      抛 SyntaxError 后被下面的 try/catch 静默吞掉，焦点再也找不回来。
  //      R75 改成 id 优先 + **DOM 路径兜底**：路径是索引序列，与 id 无关。
  const box = $('#settings-form');
  // 2026-10-23 修复：整页重建会丢滚动位置（焦点恢复用的是 preventScroll，不做补偿）。
  // 长页面（「工具与技能」30 张卡）滚到中部时，任何一次异步补渲染 —— 保存完成、
  // loadSettings 慢路径、技能开关、群名补底 —— 都会把用户弹回顶部。
  // 这里通用地找最近的滚动祖先（.settings-pane 或外层），重建后写回。
  const scroller = (() => {
    let n = box;
    while (n && n !== document.body) {
      const oy = getComputedStyle(n).overflowY;
      if (oy === 'auto' || oy === 'scroll') return n;
      n = n.parentElement;
    }
    return null;
  })();
  const prevScrollTop = scroller ? scroller.scrollTop : 0;
  const pathOf = (el, root) => {
    const parts = [];
    let n = el;
    while (n && n !== root) {
      const p = n.parentElement;
      if (!p) return null;
      parts.push([...p.children].indexOf(n));
      n = p;
    }
    return parts.reverse().join('/');
  };
  const byPath = (root, path) => {
    let n = root;
    for (const seg of String(path).split('/')) {
      if (!n) return null;
      n = n.children[Number(seg)] || null;
    }
    return n;
  };
  const focusSnap = (() => {
    const el = document.activeElement;
    if (!box || !el || el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT') return null;
    if (el.type === 'checkbox' || el.type === 'radio' || !box.contains(el)) return null;
    return {
      id: el.id,
      path: pathOf(el, box),
      tag: el.tagName,
      selStart: el.selectionStart ?? null,
      selEnd: el.selectionEnd ?? null,
      value: el.value
    };
  })();
  const c = state.config;
  // 组字中不清场（R75）：输入法正在组字时重建 DOM 会**连同组字状态一起炸掉**，
  // 用户看到的就是"中文打到一半没反应"。延到上屏/取消后再补一次重绘。
  const composingEl = document.activeElement;
  // __composePending 防止组字期间反复被调用时挂上一串 once 监听（结束会连着重绘 N 次）
  if (composingEl && composingEl.isComposing && box?.contains(composingEl)) {
    if (renderSettings.__composePending) return;
    renderSettings.__composePending = true;
    composingEl.addEventListener('compositionend', () => {
      renderSettings.__composePending = false;
      renderSettings();
    }, { once: true });
    return;
  }
  renderSettingsSidebar();
  // 2026-10-23：预览演示模式下 POST /api/config 被 00-preview.js 拦截（不落真实后端），
  // 但保存反馈仍显示「✓ 已保存」—— 用户改半天，退出演示模式后全部消失。显式告知。
  const previewBanner = (typeof state !== 'undefined' && state.preview)
    ? '<div class="hint" style="margin:0 0 10px;color:var(--orange)">⚠️ 预览演示模式：这里的改动不会保存到真实配置。</div>'
    : '';
  // 2026-10-23：只在「首次渲染 / 切分区」时播卡片阶梯（CSS 见 .settings-pane.anim-stagger）。
  // 保存完成后的补渲染、loadSettings 慢路径、SSE 引发的重建都不再重播 ——
  // 此前是无条件播，用户每改一个开关，整页卡片就重新淡入一次。
  const playStagger = pendingSwitchAnim || !box.dataset.staggerPlayed;
  box.dataset.staggerPlayed = '1';
  box.classList.toggle('anim-stagger', !!playStagger);
  box.innerHTML = `
    ${setPageHeadHtml()}${previewBanner}${renderSettingsSection(c)}`;
  bindSettingsEvents(c);
  // R123：分区切换的入场动画在这里播 —— 内容刚落到新分区的 DOM 上，动画覆盖的
  // 必然是新内容（旧写法在 click 里紧跟 renderSettings() 之后播，重建被守卫推迟
  // 时就会播在旧内容上 = 旧分区半透明地回来一下再被换掉）。
  if (pendingSwitchAnim) { pendingSwitchAnim = false; playSwitchAnim(); }
  if (focusSnap) {
    // id 优先（快），路径兜底（覆盖无 id 的输入框）——两者都失效时才放弃 + 取证。
    let back = null;
    if (focusSnap.id) {
      try { back = box.querySelector('#' + CSS.escape(focusSnap.id)); } catch { back = null; }
    }
    if (!back && focusSnap.path) back = byPath(box, focusSnap.path);
    if (back && (back.tagName === 'INPUT' || back.tagName === 'TEXTAREA')) {
      try {
        back.value = focusSnap.value;   // 覆盖渲染值：防抖窗口内的输入不被回滚
        if (focusSnap.selStart != null) back.setSelectionRange(focusSnap.selStart, focusSnap.selEnd ?? focusSnap.selStart);
        back.focus({ preventScroll: true });
      } catch { /* 恢复失败不致命 */ }
    } else if (back === null) {
      // level 3 = error → 主进程 R71 的 console-message 监听会落盘（打包版也能取证）
      console.error(`[焦点恢复失败] id=${JSON.stringify(focusSnap.id)} path=${focusSnap.path} tag=${focusSnap.tag}`);
    }
  }
  // 2026-10-23：滚动位置写回（与上面的 prevScrollTop 配对）。
  // 只在原本就滚动过时恢复，避免首次进入时把页面顶到某个旧位置。
  if (scroller && prevScrollTop > 0) scroller.scrollTop = prevScrollTop;
  // 群名补底（一次性）：分群按钮/活跃设置下拉第一次渲染时 state.chats 可能还没到
  // （switchTab 只在列表为空时才拉）。这里发现为空就补拉，到达后重渲染一次。
  if (!(state.chats || []).length && !renderSettings.__chatsFetch) {
    renderSettings.__chatsFetch = true;
    api('/api/chats').then((d) => {
      if ((d.chats || []).length && state.tab === 'settings') renderSettings();
    }).catch(() => {}).finally(() => { renderSettings.__chatsFetch = false; });
  }
}

// r107：已移除「设置 → 扩展」分区（含 extRowHtml / renderExtensionsSection /
// setExtModuleEnabled / bindExtensionsEvents）。技能 / 插件的全局启用开关改由
// 「会话设置 → 扩展 → 技能 / 插件」承载（renderModulePage compact 模式），避免
// 两处重复管理同一份数据。下载页只负责装新的（市场）。

function renderSettingsSection(c) {
  const sec = state.settingsSection || 'api';
  // 合并页 = 两个渲染函数直接字符串拼接（各自内部逻辑一行未动），
  // 各段自带的 <h3> 分组标题照常渲染，长页里仍能看出"这一段是什么"。
  // 2026-09-21 重排「模型与搜索」：按使用习惯分三组、组间用虚线分隔 ——
  //   ① 模型（主模型 → 备选模型）② 搜索（搜索服务 → 添加自定义服务[折叠]）③ 成本（成本核算 → 前缀缓存）
  // 原先的顺序是 模型 → 备选 → 成本 → 缓存 → 搜索 → 添加搜索，主题来回横跳，
  // 且「当前模型单价」卡被"前缀缓存"截断、成了无标题孤儿块。
  const sections = {
    api: () => renderApiSection(c) + renderSearchSection(c) + renderModelCostSection(c),
    persona: () => renderPersonaSection(c) + renderMemorySettingsSection(c),
    allow: () => renderAllowSection(c) + renderChatSection(c),
    desktop: () => renderOnebotSection(c) + renderDesktopSection(c),   // 兼容别名 → 旧 state 恢复
    onebot: () => renderOnebotSection(c),
    app: () => renderDesktopSection(c),
    tools: () => renderToolsSection(c),
    media: () => renderMediaSection(c)
  };
  const render = sections[sec] || sections.api;
  const raw = render();
  // ⚠️「工具与技能」的 h3 嵌在 .module-split-left 里（不是顶层），字符串切分会切碎标签 → 跳过。
  return sec === 'tools' ? raw : settingsCards(raw);
}

/* ── 「设置」页头 + 全局/会话分工提示条（照原型 v2 的 .page-head + .bs-hint）──
   ⚠️ 必须容忍「被借走」：全屏「会话设置」页会把 #settings-form 整体 appendChild 到
      #bp-setup-scroll（14-chrome.js 的安装进度条），那时这块必须消失 —— 显隐交给 style.css 的
      `#view-settings > #settings-form .set-page`，不靠 JS 判断当前宿主是谁。 */
function setPageHeadHtml() {
  // 2026-10-18：长提示默认完整显示，点「知道了」后收成一行（记住选择）。
  // 老用户天天进设置，两行提示每次都在眼前，属于纯噪音；新用户第一次仍看全。
  let hintClosed = false;
  try { hintClosed = localStorage.getItem('qa.settingsHintClosed') === '1'; } catch { /* 隐私模式 */ }
  const hintHtml = hintClosed
    ? `<div class="set-hint set-hint--mini">
        <svg class="set-hint-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8h.01M11 12h1v5h1M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span><b>全局设置</b>：对所有会话生效；单会话请用左下角「<b>会话设置</b>」。</span>
        <button class="set-hint-x" type="button" id="set-hint-open" title="展开完整说明">展开</button>
      </div>`
    : `<div class="set-hint">
        <svg class="set-hint-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8h.01M11 12h1v5h1M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>这些是<b>全局设置</b>，对所有会话生效。想针对某个 QQ 群 / 私聊单独配置（人设覆盖、响应规则、成员屏蔽…），用左下角「<b>会话设置</b>」。</span>
        <button class="set-hint-x" type="button" id="set-hint-close" title="以后收成一行">知道了</button>
      </div>`;
  // 就绪度体检卡（2026-10-19 复活）：r84 移除首启强制跳设置页后，"没填接口地址 /
  // 模型 / 白名单"在界面上只剩顶栏就绪圆点的 hover 提示，新用户没有任何主动文案
  // 告诉他缺什么、去哪填。体检卡的按钮绑定（.hc-fix-btn / #test-api-btn）一直在
  // bindSettingsEvents 里活着，缺的只是渲染调用 —— 挂回页头即整链复活。
  // 口径：只在**未就绪**时显示（就绪后老用户不该被常驻卡片打扰，r84 的教训）；
  // 用户保存配置后 renderSettings 重渲染，缺失项补齐后卡片自动消失。
  // OneBot 连接状态是渲染时刻快照（略滞后），实时口径以横幅 / 就绪圆点为准。
  const healthReady = assessReadiness(state.config, state.status).ready;
  return `
    <div class="set-page">
      <div class="set-head">
        <h2>设置</h2>
        <span class="set-head-sub">软件基础设置 · 全局生效 · 改动自动保存</span>
        <div class="set-search" role="search">
          <svg class="set-search-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4a6 6 0 1 0 3.7 10.7L20 21M10 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          <input type="text" id="set-search-input" placeholder="搜设置：密钥 / 群 / 令牌 / 积极度…" autocomplete="off" aria-label="搜索设置项" />
          <div class="set-search-panel" id="set-search-panel" hidden></div>
        </div>
        <span class="set-save-state" id="set-save-state" role="status" aria-live="polite"></span>
      </div>
      ${hintHtml}
      ${healthReady ? '' : renderHealthCard()}
    </div>`;
}

/* ── 设置搜索索引（2026-10-23 萌新化 P4）──────────────────────────────
   小白最大的成本是"记路径"：想改密钥要在 6 个分区里猜。这张表把高频意图
   （用户会输入的说法）映射到「分区 + 高亮目标」，点一下直达。
   写法约定：
     · keys  = 用户可能输入的说法（含口语 / 拼音首字母 / 开发者术语），全小写比对；
     · target = 跳到分区后高亮的元素 id（可空 = 只切分区）；
     · 一条可以同时命中多个分区（如「令牌」→ onebot）。
   匹配：输入串的任一字串作为子串出现在 key 里，或 key 包含输入串（防"ap"这种
   超短输入全表乱炸，至少 1 个字符即生效，但结果数交给排序：分区优先级的权重）。 */
const SETTINGS_SEARCH_INDEX = [
  { keys: ['密钥', 'api key', 'apikey', 'key', 'sk-', '接口地址', 'base url', 'baseurl', '模型', '提供商', '服务商', '地址', 'moxing', 'miyue'], label: '模型与密钥', desc: '接口地址、密钥、选模型、测试连通', section: 'api', target: 'open-model-config-btn', w: 10 },
  { keys: ['群', '白名单', '好友', '允许', '谁能', '群号', 'qq号', 'qun', 'baimingdan'], label: '谁能找它（白名单）', desc: '勾选允许的群和好友', section: 'allow', target: 'pick-groups-btn', w: 10 },
  { keys: ['qq', '连接', 'onebot', '启动', '登录', 'snowluma', '令牌', 'token', '连接密码', '一键', 'lianjie', 'qidong'], label: '连接 QQ', desc: '一键启动、连接地址与令牌', section: 'onebot', target: 'quick-start-btn', w: 9 },
  { keys: ['积极度', '活跃', '档位', '回话', '回复', '限速', '发送', '间隔', '峰谷', '高峰', '省钱', '安静', 'jijidu', 'huifu'], label: '回复积极度 · 发送与限速', desc: '什么时候接话、说多快、高峰时段更安静', section: 'allow', target: 'open-active-config-btn', w: 8 },
  { keys: ['人设', '性格', '记忆', '提示词', 'prompt', '语气', '人格', 'renge', 'jiyi'], label: '性格与记忆', desc: '机器人是谁、记不记得事', section: 'persona', w: 7 },
  { keys: ['工具', '技能', '插件', '网图', '搜图', '搜索', '能力', 'gongju', 'jineng'], label: '能力与工具', desc: '允许机器人用哪些工具', section: 'tools', w: 7 },
  // 2026-11-03：ffmpeg 改为按需下载后，这里成了它的主要发现路径 ——
  // 用户搜的是"视频 / 动图 / 压缩"这些**现象**，不是 "ffmpeg" 这个实现名。
  { keys: ['ffmpeg', '视频', '抽帧', '图片压缩', '压缩', '转码', '媒体', '动图', 'gif', '壁纸转', 'shipin', 'meiti'], label: '媒体工具（ffmpeg）', desc: '视频抽帧、GIF 转视频、大图压缩要用它', section: 'media', w: 8 },
  // 2026-10-23 晚：壁纸页收回「外观与数据」之后，设置搜索成了它的主要发现路径。
  // 单列一条直达条目（target 指向下面那一节的 h3 锚点），而不是把「壁纸」塞进
  // 「外观与数据」的 keys —— 后者只会带用户到分区顶部，还得自己往下滚一屏。
  { keys: ['壁纸', '背景', '背景图', '小红车', '壁纸引擎', '引擎壁纸', 'bizhi', 'beijing'], label: '界面背景（本地图片 / 壁纸）', desc: '两层背景二选一：本地导入图，或 Wallpaper Engine 壁纸', section: 'app', target: 'settings-bg', w: 10 },
  { keys: ['主题', '皮肤', '外观', '数据', '重置', '备份', '更新', '小窗', '颜色', 'zhuti', 'waiguan'], label: '外观与数据', desc: '主题、数据目录、重置（危险区在底部）', section: 'app', w: 7 },
  { keys: ['屏蔽', '拉黑', '禁言', '成员', 'pingbi'], label: '屏蔽名单', desc: '谁的话当没看见', section: 'allow', target: 'blocklist-btn', w: 6 },
  { keys: ['备用模型', '备选', 'fallback', 'beiyong'], label: '备用模型', desc: '主模型失败时自动换', section: 'api', target: 'add-fallback-row-btn', w: 6 },
  { keys: ['代理', 'proxy', 'daili'], label: '网络代理', desc: '接入国外 API 时用', section: 'api', target: 'open-model-config-btn', w: 6 },
  { keys: ['自动回复', '只读', 'zidong'], label: '自动回复（快捷开关）', desc: '左侧栏「快捷开关」第一个', section: 'api', w: 5 },
  { keys: ['表情', 'sticker', 'biaoqing'], label: '表情包', desc: '在「聊天与权限」分区', section: 'allow', w: 5 },
  { keys: ['价格', '单价', '成本', 'jiage', 'chengben'], label: '成本核算与价格', desc: 'token 单价、自定义价格', section: 'api', w: 5 }
];

/* ── 分区内容 → 卡片（照原型 v2 的 fieldset）──
   渲染函数把每个小节写成 `<h3>标题</h3> + 内容`，并在跨大组的边界放一条
   `.settings-divider`。这里按**顶层** <h3> 把整串切成若干块、各自包进 .set-card；
   那条 divider 落在卡片末尾，而卡片本身已经把这个边界表达出来了，一并删掉。
   ⚠️ 只搬字符串，不碰任何控件的 id 与 DOM 层级 —— 06:136 的焦点恢复靠
      #settings-form 的子元素索引路径定位，中间插一层包装就会对不上。
   ⚠️ 只用于 h3 位于顶层的分区；`usage-h3`（工具页的统计小标题）不切。 */
function settingsCards(html) {
  const parts = html.split(/(?=<h3(?![^>]*usage-h3)(?:\s|>))/);
  const lead = parts.shift() || '';
  const cards = parts.map((p) =>
    `<section class="set-card">${p.replace(/<div class="settings-divider"><\/div>\s*$/, '').trim()}</section>`);
  return lead + cards.join('');
}
function renderApiSection(c) {
  const currentProvider = (state.providers || []).find((p) => p.id === c.api.provider);
  const currentModelDisplay = (currentProvider?.modelNames || {})[c.api.model] || c.api.model;
  // 专用模型的显示名：跨提供商选择时也能读出目录名（找不到就显示裸 id）
  const displayOf = (modelId) => {
    const m = String(modelId || '').trim();
    if (!m) return '';
    for (const p of (state.providers || [])) {
      if ((p.modelNames || {})[m]) return `${p.modelNames[m]}`;
    }
    return m;
  };
  const visionModelDisplay = displayOf(c.api.visionModel);
  const videoModelDisplay = displayOf(c.api.videoModel);
  // 2026-10-23 萌新化 P1：按"是否已配好模型"分叉渲染。
  //   · 未配置（新人第一次进来）→ 整张卡只有两个输入框 + 一个按钮，不再把
  //     「模型配置 / 模型管理 / 添加提供商 / 模型目录 / 批量价格」5 个入口一次摊开；
  //   · 已配置 → 原有结构一行不改（两按钮 + provider-hint 摘要 + 备用模型区块）。
  // 口径与 assessReadiness / 侧栏就绪标一致：地址 + 模型都有了才算"已连接"。
  const readyModel = !!String(c.api?.baseUrl || '').trim() && !!String(c.api?.model || '').trim();
  // ⚠️ 三个 hidden input 两个态都必须渲染：saveConfig 读它们带出
  //    model/provider/baseUrl（08-modals.js 的模型编辑弹窗）。val() 的兜底虽也是旧值，
  //    但字段与改版前完全一致更稳（合并保存时不丢模型身份）。
  const hiddenIds = `
      <input type="hidden" id="cfg-provider" value="${esc(c.api.provider || '')}" />
      <input type="hidden" id="cfg-model" value="${esc(c.api.model || '')}" />
      <input type="hidden" id="cfg-baseurl-value" value="${esc(c.api.baseUrl)}" />`;
  if (!readyModel) {
    // ── 未配置：新手引导卡（两输入框 + 一次点击） ──
    // 「我有多家服务商」按钮复用 open-model-manage-btn 这个 id：行为本就是打开
    // 模型管理（添加提供商/多 Key 场景），健康卡「去设置」的高亮逻辑也自动落到它。
    return `
    <h3 id="settings-api">连接模型</h3>
    <div class="set-guide">
      <div class="sg-head"><span class="sg-step">第 1 步</span><span class="sg-title">把机器人连上一个 AI 模型</span></div>
      <p class="sg-sub">只需要两样东西，都在你买模型服务的网站上：<b>接口地址</b>和<b>密钥</b>。填完点「测试并保存」—— 拉模型列表、选第一个、试连通，都自动完成。</p>
      <div class="field">
        <label for="fg-baseurl">接口地址（Base URL）</label>
        <input type="text" id="fg-baseurl" placeholder="例如 https://api.deepseek.com/v1" autocomplete="off" />
        <div class="hint">服务商给你的网址，一般以 <code>/v1</code> 结尾。用 DeepSeek 官方就是 <code>https://api.deepseek.com/v1</code>。</div>
      </div>
      <div class="field">
        <label for="fg-apikey">密钥（API Key）</label>
        <div class="sg-keyrow">
          <input type="password" id="fg-apikey" placeholder="sk- 开头的那一串" autocomplete="new-password" />
          <button class="btn btn-small" type="button" id="fg-key-toggle">显示</button>
        </div>
        <div class="hint">在服务商网站的「API Keys / 密钥管理」页创建。只保存在你自己电脑上，不发往任何别处。</div>
      </div>
      <div class="sg-actions">
        <button class="btn btn-primary" type="button" id="fg-start">测试并保存</button>
        <button class="btn" type="button" id="open-model-manage-btn">我有多家服务商 / 手动添加</button>
      </div>
      <div class="hint sg-result" id="fg-result" role="status" aria-live="polite"></div>
      ${hiddenIds}
    </div>
    <div class="settings-divider"></div>`;
  }
  // 首次配置向导的连通性测试结果（runFirstTimeGuide 写入 state.__modelTestNote）。
  // 为什么不直接 setHintText：loadSettings 的慢路径还会再渲染一次，写在 DOM 上的
  // 文案会被冲掉；放 state 里让渲染函数读，重渲染天然带上，刷新页面后消失也合理
  // （一次性反馈，不持久化）。model 比对保证"换了模型旧结果不残留"。
  const note = state.__modelTestNote;
  const testNote = (note && note.model === String(c.api?.model || '').trim())
    ? `<div class="hint" style="margin-top:4px;color:${note.ok ? 'var(--ok, #2fa55c)' : 'var(--orange)'}">${esc(note.text)}</div>`
    : '';
  return `
    <h3 id="settings-api">连接模型</h3>
    <div class="field">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="open-model-config-btn">⚙ 模型与密钥</button>
        <button class="btn" id="open-model-manage-btn">🗂 管理服务商</button>
      </div>
      <div class="hint" id="provider-hint" style="margin-top:6px">${currentProvider ? `当前：${esc(currentProvider.displayName)} · ${esc(c.api.model || '未选模型')} @ ${esc(currentProvider.baseURL)}${currentProvider.hasKey ? ' · 已保存密钥（不显示）' : ' · 未保存密钥'}` : '尚未选择模型'}</div>
      ${testNote}
      <div class="hint" id="model-vision-hint" style="margin-top:6px"></div>
      ${hiddenIds}
    </div>

    <h3>备用模型（主模型失败时自动换）</h3>
    <div class="hint" style="margin-bottom:6px">主模型重试后仍失败时，按顺序逐个试这些模型，直到成功。一般不填也没问题。</div>
    <div id="fallback-model-rows"></div>
    <div style="display:flex;gap:8px;margin-top:6px">
      <button class="btn btn-small" id="add-fallback-row-btn">＋ 添加备用模型</button>
    </div>
    <div class="settings-divider"></div>`;
}

/* ── 「账」这一组（渲染顺序排在最后）──
   为什么把成本核算 / 当前单价 / 批量编辑 / 前缀缓存放在一起、且排在搜索之后：
     1) 原先「当前模型单价」卡片和「批量自定义价格编辑」被「前缀缓存」隔开，
        成了**没有标题的孤儿块**（挂在"前缀缓存"名下），成本信息被切成两半；
     2) 按使用习惯：先配"机器人靠什么思考 / 靠什么查资料"（模型组 → 搜索组），
        配完才关心"花多少钱"（成本组）。价格/缓存都是低频查看项，压到最后。
   id 一个没改，saveConfig 与各处绑定照旧按 id 取值。 */
function renderModelCostSection(c) {
  return `
    <h3>成本核算</h3>

    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-useofficialprice" ${c.api.useOfficialPrice !== false ? 'checked' : ''} />
      <label for="cfg-useofficialprice">用内置官方价格表估算（按模型 id 自动匹配；走中转站请关掉）</label></div>

    <div id="price-sub" class="fold-sub${c.api.useOfficialPrice === false ? ' folded' : ''}"><div class="fold-sub-inner">
      <div class="field" style="margin-top:6px"><label>远程价格表</label>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="muted">官网统一价格表</span>
          <button class="btn btn-small" id="price-feed-refresh-btn" title="从官网拉取最新价格表">拉取价格表</button>
        </div>
        <div class="hint" id="price-feed-status" style="margin-top:4px"></div>
      </div>
    </div></div>

    <!-- 当前模型的价格卡片：切换模型时内容跟着变。
         紧跟在"价格从哪来"之后 —— 价格来源 → 这个模型多少钱 → 批量改价，读起来是一条线。 -->
    <div class="price-card" id="model-price-card">
      <div class="pc-head">
        <span class="pc-title">当前模型单价</span>
        <span class="pc-model" id="pc-model">${esc(c.api.model || '（未选择模型）')}</span>
      </div>
      <div class="pc-rows">
        <div class="pc-row"><span class="pc-label">输入</span>
          <input type="number" id="cfg-price-in" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">输出</span>
          <input type="number" id="cfg-price-out" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">缓存命中</span>
          <input type="number" id="cfg-price-cached" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
      </div>
      <div class="pc-note" id="pc-note"></div>
    </div>

    <div style="display:flex;gap:8px;margin:8px 0">
      <button class="btn btn-small" id="batch-price-btn">批量自定义价格编辑</button>
      <span class="muted" style="font-size:12px;align-self:center">为多个模型分别设定单价</span>
    </div>

    <h3>前缀缓存</h3>
    <div class="hint" style="margin-bottom:6px">
      每次新会话的第一次调用，都要为「工具 schema + 系统提示」这段固定前缀付全价
      （实测约占单次请求的 36%）。打开保活后，程序会在后台定期用这段前缀发一次极短的
      请求，让服务商把它留在缓存里，之后新会话的第一次调用即可命中。
    </div>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-cachewarm" ${c.cacheWarm?.enabled === true ? 'checked' : ''} />
      <label for="cfg-cachewarm">开启前缀缓存保活（会在后台定期联网，默认关闭）</label></div>
    <div id="cachewarm-sub" class="fold-sub${c.cacheWarm?.enabled === true ? '' : ' folded'}"><div class="fold-sub-inner">
      <div class="field" style="margin-top:6px;max-width:280px"><label>保活间隔（分钟）</label>
        <input type="number" id="cfg-cachewarm-interval" min="1" max="1440" value="${Number(c.cacheWarm?.intervalMin) || 10}" />
        <div class="hint" style="margin-top:4px">
          取值取决于服务商的缓存存活时间。间隔过长缓存已过期 = 白做；过短则多花保活请求本身的钱。
          建议从 10 分钟起，逐档放大并观察新会话第一次调用的 cached 是否仍然很高。
        </div>
      </div>
    </div></div>`;
}


function renderSearchSection(c) {
  // 每个提供方区块的初始显隐都要跟当前 provider 一致
  const prov = String(c.webSearch?.provider || 'bing');
  // 自定义搜索提供商列表（可多个），用于动态生成下拉框选项
  const customProvs = Array.isArray(c.webSearch?.providers) ? c.webSearch.providers : [];
  return `
    <h3 id="settings-search">搜索服务</h3>
    <div class="hint" style="margin-bottom:12px">
      当前提供方：${prov === 'bing' ? 'Bing 网页解析' : prov === 'deepseek' ? 'DeepSeek 原生搜索' : prov === 'zhipu' ? '智谱 Web Search' : prov === 'bocha' ? '博查 AI Search' : prov === 'baidu' ? '百度千帆 AI Search' : prov === 'metaso' ? '秘塔 AI 搜索' : '自定义'}
      ${(() => {
        // 当前提供方已保存的 Key 状态（与模型 API 页同款提示口径）
        const keyState = {
          deepseek: c.webSearch?.deepseek?.hasApiKey,
          zhipu: c.webSearch?.zhipu?.hasApiKey,
          bocha: c.webSearch?.bocha?.hasApiKey,
          baidu: c.webSearch?.baidu?.hasApiKey,
          metaso: c.webSearch?.metaso?.hasApiKey
        }[prov];
        if (prov === 'bing') return ' · 无需 API Key';
        if (prov?.startsWith('custom:')) return '';
        return keyState ? ' · 已保存 API Key（不显示）' : ' · 未保存 API Key';
      })()}
    </div>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-websearch" ${c.webSearch?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-websearch">联网搜索：启用 web_search / web_fetch 工具</label></div>
    <div id="websearch-sub" class="fold-sub${c.webSearch?.enabled === false ? ' folded' : ''}"><div class="fold-sub-inner">
    <div class="field"><label>搜索提供方</label>
      <select id="cfg-searchprovider">
        <option value="bing" ${prov === 'bing' ? 'selected' : ''}>Bing 网页解析</option>
        <option value="deepseek" ${prov === 'deepseek' ? 'selected' : ''}>DeepSeek 原生搜索</option>
        <option value="zhipu" ${prov === 'zhipu' ? 'selected' : ''}>智谱 Web Search</option>
        <option value="bocha" ${prov === 'bocha' ? 'selected' : ''}>博查 AI Search</option>
        <option value="baidu" ${prov === 'baidu' ? 'selected' : ''}>百度千帆 AI Search</option>
        <option value="metaso" ${prov === 'metaso' ? 'selected' : ''}>秘塔 AI 搜索</option>
        ${customProvs.map((p) => `<option value="custom:${esc(p.id)}" ${prov === `custom:${p.id}` ? 'selected' : ''}>${esc(p.name || p.baseUrl)}（自定义 · ${p.type === 'bing' ? '网页解析' : 'JSON 接口'}）</option>`).join('')}
      </select></div>
    <div class="field" id="custom-provider-manage" style="margin-top:14px;${prov.startsWith('custom:') ? '' : 'display:none'}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
        <button class="btn btn-small" id="test-search-provider-btn">测试这个搜索服务</button>
        <button class="btn btn-small btn-danger" id="del-search-provider-btn">删除这个搜索服务</button>
        <span id="search-provider-action-hint" class="muted" style="font-size:12px"></span>
      </div>
      <label>API Key${(() => {
        const cp = customProvs.find((p) => `custom:${p.id}` === prov);
        return cp?.hasApiKey ? '（已保存，可查看/替换/清除）' : '（未保存；多数自建服务留空即可）';
      })()}</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-custom-sp-key" value="${esc(customProvs.find((p) => `custom:${p.id}` === prov)?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-custom-sp-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-custom-sp-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
      </div>
    </div>
    <div class="field" id="bing-search-fields" style="${prov === 'bing' ? '' : 'display:none'}"><label>搜索地址（高级：可替换为兼容 Bing 结果格式的引擎）</label><input type="text" id="cfg-searchurl" value="${esc(c.webSearch?.searchUrl || 'https://cn.bing.com/search')}" /></div>
    <div class="field-row" id="deepseek-search-fields" style="${prov === 'deepseek' ? '' : 'display:none'}">
      <div class="field"><label>DeepSeek 搜索 API Key（留空用环境变量 DEEPSEEK_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-ds-searchkey" value="${esc(c.webSearch?.deepseek?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-ds-searchkey-toggle" type="button">显示</button>
          <button class="btn btn-small btn-danger" id="cfg-ds-searchkey-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
        </div></div>
      <div class="field"><label>模型</label><input type="text" id="cfg-ds-searchmodel" value="${esc(c.webSearch?.deepseek?.model || 'deepseek-chat')}" /></div>
    </div>
    <div class="field-row" id="zhipu-search-fields" style="${prov === 'zhipu' ? '' : 'display:none'}">
      <div class="field"><label>智谱 API Key（留空用环境变量 ZHIPU_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-zhipu-key" value="${esc(c.webSearch?.zhipu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-zhipu-key-toggle" type="button">显示</button>
          <button class="btn btn-small btn-danger" id="cfg-zhipu-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
        </div></div>
      <div class="field"><label>搜索引擎</label>
        <select id="cfg-zhipu-engine">
          <option value="search_std" ${c.webSearch?.zhipu?.engine === 'search_std' ? 'selected' : ''}>基础版 ¥0.01/次</option>
          <option value="search_pro" ${c.webSearch?.zhipu?.engine === 'search_pro' ? 'selected' : ''}>高级版 ¥0.03/次</option>
          <option value="search_pro_sogou" ${c.webSearch?.zhipu?.engine === 'search_pro_sogou' ? 'selected' : ''}>搜狗版 ¥0.05/次</option>
          <option value="search_pro_quark" ${c.webSearch?.zhipu?.engine === 'search_pro_quark' ? 'selected' : ''}>夸克版 ¥0.05/次</option>
        </select></div>
    </div>
    <div class="field" id="bocha-search-fields" style="${prov === 'bocha' ? '' : 'display:none'}">
      <label>博查 API Key</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-bocha-key" value="${esc(c.webSearch?.bocha?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-bocha-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-bocha-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
      </div></div>
    <div class="field" id="baidu-search-fields" style="${prov === 'baidu' ? '' : 'display:none'}">
      <label>百度千帆 API Key（留空用环境变量 BAIDU_SEARCH_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-baidu-key" value="${esc(c.webSearch?.baidu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-baidu-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-baidu-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
      </div></div>
    <div class="field" id="metaso-search-fields" style="${prov === 'metaso' ? '' : 'display:none'}">
      <label>秘塔 API Key（可选，留空用官方免费额度 / 环境变量 METASO_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-metaso-key" value="${esc(c.webSearch?.metaso?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-metaso-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-metaso-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
      </div></div>
    </div></div>

    <!-- 添加自定义搜索服务：与「模型配置」同款的"入口按钮 → 专门弹窗"形态
         （2026-09-21 用户要求：折叠的 <details> 看着不像能点）。一次性动作不铺页面；
         表单整体搬进 openAddSearchProviderModal()（08-modals.js），字段 id 原样保留
         （new-sp-* / add-search-provider-btn / add-search-provider-hint，只是挪了家），
         添加成功后弹窗自动关闭并 loadSettings() 重渲染（新服务已自动选中）。 -->
    <!-- margin-top:14px 与 R35 按钮间隔规范一致：上方自定义服务的 URL 输入框
         （#custom-provider-manage 末尾）与本按钮原来贴死，用户 R38 要求留空隙。 -->
    <div class="field" id="add-search-provider-box" style="margin-top:14px">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="open-add-search-provider-btn">⚙ 添加自定义搜索服务</button>
      </div>
      <div class="hint" style="margin-top:6px">自建 SearXNG / JSON 搜索接口 / Bing 兼容页都可接入；点按钮在弹窗里配置，添加后自动选中。</div>
    </div>

    <!-- 组边界：虚线分隔「搜索（能力）」与「成本（账）」两个大组。
         同组内的 h3 只靠自带下边框分隔，虚线留给跨组。 -->
    <div class="settings-divider"></div>
  `;
}

function renderMemorySettingsSection(c) {
  const mem = c.memory || {};
  const providers = state.providers || [];
  const useChat = mem.useChatModel !== false;
  const selP = providers.find((p) => p.id === mem.provider);
  const currentDisplay = selP ? `${selP.displayName || selP.id} · ${mem.model || '未选模型'}` : (mem.model || '未选模型');
  return `
    <h3 id="settings-memory">记忆整理</h3>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-mem-consolidate" ${mem.consolidateEnabled !== false ? 'checked' : ''} />
      <label for="cfg-mem-consolidate">启用记忆自动整理</label></div>
    <div id="mem-sub" class="fold-sub${mem.consolidateEnabled === false ? ' folded' : ''}"><div class="fold-sub-inner">
      <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-mem-usechat" ${useChat ? 'checked' : ''} />
        <label for="cfg-mem-usechat">使用与聊天机器人相同的模型</label></div>
      <!-- 反向：勾上「用主模型」就不需要选专用模型 → 折叠；取消勾选才展开 -->
      <div id="mem-model-box" class="fold-sub${useChat ? ' folded' : ''}"><div class="fold-sub-inner">
        <div class="field"><label>记忆整理模型（点击选择）</label>
          <div style="display:flex;gap:8px">
            <input type="text" id="cfg-mem-model-pick" readonly placeholder="点击选择模型" value="${esc(currentDisplay)}" style="flex:1;cursor:pointer" />
          </div>
          <div class="hint" id="mem-model-hint">${selP ? `当前：${esc(selP.displayName)} @ ${esc(selP.baseURL)}` : '尚未选择专用模型'}</div>
          <input type="hidden" id="cfg-mem-provider" value="${esc(mem.provider || '')}" />
          <input type="hidden" id="cfg-mem-model" value="${esc(mem.model || '')}" />
        </div>
      </div></div>
      <div class="field"><label>整理冷却时间（毫秒）</label><input type="number" id="cfg-mem-interval" min="1800000" step="600000" value="${esc(mem.consolidateMinIntervalMs ?? 21600000)}" /></div>
      <div class="hint">条数超过阈值且距上次整理超过该冷却时间后，才会在运行结束后后台整理。默认 6 小时（21600000 毫秒）。</div>
    </div></div>`;
}

function renderPersonaSection(c) {
  // 统一人设开关：开启（默认）= 所有用同一套全局人设（下方完整编辑器）；
  // 关闭 = 每个白名单会话一个按钮，点开模态框单独编辑（personaByChat）。
  const unified = c.personaUnified !== false;
  const perChat = c.personaByChat || {};
  const allowIds = [
    ...(c.allow?.groups || []).map((g) => `group:${g}`),
    ...(c.allow?.private || []).map((p) => `private:${p}`)
  ].map(String);
  const extraIds = Object.keys(perChat).filter((id) => !allowIds.includes(id));
  const chatIds = [...allowIds, ...extraIds];

  // 统一人设模式：只给**摘要卡 + 编辑入口**，不再把三个大文本框铺在页面上
  // （角色设定 360 + 附加规则 100 + 系统提示覆盖 120 ≈ 607px，占本页 2/3 高度；
  //  而这三样平时只看不改）。编辑走人设弹窗，弹窗自己 POST 保存。
  //  ⚠️ 字段撤出页面后，saveConfig 的 persona 分支靠 `val(sel, fallback)` 回落到
  //     当前配置值 —— 不会把弹窗刚存的值覆盖成空（已确认 val 的兜底语义）。
  //  ⚠️ 这里**不能**沿用页面上的 #cfg-roletext 等 id：会和弹窗里的 #gp-* 并存冲突。
  const PARTICIPATION_LABEL = { low: '安静型', medium: '普通群友', high: '活跃型' };
  const roleText = String(c.persona.roleText || '').trim();
  const rolePreview = roleText
    ? esc(roleText.length > 96 ? `${roleText.slice(0, 96)}…` : roleText)
    : '（未设置角色设定，机器人会用内置默认提示词）';
  // 2026-10-16：两个"覆盖全局人设"的隐形层，摘要卡必须显式报出来 ——
  // 否则用户切换全局人设后在这两种场景下看到旧行为，会以为切换坏了：
  //   ① 分会话独立人设（personaByChat）：优先级高于全局（personaForChat 逐会话
  //      合并）。统一模式下按钮网格是隐藏的，残留条目完全不可见。
  //   ② 主人专属人设（owner-identity 插件）：主人发言时优先用专属设定
  //      （orchestrator.js：`persona: ownerPersona || personaForChat(chatKey)`）。
  //      插件设置存在 config.skills 下。
  const perChatActiveCount = Object.values(perChat).filter((v) => v && (v.roleText || v.participation || v.customRules || v.systemPromptOverride)).length;
  const ownerCfg = ((c.skills || {})['owner-identity']) || {};
  const ownerPersonaOn = ownerCfg.personaEnabled === true && String(ownerCfg.personaRoleText || '').trim();
  const personaSummary = `
    <div class="persona-summary">
      <div class="ps-row"><span class="ps-label">机器人名字</span><span class="ps-value">${esc(c.persona.botName || '（未设置）')}</span></div>
      <div class="ps-row"><span class="ps-label">群内展示名</span><span class="ps-value">${c.persona.selfNickname ? esc(c.persona.selfNickname) : '<span class="ps-none">未设置（用 QQ 昵称）</span>'}</span></div>
      <div class="ps-row"><span class="ps-label">参与度</span><span class="ps-value">${PARTICIPATION_LABEL[c.persona.participation] || esc(c.persona.participation || '普通群友')}</span></div>
      <div class="ps-row ps-row-text"><span class="ps-label">角色设定</span><span class="ps-value ps-text">${rolePreview}</span></div>
    </div>
    <div class="ps-badges">
      ${c.persona.customRules ? '<span class="ps-badge">已设置管理员附加规则</span>' : ''}
      ${perChatActiveCount ? `<span class="ps-badge ps-badge-warn" title="这些会话配过独立人设（点左侧会话按钮或关闭「统一人设」可见），优先级高于全局人设 —— 全局切换对它们不生效">⚠️ ${perChatActiveCount} 个会话有独立人设（覆盖全局）</span>` : ''}
      ${ownerPersonaOn ? '<span class="ps-badge ps-badge-warn" title="主人识别插件已启用主人专属人设：主人发言时优先使用专属角色设定，全局切换对主人不生效">⚠️ 主人专属人设生效中（覆盖全局）</span>' : ''}
      <!-- ⚠️ 覆盖系统提示词是危险设置（会让内置安全规则/工具协议失效），
           摘要卡上必须显式提示，不能让它静静藏在弹窗里被忘记 -->
      ${c.persona.systemPromptOverride ? '<span class="ps-badge ps-badge-warn">⚠️ 已覆盖系统提示词</span>' : ''}
      ${(!roleText && !c.persona.customRules && !c.persona.systemPromptOverride) ? '<span class="ps-badge ps-badge-none">尚未配置角色设定</span>' : ''}
    </div>
    <div class="field" style="margin-top:12px">
      <button class="btn" id="open-persona-editor-btn">⚙ 编辑人设</button>
      <span class="hint" style="margin-left:10px">名字 / 展示名 / 参与度 / 角色设定 / 附加规则 / 系统提示词覆盖都在这里改</span>
    </div>`;

  // 页面只放摘要卡：选择人设 / 添加人设 / 删除自定义人设 也一并收进弹窗
  // （页面上那套 `#cfg-persona-pick` 控件的存在意义就是"把模板填进下面的角色设定框"，
  //  框都搬进弹窗了，留在页面上就成了点不动的空控件）。
  const unifiedEditor = personaSummary;

  // 分会话模式：按钮网格（白名单 ∪ 已配置过的会话）
  const chatButtons = chatIds.map((chatKey) => {
    const conf = perChat[chatKey] || {};
    const hasCustom = Boolean(conf.roleText || conf.participation || conf.customRules || conf.systemPromptOverride);
    const title = formatChatTitle(chatKey, extraIds.includes(chatKey) ? '' : chatNameOf(chatKey));
    return `
      <button class="btn persona-chat-btn ${hasCustom ? 'has-custom' : ''}" data-chat="${esc(chatKey)}" title="${esc(title)}的人设">
        ${esc(title)}${hasCustom ? ' ●' : ''}
      </button>`;
  }).join('');

  return `
    <h3>人设</h3>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-persona-unified" ${unified ? 'checked' : ''} />
      <label for="cfg-persona-unified">为所有的群聊/私聊使用同一个人设</label></div>
    <div class="hint" style="margin-bottom:12px">${unified
      ? '所有会话共用下方这一套人设。'
      : '每个会话独立人设：点按对应按钮弹窗编辑（● = 已配置独立人设；未配置的跟随全局人设的字段）。机器人名字/群内展示名是账号身份，只能全局设置。'}</div>
    <div id="persona-unified-box" style="${unified ? '' : 'display:none'}">
      ${unifiedEditor}
    </div>
    <div id="persona-perchat-box" style="${unified ? 'display:none' : ''}">
      <div class="field" style="margin-bottom:10px">
        <button class="btn" id="open-global-persona-btn">⚙ 全局人设设置（未单独配置的会话用这套）</button>
      </div>
      <div class="persona-chat-grid">${chatButtons || '<div class="hint">（白名单为空——先在「聊天白名单」里添加群聊/私聊）</div>'}</div>
    </div>

    <!-- 组边界：人设（机器人是谁）↔ 记忆整理（机器人怎么记事）用虚线分开 -->
    <div class="settings-divider"></div>`;
}

/**
 * 「全局人设设置」模态框（2026-09-18）：统一人设关闭（分群模式）时，
 * persona 主编辑器不在场 —— 没有独立人设的会话跟随的全局字段就没了编辑入口。
 * 这里弹出同款字段（选择人设 / 参与度 / 角色设定 / 附加规则 / 系统提示覆盖 /
 * 机器人名字 / 群内展示名），保存直接 POST /api/config 的 persona 补丁。
 */

/**
 * 人设编辑弹窗（统一/分群两种模式共用同一个弹窗）。
 *   统一人设模式：它就是"人设设置"本体 —— 页面上只留摘要卡 + 入口按钮（原来三个大
 *   文本框铺在页面上占 607px，是该页 2/3 高度）。
 *   分群模式：它管"未单独配置的会话所跟随的全局字段"。
 * ⚠️ 字段用 `#gp-*` 前缀，**故意不与页面的 `#cfg-*` 重名** —— 同名 id 会让
 *    `$('#id')` 抓到先出现的那个，自动保存链从此读错元素。保存走自己的 POST。
 */
function openGlobalPersonaModal() {
  const c = state.config || {};
  const per = c.persona || {};
  const unified = c.personaUnified !== false;
  // 2026-10-16：主人专属人设（owner-identity 插件）在运行时的优先级
  // **高于**全局人设（orchestrator.js：`persona: ownerPersona || personaForChat`）。
  // 启用时主人自己测试切换效果会"看起来不生效"。插件设置存在 config.skills 下，
  // 读出来给显式提示，别让用户以为切换坏了去反复重试。
  const ownerCfg = ((c.skills || {})['owner-identity']) || {};
  const ownerPersonaOn = ownerCfg.personaEnabled === true && String(ownerCfg.personaRoleText || '').trim();
  const overlay = modelModalShell({
    head: unified ? '人设设置' : '全局人设设置',
    // 编辑型弹窗：点外部不关闭（误触丢内容太伤体验，2026-10-18）；×/取消/Esc 照常
    closeOnBackdrop: false,
    body: `
      <div class="field" style="margin-bottom:8px">
        <label>选择人设</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="gp-pick" readonly placeholder="点击选择人设" value="${esc(Object.values(state.personaTemplates || {}).find((p) => String(p.text ?? '').trim() === String(per.roleText ?? '').trim())?.name || '')}" style="flex:1;cursor:pointer" />
          <button class="btn btn-small" id="gp-new-btn">＋ 添加人设</button>
          <!-- 删除自定义人设：原来只在页面上的选择器旁边，选择器收进弹窗后必须跟过来，
               否则「删除自定义人设」这个功能就彻底没有入口了 -->
          <button class="btn btn-small btn-danger hidden" id="gp-del-btn">删除当前自定义人设</button>
        </div>
        <span class="hint" id="gp-hint"></span>
      </div>
      <div class="field-row">
        <div class="field"><label>机器人名字</label><input type="text" id="gp-botname" value="${esc(per.botName || '')}" /></div>
        <div class="field"><label>群内展示名（可选）</label><input type="text" id="gp-selfnick" value="${esc(per.selfNickname || '')}" /></div>
        <div class="field"><label>参与度</label>
          <select id="gp-participation">
            <option value="low" ${per.participation === 'low' ? 'selected' : ''}>安静型</option>
            <option value="medium" ${per.participation === 'medium' ? 'selected' : ''}>普通群友</option>
            <option value="high" ${per.participation === 'high' ? 'selected' : ''}>活跃型</option>
          </select></div>
      </div>
      <div class="field"><label>角色设定</label>
        <textarea id="gp-roletext" class="persona-role-text" style="min-height:180px" placeholder="例如：你是运维群里的老油条……">${esc(per.roleText || '')}</textarea></div>
      ${ownerPersonaOn ? `<div class="hint" style="color:var(--orange);margin-bottom:8px">⚠️ 已启用「主人专属人设」（主人识别插件）：<b>主人发言时优先使用其专属角色设定，这里的全局人设对主人不生效</b>。想统一用这套人设，去「下载 → 已安装 → 插件」找到「主人识别」，关掉「启用主人专属人设」。</div>` : ''}
      <div class="field"><label>管理员附加规则（可选，追加到系统提示）</label>
        <textarea id="gp-customrules" class="persona-role-text" style="min-height:80px">${esc(per.customRules || '')}</textarea></div>
      <div class="field"><label>系统提示词覆盖（高级 · 可选）</label>
        <textarea id="gp-sysprompt" class="persona-role-text" style="min-height:80px" placeholder="留空 = 使用内置默认系统提示词">${esc(per.systemPromptOverride || '')}</textarea></div>
      <div class="hint" style="margin-top:6px">${unified
        ? '所有群聊/私聊共用这一套人设。'
        : '未配置独立人设的群聊/私聊全部使用这套全局字段。'} <b>改动要点下方「保存」才会生效</b>（设置页里其它项是自动保存，这个弹窗不是 —— 因为人设是一大段文本，边打边存会把半句话写进去）；直接关闭（Esc/×/点外部）时会提示丢弃未保存的修改。</div>`,
    foot: `<button class="btn" id="gp-cancel">取消</button>
           <button class="btn btn-primary" id="gp-save">保存</button>`
  });

  // ── 未保存改动守卫（2026-10-17）：与分群独立人设弹窗同一套做法。
  // Esc/点遮罩/× 会先弹确认（守卫实现在 08-modals.js modelModalShell），
  // 不再把写了一半的「管理员附加规则/角色设定」静默丢掉。取消/保存按钮不拦。
  const gpSnap = () => JSON.stringify([
    overlay.querySelector('#gp-botname').value,
    overlay.querySelector('#gp-selfnick').value,
    overlay.querySelector('#gp-participation').value,
    overlay.querySelector('#gp-roletext').value,
    overlay.querySelector('#gp-customrules').value,
    overlay.querySelector('#gp-sysprompt').value
  ]);
  const gpInit = gpSnap();
  overlay.__dirtyGuard = () => gpSnap() !== gpInit;

  // 关闭本弹窗（保存 / 取消 / × / Esc / 点遮罩 —— 全部走 closeModelModal 的
  // qa-close）时通知引导：人设是**可选**步骤，"处理过"就该回引导接着走。
  // 只认状态变化不行 —— 用户选回原版默认人设保存时 roleText 与模板一致，
  // 状态没变，引导的守候永远等不到（2026-10-18 用户反馈）。
  overlay.addEventListener('qa-close', () => {
    if (typeof window.qaOnboardingStepTouched === 'function') window.qaOnboardingStepTouched('persona');
  });

  // 选择人设 / 添加人设：都复用共享弹窗，但**填回本弹窗的 gp-* 字段**
  // （不传 target 的话会填到设置页的 cfg-* 里，而这个弹窗里根本看不到效果）
  // focusSel：子弹窗（选择人设）关闭后焦点要交还的本弹窗可编辑目标 —— 否则焦点
  // 回到 readonly 的 #gp-pick 上，之后 Ctrl+V 静默失效（2026-10-18 修粘贴问题）。
  const gpTarget = { roleSel: '#gp-roletext', rulesSel: '#gp-customrules', pickSel: '#gp-pick', hintSel: '#gp-hint', focusSel: '#gp-roletext' };
  const gpHint = overlay.querySelector('#gp-hint');
  const gpRole = overlay.querySelector('#gp-roletext');
  const gpRules = overlay.querySelector('#gp-customrules');
  overlay.querySelector('#gp-pick').addEventListener('click', () => openPersonaPicker(gpTarget));
  overlay.querySelector('#gp-new-btn').addEventListener('click', () => openPersonaCreateModal(gpTarget));

  // 删除自定义人设：当前角色设定命中某个 custom_ 模板时才可删（内置人设不给删）。
  // 靠 roleEl 的 input 事件同步显隐 —— openPersonaPicker 改完值会派发一次，
  // 所以从选择器里挑一个自定义人设后按钮会自己出现。
  const gpDel = overlay.querySelector('#gp-del-btn');
  const syncGpDel = () => {
    const hit = Object.entries(state.personaTemplates || {}).find(([, p]) => String(p?.text ?? '').trim() === String(gpRole.value ?? '').trim());
    const id = hit ? hit[0] : '';
    gpDel.classList.toggle('hidden', !id.startsWith('custom_'));
    gpDel.dataset.personaId = id;
  };
  syncGpDel();
  gpRole.addEventListener('input', syncGpDel);
  gpDel.addEventListener('click', async () => {
    const id = gpDel.dataset.personaId || '';
    const tpl = state.personaTemplates[id];
    if (!id.startsWith('custom_') || !tpl) return;
    // ⚠️（2026-10-10 r86 修 P2）破坏性 → danger:true
    if (!await qaConfirm({
      danger: true,
      confirmText: '删除人设',
      message: `确定删除自定义人设「${tpl.name}」？`
    })) return;
    try {
      await api(`/api/persona-templates/${id}`, { method: 'DELETE', body: '{}' });
      // 删掉后角色设定回落到内置默认（与页面版行为一致）。
      // 只改弹窗内的字段，真正落盘靠「保存」—— 弹窗是"改完再存"的模型，
      // 混进页面的自动保存链反而会被 loadSettings 重渲染吹掉。
      const fallback = state.personaTemplates.xiaojingyu;
      gpRole.value = fallback?.text || '';
      gpRules.value = '';
      overlay.querySelector('#gp-pick').value = fallback?.name || '';
      await loadSettings();            // 刷新模板列表（人设选择器读的就是它）
      syncGpDel();
      gpHint.textContent = `人设「${tpl.name}」已删除，角色设定回落到内置默认；点「保存」生效。`;
    } catch (e) {
      gpHint.textContent = `删除失败：${e.message}`;
    }
  });

  overlay.querySelector('#gp-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#gp-save').addEventListener('click', async () => {
    const patch = {
      persona: {
        ...(c.persona || {}),
        botName: overlay.querySelector('#gp-botname').value.trim() || '小鲸鱼',
        selfNickname: overlay.querySelector('#gp-selfnick').value.trim(),
        participation: overlay.querySelector('#gp-participation').value,
        roleText: overlay.querySelector('#gp-roletext').value.trim(),
        customRules: overlay.querySelector('#gp-customrules').value.trim(),
        systemPromptOverride: overlay.querySelector('#gp-sysprompt').value.trim()
      }
    };
    try {
      const r = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
      // ⚠️ 2026-10-16 修「切换人设不成功」：POST 响应里带着最新 config，
      // **必须立即回写 state.config**。旧实现只调 loadSettings()（7 个接口
      // 的 Promise.all，含联网价格表，慢到几百 ms~数秒），这段窗口内
      // state.config 仍是旧人设 —— 期间任何一次自动保存（切页签 flush /
      // 关窗 beforeunload / 防抖）都会把旧 persona 整段回传、把刚切的
      // 人设深合并还原（saveConfig 的分支已改为不写不存在的字段，
      // 这里是双保险：把窗口压到零）。
      if (r?.config) state.config = r.config;
      closeModelModal(overlay);
      loadSettings();
    } catch (e) {
      qaAlert(`保存人设失败：${e.message}`);
    }
  });
}

/**
 * 分会话人设编辑模态框：与统一编辑器同款字段（人设选择/添加/机器人名字沿用全局说明/参与度/
 * 角色设定/附加规则/系统提示词覆盖）。保存按钮直接 POST /api/config 落盘
 * （personaByChat 整体 __replace__），不经过表单自动保存链。
 */
function openPerChatPersonaModal(chatKey) {
  const conf = (state.config?.personaByChat || {})[chatKey] || {};
  const chatName = formatChatTitle(chatKey, chatNameOf(chatKey));
  const overlay = modelModalShell({
    head: `${chatName} 的独立人设`,
    // 同 openGlobalPersonaModal：编辑型弹窗点外部不关闭
    closeOnBackdrop: false,
    body: `
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input type="text" id="pcp-pick" readonly placeholder="点击选择人设" value="${esc(conf.roleText ? (Object.values(state.personaTemplates || {}).find((p) => String(p.text ?? '').trim() === String(conf.roleText ?? '').trim())?.name || '自定义') : '')}" style="flex:1;cursor:pointer" />
        <button class="btn btn-small" id="pcp-new-btn">＋ 添加人设</button>
      </div>
      <span class="hint" id="pcp-hint" style="display:block;margin-bottom:8px"></span>
      <div class="field"><label>参与度（留空跟随全局）</label>
        <select id="pcp-participation">
          <option value="" ${!conf.participation ? 'selected' : ''}>跟随全局</option>
          <option value="low" ${conf.participation === 'low' ? 'selected' : ''}>安静型</option>
          <option value="medium" ${conf.participation === 'medium' ? 'selected' : ''}>普通群友</option>
          <option value="high" ${conf.participation === 'high' ? 'selected' : ''}>活跃型</option>
        </select></div>
      <div class="field"><label>角色设定（留空跟随全局）</label>
        <textarea id="pcp-roletext" class="persona-role-text" style="min-height:180px" placeholder="留空 = 用全局人设的角色设定">${esc(conf.roleText || '')}</textarea></div>
      <div class="field"><label>管理员附加规则（可选）</label>
        <textarea id="pcp-customrules" style="min-height:80px" placeholder="可选：追加到系统提示的规则（留空 = 用全局）">${esc(conf.customRules || '')}</textarea></div>
      <div class="field"><label>系统提示词覆盖（高级 · 可选）</label>
        <textarea id="pcp-sysprompt" style="min-height:80px" placeholder="可选：整体替换系统提示（留空 = 用全局）">${esc(conf.systemPromptOverride || '')}</textarea></div>
      <div class="hint" style="margin-top:6px">机器人名字/群内展示名不按会话变化（账号身份，改了会与 @ 判定对不上），在统一人设里设置。<b>改动要点下方「保存」才会生效</b>（这个弹窗不会自动保存）；直接关闭（Esc/×/点外部）时会提示丢弃未保存的修改。</div>`,
    foot: `<button class="btn" id="pcp-clear">清空独立人设</button>
           <button class="btn" id="pcp-cancel">取消</button>
           <button class="btn btn-primary" id="pcp-save">保存</button>`
  });

  // ── 未保存改动守卫（2026-10-17）──
  // 群友反馈"管理员附加规则没法自动保存"：本弹窗是"改完点保存"模型（不走表单
  // 自动保存链，原因见下方 saveToMap 注释），保存按钮本身没问题，坑在 Esc/点遮罩/×
  // 三条被动关闭路径会静默丢弃刚写的规则。现在这三条路径会先弹确认（守卫实现在
  // 08-modals.js modelModalShell 的 requestClose）。取消/保存按钮是明确意图，不拦。
  const pcpSnap = () => JSON.stringify([
    overlay.querySelector('#pcp-roletext').value,
    overlay.querySelector('#pcp-participation').value,
    overlay.querySelector('#pcp-customrules').value,
    overlay.querySelector('#pcp-sysprompt').value
  ]);
  const pcpInit = pcpSnap();
  overlay.__dirtyGuard = () => pcpSnap() !== pcpInit;

  // 选择人设 / 添加人设：统一走共享弹窗，**填回本弹窗的 pcp-* 字段**。
  // 原来这里自己抄了一份选择器、并且「添加人设」调用的是不带 target 的
  // openPersonaCreateModal() —— 那会把新模板填进设置页的 #cfg-roletext，
  // 而分群模式下页面根本没有那个框（弹窗里看不到任何反应）。
  // focusSel 同 openGlobalPersonaModal：子弹窗关闭后焦点交还 #pcp-roletext，
  // 不停在 readonly 的 #pcp-pick 上（2026-10-18 修粘贴问题）。
  const pcpTarget = { roleSel: '#pcp-roletext', rulesSel: '#pcp-customrules', pickSel: '#pcp-pick', hintSel: '#pcp-hint', focusSel: '#pcp-roletext' };
  overlay.querySelector('#pcp-pick').addEventListener('click', () => openPersonaPicker(pcpTarget));
  overlay.querySelector('#pcp-new-btn').addEventListener('click', () => openPersonaCreateModal(pcpTarget));

  // 直接 POST 落盘：不走"写隐藏 JSON + 等表单链保存"的老路。
  // 老路的两个坑（2026-09-17 用户实测）：
  //   1. modal 挂在 body 下、不在 #settings-form 内，dispatchEvent(change) 冒泡
  //      到不了 form 的委托监听 —— 从来没触发过自动保存；
  //   2. 就算触发了，随后的 loadSettings() 重建表单 DOM，隐藏 input 被重渲染成
  //      GET 回来的旧值，用户刚写的条目被无声丢弃 → 重开 modal 一片空白。
  const saveToMap = async (entry) => {
    const current = state.config?.personaByChat || {};
    const next = { ...current };
    if (entry) next[chatKey] = entry; else delete next[chatKey];
    try {
      const r = await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ personaByChat: { __replace__: next } })
      });
      if (r?.config) state.config = r.config;
    } catch (e) {
      qaAlert(`保存独立人设失败：${e?.message || e}`);
      throw e;
    }
  };

  overlay.querySelector('#pcp-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#pcp-clear').addEventListener('click', async () => {
    try { await saveToMap(null); } catch { return; }
    closeModelModal(overlay);
    renderSettings();   // 只刷人设区块（按钮上的 ● 标记），不整页重拉 7 个接口
  });
  overlay.querySelector('#pcp-save').addEventListener('click', async () => {
    const roleText = overlay.querySelector('#pcp-roletext').value.trim();
    const participation = overlay.querySelector('#pcp-participation').value;
    const customRules = overlay.querySelector('#pcp-customrules').value.trim();
    const sysPrompt = overlay.querySelector('#pcp-sysprompt').value.trim();
    if (!roleText && !participation && !customRules && !sysPrompt) {
      try { await saveToMap(null); } catch { return; }   // 全空 = 清除独立人设
    } else {
      const entry = {};
      if (roleText) entry.roleText = roleText;
      if (participation) entry.participation = participation;
      if (customRules) entry.customRules = customRules;
      if (sysPrompt) entry.systemPromptOverride = sysPrompt;
      try { await saveToMap(entry); } catch { return; }
    }
    closeModelModal(overlay);
    renderSettings();
  });
}

/* 白名单条目归一化（r64）：后端权威格式是**裸号**（src/store.js 的 allowed() 与
   src/routes.js 直接 `includes(String(id))`，设置页表单、跨会话发送工具同样按裸号比对）。
   历史脏数据里可能残留 `group:xxx` / `private:xxx` 前缀（r60 之前 setAllowState 的写入
   bug 遗留）。渲染与解析都必须剥掉前缀，否则会出现「输入框显示 group:xxx」以及
   更隐蔽的「选择群弹窗里已加白名单的群勾不上、点确定把老项丢掉」。 */
function bareAllowId(entry) {
  const m = /^(?:group|private):(.+)$/.exec(String(entry ?? ''));
  return m ? m[1] : String(entry ?? '');
}

function renderAllowSection(c) {
  return `
    <h3 id="settings-allow">谁能找它（白名单）</h3>
    <div class="hint" style="margin-bottom:10px">白名单为空时机器人不会在任何群聊/私聊内运行。</div>
    <div class="field"><label>从 QQ 账号直接勾选</label>
      <div style="display:flex;gap:8px">
        <button class="btn btn-small" id="pick-groups-btn">选择群</button>
        <button class="btn btn-small" id="pick-friends-btn">选择好友</button>
        <span id="pick-result" class="muted" style="align-self:center"></span>
      </div></div>
    <div class="field-row">
      <div class="field"><label>允许的群号（逗号分隔）</label><input type="text" id="cfg-allowgroups" value="${esc((c.allow.groups || []).map(bareAllowId).join(','))}" />
        <div class="hint" style="margin-top:4px">不知道群号？用上面的「选择群」按钮直接勾，不用手抄。</div></div>
      <div class="field"><label>允许的 QQ（逗号分隔）</label><input type="text" id="cfg-allowprivate" value="${esc((c.allow.private || []).map(bareAllowId).join(','))}" />
        <div class="hint" style="margin-top:4px">好友的 QQ 号；也可以用「选择好友」按钮勾。</div></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-allowallwhenempty" ${c.allowAllWhenEmpty === true ? 'checked' : ''} />
      <label for="cfg-allowallwhenempty">白名单留空时允许所有会话</label></div>
    <div class="hint">说明：勾选后，若上方两个列表都为空，机器人会在<b>所有</b>群聊和私聊中运行；只要填了任意一项，就只按名单过滤。</div>
    <div class="hint" style="margin-top:8px">按会话的独立人设在「人设」页签配置（关闭"统一人设"后出现）。</div>

    <!-- 屏蔽名单紧跟白名单（2026-09-21 重排）：两者是"让谁参与"的一体两面
         （准入 ↔ 拒绝），openBlocklistModal 的提示语本身就是"先去「白名单」页签
         添加群聊，再来屏蔽群员"。原先它排在 运行节奏 / 主动开话题 / 表情包 之后，
         被三个功能块隔开，读起来像两件不相干的事。 -->
    <h3>屏蔽名单</h3>
    <div class="field">
      <button class="btn btn-small" id="blocklist-btn">管理屏蔽名单</button>
      <div class="hint" style="margin-top:6px">全局名单保存在 QQ Agent 云端，所有安装实例共享；云端暂时不可用时使用本地缓存。群级名单仍只对当前实例生效。</div>
    </div>

    <!-- 组边界：虚线分隔「管谁（准入）」与「怎么说话（行为）」两个大组 -->
    <div class="settings-divider"></div>`;
}

// 读取历史档位：名称与说明（档位制，累积生效）
/** 把输入钳制到 [min,max]，非法值退回 fallback。 */
/**
 * 取会话的群名（群聊才有）。
 * 群名由后端 /api/chats 附带（走 OneBot get_group_info，带缓存与超时保护），
 * 拿不到就返回空串 —— 调用方会自动退回只显示群号。
 */
function chatNameOf(chatKey) {
  const c = (state.chats || []).find((x) => x.key === chatKey);
  return String(c?.chatName || '').trim();
}

/**
 * 会话标题：群名（群号） / 群 群号 / 私聊 号
 * 拿到群名时显示"群名（群号）"，既好认又能确认身份；拿不到就退回原来的"群 群号"。
 */
function formatChatTitle(chatKey, name = '') {
  const m = /^group:(\d+)$/.exec(String(chatKey || ''));
  if (m) return name ? `${name}（${m[1]}）` : `群 ${m[1]}`;
  const p = /^private:(\d+)$/.exec(String(chatKey || ''));
  if (p) return name ? `${name}（${p[1]}）` : `私聊 ${p[1]}`;
  return String(chatKey || '');
}

// clampInt 用 00-core.js 里的共享版本（两边实现原本完全相同，重复声明属于隐患：
// 顶层 function 声明后者静默覆盖前者，哪天有人只改一处就会出现难以排查的不一致）。

/*
 * 滑条换算（前端显示用）。
 *
 * 换算逻辑来自 /vendor/tier-slider.js（与 src/tier-slider.js 同一份镜像）。
 * 后端保存配置时会用它**重新权威换算**档位与概率，前端这里只负责界面即时反馈。
 * 下面的 sliderToTierUI / sliderToTierUI_tierToSlider 是对共享函数的薄封装，
 * 保持既有调用点签名不变。
 */
function sliderToTierUI(pos) {
  return sliderToTier(pos);
}

/** 已保存配置 → 滑条位置（优先用存下来的位置，老配置没有就从 tier/概率反推）。 */
function sliderToTierUI_tierToSlider(st) {
  const saved = Number(st?.contextSliderPos);
  if (Number.isFinite(saved)) return Math.min(100, Math.max(0, saved));
  return tierToSlider(st?.contextTier, st?.randomPercent);
}

/** 滑条位置 → 一句话说明（给用户的即时反馈）。 */
function sliderDesc(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  if (tier === 1) return '<b>积极度 1/4 · 只在被 @ 时回</b>：其余消息只标记已读、不请模型出手（最省 token）';
  if (tier === 2) return '<b>积极度 2/4 · @ 或关键词才回</b>：被 @ 或命中关键词时响应';
  // 3 档概率展示必须与后端判定同源：resolveContextTier 用 Math.random()*100 与
  // randomPercent 比较（即"骰子值 < 阈值"），滑条换算出的 randomPercent 就是这个阈值。
  // 之前这里展示的是 sliderToTier 的 randomPercent 四舍五入值，而后端在保存时会
  // 重新权威换算一次 —— 两边都来自同一公式，但旧版 desc 里取整方式不同导致偶发不一致，
  // 现在统一保留一位小数（与 sliderToTier 一致）。
  if (tier === 3) return `<b>积极度 3/4 · 偶尔主动接话</b>：被 @ / 关键词必响应；此外每批普通消息有 <b>${randomPercent}%</b> 概率响应`;
  return '<b>积极度 4/4 · 每条都回</b>：任何消息都响应，且艾特/关键词/随机的判定全部失效';
}

const TIER_NAME = { 1: '只在被 @ 时回', 2: '@ 或关键词', 3: '偶尔接话', 4: '每条都回' };

/** 滑条位置 → 纯文本档位名（无 HTML 标签，供双点滑条说明文字使用）。 */
function sliderDescText(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  if (tier === 3) return `积极度 3/4 · 约 ${randomPercent}%`;
  return `积极度 ${tier}/4 · ${TIER_NAME[tier]}`;
}
const TIER_HINT = {
  1: '只有被 @ 时才响应，其余消息标记已读、不调模型（最省 token）',
  2: '在 1 档基础上，命中关键词也响应',
  3: '在 2 档基础上，再按概率随机响应一些消息',
  4: '任何消息都响应（改造前的行为，最费 token）'
};

function renderChatSection(c) {
  const st = c.store || {};
  // 响应档位/峰谷/指令禁言已移入「活跃设置」模态框（openActiveConfigModal），
  // 本区块只剩 主动话题 一个短块 + 两个收纳入口按钮。
  // （屏蔽名单 2026-09-21 已上移到 renderAllowSection，跟白名单作伴）
return `
    <h3>回复节奏</h3>
    <div class="field" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      <button class="btn" id="open-send-config-btn">📨 发送与限速</button>
      <button class="btn" id="open-active-config-btn">⚡ 回复积极度</button>
    </div>
    <div class="hint" style="margin-bottom:12px">「回复积极度」决定它什么时候接话（只在被 @ 时回 / 偶尔接话 / 每条都回），也能按时间段切换；「发送与限速」是更底层的发送间隔与保护，不确定就别动。</div>

    <h3>主动开话题</h3>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-proactive" ${c.proactive.enabled ? 'checked' : ''} />
      <label for="cfg-proactive">冷场时按概率主动开话题</label></div>
    <div id="proactive-sub" class="fold-sub${c.proactive.enabled ? '' : ' folded'}"><div class="fold-sub-inner">
      <div class="field-row">
        <div class="field"><label>检查间隔下限（毫秒）</label><input type="number" id="cfg-pro-min" min="60000" value="${esc(c.proactive.checkIntervalMinMs)}" /></div>
        <div class="field"><label>检查间隔上限（毫秒）</label><input type="number" id="cfg-pro-max" min="120000" value="${esc(c.proactive.checkIntervalMaxMs)}" /></div>
        <div class="field"><label>触发概率 0~1</label><input type="number" id="cfg-pro-prob" step="0.05" min="0" max="1" value="${esc(c.proactive.probability)}" /></div>
      </div>
    </div></div>`;
}

function renderDesktopSection(c) {
  return `
    <!-- 2026-09-21 重排：界面 提到桌面端之前（按使用频率 —— 主题是这页最常改的，
         自启/托盘装完设一次基本不动）；页签名同步改成「界面与应用」。
         分组：界面 + 桌面端 = "软件长什么样、怎么表现"；数据管理 + 版本更新 = "维护"，
         两组之间用虚线分开（同组内只用 h3 自带下边框）。 -->
    <h3>界面</h3>
    <div class="field"><label>主题</label>
      <div class="theme-picker" id="theme-picker">
        ${['dark', 'light', 'system', '?'].map((t) => `
          <div class="theme-option${getThemePref() === t ? ' on' : ''}" data-theme-opt="${t}" role="button" tabindex="0">
            <span class="t-ico">${THEME_ICON[t]}</span>
            <span>${THEME_LABEL[t]}</span>
          </div>`).join('')}
      </div>
    </div>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-showvision" ${c.ui?.showVision !== false ? 'checked' : ''} />
      <label for="cfg-showvision">模型目录显示“支持图片输入/不支持图片输入”徽标</label></div>
    <!-- 预览演示模式：原先在顶栏的 #preview-btn 已删，入口收进这里（滑动开关）。
         它不是配置项（不写 config），只切换 URL 的 #preview 哈希后重载整个界面。 -->
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-previewmode" ${state.preview ? 'checked' : ''} />
      <label for="cfg-previewmode">预览演示模式（用模拟数据展示消息与用量页，不影响真实机器人）</label></div>
    <div class="field"><label>界面刷新间隔（毫秒）</label><input type="number" id="cfg-refreshms" min="1000" step="1000" value="${esc(c.ui?.refreshMs ?? 15000)}" /></div>

    <!-- 外观个性化（R40）：颜色 / 底色 / 不透明度 / 背景图。
         同在「界面」组里（都是"软件长什么样"），所以只用 h3 自带下边框、不加虚线。 -->
    <h3>外观个性化</h3>
    <div class="field"><label>强调色（按钮、链接、选中态的那一抹颜色）</label>
      <div class="swatch-row" id="accent-swatches">
        ${ACCENT_PRESETS.map(([hex, name]) => `
          <span class="swatch${String(c.ui?.accent || '').toLowerCase() === hex ? ' on' : ''}"
                data-accent="${hex}" title="${esc(name)} ${hex}" role="button" tabindex="0"
                style="--sw:${hex}"></span>`).join('')}
        <span class="swatch swatch-reset${c.ui?.accent ? '' : ' on'}" data-accent="" title="跟随主题（默认）" role="button" tabindex="0">跟随主题</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <input type="color" id="cfg-accent" value="${esc(isHexColor(c.ui?.accent) ? c.ui.accent : (c.ui?.accent ? '#5b8cff' : '#5b8cff'))}" style="width:44px;height:28px;padding:0" />
        <input type="text" id="cfg-accent-hex" value="${esc(c.ui?.accent || '')}" placeholder="#5b8cff（留空=跟随主题）" style="width:180px" />
      </div>
    </div>
    <div class="field"><label>界面底色（窗口最底层的颜色）</label>
      <div class="swatch-row" id="bg-swatches">
        ${BG_PRESETS.map(([hex, name]) => `
          <span class="swatch${String(c.ui?.bgColor || '').toLowerCase() === hex ? ' on' : ''}"
                data-bg="${hex}" title="${esc(name)} ${hex}" role="button" tabindex="0"
                style="--sw:${hex}"></span>`).join('')}
        <span class="swatch swatch-reset${c.ui?.bgColor ? '' : ' on'}" data-bg="" title="跟随主题（默认）" role="button" tabindex="0">跟随主题</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <input type="color" id="cfg-bgcolor" value="${esc(isHexColor(c.ui?.bgColor) ? c.ui.bgColor : '#0e1013')}" style="width:44px;height:28px;padding:0" />
        <input type="text" id="cfg-bgcolor-hex" value="${esc(c.ui?.bgColor || '')}" placeholder="#0e1013（留空=跟随主题）" style="width:180px" />
      </div>
    </div>
    <div class="field"><label>底色不透明度：<b id="framealpha-val">${clampInt(c.ui?.frameAlpha, 30, 100, 100)}</b>%</label>
      <input type="range" id="cfg-framealpha" min="30" max="100" step="1" value="${clampInt(c.ui?.frameAlpha, 30, 100, 100)}" style="width:260px" />
      <div class="hint">调低后窗口底色变半透明：设了背景图就能透出图片。⚠️ 没有背景图时<b>不会</b>透出桌面 —— 主窗口按不透明窗口建（为了避开"透明窗口只显示第一帧就冻结"那条已知问题，见 electron/main.js 的 R46 记录），桌面透不上来。想看到桌面请用下面的「整窗不透明度」。</div>
    </div>
    <div class="field"><label>整窗不透明度：<b id="winopacity-val">${clampInt(c.ui?.winOpacity, 30, 100, 100)}</b>%</label>
      <input type="range" id="cfg-winopacity" min="30" max="100" step="1" value="${clampInt(c.ui?.winOpacity, 30, 100, 100)}" style="width:260px" />
      <div class="hint">整个窗口（含文字）一起变淡，适合长期挂在一边偷看群消息。仅桌面端生效。</div>
    </div>
    <div class="field">
      <button class="btn btn-small" id="cfg-uicustom-reset" type="button">↺ 外观恢复默认</button>
      <span class="hint" id="cfg-uicustom-hint" style="margin-left:8px"></span>
      <div class="hint">只重置本节的颜色与透明度（强调色 / 界面底色 / 底色不透明度 / 整窗不透明度），不动下面的「界面背景」。</div>
    </div>

    <!-- ── 界面背景（2026-10-23 晚合入）────────────────────────────────────
         原来「本地背景图」在「外观个性化」里、小红车壁纸是独立一级页，两处分开导致
         一个必然踩的坑：两层背景其实是**互斥**的，而 WE 壁纸优先 ——
         style.css:493 有一条 html[data-wp='on'] #app-bg { display: none }，
         壁纸一启用，本地图被整层隐藏。用户在设置里选完图看不到任何变化，只会以为按钮坏了。
         所以这里把两种来源摆到同一屏，并明确标出「当前生效的是哪一层」。

         两层的存储与渲染链路完全不同，不要混：
           ① 本地图片  config.ui.bgImage（图片由主进程复制进数据目录）→ #app-bg 的 background-image
           ② WE 壁纸   localStorage['wp-console-bg']（{id,title,blur,dim,monet,fit}）
                        → html[data-wp='on'] + #wp-bg-video / #wp-bg-img（真媒体层）
         状态行由 07-settings-events.js 的 refreshBgStatus() 刷新，这里只给首帧内容。 -->
    <h3 id="settings-bg">界面背景</h3>
    <div class="field">
      <div class="hint" id="cfg-bgstatus" style="font-size:12px">${(() => {
        // 运行时才执行（renderSettings 由用户点设置页触发），此时 14-wallpaper.js 早已就位；
        // typeof 守卫只防"纯核心部署、壁纸模块被摘掉"这一种情况。
        const wp = typeof wpCfgLoad === 'function' ? wpCfgLoad() : null;
        const wpOn = !!(wp && wp.id);
        const local = String(c.ui?.bgImage || '').trim();
        // 注意 bg-we- 前缀的图是本项目"旧版自动抓的小红车缩略图"，不是用户自己选的图，
        // 口径与 00-core.js 的 applyUiCustom 保持一致（那里用 autoThumb 判定是否让位给壁纸）。
        const localIsAutoThumb = local.startsWith('bg-we-');
        if (wpOn) return `<b style="color:var(--accent)">当前生效：Wallpaper Engine 壁纸</b>（${esc(wp.title || wp.id)}）${local ? '　·　本地图片已被隐藏' : ''}`;
        if (local && !localIsAutoThumb) return `<b style="color:var(--accent)">当前生效：本地图片</b>（${esc(local)}）`;
        if (local) return `<b style="color:var(--accent)">当前生效：自动缩略图</b>（${esc(local)}，壁纸模块的降级兜底）`;
        return '当前生效：无 —— 只有界面底色。两层背景都没有启用。';
      })()}</div>
      <div class="hint">两层<b>互斥</b>：挂上壁纸后本地图片不显示，选了本地图片会顺手把壁纸撤下来。想同时"有图"和"动态"，只能二选一。</div>
    </div>

    <div class="field"><label>① 本地图片（一张静态图）</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-small" id="cfg-bg-pick" type="button">🖼 选择图片</button>
        <!-- 清除（R50）：没有背景图时禁用 —— 可点但点了只是把空值再写一遍，
             视觉上一枚"能点的危险按钮"摆在"没有东西可清"的地方也很违和 -->
        <button class="btn btn-small btn-danger" id="cfg-bg-clear" type="button" ${c.ui?.bgImage ? '' : 'disabled'} title="${c.ui?.bgImage ? '移除当前背景图' : '还没有设置背景图'}">清除</button>
        <select id="cfg-bgfit" style="width:120px">
          ${[['cover', '铺满裁剪'], ['contain', '完整显示'], ['repeat', '平铺']].map(([v, t]) => `<option value="${v}" ${String(c.ui?.bgFit || 'cover') === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="margin-top:8px"><label>背景图暗化：<b id="bgdim-val">${clampInt(c.ui?.bgDim, 0, 85, 0)}</b>%</label>
        <input type="range" id="cfg-bgdim" min="0" max="85" step="1" value="${clampInt(c.ui?.bgDim, 0, 85, 0)}" style="width:260px" /></div>
      <div class="hint" id="cfg-bg-hint">${c.ui?.bgImage ? `已设置：${esc(c.ui.bgImage)}（图片已复制到数据目录，换电脑不会丢）` : '未设置。选好图片后，把上面的「底色不透明度」调低就能看到它。'}</div>
    </div>

    <div class="field"><label>② Wallpaper Engine 壁纸（小红车，可动）</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span class="hint" id="cfg-wp-current" style="font-size:12px"></span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
        <button class="btn btn-small" id="cfg-open-wallpaper" type="button">🎨 打开壁纸库…</button>
        <button class="btn btn-small btn-danger" id="cfg-wp-off" type="button">关闭壁纸</button>
        <!-- 自动撤壁纸时会把原选择备份到 wp-console-bg-prev，这里给一条退路 ——
             否则"选了本地图，回来发现壁纸没了、还得重新在几百张里找"又是一个坑。 -->
        <button class="btn btn-small" id="cfg-wp-restore" type="button" hidden>↩ 恢复上次的壁纸</button>
      </div>
      <div class="hint">模糊、压暗、字体、莫奈取色这些只对壁纸生效的选项，在壁纸库里调（点上面的按钮弹出来，选完点「关闭」就回到这里）。</div>
    </div>

    <h3>桌面端</h3>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-autostart" ${c.server?.autoStart ? 'checked' : ''} />
      <label for="cfg-autostart">开机自启</label></div>
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-closetray" ${c.server?.closeToTray !== false ? 'checked' : ''} />
      <label for="cfg-closetray">点关闭时最小化到托盘</label></div>

    <!-- ── 桌面悬浮小窗（2026-10-20）──
         打开后桌面右下角（默认）出现一张无边框小卡片：今日调用 / 估算成本 /
         总 Token / 缓存命中率 + 机器人连接状态。数据走 /api/status 轮询，
         与主界面顶栏同一个接口。卡片整体可拖动移位；右键有菜单（置顶 /
         鼠标穿透 / 尺寸三档 / 关闭）。改动即时生效（主进程 1 秒内同步）。 -->
    <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-widget-enabled" ${c.widget?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-widget-enabled">显示桌面悬浮小窗（用量 / 命中率 / 机器人状态）</label></div>
    <div class="field" id="cfg-widget-opts" style="${c.widget?.enabled !== false ? '' : 'opacity:.45;pointer-events:none'}">
      <div class="field-row">
        <div class="field"><label>尺寸</label>
          <select id="cfg-widget-size" style="width:120px">
            ${[['s', '小'], ['m', '中'], ['l', '大']].map(([v, t]) => `<option value="${v}" ${(c.widget?.size || 'm') === v ? 'selected' : ''}>${t}</option>`).join('')}
          </select></div>
        <div class="field"><label>刷新间隔（毫秒）</label>
          <input type="number" id="cfg-widget-refresh" min="1000" step="500" max="60000" value="${clampInt(c.widget?.refreshMs, 1000, 60000, 2500)}" /></div>
      </div>
      <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-widget-top" ${c.widget?.alwaysOnTop !== false ? 'checked' : ''} />
        <label for="cfg-widget-top">总是置顶（压在其他窗口上面）</label></div>
      <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-widget-click" ${c.widget?.clickThrough ? 'checked' : ''} />
        <label for="cfg-widget-click">鼠标穿透（点它不会抢焦点；开启后小窗右键菜单会失效，用托盘菜单或这里关掉）</label></div>
      <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-widget-edgehide" ${c.widget?.edgeHide !== false ? 'checked' : ''} />
        <label for="cfg-widget-edgehide">贴边自动收起（拖到屏幕边缘会收起成一条细缝，鼠标移近即展开，和 QQ 一样）</label></div>
      <div class="field-row">
        <div class="field"><label>背景不透明度</label>
          <div style="display:flex;align-items:center;gap:10px">
            <input type="range" id="cfg-widget-opacity" min="30" max="100" step="1" value="${clampInt(c.widget?.opacity, 30, 100, 50)}" style="width:260px" />
            <span id="cfg-widget-opacity-val" style="min-width:40px;text-align:right">${clampInt(c.widget?.opacity, 30, 100, 50)}%</span>
          </div>
          <div class="hint" style="margin-top:4px">50% = 默认的半透明卡片。100% = 不透明深色小卡；关掉「真·透明背景」时，100% 以下会走 Windows 11 acrylic 毛玻璃背板（真模糊桌面）。拖动时小窗即时跟随；调过 100% 这条线会重建一次小窗，位置和贴边状态都不变。若你的系统上小窗显示异常，调回 100% 即可。</div>
        </div>
      </div>
      <div class="checkbox-row"><input type="checkbox" class="sw" id="cfg-widget-transparent" ${c.widget?.transparent !== false ? 'checked' : ''} />
        <label for="cfg-widget-transparent">真·透明背景（实验：部分电脑上透明窗口会冻结不刷新，出问题关掉此项即可）</label></div>
      <div class="hint">小窗整体可拖动换位置；右键菜单里也能改置顶 / 穿透 / 尺寸 / 不透明度、或直接关闭。默认档 = 本项<b>开</b> + 不透明度 50%：卡片浮在桌面上、直接看见桌面。<br>
        <b>两种"透明"不是一回事，按需选一个：</b><br>
        · 想要<b>直接看见桌面</b>（卡片浮在桌面上、四角是真圆角）→ 保持本项打开，再用「背景不透明度」调卡片浓淡；<br>
        · 想要<b>磨砂玻璃</b>（背后桌面被糊掉）→ 关掉本项，把「背景不透明度」调到 60~85%。<br>
        本项是实验档：它不糊桌面（系统限制），且部分电脑上会冻结不刷新 —— 真出问题就关掉它、把不透明度调回 100%。</div>
    </div>

    <div class="settings-divider"></div>
    <h3>数据管理</h3>
    <div class="field"><label>用户数据目录</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-datadir" readonly value="${esc(state.dataDir || '（加载中…）')}" style="flex:1" />
        <button class="btn btn-small" id="open-datadir-btn">打开文件夹</button>
      </div>
      <div class="hint">所有用户数据（配置、聊天记录、记忆、表情包）都存在这个目录里。建议定期复制一份到别处备份。</div>
    </div>
    <div class="danger-zone">
      <div class="dz-title">⚠️ 危险区</div>
      <div class="dz-sub">下面的操作会删除数据且<b>不可恢复</b>。动手前建议先点上面的「打开文件夹」，把整个 data/ 目录复制一份。</div>
      <div class="field">
        <button class="btn btn-danger" id="reset-data-btn">重置为初始形态</button>
        <span class="hint" id="reset-data-hint" style="margin-left:10px"></span>
        <div class="hint" style="margin-top:6px">删除所有用户数据：配置（API Key、模型、白名单）、聊天记录、长期记忆、表情包库。</div>
      </div>
    </div>
    <h3>版本更新</h3>
    <div class="field"><label>当前版本 <b id="update-current">…</b><span id="update-status-text">${updateStatusText()}</span></label>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn btn-small" id="check-update-btn">检查更新</button>
        <span class="hint" id="update-hint" style="margin:0"></span>
      </div>
      ${updateDisabled ? '<div class="hint">在线更新检查未启用：请手动下载新版本覆盖安装，用户数据保存在 data/ 目录不会丢。</div>' : ''}</div>`;
}

function renderOnebotSection(c) {
  /* 2026-10-23：协议端解耦后的「连接 QQ」分区。
     本分区只剩两件事：
       ① 启动机器人的 QQ（一键启动 = **只启动 QQ**；协议端由用户自装、自启）；
       ② 连接地址与令牌（协议端默认 3001/3000，改了才需要动）。
     随内置协议端一起删掉的控件：自动拉起 SnowLuma、SnowLuma 程序目录、打开文件夹。
     状态说明：renderSettings 是同步渲染，QQ 运行态是异步接口 —— 这里先渲染占位
     （disabled 按钮 + "正在读取"），bindSettingsEvents 里的 qbRefresh() 拉到状态后
     **只更新这块的文字与按钮态**，不重建表单（绑定不丢）。 */
  const proto = c.protocol || {};
  return `
    <h3 id="settings-onebot">连接 QQ（启动与登录）</h3>
    <div class="hint" style="margin-bottom:10px">「一键启动」只负责启动机器人用的 QQ。协议端（SnowLuma 或 NapCat）由你自己安装、自己启动 —— 两者默认端口一致，装好就能连上。连接状态与排查在「工具 → 连接」页。</div>
    <div class="sl-quickbar" id="settings-quickbar">
      <span class="sl-quickbar-text" id="quick-start-text">正在读取 QQ 状态…</span>
      <button class="btn btn-small btn-primary" id="quick-start-btn" disabled>…</button>
      <span id="quick-start-hint" class="sl-hint"></span>
    </div>

    <h3 style="margin-top:22px">QQ 来源</h3>
    <div class="hint" style="margin-bottom:10px">推荐直接用你电脑里已装的 QQ（检测到就自动用它，无需任何安装步骤）。下面的「装独立副本」是给想要彻底隔离的人准备的「可选项」，不装也完全能用。</div>
    <div class="field">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-small" id="qq-portable-start-btn" title="启动应用自带的便携版 QQ（装了独立副本才有意义）" style="display:none">单独启动便携 QQ</button>
        <button class="btn btn-small" id="qq-install-btn" title="复制一份独立的 QQ 副本（1~2GB，需几分钟），和你自己的 QQ 完全分开；需要先把 QQ 完全退出" style="display:none">装独立副本（可选）</button>
        <span id="qq-portable-state" class="hint" style="margin:0">正在读取 QQ 状态…</span>
      </div>
      <div class="hint" id="qq-portable-hint" style="margin-top:6px"></div>
    </div>

    <h3 style="margin-top:22px">连接</h3>
    <div class="field-row">
      <div class="field"><label>WebSocket 地址（收消息）</label><input type="text" id="cfg-wsurl" value="${esc(proto.wsUrl || '')}" />
        <div class="hint" style="margin-top:4px">协议端的 OneBot v11 正向 WS，默认 ws://127.0.0.1:3001。</div></div>
      <div class="field"><label>HTTP 地址（发消息）</label><input type="text" id="cfg-httpurl" value="${esc(proto.httpUrl || '')}" />
        <div class="hint" style="margin-top:4px">协议端的 OneBot HTTP 接口，默认 http://127.0.0.1:3000。</div></div>
      <div class="field"><label>WebSocket 令牌</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-obtoken" value="${esc(proto.hasAccessToken ? '******' : '')}" placeholder="协议端没设令牌就留空" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-obtoken-toggle" type="button">显示</button>
        </div>
        <div class="hint" style="margin-top:4px">连接密码，防止别的程序连你的机器人。要和协议端里填的一致。</div></div>
      <div class="field"><label>HTTP 令牌（与 WS 不同时才填）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-obhttptoken" value="${esc(proto.hasHttpAccessToken ? '******' : '')}" placeholder="留空 = 与 WS 令牌相同" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-obhttptoken-toggle" type="button">显示</button>
        </div>
        <div class="hint" style="margin-top:4px">同上；两个令牌相同就填一样的。</div></div>
    </div>
    <div class="hint">改完保存后会自动用新地址重连，不用重启。换了端口、加了令牌、或者双开（端口带偏移）时才需要动这里。</div>`;
}

/**
 * 刷新 Skill 状态（后端判定结果）。
 * 单独抽出来是因为开关切换后需要立即重取，而不是等下一次 loadSettings。
 */

/**
 * 拉取技能/插件列表（内存态）。**不含磁盘重扫** —— 想让新放入的目录
 * 被看到，走 rescanSkills()。
 */
async function loadSkillsStatus() {
  try {
    const data = await api('/api/skills');
    state.skills = data.skills || [];
    state.skillsSummary = data.summary || {};
    state.uninstalledSkills = data.uninstalled || [];
  } catch {
    /* 取不到就保持原值，不覆盖成空列表造成"条目都不见了"的假象 */
  }
}

/**
 * 重扫磁盘并刷新列表：技能/插件页「刷新」按钮的完整动作。
 * 之前刷新只重读内存注册表，后台文件监听一旦丢事件（目录删除重建、
 * 网络盘、杀毒软件），放进去的新插件无论点多少次刷新都看不到。
 * 现在先 POST /api/skills/reload 让后端真正重扫；接口不可用时退回
 * 普通列表拉取（不比旧行为差）。
 */
async function rescanSkills({ quiet = false } = {}) {
  try {
    const r = await api('/api/skills/reload', { method: 'POST' });
    if (r && r.skills) {
      state.skills = r.skills;
      state.skillsSummary = r.summary || {};
      // 重扫接口的响应没有 uninstalled 字段，补拉一次（很轻，还能顺带拿脱敏配置）
      await loadSkillsStatus();
      if (!quiet && r.failed?.length) {
        console.warn('[skill] 本次重扫失败条目：', r.failed);
      }
      return r;
    }
  } catch (e) {
    console.warn('[skill] 重扫请求失败：', e?.message || e);
  }
  await loadSkillsStatus();
  return null;
}

/**
 * 技能设置弹窗。
 *
 * 为什么把设置放在技能自己的弹窗里（而不是塞进设置页）：
 *   · 这些字段**只对这个技能有意义** —— 分散在全局设置页里，用户根本对不上号
 *   · 技能页本来就该是"这个技能能配什么"的唯一入口
 *   · 开关和设置放在一起，改完立刻能看到状态徽章变化
 *
 * 表单**完全按 manifest 的 configSchema 渲染**，前端不硬编码任何字段名 ——
 * 加一个新技能、加一个字段，这里一行都不用改。
 * 支持的 type：boolean（复选框）/ number（数字输入）/ enum（下拉）/ string（文本框）
 * 另外 secret: true 的字段用密码框，且留空 = 不修改（后端也按同一约定处理）。
 */

/**
 * 生成技能设置弹窗的 HTML（**纯函数**，不碰 DOM）。
 *
 * 拆出来的唯一目的是可测：这次改动的重点是视觉层级
 * （名字用等宽大字、介绍用正文小字、模态框加宽），
 * 埋在 DOM 操作里就只能靠肉眼看，改坏了没人发现。
 *
 * @returns {{ html: string } | { error: string }}
 */
function renderSkillSettingsModal(skill) {
  if (!skill) return { error: '技能不存在' };
  const skillId = skill.id;
  const schema = skill.configSchema || {};
  const values = skill.settings || {};
  // 界面入口（configSchema 里 type:'action' 的条目）**不在这里**：后端在
  // normalizeManifest 阶段就把它们摘出来、校验好、拼好 URL，放在 skill.panels 上
  // （见 src/skills/panel.js）。所以下面 schema 里剩下的全是"真配置项"，
  // 前端不必再过滤一遍，也不必再把它从「共 N 项设置」里减掉。
  const panels = Array.isArray(skill.panels) ? skill.panels : [];
  // internal 字段（列表/对象类）不渲染成表单输入 —— 它们由专用界面管理。
  // 但仍然要在弹窗里列出来并说明去哪改，否则用户会以为"这个设置根本不存在"。
  const allKeys = Object.keys(schema);
  const internalKeys = allKeys.filter((k) => schema[k]?.type === 'internal');
  const keys = allKeys.filter((k) => schema[k]?.type !== 'internal');
  if (!allKeys.length && !panels.length) return { error: '这个技能没有可配置项' };

  const fieldHtml = (key) => {
    const d = schema[key] || {};
    const v = values[key] ?? d.default ?? '';
    const label = esc(d.label || key);
    const hint = d.description ? `<div class="hint">${esc(d.description)}</div>` : '';
    const id = `skset-${esc(skillId)}-${esc(key)}`;
    // secret：用密码框 + 占位符提示"留空不改"，避免把脱敏值当明文回填
    const isSecret = d.secret === true;
    // 长文本字段跨整行：窄列里换行会碎成一条，读起来很累
    const isWide = d.type === 'string' && (d.multiline === true || String(d.description || '').length > 60);
    const cls = 'field' + (isWide ? ' field--wide' : '');

    let input;
    if (d.type === 'boolean') {
      // 整行做成可点区域：单摆一个小复选框在宽弹窗里像没渲染完
      input = `<label class="skill-toggle-row">
        <input type="checkbox" class="sw" id="${id}" data-key="${esc(key)}" data-type="boolean" ${v ? 'checked' : ''} />
        <span class="st-text">${v ? '已开启' : '已关闭'}</span>
      </label>`;
    } else if (d.type === 'number') {
      input = `<input type="number" id="${id}" data-key="${esc(key)}" data-type="number" value="${esc(v)}" step="any" />`;
    } else if (d.type === 'enum' && (Array.isArray(d.values) || Array.isArray(d.options))) {
      // 枚举渲染成下拉：值写错会让技能行为异常，下拉从根上避免手抖。
      // 两种写法都支持：
      //   values:  ['a','b']                —— 值即显示文本
      //   options: [{ value, label }]       —— 值/显示分离（如把 0~3 档显示成中文档位）
      const opts = Array.isArray(d.options)
        ? d.options.map((o) => ({ value: o?.value, label: o?.label ?? o?.value }))
        : d.values.map((x) => ({ value: x, label: x }));
      input = `<select id="${id}" data-key="${esc(key)}" data-type="enum">${
        opts.map((o) => `<option value="${esc(o.value)}" ${String(v) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')
      }</select>`;
    } else {
      input = `<input type="${isSecret ? 'password' : 'text'}" id="${id}" data-key="${esc(key)}" data-type="string" value="${isSecret ? '' : esc(v)}" placeholder="${isSecret ? (v ? '已设置（留空 = 不修改）' : '未设置') : ''}" autocomplete="off" />`;
    }
    return `<div class="${cls}"><label>${label}${d.secret ? ' 🔒' : ''}</label>${input}${hint}</div>`;
  };

  return { html: `<div class="modal skill-modal" role="dialog" aria-modal="true" aria-label="${esc(skill.name)} 设置">
    <div class="skill-modal__head">
      <div class="skill-modal__titles">
        <div class="skill-modal__name">
          ${esc(skill.name)}
          <span class="skill-modal__ver">v${esc(skill.version || '')}</span>
        </div>
        <div class="skill-modal__id">${esc(skillId)}</div>
        <div class="skill-modal__desc">${esc(skill.description || '（这个技能没有写介绍）')}</div>
      </div>
      <button class="icon-btn" id="skset-x" title="关闭" aria-label="关闭">✕</button>
    </div>
    <div class="skill-modal__body">
      <div class="skill-modal__note">
        ${keys.length
          ? `共 <b>${keys.length}</b> 项设置 · 保存在 <code>config.skills['${esc(skillId)}']</code>，只有这个技能会读到它们。`
          : '这个技能没有可调设置。'}
      </div>
      ${panels.length ? `<div class="skill-panels">
        <div class="skill-panels__head">界面</div>
        ${panels.map((p) => `<div class="skill-panel-row">
          <div class="skill-panel-row__text">
            <div class="skill-panel-row__label">${p.icon ? `${esc(p.icon)} ` : ''}${esc(p.label)}</div>
            ${p.description ? `<div class="hint">${esc(p.description)}</div>` : ''}
          </div>
          ${p.url
            ? `<button class="btn btn-small" type="button" data-skill-panel="${esc(p.url)}" data-skill-panel-title="${esc(p.label)}">${esc(p.button)}</button>`
            : `<span class="skill-panel-row__bad">打不开：${esc(p.problem || '入口配置有误')}</span>`}
        </div>`).join('')}
      </div>` : ''}
      <div class="skill-form">${keys.map(fieldHtml).join('')}</div>
      ${internalKeys.length ? `<div class="skill-modal__internal">
        <div class="skill-modal__internal-head">以下设置不在这里改</div>
        ${internalKeys.map((k) => `<div class="skill-modal__internal-item"><b>${esc(schema[k].label || k)}</b><br />${esc(schema[k].description || '')}</div>`).join('')}
      </div>` : ''}
    </div>
    <div class="skill-modal__foot">
      <!-- 上传到市场：从卡片上收进来（卡片只留开关 + 设置，低频动作不常驻） -->
      <button class="btn btn-small" id="skset-upload" title="把这个条目发布到社区市场">上传到市场</button>
      <span class="skill-modal__foot-tip">改动即时生效，无需重启</span>
      <span class="spacer"></span>
      <button class="btn btn-small" id="skset-cancel">取消</button>
      <button class="btn btn-primary" id="skset-save">保存</button>
    </div>
  </div>` };
}

/**
 * 打开插件自带的静态页。
 *
 * ⚠️ 这里**只接收后端算好的 URL**（`skill.panels[].url`），前端不拼路径。
 * 为什么：这条通道的三段 —— 后端静态服务、这个弹层、插件侧的 `api.panel` ——
 * 必须对同一套路径规则与编码方式达成一致。前端要是自己拼一遍，两处拼法一旦
 * 有分歧（多一个斜杠、少一次 encodeURIComponent），症状就是"点了白屏"且不报错。
 * 规则与拼装都在 src/skills/panel.js，后端在加载时就校验完并算好 URL。
 *
 * 后端把 `<APP_ROOT>/plugins|skills/<id>/` 与 `<DATA_DIR>/plugin-data/<id>/`
 * 只读挂在 `/plugin-panel/<id>/` 下（见 src/app.js 静态服务的"插件自带页面"分支），
 * 插件因此可以在**不改 UI 代码**的前提下提供自己的界面 —— 表情库查看器、
 * 日志面板、配置向导之类。
 *
 * 为什么用 iframe 而不是把插件 HTML 注进来：
 *   ① 插件页有自己的 `<script>`，注进来会被主页面 CSP 的 script-src 'self' 拦掉；
 *   ② 它的 `<style>` 会串味到整个控制台；
 *   ③ iframe 是现成的沙箱 —— 插件页拿不到主页面的 DOM、变量和事件。
 * 代价是插件页要自己再发一次请求，且只能读 `/plugin-panel/` 与 `/api` 的公开数据。
 *
 * @param {string} url    形如 /plugin-panel/<id>/panel/viewer.html（后端产出，已编码）
 * @param {string} title  弹层标题（取 panel.label）
 */
function openPluginPanel(url, title) {
  // 只认自家前缀：URL 来自 /api/skills 的响应，正常一定是后端 panelUrl() 的产物，
  // 但它是可以被插件间接影响的数据（label/panel 都在插件目录里），多一道形状检查。
  const src = String(url || '');
  if (src.indexOf('/plugin-panel/') !== 0) { qaAlert('这个入口没有可打开的页面'); return; }

  const layer = document.createElement('div');
  layer.className = 'modal-overlay plugin-panel-overlay';
  layer.innerHTML = `<div class="skill-modal plugin-panel-modal" role="dialog" aria-modal="true" aria-label="${esc(title || '插件页面')}">
    <div class="skill-modal__head">
      <div class="skill-modal__titles">
        <div class="skill-modal__name">${esc(title || '插件页面')}</div>
        <div class="skill-modal__id">${esc(src)}</div>
      </div>
      <button class="icon-btn" id="ppanel-x" title="关闭" aria-label="关闭">✕</button>
    </div>
    <div class="plugin-panel__body">
      <iframe class="plugin-panel__frame" src="${esc(src)}" referrerpolicy="no-referrer" title="${esc(title || '插件页面')}"></iframe>
      <div class="plugin-panel__fallback" hidden>
        <div class="plugin-panel__fallback-title">页面没能加载出来</div>
        <div class="plugin-panel__fallback-body">
          常见原因：插件目录被删了、<code>panel</code> 指的文件不存在、或者这个插件还没被信任。<br />
          地址：<code>${esc(src)}</code>
        </div>
      </div>
    </div>
  </div>`;
  document.body.appendChild(layer);

  let closed = false;
  // 关掉时要把探活定时器一起清掉，否则弹层已移除、回调还在跑（且会往已脱离的节点写）
  let probeTimer = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    if (probeTimer) clearTimeout(probeTimer);
    document.removeEventListener('keydown', onEsc, true);
    // 摘掉面板命令桥（onPanelMsg 在下方定义；close 只在用户交互时调用，晚于它初始化）
    try { window.removeEventListener('message', onPanelMsg); } catch { /* 未定义时忽略 */ }
    layer.remove();
  };
  // 挂 document 捕获、且**在设置弹窗的 onEsc 之后注册** —— 那一层会先跑，
  // 它靠 `document.querySelector('.plugin-panel-overlay')` 判断上面还压着一层而让路，
  // 于是 Esc 只关这一层（见 openSkillSettings 里的 onEsc）。
  const onEsc = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onEsc, true);

  // 加载探活。iframe 的 error 事件对 HTTP 错误**不触发**（404 也算一次"成功"的导航），
  // 所以不能靠它。两条路一起用：
  //   ① load 之后直接看文档内容 —— 页面与宿主同源，读得到 contentDocument。
  //      后端的 404/403 返回的是 text/plain 的 "Not Found" / "Forbidden"，
  //      浏览器会把它当文档渲染，于是能精确识别"页面其实没找到"；
  //   ② 4 秒还没 load（被 CSP 挡、连接层失败）就按"没加载出来"处理。
  // 目的只有一个：不要留一片空白让用户猜。
  const frame = layer.querySelector('.plugin-panel__frame');
  const fallback = layer.querySelector('.plugin-panel__fallback');
  const looksLikeErrorPage = () => {
    let text = '';
    try { text = String(frame.contentDocument?.body?.textContent || '').trim(); } catch { return false; }
    return text === 'Not Found' || text === 'Forbidden';
  };
  frame.addEventListener('load', () => {
    if (probeTimer) { clearTimeout(probeTimer); probeTimer = 0; }
    fallback.hidden = !looksLikeErrorPage();
  });
  probeTimer = setTimeout(() => {
    probeTimer = 0;
    if (!closed) fallback.hidden = false;
  }, 4000);

  // ── 面板 → 宿主 的命令桥（2026-10-18）─────────────────────────────────
  // 插件面板是只读静态页（安全模型见 src/skills/panel.js），但群友需要能
  // 直接编辑表情备注/标签。约定：面板 postMessage({ type:'qa-plugin-cmd',
  // tool, args, reqId })，宿主校验来源后转发到 /api/plugin-tool（该端点
  // 自带工具白名单 + 来源校验），再把结果 postMessage 回去。
  // ⚠️ 只认**自己嵌的这个 iframe**（e.source 比对），且 origin 必须同源；
  //    结果 targetOrigin 也钉死同源，不往 '*' 发。
  const onPanelMsg = async (e) => {
    if (closed || e.origin !== location.origin) return;
    if (e.source !== frame.contentWindow) return;
    const d = e.data;
    if (!d || d.type !== 'qa-plugin-cmd' || typeof d.tool !== 'string') return;
    const reply = (payload) => {
      try { frame.contentWindow?.postMessage({ type: 'qa-plugin-cmd-result', reqId: d.reqId, ...payload }, location.origin); } catch { /* 面板已卸载 */ }
    };
    try {
      const r = await api('/api/plugin-tool', {
        method: 'POST',
        body: JSON.stringify({ name: d.tool, args: d.args || {} })
      });
      if (r && r.ok) {
        reply({ ok: true, result: r.result || '' });
        if (d.reload || d.tool === 'sticker__note') {
          // 写完数据后，插件会在下一次快照里体现；面板自己会重新 load()，这里不用插手。
        }
      } else {
        reply({ ok: false, error: String(r?.error || '执行失败') });
      }
    } catch (err) {
      reply({ ok: false, error: String(err?.message ?? err) });
    }
  };
  window.addEventListener('message', onPanelMsg);

  layer.querySelector('#ppanel-x').addEventListener('click', close);
  layer.addEventListener('click', (e) => { if (e.target === layer) close(); });
}

/** 打开某个技能的设置弹窗。 */
function openSkillSettings(skillId) {
  const skill = (state.skills || []).find((x) => x.id === skillId);
  if (!skill) return;
  const built = renderSkillSettingsModal(skill);
  if (built.error) { qaAlert(built.error); return; }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = built.html;
  document.body.appendChild(overlay);
  // 2026-10-23 修复：手搓遮罩纳入焦点陷阱（自动登记只认 .model-modal-overlay），
  // 否则 Tab 能跑出技能设置弹窗到背后的页面。
  registerFocusTrap(overlay);

  // ── 关闭：归还焦点 + 解绑全局监听（2026-10-10 r86 修）──
  // 此前 close 只 overlay.remove()：① 焦点落回 body，键盘/读屏用户关闭后迷失；
  // ② Esc 监听挂在 overlay 自身 —— 焦点一旦 Tab 出弹窗就再也按不掉 Esc。
  const prevFocus = document.activeElement;   // 记住打开它的那个按钮
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onEsc, true);
    if (prevFocus && typeof prevFocus.focus === 'function' && prevFocus.isConnected) {
      try { prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
    unregisterFocusTrap(overlay);
    overlay.remove();
  };
  // ⚠️ Esc 走**捕获阶段**挂 document，而不是挂在 overlay 上：
  //   挂 overlay 时只在"焦点在弹窗内"才收得到；挂 document 捕获则先于
  //   14-chrome.js 的冒泡处理器执行，stopPropagation 后不会连带关掉全屏页。
  const onEsc = (e) => {
    if (e.key === 'Escape') {
      // 上面还压着一层插件页面弹层时让路：Esc 该先关那一层（它自己的处理器负责），
      // 否则一次 Esc 会连设置弹窗一起关掉 —— 而用户只是想从查看器退回来。
      if (document.querySelector('.plugin-panel-overlay')) return;
      e.preventDefault(); e.stopPropagation(); close();
    }
  };
  document.addEventListener('keydown', onEsc, true);

  overlay.querySelector('#skset-x').addEventListener('click', close);
  overlay.querySelector('#skset-cancel').addEventListener('click', close);
  // 上传到市场：带上条目类型（kind 为 null = 自定义目录，按技能处理）
  overlay.querySelector('#skset-upload')?.addEventListener('click', () => {
    openMarketUploadModal(skill.kind || 'skill', skillId);
  });
  // 插件界面入口（manifest.panels，来自 configSchema 里 type:'action' 的条目）：
  // 按钮点开插件自带的静态页。事件委托挂在 overlay 上，插件加多少入口都不用改这里。
  overlay.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('[data-skill-panel]');
    if (btn) openPluginPanel(btn.dataset.skillPanel, btn.dataset.skillPanelTitle);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.setAttribute('tabindex', '-1');
  overlay.focus();

  // 复选框旁边的"已开启/已关闭"文字要跟着变，否则看不出当前状态
  overlay.querySelectorAll('input[type="checkbox"][data-type="boolean"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const span = cb.parentElement?.querySelector('.st-text');
      if (span) span.textContent = cb.checked ? '已开启' : '已关闭';
    });
  });

  overlay.querySelector('#skset-save').addEventListener('click', async () => {
    const settings = {};
    overlay.querySelectorAll('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      const type = el.dataset.type;
      if (type === 'boolean') settings[key] = el.checked;
      else if (type === 'number') {
        const n = Number(el.value);
        // 空值/非数字：不提交这个键，让后端保留原值（而不是写进一个 NaN）
        if (el.value.trim() !== '' && Number.isFinite(n)) settings[key] = n;
      } else if (type === 'enum') {
        // options 里的 number 值经 DOM 往返会变成字符串：纯数字就还原成 number，
        // 否则（自由文本枚举）保持字符串。
        const raw = el.value;
        settings[key] = /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw;
      }
      else settings[key] = el.value;   // secret 留空 → 后端按"不修改"处理
    });
    try {
      const r = await api(`/api/skills/${encodeURIComponent(skillId)}`, {
        method: 'POST',
        body: JSON.stringify({ settings })
      });
      const idx = (state.skills || []).findIndex((x) => x.id === skillId);
      if (idx >= 0 && r.skill) {
        // 后端返回的是 status 视图；把设置与 schema 合并回去，避免卡片丢掉这两项
        state.skills[idx] = { ...state.skills[idx], ...r.skill, settings: r.settings || {}, configSchema: state.skills[idx].configSchema };
      }
      if (r.config) state.config = r.config;
      await loadSkillsStatus();
      // 两页都重绘：设置弹窗可能从技能页或插件页打开，
      // 而改动会同时影响状态徽章。重绘代价可忽略（每页最多十来张卡片）。
      renderModulePage('skill');
      renderModulePage('plugin');
      close();
    } catch (err) {
      qaAlert(`保存失败：${err.message}`);
    }
  });
}

/**
 * 扩展页（技能 / 插件）
 *
 * 两型在**代码里完全同构**（同一条加载器、同一套清单字段、同一个开关），
 * 唯一的区别是"谁决定何时执行"：
 *   skill  （LLM 型）  —— 注册工具，模型看了 description 自己决定调不调
 *   plugin （确定性型）—— 提供能力/钩子，核心代码按能力名确定性调用，必然执行
 *
 * 这件事对使用者太重要了（决定"这个功能会不会被模型忽略"），所以拆成两个页签，
 * 但渲染逻辑共用一份 —— 否则两页的卡片、分组、开关行为迟早会分叉。
 *
 * ⚠️ 状态一律用后端 /api/skills 的判定结果，前端**不自己推断**能不能用 ——
 * 否则又会出现"界面说能用、实际不生效"的两套口径。
 */
const MODULE_KINDS = {
  skill: {
    kind: 'skill',
    tab: 'skills',
    boxSel: '#skills-page',
    title: '技能（Skill）',
    dir: 'skills/',
    emptyHint: `还没加载到任何技能。<br />LLM 型技能放在项目的 <code>skills/&lt;id&gt;/</code> 目录，需要 <code>skill.json</code> + <code>index.js</code>。`,
    lead: `技能是 <b>LLM 型</b>扩展：它们注册工具进模型的 function 列表，<b>用不用、什么时候用由模型自己判断</b>。<br />
      所以技能不会"一定生效" —— 模型可能一直不调用它。需要"条件满足必跑"的功能，应该做成插件（见旁边的「插件」页签）。`,
    // 折叠条上那一行摘要（2026-10-09 r30）：完整说明收进 <details>，默认收起。
    // 这一句必须把"这一页跟旁边那页的区别"讲完 —— 它是两页唯一真正重要的分野。
    noteSummary: '技能是 LLM 型扩展 —— 用不用、什么时候用，由模型自己判断',
    setupTitle: '新增技能',
    setupHint: `在 <code>skills/&lt;id&gt;/</code> 放 <code>skill.json</code> + <code>index.js</code>，
      导出 <code>setup(api)</code> 并在里面 <code>api.registerTool({...})</code>。
      热重载默认开启，保存即生效。完整规范见 <code>doc/extend_development/skill-development.md</code>。`
  },
  plugin: {
    kind: 'plugin',
    tab: 'plugins',
    boxSel: '#plugins-page',
    title: '插件（Plugin）',
    dir: 'plugins/',
    emptyHint: `还没加载到任何插件。<br />确定性型插件放在项目的 <code>plugins/&lt;id&gt;/</code> 目录，需要 <code>plugin.json</code> + <code>index.js</code>。`,
    lead: `插件是 <b>确定性型</b>扩展：它们提供<b>能力</b>（<code>providers</code>）或<b>钩子</b>（<code>hooks</code>），
      由核心代码按能力名确定性调用 —— <b>条件满足就一定会执行，不经过 LLM，模型想忽略也忽略不掉</b>。<br />
      代价是它不能"看情况发挥"：什么时候触发必须在代码里写死。需要模型理解意图的功能，应该做成技能（见旁边的「技能」页签）。`,
    noteSummary: '插件是确定性型扩展 —— 宿主按能力名调用，条件满足必然执行',
    setupTitle: '新增插件',
    setupHint: `在 <code>plugins/&lt;id&gt;/</code> 放 <code>plugin.json</code> + <code>index.js</code>，
      导出 <code>setup(api)</code>，并用 <code>export const providers = {...}</code> 或 <code>export const hooks = {...}</code> 声明扩展点。
      热重载默认开启，保存即生效。完整规范见 <code>doc/extend_development/plugin-development.md</code>。`
  }
};

/* ══════════════════════════════════════════════════════════════
   卡片顺序（用户拖拽排序，2026-09-20）
   ══════════════════════════════════════════════════════════════
   两层持久化，和主题一个套路：
     1. localStorage —— 拖完立即生效，不等接口
     2. 后端 config.ui.moduleOrder.{skill|plugin} —— 换设备/重装后还在
   没排过序（取不到任何顺序）就保持后端给的原顺序，不做任何重排。
*/
function moduleOrderKey(kind) { return `qqa-module-order-${kind}`; }

/** 取本页顺序（id 数组）；没排过返回 null。 */
function readModuleOrder(kind) {
  try {
    const raw = localStorage.getItem(moduleOrderKey(kind));
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    }
  } catch { /* 隐私模式下可能不可用 */ }
  const fromCfg = state.config?.ui?.moduleOrder?.[kind];
  return Array.isArray(fromCfg) ? fromCfg : null;
}

/**
 * 内置模块的默认展示顺序（2026-10-18）。
 *
 * 排序逻辑是"重要性与常用度"，不是目录字母序：
 *   每天在用的（记忆 / 表情 / 前缀缓存）→ 影响回答准确度的（发言人身份 /
 *   思考适配 / 图片格式）→ 运行状态与账号（禁言 / 账号池 / 主人识别）→
 *   运维（自检 / 修复 / 工单）→ 进阶能力（语音 / 视频下载 / 锻造台 / 抽帧）。
 * 字母序会把 account-pool、cache-guard 顶到最前面，用户完全看不出哪个是核心。
 *
 * ⚠️ 只作**默认值**：用户拖拽过的顺序（localStorage / config.ui.moduleOrder）优先。
 * ⚠️ 新装或第三方插件不在此表 → 落最后，保持后端原相对顺序（applyModuleOrder 的稳定排序）。
 */
const DEFAULT_MODULE_ORDER = {
  plugin: [
    'mem-layered', 'sticker', 'cache-guard',
    'speaker-identity', 'thinking-adapters', 'image-compat',
    'ban-state', 'account-pool', 'owner-identity',
    'self-doctor', 'self-fix', 'dev-orders',
    'speech-to-text', 'media-download', 'extension-forge', 'video-frames'
  ]
};

/** 按保存的顺序重排条目；没排过的 / 新装的条目按原相对顺序落在最后。 */
function applyModuleOrder(items, kind) {
  // 用户没拖过 → 用内置默认顺序（2026-10-18），不再落到 plugins/ 目录的字母序
  const ord = readModuleOrder(kind) || DEFAULT_MODULE_ORDER[kind];
  if (!ord || !ord.length) return items;
  const pos = new Map();
  ord.forEach((id, i) => { if (!pos.has(id)) pos.set(id, i); });
  return items.slice().sort((a, b) => {
    const pa = pos.has(a.id) ? pos.get(a.id) : Number.MAX_SAFE_INTEGER;
    const pb = pos.has(b.id) ? pos.get(b.id) : Number.MAX_SAFE_INTEGER;
    return pa - pb;   // 同为"没排过"时 sort 稳定 → 保持后端原顺序
  });
}

/** 把 grid 里现在的顺序落盘（本地 + 后端，后端失败静默）。 */
function saveModuleOrder(kind, grid) {
  const ids = [...grid.querySelectorAll('.mcard[data-skill-id]')].map((el) => el.dataset.skillId);
  if (!ids.length) return;
  const key = moduleOrderKey(kind);
  try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* 忽略 */ }
  const ui = { ...(state.config?.ui || {}) };
  const next = { ...(ui.moduleOrder || {}), [kind]: ids };
  ui.moduleOrder = next;
  if (state.config) state.config.ui = ui;   // 让紧接着的重渲染直接用新顺序
  api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { moduleOrder: next } }) })
    .catch(() => { /* 后端不可达时静默：localStorage 已经生效 */ });
}

/**
 * 给一页的卡片装上拖拽排序。
 *
 * 用 Pointer Events 手动实现（2026-09-20 晚，替换 HTML5 DnD）。旧 DnD 方案两个
 * 体验问题：
 *   1. 拖动时浏览器自带"半透明快照"（drag image）跟着光标走 —— 用户看到
 *      两个标签（"留下拖动的标签"）；
 *   2. 让位是"插入式"的：拖卡与目标之间的所有卡整体平移一格 —— 用户预期
 *      是"和目标卡直接互换"。
 * 新交互：
 *   · 按住卡片左缘 26px 热区（手柄列）移动 ≥5px 才算拖起 —— 点卡片仍是开关；
 *   · 拖起：克隆一张浮层卡跟手（微倾斜 + 大投影），原卡淡出占位；
 *   · 悬停到另一张卡上：**只交换这两张** —— 目标卡 180ms 滑到拖卡原槽位，
 *     其余卡片纹丝不动（目标不变时过渡只跑一次，丝滑不抖）；
 *   · 松手：一次性提交 DOM 顺序并持久化（localStorage + 后端）。
 */
function setupCardDrag(scope, kind) {
  const grid = scope.querySelector('.module-grid');
  if (!grid) return;
  // ⚠️ 本函数每渲染一次就跑一次（技能/插件页的初次加载、重扫、导入、删除、
  //    开关、拖拽重排后重渲染……）。window 级监听若只加不移，长会话里反复
  //    操作会往 window 上叠出一串 pointermove/up 监听 —— 每次移动指针都把它们
  //    全跑一遍（旧闭包的 drag 恒为 null 属空转，但监听器数量无上限地涨）。
  //    先把上一次挂在这块 scope 上的摘掉，再挂本次的（见函数尾）。
  const prevWin = scope.__cardDragWin;
  if (prevWin) {
    window.removeEventListener('pointermove', prevWin.onMove);
    window.removeEventListener('pointerup', prevWin.onUp);
    window.removeEventListener('pointercancel', prevWin.onCancel);
  }
  let drag = null;   // { el, clone, cards, slots, fromIdx, toIdx, started, startX, startY }

  const beginDrag = () => {
    const el = drag.el;
    const cards = [...grid.querySelectorAll('.mcard')];
    const slots = cards.map((c) => c.getBoundingClientRect());
    const r = slots[cards.indexOf(el)];
    const clone = el.cloneNode(true);
    clone.classList.add('mcard-ghost');
    clone.style.left = r.left + 'px';
    clone.style.top = r.top + 'px';
    clone.style.width = r.width + 'px';
    clone.style.height = r.height + 'px';
    // ⚠️ 抬起效果（rotate + scale，见 .mcard-ghost）默认绕**中心**变换，会把抓取点
    // 从指针下挪走（实测约漂移 11px，卡片越大越明显）。把变换原点设为抓取点，
    // 卡片就绕"手指按住的那一点"倾斜放大 —— 指针始终钉在按下时的位置。
    clone.style.transformOrigin = `${drag.offX}px ${drag.offY}px`;
    document.body.appendChild(clone);
    el.classList.add('mcard-src');
    for (const c of cards) if (c !== el) c.classList.add('mcard-shifting');
    Object.assign(drag, { started: true, cards, slots, fromIdx: cards.indexOf(el), toIdx: -1, clone });
    grid.classList.add('mdrag-active');
    document.body.style.cursor = 'grabbing';
  };

  /** 与悬停卡互换：目标卡滑到拖卡原槽位，其余不动。idx=-1 = 未悬停，复位。 */
  const swapTo = (idx) => {
    if (idx === drag.toIdx) return;
    if (drag.toIdx >= 0) drag.cards[drag.toIdx].style.transform = '';
    drag.toIdx = idx;
    if (idx >= 0 && idx !== drag.fromIdx) {
      const r = drag.slots[idx];
      const o = drag.slots[drag.fromIdx];
      const dx = Math.round(o.left - r.left);
      const dy = Math.round(o.top - r.top);
      drag.cards[idx].style.transform = (dx || dy) ? `translate(${dx}px, ${dy}px)` : '';
    }
  };

  const endDrag = (commit) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    document.body.style.cursor = '';
    grid.classList.remove('mdrag-active');
    d.clone?.remove();
    d.el.classList.remove('mcard-src');
    if (!d.started) return;   // 没超过 5px 阈值 = 普通点击，交给 click 事件
    const settle = () => {
      for (const c of d.cards) { c.classList.remove('mcard-shifting'); c.style.transform = ''; }
    };
    if (commit && d.toIdx >= 0 && d.toIdx !== d.fromIdx) {
      const order = [...d.cards];
      order[d.fromIdx] = d.cards[d.toIdx];
      order[d.toIdx] = d.cards[d.fromIdx];
      // ⚠️ 落位必须「零动画」（r38，用户反馈"拖动结束后有一小段奇怪的动画"）：
      //   appendChild 移动已有节点时，浏览器会把**重挂前**的样式（目标卡身上还挂着
      //   inline translate）当成过渡起点 —— 松手后那张已经滑到位的卡会再滑一遍，
      //   叠上 :hover 的 1px 上浮就是两段诡异滑动（实测 document.getAnimations()
      //   松手后同卡上有 2 个 CSSTransition(transform)，跑约 100ms）。
      //   正解：先禁过渡 → 提交 DOM / 清 transform → 强制 reflow 让"零过渡下的
      //   终态"先成为样式事实 → 再恢复过渡。一帧内钉死，无任何收尾动画。
      d.cards.forEach((c) => { c.style.transition = 'none'; });
      for (const c of order) grid.appendChild(c);
      settle();
      void grid.offsetWidth;              // 强制 reflow：落位在这一帧完成
      d.cards.forEach((c) => { c.style.transition = ''; });
    } else {
      settle();
    }
    saveModuleOrder(kind, grid);
  };

  grid.querySelectorAll('.mcard').forEach((cardEl) => {
    // 2026-10-23：键盘排序。拖拽是唯一的排序方式，键盘用户无法调整技能/插件顺序。
    // 给卡片补 Alt+↑/↓（与拖拽同一套落位逻辑：交换相邻卡后立即落盘）。
    cardEl.addEventListener('keydown', (e) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      const sib = e.key === 'ArrowUp' ? cardEl.previousElementSibling : cardEl.nextElementSibling;
      if (!sib || !sib.classList.contains('mcard')) return;
      if (e.key === 'ArrowUp') grid.insertBefore(cardEl, sib);
      else grid.insertBefore(sib, cardEl);
      try { cardEl.focus({ preventScroll: true }); } catch { /* ignore */ }
      saveModuleOrder(kind, grid);
    });
    cardEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button, input, label, a, textarea, select')) return;
      const r = cardEl.getBoundingClientRect();
      // 热区：卡片左缘 26px（手柄列 + 余量）。整卡可点（点一下切开关），
      // 不能整卡都算拖拽，否则开关点不准。
      if (e.clientX - r.left > 26) return;
      // offX/offY = 抓取点相对卡片左上角的偏移：拖起来后浮层卡按这个偏移跟手，
      // 指针始终停在你按下的那个位置上（曾经是中心对齐，一拖起卡片就"跳"到
      // 鼠标正下方，手感像被甩了一下——2026-09-20 用户反馈）。
      drag = {
        el: cardEl, startX: e.clientX, startY: e.clientY,
        offX: e.clientX - r.left, offY: e.clientY - r.top, started: false
      };
    });
  });

  const onMove = (e) => {
    if (!drag) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return;
      beginDrag();
    }
    // 浮层卡跟手：按按下时的抓取偏移走（指针停在你按的那个点上，不居中吸附）
    drag.clone.style.left = Math.round(e.clientX - drag.offX) + 'px';
    drag.clone.style.top = Math.round(e.clientY - drag.offY) + 'px';
    // 悬停到哪张卡 → 与它互换。
    // ⚠️ 不能拿「指针点」判定：从上往下拖会路过中间的卡，擦个边就误触发互换，
    //    被擦过的卡猛地滑上来又弹回去 —— 用户说的"意义不明的动画"就是它。
    //    改用**浮层卡与槽位的重叠面积**判定，并且带**回滞**（2026-09-21）：
    //    接管新目标要 >50%，但已接管的目标要等重叠 <30% 才放手。只有一条阈值时，
    //    拖卡悬在目标槽位边缘（重叠在 50% 附近）+ 鼠标轻微上下修正，会让下方卡
    //    反复"顶上去→滑回来"（用户反馈的"一小段上弹然后滑下来"）—— 30~50% 的
    //    回滞带把这个抖动整个吸收掉：一旦顶上去，只要还压着 3 成就不松手。
    const gr = drag.clone.getBoundingClientRect();
    /** 拖卡与第 i 个槽位的重叠面积占该槽位的比例 */
    const fracOf = (i) => {
      const s = drag.slots[i];
      const ox = Math.min(gr.right, s.right) - Math.max(gr.left, s.left);
      const oy = Math.min(gr.bottom, s.bottom) - Math.max(gr.top, s.top);
      return (ox <= 0 || oy <= 0) ? 0 : (ox * oy) / (s.width * s.height);
    };
    let best = -1;
    let bestArea = 0;
    for (let i = 0; i < drag.slots.length; i++) {
      if (i === drag.fromIdx) continue;
      const s = drag.slots[i];
      const ox = Math.min(gr.right, s.right) - Math.max(gr.left, s.left);
      const oy = Math.min(gr.bottom, s.bottom) - Math.max(gr.top, s.top);
      if (ox <= 0 || oy <= 0) continue;
      const area = ox * oy;
      if (area > bestArea) { bestArea = area; best = i; }
    }
    let hit = -1;
    if (drag.toIdx >= 0 && drag.toIdx !== drag.fromIdx) {
      // 已有目标：黏住，重叠掉到 30% 以下才放手
      if (fracOf(drag.toIdx) >= 0.3) hit = drag.toIdx;
      else if (best >= 0 && fracOf(best) >= 0.5) hit = best;
    } else if (best >= 0) {
      if (fracOf(best) >= 0.5) hit = best;   // 擦边（<半张卡）不算
    }
    swapTo(hit);
  };
  const onUp = () => endDrag(true);
  const onCancel = () => endDrag(false);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  // 记到 scope 上：下次渲染时先摘掉这一组（见函数开头）
  scope.__cardDragWin = { onMove, onUp, onCancel };
}

/* 列表状态指纹：只取"会影响这一页长什么样"的字段，用来判断后台对齐回来的
   数据和屏幕上这份是不是同一份。变了才重渲染，没变就不动 DOM。 */
function moduleStateFingerprint() {
  const list = Array.isArray(state.skills) ? state.skills : [];
  const parts = list.map((s) => `${s.id}:${s.loaded ? 1 : 0}${s.enabled ? 1 : 0}${s.active ? 1 : 0}${(s.breaker && s.breaker.open) ? 'b' : ''}`);
  const un = Array.isArray(state.uninstalledSkills) ? state.uninstalledSkills.length : 0;
  return parts.join('|') + '#' + un;
}

/**
 * 载入并渲染「技能 / 插件」管理页。
 *
 * ⚠️ 2026-10-20（修「从别的页签点『下载』会明显卡一下」）：
 *    根因不是后端慢（实测 /api/skills 9.7ms、/api/prompt-preview 2.2ms），
 *    而是这个函数**每次进入都从头来一遍**：
 *      清空成骨架 → 等两个接口 → 整页重建 → 重绑所有事件
 *    骨架是同步写进去的，所以它至少会被画到屏幕上一帧 —— 用户看到的就是
 *    「旧页 → 骨架闪白 → 完整页」的三段跳；再叠加 .view 刚从 display:none
 *    变成 flex（一次全量布局）、强制 reflow（第二次）、innerHTML 覆盖（第三次），
 *    点一下的代价被放大成肉眼可见的卡顿。
 *
 *    现在分三条路：
 *      ① 已有数据 + 普通进入（绝大多数情况，包括从导航栏切过来）
 *         → 直接用内存数据渲染，**同步一次 DOM 写入**就出完整页；
 *           与后端的对齐放到后台，指纹没变就一个字节都不动。
 *      ② 首次进入（还没数据）/ fresh 强制 → 数据没到之前**不清空**，
 *         只有慢过 120ms 才补骨架（本地接口通常 10ms 就回来了，
 *         那条"必闪一帧"的骨架就是这么省掉的）。
 *      ③ rescan（「刷新」按钮 / 装完插件）→ 保留骨架，因为这个动作本来就慢，
 *         需要即时反馈。
 *
 * @param {'skill'|'plugin'} kind
 * @param {{rescan?: boolean, fresh?: boolean}} opts
 *   rescan —— 让后端真的重扫磁盘（慢，带骨架）。
 *   fresh  —— 数据刚被别处改过（如清理未安装残留），别用缓存先画一遍。
 */
async function loadModulePage(kind, { rescan = false, fresh = false } = {}) {
  const meta = MODULE_KINDS[kind];
  if (!meta) return;
  const box = $(meta.boxSel);
  if (!box) return;

  const hasCache = Array.isArray(state.skills) && state.skills.length > 0;

  // ① 缓存命中：同步出页，后台对齐
  if (hasCache && !rescan && !fresh) {
    renderModulePage(kind);
    // 技能页自己**不再**显示预览（右栏已撤，见 renderModulePage 顶部注释），
    // 但「设置 → 工具与技能」那份要的是最新数据 —— 所以还是刷，只是**不再 await**：
    // 它是纯后台预热，没有任何理由挡住这一帧。（加载慢时它的代价也就跟着消失了）
    if (kind === 'skill') refreshPromptPreview(state.config || {});
    const before = moduleStateFingerprint();
    loadSkillsStatus()
      .then(() => {
        if (moduleStateFingerprint() === before) return;      // 数据没变：什么都不做
        if (state.tab !== meta.tab) return;                   // 人已经走了：不必重画
        try { renderModulePage(kind); } catch (e) { console.warn('[module] 后台对齐重渲染失败：', e && e.message); }
      })
      .catch(() => { /* 拿不到就用屏幕上这份，不打断 */ });
    return;
  }

  // ② / ③ 需要等数据：先不主动清空，慢过 120ms 才补骨架
  let settled = false;
  const skelTimer = setTimeout(() => {
    if (settled) return;
    // ⚠️ 2026-10-22：**已有内容时不要用骨架覆盖**。
    // 群友反馈「安装插件 / skills 会重置页面」「每次安装完都得重新划下去」——
    // 安装后 rescan 走的就是这条路：等 /api/skills 的这段时间里把列表换成骨架，
    // 容器内容先清空再填，scrollTop 必然归零（实测：一次性同步替换 innerHTML
    // 是**保留**滚动位置的，700 还是 700；但只要中间出现一次"清空"就归零）。
    // 保留旧内容直到新数据回来 —— 用户眼前的列表位置不动，代价只是这
    // 100~300ms 里看到的还是稍旧的一份，比"被弹回顶部"好得多。
    if (box.querySelector('.module-grid')) return;
    try { box.innerHTML = renderModuleSkeleton(meta); } catch { /* 骨架画不出来也不影响后续渲染 */ }
  }, 120);
  try {
    if (rescan) await rescanSkills({ quiet: true });
    else await loadSkillsStatus();
  } finally {
    settled = true;
    clearTimeout(skelTimer);
  }
  if (kind === 'skill') refreshPromptPreview(state.config || {});
  renderModulePage(kind);
}

function renderModuleSkeleton(meta) {
  return `<div class="usage-wrap">
    <div class="usage-head"><h2>${esc(meta.title)}</h2></div>
    <div class="sk-block">${'<div class="sk-row"></div>'.repeat(5)}</div>
  </div>`;
}

/**
 * 渲染一页（技能或插件）。
 *
 * @param {'skill'|'plugin'} kind 只渲染该类型；另一类的条目**完全不进这一页**
 */
/* 技能页 / 插件页各自的状态筛选（PCL「实例设置 → 资源」那排 全部 / 启用 / 禁用）。
   r94 新增：模块一多，"想找那个被我关掉的技能"得把整页卡片从头扫一遍。
   只放内存态，不落配置 —— 刷新页面回到「全部」是符合直觉的。 */
const MODULE_FILTER = { skill: 'all', plugin: 'all' };
/* 来源筛选（2026-10-22 新增）：把随应用分发的内置模块和自己后来装的隔开，方便管理。
   与 MODULE_FILTER（状态）是**两个独立维度**，同时生效（AND）。
   数据来自 /api/skills 每条上的 builtin 字段（后端按 builtin-modules.json 的目录名判定）。 */
const MODULE_SOURCE = { skill: 'all', plugin: 'all' };

/* r95：target / opts 是给「会话设置」页右栏复用的入口 —— 不传时行为与以前逐字相同。
   · target：渲染到哪个容器（默认仍是本页自己的 #skills-page / #plugins-page）。
   · opts.compact：精简版 —— 只出「标题 + 计数 + 状态筛选 + 卡片网格」。
     省掉的三块（去市场 / ＋添加 / 刷新、未安装残留清理）都带**全局唯一 id**
     （#skills-refresh-btn、#skills-cleanup-btn…），而 #view-skills / #view-plugins
     一直挂在 DOM 里 —— 两份同 id 的 DOM 会让 $() 只认先出现的那一个，
     另一份的按钮全成哑的（点了没反应，还查不出原因）。 */
function renderModulePage(kind, target, opts) {
  const meta = MODULE_KINDS[kind];
  if (!meta) return '';
  const box = target || $(meta.boxSel);
  const compact = !!(opts && opts.compact);
  const all = state.skills || [];
  // 只留本页该管的类型。
  // ⚠️ kind 为 null（自定义根目录，如测试用的临时目录）时归入**技能页**而不是丢弃 ——
  // "界面上凭空少了一个条目"比"归错页"难排查得多（用户刚刚就踩过这个坑）。
  // 卡片上会标「目录未识别」提示作者去确认放置位置。
  const items = all.filter((s) => s.kind === meta.kind || (s.kind == null && meta.kind === 'skill'));

  // 统计按本页条目现算：后端 summary 是全量的，直接用会把另一类也算进来
  const mine = {
    total: items.length,
    active: items.filter((s) => s.active).length,
    off: items.filter((s) => s.loaded && !s.enabled).length,
    broken: items.filter((s) => !s.loaded).length
  };

  if (!items.length) {
    // 2026-10-18：首次进入（扩展列表还没拉回来）与"真的一件都没装"必须分开 ——
    // 否则切页签的瞬间会闪一下"还没有插件/技能"，看起来像数据丢了。
    if (!state.skillsReady) {
      const loading = `<div class="usage-wrap">
        <div class="usage-head"><h2>${esc(meta.title)}</h2></div>
        <div class="empty-hint">正在读取已安装的${meta.kind === 'skill' ? '技能' : '插件'}…</div>
      </div>`;
      if (box) box.innerHTML = loading;
      return loading;
    }
    const emptyHtml = `<div class="usage-wrap">
      <div class="usage-head"><h2>${esc(meta.title)}</h2>
        <div class="usage-days">
          <button class="btn btn-small" id="${esc(meta.tab)}-market-btn" title="在应用内浏览市场，点一下就装">去市场</button>
          <button class="btn btn-small" id="${esc(meta.tab)}-create-btn">＋ 添加${meta.kind === 'skill' ? '技能' : '插件'}</button>
          <button class="btn btn-small" id="${esc(meta.tab)}-refresh-btn">刷新</button>
        </div></div>
      <div class="empty-hint">${meta.emptyHint}</div>
      <div class="hint" style="margin-top:10px">${meta.lead}</div>
      <div class="hint" style="margin-top:10px"><b>最省事的办法是点上面「去市场」</b>直接挑一个装；也可以把 zip 包或整个文件夹拖到这一页，或点「＋ 添加${meta.kind === 'skill' ? '技能' : '插件'}」选「导入本地文件」。</div>
    </div>`;
    // compact 版不能复用 emptyHtml：它带 #skills-market-btn / #skills-create-btn
    // 等全局唯一 id（理由同函数头注释）。
    const empty = compact
      ? `<div class="usage-wrap">
      <div class="usage-head"><h2>${esc(meta.title)}</h2>
        <div class="usage-days"><span class="uc-tag" title="生效中 / 这一页的总数">0 / 0 生效</span></div></div>
      <div class="empty-hint">${meta.emptyHint}</div>
      <div class="hint" style="margin-top:10px">装新的${meta.kind === 'skill' ? '技能' : '插件'}去顶部导航栏「<b>下载</b>」页 —— 那边有市场，点一下就装。</div>
    </div>`
      : emptyHtml;
    if (box) box.innerHTML = empty;
    bindModulePageEvents(kind, box, opts);
    return empty;
  }

  // ── 半宽卡片 + 拖拽排序（2026-09-20 改版）──
  // 上一版是「一整行大卡 + 按分类分组」：一屏放不下几个，翻很久。
  // 现在：取消分类（分类图标/标签一并去掉），一屏两列半宽卡；
  // 顺序由用户按住左侧手柄拖动决定，存 config.ui.moduleOrder + localStorage。
  // 卡左条颜色表达状态（绿=生效 / 灰=已关 / 红=加载失败 / 黄=依赖未就绪）。
  // 设置钮图标（2026-09-20 换版）：用户点名要「齿轮」造型（线性 outline 风格）。
  // 上一版用的滑块图标被换掉；这颗齿是 8 齿 + 中轴双圈，stroke 线性，
  // 与顶栏自绘窗口按钮同一套图标语言（fill:none / stroke:currentColor 由 CSS 提供）。
  const GEAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="3.2"/>'
    + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
    + '</svg>';
  // 拖动手柄：两列三点，纯线条点阵（不用 ⠿ 文本字形，各平台字体不一致）
  const GRIP_SVG = '<svg viewBox="0 0 8 16" aria-hidden="true">'
    + '<circle class="dt" cx="2.2" cy="3.5" r="1.05"/>'
    + '<circle class="dt" cx="5.8" cy="3.5" r="1.05"/>'
    + '<circle class="dt" cx="2.2" cy="8" r="1.05"/>'
    + '<circle class="dt" cx="5.8" cy="8" r="1.05"/>'
    + '<circle class="dt" cx="2.2" cy="12.5" r="1.05"/>'
    + '<circle class="dt" cx="5.8" cy="12.5" r="1.05"/>'
    + '</svg>';
  // 删除钮：小垃圾桶（feather trash-2 造型：盖线 + 提手 + 桶身 + 两条竖线），
  // 与齿轮同一套线性图标语言（fill:none / stroke:currentColor 由 CSS 提供）。
  const TRASH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M3 6h18"/>'
    + '<path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>'
    + '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'
    + '<path d="M10 11v6"/>'
    + '<path d="M14 11v6"/>'
    + '</svg>';
  const card = (s) => {
    const loadedOk = s.loaded;
    const active = loadedOk && s.enabled && s.active;
    // 状态类名：驱动卡片边框/底色（CSS 里 .mcard-* 定义）
    const stateCls = !loadedOk ? 'mcard-broken' : (!s.enabled ? 'mcard-off' : (active ? 'mcard-on' : 'mcard-dep'));
    const stateTitle = !loadedOk ? `加载失败：${s.loadError || '原因未知'}`
      : (!s.enabled ? '已关闭（点击开启）'
        : (active ? '生效中（点击关闭）' : `已启用但依赖未就绪：${s.reason || (s.missingRequires || []).join('、') || '原因未知'}`));
    const stateText = !loadedOk ? '加载失败' : (!s.enabled ? '已关闭' : (active ? '生效中' : '依赖未就绪'));
    // 运行时熔断徽章（2026-10-19）：加载成功、开关开着、但工具连续失败触发了
    // 护栏熔断 —— 这是"启用后跑不正常"的唯一目前可自动感知的信号，必须可见。
    // 熔断到期自动恢复（半开），成功一次即复位，所以徽章是临时态不是封禁。
    const brk = (s.breaker && s.breaker.open) ? s.breaker : null;
    const brkTitle = brk
      ? `运行异常：工具连续失败 ${brk.fails} 次已被临时熔断（数分钟后自动恢复，成功一次即复位；最近失败的工具：${brk.lastTool || '未知'}）`
      : '';
    const brkBadge = brk
      ? `<span class="mcard-state mcard-brk" title="${esc(brkTitle)}">已熔断</span>`
      : '';
    // 调用性诊断（2026-10-19）：生效中 ≠ 模型调得到。callability 由后端
    // 按 skillId 聚合 /api/tools/availability 的结果：工具可以因为「单工具
    // 开关 / 分类开关 / 视觉依赖」等被静默拦在模型列表外 —— 以前这种卡片
    // 也显示"生效中"，用户体感就是"插件没法正常调用"。
    const cal = (loadedOk && s.enabled && s.active && s.callability) ? s.callability : null;
    const calAllBlocked = !!(cal && cal.total > 0 && cal.callables === 0);
    const calBlockedBadge = calAllBlocked
      ? `<span class="mcard-state mcard-brk" title="它的 ${cal.total} 个工具当前全部进不了模型列表：${esc((cal.blocked[0] || {}).reason || '原因未知')}">工具被关</span>`
      : '';
    // 放置/引导 lint 警告：skills/ 里没工具（模型完全看不见）、注册了工具
    // 却没有策略段引导等 —— 不是故障，但正是"写了东西却没人调用"的来源。
    const lintWarns = (loadedOk && Array.isArray(s.warnings)) ? s.warnings : [];
    const lintBadge = lintWarns.length
      ? `<span class="mcard-state mcard-brk" title="${esc(lintWarns.join('；').slice(0, 400))}">⚠️ 有警告</span>`
      : '';
    const allFields = Object.keys(s.configSchema || {});
    const panelCount = Array.isArray(s.panels) ? s.panels.length : 0;
    // ⚙ 出现的条件要**同时**看设置项和界面入口：只有 panels、没有配置项的插件
    // 一样需要这颗齿轮才能进弹窗 —— 否则它的界面就完全没入口了。
    const gearTitle = panelCount
      ? `界面 / 设置（${panelCount} 个界面 · ${allFields.length} 项设置）`
      : `设置（${allFields.length} 项）`;
    const settingsBtn = (allFields.length || panelCount)
      ? `<button class="mcard-gear" data-skill-id="${esc(s.id)}" title="${esc(gearTitle)}" aria-label="打开 ${esc(s.name)} 的设置">${GEAR_SVG}</button>`
      : '';
    // 删除钮：从磁盘移除这个 Skill/插件的整个目录（不可逆）。
    // 图标按钮的点击会 stopPropagation，不会触发整卡开关。
    const kindLabel = (s.kind || kind) === 'plugin' ? '插件' : '技能';
    const delBtn = `<button class="mcard-del" data-skill-id="${esc(s.id)}" data-skill-name="${esc(s.name)}" data-skill-kind="${esc(s.kind || kind || '')}" title="删除${kindLabel}（从磁盘移除整个文件夹，不可恢复）" aria-label="删除 ${esc(s.name)}">${TRASH_SVG}</button>`;
    // 「信任并重试」按钮（2026-10-07 新增）：仅在**因高危能力被拦**时出现。
    // 准入闸是为了保护用户，但用户自己写的插件常常确实需要 fs；
    // 没有这一键就只剩"手改 data/config.json"或"把闸门关掉"两个坏选择。
    // 按钮只在该模块处于这个特定失败状态时出现 —— 不是所有加载失败都能点信任。
    const trustable = !loadedOk && /触碰了高危能力/.test(String(s.loadError || ''));
    const trustBtn = trustable
      ? `<button class="mcard-trust" data-skill-id="${esc(s.id)}" data-skill-dir="${esc(s.dir || s.id)}"
           title="我信任这个${kindLabel}，允许它使用本机能力（会记入信任名单）"
           aria-label="信任并重试 ${esc(s.name)}">信任并重试</button>`
      : '';
    // 自动适配入口（2026-10-19）：加载失败、或加载正常但触发熔断（工具连续失败）
    // 的模块，一键送去「升级扩展」工作台 —— 那是现成的适配 harness：
    // 复制进暂存区 → 模型按本机环境改 → 五道闸门 + 自动修复回路 → 你确认后才
    // 备份覆盖安装（可回滚）。全程不原地改，失败也不伤原文件。
    const adaptCandidate = !loadedOk || brk;
    const adaptDir = (String(s.dir || '').replace(/\\/g, '/').split('/').pop()) || s.id;
    const adaptBtn = adaptCandidate
      ? `<button class="mcard-adapt" data-skill-id="${esc(s.id)}" data-skill-name="${esc(s.name)}"
           data-skill-kind="${esc(s.kind || kind || 'plugin')}" data-skill-dir="${esc(adaptDir)}"
           title="去「升级扩展」工作台自动适配：复制进暂存区，让模型修好它，过闸确认后才覆盖安装（原版自动备份，可回滚）"
           aria-label="自动适配 ${esc(s.name)}">🔧 自动适配</button>`
      : '';
    return `
    <div class="mcard mcard-big mcard-half ${stateCls}" data-skill-id="${esc(s.id)}" role="button" tabindex="0" title="${esc(stateTitle)}">
      <span class="mcard-grip" title="按住拖动排序" aria-label="拖动 ${esc(s.name)} 排序" role="button" tabindex="-1">${GRIP_SVG}</span>
      <div class="mcard-info">
        <div class="mcard-title-line">
          <span class="mcard-name">${esc(s.name)}</span>
          <span class="skill-card__ver">v${esc(s.version)}</span>
          ${brkBadge}
          ${calBlockedBadge}
          ${lintBadge}
          <span class="mcard-state">${stateText}</span>
        </div>
        <div class="mcard-desc">${esc(s.description || '（没有写介绍）')}</div>
        <div class="mcard-dir">${esc(s.dir || '')}</div>
      </div>
      <div class="mcard-acts">
        ${settingsBtn}
        ${delBtn}
        <label class="mcard-sw" title="${esc(stateTitle)}">
          <input type="checkbox" class="sw" data-skill-toggle="${esc(s.id)}" ${s.enabled ? 'checked' : ''} ${!loadedOk ? 'disabled' : ''} />
        </label>
      </div>
      ${!loadedOk && s.loadError ? `<span class="mcard-err">${esc(String(s.loadError).slice(0, 120))}</span>` : ''}
      ${brk && loadedOk ? `<span class="mcard-err mcard-err-brk">工具连续失败 ${esc(String(brk.fails))} 次已熔断 —— 点「自动适配」让模型修</span>` : ''}
      ${calAllBlocked ? `<span class="mcard-err mcard-err-brk">它的 ${esc(String(cal.total))} 个工具当前全被拦在模型列表外：${esc((cal.blocked[0] || {}).reason || '原因未知')}（去 设置 → 工具与技能 开启）</span>` : ''}
      ${lintWarns.length ? `<span class="mcard-err mcard-err-brk">⚠️ ${esc(lintWarns[0].slice(0, 160))}${lintWarns.length > 1 ? `（另有 ${lintWarns.length - 1} 条警告，悬停徽章可看）` : ''}</span>` : ''}
      ${trustBtn}
      ${adaptBtn}
    </div>`;
  };

  // ── 两页共用一个骨架：标题 / 说明折叠条 / 卡片网格 / 尾注 / 新增说明 ──
  // （2026-10-09 r30）这里原来还有个"技能页专属右栏"放提示词预览，撤掉了：
  //   ① 原型里这一页根本没有预览栏 —— 预览在「设置 → 工具与技能」（真机设置页
  //      本文件后面**已经有一份**，技能页那份是重复的）；
  //   ② 它把技能页左栏挤到 630px，而插件页是 1048px —— 两页卡片宽 309 vs 464、
  //      说明块 7 行 vs 5 行，实测差异全从这一栏来。
  //   撤掉后两页左栏都是 1048，.usage-wrap(940) 上限两页同时触发，卡片/换行完全一致。
  // 分类分组已取消：全部条目平铺进**一个** grid，顺序 = 用户拖出来的顺序。
  const ordered = applyModuleOrder(items, kind);
  // ── 状态筛选条（r94）──
  // 计数直接复用上面按本页现算的 mine（后端 summary 是全量的，用它会串页）。
  const filter = MODULE_FILTER[kind] || 'all';
  const filterTabs = [
    { id: 'all', label: '全部', n: mine.total },
    { id: 'on', label: '生效', n: mine.active },
    { id: 'off', label: '已关', n: mine.off },
    { id: 'bad', label: '加载失败', n: mine.broken }
  ];
  // 来源维度：内置 / 第三方（s.builtin 由后端按 builtin-modules.json 的目录名给出）
  const srcFilter = MODULE_SOURCE[kind] || 'all';
  const builtinCount = items.filter((s) => s.builtin).length;
  // 过渡期兜底：后端还没带上 builtin 字段时（换了前端没重启进程），整组不显示 ——
  // 否则会写「内置 0 / 第三方 12」，看着像"内置的都不见了"，比不显示更吓人。
  const hasBuiltinInfo = items.some((s) => typeof s.builtin === 'boolean');
  const srcTabs = [
    { id: 'all', label: '不限来源', n: mine.total },
    { id: 'builtin', label: '内置', n: builtinCount },
    { id: 'third', label: '第三方', n: mine.total - builtinCount }
  ];
  const shown = ordered.filter((s) => {
    // 来源先过一遍（与状态维度是 AND 关系）
    if (srcFilter === 'builtin' && !s.builtin) return false;
    if (srcFilter === 'third' && s.builtin) return false;
    if (filter === 'on') return !!(s.loaded && s.enabled && s.active);
    if (filter === 'off') return !!(s.loaded && !s.enabled);
    if (filter === 'bad') return !s.loaded;
    return true;
  });
  // 两组筛选条：状态一行、来源一行。挤在一行放不下（状态 4 档 + 来源 3 档），
  // 而且混在一起会让人以为"内置"也是一种状态 —— 分成两行、来源那行加个小标签。
  const filterBar = `<div class="mod-filters" style="display:flex;gap:8px;flex-wrap:wrap;margin:0 0 8px">`
    + filterTabs.map((f) => `<button type="button" class="btn btn-small" data-mod-filter="${f.id}"`
      // 选中态用主题强调色（与「会话设置 → 扩展」的子页签同一套写法，避免新增一次性 CSS）
      + (f.id === filter ? ' style="background:var(--accent);color:#fff;border-color:var(--accent)"' : '')
      + `>${f.label} ${f.n}</button>`).join('')
    + '</div>'
    + (hasBuiltinInfo
      ? `<div class="mod-filters" style="display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px;align-items:center">`
        + '<span style="font-size:11.5px;color:var(--fg-mute);margin-right:2px">来源</span>'
        + srcTabs.map((f) => `<button type="button" class="btn btn-small" data-mod-src="${f.id}"`
          + (f.id === srcFilter ? ' style="background:var(--accent);color:#fff;border-color:var(--accent)"' : '')
          + `>${f.label} ${f.n}</button>`).join('')
        + '</div>'
      : '');
  const grid = `
    <div class="module-grid">
      ${shown.map(card).join('') || '<div class="empty-hint" style="grid-column:1/-1">这一档里没有条目。</div>'}
    </div>`;

  // 尾注：技能页最有用的信息是"它有哪些工具"（模型看到的就是这些），
  // 插件页最有用的信息是"它提供哪些能力"（核心按名字找的就是这些）。
  const toolsOfMine = items.flatMap((s) => s.toolIds || []);
  const capsOfMine = [...new Set(items.flatMap((s) => s.capabilities || []))].sort();
  const footer = kind === 'skill'
    ? `<h3 class="usage-h3">这一页的技能共注册 ${toolsOfMine.length} 个工具</h3>
    <div class="hint" style="margin-bottom:6px">这些工具会被放进发给模型的 function 列表 —— 模型只能看到工具，看不到技能本身。</div>
    <div class="tool-meta" style="gap:6px">${toolsOfMine.map((t) => `<span class="tool-dep">${esc(t)}</span>`).join('') || '<span class="muted">（没有注册任何工具）</span>'}</div>`
    : `<h3 class="usage-h3">这一页的插件共提供 ${capsOfMine.length} 个能力</h3>
    <div class="hint" style="margin-bottom:6px">核心模块按这些能力名找提供者，不依赖具体插件名 —— 所以换实现不用改核心代码。</div>
    <div class="tool-meta" style="gap:6px">${capsOfMine.map((c) => `<span class="tool-dep">${esc(c)}</span>`).join('') || '<span class="muted">（没有声明任何能力）</span>'}</div>`;

  // 已配置但未安装的残留配置段：删目录后 config.skills.<id> 还留着。
  // 只在技能页展示一次（两页共用 state，插件页不重复渲染）；
  // 一键清理走 POST /api/skills/cleanup，后端会再次校验"确实未安装"。
  const uninstalledHtml = (kind === 'skill' && (state.uninstalledSkills || []).length)
    ? `<h3 class="usage-h3">已配置但未安装（${state.uninstalledSkills.length}）</h3>
      <div class="hint" style="margin-bottom:6px">这些条目在配置里留着开关/设置，但 <code>skills/</code> 与 <code>plugins/</code> 目录里已经没有对应的文件夹。重装同名插件会自动恢复这些设置；确认不要了可以清理掉。</div>
      <div class="tool-meta" style="gap:6px;margin-bottom:8px">
        ${state.uninstalledSkills.map((u) => `<span class="tool-dep">${esc(u.id)}${u.enabled ? '' : '（已关）'}${u.hasSettings ? ' · 有设置' : ''}</span>`).join('')}
      </div>
      <button class="btn btn-small" id="skills-cleanup-btn">清理这些残留配置</button>`
    : '';

  // 工具条（r95）：compact（会话设置页右栏）只留标题 + 计数 + 一颗「打开完整管理页」——
  // 其余三颗钮的 id 与「下载」页那一份同名，这里不能再来一份（见函数头注释）。
  const headHtml = compact
    ? `<div class="usage-head">
          <h2>${esc(meta.title)}</h2>
          <div class="usage-days">
            <span class="uc-tag" title="生效中 / 这一页的总数">${mine.active} / ${mine.total} 生效</span>
            <button class="btn btn-small" data-mod-fullpage="${esc(kind)}" title="回到「下载」页看完整的管理界面（含去市场 / ＋添加 / 刷新）">打开完整管理页</button>
          </div>
        </div>`
    : `<div class="usage-head">
          <h2>${esc(meta.title)}</h2>
          <div class="usage-days">
            <span class="uc-tag" title="生效中 / 这一页的总数">${mine.active} / ${mine.total} 生效</span>
            <button class="btn btn-small" id="${esc(meta.tab)}-market-btn" title="在应用内浏览市场，点一下就装">去市场</button>
            <button class="btn btn-small" id="${esc(meta.tab)}-create-btn">＋ 添加${meta.kind === 'skill' ? '技能' : '插件'}</button>
            <button class="btn btn-small" id="${esc(meta.tab)}-refresh-btn">刷新</button>
          </div>
        </div>`;

  // r107：一键信任全部 banner —— 当本页存在"因高危能力被拦"的卡时，
  //   在筛选条上方挂一条提示 + 一颗按钮，省得用户挨个点。
  //   在 compact 模式（会话设置 → 扩展 那份）也照样渲染：那边也会显示这些卡。
  //   判据与卡片自己渲染"信任并重试"按钮用的同一条 —— 不可能错挂/漏挂。
  const trustableItems = items.filter((s) => !s.loaded && /触碰了高危能力/.test(String(s.loadError || '')));
  const trustAllBanner = trustableItems.length > 0
    ? `<div class="mod-trust-all">
         <span class="mta-text">有 <b>${trustableItems.length}</b> 个${meta.kind === 'skill' ? '技能' : '插件'}因需要本机能力被拦截</span>
         <button class="btn btn-small btn-primary" id="mod-trust-all-btn">一键信任全部</button>
       </div>`
    : '';

  const html = `<div class="module-split">
    <div class="module-split-left">
      <div class="usage-wrap">
        ${headHtml}
        <!-- 说明折叠条（2026-10-09 r30）：原来这段是常显的 .hint 文字墙，
             技能页 7 行 121px、插件页 5 行 87px（其中 3 行两页逐字相同），
             顶部吃掉了 10~14% 的视口。现在收进原生 <details>，默认收起，
             顶部只留一行摘要 —— 信息一字不丢，两页骨架也因此长得一样。
             用原生 details 而不是自绘折叠：无 JS 参与，键盘/读屏天然可用。 -->
        <details class="module-note">
          <summary>
            <svg class="mn-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.4 2.4 8 6l-3.6 3.6" /></svg>
            <span class="mn-t">${meta.noteSummary}</span>
          </summary>
          <div class="hint mn-body">
            ${meta.lead}<br />
            开关只有这一处 —— 关闭后它注册的工具、提供的能力、提示词片段和请求改写会<b>同时</b>失效。
            不可用时下面会直接写明原因（未启用 / 缺依赖 / 模型不支持 / 加载失败）。
            卡片顺序可以自己排：按住左侧的点阵手柄拖到想要的位置，顺序会记住。<br />
            <b>装新的：把 zip 包或整个文件夹直接拖到这一页</b>（或点右上角「＋ 添加${meta.kind === 'skill' ? '技能' : '插件'}」→ 导入本地文件）。
          </div>
        </details>
        ${trustAllBanner}
        ${filterBar}
        ${grid}
        ${compact ? '' : footer}
        ${compact ? '' : uninstalledHtml}
        ${compact ? '' : `<h3 class="usage-h3">${esc(meta.setupTitle)}</h3>
        <div class="hint">${meta.setupHint}</div>`}
      </div>
    </div>
  </div>`;

  if (box) box.innerHTML = html;
  bindModulePageEvents(kind, box, opts);
  return html;
}

/** 供渲染测试按名取用的两个入口（render-test 会逐个执行这些函数）。 */
function renderSkillsPage() { return renderModulePage('skill'); }
function renderPluginsPage() { return renderModulePage('plugin'); }

/**
 * 绑定一页卡片上的全部交互。
 *
 * @param {'skill'|'plugin'} kind
 * @param {Element} [scopeEl] 渲染容器。不传 = 本页自己的 #skills-page / #plugins-page；
 *        「会话设置」页右栏复用时传它（r95）。
 * @param {{compact?:boolean}} [opts] 与 renderModulePage 同一份 —— 重渲染时要原样带回去。
 */
function bindModulePageEvents(kind, scopeEl, opts) {
  const meta = MODULE_KINDS[kind];
  if (!meta) return;
  const compact = !!(opts && opts.compact);
  /* ⚠️ 绑定范围必须是**本次渲染的那个容器**：
     两个视图（#view-skills / #view-plugins）一直挂在 DOM 里（只是 display 切换），
     而「会话设置」页右栏是第三份 —— 用全局 $ / $$ 会把别的容器命中一遍，
     同一个开关被绑两次，拨一下发两个请求。
     r95 起 id 那几颗钮（刷新 / 去市场 / ＋添加 / 清理残留）一律走 q()：
     compact 版根本没渲染它们，q() 返回 null → 直接跳过，不会再误绑到「下载」页那份。 */
  const scope = scopeEl || $(meta.boxSel);
  if (!scope) return;
  const boxEl = scope;
  const q = (sel) => scope.querySelector(sel);
  // 重渲染：把本次的容器与选项原样带回（不传 → 与 r94 及以前逐字相同）
  const rerender = () => renderModulePage(kind, scopeEl, opts);
  // 整页放置区：把 zip / 文件夹拖进来直接装（绑在容器上，页面重渲染不会丢）
  // ⚠️ compact（会话设置页右栏）不接拖放：拖进来的包装完之后只重画「下载」页那一份，
  //    这一页会停在旧列表上，看着像"没装上"。
  if (!compact) bindModuleDropZone(kind, boxEl);
  q(`#${meta.tab}-refresh-btn`)?.addEventListener('click', () => loadModulePage(kind, { rescan: true }));
  // 「去市场逛逛」（r87）：直接切到应用内市场页 —— 这是最省事的装法，
  // 所以放在「＋ 添加」左边更靠前的位置。
  q(`#${meta.tab}-market-btn`)?.addEventListener('click', () => {
    try { if (typeof switchTab === 'function') switchTab(meta.kind === 'plugin' ? 'pluginmarket' : 'skillmarket'); }
    catch (e) { /* 忽略：切页失败不应打断当前页 */ }
  });
  // 「添加技能/插件」：三个去处 —— 市场 / 导入本地 / 自己造（2026-10-10 r87 改版）。
  q(`#${meta.tab}-create-btn`)?.addEventListener('click', () => openAddModuleModal(kind));
  // 残留配置清理（只在技能页渲染，按钮也只在这一页出现）
  q('#skills-cleanup-btn')?.addEventListener('click', async () => {
    const btn = q('#skills-cleanup-btn');
    if (!btn || !state.uninstalledSkills?.length) return;
    const ids = state.uninstalledSkills.map((u) => u.id);
    // ⚠️（2026-10-10 r86 修 P2）清理配置=删除条目 → danger:true
    if (!await qaConfirm({
      danger: true,
      confirmText: `清理 ${ids.length} 条`,
      message: `清理 ${ids.length} 个未安装条目的配置（${ids.join('、')}）？\n清理后重装同名插件将恢复默认设置。`
    })) return;
    btn.disabled = true;
    try {
      const r = await api('/api/skills/cleanup', { method: 'POST', body: JSON.stringify({ ids }) });
      if (r.config) state.config = r.config;
      // fresh：刚清掉一批残留配置，缓存里那份已经不对了 —— 不能先拿它画一遍再等后台对齐
      await loadModulePage('skill', { fresh: true });
    } catch (e) {
      qaAlert(`清理失败：${e?.message || e}`);
      btn.disabled = false;
    }
  });
  // 注意这里是 $$ （返回数组）不是 $（返回单个元素）：
  // 卡片可能有多个，用 $ 会拿到一个元素然后 .forEach 报错。
  // ⚠️ 绑定范围必须限定在**本页容器内**：两个页面同时存在于 DOM 里（只是 view 切换显隐），
  // 用全局 $$ 会把另一页的卡片也绑一遍 —— 同一个开关被绑两次，一次切换会发两个请求。
  // compact 版多一颗「打开完整管理页」（r95）：关掉全屏页、切到「下载 → 技能 / 插件」。
  // ⚠️ 关页与切页之间必须隔一拍：15-chat-chrome.js 的 sync() 会在微任务里把 tab
  //    还原成"打开全屏页之前那一页"，同一 tick 里的 switchTab 会被它顶掉（r95 实测）。
  //    closeBigPageThen 就是 14-chrome.js 里那份带延时的版本；取不到时退回本地同款实现。
  q('[data-mod-fullpage]')?.addEventListener('click', () => {
    const tab = meta.tab;
    if (typeof window.closeBigPageThen === 'function') { window.closeBigPageThen(tab); return; }
    const back = document.getElementById('bp-back');
    if (back) back.click();
    setTimeout(() => { try { if (typeof switchTab === 'function') switchTab(tab); } catch (e) { /* 忽略 */ } }, 0);
  });
  // 状态筛选（r94）：只切内存里的筛选态后重渲染本页，不重新拉数据、不发请求。
  scope.querySelectorAll('[data-mod-filter]').forEach((b) => {
    b.addEventListener('click', () => {
      MODULE_FILTER[kind] = b.dataset.modFilter;
      rerender();
    });
  });
  // 来源筛选（内置 / 第三方）—— 与状态筛选独立，各自记各自的选中档
  scope.querySelectorAll('[data-mod-src]').forEach((b) => {
    b.addEventListener('click', () => {
      MODULE_SOURCE[kind] = b.dataset.modSrc;
      rerender();
    });
  });
  // 齿轮按钮：卡片里的唯一入口（class 名是 mcard-gear）。
  // ⚠️ 2026-10-21：这里原先还带一个 `.skill-settings-btn`，全仓搜不到任何地方产出这个 class
  //    （HTML/CSS/模板都没有），属于改版后残留的死选择器 —— 已删，别再照着旧代码加回来。
  scope.querySelectorAll('.mcard-gear').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();   // 齿轮在卡片内部，点它不能触发整卡开关
      openSkillSettings(btn.dataset.skillId);
    });
  });
  // 删除：垃圾桶钮 → 二次确认 → DELETE /api/skills/<id>（后端删目录 + 热重扫）。
  // click 与 keydown 都要 stopPropagation：否则点它 / 在上面回车会顺带触发整卡开关。
  scope.querySelectorAll('.mcard-del').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.skillId;
      const name = btn.dataset.skillName || id;
      const isPlugin = btn.dataset.skillKind === 'plugin';
      const kindLabel = isPlugin ? '插件' : '技能';
      const dirLabel = isPlugin ? 'plugins' : 'skills';
      // ⚠️（2026-10-10 r86 修 P2）从磁盘整体移除 → danger:true
      if (!await qaConfirm({
        danger: true,
        confirmText: `删除${kindLabel}`,
        message: `确定删除${kindLabel}「${name}」吗？\n\n它会从磁盘上被整体移除（删除 ${dirLabel}/ 下的整个文件夹），此操作不可恢复。`
      })) return;
      btn.disabled = true;
      try {
        const r = await api(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (r.config) state.config = r.config;
        await loadSkillsStatus();
        rerender();
      } catch (err) {
        qaAlert(`删除失败：${err?.message || err}`);
        btn.disabled = false;
      }
    });
    btn.addEventListener('keydown', (e) => e.stopPropagation());
  });
  // 信任并重试（2026-10-07 新增）：只有「因高危能力被拦」的卡片上才有这个钮。
  // 后端会校验它此刻确实处于该状态（不是万能放行口），登记后立刻 reloadSkills，
  // 用户点完就能看到结果 —— 不用去手改 data/config.json，也不用把闸门整个关掉。
  // r107：抽出 trustPluginInline() 给「卡片点信任」和「一键信任全部」共用。
  // bug fix：原先 `body: { id: dir }` 直接传对象，fetch 行为在不同 Electron 版本里
  //   不一致（有的自动 JSON.stringify 有的把对象 toString 成 "[object Object]"），
  //   后端拿到非 JSON body 就回 "缺少 id"。统一改成 JSON.stringify。
  // 错误文案：把后端"缺少 id / 找不到模块 / 当前不是因高危能力被拦截"等技术错误
  //   翻译成用户能看懂的提示 —— 不暴露 JSON 格式规约。
  async function trustPluginInline(dir) {
    const r = await api('/api/skills/trust', { method: 'POST', body: JSON.stringify({ id: dir }) });
    if (r.config) state.config = r.config;
    return r;
  }
  function translateTrustError(rawMsg) {
    const m = String(rawMsg || '');
    if (m.includes('缺少 id')) return '提交格式异常，请刷新页面后重试。';
    if (m.includes('找不到模块')) return '该插件已被移除，请刷新列表后再试。';
    if (m.includes('当前不是因高危能力')) return '该插件当前不处于"需信任"状态（可能已被自动恢复）。';
    return m || '未知错误';
  }
  // 自动适配（2026-10-19）：把「加载失败 / 熔断中」的模块送去 harness 的
  // 「升级扩展」工作台（self-doctor 前端页，extension-forge 供能力）并自动
  // 起草适配草稿。升级管线 = 复制进暂存区 → 模型按本机环境改 → 五道闸门
  // （带自动修复回路）→ 人工确认 → 备份原版后覆盖安装 → 随时可回滚。
  // 与「信任并重试」的分工：信任管"能力被闸拦下"（人审即可），适配管
  // "代码本身跑不起来"（需要模型动手）。
  async function goAdaptInForge({ kind, dir, name }) {
    const kindLabel = kind === 'plugin' ? '插件' : '技能';
    // 先探 forge 是否可用：没启用就直接告诉用户去哪开，别让用户跳过去看半页空
    try {
      const d = await api('/api/forge/installed', { timeoutMs: 10000 });
      if (d && d.available === false) {
        qaAlert(`自动适配由「扩展锻造台」插件提供 —— 它当前未启用。\n\n去「下载 → 已安装 → 插件」找到 extension-forge 并启用，然后回来点这个「自动适配」。`);
        return;
      }
    } catch { /* 探测失败继续跳 —— 升级页内部还有一层未启用提示兜底 */ }
    if (typeof switchTab !== 'function' || typeof switchDoctorSub !== 'function' || typeof runUpgradeStart !== 'function') {
      qaAlert('升级扩展工作台不可用（前端脚本可能不是最新），请刷新页面后重试。');
      return;
    }
    switchTab('harness');                    // 切到排障工作台（同步重绘出容器）
    switchDoctorSub('upgrade');              // 切到「升级扩展」子页（同步）
    runUpgradeStart(kind, dir);              // 直接对该模块起草适配草稿（异步，busy 横幅自会显示）
    try { window.scrollTo?.({ top: 0, behavior: 'smooth' }); } catch { /* 忽略 */ }
  }
  scope.querySelectorAll('.mcard-adapt').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();                   // 不触发整卡开关
      goAdaptInForge({
        kind: btn.dataset.skillKind || 'plugin',
        dir: btn.dataset.skillDir || btn.dataset.skillId,
        name: btn.dataset.skillName || btn.dataset.skillId
      }).catch((err) => qaAlert(`跳转失败：${err?.message || err}`));
    });
    btn.addEventListener('keydown', (e) => e.stopPropagation());
  });
  scope.querySelectorAll('.mcard-trust').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.skillId;
      const dir = btn.dataset.skillDir || id;
      const name = btn.closest('.mcard')?.querySelector('.mcard-name')?.textContent || id;
      // r107：把"config.trustedPlugins 里的「xxx」"这种技术细节摘掉，
      //   改成"加入信任名单"一句话讲清楚后果 —— 用户不关心配置字段名。
      const ok = await qaConfirm(
        `信任「${name}」并允许它使用本机能力吗？\n\n`
        + `它会读取文件、调用进程、访问网络 —— 与本程序同进程运行，\n`
        + `意味着它能碰到你机器上的一切。请只在确认来源可信时点确定。\n\n`
        + `加入信任名单后，下次启动会自动放行，不用再问。`
      );
      if (!ok) return;
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = '信任中…';
      try {
        const r = await trustPluginInline(dir);
        await loadSkillsStatus();
        rerender();
        // 成功时不需要额外提示 —— renderModulePage 之后卡片自己就从
        // "加载失败" 变回可用了，那就是反馈。（本项目只有阻塞式对话框，
        // 没有 toast；为一个成功态弹窗反而是干扰。）
        if (r.stillFailing) qaAlert(`已记入信任名单，但仍然加载失败：\n${r.stillFailing}`);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = old;
        qaAlert(`信任失败：${translateTrustError(err?.message || err)}`);
      }
    });
    btn.addEventListener('keydown', (e) => e.stopPropagation());
  });
  // 一键信任全部（r107）：与卡片级「信任并重试」共用 trustPluginInline + translateTrustError。
  // ⚠️ 必须用**全量** items 算 trustable（不能用 DOM 里的 .mcard-trust 钮来代算）：
  //   筛选条停在「生效 / 已关」时，被拦的卡根本没渲染出来 → 钮为 0 颗，
  //   却仍按 banner 文案提示"已信任 N 个"，造成"点了没反应"的错觉。
  //   所以这里原样重算一遍（判据与 banner、与卡片按钮同一条正则），保证对得上。
  const allTrustBtn = q('#mod-trust-all-btn');
  if (allTrustBtn) {
    allTrustBtn.addEventListener('click', async () => {
      const allItems = (state.skills || []).filter((s) => s.kind === meta.kind || (s.kind == null && meta.kind === 'skill'));
      const trustable = allItems.filter((s) => !s.loaded && /触碰了高危能力/.test(String(s.loadError || '')));
      if (!trustable.length) return;
      const kindLabel = meta.kind === 'skill' ? '技能' : '插件';
      const ok = await qaConfirm(
        `确认信任这 ${trustable.length} 个${kindLabel}并允许它们使用本机能力吗？\n\n`
        + `它们会读取文件、调用进程、访问网络 —— 与本程序同进程运行，\n`
        + `意味着它们能碰到你机器上的一切。请只在确认来源可信时继续。\n\n`
        + `加入信任名单后，下次启动会自动放行，不用再问。`
      );
      if (!ok) return;
      allTrustBtn.disabled = true;
      allTrustBtn.textContent = '信任中…';
      let failed = 0;
      try {
        // 单条失败不中断其余：用户可能手滑装了同名残留，逐条信任更稳妥。
        for (const s of trustable) {
          const dir = s.dir || s.id;
          try { await trustPluginInline(dir); }
          catch (e) { failed++; }
        }
        await loadSkillsStatus();
        rerender();
        if (failed) qaAlert(`有 ${failed} 个信任失败（可能已被移除或已自动恢复），其余已加入信任名单。`);
      } catch (err) {
        allTrustBtn.disabled = false;
        allTrustBtn.textContent = '一键信任全部';
        qaAlert(`信任失败：${translateTrustError(err?.message || err)}`);
      }
    });
  }
  // 上传到市场：入口已收进「设置」弹窗（卡片上不再放 ⬆ 钮）。
  // ── 切换启停：点滑块开关 或 点卡片其余区域（保留旧习惯）。
  // 两者共用同一条请求链；开关上的 click 会 stopPropagation，避免卡片再触发一次。
  const toggleModule = async (id, next, busyEl) => {
    const cur = (state.skills || []).find((s) => s.id === id);
    if (!cur || !cur.loaded) return;   // 加载失败的条目切不动
    busyEl.style.pointerEvents = 'none';
    if (busyEl instanceof HTMLInputElement) busyEl.dataset.pending = '1';
    try {
      const r = await api(`/api/skills/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: JSON.stringify({ enabled: next })
      });
      const idx = (state.skills || []).findIndex((s) => s.id === id);
      if (idx >= 0 && r.skill) state.skills[idx] = r.skill;
      if (r.config) state.config = r.config;
      await loadSkillsStatus();
      rerender();
    } catch (err) {
      qaAlert(`切换失败：${err.message}`);
      busyEl.style.pointerEvents = '';
      if (busyEl instanceof HTMLInputElement) delete busyEl.dataset.pending;
    }
  };
  scope.querySelectorAll('input[data-skill-toggle]').forEach((sw) => {
    // label 一并拦下：点 label 的 click 目标是 label 本身，不拦会冒泡成"整卡开关"
    sw.closest('.mcard-sw')?.addEventListener('click', (e) => e.stopPropagation());
    sw.addEventListener('change', () => toggleModule(sw.dataset.skillToggle, sw.checked, sw));
  });
  // 键盘可达：Enter/Space 同样触发（role=button + tabindex=0）。
  scope.querySelectorAll('.mcard').forEach((cardEl) => {
    const toggle = () => {
      const sw = cardEl.querySelector('input[data-skill-toggle]');
      if (sw && !sw.disabled && !sw.dataset.pending) toggleModule(cardEl.dataset.skillId, !sw.checked, cardEl);
    };
    cardEl.addEventListener('click', toggle);
    cardEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
  // 拖拽排序：放在最后 —— 它要读 grid 里最终的卡片顺序
  setupCardDrag(scope, kind);
}

// 工具分类的顺序与名字提到模块级：buildToolCategoryHTML（局部刷新共用）
// 和 renderToolsSection（整页渲染）必须读到同一份定义。
// 工具分类：KNOWN_TOOL_CATEGORIES 只决定「已知分类的先后排序」。
// 实际渲染哪些块由「已注册工具里真实出现的分类」决定 —— 新增插件只要
// registerTool 用了合法 category，设置页就自动出现对应分类块，无需回来改这里（保证插件通用性）。
// 旧版这里写死 6 类，漏了 media/knowledge/utility，导致这些分类下的工具在设置页完全不可见、也无法开关。
const KNOWN_TOOL_CATEGORIES = ['messaging', 'sticker', 'query', 'memory', 'web', 'system', 'media', 'knowledge', 'utility', 'model', 'message', 'fun'];
const TOOL_CATEGORY_NAMES = {
  messaging: '💬 消息发送',
  sticker: '😀 表情管理',
  query: '🔍 消息查询',
  memory: '🧠 记忆系统',
  web: '🌐 联网搜索',
  system: '⚙️ 系统反馈',
  media: '🖼️ 媒体理解',
  knowledge: '📚 知识库',
  utility: '🧰 实用工具',
  model: '🤖 模型相关',
  message: '💭 消息增强',
  fun: '🎉 趣味'
};
// 由实际已注册工具派生分类顺序：已知分类在前（按 KNOWN 顺序），未来插件用到的未知分类追加在末尾，保证不丢。
function resolveToolCategoryOrder(tools) {
  const actual = new Set((tools || []).map((t) => t.category).filter(Boolean));
  const ordered = KNOWN_TOOL_CATEGORIES.filter((c) => actual.has(c));
  for (const c of actual) if (!KNOWN_TOOL_CATEGORIES.includes(c)) ordered.push(c);
  return ordered;
}

/**
 * 生成单个分类块（.tool-category）的 HTML。整页渲染与局部刷新共用这一份：
 * 07-settings-events.js 的 refreshToolCategory 在分类总开关/折叠展开时只替换
 * 这一个块（整页 innerHTML 重建在软件渲染下是肉眼可见的闪烁），
 * 两处渲染不同源就会出现"点一下开关 DOM 结构变样"的怪象。
 */
function buildToolCategoryHTML(cat) {
  const c = state.config;
  const toolsCfg = c.tools || {};
  const tools = state.toolRegistry || [];
  const catTools = tools.filter((t) => t.category === cat);
  if (!catTools.length) return '';
  // 分类总开关：关 = 整类工具全部停用（后端本来就按 categories[cat] 拦，
  // 这里补的是**视觉**：子开关要跟着显示成关、且不可拨，而不是"开着却没生效"）。
  const catEnabled = toolsCfg.categories?.[cat] !== false;
  const expandedCategories = state.expandedToolCategories || new Set(['messaging']);
  const isExpanded = expandedCategories.has(cat);

  const toolCards = isExpanded ? catTools.map((t) => {
    const enabled = toolsCfg.overrides?.[t.id] ?? t.defaultEnabled ?? true;
    const disabledByDep = (t.requiresVision && c.api?.vision === false) || (t.requiresSearch && c.webSearch?.enabled === false);
    // 功能名字 + 一句话概括
    const funcName = t.id.split(':').pop(); // 去掉插件前缀
    const summary = t.description.split('。')[0] + '。'; // 第一句话
    // send_to 的开关就是「跨会话发送」本身（tools.crossChatSend）：
    // 开关收编进消息发送分类，用户在工具卡上直接控制，不再单独设全局勾选框。
    const isSendTo = t.id === 'send_to';
    const ownChecked = isSendTo ? (toolsCfg.crossChatSend === true) : enabled;
    // 2026-10-20 补「两层开关互指」：send_image / search_images 除了这里的工具开关，
    //   还受 security.imageSend.enabled 这个安全总开关管。总开关被显式关掉（false）时，
    //   卡片开着也白开 —— 与其等模型调用失败再报错，不如在用户第一次看到这张卡时就说明。
    //   注意 2026-10-23 起该总开关默认开启，只有显式 false 才需要提示。
    const needsImageSend = (t.id === 'send_image' || t.id === 'search_images')
      && ((c.security || {}).imageSend || {}).enabled === false;
    // 实际生效 = 自己开着 **且** 分类总开关开着；总开关关时子开关显示关 + disabled
    const checked = catEnabled && ownChecked;
    return `
        <div class="tool-card ${checked ? 'enabled' : 'disabled'} ${disabledByDep ? 'dep-disabled' : ''}" data-tool-id="${t.id}">
          <div class="tool-header">
            <span class="tool-switch-wrap">
              <label class="tool-switch">
                <input type="checkbox" class="tool-checkbox sw" data-tool-id="${t.id}" ${isSendTo ? 'data-cross-chat="1"' : ''} ${checked ? 'checked' : ''} ${(!catEnabled || (disabledByDep && !isSendTo)) ? 'disabled' : ''} />
              </label>
            </span>
            <span class="tool-icon">${t.icon}</span>
            <div class="tool-title">
              <div class="tool-name">${esc(funcName)}</div>
              <div class="tool-summary">${esc(summary)}</div>
            </div>
          </div>
          <div class="tool-meta">
            ${t.requiresVision ? '<span class="tool-dep">需要视觉模型</span>' : ''}
            ${t.requiresSearch ? '<span class="tool-dep">需要搜索服务</span>' : ''}
            ${disabledByDep ? '<span class="tool-dep-warn">依赖未满足</span>' : ''}
            ${isSendTo ? '<span class="tool-dep">目标须在白名单内</span>' : ''}
            ${needsImageSend ? '<span class="tool-dep-warn">还需在 聊天 →「📨 信息发送配置」勾选「允许机器人发送网图」，否则调用会被拒绝</span>' : ''}
          </div>
        </div>`;
  }).join('') : '';

  return `
      <div class="tool-category ${isExpanded ? 'expanded' : 'collapsed'}" data-category="${cat}">
        <div class="tool-category-header" data-category="${cat}">
          <span class="tool-category-arrow">${isExpanded ? '▼' : '▶'}</span>
          <!-- R76：不要在这里写 inline onclick —— CSP script-src 'self' 会把它拦下
               （日志里 4 条 Refused to execute inline event handler 就是它），
               且 07-settings-events.js 的委托监听已做了同样的阻止冒泡。 -->
          <label class="tool-category-toggle">
            <input type="checkbox" class="category-checkbox sw" data-category="${cat}" ${catEnabled ? 'checked' : ''} />
            <span class="tool-category-name">${TOOL_CATEGORY_NAMES[cat] || cat}</span>
            <span class="tool-category-count">${catTools.length} 个工具</span>
          </label>
        </div>
        ${isExpanded ? `<div class="tool-list">${toolCards}</div>` : ''}
      </div>`;
}

function renderToolsSection(c) {
  // 按分类分组（只用来决定哪些分类要渲染；块内逻辑在 buildToolCategoryHTML）
  const tools = state.toolRegistry || [];
  const toolsCfg = c.tools || {};
  // 动态派生：已注册工具实际用了哪些分类，就渲染哪些分类块（插件通用性）
  const categories = resolveToolCategoryOrder(tools);

  const categoryCards = categories.map((cat) => buildToolCategoryHTML(cat)).join('');

  // 完整提示词预览（文本统一走 renderPromptPreviewText，见其注释）

  // 页面级左右分栏：左=标题/开关/工具卡（随滚动），右=整块预览（钉住）。
  // 标题与说明全部在左半边，不进右栏。
  return `
    <div class="module-split">
      <div class="module-split-left">
        <h3 id="settings-tools">能力与工具</h3>
        <div class="hint" style="margin-bottom:16px">
          勾选启用机器人可调用的工具。禁用后模型将无法使用该功能。
          当前已注册 ${tools.length} 个工具（含技能/插件注册的工具），
          技能与插件的启用 / 禁用统一在「会话设置 → 扩展」页管理（全局生效）。
          ${toolsCfg.enabled === false ? '<span style="color:var(--red)">⚠️ 全局开关已关闭，所有工具均不可用</span>' : ''}
        </div>
        <div class="field">
          <label class="tool-global-toggle">
            <input type="checkbox" class="sw" id="cfg-tools-enabled" ${toolsCfg.enabled !== false ? 'checked' : ''} />
            <span>启用工具系统（关闭后机器人只能看不能做任何操作）</span>
          </label>
        </div>
        <div class="tool-actions" style="margin-bottom:16px;display:flex;gap:8px">
          <button class="btn btn-small" id="tools-enable-all">全部启用</button>
          <button class="btn btn-small" id="tools-disable-all">全部禁用</button>
          <button class="btn btn-small" id="tools-reset">恢复默认</button>
          <!-- 2026-10-20：浏览锁定 / 内网图片 / 外部链接白名单三项只有配置项、
               此前没有任何界面入口（见 09-community.js openSecurityModal 注释）。
               放在这一页是因为它们限定的正是"工具能碰到什么"，与上面的开关同一层语义。 -->
          <button class="btn btn-small" id="tools-security">🛡 安全开关</button>
        </div>
        ${categoryCards}
      </div>
      <div class="module-split-right">
        <div class="prompt-preview-card tools-preview-card">
          <div class="prompt-preview-title">📝 完整提示词预览</div>
          <div class="prompt-preview-hint">按当前的插件/技能/工具开关实时组装（没开的不会出现）：</div>
          <pre class="prompt-preview-content">${esc(renderPromptPreviewText())}</pre>
        </div>
      </div>
    </div>`;
}

/**
 * 「媒体工具」分区（2026-11-03）。
 *
 * ffmpeg 不再随安装包分发（79MB，安装包从 186.3MB 降到约 107MB），改为这里
 * 按需下载到 data/runtime/ffmpeg/bin/。它只服务四项：大图压缩、GIF 转视频、
 * 视频抽帧、动态壁纸导入 —— 没下载时这四项各自降级，不影响启动与纯文字聊天。
 *
 * 页面结构：状态条 → 安装指引（按平台） → 未安装时的说明 → 下载/进度 → 下载源 → 手动路径。
 * 状态是异步拉的（GET /api/ffmpeg/status），首帧先渲染占位，
 * bindSettingsEvents 里的 ffmpegRefresh() 拉到后**只更新这块文字与按钮态**，
 * 不重建表单（与「连接 QQ」的 qbRefresh 同一套做法）。
 *
 * 平台差异（2026-11-03）：ffmpeg 从"只有 Windows 能程序内下载"扩到全平台后，
 * 同一个区块在不同系统上该给的东西完全不同 —— macOS 没有可靠的免编译二进制，
 * 给 brew 命令；Linux 首选发行版包管理器，下载只是兜底。这些数据都来自
 * /api/ffmpeg/status 的 installGuide / canAutoInstall，本函数是纯同步渲染，
 * 拿不到 → 安装指引区首帧保持 hidden 占位，由 paint() 异步注入。
 *
 * ⚠️ 高级折叠区里那四节（下载 / 下载源 / Token / 删除）只能靠标题上的
 *    `.ffmpeg-dl-only` 整卡隐藏，不能只藏外层 `#ffmpeg-adv`：settingsCards()
 *    按**顶层** <h3> 切卡，切分点落在折叠区中间，外层 div 会被 </section>
 *    提前闭合，于是四个小节各自成了独立卡片。
 * ⚠️ 本模板内不要写含 `<h3` 字样的 HTML 注释 —— settingsCards() 的切分正则
 *    不认注释边界，会把注释里的文本切成一张空卡片。
 */
function renderMediaSection(c) {
  const m = c.media || {};
  const mirror = String(m.downloadMirror || 'yylx');
  const source = String(m.ffmpegSource || '');
  const tokenHint = m.hasGithubAccessToken ? '已保存（不显示）' : '';
  // 平台相关的文案在首帧无从得知（状态是异步拉的），先用 Windows 口径渲染，
  // paint() 拿到 platform 后会把两处文案与 macOS 要隐藏的区块一起修正。
  return `
    <h3 id="settings-media">ffmpeg（视频与图片处理）</h3>
    <!-- 状态条：已安装时只陈述事实，不摆一个大按钮；未安装时才出现主行动按钮。
         「下载并安装」在已装状态下不是主路径（用户已经有能用的 ffmpeg 了），
         放在这里只会制造"我是不是还缺什么"的错觉。 -->
    <div class="sl-quickbar" id="ffmpeg-statusbar">
      <span class="sl-quickbar-text" id="ffmpeg-status-text">正在读取 ffmpeg 状态…</span>
      <button class="btn btn-small btn-primary" id="ffmpeg-download-btn" hidden disabled>下载并安装</button>
      <span class="sl-hint" id="ffmpeg-progress-hint"></span>
    </div>
    <!-- 安装指引（按平台）：内容依赖 /api/ffmpeg/status，首帧只能是空占位。
         paint() 拿到 installGuide 后才填内容并取消 hidden；Windows 上
         installGuide 为 null，这块永远不出现（Windows 的安装路径就是下面的下载按钮）。 -->
    <div id="ffmpeg-install-guide" style="margin-bottom:14px" hidden></div>
    <div class="hint" style="margin-bottom:14px">
      ffmpeg 是一个外部工具，负责四项功能：<b>大图压缩</b>（群友发的大图先缩到模型能接受的尺寸）、
      <b>GIF 转视频</b>、<b>视频抽帧</b>（让只能看图的模型也能理解视频）、<b>动态壁纸导入</b>。
      没有它时这四项各自降级 —— 不报错，但也用不了；聊天与其它功能完全不受影响。
    </div>
    <div class="hint" id="ffmpeg-proxy-line" style="margin-bottom:14px" hidden></div>

    <h3>优先使用哪一个</h3>
    <div class="field">
      <label>如果你系统里已经装过 ffmpeg，可以直接用它，不必再下载一份</label>
      <div class="checkbox-row"><input type="radio" name="cfg-ffmpeg-source" id="cfg-ffmpeg-source-auto" value="" ${source === '' ? 'checked' : ''} />
        <label for="cfg-ffmpeg-source-auto">自动（手填路径 → 下载的 → 系统安装）</label></div>
      <div class="checkbox-row"><input type="radio" name="cfg-ffmpeg-source" id="cfg-ffmpeg-source-managed" value="managed" ${source === 'managed' ? 'checked' : ''} />
        <label for="cfg-ffmpeg-source-managed">优先用「下载并安装」装的那份</label></div>
      <div class="checkbox-row"><input type="radio" name="cfg-ffmpeg-source" id="cfg-ffmpeg-source-system" value="system" ${source === 'system' ? 'checked' : ''} />
        <label for="cfg-ffmpeg-source-system" id="cfg-ffmpeg-source-system-label">优先用系统里自己装的（PATH / winget）</label></div>
      <div class="checkbox-row"><input type="radio" name="cfg-ffmpeg-source" id="cfg-ffmpeg-source-manual" value="manual" ${source === 'manual' ? 'checked' : ''} />
        <label for="cfg-ffmpeg-source-manual">优先用下面手填的路径</label></div>
      <div class="hint" id="cfg-ffmpeg-source-hint">正在扫描本机可用的 ffmpeg…</div>
      <div class="hint">这只是调换顺序，不是"只用这一个"：优先的那一档找不到时，仍会按其余顺序继续找。</div>
    </div>

    <h3>手动指定路径</h3>
    <div class="field">
      <label for="cfg-ffmpeg-path">ffmpeg 可执行文件</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-ffmpeg-path" value="${esc(m.ffmpegPath || '')}" placeholder="留空 = 自动探测（下载的 / 系统 PATH）" autocomplete="off" style="flex:1" />
        <button class="btn btn-small" type="button" id="cfg-ffmpeg-test">测试</button>
      </div>
      <div class="hint" id="cfg-ffmpeg-path-hint">自己装过 ffmpeg 的话，把 ffmpeg.exe 的完整路径填这里，会优先使用它。</div>
      <div class="hint" id="cfg-ffmpeg-test-hint"></div>
    </div>

    <button class="btn btn-small" type="button" id="ffmpeg-adv-toggle" aria-expanded="false" aria-controls="ffmpeg-adv">高级：下载与安装设置</button>
    <div id="ffmpeg-adv" class="fold-sub folded"><div class="fold-sub-inner">
      <h3 class="ffmpeg-dl-only">下载</h3>
      <div class="field">
        <button class="btn btn-small" type="button" id="ffmpeg-download-btn-adv" disabled>下载并安装</button>
        <span class="hint" id="ffmpeg-download-hint" style="margin-left:8px"></span>
        <div class="hint" style="margin-top:6px">下载到数据目录，不写系统 PATH；装完立即生效，不必重启。</div>
      </div>

      <h3 class="ffmpeg-dl-only">下载源</h3>
      <div class="field">
        <label>从哪里下载</label>
        <div class="checkbox-row"><input type="radio" name="cfg-ffmpeg-mirror" id="cfg-ffmpeg-mirror-yylx" value="yylx" ${mirror === 'yylx' ? 'checked' : ''} />
          <label for="cfg-ffmpeg-mirror-yylx">git.yylx.win 镜像加速（默认，不需要代理）</label></div>
        <div class="checkbox-row"><input type="radio" name="cfg-ffmpeg-mirror" id="cfg-ffmpeg-mirror-ghproxy" value="gh-proxy" ${mirror === 'gh-proxy' ? 'checked' : ''} />
          <label for="cfg-ffmpeg-mirror-ghproxy">gh-proxy 镜像加速（备选，不需要代理）</label></div>
        <div class="checkbox-row"><input type="radio" name="cfg-ffmpeg-mirror" id="cfg-ffmpeg-mirror-direct" value="direct" ${mirror === 'direct' ? 'checked' : ''} />
          <label for="cfg-ffmpeg-mirror-direct">GitHub 官方地址（国内通常很慢或超时）</label></div>
        <div class="checkbox-row"><input type="radio" name="cfg-ffmpeg-mirror" id="cfg-ffmpeg-mirror-custom" value="custom" ${mirror === 'custom' ? 'checked' : ''} />
          <label for="cfg-ffmpeg-mirror-custom">自定义加速前缀</label></div>
        <div id="ffmpeg-mirror-sub" class="fold-sub${mirror === 'custom' ? '' : ' folded'}"><div class="fold-sub-inner">
          <input type="text" id="cfg-ffmpeg-mirror-custom" value="${esc(m.customMirror || '')}" placeholder="例如 https://git.yylx.win/" autocomplete="off" />
          <div class="hint">前缀会拼在官方地址前面，最终形如 <code>前缀</code> + <code>https://github.com/GyanD/codexffmpeg/releases/download/…</code>。</div>
        </div></div>
        <div class="hint">
          <b>检测到代理时会自动改走官方直连</b>（镜像本来就是替代代理用的，代理 + 镜像等于多绕一跳）。
          下载的文件一律做 SHA-256 校验，校验值写死在程序里，换任何源都不影响安全性 ——
          某个镜像站挂了或限速，换个源再试即可。
        </div>
      </div>

      <h3 class="ffmpeg-dl-only">GitHub Token（可选）</h3>
      <div class="field">
        <label for="cfg-ffmpeg-ghtoken">访问令牌</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-ffmpeg-ghtoken" value="${m.hasGithubAccessToken ? '******' : ''}" placeholder="${tokenHint || '不填也能下载'}" autocomplete="off" style="flex:1" />
          <button class="btn btn-small" type="button" id="cfg-ffmpeg-ghtoken-toggle">显示</button>
        </div>
        <div class="hint">用于代理节点是共享出口 IP 时绕开 GitHub 的按 IP 限流（未认证 60 次/小时，带 Token 5000 次/小时）。只发给 GitHub 自己的主机，<b>不会</b>发给下载镜像站。</div>
      </div>

      <h3 class="ffmpeg-dl-only">已下载的文件</h3>
      <div class="field">
        <button class="btn btn-small" type="button" id="cfg-ffmpeg-remove" disabled>删除已下载的 ffmpeg</button>
        <span class="hint" id="cfg-ffmpeg-remove-hint" style="margin-left:8px"></span>
        <div class="hint" style="margin-top:6px">只删除「下载并安装」装到数据目录的那份，不会动你系统里自己装的 ffmpeg。</div>
      </div>
    </div></div>`;
}

/**
 * 完整提示词预览文本（设置-工具与技能 & 技能页右侧共用同一份）。
 * 数据来自 GET /api/prompt-preview —— 后端用运行时同一套
 * buildSystemPrompt + getToolAvailability 组装，按当前启停状态实时反映；
 * 前端不再自己拼（曾经前端复制了一份静态模板，永远是"全启用"的样子，
 * 与实际发送的提示词越漂越远）。
 * 后端返回结果缓存在 state.promptPreview；render* 渲染时同步取，
 * 开关变动后由 refreshPromptPreview() 异步拉新并原地更新 DOM。
 */
function renderPromptPreviewText() {
  const d = state.promptPreview;
  if (!d || typeof d.systemPrompt !== 'string') return '（正在加载提示词预览…）';
  const tools = d.tools || [];
  const toolLines = tools.length
    ? tools.map((t) => `- ${t.id}：${t.description}`).join('\n')
    : '（当前没有可用工具）';
  // ⚠️ 方案 A（2026-10-11）：易变片段（思考模式/系统自检/开发模式）已从系统提示
  //    拆出、实际拼在**用户提示词末尾**。预览里把它们单独列一段并注明去向，
  //    否则用户会以为"这些说明怎么没有了"。
  const volatile = typeof d.volatileNote === 'string' && d.volatileNote.trim()
    ? `\n\n【以下内容实际拼在用户提示词末尾（不进系统提示，保前缀缓存命中）】\n${d.volatileNote}`
    : '';
  return `${d.systemPrompt}${volatile}\n\n【本次可用工具清单（function calling）】\n${toolLines}`;
}

/**
 * 拉取/刷新提示词预览。
 * 实时性设计（2026-09-17）：预览读的是**后端活配置**（getConfig），而设置的
 * 自动保存有 600ms 防抖 —— 直接刷看到的是旧状态。所以本函数可带 overrides
 * （与配置同结构的临时补丁）：请求发给 /api/prompt-preview，后端先深合并补丁
 * 再组装（不落盘），预览即刻反映刚点的开关，不用等自动保存落地。
 */
async function refreshPromptPreview(overrides = null) {
  try {
    // 空对象不附 body（GET 语义）——没有补丁就按后端活配置组装
    const hasOverrides = overrides && Object.keys(overrides).length > 0;
    const d = await api('/api/prompt-preview', hasOverrides ? {
      method: 'POST',
      body: JSON.stringify(overrides)
    } : {});
    state.promptPreview = d;
  } catch {
    state.promptPreview = null;
  }
  // 两处预览 DOM（设置-工具页 / 技能页右侧）都原地换文本，不整页重渲染
  $$('.prompt-preview-content').forEach((pre) => {
    pre.textContent = renderPromptPreviewText();
  });
}
