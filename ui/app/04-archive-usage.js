// 〔存档 / 用量〕——M9 拆分第 5 段
'use strict';
// ── 存档视图 ──
async function loadChats({ quiet = false } = {}) {
  try {
    const data = await api('/api/chats');
    state.chats = data.chats || [];
    renderChatList();
    if (state.currentChatKey) {
      // 打开着某群详情时也刷新该群消息。
      // keepView=true：只更新内容，不动分页与滚动位置 ——
      // 否则用户滚出来的内容会被每 15 秒的轮询刷回去。
      loadChatMessages(state.currentChatKey, { keepView: true });
    }
  } catch (e) { if (!quiet) console.error(e); }
}

/**
 * 真实 QQ 头像 URL（2026-10-17，用户要求存档列表读取群聊真实头像）：
 * 腾讯公开 CDN，无需鉴权 ——
 *   群   → https://p.qlogo.cn/gh/<群号>/<群号>/100
 *   私聊 → https://q1.qlogo.cn/g?b=qq&nk=<QQ号>&s=100
 * ⚠️ 群头像**不能**用 b=qq&nk=群号（那是个人接口，对群号返回 404）。
 * 与 15-chat-chrome.js 会话页左栏、05-memory-settings.js 记忆卡片同一套路
 * （15-chat-chrome 的实现闭在 IIFE 里拿不到，这里按同款规则再写一份）。
 * key 不是纯数字 ID 时返回 ''，由调用方退回首字。
 */
function qqAvatarUrl(chatKey, size) {
  const m = /^(group|private):(\d{5,12})$/.exec(String(chatKey || ''));
  if (!m) return '';
  const id = m[2];
  const s = size || 100;
  return m[1] === 'group'
    ? `https://p.qlogo.cn/gh/${id}/${id}/${s}`
    : `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=${s}`;
}

/**
 * 头像加载失败 → 揭开首字兜底（与 15-chat-chrome.js bindAvatarFallback 同款）。
 * ⚠️ error 事件**不冒泡**，必须捕获阶段监听；绑在长期容器上，
 *    innerHTML 重建不影响委托（渲染函数每次整体重画，不能逐节点绑）。
 */
function bindArchiveAvatarFallback(box) {
  if (!box || box.__avBound) return;
  box.__avBound = true;
  box.addEventListener('error', (e) => {
    const im = e.target;
    if (!im || im.tagName !== 'IMG' || !im.classList.contains('av-img')) return;
    const fb = im.parentNode?.querySelector('.av-fb');
    im.style.display = 'none';
    if (fb) fb.hidden = false;
  }, true);
}

/**
 * 存档群聊列表（2026-10-17 改版）：结构与「会话」页左栏的聊天对象行**逐字同款**
 * （.bp-row + .bp-av 真实头像 + .bp-rt 群名 / .bp-ri 末条预览 + .cc-pill 计数），
 * 两类样式全是全局类、直接复用，不再自造一套。
 * 右侧 pill：有未读 → 红胶囊「N 条未读」；否则 → 灰胶囊「N 条」（消息总数）。
 * 元素上保留 .chat-item class：new-item 入场动画与 ? 主题的彩蛋规则还挂在它上面。
 */
function renderChatList() {
  const box = $('#chat-items');
  state.seenChatKeys = state.seenChatKeys || new Set();
  box.innerHTML = state.chats.map((c) => {
    const name = formatChatTitle(c.key, chatNameOf(c.key));
    const isNew = !state.seenChatKeys.has(c.key);
    const fb = String(name || '?').trim().slice(0, 1) || '?';
    const url = qqAvatarUrl(c.key, 100);
    const av = url
      ? `<span class="bp-av" data-avk="${esc(c.key)}"><img class="av-img" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" /><span class="av-l av-fb" hidden>${esc(fb)}</span></span>`
      : `<span class="bp-av"><span class="av-l">${esc(fb)}</span></span>`;
    const pill = c.unread
      ? `<span class="cc-pill cc-error">${c.unread} 条未读</span>`
      : (c.total ? `<span class="cc-pill cc-gray">${c.total} 条</span>` : '');
    return `
      <div class="bp-row chat-row chat-item${c.key === state.currentChatKey ? ' on' : ''}${isNew ? ' new-item' : ''}" data-key="${c.key}">
        ${av}
        <span class="bp-rl">
          <span class="bp-rt">${esc(name)}</span>
          <span class="bp-ri">${esc(c.lastText || '（暂无消息）')}</span>
        </span>
        ${pill}
      </div>`;
  }).join('') || '<div class="list-head muted">还没有消息存档（等白名单里的群/好友来消息）</div>';
  for (const c of state.chats) state.seenChatKeys.add(c.key);
  bindArchiveAvatarFallback(box);
  // 2026-10-23：改事件委托（与 02-sse-sessions.js 的会话列表同一套做法）。
  // 此前逐行 addEventListener：列表每次 SSE/轮询刷新都重建 HTML，N 行就产生 N 个闭包，
  // 且与项目自己在会话列表里写下的"改委托"决策不一致。
  if (!box.__chatItemsBound) {
    box.__chatItemsBound = true;
    box.addEventListener('click', (e) => {
      const row = e.target.closest?.('.chat-item');
      if (row && row.dataset.key) selectChat(row.dataset.key);
    });
  }
}

async function selectChat(key) {
  state.currentChatKey = key;
  if (state.quoteMode) state.quoteSelected = new Set();   // 金句按单段对话收录，换会话清空勾选
  renderChatList();
  // R76：详情容器可能已被切页销毁（#chat-detail 只在存档页存在）—— 直接写
  // innerHTML 会抛 TypeError（10/10 日志实测过一次）。切走时静默跳过即可。
  const detail = $('#chat-detail');
  if (detail) detail.innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadChatMessages(key);
}

/**
 * 拉取并渲染某会话的存档消息。
 *
 * @param {string} key
 * @param {boolean} keepView  true = 保留当前分页与滚动位置（轮询刷新用）；
 *                            false = 重置为第一页并重建结构（切换会话用）。
 *
 * ⚠️ 这个参数是修"滚动被冲掉"的关键：
 *    轮询每 15 秒一次、每次 SSE 事件也会触发，如果都走"重置分页 + 重建 DOM"，
 *    用户辛辛苦苦滚出来的内容会瞬间被刷回前 500 条，滚动位置也回到顶部
 *    —— 表现为"明明滚下去了，过一会儿自己弹回上面"。
 */
async function loadChatMessages(key, { keepView = false } = {}) {
  try {
    // 2026-10-23 修复：原先 limit=100000 —— 几万条的群会一次拉回数十 MB JSON，
    // 主线程解析 + 排序造成明显卡顿与内存峰值。改为只取最近 5000 条（前端分页逻辑不变），
    // 更早的消息在计数文案里明确提示"仅载入最近 N 条"。
    const data = await api(`/api/chats/${key.replace(':', '_')}/messages?limit=5000`);
    // 期间用户可能切走了会话，那就别覆盖当前视图
    if (state.currentChatKey !== key) return;
    state.chatMessages = data.messages || [];

    if (keepView && (state.chatMsgLimit || 0) > 0 && $('#chat-msg-body')) {
      // 只更新表格内容：分页不变、滚动位置不变
      updateChatMessagesBody(true);
    } else {
      // 切换会话：重置分页并从第一页开始
      state.chatMsgLimit = CHAT_MSG_PAGE;
      renderChatMessages();
    }
  } catch (e) {
    if (state.currentChatKey !== key) return;
    const box = $('#chat-detail');
    if (box) box.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/**
 * 存档消息列表：首次建结构 + 填充内容。
 *
 * ⚠️ 关键：这个只在"切换会话 / 首次打开"时调用，负责建出完整骨架并绑定工具栏事件。
 *    滚动加载更多时走 updateChatMessagesBody() —— 只替换 tbody 与底部文案，
 *    不碰外层结构。
 *
 *    曾经每次加载更多都走整个函数（innerHTML 全量重建），后果有两个：
 *      1. 浏览器丢失 scrollTop → 表现为"明明在往下滚，却自己弹回上面"
 *      2. 工具栏事件被反复绑定 → 点一次发好几条
 */
function renderChatMessages() {
  const key = state.currentChatKey;
  if (!key) return;
  const detail = $('#chat-detail');
  if (!detail) return;

  // 2026-10-23 修复：切到别的会话时清掉上一个会话的勾选。
  //   chatDeleteSelected 存的是**消息 id**，跨会话残留会让「删除选中」把 A 群的 id
  //   发给 B 群的删除接口 —— 用户以为在删 B 的，实际删的是 A 的。
  if (state.chatDeleteKey !== key) {
    state.chatDeleteKey = key;
    if (state.chatDeleteSelected && state.chatDeleteSelected.size) state.chatDeleteSelected.clear();
  }

  // 切换会话时重置分页（每个会话独立从第一页开始）
  state.chatMsgLimit = CHAT_MSG_PAGE;

  const name = formatChatTitle(key, chatNameOf(key));
  const meta = state.chats.find((c) => c.key === key) || {};

  detail.innerHTML = `
    <div class="detail-header">
      <h2>${esc(name)} ${meta.unread ? `<span class="unread-pill">${meta.unread} 未读</span>` : ''}</h2>
      <div class="sub"><span data-field="chat-msg-count"></span></div>
    </div>
    <div class="chat-toolbar">
      <button class="btn btn-small" id="chat-wake-btn">唤醒一次处理</button>
      <button class="btn btn-small" id="chat-read-btn">全部标为已读</button>
      <button class="btn btn-small" id="chat-mute-btn" title="仅屏蔽：把未读标记为已读，不再触发回复（消息保留）">仅屏蔽</button>
      <button class="btn btn-small" id="chat-del-mode-btn" title="选择部分消息删除">选择删除</button>
      <button class="btn btn-small btn-danger" id="chat-clear-btn" title="清空这个会话的全部消息存档">清空存档</button>
      <input type="text" id="test-send-text" placeholder="手动发一条测试消息" style="flex:1" />
      <button class="btn btn-small" id="chat-testsend-btn">发送</button>
    </div>
    <div class="chat-toolbar chat-del-bar" id="chat-del-bar" style="display:none">
      <span class="muted" id="chat-del-count">已选 0 条</span>
      <button class="btn btn-small btn-danger" id="chat-del-confirm-btn">删除选中</button>
      <button class="btn btn-small" id="chat-del-cancel-btn">取消</button>
    </div>
    <table class="archive-table"><tbody id="chat-msg-body"></tbody></table>
    <div class="list-more muted" id="chat-msg-more"></div>`;

  // 工具栏事件：只在这里绑一次
  // 2026-10-23 修复：这三个按钮此前完全没有错误处理 —— 后端未连接 / 白名单未配时，
  // 点了毫无反应也不提示（用户会反复点，并误判"已生效"）。统一补
  // 「禁用 → 执行 → 失败 qaAlert → 恢复」，顺带挡住连点。
  const runChatAction = async (btn, fn, label) => {
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '处理中…';
    try { await fn(); }
    catch (e) { qaAlert(`${label}失败：${e.message}`); }
    finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = old; } }
  };
  $('#chat-wake-btn').addEventListener('click', (e) => runChatAction(e.currentTarget, async () => {
    await api(`/api/chats/${key.replace(':', '_')}/wake`, { method: 'POST', body: '{}' });
    refreshStatus();
  }, '唤醒'));
  $('#chat-read-btn').addEventListener('click', (e) => runChatAction(e.currentTarget, async () => {
    await api(`/api/chats/${key.replace(':', '_')}/mark-read`, { method: 'POST', body: '{}' });
    loadChats();
    // 保持视图：用户可能已经滚到中间了，别把他弹回顶部
    loadChatMessages(key, { keepView: true });
  }, '标记已读'));
  // 仅屏蔽：未读标记为已读、不再触发回复（消息保留在存档里）
  $('#chat-mute-btn').addEventListener('click', (e) => runChatAction(e.currentTarget, async () => {
    await api(`/api/chats/${key.replace(':', '_')}/mute`, { method: 'POST', body: '{}' });
    loadChats();
    loadChatMessages(key, { keepView: true });
  }, '屏蔽'));
  // 清空存档：删除这个会话的全部消息（不可恢复）
  $('#chat-clear-btn').addEventListener('click', async () => {
    const meta = state.chats.find((c) => c.key === key) || {};
    // ⚠️（2026-10-10 r86 修 P2）破坏性 → danger:true（红主按钮 + 明确按钮文案）
    if (!await qaConfirm({
      danger: true,
      confirmText: '清空存档',
      message: `确定清空「${name}」的全部消息存档？\n\n共 ${meta.total ?? '?'} 条消息，删除后不可恢复。\n（机器人之后来新消息会重新记录）`
    })) return;
    try {
      await api(`/api/chats/${key.replace(':', '_')}/clear`, { method: 'POST', body: '{}' });
      loadChats();
      loadChatMessages(key);
    } catch (e) {
      qaAlert(`清空失败：${e.message}`);
    }
  });
  // ── 选择删除（部分消息）──
  state.chatDeleteMode = state.chatDeleteMode || false;
  state.chatDeleteSelected = state.chatDeleteSelected || new Set();
  const delBar = $('#chat-del-bar');
  const updateDelBar = () => {
    $('#chat-del-count').textContent = `已选 ${state.chatDeleteSelected.size} 条`;
    delBar.style.display = state.chatDeleteMode ? 'flex' : 'none';
  };
  // 2026-10-23 修复：模板里 #chat-del-bar 写死 display:none，而 state.chatDeleteMode
  //   是全局的 —— 在删除模式下切会话，新会话的行首有勾选框、工具条却不出现，
  //   用户勾完既删不掉也退不出删除模式。这里按当前状态同步一次。
  updateDelBar();
  $('#chat-del-mode-btn').addEventListener('click', () => {
    state.chatDeleteMode = !state.chatDeleteMode;
    if (!state.chatDeleteMode) state.chatDeleteSelected.clear();
    updateDelBar();
    updateChatMessagesBody(true);   // 重渲染出行首勾选框
  });
  $('#chat-del-cancel-btn').addEventListener('click', () => {
    state.chatDeleteMode = false;
    state.chatDeleteSelected.clear();
    updateDelBar();
    updateChatMessagesBody(true);
  });
  $('#chat-del-confirm-btn').addEventListener('click', async () => {
    const ids = [...state.chatDeleteSelected];
    if (!ids.length) { qaAlert('请先勾选要删除的消息'); return; }
    // ⚠️（2026-10-10 r86 修 P2）破坏性 → danger:true
    if (!await qaConfirm({
      danger: true,
      confirmText: `删除 ${ids.length} 条`,
      message: `确定删除选中的 ${ids.length} 条消息？删除后不可恢复。`
    })) return;
    try {
      await api(`/api/chats/${key.replace(':', '_')}/delete-messages`, {
        method: 'POST', body: JSON.stringify({ ids })
      });
      state.chatDeleteMode = false;
      state.chatDeleteSelected.clear();
      updateDelBar();
      loadChats();
      loadChatMessages(key, { keepView: true });
    } catch (e) {
      qaAlert(`删除失败：${e.message}`);
    }
  });
  // 删除勾选框（事件委托，tbody 会被重建）
  if (!detail.__chatDelBound) {
    detail.__chatDelBound = true;
    detail.addEventListener('change', (e) => {
      const chk = e.target.closest?.('.chat-del-check');
      if (!chk) return;
      const id = Number(chk.dataset.mid);
      if (chk.checked) state.chatDeleteSelected.add(id); else state.chatDeleteSelected.delete(id);
      const cnt = $('#chat-del-count');
      if (cnt) cnt.textContent = `已选 ${state.chatDeleteSelected.size} 条`;
    });
  }
  // 2026-10-23 修复：手动发测试消息此前无 try/catch —— 发送失败（未连 OneBot /
  // 白名单拦截）时按钮毫无反应，用户会以为"已经发出去了"。现在失败明确提示，
  // 成功才清空输入框；并禁用按钮防连点（避免重复发两条）。
  $('#chat-testsend-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const input = $('#test-send-text');
    const text = input.value.trim();
    if (!text) { qaAlert('先输入要发送的内容'); return; }
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '发送中…';
    try {
      await api(`/api/chats/${key.replace(':', '_')}/test-send`, {
        method: 'POST', body: JSON.stringify({ text })
      });
      input.value = '';
      // 同理，保持当前分页与滚动位置
      loadChatMessages(key, { keepView: true });
    } catch (err) {
      qaAlert(`发送失败：${err.message}`);
    } finally {
      if (btn.isConnected) { btn.disabled = false; btn.textContent = old; }
    }
  });

  updateChatMessagesBody();
  // 滚动加载只挂一次（attachScrollLoader 内部有防重复）
  initChatScrollLoader();
  // 金句勾选：事件委托挂在容器上（tbody 会被轮询重建，委托不受影响的）。
  // 防重复：renderChatMessages 每次切会话都会跑，容器只绑一次。
  if (!detail.__quoteBound) {
    detail.__quoteBound = true;
    detail.addEventListener('change', (e) => {
      const cb = e.target.closest?.('.quote-check');
      if (!cb) return;
      const mid = Number(cb.dataset.mid);
      if (cb.checked) state.quoteSelected.add(mid); else state.quoteSelected.delete(mid);
      cb.closest('tr')?.classList.toggle('quote-selected', cb.checked);
    });
  }
}

