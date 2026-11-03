// 〔启动引导 / OOBE〕
'use strict';

/* ══════════════════════════════════════════════════════════════════════
   启动引导（OOBE，Out-Of-Box Experience）

   解决的问题：群友多次反馈新手不知道从哪下手。
   旧方案是"配置没配好就 switchTab('settings') 后 return"，被「每次点开都在
   设置界面，我要的是直接进会话」否决后整段移除，只剩右下角横幅 + 顶栏 4 个
   就绪圆点，对从没配过的新用户仍然不够：圆点不会说话，横幅只在 OneBot 未连接时出现。

   四条设计约束：
     ① 不拦截、不跳转：全屏遮罩可随时关掉，关掉照常进会话页；
     ② 不烦人：只在「从没看过引导」或「引导改版」时自动弹一次；
         "跳过"与"开始使用"都会写 config.onboarding.seen；
     ③ 步骤状态与实时数据同源：完成态口径与就绪圆点/体检（assessReadiness）
         逐条一致，打开期间每 2s 跟随底层状态刷新（OneBot 可能刚连上）；
     ④ 保留手动入口：设置页侧栏「使用引导」，想回来看随时能看。

   触发判定：config.onboarding 缺字段 / seen=false / version 低于本文件
   ONBOARDING_VERSION → 下次启动自动展示。
   ══════════════════════════════════════════════════════════════════════ */

// 引导内容版本号。改版（增删步骤、改文案结构）时 +1，老用户升级后会重新看一版。
const ONBOARDING_VERSION = 1;

