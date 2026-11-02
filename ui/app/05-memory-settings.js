// 〔记忆视图 / 设置加载 / 价格表状态〕——M9 拆分第 6 段
'use strict';
// ── 记忆视图 ──
async function loadMemoryView() {
  try {
    const [cfg, chats] = await Promise.all([api('/api/config'), api('/api/chats')]);
    state.config = cfg;
    const files = await api('/api/memory-files');
    state.memoryFiles = files.files || [];
    state.chats = chats.chats || [];
    // 用后端状态校正本地记录：覆盖"页面刚刷新""SSE 断连期间状态变化"两种情况。
    // 后端 consolidating 是唯一可信来源（它在 orchestrator 里真实维护）。
    for (const f of state.memoryFiles) {
      if (f.consolidating) {
        if (!state.consolidating[f.chatKey]) {
          state.consolidating[f.chatKey] = { startedAt: Date.now() };
        }
      } else if (state.consolidating[f.chatKey]) {
        // 后端已经不在整理，说明完成了（结果由 SSE 事件补充）
        delete state.consolidating[f.chatKey];
        if (!state.consolidateResult[f.chatKey]) {
          state.consolidateResult[f.chatKey] = { note: '整理完成', at: Date.now() };
        }
      }
    }
    renderMemoryList();
    if (state.currentMemoryChatKey) loadMemoryDetail(state.currentMemoryChatKey);
  } catch (e) {
    console.error('加载记忆视图失败:', e);
    $('#memory-items').innerHTML = '<div class="list-head muted">加载失败</div>';
  }
}

// 整理中的计时刷新：让"已 Ns"持续走动，并在没有活跃任务时自动停掉。
// 整理可能持续几十秒，用户切走再切回时靠它维持可见状态。
// r126：不再每秒整体重建列表 —— 原来 renderMemoryList() 每秒把左侧列表 DOM
// 整个换一遍，用户正点在某个群上时节点被替换 → click 事件丢失，表现为
// "整理期间/刚整理完记忆页点群都点不动"（2026-10-14 用户实测）。现在只有
// 整理中的会话集合发生变化才重建一次；平时只更新计时文本。状态变化的
// 重渲染由 SSE（consolidate-start/done/error）各自触发，收尾兜底在下面
// active.length===0 分支里，不丢任何一次状态切换。
let consolidateTicker = null;
let consolidateTickerSig = '';
function startConsolidateTicker() {
  if (consolidateTicker) return;
  consolidateTickerSig = Object.keys(state.consolidating).sort().join(',');
  consolidateTicker = setInterval(() => {
    const active = Object.keys(state.consolidating);
    const sig = active.sort().join(',');
    if (!active.length) {
      clearInterval(consolidateTicker);
      consolidateTicker = null;
      consolidateTickerSig = '';
      if (state.tab === 'memory') renderMemoryList();
      return;
    }
    if (state.tab !== 'memory') return;
    // 只更新计时文本，不重建整个详情页（避免打断用户阅读/滚动）
    const key = state.currentMemoryChatKey;
    const el = $('#mem-consolidate-status');
    if (key && state.consolidating[key] && el) {
      const sec = Math.max(0, Math.round((Date.now() - (state.consolidating[key].startedAt || Date.now())) / 1000));
      el.textContent = `整理中…（已 ${sec}s）`;
    }
    if (sig !== consolidateTickerSig) {
      consolidateTickerSig = sig;
      renderMemoryList();
    }
  }, 1000);
}

function renderMemoryList() {
  const box = $('#memory-items');
  const files = state.memoryFiles || [];
  const names = {};
  for (const c of state.chats || []) names[c.key] = formatChatTitle(c.key, chatNameOf(c.key));
  if (!files.length) {
    box.innerHTML = '<div class="list-head muted">还没有任何记忆（等机器人使用记忆工具后才会出现）</div>';
    return;
  }
  box.innerHTML = files.map((f) => {
    const key = f.chatKey;
    const busy = !!state.consolidating[key];
    // 整理中：在列表项上直接标出，切页签回来也能一眼看到
    const busyHtml = busy
      ? `<span class="unread-pill" style="background:var(--orange)">整理中…</span>`
      : '';
    const sub = busy
      ? '正在整理本群记忆'
      : (f.memberCount
        ? `${f.memberCount} 位群友 · ${f.impressionCount} 条印象`
        : '暂无群友印象');
    const delBtn = (f.memberCount || f.impressionCount)
      ? `<button class="btn btn-small btn-danger mem-del-chat" data-key="${esc(key)}" title="删除本会话的全部记忆（所有群友的印象）">删除</button>`
      : '';
    return `
      <div class="chat-item ${key === state.currentMemoryChatKey ? 'selected' : ''}" data-key="${esc(key)}">
        <div class="chat-item-title">
          <span class="session-chat">${esc(names[key] || key)}</span>
          ${busyHtml}
          ${delBtn}
        </div>
        <div class="chat-item-sub">${esc(sub)}</div>
        <div class="session-meta"><span>更新于 ${fmtTime(f.updatedAt || 0)}</span></div>
      </div>`;
  }).join('');
  // 2026-10-23：改事件委托（列表每次重绘都重建行，逐行绑定会产生 N 个闭包）。
  // 删除按钮的点击也在这里分流，避免它冒泡成"选中这一行"。
  if (!box.__memItemsBound) {
    box.__memItemsBound = true;
    box.addEventListener('click', (e) => {
      const delBtn = e.target.closest?.('.mem-del-chat');
      if (delBtn) { deleteMemoryChat(delBtn); return; }
      const row = e.target.closest?.('.chat-item');
      if (row && row.dataset.key) {
        state.currentMemoryChatKey = row.dataset.key;
        renderMemoryList();
        loadMemoryDetail(state.currentMemoryChatKey);
      }
    });
  }
  // 删除本会话的全部记忆（由上面的委托调用；保留 danger 二次确认）
  async function deleteMemoryChat(btn) {
    const key = btn.dataset.key;
    const name = names[key] || key;
    if (state.consolidating[key]) { qaAlert('该会话记忆正在整理中，稍后再删'); return; }
    // ⚠️（2026-10-10 r86 修 P2）破坏性 → danger:true
    if (!await qaConfirm({
      danger: true,
      confirmText: '删除全部记忆',
      message: `确定删除「${name}」的全部记忆？\n\n所有群友的印象都会被删除，此操作不可撤销。`
    })) return;
    try {
      await api(`/api/memory-files/${encodeURIComponent(key.replace(':', '_'))}`, { method: 'DELETE' });
      if (state.currentMemoryChatKey === key) {
        state.currentMemoryChatKey = null;
        const detail = $('#memory-detail');
        if (detail) detail.innerHTML = '<div class="empty-hint">已删除。从左侧选择一个会话查看记忆</div>';
      }
      await loadMemoryView();
    } catch (err) {
      qaAlert(`删除失败：${err.message}`);
    }
  }
}