/**
 * 排序缓存：state.chatMessages 的引用不变就复用上次的排序结果。
 *
 * 曾经在 updateChatMessagesBody 里每次都 slice + sort + 再 slice + reverse
 * （两遍全量拷贝 + O(n log n)）。轮询进来数据确实会变（新数组引用，重排一次），
 * 但滚动加载更多时数据根本没动 —— 每滚一批就白排一遍，几万条时卡在滚动事件里。
 *
 * 用"稳定排序"而不是简单 reverse：存档里 ts 是秒级精度（实测 2000 条中有 18 处
 * 同一秒内的消息毫秒级逆序）。直接 reverse 会把这些也翻过来，导致同一秒内的
 * 消息顺序不对。先按 ts 稳定升序排一遍（Array.sort 在现代引擎里是稳定的），
 * 再反转，就能保证"新的在上"且同秒内顺序也正确。
 */
let chatMsgSortCache = { src: null, newestFirst: [] };
function chatMessagesNewestFirst() {
  const src = state.chatMessages || [];
  if (chatMsgSortCache.src !== src) {
    const sorted = src.slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    sorted.reverse();
    chatMsgSortCache = { src, newestFirst: sorted };
  }
  return chatMsgSortCache.newestFirst;
}

/** 单行消息 HTML（全量渲染与滚动追加共用同一个模板，保证两处长得一样）。 */
function chatMsgRowHtml(m) {
  // 金句勾选模式：行首加勾选框；选中态存 state.quoteSelected（按消息 id），
  // 轮询重建行时勾选状态不丢
  const q = state.quoteMode
    ? `<td class="q-check"><input type="checkbox" class="quote-check" data-mid="${m.id}" ${state.quoteSelected.has(m.id) ? 'checked' : ''} /></td>`
    : '';
  // 删除勾选模式：行首加删除勾选框（与金句勾选互斥）
  const d = state.chatDeleteMode
    ? `<td class="q-check"><input type="checkbox" class="chat-del-check" data-mid="${m.id}" ${state.chatDeleteSelected.has(m.id) ? 'checked' : ''} /></td>`
    : '';
  const sel = state.quoteMode && state.quoteSelected.has(m.id) ? ' quote-selected' : '';
  const dsel = state.chatDeleteMode && state.chatDeleteSelected.has(m.id) ? ' chat-del-selected' : '';
  return `
    <tr class="${m.read ? '' : 'unread'}${sel}${dsel}" data-midrow="${m.id}">${q}${d}
      <td class="t">${fmtTime(m.ts)}</td>
      <td class="w ${m.self ? 'self' : ''}">${m.self ? '我' : esc(m.senderName)}</td>
      <td class="text">${esc(m.text)}${m.read ? '' : ' <span class="unread-pill">未读</span>'}</td>
    </tr>`;
}

/** 更新底部"还有 N 条"与顶部计数文案（全量渲染与追加都要刷这两处）。 */
function updateChatMessagesMeta(newestFirst) {
  const total = newestFirst.length;
  const shownCount = Math.min(Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE), total);
  const rest = total - shownCount;
  const more = $('#chat-msg-more');
  if (more) {
    more.textContent = rest > 0
      ? `向下滚动加载更早的（还有 ${rest} 条）`
      : (total > CHAT_MSG_PAGE ? `已显示全部 ${total} 条` : '');
  }
  const cnt = $('#chat-detail')?.querySelector('[data-field="chat-msg-count"]');
  if (cnt) {
    const meta = state.chats.find((c) => c.key === state.currentChatKey) || {};
    const t = meta.total || total || 0;
    // 2026-10-23：拉取上限 5000，超出时明确告知"只载入了最近多少条"，
    // 否则用户会把"看不到更早的"当成数据丢失。
    const clipped = t > total ? `（仅载入最近 ${total} 条，更早的在 data/messages 里）` : '';
    cnt.textContent = t
      ? `共 ${t} 条 · 已显示 ${shownCount} 条${clipped} · 存储于 data/messages/`
      : '暂无消息';
  }
}

/**
 * 滚动加载更多的追加路径：只把新批次的行插到 tbody 末尾。
 * 不重排（走缓存）、不重建已有行、不碰滚动位置 —— 内容加在视口下方，
 * 浏览器天然保持视口稳定，所以这里**绝对不能**做 scrollTop 补偿。
 */
function appendChatMessageRows(prevShown) {
  const tbody = $('#chat-msg-body');
  if (!tbody) return;
  const newestFirst = chatMessagesNewestFirst();
  const limit = Math.min(state.chatMsgLimit, newestFirst.length);
  const rows = newestFirst.slice(prevShown, limit);
  if (rows.length) tbody.insertAdjacentHTML('beforeend', rows.map(chatMsgRowHtml).join(''));
  state.chatMsgRendered = limit;
  updateChatMessagesMeta(newestFirst);
}

/**
 * 只更新消息表格的内容（不重建外层结构）。
 * 轮询刷新与首次填充走这里 —— 表格内容变长，但滚动容器没动，
 * 所以用户的滚动位置天然保持，不会再"自己弹回上面"。
 *
 * @param {boolean} keepScroll 轮询路径传 true：新消息从**顶部**进来，
 *        内容高度变化会把视口顶走，按增量补偿回阅读位置。
 *        （滚动加载更多不走这里，走 appendChatMessageRows —— 底部追加不需要补偿）
 */
function updateChatMessagesBody(keepScroll = false) {
  const detail = $('#chat-detail');
  const tbody = $('#chat-msg-body');
  if (!detail || !tbody) return;

  const prevTop = keepScroll ? detail.scrollTop : 0;
  const prevHeight = keepScroll ? detail.scrollHeight : 0;

  // 倒序后取前 N 条 = 最新的 N 条（排序结果走引用缓存，数据没变不重排）
  const newestFirst = chatMessagesNewestFirst();
  state.chatMsgLimit = Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE);
  const shown = newestFirst.slice(0, state.chatMsgLimit);

  tbody.innerHTML = shown.map(chatMsgRowHtml).join('');
  state.chatMsgRendered = shown.length;   // 行数账本：滚动追加靠它判断该不该走增量
  updateChatMessagesMeta(newestFirst);

  // 保险：若内容高度变了导致视口跳动，按增量补偿回来
  if (keepScroll) {
    const delta = detail.scrollHeight - prevHeight;
    if (delta !== 0) detail.scrollTop = prevTop + delta;
  }
}

/* ══════════════════════════════════════════════════════════════
 用量页图表（按天折线 + 按会话/按模型横向条形）

 表格是"精确"，图表是"一眼看懂"：趋势、谁占大头、集中在哪几天，
 这些扫一眼图就知道，扫表格得逐行做心算。图下面仍保留数值表（默认折叠）。

 ⚠️ 本项目 electron/main.js 关掉了硬件加速（软件渲染）：图表里
   不要用 backdrop-filter、不要给常驻元素加 animation。
 ══════════════════════════════════════════════════════════════ */
function usageMetric() {
  const m = state.usageMetric;
  return USAGE_METRICS.some(([k]) => k === m) ? m : 'runs';
}

/** 取某项在当前指标下的数值 */
function metricOf(item, metric = usageMetric()) {
  if (!item) return 0;
  if (metric === 'cost') return Number(item.cost) || 0;
  if (metric === 'tokens') return (Number(item.promptTokens) || 0) + (Number(item.completionTokens) || 0);
  return Number(item.runs) || 0;
}

/** 完整格式（气泡/条形末端用） */
function fmtMetric(v, metric = usageMetric()) {
  if (metric === 'cost') return fmtMoneyChart(v);
  if (metric === 'tokens') return fmtTokens(v);
  return String(Math.round(Number(v) || 0));
}

/** 图表里的金额：低于 1 元给 3 位即可（fmtYuan 给 4 位是给表格用的，条形上太吵） */
function fmtMoneyChart(n) {
  const v = Number(n) || 0;
  if (v === 0) return '¥0';
  return Math.abs(v) < 1 ? `¥${v.toFixed(3)}` : `¥${v.toFixed(2)}`;
}

/**
 * 坐标轴刻度用的紧凑格式（太长会把图挤变形）。
 *
 * ⚠️ token 分支已改为复用 fmtTokShort：过去这里是 `n >= 10000 ? round(n/1000)+'k'`
 * —— 没有 M 档且 Math.round 丢精度，1687 万 token 会在坐标轴上显示成
 * 「16872k」。现在与顶部概览条、卡片完全同一套换算。
 *
 * 成本分支同理补了 ¥1 万 / ¥100 万 档：一天成本上万时旧版会输出「¥12345」。
 */
function fmtMetricShort(v, metric = usageMetric()) {
  const n = Number(v) || 0;
  if (metric === 'cost') {
    const abs = Math.abs(n);
    if (abs >= 1e6) return `¥${(n / 1e6).toFixed(2)}M`;
    if (abs >= 1e4) return `¥${(n / 1e4).toFixed(1)}万`;
    return n >= 100 ? `¥${Math.round(n)}` : `¥${n.toFixed(n < 10 ? 2 : 1)}`;
  }
  return fmtTokShort(n);
}