/** 步骤定义。done/status 每次渲染现算，引导开着的时候用户可能刚配好一项。 */
function onboardingSteps() {
  const cfg = state.config || {};
  const st = state.status || {};
  const api = cfg.api || {};
  const urlOk = !!String(api.baseUrl || '').trim();
  const modelOk = !!String(api.model || '').trim();
  // 白名单口径与就绪圆点（01-boot.js updateReadinessDots）逐条一致：
  // 有群 / 有好友 / 或显式开了"白名单为空时响应所有人"都算配过。
  const allowOk = !!((cfg.allow?.groups?.length || cfg.allow?.private?.length || cfg.allowAllWhenEmpty));
  const obOk = !!st.onebot?.connected;
  // 人设步骤的"完成"口径：用现成模板（含内置默认的小鲸鱼）不算自定义。
  // 刚装完时 persona.roleText 就是内置文本，按"有文本就算"判会把它标成
  // 「已自定义」还打勾，既误导又让"四步全绿"失去意义。
  // 模板列表没加载时保守判"未自定义"，不误报。
  const roleText = String(cfg.persona?.roleText || '').trim();
  const tplList = Object.values(state.personaTemplates || {});
  const tplHit = tplList.find((p) => String(p.text ?? '').trim() === roleText);
  const personaOk = tplList.length > 0 ? (!!roleText && !tplHit) : false;
  const personaStatus = tplHit ? `使用「${tplHit.name}」` : (personaOk ? '已自定义' : '使用默认人设');
  // 第 5 步（验证）的完成判据：机器人真的在群里发过话，state.sessions 里
  // 有 sent（已发送到 QQ 的条目）。四步全绿只说明"配置齐了"，不说明"能说话"：
  // 响应档位停在「仅艾特」/ 左栏「自动回复」被关时，配置再全群里也没动静。
  // repliedCount 曾被一次合并连带删掉，第 5 步的 done / status 还在用它，
  // 引导一渲染就 ReferenceError，别再去删。
  const repliedCount = (state.sessions || []).filter((s) => Array.isArray(s.sent) && s.sent.length > 0).length;
  const preOk = urlOk && modelOk && obOk && allowOk;
  return [
    {
      id: 'model', required: true,
      title: '配一个 AI 模型',
      desc: '先添加一个服务商（接口地址 + API Key），再选一个模型。没有 Key 可以去 DeepSeek 官网申请 —— 按量计费，充多少用多少，不用不花钱。',
      done: urlOk && modelOk,
      status: !urlOk ? '还没填接口地址' : (!modelOk ? '还没选模型' : `已选 ${api.model}`),
      jump: { tab: 'settings', section: 'api' },
      // 点「去配置」直接把「模型管理」弹窗弹出来：只跳到设置页还不够，
      // 萌新会在页面上找不到「模型管理」这颗按钮。弹窗里「＋ 添加提供商」就是
      // 最短路径，关掉弹窗后人还在设置页对应分区，不会迷路。
      open: 'openModelManageModal'
    },
    {
      id: 'qq', required: true,
      title: '把机器人接上 QQ',
      // 文案要跟着跳转目标走：曾经这里写「到「连接与启动」页启动 SnowLuma」，
      // 但按钮跳的是 SnowLuma 页，说的和做的不是一个地方，萌新会在设置页里
      // 找「连接与启动」然后回不来。
      // 协议端解耦后本软件不再自带、也不再启动协议端，流程是
      // 「装一个协议端 → 启动它并登录机器人 QQ → 回连接页看是否连上」，
      // 所以这里分三步、并把"去哪儿装"说清楚（连接页有两张卡：SnowLuma / NapCat）。
      desc: '点「去连接」会打开连接页：① 先按页面上的两张卡装一个协议端（SnowLuma 或 NapCat，二选一）；② 启动它并登录机器人 QQ；③ 回到连接页，状态会自动变成「机器人工作中」。QQ 本身可以在「设置 → 连接 QQ」里一键启动。⚠️ 请用专用小号，不要用你的日常 QQ —— 机器人会以这个号的身份在群里发言。',
      done: obOk,
      status: obOk ? `已连接（${st.onebot?.self?.nickname || '机器人 QQ'}）` : (st.onebot?.diagnosis || '机器人还没连上'),
      jump: { tab: 'connection' }
    },
    {
      id: 'allow', required: true,
      title: '设定响应范围',
      desc: '把要让机器人发言的群 / 好友加进白名单。没加之前它谁都不理 —— 这是防误触的设计，不是坏了。',
      done: allowOk,
      status: allowOk ? `${(cfg.allow?.groups || []).length} 个群 / ${(cfg.allow?.private || []).length} 个好友` : '白名单还是空的',
      jump: { tab: 'settings', section: 'allow' }
    },
    {
      id: 'persona', required: false,
      title: '给它一个性格（可选）',
      desc: '默认人设是「小鲸鱼」—— 说话口语化、简短的 QQ 群友。想换语气、加规则，去「人设与记忆」改。',
      done: personaOk,
      status: personaStatus,
      jump: { tab: 'settings', section: 'persona' },
      // 同模型步骤：直接弹「人设设置」编辑器，省掉在设置页找「⚙ 编辑人设」。
      open: 'openGlobalPersonaModal'
    },
    {
      // 第 5 步「验证」：四步全绿 ≠ 能在群里说话。
      // 「响应档位」停在仅艾特档 / 左栏「自动回复」被关这两种"全绿仍不说话"的情况，
      // 旧引导只字未提，用户进群 @ 没反应就判定"软件坏了"。这一步把验证动作和
      // 两个排查点写进引导，形成闭环。
      id: 'verify', required: false,
      title: '去群里 @ 它一句，确认真的会回话',
      desc: '把它拉进白名单里的一个群，@ 它说句话。有回应就全部搞定了。如果没反应，先看两处：这个群的「响应档位」是不是停在「仅艾特」档（在该群的会话设置里改），以及左栏「自动回复」开关有没有被关掉。',
      done: repliedCount > 0,
      status: !preOk
        ? '先完成上面的必选步骤'
        : (repliedCount > 0 ? `机器人已应答 ${repliedCount} 次` : '还没有应答记录'),
      jump: { tab: 'chats' }
    }
  ];
}