async function loadMemoryDetail(chatKey) {
  const detail = $('#memory-detail');
  if (!detail) return;                       // R76：容器不存在（已切页）直接返回
  detail.innerHTML = '<div class="empty-hint">加载中…</div>';
  try {
    const [mem, cfg] = await Promise.all([
      api(`/api/memory-files/${chatKey.replace(':', '_')}`),
      api('/api/config')
    ]);
    const notes = cfg.memberNotes || {};
    const kind = chatKey.startsWith('group') ? 'group' : 'private';
    const chatId = chatKey.split(':')[1] || '';
    const members = Array.isArray(mem.members) ? mem.members : [];
    // 「拉取群成员列表」按钮挪进页头按钮行（与 添加印象/整理本群记忆 同排，2026-09-21 用户要求）；
    // 原来它单独占一行横在卡片上方，和页头那排按钮功能同级却分了两处。
    const membersBtnHtml = kind === 'group'
      ? `<button class="btn btn-small" id="mem-load-members-btn" title="拉取群成员列表，可逐个编辑备注">拉取群成员</button><span id="mem-members-status" class="muted"></span>`
      : '';
    const membersHtml = kind === 'group' ? '<div id="mem-members"></div>' : '';
    // 每个群友一张「身份证」小卡片（2026-09-21 R31 按用户要求改版）：
    //   · 高度约为初版两倍，容纳两行文字：第一排 = QQ 昵称，第二排 = QQ 号；
    //   · 头像自动读取 QQ 头像（q1.qlogo.cn，CSP img-src 已放行 https:）；
    //     加载失败回退到姓名首字（⚠️ 不能用内联 onerror —— CSP script-src 'self'
    //     会拦内联事件，必须渲染后 addEventListener 绑 error）；
    //   · 底部保留最近一条印象预览；点开卡片才是完整档案（openMemoryCardModal）。
    const cards = members.map((m) => {
      const uid = String(m.userId || '');
      const note = notes[uid] || '';
      const nickname = m.name || '';
      const who = note || nickname || uid || '某人';
      const imps = Array.isArray(m.impressions) ? m.impressions : [];
      const last = imps[imps.length - 1] || imps[0];
      const preview = String(last?.content || '还没有任何印象').replace(/\s+/g, ' ').trim();
      const canAvatar = /^\d{5,12}$/.test(uid);
      const ava = canAvatar
        ? `<img class="mem-card-ava-img" src="https://q1.qlogo.cn/g?b=qq&nk=${esc(uid)}&s=100" alt="" loading="lazy" referrerpolicy="no-referrer" />`
        : '';
      return `<button type="button" class="mem-card" data-qq="${esc(uid)}" title="点击查看「${esc(who)}」的完整记忆">
        <span class="mem-card-avatar">
          ${ava}<span class="mem-card-ava-fb"${ava ? ' hidden' : ''}>${esc(String(who).trim().slice(0, 1))}</span>
        </span>
        <span class="mem-card-main">
          <span class="mem-card-name">${esc(nickname || who)}${note && note !== nickname ? `<span class="mem-card-note">备注：${esc(note)}</span>` : ''}</span>
          <span class="mem-card-sub">QQ ${esc(uid || '—')}</span>
          <span class="mem-card-quote">${esc(preview)}</span>
        </span>
        <span class="mem-card-right"><span class="mem-card-count">${imps.length} 条</span></span>
      </button>`;
    }).join('');
    const rows = members.length ? `<div class="mem-cards">${cards}</div>` : '';
    // 整理状态从 state 恢复：切页签回来 / 刷新页面后依然可见
    const busy = !!state.consolidating[chatKey];
    const result = state.consolidateResult[chatKey];
    let consolidateStatusHtml = '';
    if (busy) {
      const started = state.consolidating[chatKey]?.startedAt || Date.now();
      const sec = Math.max(0, Math.round((Date.now() - started) / 1000));
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted">整理中…（已 ${sec}s）</span>`;
    } else if (result) {
      const ago = Math.max(0, Math.round((Date.now() - (result.at || 0)) / 1000));
      const when = ago < 60 ? `${ago}s 前` : `${Math.round(ago / 60)} 分钟前`;
      // 有失败（含部分失败/接口失败）加警示前缀，与"内容无需改动"区分开（2026-10-16）
      const warn = (result.failed || result.failed === true) ? '⚠️ ' : '';
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted">${warn}${esc(result.note)}（${when}）</span>`;
    } else {
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted"></span>`;
    }
    detail.innerHTML = `
      <div class="detail-header">
        <h2>${esc(formatChatTitle(chatKey, chatNameOf(chatKey)))} 的记忆</h2>
        <div class="sub">
          ${membersBtnHtml}
          <button class="btn btn-small" id="mem-add-imp-btn">＋ 添加印象</button>
          <button class="btn btn-small" id="mem-consolidate-btn" ${busy ? 'disabled' : ''}>${busy ? '整理中…' : '整理本群记忆'}</button>
          ${consolidateStatusHtml}
        </div>
      </div>
      ${membersHtml}
      ${rows || '<div class="muted" style="padding:10px">还没有任何群友印象（可点右上角「＋ 添加印象」手动记，或点「整理本群记忆」让模型从聊天记录里提炼）。</div>'}
    `;
    const loadMembersBtn = $('#mem-load-members-btn');
    if (loadMembersBtn) loadMembersBtn.addEventListener('click', () => loadGroupMembers(chatId, chatKey));
    // 点「身份证」卡片 → 打开这个人的完整记忆（编辑/更新/删除都在弹窗里，
    // 不再挤在标题行上 —— 列表只负责"认人"，详情负责"看内容 + 操作"）
    $$('.mem-card', detail).forEach((el) => {
      el.addEventListener('click', () => {
        const m = members.find((x) => String(x.userId) === String(el.dataset.qq));
        openMemoryCardModal(chatKey, m || { userId: el.dataset.qq, name: '', impressions: [] });
      });
    });
    // QQ 头像加载失败 → 回退到姓名首字（不能写内联 onerror，CSP 拦内联事件）
    $$('.mem-card-ava-img', detail).forEach((img) => {
      img.addEventListener('error', () => {
        img.hidden = true;
        const fb = img.parentElement?.querySelector('.mem-card-ava-fb');
        if (fb) fb.hidden = false;
      });
    });
    $('#mem-add-imp-btn')?.addEventListener('click', () => openMemberImpressModal(chatKey, null));
    $('#mem-consolidate-btn')?.addEventListener('click', async () => {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      // 立刻记进 state：即使马上切走页签，回来也能看到"整理中"
      state.consolidating[chatKey] = { startedAt: Date.now() };
      delete state.consolidateResult[chatKey];
      startConsolidateTicker();
      renderMemoryList();
      if (btn) { btn.disabled = true; btn.textContent = '整理中…'; }
      if (status) status.textContent = '整理中…';
      try {
        const r = await api('/api/memory-files/consolidate', {
          method: 'POST',
          body: JSON.stringify({ chatKey })
        });
        if (r.error) {
          delete state.consolidating[chatKey];
          state.consolidateResult[chatKey] = { note: `失败：${r.error}`, at: Date.now(), failed: true };
          if (status) status.textContent = `失败：${r.error}`;
          if (btn) { btn.disabled = false; btn.textContent = '整理本群记忆'; }
          renderMemoryList();
        }
        // 成功时保持"整理中"，等 SSE 的 consolidate-done 事件来收尾
      } catch (e) {
        delete state.consolidating[chatKey];
        state.consolidateResult[chatKey] = { note: `失败：${e.message}`, at: Date.now(), failed: true };
        if (status) status.textContent = `失败：${e.message}`;
        if (btn) { btn.disabled = false; btn.textContent = '整理本群记忆'; }
        renderMemoryList();
      }
    });
    // 若本群正在整理，启动计时刷新（切回来时也能接着走）
    if (state.consolidating[chatKey]) startConsolidateTicker();
  } catch (e) {
    detail.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/**
 * 点「身份证」卡片打开的完整档案：上半部是身份信息（备注名 / 群名片 / QQ 昵称 / QQ 号 /
 * 印象条数 / 更新时间），下半部是全部印象逐条列出；编辑 / 更新记忆 / 删除 都收在这里。
 * ⚠️「编辑」走"先关后开"：两个模型弹窗遮罩会同层重叠（.model-modal-overlay
 *    的层号全项目只有一处，见 style.css 0.5 段的 --z-model-modal-overlay），
 *    新旧两团糊在一起、中间那段既点得到旧关闭钮又点得到新内容（同
 *    scheduleOpenModelManage 的处理）。原文写的"+20 z-index 覆盖链 /
 *    新的在下面"经核实并不存在，勿据此推断层叠关系。
 */
/* 记忆档案弹窗的头像兜底（r34）：img 加载失败 → 藏 img、揭首字。
   ⚠️ 必须用捕获监听 —— error 不冒泡，默认监听收不到（同 15-chat-chrome.js）。 */
function bindMemAvatarFallback(overlay) {
  $$('.mf-av-img', overlay).forEach((img) => {
    img.addEventListener('error', () => {
      img.hidden = true;
      const fb = img.parentElement?.querySelector('.mf-av-fb');
      if (fb) fb.hidden = false;
    }, true);
  });
}

function openMemoryCardModal(chatKey, member) {
  const uid = String(member?.userId || '');
  const notes = (state.config?.memberNotes) || {};
  const note = notes[uid] || '';
  const nickname = member?.name || '';
  const cardName = member?.card || '';
  const who = note || cardName || nickname || uid || '某人';
  const imps = Array.isArray(member?.impressions) ? member.impressions : [];
  const updated = Number(member?.updatedAt) || 0;
  // 头像读真实 QQ 头像（q1.qlogo.cn，CSP img-src 已放行 https:）。
  // ⚠️ 不能用内联 onerror（script-src 'self' 会拦），失败回退首字由
  //    bindMemAvatarFallback 在弹窗挂载后用捕获监听兜住。
  const canAvatar = /^\d{5,12}$/.test(uid);
  const avUrl = canAvatar ? `https://q1.qlogo.cn/g?b=qq&nk=${esc(uid)}&s=100` : '';
  const avInner = avUrl
    ? `<img class="mf-av-img" src="${avUrl}" alt="" referrerpolicy="no-referrer" />
       <span class="mf-av-fb" hidden>${esc(String(who).trim().slice(0, 1))}</span>`
    : `<span class="mf-av-fb">${esc(String(who).trim().slice(0, 1))}</span>`;
  // 副行：QQ 号必显；昵称/群名片与主名重复时不重复出现（原型同款去重）。
  const sub = ['QQ ' + (uid || '—')];
  if (nickname && nickname !== who) sub.push('昵称 ' + nickname);
  if (cardName && cardName !== who && cardName !== nickname) sub.push('群名片 ' + cardName);
  const mfCell = (k, v) =>
    `<div class="mf-cell"><span class="mf-k">${esc(k)}</span><span class="mf-v" title="${esc(v)}">${esc(v)}</span></div>`;

  const overlay = modelModalShell({
    head: `${who} 的记忆档案`,
    body: `
      <div class="mf-hero">
        <span class="mf-av">${avInner}</span>
        <div class="mf-hid"><div class="mf-nm" title="${esc(who)}">${esc(who)}</div>
        <div class="mf-sub">${esc(sub.join(' · '))}${updated ? ` · 更新于 ${esc(fmtTime(updated))}` : ''}</div></div>
        <span class="mf-badge">${imps.length} 条印象</span>
      </div>
      <div class="mf-meta">
        ${mfCell('备注名', note || '—')}
        ${mfCell('QQ 昵称', nickname || '—')}
        ${mfCell('群名片', cardName || '—')}
        ${mfCell('QQ 号', uid || '—')}
      </div>
      <div class="mf-sec"><span class="mf-sec-t">印象</span><span class="mf-sec-n">共 ${imps.length} 条</span></div>
      <div class="mem-id-imps">
        ${imps.length
          ? imps.map((e, i) => `<div class="mem-imp">
              <span class="mem-imp-n">${i + 1}</span>
              <span class="mem-imp-c">${esc(e.content || '')}</span>
              ${e.createdAt ? `<span class="mem-imp-t">${fmtTime(e.createdAt)}</span>` : ''}
            </div>`).join('')
          : '<div class="empty-hint">还没有任何印象。点「编辑印象」手动记，或点「更新记忆」让模型从聊天记录里提炼。</div>'}
      </div>`,
    foot: `<button class="btn" id="mc-close">关闭</button>
           <button class="btn btn-danger" id="mc-del">删除此人</button>
           <button class="btn" id="mc-refresh">更新记忆</button>
           <button class="btn btn-primary" id="mc-edit">编辑印象</button>`
  });
  bindMemAvatarFallback(overlay);
  overlay.querySelector('#mc-close').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mc-edit').addEventListener('click', () => {
    closeModelModal(overlay);
    setTimeout(() => openMemberImpressModal(chatKey, { ...member, userId: uid, name: nickname }), 420);
  });
  overlay.querySelector('#mc-del').addEventListener('click', async () => {
    // ⚠️（2026-10-10 r86 修 P2）破坏性 → danger:true
    if (!await qaConfirm({
      danger: true,
      confirmText: '删除印象',
      message: `确定删除「${who}」的全部印象？此操作不可撤销。`
    })) return;
    try {
      await api(`/api/memory-files/${encodeURIComponent(chatKey.replace(':', '_'))}/members/${encodeURIComponent(uid)}`, { method: 'DELETE', body: '{}' });
      closeModelModal(overlay);
      await loadMemoryDetail(chatKey);
      await loadMemoryView();
    } catch (err) {
      qaAlert(`删除失败：${err.message}`);
    }
  });
  overlay.querySelector('#mc-refresh').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!/^\d{1,15}$/.test(uid)) { qaAlert('该群友缺少 QQ 号，无法定位聊天记录'); return; }
    btn.disabled = true;
    btn.textContent = '已提交…';
    // 记进 state：关掉弹窗 / 切页签回来后仍能看到"整理中"
    state.consolidating[chatKey] = { startedAt: Date.now() };
    delete state.consolidateResult[chatKey];
    startConsolidateTicker();
    renderMemoryList();
    try {
      await api('/api/memory-files/consolidate', { method: 'POST', body: JSON.stringify({ chatKey, userIds: [uid] }) });
      closeModelModal(overlay);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '更新记忆';
      qaAlert(`更新记忆失败：${err.message}`);
    }
  });
}