/** 坐标轴上界取 1 / 2 / 5 × 10^n，刻度才好看 */
function niceMax(v) {
  const n = Number(v) || 0;
  if (n <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const r = n / pow;
  const step = r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10;
  return step * pow;
}

/**
 * 平滑曲线路径（单调三次 Hermite，Fritsch–Carlson 限幅）。
 * ⚠️ 刻意不用普通的 Catmull-Rom：它在陡升陡降处会「过冲」，把曲线甩到 0 以下
 * 或刻度上界以上，数据图里看着像假数据。这里的算法保证曲线始终落在相邻两点
 * 的取值区间内 → 既没有折角，又不会冒出假的峰谷。点数 < 2 时返回空串。
 */
function smoothPath(pts) {
  const n = pts.length;
  if (n < 2) return '';
  const dx = [], sec = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x || 1;
    sec[i] = (pts[i + 1].y - pts[i].y) / dx[i];
  }
  // 端点切线取相邻割线，中间点取两侧割线的平均（异号说明是极值点 → 切线压平）
  const t = new Array(n);
  t[0] = sec[0];
  t[n - 1] = sec[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = sec[i - 1] * sec[i] <= 0 ? 0 : (sec[i - 1] + sec[i]) / 2;
  // 限幅：把切线拉回单调区，过冲就是在这里被消掉的
  for (let i = 0; i < n - 1; i++) {
    if (sec[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / sec[i], b = t[i + 1] / sec[i];
    const s = a * a + b * b;
    if (s > 9) { const tau = 3 / Math.sqrt(s); t[i] = tau * a * sec[i]; t[i + 1] = tau * b * sec[i]; }
  }
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h3 = dx[i] / 3;
    d += `C${(pts[i].x + h3).toFixed(1)},${(pts[i].y + t[i] * h3).toFixed(1)}`
      + ` ${(pts[i + 1].x - h3).toFixed(1)},${(pts[i + 1].y - t[i + 1] * h3).toFixed(1)}`
      + ` ${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`;
  }
  return d;
}

/**
 * 按天折线图（平滑曲线）。
 * viewBox 用真实像素尺寸（= 实测容器宽 × 固定高），所以线宽与字号不会被拉伸。
 * 窗口缩放后由 bindUsageResize() 重画一次。
 *
 * 「一眼看懂」靠三件事：
 *   1. 曲线平滑，趋势比折线好读（且不过冲）；
 *   2. 图上方摘要条直接给出 峰值（带日期）/ 日均 / 合计，不用在图上找数字；
 *   3. 峰值点带虚线下引线、最新一点实心高亮，位置一目了然。
 * ⚠️ 所有文字都放在 SVG 外的摘要条里：页面背景是渐变光晕，SVG 文字没法靠纯色描边
 *    挖底，压在线/面积上会糊成一团。图上只留形状。
 * ⚠️ 圆点提示用 data-tip 而不是 SVG <title> —— 窗口是 transparent 的，
 *    原生 tooltip 会渲染成淡黄色色块（见 tooltip.js）。
 */
function usageLineChart(points, metric, width, height = 156) {
  const w = Math.max(280, Math.round(width || 680));
  const h = height;
  const padL = 46, padR = 14, padT = 10, padB = 22;
  const iw = w - padL - padR;
  const ih = h - padT - padB;
  const n = points.length;
  const vals = points.map((p) => metricOf(p, metric));
  const max = niceMax(Math.max(...vals, 0));
  const base = padT + ih;
  const X = (i) => (n <= 1 ? padL + iw / 2 : padL + (iw * i) / (n - 1));
  const Y = (v) => base - (max > 0 ? (ih * Math.max(0, v)) / max : 0);

  let grid = '';
  // 分 5 段：niceMax 取 1/2/5×10^n，除以 5 必定是整数（除 4 会出现 12.5 这种刻度）
  for (let i = 0; i <= 5; i++) {
    const v = (max * i) / 5;
    const y = Y(v).toFixed(1);
    grid += `<line class="uc-grid" x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}"/>`
         + `<text class="uc-ylabel" x="${padL - 7}" y="${(Number(y) + 3.5).toFixed(1)}" text-anchor="end">${esc(fmtMetricShort(v, metric))}</text>`;
  }

  // x 轴日期：点太多就均匀抽，避免标签叠在一起
  const step = Math.max(1, Math.ceil(n / 6));
  const shownX = new Set();
  for (let i = 0; i < n; i += step) shownX.add(i);
  // 最后一天离前一个标签太近就不画了，否则两个日期会叠在一起糊成一团
  if (n && (n - 1) - Math.max(...shownX) >= Math.max(1, step * 0.6)) shownX.add(n - 1);
  let xlabels = '';
  for (const i of [...shownX].sort((a, b) => a - b)) {
    if (!points[i]) continue;
    xlabels += `<text class="uc-xlabel" x="${X(i).toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(String(points[i].day || '').slice(5))}</text>`;
  }

  // ── 曲线 / 面积 ──
  const pts = points.map((p, i) => ({ x: X(i), y: Y(metricOf(p, metric)) }));
  const linePath = smoothPath(pts);
  const areaPath = linePath
    ? `${linePath} L${pts[n - 1].x.toFixed(1)},${base.toFixed(1)} L${pts[0].x.toFixed(1)},${base.toFixed(1)} Z`
    : '';

  // ── 峰值 / 日均（摘要条与图上的标记共用这两个值）──
  const peakV = Math.max(...vals, 0);
  const peakIdx = peakV > 0 ? vals.indexOf(peakV) : -1;
  const total = vals.reduce((a, v) => a + v, 0);
  const avg = n ? total / n : 0;
  const dayOf = (i) => String(points[i]?.day || '').slice(5);

  // 均值虚线：全 0 时贴着基线没意义，只有真的高于 0 才画
  const avgLine = avg > 0
    ? `<line class="uc-avg" x1="${padL}" y1="${Y(avg).toFixed(1)}" x2="${(w - padR).toFixed(1)}" y2="${Y(avg).toFixed(1)}"/>`
    : '';
  // 峰值下引线：一眼看出峰值落在哪一天（否则只能靠猜 x 轴）
  const peakGuide = peakIdx >= 0
    ? `<line class="uc-peak-guide" x1="${pts[peakIdx].x.toFixed(1)}" y1="${pts[peakIdx].y.toFixed(1)}" x2="${pts[peakIdx].x.toFixed(1)}" y2="${base.toFixed(1)}"/>`
    : '';

  // 点太密时普通点淡化处理（保留 3.4 半径的点击热区，只是不抢视线），峰值/最新永远醒目
  const dense = n > 22;
  const dots = points.map((p, i) => {
    const isPeak = i === peakIdx;
    const isLast = i === n - 1;
    const cls = ['uc-dot',
      dense && !isPeak && !isLast ? 'uc-dot-quiet' : '',
      isPeak ? 'uc-dot-peak' : '',
      isLast ? 'uc-dot-last' : ''].filter(Boolean).join(' ');
    const r = isPeak ? 4.6 : isLast ? 4.2 : 3.4;
    return `<circle class="${cls}" cx="${pts[i].x.toFixed(1)}" cy="${pts[i].y.toFixed(1)}" r="${r}" data-key="${esc(p.day)}" data-tip="${esc(String(p.day))}：${esc(fmtMetric(vals[i], metric))}"></circle>`;
  }).join('');

  const sumBar = `<div class="uc-sum">`
    + `<span class="uc-sum-item"><i>峰值</i><b>${esc(fmtMetric(peakV, metric))}</b>`
      + (peakIdx >= 0 ? `<span class="uc-sum-extra">${esc(dayOf(peakIdx))}</span>` : '') + `</span>`
    + `<span class="uc-sum-item${avg > 0 ? ' has-dash' : ''}"><i>日均</i><b>${esc(fmtMetric(avg, metric))}</b></span>`
    + `<span class="uc-sum-item"><i>合计</i><b>${esc(fmtMetric(total, metric))}</b></span>`
    + `</div>`;

  return `<div class="uc-line-wrap">${sumBar}`
       + `<svg class="usage-line" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img">`
       + grid + avgLine + peakGuide + xlabels
       + (areaPath ? `<path class="uc-area" d="${areaPath}"/>` : '')
       + (linePath ? `<path class="uc-line" d="${linePath}"/>` : '')
       + dots
       + `</svg></div>`;
}

/**
 * 横向条形图（分类排名用）。会话/模型是并列关系，折线会误导"前后有趋势"，
 * 条形一眼看出谁多谁少。
 *
 * 「一眼看懂」靠三件事：
 *   1. 左侧名次徽标 + 条色随名次递减（第一名最实），不用逐行比长度；
 *   2. 每行右侧给百分比；条形按最大值归一化，第一名永远满格；
 *   3. 底部汇总「合计 + 前 N 项占比」，直接看出集中度（少数会话吃掉大部分用量）。
 */
function usageBars(list, metric, labelOf, limit = 8) {
  // key 做二级比较项，保证排序稳定（同指标值的条目不随刷新跳动）
  const items = (list || []).slice().sort((a, b) => {
    const d = metricOf(b, metric) - metricOf(a, metric);
    if (d) return d;
    return String(a.key ?? '').localeCompare(String(b.key ?? ''));
  });
  if (!items.length) return '<div class="uc-empty muted">这段时间没有记录</div>';
  const shown = items.slice(0, limit);
  const max = Math.max(...shown.map((x) => metricOf(x, metric)), 0) || 1;
  const totalV = items.reduce((a, x) => a + Math.max(0, metricOf(x, metric)), 0);
  const topV = shown.reduce((a, x) => a + Math.max(0, metricOf(x, metric)), 0);
  const topPct = totalV > 0 ? (topV / totalV) * 100 : 0;
  const rest = items.slice(limit);

  const rows = shown.map((x, i) => {
    const v = metricOf(x, metric);
    // ⚠️ 曾经是 Math.max(2, (v/max)*100)：值为 0 的项也被画出 2% 宽的条，
    // 看起来"有数据"，点进去却是 0。零值就该是零宽度（仍保留行与百分比，
    // 用户能看到"有这一项但没用量"）。
    const w = max > 0 ? Math.max(0, (v / max) * 100) : 0;
    // 占比分母用全量 totalV（不截断），保证所有行占比之和为 100%。
    // 负数（如退款场景）会破坏这个不变量，所以负值一律按 0 显示，
    // 避免出现「各行加起来 120%」的诡异数字。
    const share = totalV > 0 ? Math.max(0, (v / totalV) * 100) : 0;
    // 名次色阶：第一名 1.0，每降一名淡 0.1，最低 0.34（再淡就看不清了）
    const alpha = Math.max(0.34, 1 - i * 0.1);
    return `<div class="uc-bar-row${i === 0 ? ' top' : ''}" data-key="${esc(x.key)}" role="button" tabindex="0" title="点击查看明细">`
         + `<div class="uc-bar-label"><span class="uc-rank">${i + 1}</span><span class="uc-name">${esc(labelOf(x))}</span></div>`
         + `<div class="uc-bar-track"><div class="uc-bar-fill" style="width:${w.toFixed(1)}%;opacity:${alpha.toFixed(2)}"></div></div>`
         + `<div class="uc-bar-val">${esc(fmtMetric(v, metric))}<span class="uc-bar-share">· ${share.toFixed(0)}%</span></div>`
         + `</div>`;
  }).join('');

  // 全部项都已经画出来时，「前 N 项占 100%」是废话，只留合计
  const foot = `<div class="uc-rest">合计 <b>${esc(fmtMetric(totalV, metric))}</b>`
    + (rest.length
        ? ` · 前 ${shown.length} 项占 <b>${topPct.toFixed(0)}%</b> · 其余 ${rest.length} 项占 <b>${(100 - topPct).toFixed(0)}%</b>`
        : '')
    + `</div>`;
  return `<div class="uc-bars">${rows}</div>${foot}`;
}

/** 画三张图（用 dataset.sig 做内容指纹，轮询时内容没变就不动 DOM） */
function renderUsageCharts(stats, box) {
  if (!box) return;
  const metric = usageMetric();
  const days = stats?.days || [];
  const host = box.querySelector('[data-chart="days"]');
  // 折线图要用真实像素宽度：优先量自己的容器，量不到再退回外层
  const width = (host?.clientWidth || box.clientWidth || 680) - 4;
  const html = {
    days: days.length ? usageLineChart(days, metric, width) : '<div class="uc-empty muted">这段时间没有记录</div>',
    chats: usageBars(stats?.chats, metric, (c) => formatChatTitle(c.key, chatNameOf(c.key))),
    models: usageBars(stats?.models, metric, (m) => (m.vendor ? `${m.vendor}：${m.model}` : (m.model ?? m.key)))
  };
  for (const name of Object.keys(html)) {
    const el = box.querySelector(`[data-chart="${name}"]`);
    if (!el) continue;
    // 宽度变了也要重画（否则折线图会被拉伸变形）
    const sig = `${width}|${html[name]}`;
    if (el.dataset.sig !== sig) { el.innerHTML = html[name]; el.dataset.sig = sig; }
  }
}

/** 窗口缩放后重画图表（只挂一次，防重复绑定） */
let usageResizeBound = false;
function bindUsageResize() {
  if (usageResizeBound) return;
  usageResizeBound = true;
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const args = state.usageRenderArgs;
      const box = $('#usage-page');
      if (!args || !box || state.tab !== 'usage') return;
      // ⚠️ 必须核对 args 是不是当前范围的：state.usageRenderArgs 里存的是
      // **最近一次渲染时**的参数，而 resize 是 200ms 防抖的。若用户在这
      // 200ms 内切了时间范围，页面上的表已是新范围，args.stats 还是旧的
      // → 重画出来的图与表格对不上。现在渲染时一并记下范围（见
      // updateUsagePage），这里比对不一致就跳过，等下次数据回来自然重画。
      if (args.range !== usageRange) return;
      box.querySelectorAll('.usage-chart').forEach((el) => { el.dataset.sig = ''; });
      renderUsageCharts(args.stats, box);
    }, 200);
  }, { passive: true });
}