/** 是否需要自动展示：从没看过 / 看过但引导改版了。 */
function onboardingNeedsShow(cfg) {
  const ob = cfg?.onboarding;
  if (!ob || typeof ob !== 'object') return true;                  // 老配置升级：缺字段
  if (ob.seen !== true) return true;                               // 看过但没确认过（点了"去配置"）
  return Number(ob.version || 0) < ONBOARDING_VERSION;             // 引导内容改版
}

/** 写"已看过"。失败不抛：顶多少弹一次，不能堵住用户关引导的手。 */
async function markOnboardingSeen() {
  // 用户明确退出引导（跳过/完成/Esc）→ 守候也撤掉，不再自动弹回
  obPendingStep = null;
  stopPendingWatch();
  const patch = { onboarding: { seen: true, version: ONBOARDING_VERSION } };
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
  } catch { /* 后端没写进去也让本次会话的内置标记跟上，避免同一会话内逻辑分叉 */ }
  if (state.config) state.config.onboarding = { seen: true, version: ONBOARDING_VERSION };
}

/**
 * 「去配置」后的守候轮询：每 2s 看一次目标步骤配好没有，配好就自动接回引导。
 *
 * 萌新点「去配置」跳去设置页，配完那一步后不知道该干嘛了。旧行为是引导彻底消失，
 * 要么自己摸回设置页、要么每次重启再看一遍。现在配好 2 秒内引导自己弹回来
 * （该步打勾 + 高亮闪一下），接着走下一步。
 * 只认 onboardingSteps() 的完成口径，不会误弹；「我先自己看看 / Esc / 开始使用」
 * 走 markOnboardingSeen，会把守候撤掉，不再回来。
 */
function startPendingWatch() {
  if (obPendingTimer) return;
  obPendingTimer = setInterval(() => {
    if (!obPendingStep) { stopPendingWatch(); return; }
    const step = onboardingSteps().find((s) => s.id === obPendingStep);
    if (step && step.done) {
      obHighlight = obPendingStep;
      obPendingStep = null;
      stopPendingWatch();
      openOnboarding();
    }
  }, 2000);
}
function stopPendingWatch() {
  if (obPendingTimer) { clearInterval(obPendingTimer); obPendingTimer = null; }
}

let obOverlay = null;
let obTimer = null;
let obKeyHandler = null;
let obLastSig = null;   // 步骤状态签名：一字不变就不碰 DOM（焦点/悬停态不闪）
let obPendingStep = null;   // 「去配置」之后守候的步骤 id：配好就自动接回引导
let obPendingTimer = null;
let obHighlight = null;     // 刚配好的步骤：回到引导时高亮一下，让用户知道为什么又弹出来了