/** 编辑/添加某个群友的印象（一行一条，保存后整体替换）。 */
function openMemberImpressModal(chatKey, member) {
  const isEdit = !!(member && member.userId);
  const userId = member?.userId || '';
  const name = member?.name || '';
  const imps = (member?.impressions || []).map((e) => e.content).join('\n');
  const cfg = state.config || {};
  const notes = cfg.memberNotes || {};
  const note = notes[String(userId)] || '';
  const overlay = modelModalShell({
    head: isEdit ? `编辑群友印象：${note || name || userId}` : '添加群友印象',
    closeOnBackdrop: false,   // 编辑型：点外部不关闭，防误触丢内容
    body: `
      ${isEdit ? `
      <div class="field-row">
        <div class="field"><label>QQ 号</label><input type="text" id="mi-qq" value="${esc(userId)}" readonly /></div>
        <div class="field"><label>QQ 昵称</label><input type="text" id="mi-nickname" value="${esc(name)}" readonly /></div>
        <div class="field"><label>群内昵称</label><input type="text" id="mi-card" value="${esc(member?.card || '')}" readonly /></div>
      </div>
      <div class="field"><label>QQ agent 对群友的当前备注</label><input type="text" id="mi-note" value="${esc(note)}" placeholder="留空则使用原群名片/昵称" /></div>` : `
      <div class="field"><label>QQ 号（必填）</label><input type="text" id="mi-qq" value="${esc(userId)}" /></div>
      <div class="field"><label>名字（备注名/群名片/昵称）</label><input type="text" id="mi-name" value="${esc(name)}" /></div>`}
      <div class="field"><label>印象内容（一行一条；留空 = 删除该成员全部印象）</label><textarea id="mi-imps" style="min-height:160px" placeholder="老王喜欢钓鱼，周末常不在&#10;说话爱玩梗，别太认真">${esc(imps)}</textarea></div>`,
    foot: `<button class="btn" id="mi-cancel">取消</button>
           ${isEdit ? '<button class="btn btn-danger" id="mi-del">删除此人</button>' : ''}
           <button class="btn btn-primary" id="mi-save">保存</button>`
  });
  overlay.querySelector('#mi-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mi-save').addEventListener('click', async () => {
    const qq = ($('#mi-qq')?.value || '').trim();
    const nm = ($('#mi-name')?.value || $('#mi-nickname')?.value || '').trim();
    const newNote = ($('#mi-note')?.value || '').trim();
    const lines = ($('#mi-imps')?.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!/^\d{1,15}$/.test(qq)) { qaAlert('QQ 号必须是数字'); return; }
    try {
      await api(`/api/memory-files/${chatKey.replace(':', '_')}/members/${qq}`, {
        method: 'PUT',
        body: JSON.stringify({ name: nm, note: newNote, impressions: lines })
      });
      closeModelModal(overlay);
      loadMemoryDetail(chatKey);
    } catch (e) {
      qaAlert(`保存失败：${e.message}`);
    }
  });
  const delBtn = overlay.querySelector('#mi-del');
  if (delBtn) delBtn.addEventListener('click', async () => {
    // ⚠️（2026-10-10 r86 修 P2）破坏性 → danger:true
    if (!await qaConfirm({
      danger: true,
      confirmText: '删除印象',
      message: `确定删除 ${note || name || userId} 的全部印象？`
    })) return;
    try {
      await api(`/api/memory-files/${chatKey.replace(':', '_')}/members/${userId}`, { method: 'DELETE', body: '{}' });
      closeModelModal(overlay);
      loadMemoryDetail(chatKey);
    } catch (e) {
      qaAlert(`删除失败：${e.message}`);
    }
  });
}