function renderUsageSkeleton() {
  const card = '<div class="usage-card skeleton"><div class="sk-line"></div><div class="sk-line short"></div></div>';
  // 图表占位：一排参差小柱 + 扫光（暗示"这里会出现折线/条形图"）
  const cols = [38, 62, 45, 80, 55, 70, 40, 90, 58, 66, 48, 74, 60, 42]
    .map((h) => `<i class="sk-col" style="height:${h}%"></i>`).join('');
  const chart = (h) => `<div class="sk-chart" style="height:${h}px">${cols}</div>`;
  const h3 = '<div class="sk-line" style="width:64px;height:15px;margin:22px 0 10px"></div>';
  // 说明行 + 摘要行占位：正式版式里每块都有这两条（2026-10-19 统一版式），
  // 不占位的话数据回来时整页会往下跳约 200px。
  const note = '<div class="sk-line" style="width:58%;height:11px;margin:0 0 10px"></div>';
  const sum = '<div class="sk-line" style="width:86%;height:30px;margin:0 0 11px;border-radius:9px"></div>';
  // 顺序与正式页面一致（控制条 → 三块图 → 统计卡），加载完成时布局不跳。
  // 提示文案（R49）：大数据下统计可能要几秒，让用户知道页面没死。
  return `
    <div class="usage-wrap">
      <div class="usage-head">
        <h2>用量与成本</h2>
        <span class="muted" style="font-size:12px">正在统计…历史数据较多时可能需要几秒</span>
      </div>
      <div class="usage-ctrl"><span class="sk-line" style="width:280px;height:26px;margin:0"></span></div>
      ${h3}${note}${sum}${chart(190)}
      ${h3}${note}${sum}${chart(150)}
      ${h3}${note}${sum}${chart(150)}
      <div class="usage-cards" style="margin-top:22px">${card.repeat(5)}</div>
    </div>`;
}

/** 建骨架（只建一次，轮询走 updateUsagePage 以免滚动位置丢失）。 */
function renderUsagePage(stats, st, prices) {
  const box = $('#usage-page');
  if (!box) return;

  box.innerHTML = `
    <div class="usage-wrap">
      <div class="usage-head">
        <h2>用量与成本</h2>
      </div>

      <!-- 控制条（指标 + 时间范围 + 刷新）贴着第一张图放，但要**独立于 [data-block="days"]**：
           ⚠️ 选「今日 / 24 小时」时后端 mode ≠ 'days'，updateUsagePage 会把整个
              [data-block="days"] 隐藏（那时光图表本来就没数据）——控制条若住在里面
              会跟着一起消失（实测 bug：点「今日」后所有按钮都不见了）。
           所以它必须是 days 块的**兄弟节点**，位置仍紧贴图表上方。 -->
      <div class="usage-ctrl">
        <span class="usage-metrics" title="选择三张图表显示的指标">
          <span class="usage-metrics-label">图表</span>
          ${USAGE_METRICS.map(([k, label]) => `<button class="btn btn-small" data-metric="${k}">${label}</button>`).join('')}
        </span>
        <span class="usage-sep"></span>
        ${USAGE_RANGES.map(([v, label]) => `<button class="btn btn-small" data-range="${v}">${label}</button>`).join('')}
        <button class="btn btn-small" id="usage-refresh-btn" title="立即重算（跳过 3 小时缓存）">刷新</button>
        <span class="usage-fresh" id="usage-updated"></span>
      </div>

      <div data-block="days" class="usage-sec">
        <div class="usage-sec-head">
          <h3 class="usage-h3">按天</h3>
          <span class="usage-sec-meta" data-meta="days"></span>
        </div>
        <p class="usage-sec-note" data-note="days">一天一个点。看整体趋势和峰值，单日高低主要取决于那天聊得多不多。</p>
        <p class="usage-sec-sum" data-sum="days"></p>
        <!-- 时间序列 → 折线图（看趋势） -->
        <div class="usage-chart" data-chart="days"></div>
        <!-- 原始数值表：默认折叠，精确数字与点击下钻都还在 -->
        <details class="usage-details">
          <summary>数值表</summary>
          <table class="usage-table clickable" data-table="days">
            <thead><tr><th>日期</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">缓存命中</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
            <tbody></tbody>
          </table>
        </details>
        <details class="usage-details usage-details-sub">
          <summary>这些数字是怎么算的？</summary>
          <div class="up-howto-body">
            <p><b>哪一天</b>：按每次模型调用的<b>发生时刻</b>归日（本地时区）。一个跨零点的会话会被拆到两天，不会整段记在结束那天。</p>
            <p><b>缓存命中</b>：输入里命中前缀缓存、按折扣价计费的那部分；命中率 = 命中 ÷ 输入 token。</p>
            <p><b>成本</b>：各模型单价 × 用量。价格取「设置 → 模型与搜索 → 当前模型单价」，模型没有内置单价时按 0 计 —— 那是缺价，不是统计失败。</p>
            <p><b>图表画什么</b>：由上方「图表」按钮决定（调用次数 / 成本 / Token）；数值表始终给全量，不受指标切换影响。</p>
          </div>
        </details>
      </div>

      <div data-block="chats" class="usage-sec">
        <div class="usage-sec-head">
          <h3 class="usage-h3">按会话</h3>
          <span class="usage-sec-meta" data-meta="chats"></span>
        </div>
        <p class="usage-sec-note" data-note="chats">一个会话一条。排在前面的是消耗大户——聊得越久，每轮重发的历史越贵。</p>
        <p class="usage-sec-sum" data-sum="chats"></p>
        <!-- 分类排名 → 横向条形（折线会暗示"前后有趋势"，反而误导） -->
        <div class="usage-chart" data-chart="chats"></div>
        <details class="usage-details">
          <summary>数值表</summary>
          <table class="usage-table clickable" data-table="chats">
            <thead><tr><th>会话</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
            <tbody></tbody>
          </table>
        </details>
        <details class="usage-details usage-details-sub">
          <summary>这些数字是怎么算的？</summary>
          <div class="up-howto-body">
            <p><b>一个「会话」</b>＝一次完整对话（群聊、私聊各算一个），名字取会话标题。它的 token 与成本是所有模型调用的累加。</p>
            <p><b>为什么有的会话特别贵</b>：每次对话都要把这段历史重发一遍。同一句话在第 2 轮和第 40 轮的成本差几十倍——贵的是历史，不是新消息。</p>
            <p><b>排序</b>按上方「图表」指标（调用次数 / 成本 / Token）；点任意一根条或表格里的行，可以看这个会话逐步花在哪。</p>
            <p><b>更早的会话</b>：本地只保留最近 120 个会话明细（<code>store.keepSessionFiles</code>），被裁掉的那些仍按天记在账本里、照样计入合计，只是在这张按会话表里看不到明细。</p>
          </div>
        </details>
      </div>

      <div data-block="models" class="usage-sec">
        <div class="usage-sec-head">
          <h3 class="usage-h3">按模型</h3>
          <span class="usage-sec-meta" data-meta="models"></span>
        </div>
        <p class="usage-sec-note" data-note="models">同一个模型走不同渠道算两个——官方、中转站、<code>:free</code> 版本的价格可能差好几倍。</p>
        <p class="usage-sec-sum" data-sum="models"></p>
        <div class="usage-chart" data-chart="models"></div>
        <details class="usage-details">
          <summary>数值表</summary>
          <!-- ⚠️ 这个按钮从 h3 挪进来了（表格现在默认折叠，按钮留在标题上会点不着） -->
          <div class="usage-details-tools">
            <button class="btn btn-small ub-expand" id="models-expand" style="display:none">展开全部</button>
          </div>
          <table class="usage-table clickable" data-table="models">
            <thead><tr><th>模型（渠道：模型 id）</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
            <tbody></tbody>
          </table>
        </details>
        <details class="usage-details usage-details-sub">
          <summary>这些数字是怎么算的？</summary>
          <div class="up-howto-body">
            <p><b>为什么写成「渠道：模型 id」</b>：同一个 id 走官方直连和中转站是不同的商品，单价可能差几倍，混在一起会算错账，所以拆成两行。</p>
            <p><b>成本</b>：用量 × 「设置 → 模型与搜索 → 当前模型单价」里匹配到的单价。匹配不到单价时显示 ¥0 —— 那表示缺价，可以去那里补一条。</p>
            <p><b>命中率</b>：命中缓存 ÷ 输入 token。不同渠道的提示词前缀不一样，命中率会各自算，不要横向直接比。</p>
            <p><b>超过 20 行</b>时数值表默认只显示前 20 行，点「展开全部」看其余（求和与图不受影响，后端从不截断）。</p>
          </div>
        </details>
      </div>

      <!-- ── 按插件（2026-10-19 新增）──
           回答"是谁花的 token"：每个插件每次请求的固定开销（提示词片段 + 工具定义）、
           区间内实际调用次数与返回内容 token、以及易变片段对缓存命中率的影响。
           数据来自 /api/usage/plugins（src/plugin-usage.js），数值为估算值
           （字符 / 2.5，与 llm.js 的 LCP 日志同口径）。 -->
      <div data-block="plugins" class="usage-sec">
        <div class="usage-sec-head">
          <h3 class="usage-h3">按插件</h3>
          <!-- 段落头右侧：先给一句计量（几个插件、几个在用），再放本块专属的排序切换。
               四个块的段落头都是「左标题 + 右小字/小按钮」这一副骨架（2026-10-19 统一）。 -->
          <span class="usage-sec-side">
            <span class="usage-sec-meta" data-meta="plugins"></span>
            <span class="up-metric" data-up="metricbar">
              <span class="up-metric-label">排行依据</span>
              <button class="btn btn-small" type="button" data-plugin-metric="total">区间总消耗</button>
              <button class="btn btn-small" type="button" data-plugin-metric="fixed">每次固定</button>
              <button class="btn btn-small" type="button" data-plugin-metric="calls">调用次数</button>
            </span>
          </span>
        </div>

        <p class="usage-sec-note" data-note="plugins">每次对话都会把<b>插件说明 + 工具说明 + 聊天记录</b>一起发给模型。最后一行「对话内容」是参照系——它不属于任何插件，但同样在花钱。</p>
        <p class="usage-sec-sum" data-sum="plugins"></p>
        <div class="usage-chart" data-chart="plugins"></div>

        <details class="usage-details">
          <summary>数值表</summary>
          <table class="usage-table clickable" data-table="plugins">
            <thead><tr>
              <th>插件</th>
              <th class="r">每次固定</th>
              <th class="r" title="区间总消耗 = 每次固定 × 调用次数 + 工具结果">区间总消耗</th>
              <th class="r" title="插件写给模型看的「行为说明」占用">行为说明</th>
              <th class="r" title="插件工具的说明书（名称、描述、参数）占用">工具说明</th>
              <th class="r">区间使用</th>
              <th class="r" title="工具返回结果占用，会作为历史反复重发">结果 token</th>
              <th class="r" title="易变内容占比：越高，每轮越难命中缓存">缓存影响</th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </details>

        <details class="usage-details usage-details-sub">
          <summary>这些数字是怎么来的？</summary>
          <div class="up-howto-body">
            <p><b>对话内容</b>（排行最后一行）：不是插件，是「这次输入里除了插件和工具说明之外剩下的部分」——聊天记录、人设、当前状态。它的口径是「每次真实输入 − 插件与工具说明」，用减法倒推，所以它一定和总数对得上。</p>
            <p><b>那"每轮新说的话"呢？</b>新消息本身很小（通常几十 token，见摘要行末尾的提示），但它会进入聊天记录，<b>之后每一次对话都要把它重发一遍</b>——所以聊得越久，单次输入越贵。要省钱，缩短历史比少说一句话有用得多。</p>
            <p><b>每次固定</b>：这个插件每次对话固定要付的 token = 说明文字 + 工具说明。即使没被调用也在付。</p>
            <p><b>区间使用</b>：这段时间里它的功能被真正调用了几次；「未使用」表示装了但一次都没用过，却仍在付固定消耗。</p>
            <p><b>结果 token</b>：功能返回的内容会存进对话历史，之后每一轮都会重新发给模型，是容易被忽视的一笔。</p>
            <p><b>缓存影响</b>：插件的说明里有一部分每轮都会变（比如当前状态），这部分无法命中缓存，只能按原价重算。没有这类内容的插件显示「无」。</p>
            <p>token 为估算值（字符 ÷ 2.5），用于横向比较大小，不适合拿去对账。</p>
          </div>
        </details>
      </div>

      <!-- 统计卡整排挪到图表之后（需求：先看趋势，再看精确数字；首屏只剩标题+图，更简洁）。
           ⚠️ 这些 data-field / id 一个都不能少 —— updateUsagePage 靠它们填数值，
              #runs-card 的点击绑定也挂在 renderUsagePage 里。
           估算成本仍是第一张：它是这页的主指标（accent 描边/底色突出）。 -->
      <div class="usage-cards">
        <div class="usage-card accent">
          <div class="uc-label">估算成本</div>
          <div class="uc-value" data-field="cost">-</div>
          <div class="uc-sub" data-field="cost-sub">-</div>
        </div>
        <div class="usage-card clickable" id="runs-card" title="点击查看各类工具分别调用了多少次">
          <div class="uc-label">模型调用次数 <span class="uc-more">明细 ›</span></div>
          <div class="uc-value" data-field="runs">-</div>
          <div class="uc-sub" data-field="runs-sub">-</div>
        </div>
        <div class="usage-card">
          <div class="uc-label">搜索次数 <span class="uc-tag">不计入成本</span></div>
          <div class="uc-value" data-field="search">-</div>
          <div class="uc-sub" data-field="search-sub">-</div>
        </div>
        <div class="usage-card">
          <div class="uc-label">输入 token</div>
          <div class="uc-value" data-field="prompt">-</div>
          <div class="uc-sub" data-field="prompt-sub">-</div>
        </div>
        <div class="usage-card">
          <div class="uc-label">缓存命中率</div>
          <div class="uc-value" data-field="rate">-</div>
          <div class="usage-bar"><div class="usage-bar-fill ok" data-field="rate-bar" style="width:0%"></div></div>
          <div class="uc-sub" data-field="rate-sub">-</div>
        </div>
      </div>
    </div>`;

  // 「调用次数」卡片可点开明细（骨架重建后重新绑定，所以放在 renderUsagePage 里）
  const runsCard = $('#usage-page #runs-card');
  if (runsCard) runsCard.addEventListener('click', () => openToolBreakdown());

  $$('#usage-page [data-range]').forEach((el) => {
    el.addEventListener('click', () => {
      usageRange = el.dataset.range;
      loadUsageView({ force: true });
    });
  });
  $('#usage-refresh-btn')?.addEventListener('click', () => loadUsageView({ force: true, hard: true }));

  // 图表指标切换：只重画图，不重新请求接口（数据没变）
  $$('#usage-page [data-metric]').forEach((el) => {
    el.addEventListener('click', () => {
      state.usageMetric = el.dataset.metric;
      const args = state.usageRenderArgs;
      if (args) updateUsagePage(args.stats, args.st, args.prices);
    });
  });

  // ── 图表点击 / 键盘下钻（委托挂 box 上，必须防重复绑定）──
  // ⚠️（2026-10-12 修「明细弹窗多开」）box 是 #usage-page —— index.html 里的
  //    **持久容器**，而本函数会被反复调用（切到用量页签 / 切时间范围 / 点刷新
  //    都走 loadUsageView({force:true}) → 在此重建骨架）。委托监听器挂在 box
  //    自身上，innerHTML 重建**清不掉它们** —— 每调用一次就多积一份。
  //    积 N 份后，点一次图表条形会同时触发 N 次 openUsageBreakdown → 弹出 N 个
  //    完全相同的「明细」弹窗（用户报障：「点击明细弹出很多个弹窗」，且每次
  //    刷新后再点都会再多一个）。表格行的绑定挂在每次重建的 table 元素上，
  //    不受影响；此处两个是唯一挂在持久容器上的。
  //    与 bindSessionListDelegation（dataset.delegated）/ bindMarketList
  //    （dataset.mkBound）/ __chatDelBound、__quoteBound 同一约定：只绑一次。
  if (box.dataset.usageDrillBound !== '1') {
    box.dataset.usageDrillBound = '1';
    // 图表点击 → 与表格行点击走同一套下钻
    box.addEventListener('click', (e) => {
      const hit = e.target.closest('.usage-chart [data-key]');
      if (!hit) return;
      const chart = hit.closest('[data-chart]');
      const dim = chart?.dataset.chart === 'days' ? 'day' : chart?.dataset.chart === 'chats' ? 'chat' : 'model';
      openUsageBreakdown(dim, hit.dataset.key);
    });
    // 键盘可达：条形图是 tabindex 元素，回车等同点击
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const hit = e.target.closest?.('.usage-chart [data-key]');
      if (!hit) return;
      e.preventDefault();
      const chart = hit.closest('[data-chart]');
      const dim = chart?.dataset.chart === 'days' ? 'day' : chart?.dataset.chart === 'chats' ? 'chat' : 'model';
      openUsageBreakdown(dim, hit.dataset.key);
    });
  }

  bindUsageResize();

  // 行点击 → 弹明细
  box.querySelector('[data-table="days"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('day', tr.dataset.key);
  });
  box.querySelector('[data-table="chats"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('chat', tr.dataset.key);
  });
  box.querySelector('[data-table="models"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('model', tr.dataset.key);
  });

  // 「展开全部 / 收起」按钮：显隐与文案由 updateUsagePage 里的 fill() 负责，
  // 但此前**没有任何地方监听它的点击**，也没有代码把 tbody.dataset.expanded 置为 '1' ——
  // 结果是：模型超过 20 行时按钮会出现、写着「展开全部（还有 N 行）」，点下去却毫无反应，
  // 剩下的行永远看不到。这里补上开合逻辑（复用 updateUsagePage 重绘，不重新请求接口）。
  const modelsExpandBtn = box.querySelector('#models-expand');
  if (modelsExpandBtn) {
    modelsExpandBtn.addEventListener('click', () => {
      const tb = box.querySelector('[data-table="models"] tbody');
      const args = state.usageRenderArgs;
      if (!tb || !args) return;
      tb.dataset.expanded = tb.dataset.expanded === '1' ? '0' : '1';
      updateUsagePage(args.stats, args.st, args.prices);
    });
  }

  updateUsagePage(stats, st, prices);
}