/** 只重绘步骤状态区（不重建卡片）：按钮焦点不闪、动画不重放。 */
function refreshOnboarding() {
  if (!obOverlay) return;
  const steps = onboardingSteps();
  const allDone = steps.every((s) => s.done || !s.required);
  const sig = JSON.stringify(steps.map((s) => [s.id, s.done, s.status]));
  const box = obOverlay.querySelector('#ob-steps');
  if (box && sig !== obLastSig) {
    obLastSig = sig;
    // 焦点保护：重建前焦点若在某一步的「去配置」上，重建后还回去。
    // 否则整区 innerHTML 重建会把焦点打回 body，之后 Ctrl+V 全部静默失效
    // （同族问题见 closeModelModal 的三重兜底注释）。
    const focusedIdx = document.activeElement?.classList?.contains('ob-step-go')
      ? document.activeElement.dataset.jump : null;
    box.innerHTML = steps.map((s, i) => `
      <div class="ob-step${s.done ? ' done' : ''}" data-step="${s.id}">
        <span class="ob-step-dot" aria-hidden="true">${s.done ? '✓' : i + 1}</span>
        <div class="ob-step-body">
          <div class="ob-step-title">${esc(s.title)}${s.required ? '' : '<span class="ob-step-opt">可选</span>'}</div>
          <div class="ob-step-desc">${esc(s.desc)}</div>
          <div class="ob-step-status${s.done ? ' ok' : ''}">${esc(s.status)}</div>
        </div>
        ${s.done ? '' : `<button class="btn btn-small ob-step-go" data-jump="${i}" type="button">去配置 →</button>`}
      </div>`).join('');
    box.querySelectorAll('.ob-step-go').forEach((btn) => {
      btn.addEventListener('click', () => {
        const step = steps[Number(btn.dataset.jump)];
        // 「去配置」= 接受引导并去行动：不标 seen，关掉引导、跳去目标页，
        // 并挂上守候：该步骤一旦配好（2s 内发现），自动把引导弹回来接着走。
        obPendingStep = step.id;
        startPendingWatch();
        closeOnboarding();
        onboardingJump(step.jump);
        // 带 open 的步骤（模型 / 人设）跳完再把对应弹窗盖上来：只跳到设置页还不够，
        // 萌新会在页面里找不到「模型管理」「⚙ 编辑人设」那颗按钮。
        // 延迟 340ms：等页签切换动画和引导退场都落定，视觉上不打架。
        if (step.open) {
          setTimeout(() => {
            const fn = window[step.open];
            if (typeof fn !== 'function') return;
            try { fn(); } catch (e) { console.warn('[onboarding] 打开配置弹窗失败：', e?.message ?? e); }
          }, 340);
        }
      });
    });
    if (focusedIdx != null) {
      // 原步骤可能刚变绿（按钮消失）→ 顺延到第一个还存在的「去配置」
      const back = box.querySelector(`.ob-step-go[data-jump="${focusedIdx}"]`)
        || box.querySelector('.ob-step-go');
      try { back?.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
  }
  const foot = obOverlay.querySelector('#ob-done-btn');
  if (foot) {
    foot.textContent = allDone ? '🎉 全部就绪，开始使用' : '开始使用';
    foot.classList.toggle('btn-primary', allDone);
  }
}

/** 跳转到步骤目标。settings 需要同时落到指定分区（与健康卡"去设置"同模式）。 */
function onboardingJump(jump) {
  if (!jump) return;
  if (jump.tab === 'settings') {
    state.settingsSection = jump.section || 'api';
    if (state.tab !== 'settings') {
      // switchTab 内部按 state.settingsSection 渲染，不必再手动重绘（避免入场动画重播）
      switchTab('settings');
    } else {
      // 同页：直接重绘到目标分区
      renderSettingsSidebar();
      renderSettings();
    }
  } else {
    switchTab(jump.tab);
  }
}

/**
 * 打开引导。已开着时只刷新状态（手动入口重复点击不叠层）。
 * 自动路径由 onboardingAutoLaunch 调用（仅启动时一次）。
 */
function openOnboarding() {
  if (obOverlay) { obLastSig = null; refreshOnboarding(); return; }
  const overlay = document.createElement('div');
  overlay.className = 'ob-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '使用引导');
  overlay.innerHTML = `
    <div class="ob-card">
      <div class="ob-head">
        <div class="ob-logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M5 20a7 7 0 0 1 14 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div>
          <div class="ob-title">欢迎使用 QQ Agent</div>
          <div class="ob-sub">这是一个跑在你自己电脑上的 QQ 群 AI 机器人。上线前还差几步 —— 每步点「去配置」直接过去，配好了会打勾。</div>
        </div>
      </div>
      <div class="ob-steps" id="ob-steps"></div>
      <div class="ob-foot">
        <button class="btn ob-skip" id="ob-skip-btn" type="button">我先自己看看</button>
        <button class="btn btn-primary" id="ob-done-btn" type="button">开始使用</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  obOverlay = overlay;
  // obLastSig 是跨实例的签名缓存，新建的 overlay 里 #ob-steps 是空 div。
  // 若签名与上次关闭时相同（用户还没配任何东西，状态没变），refreshOnboarding
  // 会以为"没变化"跳过渲染，引导只剩标题和两个按钮。
  // 每次新建弹层都必须让签名失效，强制重绘一次。
  obLastSig = null;

  overlay.querySelector('#ob-skip-btn').addEventListener('click', () => {
    // "跳过" = 明确拒绝引导 → 标记看过，以后不再自动弹。
    markOnboardingSeen();
    closeOnboarding();
  });
  overlay.querySelector('#ob-done-btn').addEventListener('click', () => {
    markOnboardingSeen();
    closeOnboarding();
  });

  // Esc = 跳过（同"我先自己看看"）：捕获阶段拦截，避免连带关掉背后的全屏页。
  obKeyHandler = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    markOnboardingSeen();
    closeOnboarding();
  };
  document.addEventListener('keydown', obKeyHandler, true);

  refreshOnboarding();
  // 从「去配置」守候回来的：给刚配好的步骤闪一下高亮，用户立刻明白为什么引导又出现了
  if (obHighlight) {
    const el = overlay.querySelector(`.ob-step[data-step="${obHighlight}"]`);
    if (el) {
      el.classList.add('just-done');
      setTimeout(() => el.classList.remove('just-done'), 2400);
    }
    obHighlight = null;
  }
  // 引导开着的时候底层状态可能变化（OneBot 刚好连上 / 用户在别的窗口配好了），
  // 2s 一刷，只重绘状态区，不碰按钮焦点。
  obTimer = setInterval(refreshOnboarding, 2000);
}

/** 关闭引导（只做清理）。"标不标 seen"由各按钮自己决定后调用方自行处理。 */
function closeOnboarding() {
  if (obTimer) { clearInterval(obTimer); obTimer = null; }
  if (obKeyHandler) {
    document.removeEventListener('keydown', obKeyHandler, true);
    obKeyHandler = null;
  }
  if (!obOverlay) return;
  const el = obOverlay;
  obOverlay = null;
  el.classList.add('closing');
  const finish = () => el.remove();
  el.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 300);   // 兜底：动画被 reduced-motion 压掉时也能收掉
}

/**
 * 自动展示入口（启动时一次）。
 *
 * 时序：本文件与 11-init.js 同为 defer、按文档序执行，11-init 的 init()
 * 在本文件之前就起步了，但它要等 bootLoop + /api/config 回来才写 state.config。
 * 这里轮询等待（最长 ~10s），不阻塞启动链：
 *   拿不到 config（启动异常）→ 不弹，交给横幅 + 就绪圆点，那也是它们的本职。
 */
(async function onboardingAutoLaunch() {
  for (let i = 0; i < 50; i++) {
    if (state.config) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!state.config) return;
  if (onboardingNeedsShow(state.config)) openOnboarding();
})();

// 手动入口（设置页侧栏「使用引导」按钮）挂全局，供 06-settings-render.js 调用。
window.openOnboarding = openOnboarding;

/**
 * 「该步骤已处理」信号，由配置弹窗在关闭时调用。
 *
 * 守候轮询只认"状态达成"，而可选步骤（人设）会出现"处理过但状态没变"的情况：
 * 用户选回原版默认人设保存，roleText 与模板一致，判定仍是未自定义，
 * 守候永远不触发，保存完引导也不回来。
 * 对可选步骤，"打开并关闭了配置弹窗"本身就是处理完毕的信号。
 *
 * 仅在守候的正是该步骤时生效；手动打开弹窗（不在引导流程里）不受影响。
 */
window.qaOnboardingStepTouched = (stepId) => {
  if (!stepId || obPendingStep !== stepId) return;
  obHighlight = stepId;
  obPendingStep = null;
  stopPendingWatch();
  openOnboarding();
};