async function loadGroupMembers(chatId, chatKey) {
  const status = $('#mem-members-status');
  if (status) status.textContent = '拉取中…';
  try {
    const data = await api(`/api/groups/${chatId}/members`);
    state.groupMembers = data.members || [];
    state.groupMembersLoaded = true;
    const cfg = state.config || await api('/api/config');
    const notes = cfg.memberNotes || {};
    const box = $('#mem-members');
    if (box) {
      box.innerHTML = `<div class="collapsible" open><summary>群成员（${state.groupMembers.length} 人）</summary><div class="coll-body"><table class="member-table">
        <tr><th style="text-align:left">群名片</th><th style="text-align:left">QQ昵称</th><th style="text-align:left">QQ号</th><th style="width:90px;text-align:right">备注</th></tr>
        ${state.groupMembers.map((m) => {
          const note = notes[String(m.userId)];
          return `<tr>
            <td>${esc(note || m.card || '—')}${note && (m.card || m.nickname) ? ` <span class="muted">(${esc(m.card || m.nickname)})</span>` : ''}</td>
            <td>${esc(m.nickname || '—')}</td>
            <td class="muted" style="font-size:11px">${esc(m.userId)}</td>
            <td style="text-align:right"><button class="btn btn-small member-note-edit" data-qq="${esc(m.userId)}">编辑备注</button></td>
          </tr>`;
        }).join('')}
      </table></div></div>`;
      box.querySelectorAll('.member-note-edit').forEach((el) => {
        el.addEventListener('click', () => openMemberNoteModal(el.dataset.qq, chatKey));
      });
    }
    if (status) status.textContent = `已拉取 ${state.groupMembers.length} 人`;
  } catch (e) {
    if (status) status.textContent = `拉取失败：${e.message}`;
  }
}