/** 只更新数值与表格行，不碰骨架。 */
function updateUsagePage(stats, st, prices) {
  const box = $('#usage-page');
  if (!box) return;
  // 记住最近一次渲染参数：供「展开全部/收起」按钮与窗口缩放重画图表使用。
  // range 必须一起记 —— resize 回调要靠它判断这份 stats 是不是当前范围的
  // （见 bindUsageResize 里的注释）。
  state.usageRenderArgs = { stats, st, prices, range: usageRange };
  const t = stats?.totals || {};
  const cfg = state.config || {};

  // 统一存字符串：曾经这里把数字直接赋给 textContent（如 runs=0 时存的是数字 0
  // 而非 '0'）。浏览器会隐式转换所以显示没问题，但类型不一致会在别处埋雷
  // （比较、测试断言、序列化时都可能踩到）。这里显式转成字符串。
  const set = (f, v) => {
    const el = box.querySelector(`[data-field="${f}"]`);
    if (!el) return;
    const s = String(v);
    if (el.textContent !== s) el.textContent = s;
  };

  // 价格口径说明（不再显示"当前模型" —— 全天可能换过多个模型）
  const today = st?.usage || {};
  set('runs', t.runs || 0);
  // ⚠️ 这两个数字**口径不同**，曾经并排显示成「132 / 今日 800 次」，
  // 用户必然以为数据错了：
  //   大字 runs      = LLM 调用次数（本页统计，一个会话多轮就是多次）
  //   /api/status 的 usage.runs = 会话运行次数（每完成一个会话 +1）
  // 现在把口径写进文案，避免"看起来自相矛盾"。
  set('runs-sub', `今日 ${today.runs ?? 0} 次会话运行`);
  // 搜索次数：只列数量，不参与成本计算（搜索通常是资源包或免费的）
  const searches = Number(stats?.searchCount) || 0;
  set('search', fmtTok(searches));
  // 拆开显示搜索与抓取的构成（曾经三元两分支文案相同，判定是死逻辑）
  {
    const nSearch = Number(stats?.toolCounts?.web_search) || 0;
    const nFetch = Number(stats?.toolCounts?.web_fetch) || 0;
    set('search-sub', searches
      ? `搜索 ${nSearch} · 抓网页 ${nFetch}`
      : '本区间没有联网');
  }
  set('prompt', fmtTok(t.promptTokens));
  set('prompt-sub', `输出 ${fmtTok(t.completionTokens)}`);
  set('rate', fmtRate(t.cacheHitRate));
  set('rate-sub', `命中 ${fmtTok(t.cachedTokens)} / 输入 ${fmtTok(t.promptTokens)}`);
  set('cost', fmtYuan(t.cost));
  // ⚠️（2026-10-17 N7）成本 0 有**两种完全不同的含义**，必须让用户分得清：
  //   ① 真的没花钱（免费模型 / 本区间没调用）—— 正常；
  //   ② **没匹配到官方单价**（走中转站、或模型不在内置价格表里）——
  //      算术上只能得 0，但看起来像"统计坏了 / 价格算错了"。
  //   实测本机：模型是 `sensenova-6.8-flash-lite`（token.sensenova.cn 中转站），
  //   内置官方价格表里查无此模型 → 快照里 cost 全为 0，而 token 有近千万。
  //   这不是 bug（顶栏早就为此不显示 ¥0），但用量页的副标题上没说清楚，
  //   容易被误当成故障。这里补一句，并指向可自定义单价的位置。
  const costZero = !(Number(t.cost) > 0);
  const noPriceHint = (costZero && (Number(t.totalTokens) || 0) > 0)
    ? '未匹配到内置官方单价（中转站 / 未收录模型），可在「设置 → 模型与搜索 → 当前模型单价」自定义'
    : '';
  set('cost-sub', [stats?.rangeLabel || '', noPriceHint].filter(Boolean).join(' · '));
  const bar = box.querySelector('[data-field="rate-bar"]');
  const rate = Number(t.cacheHitRate);
  if (bar) bar.style.width = `${(Number.isFinite(rate) ? Math.max(0, Math.min(100, rate * 100)) : 0).toFixed(1)}%`;

  // 范围按钮高亮
  $$('#usage-page [data-range]').forEach((el) => {
    el.classList.toggle('btn-primary', el.dataset.range === String(usageRange));
  });

  // 统计新鲜度：服务端把统计结果缓存住了（默认 3 小时一次），所以这页的数字
  // 未必是"刚刚"的。必须把算出来的时刻摆出来 —— 否则用户会拿一个几小时前的
  // 成本数当成实时的，那比"慢"更糟。想立刻要最新的就点右边「刷新」。
  const fresh = box.querySelector('#usage-updated');
  if (fresh) {
    const at = Number(stats?.computedAt) || 0;
    const txt = at ? `数据更新于 ${fmtTime(at)}` : '';
    if (fresh.textContent !== txt) fresh.textContent = txt;
    fresh.title = '用量统计每 3 小时自动重算一次；点「刷新」立即重算。'
      + '页面顶部的「今日」概览是实时的，不受此缓存影响。';
  }

  // 单日/24小时 → 隐藏"按天"
  const daysBlock = box.querySelector('[data-block="days"]');
  if (daysBlock) daysBlock.style.display = (stats?.mode === 'days') ? '' : 'none';

  // 行数很多时（按模型常有几十行）默认只显示前 N 行，点"展开全部"再看全部。
  // 注意：后端不截断（保证求和一致），这里只是前端显示层面的折叠。
  const COLLAPSE_AT = 20;
  /**
   * 按当前指标降序排（与横向条形图 usageBars 用的是同一个 metricOf）。
   *
   * ⚠️ 曾经表格直接用后端顺序（cost 优先，见 app.js 的 mergeGroups），
   * 而条形图按**当前选中指标**排 —— 于是切到「Token」指标时，
   * 「按模型」的图按 token 排、它下面的表还按成本排，同一个维度两种顺序，
   * 用户对照时会以为数据错了。
   *
   * 排序必须**稳定**：大量条目 cost 为 0，若只按指标值比较，
   * 相等项的相对顺序取决于后端 Map 的插入序（= readdirSync 顺序，
   * 依赖文件系统），每次刷新可能不一样。所以用 key 做二级比较。
   */
  const sortByMetric = (list) => (list || []).slice().sort((a, b) => {
    const d = metricOf(b) - metricOf(a);
    if (d) return d;
    return String(a.key ?? '').localeCompare(String(b.key ?? ''));
  });
  const fill = (name, list, build, opts = {}) => {
    const tbody = box.querySelector(`[data-table="${name}"] tbody`);
    if (!tbody) return;
    const wanted = sortByMetric(list);
    const collapsed = Boolean(opts.collapsible) && wanted.length > COLLAPSE_AT
      && tbody.dataset.expanded !== '1';
    const shown = collapsed ? wanted.slice(0, COLLAPSE_AT) : wanted;
    const moreBtn = opts.expandBtn ? box.querySelector(opts.expandBtn) : null;
    if (moreBtn) {
      if (wanted.length > COLLAPSE_AT) {
        moreBtn.style.display = '';
        moreBtn.textContent = collapsed
          ? `展开全部（还有 ${wanted.length - COLLAPSE_AT} 行）`
          : '收起';
      } else {
        moreBtn.style.display = 'none';
      }
    }
    // 折叠起来的表格：把行数写进 summary，用户才知道值不值得展开
    const det = tbody.closest('details');
    const sumEl = det ? det.querySelector('summary') : null;
    if (sumEl) {
      const txt = wanted.length ? `数值表（${wanted.length} 行）` : '数值表（无记录）';
      if (sumEl.textContent !== txt) sumEl.textContent = txt;
    }
    if (!wanted.length) {
      if (tbody.dataset.empty !== '1') {
        // ⚠️ 曾经写死 colspan="7"，但「按会话」表只有 6 列 —— 空态的
        // 占位格比表头多一格，视觉上会错位。改为读真实列数，读不到再兜底 1。
        const cols = Number(tbody.closest('table')?.querySelectorAll('thead th').length) || 1;
        tbody.innerHTML = `<tr><td colspan="${cols}" class="muted">无</td></tr>`;
        tbody.dataset.empty = '1';
      }
      return;
    }
    tbody.dataset.empty = '0';
    const html = shown.map(build).join('');
    if (tbody.dataset.sig !== html) { tbody.innerHTML = html; tbody.dataset.sig = html; }
  };

  fill('days', stats?.days, (d) => `
    <tr data-key="${esc(d.day)}">
      <td>${esc(d.day)}</td>
      <td class="r">${d.runs}</td>
      <td class="r">${fmtTok(d.promptTokens)}</td>
      <td class="r">${fmtTok(d.completionTokens)}</td>
      <td class="r">${fmtTok(d.cachedTokens)}</td>
      <td class="r">${fmtRate(d.cacheHitRate)}</td>
      <td class="r">${fmtYuan(d.cost)}</td>
    </tr>`);

  fill('chats', stats?.chats, (c) => `
    <tr data-key="${esc(c.key)}">
      <td>${esc(formatChatTitle(c.key, chatNameOf(c.key)))}</td>
      <td class="r">${c.runs}</td>
      <td class="r">${fmtTok(c.promptTokens)}</td>
      <td class="r">${fmtTok(c.completionTokens)}</td>
      <td class="r">${fmtRate(c.cacheHitRate)}</td>
      <td class="r">${fmtYuan(c.cost)}</td>
    </tr>`);

  // 模型与供应商分两列显示：同一个 id 走不同渠道是不同的"商品"，
  // 价格可能差很多（中转站加价、:free 版本等），必须能区分开。
  fill('models', stats?.models, (m) => `
    <tr data-key="${esc(m.key)}">
      <td>${esc(m.vendor ? `${m.vendor}：${m.model}` : (m.model ?? m.key))}</td>
      <td class="r">${m.runs}</td>
      <td class="r">${fmtTok(m.promptTokens)}</td>
      <td class="r">${fmtTok(m.completionTokens)}</td>
      <td class="r">${fmtRate(m.cacheHitRate)}</td>
      <td class="r">${fmtYuan(m.cost)}</td>
    </tr>`, { collapsible: true, expandBtn: '#models-expand' });

  // 图表指标按钮高亮
  $$('#usage-page [data-metric]').forEach((el) => {
    el.classList.toggle('btn-primary', el.dataset.metric === usageMetric());
  });

  // 四个维度块的段落计量 + 摘要行（「按插件」那块由 renderPluginUsage 自己填）
  fillUsageSectionSummaries(stats, box);

  // 三张图（按天折线 / 按会话条形 / 按模型条形）
  renderUsageCharts(stats, box);
}

