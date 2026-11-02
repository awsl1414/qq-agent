// 开发工单对话框：把 dev-orders 的会话能力包装成一只随手可开的聊天窗。
// 所有数据都经主进程转发（受限 preload），页面不直接访问 HTTP / 文件系统。
const api = window.qqDevChat;
const $ = (id) => document.getElementById(id);

const state = {
  available: true,
  sessions: [],
  selected: '',
  running: '',
  signature: '',
  busy: false,
  sessionSig: '',
  timer: null
};

const fmtTime = (ts) => {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function setStatus(text, tone = '') {
  $('status').textContent = text;
  const dot = $('dot');
  dot.classList.remove('on', 'busy');
  if (tone) dot.classList.add(tone);
}

function renderSessions() {
  const sig = state.sessions.map((s) => `${s.id}:${s.status}:${s.title}`).join('|');
  if (sig === state.sessionSig) return;
  state.sessionSig = sig;
  const select = $('session');
  select.innerHTML = '';
  if (!state.sessions.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '（新工单）';
    select.append(option);
    select.disabled = true;
    $('session-meta').textContent = '';
    return;
  }
  select.disabled = false;
  for (const session of state.sessions) {
    const option = document.createElement('option');
    option.value = session.id;
    const flag = session.status === 'closed' ? ' · 已归档' : (session.id === state.running ? ' · 开发中' : '');
    option.textContent = `#${session.seq ?? '?'} ${String(session.title || '未命名').slice(0, 28)}${flag}`;
    select.append(option);
  }
  select.value = state.selected;
}

function updateStatus() {
  const session = state.sessions.find((s) => s.id === state.selected);
  if (!session) { setStatus(state.sessions.length ? '请选择工单' : '还没有工单'); return; }
  $('session-meta').textContent = session.usage?.totalTokens
    ? `${(session.usage.totalTokens / 1000).toFixed(1)}k tok`
    : '';
  if (state.running === session.id) { setStatus('开发中…', 'busy'); return; }
  if (session.status === 'closed') { setStatus('已归档'); return; }
  setStatus('待命', 'on');
}

function renderEmpty(title, desc) {
  const list = $('list');
  list.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'empty';
  const t = document.createElement('p');
  t.className = 'empty-title';
  t.textContent = title;
  const d = document.createElement('p');
  d.className = 'empty-desc';
  d.textContent = desc;
  box.append(t, d);
  list.append(box);
}

function lineNode(line) {
  if (!line || typeof line !== 'object') return null;
  const kind = String(line.kind || '');
  if (kind === 'user') {
    const wrap = document.createElement('div');
    wrap.className = 'msg user';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = `${line.from || '你'}${line.at ? ` · ${fmtTime(line.at)}` : ''}`;
    const text = document.createElement('span');
    text.textContent = String(line.text || '');
    wrap.append(who, text);
    return wrap;
  }
  if (kind === 'assistant') {
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    wrap.textContent = String(line.text || '');
    return wrap;
  }
  if (kind === 'tool') {
    const wrap = document.createElement('div');
    wrap.className = `tool${line.ok ? '' : ' err'}`;
    const label = String(line.label || line.name || '工具');
    const brief = String(line.brief || '').slice(0, 120);
    wrap.textContent = brief ? `${label} — ${brief}` : label;
    return wrap;
  }
  if (kind === 'notice') {
    const wrap = document.createElement('div');
    wrap.className = 'notice';
    wrap.textContent = String(line.text || '');
    return wrap;
  }
  if (kind === 'delivered') return dividerTag(line.ok ? '已回群' : '回群失败');
  if (kind === 'closed') return dividerTag('会话已归档');
  if (kind === 'run-start' || kind === 'done') return dividerTag('开工');
  return null;
}

function dividerTag(text) {
  const wrap = document.createElement('div');
  wrap.className = 'divider';
  wrap.textContent = text;
  return wrap;
}

function renderLines(lines) {
  const list = $('list');
  const pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  list.innerHTML = '';
  let rendered = 0;
  for (const line of lines) {
    const node = lineNode(line);
    if (!node) continue;
    list.append(node);
    rendered += 1;
  }
  if (!rendered) {
    renderEmpty('工单已创建', '发一句话给它，开发 agent 就会开始处理。');
    return;
  }
  if (pinned) list.scrollTop = list.scrollHeight;
}

async function refresh() {
  if (!api) return;
  let snap;
  try { snap = await api.snapshot(state.selected); }
  catch (error) { setStatus(`读取失败：${error?.message || error}`); return; }
  if (!snap || snap.ok === false || snap.available === false) {
    state.available = false;
    setStatus(snap?.error || '开发工单不可用');
    renderEmpty('「开发工单」插件未启用', '在控制台「插件」页打开 dev-orders 后，这里就能直接对话。');
    return;
  }
  state.available = true;
  state.sessions = Array.isArray(snap.sessions) ? snap.sessions : [];
  state.running = String(snap.running || '');
  if (!state.selected || !state.sessions.some((s) => s.id === state.selected)) {
    state.selected = state.sessions[0]?.id || '';
  }
  renderSessions();
  if (!state.selected) {
    $('session').value = '';
    if (state.signature !== 'empty') {
      state.signature = 'empty';
      renderEmpty('在这里直接和开发工单对话', '输入需求 → 回车，会开一个新工单并让开发 agent 直接读改项目。');
    }
    updateStatus();
    return;
  }
  let detail = null;
  try { detail = await api.detail({ id: state.selected }); } catch { detail = null; }
  const lines = Array.isArray(detail?.lines) ? detail.lines : [];
  const tail = lines[lines.length - 1];
  const sig = `${state.selected}|${lines.length}|${tail?.text || ''}|${tail?.kind || ''}|${state.running}|${state.sessions.find((s) => s.id === state.selected)?.status || ''}`;
  if (sig !== state.signature) {
    state.signature = sig;
    renderLines(lines);
  }
  updateStatus();
}

async function send() {
  if (state.busy) return;
  const input = $('input');
  const text = input.value.trim();
  if (!text) return;
  state.busy = true;
  $('send').disabled = true;
  setStatus('发送中…', 'busy');
  try {
    const result = state.selected
      ? await api.send({ id: state.selected, text })
      : await api.newSession(text);
    if (!result || result.ok === false) {
      setStatus(result?.error || '发送失败');
      return;
    }
    input.value = '';
    if (result.id && result.id !== state.selected) {
      state.selected = result.id;
      state.sessionSig = '';
      state.signature = '';
    }
    await refresh();
  } catch (error) {
    setStatus(`发送失败：${error?.message || error}`);
  } finally {
    state.busy = false;
    $('send').disabled = false;
    input.focus();
  }
}

$('send').addEventListener('click', () => void send());
$('input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
});
$('session').addEventListener('change', (event) => {
  state.selected = String(event.target.value || '');
  state.signature = '';
  void refresh();
});
$('new').addEventListener('click', () => {
  state.selected = '';
  state.signature = '';
  $('session').value = '';
  renderEmpty('新工单', '说一句需求，回车即开工。');
  $('input').focus();
});
$('close').addEventListener('click', () => api?.hide?.());
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') api?.hide?.(); });

api?.ready?.();
api?.onRefresh?.(() => { state.sessionSig = ''; state.signature = ''; void refresh(); });
void refresh();
state.timer = setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
window.addEventListener('pagehide', () => { if (state.timer) clearInterval(state.timer); });
$('input').focus();