async function openMemberNoteModal(qq, chatKey) {
  const cfg = state.config || await api('/api/config');
  const notes = cfg.memberNotes || {};
  const oldNote = notes[String(qq)] || '';
  const member = (state.groupMembers || []).find((m) => String(m.userId) === String(qq));
  const displayName = member ? String(member.card || member.nickname || '') : '';
  const overlay = modelModalShell({
    head: `编辑备注：${oldNote || displayName || qq}`,
    closeOnBackdrop: false,   // 编辑型：点外部不关闭，防误触丢内容
    body: `
      <div class="field"><label>QQ 号</label><input type="text" value="${esc(qq)}" readonly style="width:100%" /></div>
      <div class="field"><label>备注名</label><input type="text" id="mn-note" value="${esc(oldNote)}" placeholder="${esc(displayName || '备注名（如 老王）')}" style="width:100%" /></div>
      <div class="hint">保存后，聊天记录、记忆、群成员列表都会优先显示这个备注；留空则显示原群名片/昵称。</div>`,
    foot: `<button class="btn" id="mn-cancel">取消</button>
           ${oldNote ? '<button class="btn btn-danger" id="mn-delete">删除备注</button>' : ''}
           <button class="btn btn-primary" id="mn-save">保存</button>`
  });
  overlay.querySelector('#mn-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mn-save').addEventListener('click', async () => {
    const name = $('#mn-note')?.value.trim() || '';
    const nextNotes = { ...(state.config?.memberNotes || {}) };
    if (name) nextNotes[String(qq)] = name; else delete nextNotes[String(qq)];
    try {
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ memberNotes: nextNotes }) });
      state.config = data.config;
      closeModelModal(overlay);
      await loadGroupMembers(chatKey.split(':')[1] || '', chatKey);
    } catch (e) {
      qaAlert(`保存失败：${e.message}`);
    }
  });
  const delBtn = overlay.querySelector('#mn-delete');
  if (delBtn) delBtn.addEventListener('click', async () => {
    const nextNotes = { ...(state.config?.memberNotes || {}) };
    delete nextNotes[String(qq)];
    try {
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ memberNotes: nextNotes }) });
      state.config = data.config;
      closeModelModal(overlay);
      await loadGroupMembers(chatKey.split(':')[1] || '', chatKey);
    } catch (e) {
      qaAlert(`删除失败：${e.message}`);
    }
  });
}
async function loadSettings() {
  // ⚠️ 2026-10-16 修「切换人设不成功」：state.config 必须在**第一个请求**
  // 就绪时立即刷新。旧实现把 7 个接口塞进一个 Promise.all（含 /api/model-prices
  // 联网拉价格表），全部返回才更新 state.config —— 弹窗/市场刚保存完人设的
  // 这段窗口里，任何一次自动保存（切页签 flush / 关窗 / 600ms 防抖）都会拿
  // 旧 persona 回传、把新人设深合并掉。现在 config 单独先行（本地请求，毫秒级），
  // 其余接口慢到无所谓：它们只喂侧栏/预览/模板列表，不参与 saveConfig 回传。
  const cfg = await api('/api/config');
  state.config = cfg;
  refreshPromptPreview(cfg);
  renderSettings();
  // 慢路径：模板/提供商/价格/工具/技能到位后再补一次渲染（只影响这些区块的显示）。
  // 不重置 state.personaTemplates —— 先前的列表继续可用，避免"选择人设"闪现空列表。
  Promise.all([
    api('/api/persona-templates').catch(() => ({ templates: [] })),
    api('/api/providers').catch(() => ({ providers: [] })),
    api('/api/vision/results').catch(() => ({ results: {}, scanning: false })),
    api('/api/model-prices').catch(() => ({ prices: [], current: null })),
    api('/api/tools').catch(() => ({ tools: [] })),
    // 技能状态由后端判定（loaded/enabled/available/active + reason），
    // 前端只展示，不自己推断可用性 —— 避免出现第二套口径
    api('/api/skills').catch(() => ({ skills: [], summary: {} }))
  ]).then(([tplData, provData, visionData, priceData, toolsData, skillsData]) => {
    // 迟到响应守卫：用户可能已切走设置页，state.* 照常更新但不整页重渲染
    state.providers = provData.providers || [];
    state.visionResults = visionData.results || {};
    state.visionScanning = !!visionData.scanning;
    state.modelPrices = priceData || { prices: [], current: null };
    state.toolRegistry = toolsData.tools || [];
    state.skills = skillsData.skills || [];
    state.skillsSummary = skillsData.summary || {};
    state.skillsReady = true;   // 扩展页据此区分"加载中"和"真的空"（2026-10-18）
    state.uninstalledSkills = skillsData.uninstalled || [];
    const tpl = {};
    for (const t of tplData.templates || []) tpl[t.id] = { name: t.name, text: t.text, builtin: !!t.builtin };
    state.personaTemplates = tpl;
    if (state.tab === 'settings') renderSettings();
  }).catch(() => { /* 慢路径失败不阻塞：主配置已就位 */ });
}