/**
 * 缓存命中率百分比。
 *
 * ⚠️ 曾经卡片用 1 位小数、表格用 0 位小数，同一页两种精度（`96.7%` vs `97%`），
 * 用户对照表格时会以为算错了。现在统一 1 位。
 * 同时不再用 `x.cacheHitRate || 0` —— 那会把"字段缺失(undefined)"与
 * "真实的 0"混为一谈，这里显式区分：缺失时显示 '—' 而不是骗人的 0%。
 */
function fmtRate(rate) {
  if (rate === null || rate === undefined || !isFinite(Number(rate))) return '—';
  return `${(Math.min(1, Math.max(0, Number(rate))) * 100).toFixed(1)}%`;
}

/* ══════════════════════════════════════════════════════════════
   四个维度块统一的「段落计量 + 摘要行」
   （2026-10-19 用户要求：按天 / 按会话 / 按模型 / 按插件 四块风格统一）

   每块固定四段，顺序不再各自发挥：
     ① .usage-sec-head   左标题 + 右侧计量（data-meta）
     ② .usage-sec-note   一行说明（静态文案，写在骨架里）
     ③ .usage-sec-sum    摘要行（本函数按数据生成；「按插件」由 renderPluginUsage 填）
     ④ .usage-chart      图表 —— 再往下是折叠的数值表与口径说明

   摘要行只写「不看数字就不知道的事」：平均、最大、占比、命中率。
   合计/占比这类图里已经有的（.uc-rest 脚注）不再重复 ——
   同一个数字在一页里出现三遍，读者反而不知道该信哪个。
   ══════════════════════════════════════════════════════════════ */
function fillUsageSectionSummaries(stats, box) {
  if (!box) return;
  const t = stats?.totals || {};
  const metric = usageMetric();
  // 占比的口径要跟着上方「图表」按钮走，否则切到成本后写着"39% 调用"会自相矛盾
  const metricWord = metric === 'cost' ? '成本' : metric === 'tokens' ? 'Token' : '调用';

  const setMeta = (k, txt) => {
    const el = box.querySelector(`[data-meta="${k}"]`);
    if (!el) return;
    if (el.textContent !== txt) el.textContent = txt;
    // 计量文字可能为空（没有记录时）——空着比写"0 个"更诚实，也少一行噪声
    el.style.display = txt ? '' : 'none';
  };
  const setSum = (k, html) => {
    const el = box.querySelector(`[data-sum="${k}"]`);
    if (!el) return;
    if (el.innerHTML !== html) el.innerHTML = html;
    el.style.display = html ? '' : 'none';
  };
  // 会话/模型名可能很长，摘要行里截断，完整名字在表格里
  // （30 字符：够放下「api.deepseek.com：deepseek-chat」这类常见写法，再长才省略）
  const short = (s, n = 30) => {
    const str = String(s ?? '');
    return str.length > n ? `${str.slice(0, n)}…` : str;
  };
  const byMetricDesc = (a, b) => metricOf(b, metric) - metricOf(a, metric)
    || String(a.key ?? '').localeCompare(String(b.key ?? ''));

  // ── 按天（单日 / 24 小时范围下整块被隐藏，这里也就没有数据）──
  // ⚠️ 摘要行**故意不重复**图上方那条「峰值 / 日均 / 合计」（.uc-sum，随「图表」指标变）：
  //    两条数字挨着写同一批值，读者只会觉得啰嗦。这里只给"看形状才得出的结论"——
  //    用量集中在哪天、日均能不能代表整体。
  const days = Array.isArray(stats?.days) ? stats.days.slice() : [];
  if (days.length) {
    const runs = days.map((d) => Number(d.runs) || 0);
    const totalRuns = runs.reduce((a, v) => a + v, 0);
    const peak = Math.max(...runs, 0);
    const peakDay = peak > 0 ? days[runs.indexOf(peak)] : null;
    const peakShare = totalRuns > 0 ? Math.round((peak / totalRuns) * 100) : 0;
    setMeta('days', `${days.length} 天`);
    if (days.length < 2) {
      setSum('days', '只有一天的记录，折线上只落得下一个点 —— 想看趋势请换「近 7 天 / 近 30 天」。');
    } else if (peakShare >= 40) {
      setSum('days',
        `用量很不均匀：最忙的 <b>${esc(String(peakDay?.day ?? '').slice(5))}</b> 一天占了全区间 <b>${peakShare}%</b> ——`
        + ` 看峰值比看日均更有意义，日均会被它拉高。`);
    } else {
      setSum('days',
        `用量分布比较均匀（最忙的一天也只占 <b>${peakShare}%</b>），`
        + `日均 <b>${(totalRuns / days.length).toFixed(0)}</b> 次可以代表整体水平。`);
    }
  } else {
    setMeta('days', '');
    setSum('days', '');
  }

  // ── 按会话 ──
  const chats = Array.isArray(stats?.chats) ? stats.chats.slice() : [];
  if (chats.length) {
    const totalV = chats.reduce((a, c) => a + Math.max(0, metricOf(c, metric)), 0);
    chats.sort(byMetricDesc);
    const top = chats[0];
    const topVal = Math.max(0, metricOf(top, metric));
    const topShare = totalV > 0 ? Math.round((topVal / totalV) * 100) : 0;
    const totalRuns = chats.reduce((a, c) => a + (Number(c.runs) || 0), 0);
    setMeta('chats', `${chats.length} 个会话`);
    // 只有一个会话时，「占 100%」是句废话。也**不**在这里报"每次输入多少"：
    // 「按插件」那块会给出同一个指标，但口径来自另一条统计链路（llmCalls），
    // 两处数字差几个百分点就会被当成算错 —— 这里改成指路。
    if (chats.length === 1) {
      setSum('chats',
        '只有一个会话，全部用量都来自它 —— 单次输入有多贵、钱花在插件说明还是历史上，'
        + '去「按插件」看构成最清楚。');
    } else {
      setSum('chats',
        `平均每个 <b>${(totalRuns / chats.length).toFixed(1)}</b> 次调用；`
        + `用得最多的是「<b>${esc(short(formatChatTitle(top.key, chatNameOf(top.key))))}</b>」，`
        + `占 <b>${topShare}%</b> ${metricWord}。`);
    }
  } else {
    setMeta('chats', '');
    setSum('chats', '');
  }

  // ── 按模型 ──
  const models = Array.isArray(stats?.models) ? stats.models.slice() : [];
  if (models.length) {
    const labelOf = (m) => (m.vendor ? `${m.vendor}：${m.model}` : (m.model ?? m.key));
    const totalV = models.reduce((a, m) => a + Math.max(0, metricOf(m, metric)), 0);
    models.sort(byMetricDesc);
    const top = models[0];
    const topShare = totalV > 0 ? Math.round((Math.max(0, metricOf(top, metric)) / totalV) * 100) : 0;
    // 命中率最低的那个：只看真有输入的，避免 0/0 算出来的假 0% 抢戏
    const rated = models.filter((m) => (Number(m.promptTokens) || 0) > 0);
    const worst = rated.length > 1
      ? rated.slice().sort((a, b) => (Number(a.cacheHitRate) || 0) - (Number(b.cacheHitRate) || 0))[0]
      : null;
    setMeta('models', `${models.length} 个模型`);
    setSum('models',
      `主力是 <b>${esc(short(labelOf(top)))}</b>（占 <b>${topShare}%</b> ${metricWord}）；`
      + `整体缓存命中 <b>${fmtRate(t.cacheHitRate)}</b>`
      + (worst ? `，最低的 <b>${esc(short(labelOf(worst)))}</b> 只有 <b>${fmtRate(worst.cacheHitRate)}</b>` : '')
      + '。');
  } else {
    setMeta('models', '');
    setSum('models', '');
  }
}

/**
 * 加载用量页。
 *
 * @param {boolean} force  true = 重建整个页面骨架（切换页签、切换时间范围、点刷新）；
 *                         false = 轮询刷新，只更新数值与表格行，不重建 DOM。
 *
 * ── 为什么要分开 ──
 * 轮询每 15 秒一次，如果每次都重建 DOM，用户正在看的行会被重新渲染、
 * 滚动位置也会丢。所以轮询走"只更新数值"这条路。
 *
 * ── 加载为什么快 ──
 * 1. 三个接口用 Promise.all **并行**请求（串行会慢 3 倍）
 * 2. 骨架屏**立即**显示，不等数据回来 —— 用户切过去马上看到布局，不会"黑一会"
 * 3. 竞态防护：请求期间用户可能切走或改了时间范围，回来时丢弃过期结果
 */
let usageLoadToken = 0;          // 每次加载递增，用于丢弃过期结果
let usageLastData = null;        // 上一次加载成功的数据：{ range, stats, st, prices }
                                 // 用于切回用量页时先立即画出旧内容，避免"黑一下"

/**
 * 统计请求 URL。
 *
 * hard=true（用户明确点了「刷新」）→ 带 force=1，服务端跳过 3 小时结果缓存当场重算。
 * 其余入口（轮询、SSE、切页签、切时间范围）一律走缓存 —— 服务端为了"点今日要等很久"
 * 已经把统计结果缓存住了，前端不该再用 force 把它顶掉，否则缓存等于不存在。
 * 这三者的区别要一直保持：**只有刷新按钮才代表"我现在就要最新的"。**
 */
function usageStatsUrl(range, hard = false) {
  return `/api/usage/stats?range=${encodeURIComponent(range)}${hard ? '&force=1' : ''}`;
}

/* ══════════ 按插件统计（2026-10-19）══════════
   与主统计分开请求：插件维度要额外扫会话文件 + 算提示词片段，比主统计慢；
   单独请求的好处是"它失败不连累主页面"，也方便按需刷新（30 秒节流）。 */
let pluginUsageAt = 0;
let pluginUsageRange = '';

async function loadPluginUsage(range, { force = false } = {}) {
  if (!force && pluginUsageRange === range && Date.now() - pluginUsageAt < 30000) return;
  try {
    const r = await api(`/api/usage/plugins?range=${encodeURIComponent(range)}`, { timeoutMs: 20000 });
    if (!r || r.ok !== true) return;
    pluginUsageAt = Date.now();
    pluginUsageRange = range;
    state.pluginUsage = r;
    renderPluginUsage(r);
  } catch (e) {
    // 2026-10-20：原文案让用户"重启 QQ Agent 后重试"—— 代价太重，而且这里失败
    // 多半是后端一时没响应（接口本身存在，上面刚成功过）。页面上就有「刷新」，
    // 它走的是 force=true，会把插件统计一起重拉，指过去就够了。
    const tb = $('#usage-page [data-table="plugins"] tbody');
    if (tb) {
      tb.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center;padding:18px">'
        + `插件统计暂时拿不到（${esc(String(e?.message || '后端未响应'))}）—— 点上方「刷新」重试。`
        + '</td></tr>';
    }
  }
}