/** 设置页「远程价格表」状态行：来源（在线/缓存/内置）、时间、条目数、错误。 */
function renderPriceFeedStatus() {
  const el = $('#price-feed-status');
  if (!el) return;
  const r = state.modelPrices?.remote;
  if (!r || !r.enabled) {
    el.textContent = '官网价格表暂未启用，当前使用内置表；点击“拉取价格表”即可立即重试。';
    return;
  }
  const when = r.fetchedAt ? fmtTime(r.fetchedAt) : '-';
  const droppedTxt = r.dropped ? `，${r.dropped} 条不合格被丢弃` : '';
  if (r.ok && r.source === 'remote') {
    el.textContent = `远程表生效中：${r.count} 条覆盖内置表 · 上次拉取 ${when}${droppedTxt}`;
  } else if (!r.ok && r.source === 'cache') {
    el.textContent = `服务器暂时拉不到（${r.error || '未知错误'}），正在用上次缓存的远程表（${r.count} 条）· ${when}`;
  } else if (!r.ok) {
    el.textContent = `拉取失败（${r.error || '未知错误'}），暂用内置表 · ${when}`;
  } else {
    el.textContent = `已应用本地缓存（${r.count} 条），正在拉取最新…`;
  }
}

/**
 * 刷新「当前模型单价」卡片。
 *
 * ── 规则（只跟开关绑定，绝不依赖保存状态）──
 *   开关开 → 展示内置官方价，输入框**只读**
 *            匹配不到就是 0，提示关掉开关自填
 *   开关关 → 输入框**可编辑**，优先该模型的自定义价，没设则用全局兜底
 *
 * 匹配判断在本地用 state.modelPrices.prices 直接算，
 * 不读 state.modelPrices.current —— 那是后端按「当时请求的模型」算的，
 * 切换模型后若不重新请求就会拿到旧值。
 */

/**
 * 在内置价格表里匹配模型（前端版）。
 *
 * 前端是无模块单文件，拿不到 src/model-prices.js 的导出，所以这里实现一份
 * 与后端 matchPriceTable 完全相同的逻辑：精确 → 去前缀 → 最长前缀匹配。
 * 用本地数据算而不是读 state.modelPrices.current —— 后者是后端按
 * 「当时请求的模型」算的，切换模型后不重新请求就会拿到旧值。
 */
function refreshModelPriceCard() {
  const modelEl = $('#pc-model');
  const noteEl = $('#pc-note');
  const inEl = $('#cfg-price-in');
  const outEl = $('#cfg-price-out');
  const cachedEl = $('#cfg-price-cached');
  if (!modelEl) return;

  const cfg = state.config || {};
  const api = cfg.api || {};

  // 实时值：优先界面控件，退回已保存配置
  const box = $('#cfg-useofficialprice');
  const modelInput = $('#cfg-model');
  const useOfficial = box ? box.checked : (api.useOfficialPrice !== false);
  const model = String((modelInput ? modelInput.value : api.model) || '').trim();

  modelEl.textContent = model || '（未选择模型）';

  if (!model) {
    [inEl, outEl, cachedEl].forEach((el) => { if (el) { el.value = 0; el.disabled = true; } });
    if (noteEl) noteEl.textContent = '先在上方选择一个模型，才能查看/设定它的单价。';
    return;
  }

  let shown, locked, sourceTxt;

  if (useOfficial) {
    locked = true;
    const official = matchPriceTable(model, state.modelPrices?.prices || []);
    if (official) {
      shown = {
        in: official.in ?? 0,
        out: official.out ?? 0,
        cached: official.cached == null ? official.in : official.cached
      };
      const tag = official.src === 'official' ? '厂商官方定价页直取' : '二手折算，仅供参考';
      sourceTxt = `内置官方价格表已匹配到「${official.id}」（${tag}）。开关开启时只读 —— 要自定义请关闭上方开关。`;
      if (official.peak) {
        sourceTxt += `　该模型分时段计价（高峰 ${official.peak.in}/${official.peak.out}/${official.peak.cached}）。`;
      }
      if (official.image) {
        sourceTxt += '　支持图片输入：' + (official.image.mode === 'capped'
          ? `每张封顶 ${official.image.maxTokensPerImage} token`
          : official.image.mode === 'pixel'
            ? `每张 = 宽×高/${official.image.divisor}+${official.image.base} token`
            : '换算规则待补');
      }
    } else {
      shown = { in: 0, out: 0, cached: 0 };
      sourceTxt = '';
    }
  } else {
    locked = false;
    // 自定义价读已保存的配置（那才是用户存的），但模型身份用实时模型名去查
    const custom = (api.modelPrices || {})[model];
    if (custom && (Number(custom.in) || Number(custom.out))) {
      shown = {
        in: Number(custom.in) || 0,
        out: Number(custom.out) || 0,
        cached: custom.cached == null ? Number(custom.in) || 0 : Number(custom.cached) || 0
      };
      sourceTxt = '正在使用你为该模型设定的单价。';
    } else {
      shown = {
        in: Number(api.priceInputPerM) || 0,
        out: Number(api.priceOutputPerM) || 0,
        cached: Number(api.priceCachedPerM) || Number(api.priceInputPerM) || 0
      };
      sourceTxt = '已关闭官方价格表，可在此填写该模型的单价（也可在「批量自定义价格编辑」里为多个模型分别设定）。';
    }
  }

  if (inEl) { inEl.value = shown.in ?? 0; inEl.disabled = locked; }
  if (outEl) { outEl.value = shown.out ?? 0; outEl.disabled = locked; }
  if (cachedEl) { cachedEl.value = shown.cached ?? 0; cachedEl.disabled = locked; }
  const card = $('#model-price-card');
  if (card) card.classList.toggle('locked', locked);
  if (noteEl) noteEl.textContent = sourceTxt;
}

/**
 * 批量自定义价格编辑：左列选供应商 → 右列该供应商的模型 →
 * 官方表（输入/输出/缓存命中）参考列 + 自定义单价输入列。
 *
 * 曾经的候选列表是"当前模型 + 已自定义 + 用量统计里出现过的" ——
 * 没调用过的模型根本进不了名单，想提前给没用过的新模型定价都做不到。
 * 现在按供应商目录浏览，全量模型都可设定。
 *
 * 两个细节：
 *   1. 编辑暂存在 edits 里（input 事件实时写入），切换供应商不丢未保存的修改
 *   2. 目录之外但已自定义的模型归到虚拟供应商「已自定义（目录外）」，
 *      保证旧条目永远能找到、能清除
 */
function openBatchPriceModal() {
  const cfg = state.config || {};
  const customMap = cfg.api?.modelPrices || {};
  // 编辑暂存：以已保存的自定义价为起点，用户的每一次输入都先落在这里
  const edits = {};
  for (const [k, v] of Object.entries(customMap)) edits[k] = { ...(v || {}) };

  // 左列数据：供应商目录 + 虚拟供应商（目录外已自定义的模型）
  const catalogModels = new Set();
  for (const p of (state.providers || [])) for (const m of (p.models || [])) catalogModels.add(m);
  const orphanCustoms = Object.keys(customMap).filter((k) => !catalogModels.has(k)).sort();
  const lefts = (state.providers || []).map((p) => ({
    id: p.id, name: p.displayName || p.id, models: p.models || [], names: p.modelNames || {}
  }));
  if (orphanCustoms.length) {
    lefts.push({ id: '__custom__', name: `已自定义（目录外 ${orphanCustoms.length}）`, models: orphanCustoms, names: {} });
  }

  if (!lefts.length) {
    modelModalShell({
      head: '批量自定义价格编辑',
      closeOnBackdrop: false,   // 编辑型：点外部不关闭，防误触丢内容
      body: '<div class="empty-hint">模型目录为空：请先在「设置 → 模型与搜索 → 模型管理」里添加一个提供商。</div>',
      foot: ''
    });
    return;
  }

  let activePid = lefts[0].id;
  let kw = '';   // 搜索关键词（中转站供应商可能有几百个模型，没搜索没法用）

  const overlay = modelModalShell({
    head: '批量自定义价格编辑',
    closeOnBackdrop: false,   // 编辑型：点外部不关闭，防误触丢内容
    body: `
      <div class="ma-toolbar">
        <input type="text" id="bp-search" placeholder="搜索模型…" autocomplete="off" />
        <span class="muted" style="font-size:12px;white-space:nowrap">留空 = 不自定义（走官方表/兜底）</span>
      </div>
      <div class="ma-body dual">
        <div class="model-modal-left" id="bp-left"></div>
        <div class="model-modal-right" id="bp-right"></div>
      </div>
      <div id="bp-hint" class="muted" style="font-size:12px;flex-shrink:0;margin-top:8px">
        输入框占位符与模型名悬停提示均为官方价（元/百万 token）；修改只写入你的配置，不会改动官方价格表。
      </div>`,
    foot: `<button class="btn" id="bp-cancel">取消</button>
           <button class="btn btn-primary" id="bp-save">保存</button>`
  });

  const left = overlay.querySelector('#bp-left');
  const right = overlay.querySelector('#bp-right');
  const hintEl = overlay.querySelector('#bp-hint');

  function renderLeft() {
    left.innerHTML = lefts.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.name)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }

  function rowHtml(p, m) {
    if (kw && !m.toLowerCase().includes(kw) && !String(p.names[m] || '').toLowerCase().includes(kw)) return '';
    const off = matchPriceTable(m, state.modelPrices?.prices || []);
    const c = edits[m] || {};
    // 官方价不占列（太挤）：placeholder 里有，模型名悬停也有
    const offTitle = off ? `官方价：输入 ${off.in} / 输出 ${off.out} / 缓存 ${off.cached ?? '—'}（元/百万）` : '官方价格表未收录';
    return `
      <tr data-model="${esc(m)}">
        <td title="${esc(offTitle)}">${esc(p.names[m] || m)}${(p.names[m] || m) !== m ? `<div class="muted" style="font-size:11px">${esc(m)}</div>` : ''}</td>
        <td><input type="number" step="0.01" min="0" class="bp-in" value="${esc(c.in ?? '')}" placeholder="${off ? off.in : 0}" /></td>
        <td><input type="number" step="0.01" min="0" class="bp-out" value="${esc(c.out ?? '')}" placeholder="${off ? off.out : 0}" /></td>
        <td><input type="number" step="0.01" min="0" class="bp-cached" value="${esc(c.cached ?? '')}" placeholder="${off ? (off.cached ?? 0) : 0}" /></td>
        <td><button class="bp-del" title="清除该模型的自定义价">清除</button></td>
      </tr>`;
  }

  function renderRight() {
    const p = lefts.find((x) => x.id === activePid);
    const models = p ? p.models : [];
    right.innerHTML = `
      <table class="usage-table">
        <thead><tr>
          <th>模型（悬停看官方价）</th>
          <th>自定义 输入</th><th>自定义 输出</th><th>自定义 缓存命中</th><th></th>
        </tr></thead>
        <tbody id="bp-body">
          ${models.map((m) => rowHtml(p, m)).join('') || '<tr><td colspan="5" class="muted">没有匹配的模型</td></tr>'}
        </tbody>
      </table>`;
    // 输入实时落进 edits：切换供应商/搜索重渲染后不丢未保存的修改
    right.querySelectorAll('#bp-body tr[data-model]').forEach((tr) => {
      const m = tr.dataset.model;
      const sync = () => {
        const num = (sel) => {
          const v = String(tr.querySelector(sel)?.value ?? '').trim();
          return v === '' ? null : (Number(v) || 0);
        };
        const i = num('.bp-in'), o = num('.bp-out'), c = num('.bp-cached');
        if (i === null && o === null && c === null) delete edits[m];
        else edits[m] = { in: i ?? 0, out: o ?? 0, cached: c ?? (i ?? 0) };
      };
      tr.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', sync));
    });
    right.querySelectorAll('#bp-body .bp-del').forEach((el) => {
      el.addEventListener('click', () => {
        const tr = el.closest('tr[data-model]');
        if (!tr) return;
        delete edits[tr.dataset.model];
        tr.querySelectorAll('input').forEach((i) => { i.value = ''; });
      });
    });
  }

  overlay.querySelector('#bp-search')?.addEventListener('input', (e) => {
    kw = String(e.target.value || '').trim().toLowerCase();
    renderRight();
  });

  renderLeft();
  renderRight();

  overlay.querySelector('#bp-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#bp-save').addEventListener('click', async () => {
    // 保存的就是 edits 本身（输入时已实时同步，不用再扫 DOM）
    const next = edits;
    try {
      hintEl.textContent = '保存中…';
      // 用 __replace__ 整体替换：普通深合并传对象是删不掉旧键的，
      // 用户点"清除"某行后保存，旧条目会复活。
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ api: { modelPrices: { __replace__: next } } })
      });
      // 更新本地状态，避免下次打开还是旧值
      state.config = state.config || {};
      state.config.api = state.config.api || {};
      state.config.api.modelPrices = next;
      closeModelModal(overlay);
      refreshModelPriceCard();
      // 2026-09-19（M9 清理）：旧 #provider-action-hint 元素已随改版消失，写它会在
      // try 里抛 TypeError 被自己的 catch 吞成"保存失败"。改写存活的 #provider-hint。
      // 2026-10-23 修复：原来的 $('#provider-hint').textContent 没有判空 ——
      // 设 置页不在该分区时元素不存在，会抛 TypeError 并被自己的 catch 吞成
      // "保存失败"（与 08-modals.js 记录的是同一类事故）。走 setHintText。
      setHintText('#provider-hint', `已保存 ${Object.keys(next).length} 个模型的自定义单价。`);
    } catch (e) {
      hintEl.textContent = `保存失败：${esc(e.message)}`;
    }
  });
}