/** 插件排行条：复用「按模型」的 .uc-bar-* 视觉（名次徽标 + 渐隐条 + 百分比）。
 *
 *  三种排行依据（2026-10-19 用户补充：只排"每次固定"会漏掉真正用起来的开销）：
 *    total → 区间总消耗 = 每次固定 × 调用次数 + 工具结果（默认，最贴近"花了多少"）
 *    fixed → 每次固定消耗（看"装了就在付"的底噪）
 *    calls → 区间调用次数（看"用得勤不勤"）
 *
 *  数据来自 /api/usage/plugins（不在 stats.xxx 里），所以不复用 usageBars；
 *  但 DOM 结构与它完全一致，样式不用改一行。 */
const PLUGIN_METRIC_DEFS = {
  total: { value: (p) => Number(p.periodTotal) || 0, unit: 'tok', hint: '区间总消耗 = 每次固定 × 调用次数 + 工具结果' },
  fixed: { value: (p) => Number(p.fixedPerCall) || 0, unit: 'tok/次', hint: '每次对话都要付的固定部分' },
  calls: { value: (p) => Number(p.toolCalls) || 0, unit: '次', hint: '区间内功能被调用的次数' }
};

function pluginBars(plugins, metric = 'total', extras = []) {
  const def = PLUGIN_METRIC_DEFS[metric] || PLUGIN_METRIC_DEFS.total;
  const items = (plugins || [])
    .filter((p) => def.value(p) > 0 || p.fixedPerCall > 0 || p.toolCalls > 0)
    .slice()
    .sort((a, b) => def.value(b) - def.value(a) || String(a.id).localeCompare(String(b.id)));
  const extraRows = (extras || []).filter((p) => p && def.value(p) > 0);
  if (!items.length && !extraRows.length) return '<div class="uc-empty muted">这段时间没有插件消耗记录</div>';
  // 条形长度统一按「含对照行」的最大值归一 —— 这样能一眼看出插件条和对话条谁长，
  // 而不是各自满格造成"插件也很大"的错觉。
  const max = Math.max(...items.map(def.value), ...extraRows.map(def.value), 1);
  const total = items.reduce((a, p) => a + Math.max(0, def.value(p)), 0);
  const rows = items.map((p, i) => {
    const v = Math.max(0, def.value(p));
    const w = max > 0 ? Math.max(0, (v / max) * 100) : 0;
    const share = total > 0 ? Math.max(0, (v / total) * 100) : 0;
    const alpha = Math.max(0.34, 1 - i * 0.1);
    const isCore = p.id === '(core)';
    const label = isCore ? '核心功能（非插件）' : p.name;
    // 副标注：切到"总消耗"时把调用次数带出来，否则用户看不出"贵是因为装得多还是用得多"
    const sub = metric === 'total'
      ? (p.toolCalls > 0 ? ` · ${p.toolCalls} 次调用` : ' · 装了没用过')
      : '';
    return `<div class="uc-bar-row${i === 0 ? ' top' : ''}" data-plugin-key="${esc(p.id)}" role="button" tabindex="0" title="点击看它每个功能用了多少">
      <div class="uc-bar-label"><span class="uc-rank">${i + 1}</span><span class="uc-name">${esc(label)}${sub ? `<i class="uc-name-sub">${esc(sub)}</i>` : ''}</span></div>
      <div class="uc-bar-track"><div class="uc-bar-fill" style="width:${w.toFixed(1)}%;opacity:${alpha.toFixed(2)}"></div></div>
      <div class="uc-bar-val">${esc(fmtTok(v))}<span class="uc-bar-share">· ${share.toFixed(0)}%</span></div>
    </div>`;
  }).join('');
  // 对照行（对话内容）：不是插件、不参与名次，放在最后用虚线分隔，
  // 作用是给上面的插件条一个参照系 —— 「插件 3,877 / 对话 11,284」一眼可见。
  const contrast = extraRows.map((p) => {
    const v = Math.max(0, def.value(p));
    const w = max > 0 ? Math.max(0, (v / max) * 100) : 0;
    return `<div class="uc-bar-row contrast" data-extra="1" title="${esc(p.title || '')}">
      <div class="uc-bar-label"><span class="uc-rank">—</span><span class="uc-name">${esc(p.name)}${p.note ? `<i class="uc-name-sub">${esc(p.note)}</i>` : ''}</span></div>
      <div class="uc-bar-track"><div class="uc-bar-fill" style="width:${w.toFixed(1)}%"></div></div>
      <div class="uc-bar-val">${esc(fmtTok(v))}<span class="uc-bar-share">${esc(def.unit)}</span></div>
    </div>`;
  }).join('');
  // 合计口径标注：摘要行给的是"只算插件"的数，这里包含核心功能——不写清楚会对不上账
  const hasCore = items.some((p) => p.id === '(core)');
  return `<div class="uc-bars">${rows}${contrast}</div>`
    + `<div class="uc-rest">插件合计${hasCore ? '（含核心功能）' : ''} <b>${esc(fmtTok(total))}</b> ${def.unit}`
    + `<span class="uc-rest-hint">${esc(def.hint)}</span></div>`;
}

/** 把「按插件」块填上数据。骨架在 renderUsagePage 里，这里只写值，不重建 DOM。 */
function renderPluginUsage(r) {
  const box = $('#usage-page');
  if (!box) return;
  const t = r.totals || {};
  const s = r.summary || {};
  const plugins = Array.isArray(r.plugins) ? r.plugins : [];

  const avg = Number(t.avgInputPerCall) || 0;
  const pluginFixed = Number(s.pluginFixedPerCall ?? s.fixedPerCall) || 0;
  const share = avg > 0 ? Math.round(pluginFixed / avg * 100) : 0;

  // 区间口径就地补算（2026-10-19）：periodFixed / periodTotal 是这次新加的字段，
  // 主进程没重启时接口里还没有它们——与其显示 0，不如用「每次固定 × 调用次数
  // + 工具结果」在本地算一遍。摘要行和表格都读这一份，数字永远对得上。
  const llmCalls = Number(t.llmCalls) || 0;
  const periodFixedOf = (p) => Number.isFinite(Number(p.periodFixed))
    ? Number(p.periodFixed)
    : (Number(p.fixedPerCall) || 0) * llmCalls;
  const periodTotalOf = (p) => Number.isFinite(Number(p.periodTotal))
    ? Number(p.periodTotal)
    : periodFixedOf(p) + (Number(p.resultTokens) || 0);
  const rowsData = plugins.map((p) => ({ ...p, periodFixed: periodFixedOf(p), periodTotal: periodTotalOf(p) }));
  const others = rowsData.filter((p) => p.id !== '(core)');
  const periodFixedSum = others.reduce((a, p) => a + p.periodFixed, 0);

  // ── 对话侧（2026-10-19 用户第二次澄清：要的是「每次对话新进来的文本」这一块）──
  // 口径：每次输入的真实平均 token 减去全部固定开销（插件说明 + 核心工具说明），
  // 剩下的就是聊天记录 / 人设 / 运行时状态。倒推值，但分子分母都是真数。
  // 与后端 summary.chatPerCall 同口径；接口没这字段时（主进程未重启）本地补算。
  const allFixed = rowsData.reduce((a, p) => a + (Number(p.fixedPerCall) || 0), 0);
  const coreFixed = rowsData.filter((p) => p.id === '(core)').reduce((a, p) => a + (Number(p.fixedPerCall) || 0), 0);
  const corePeriodFixed = rowsData.filter((p) => p.id === '(core)').reduce((a, p) => a + p.periodFixed, 0);
  const chatPerCall = Number.isFinite(Number(s.chatPerCall))
    ? Number(s.chatPerCall)
    : Math.max(0, avg - allFixed);
  const chatPeriod = Number.isFinite(Number(s.chatPeriod))
    ? Number(s.chatPeriod)
    : Math.max(0, (Number(t.promptTokens) || 0) - allFixed * llmCalls);
  const coreShare = avg > 0 ? Math.round(coreFixed / avg * 100) : 0;
  const chatShare = avg > 0 ? Math.round(chatPerCall / avg * 100) : 0;
  const newTextPerCall = Number(s.newTextPerCall) || 0;

  // 段落头右侧的计量文字：「6 个插件 · 3 个在用」。
  // 与「按天/按会话/按模型」的 meta 同一副样子（data-meta），四个块对齐。
  const metaEl = box.querySelector('[data-meta="plugins"]');
  if (metaEl) {
    const usedN = others.filter((p) => Number(p.toolCalls) > 0).length;
    const txt = others.length
      ? `${others.length} 个插件 · ${usedN ? `${usedN} 个在用` : '本区间都没用过'}`
      : '';
    if (metaEl.textContent !== txt) metaEl.textContent = txt;
  }

  // 摘要行：一句把「一次输入到底花在哪」说完 —— 插件 / 核心工具 / 对话内容
  const topEl = box.querySelector('[data-sum="plugins"]');
  if (topEl && avg > 0) {
    topEl.innerHTML = `每次输入 <b>${fmtTok(avg)}</b> tok =`
      + ` 插件 <b>${fmtTok(pluginFixed)}</b>（${share}%）`
      + ` + 核心工具 <b>${fmtTok(coreFixed)}</b>（${coreShare}%）`
      + ` + 对话内容 <b>${fmtTok(chatPerCall)}</b>（${chatShare}%）`
      + `<br>区间累计：插件 ${fmtTok(periodFixedSum)} + 核心工具 ${fmtTok(corePeriodFixed)}`
      + ` + 对话内容 <b>${fmtTok(chatPeriod)}</b>`
      // 这条提示是整块的重点：让用户明白贵的不是"刚说的那句"，而是历史在重发。
      + (newTextPerCall > 0
        ? ` <span class="up-sumline-note">（每轮新进来的消息只占 ${fmtTok(newTextPerCall)} tok，其余都是历史在重发）</span>`
        : ' <span class="up-sumline-note">（新消息本身只有几十 tok，贵的是历史每轮重发）</span>');
  } else if (topEl) {
    topEl.innerHTML = '';
  }

  // 排行依据切换（区间总消耗 / 每次固定 / 调用次数）
  const metric = PLUGIN_METRIC_DEFS[state.pluginMetric] ? state.pluginMetric : 'total';
  const metricBar = box.querySelector('[data-up="metricbar"]');
  if (metricBar) {
    metricBar.querySelectorAll('[data-plugin-metric]').forEach((b) => {
      b.classList.toggle('btn-primary', b.dataset.pluginMetric === metric);
    });
    if (metricBar.dataset.upBound !== '1') {
      metricBar.dataset.upBound = '1';
      metricBar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-plugin-metric]');
        if (!b) return;
        state.pluginMetric = b.dataset.pluginMetric;
        if (state.pluginUsage) renderPluginUsage(state.pluginUsage);
      });
    }
  }

  // 排行条（与「按模型」同一套 .uc-bar-* 视觉）+ 一条「对话内容」对照行
  const chartEl = box.querySelector('[data-chart="plugins"]');
  if (chartEl) {
    const chatRow = {
      id: '(chat)',
      name: '对话内容',
      note: '聊天记录 · 人设 · 状态',
      // 三档排行下都能给出对应值：total → 区间累计，fixed → 每次携带量；
      // calls 档没有意义（对话不按"调用次数"计），所以不显示。
      fixedPerCall: chatPerCall,
      periodTotal: chatPeriod,
      toolCalls: 0,
      title: `每次输入里扣除插件与工具说明后剩下的部分，主要是聊天历史被反复重发（本轮新消息约 ${newTextPerCall} tok）`
    };
    const extras = metric === 'calls' ? [] : [chatRow];
    const html = pluginBars(rowsData, metric, extras);
    if (chartEl.dataset.sig !== html) { chartEl.innerHTML = html; chartEl.dataset.sig = html; }
    if (chartEl.dataset.upBound !== '1') {
      chartEl.dataset.upBound = '1';
      const openFromRow = (e) => {
        const row = e.target.closest('[data-plugin-key]');
        if (!row) return;
        const p = (state.pluginUsage?.plugins || []).find((x) => x.id === row.dataset.pluginKey);
        if (p) openPluginToolsModal(p);
      };
      chartEl.addEventListener('click', openFromRow);
      chartEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        openFromRow(e);
      });
    }
  }

  const tb = box.querySelector('[data-table="plugins"] tbody');
  if (!tb) return;
  const rows = rowsData.filter((p) => p.fixedPerCall > 0 || p.toolCalls > 0 || p.promptVolatile > 0);
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center;padding:18px">本区间没有插件开销记录。</td></tr>';
  } else {
    const maxFixed = Math.max(1, ...rows.map((p) => p.fixedPerCall || 0));
    tb.innerHTML = rows.map((p) => {
      const impact = Number(p.hitImpactPct) || 0;
      // 缓存影响用「人话分级」代替百分数：满屏 0% 会让人以为是 bug。
      const impactHtml = impact >= 2
        ? `<span class="up-badge bad" title="易变内容占比 ${impact}%，每轮都在拖慢缓存">明显</span>`
        : impact >= 0.5
          ? `<span class="up-badge warn" title="易变内容占比 ${impact}%">轻微</span>`
          : '<span class="up-badge" title="没有每轮都变的内容">无</span>';
      const isCore = p.id === '(core)';
      const nameCell = isCore
        ? '<span class="up-name">核心功能</span><span class="up-sub">框架自带 · 一般不用动</span>'
        : `<span class="up-name">${esc(p.name)}</span><span class="up-sub">${esc(p.id)}${p.toolCount ? ' · ' + p.toolCount + ' 个功能' : ''}</span>`;
      const used = p.toolCalls
        ? `${fmtTok(p.toolCalls)} 次`
        : '<span class="up-unused" title="装了但一次没用过，固定消耗照付">未使用</span>';
      const bar = `<span class="up-cost-bar"><i style="width:${Math.max(2, Math.round(p.fixedPerCall / maxFixed * 100))}%"></i></span>`;
      return `<tr data-plugin="${esc(p.id)}" title="点一下，看它每个功能各用了多少">
        <td>${nameCell}</td>
        <td class="r"><div class="up-cost"><b>${fmtTok(p.fixedPerCall)}</b>${bar}</div></td>
        <td class="r"><b>${fmtTok(p.periodTotal)}</b></td>
        <td class="r">${fmtTok(p.promptStable + p.promptVolatile)}</td>
        <td class="r">${fmtTok(p.toolDefTokens)}</td>
        <td class="r">${used}</td>
        <td class="r">${p.resultTokens ? fmtTok(p.resultTokens) : '<span class="muted">—</span>'}</td>
        <td class="r">${impactHtml}</td>
      </tr>`;
    }).join('');
  }

  // 行点击 → 功能明细（委托挂在每次重建的 tbody 上，不会重复绑定）
  if (tb.dataset.upBound !== '1') {
    tb.dataset.upBound = '1';
    tb.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-plugin]');
      if (!tr) return;
      const p = (state.pluginUsage?.plugins || []).find((x) => x.id === tr.dataset.plugin);
      if (p) openPluginToolsModal(p);
    });
  }
}