function renderPersonaPicker(c) {
  const currentId = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === (c.persona?.roleText || ''))?.[0] || '';
  const currentName = state.personaTemplates[currentId]?.name || '';
  return `
    <div class="field-row" style="align-items:flex-end">
      <div class="field">
        <label>选择人设</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-persona-pick" readonly placeholder="点击选择人设" value="${esc(currentName)}" style="flex:1;cursor:pointer" />
          <button class="btn btn-small" id="new-persona-btn">＋ 添加人设</button>
          <button class="btn btn-small btn-danger hidden" id="del-persona-btn">删除当前自定义人设</button>
        </div>
        <span id="persona-pick-hint" class="muted" style="font-size:12px"></span>
      </div>
    </div>`;
}

function renderHealthCard() {
  const { ready, checks } = assessReadiness(state.config, state.status);
  const rows = checks.map((c, idx) => {
    let extra = '';
    if (!c.ok) {
      if (c.fix === 'connection-tab') {
        // 2026-10-23：原「前往启动 SnowLuma」→ 现在跳「工具 → 连接」页看状态与协议端指引。
        extra = ' <button class="btn btn-small hc-fix-btn" data-target="connection">去连接页</button>';
      } else if (c.fix === 'settings-api') {
        extra = ' <button class="btn btn-small hc-fix-btn" data-target="settings-api">去填写</button>';
      } else if (c.fix === 'settings-allow') {
        extra = ' <button class="btn btn-small hc-fix-btn" data-target="settings-allow">去勾选</button>';
      }
    }
    return `
    <div class="h-item ${c.ok ? 'ok' : 'bad'}">
      <span>${c.ok ? '✓' : '✗'}</span>
      <span class="h-label">${esc(c.label)}${extra}</span>
    </div>`;
  }).join('');
  const testRow = `
    <div class="h-item ${'mute'}">
      <span>·</span>
      <span class="h-label">API 连通性：
        <button class="btn btn-small" id="test-api-btn">测试一下</button>
        <span id="test-api-result" class="muted"></span>
      </span>
    </div>`;
  return `
    <div class="health-card ${ready ? 'all-ok' : ''}">
      <div class="h-title">${ready ? '✅ 一切就绪，机器人运行中' : '🧭 完成下面缺失项就能跑起来'}</div>
      ${rows}
      ${testRow}
    </div>`;
}

// 人设模板数据：state.personaTemplates（由 loadSettings 从后端填充）