/** 单个插件的功能明细：每个工具调用了多少次、返回多少 token、错了几次。
 *
 * ⚠️（2026-10-19）不要复用「调用明细」的 .tb-row —— 那套是 74px 名字 + 118px 代码
 *    + 34px 数字的窄三列，为"分类分组 + 条形图"设计的。插件功能行只有 id 和数字，
 *    塞进 34px 的数字列时「2,655 tok」会被挤成两行（用户截图反馈"看着奇怪"）。
 *    这里用独立的 .upt 网格：功能名自适应，三个数字列定宽右对齐。 */
function openPluginToolsModal(p) {
  const tools = (p.tools || []).slice()
    .sort((a, b) => b.calls - a.calls || b.resultTokens - a.resultTokens);
  const head = `<div class="upt-row upt-head">
      <span class="upt-what">功能</span>
      <span class="upt-n">调用</span>
      <span class="upt-n">返回 token</span>
      <span class="upt-n">错误</span>
    </div>`;
  const rows = tools.length
    ? tools.map((t) => `
      <div class="upt-row">
        <span class="upt-what">
          <b>${esc(t.name || t.id)}</b>
          ${t.name ? `<i>${esc(t.id)}</i>` : ''}
        </span>
        <span class="upt-n">${fmtTok(t.calls)}</span>
        <span class="upt-n">${fmtTok(t.resultTokens)}</span>
        <span class="upt-n">${t.errors ? `<span class="up-err">${t.errors}</span>` : '—'}</span>
      </div>`).join('')
    : '<div class="empty-hint">这个插件在当前区间没有工具调用记录。</div>';

  if (typeof modelModalShell !== 'function') return;
  modelModalShell({
    head: `${p.name} · 功能用量`,
    body: `
      <div class="tool-breakdown">
        <div class="tb-lead">
          固定开销 <b>${fmtTok(p.fixedPerCall)} tok/次</b>：提示词 ${fmtTok(p.promptStable)}（稳定）+ ${fmtTok(p.promptVolatile)}（易变），工具定义 ${fmtTok(p.toolDefTokens)}。
          共 ${p.toolCount} 个功能，区间内调用 ${fmtTok(p.toolCalls)} 次，返回内容约 ${fmtTok(p.resultTokens)} tok。
        </div>
        <div class="upt">${head}${rows}</div>
      </div>`,
    foot: '<div class="muted" style="font-size:11.5px">token 为估算值（字符÷2.5）；「返回 token」是工具结果进对话后的体积，会作为历史反复重发。</div>'
  });
}

async function loadUsageView({ force = false, hard = false } = {}) {
  const box = $('#usage-page');
  if (!box) return;

  // ── 轮询刷新：只更新数值，不重建 DOM ──
  if (!force) {
    const range = usageRange;   // 发请求前记下范围，回来时比对（下面）
    try {
      const [stats, st] = await Promise.all([
        api(usageStatsUrl(range, false), { timeoutMs: 15000 }),
        api('/api/status', { timeoutMs: 15000 })
      ]);
      // 用户可能已经切走页签了，那就别动了
      if (state.tab !== 'usage') return;
      // ⚠️ 也可能只是**切了时间范围**。轮询分支不重建骨架、不递增
      // usageLoadToken，所以这里没有 token 守卫 —— 曾经只查了页签，
      // 结果是：在途的 15s 请求回来后把**旧范围**的统计覆盖到新范围的
      // 页面上，卡片与表格瞬间对不上。范围变了直接丢弃，等新范围自己的
      // 加载流程把正确数据送上来。
      if (usageRange !== range) return;
      state.usageStats = stats;
      // ⚠️ 价格不用再请求：启动时已加载进 state.modelPrices（/api/model-prices），
      //    更新时按需拉取即可。曾经这里请求了一个**不存在的** /api/usage/prices，
      //    404 会让整个 Promise.all reject → 用量页永远加载失败。
      updateUsagePage(stats, st, state.modelPrices || {});
      // 插件维度单独拉（30 秒节流；失败静默，不让它拖累主页面）
      loadPluginUsage(range);
    } catch (e) { /* 轮询失败静默，不打扰用户 */ }
    return;
  }

  // ── 强制重建 ──
  const token = ++usageLoadToken;
  const range = usageRange;

  // ★ 先用上一次的数据立即渲染（如果有的话），而不是先画骨架等网络。
  //   后端统计的冷启动实测约 200ms（要遍历全部会话文件），热数据只要 24ms；
  //   但缓存 TTL 只有 5 秒、轮询 4 秒一次，切回用量页时缓存经常已经过期，
  //   于是每次都要等那 200ms —— 表现就是"点过去黑一下"。
  //   有旧数据时直接先画出来（0ms 可见），再在后台拉新的覆盖。
  const cached = usageLastData && usageLastData.range === range ? usageLastData : null;
  if (cached) {
    state.usageStats = cached.stats;
    renderUsagePage(cached.stats, cached.st, cached.prices);
  } else {
    box.innerHTML = renderUsageSkeleton();
  }

  try {
    const [stats, st] = await Promise.all([
      api(usageStatsUrl(range, hard), { timeoutMs: 15000 }),
      api('/api/status', { timeoutMs: 15000 })
    ]);
    const prices = state.modelPrices || {};   // 启动时已加载，无需再请求
    // 竞态：期间用户切走了页签、或又点了别的时间范围 → 这次结果作废
    if (token !== usageLoadToken) return;
    if (state.tab !== 'usage' || usageRange !== range) return;

    state.usageStats = stats;
    usageLastData = { range, stats, st, prices };

    if (cached) {
      // 已有页面：只更新数值，不重建（避免打断用户的滚动/交互）
      updateUsagePage(stats, st, prices);
    } else {
      // ⚠️ renderUsagePage 不返回字符串 —— 它内部自己写 box.innerHTML、
      //    绑定事件、并调用 updateUsagePage 填数值。
      //    所以这里只能"直接调用"，不能再赋值（赋 undefined 会把页面清空）。
      renderUsagePage(stats, st, prices);
    }
    // 范围变了 → 插件统计也要重算（force：点刷新/切范围必须拿到新数）
    loadPluginUsage(range, { force: true });
  } catch (e) {
    if (token !== usageLoadToken) return;
    // 旧数据还在页面上就别用错误覆盖它（用户至少能看到上一次的数字）
    if (cached) return;
    // 曾经这里只有一行错误文案：请求 hang 死时（无超时时代）骨架屏永远转下去，
    // 用户只能重启。现在超时/失败都落到这张卡上，给一个明确的出路（R49）。
    box.innerHTML = `
      <div class="empty-hint">
        用量加载失败：${esc(e?.message || String(e))}<br/>
        <button class="btn btn-small" id="usage-retry-btn" style="margin-top:10px">重新加载</button>
      </div>`;
    $('#usage-retry-btn')?.addEventListener('click', () => loadUsageView({ force: true, hard: true }));
  }
}

function peakSplitHtml(sum) {
  if (!sum || !sum.hasPeakModel) return '';
  if (!(sum.peakCost > 0 || sum.offPeakCost > 0)) return '';
  const ratio = sum.peakRatio || 0;
  return `
    <div class="usage-peak">
      <div class="up-title">峰谷拆分</div>
      <div class="up-row">
        <span class="up-dot peak"></span>
        <span class="up-label">高峰时段</span>
        <span class="up-val">${fmtYuan(sum.peakCost)}</span>
        <span class="up-bar"><i style="width:${(ratio * 100).toFixed(1)}%"></i></span>
        <span class="up-pct">${(ratio * 100).toFixed(0)}% token</span>
      </div>
      <div class="up-row">
        <span class="up-dot off"></span>
        <span class="up-label">闲时</span>
        <span class="up-val">${fmtYuan(sum.offPeakCost)}</span>
        <span class="up-bar"><i class="off" style="width:${((1 - ratio) * 100).toFixed(1)}%"></i></span>
        <span class="up-pct">${((1 - ratio) * 100).toFixed(0)}% token</span>
      </div>
      <div class="up-hint">高峰 = 北京时间工作日 9:00-12:00、14:00-18:00；周末全天闲时。</div>
    </div>`;
}

/**
 * 点表格行 → 弹明细。
 * dim 决定可选的第二个维度：
 *   chat  → 按模型 / 按天
 *   model → 按会话 / 按天
 *   day   → 按模型 / 按会话
 */
function openUsageBreakdown(dim, key) {
  const tabs = {
    chat: [['model', '各模型'], ['day', '各天']],
    model: [['chat', '各群聊'], ['day', '各天']],
    day: [['model', '各模型'], ['chat', '各群聊']]
  }[dim] || [['model', '各模型']];

  const dimLabel = { chat: '会话', model: '模型', day: '日期' }[dim] || '';
  let activeBy = tabs[0][0];

  const overlay = modelModalShell({
    head: `明细：${dimLabel} ${key}`,
    body: `
      <div class="ub-wrap">
        <div class="ub-tabs" id="ub-tabs">${tabs.map(([v, l]) => `<button class="btn btn-small" data-by="${v}">${l}</button>`).join('')}</div>
        <div id="ub-peak"></div>
        <div class="ub-scroll">
          <table class="usage-table">
            <thead><tr><th id="ub-col">项目</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
            <tbody id="ub-body"><tr><td colspan="6" class="muted">加载中…</td></tr></tbody>
          </table>
        </div>
      </div>`,
    foot: `<button class="btn" id="ub-close">关闭</button>`
  });

  const bodyEl = overlay.querySelector('#ub-body');
  const peakEl = overlay.querySelector('#ub-peak');
  const colEl = overlay.querySelector('#ub-col');

  async function load() {
    bodyEl.innerHTML = '<tr><td colspan="6" class="muted">加载中…</td></tr>';
    try {
      const r = await api(`/api/usage/breakdown?range=${encodeURIComponent(usageRange)}&dim=${dim}&key=${encodeURIComponent(key)}&by=${activeBy}`, { timeoutMs: 15000 });
      peakEl.innerHTML = peakSplitHtml(r.totals);
      colEl.textContent = { model: '模型', chat: '会话', day: '日期' }[activeBy] || '项目';
      bodyEl.innerHTML = (r.rows || []).length
        ? r.rows.map((x) => `
            <tr>
              <td>${esc(activeBy === 'chat'
                ? formatChatTitle(x.key, chatNameOf(x.key))
                : (x.vendor ? `${x.vendor}：${x.model}` : (x.model ?? x.key)))}</td>
              <td class="r">${x.runs}</td>
              <td class="r">${fmtTok(x.promptTokens)}</td>
              <td class="r">${fmtTok(x.completionTokens)}</td>
              <td class="r">${fmtRate(x.cacheHitRate)}</td>
              <td class="r">${fmtYuan(x.cost)}</td>
            </tr>`).join('')
        : '<tr><td colspan="6" class="muted">无数据</td></tr>';
    } catch (e) {
      bodyEl.innerHTML = `<tr><td colspan="6" class="muted">加载失败：${esc(e.message)}</td></tr>`;
    }
  }

  overlay.querySelectorAll('#ub-tabs [data-by]').forEach((el) => {
    el.addEventListener('click', () => {
      activeBy = el.dataset.by;
      overlay.querySelectorAll('#ub-tabs [data-by]').forEach((x) => x.classList.toggle('btn-primary', x.dataset.by === activeBy));
      load();
    });
  });
  overlay.querySelector('#ub-close').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelectorAll('#ub-tabs [data-by]').forEach((x) => x.classList.toggle('btn-primary', x.dataset.by === activeBy));
  load();
}
