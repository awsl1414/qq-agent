// 〔连接页签〕
'use strict';

/* ── 这一页为什么长这样 ───────────────────────────────────────────────────
 * SnowLuma 的 EULA 5.4 明确禁止把它的专有原生组件并入第三方安装包、也禁止
 * 用自动化脚本部署，所以协议端不由本软件托管：
 *   · 协议端（SnowLuma 或 NapCat，二选一）= 用户自己安装、自己启动；
 *   · QQ Agent = 纯 OneBot v11 客户端，只负责连上 ws/http 端点。
 *
 * 这一页只剩三件事：
 *   ① 现在连上没有（状态）；
 *   ② 没连上该装什么、怎么配（协议端指引，两张卡）；
 *   ③ 端点地址 / 令牌在哪儿改（端点设置，默认折叠）。
 *
 * 日志只留「应用日志」：协议端的日志归协议端自己（SnowLuma 控制台 / NapCat
 * 控制台），我们拿不到，也不该假装能拿到。
 *
 * 样式沿用 .snowluma-* / .sl-* 类名（style.css 里那一大段仍然有效）：
 * 换的只是内容与 id，没必要为了改名再动一遍 CSS。
 */

/* 折叠区展开态：页面每 15 秒被 startListPoller 重建一次（quiet），
   不记住的话用户刚展开日志、一转眼就自己合上了。
   ⚠️ 端点设置里可能有用户正在输入的地址，所以 quiet 刷新只改状态文字、
   绝不重绘整页（见 updateConnectionLive），否则输入框打到一半会被重置。 */
let connLogsOpen = false;
let connAdvOpen = false;
/* connSetupOpen，「装一个协议端」折叠区的手动开合态。null = 用户还没动过，
   按连接状态自动定（没连上默认展开，连上默认收起）；
   connLogsCache，最近一次拿到的日志。手动「重新检测」只重读 /api/status、
   不重新拉日志，但 updateConnectionLive 需要日志参数来维护日志面板。 */
let connSetupOpen = null;
let connLogsCache = { logs: [], level: 'info' };

/** 把 /api/status 压成一个视图对象，渲染与局部更新共用同一份判断。 */
function connView(s) {
  const proto = (s && s.protocol) || {};
  const ob = (s && s.onebot) || {};
  const connected = !!ob.connected;
  const portOpen = !!proto.portOpen;
  const selfId = String((ob.self && ob.self.userId) || '');
  const nick = String((ob.self && ob.self.nickname) || '');
  const diag = String(ob.diagnosis || '');
  // 三层口径：连上 = 绿；端口开着但没连上 = 橙（多半是令牌/账号）；端口没开 = 灰。
  const overall = connected ? 'ok' : (portOpen ? 'warn' : 'off');
  const overallText = connected ? '机器人工作中' : (portOpen ? '等待连接' : '协议端未运行');
  return { proto, ob, connected, portOpen, selfId, nick, diag, overall, overallText };
}

/** 应用日志 → 面板文本。空态文案与旧版一致（'暂无日志' 触发 .is-empty 居中样式）。 */
function connLogText(appLogsData) {
  const arr = (appLogsData && appLogsData.logs) || [];
  const text = arr.map((e) => {
    const t = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false });
    const lv = String(e.level || 'info').toUpperCase().padEnd(5);
    return `[${t}] [${lv}] [${e.module || '-'}] ${e.text}`;
  }).join('\n') || '暂无日志';
  return { arr, text };
}

/** 三种状态的"人话结论"：连上 / 端口通了但没连上 / 端口没开。
    这一页 99% 的使用场景是"为什么连不上、我该先做什么"，所以结论自己要把
    下一步说出来，而不是把后端诊断原样甩给人。 */
function connVerdict(v) {
  if (v.connected) {
    return {
      cls: 'is-ok',
      title: '机器人工作中',
      sub: `已经用「${v.nick || '机器人'}」${v.selfId ? `（${v.selfId}）` : ''}收发群消息。协议端那头断开的话，这一页会自动变回来。`
    };
  }
  if (v.portOpen) {
    return {
      cls: 'is-warn',
      title: '端口通了，但还没连上',
      sub: '最常见的是令牌不一致，或机器人 QQ 还没登录 —— 检查下面「端点设置」里的令牌，以及协议端里登录的账号。'
    };
  }
  return {
    cls: 'is-off',
    title: '没检测到协议端在运行',
    sub: '先启动 SnowLuma / NapCat 并登录机器人 QQ；如果它开在别的端口，到「端点设置」里改地址。还没装过就看下面的安装说明。'
  };
}

/** 结论块右上角的时间戳：这一页会被 SSE / 轮询悄悄刷新，不给个时间用户不知道是不是新的。 */
function connClock() {
  return '检测于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function renderConnectionPage(v, appLogsData) {
  const { proto, connected, portOpen, selfId, nick, diag, overall, overallText } = v;
  const wsUrl = String(proto.wsUrl || '');
  const httpUrl = String(proto.httpUrl || '');
  const appLog = connLogText(appLogsData);
  const level = (appLogsData && appLogsData.level) || 'info';
  const verdict = connVerdict(v);

  const selfHtml = connected
    ? `${esc(nick || '已登录')}${selfId ? ` <em style="opacity:.65;font-style:normal">${esc(selfId)}</em>` : ''}`
    : '<span class="sl-adv-dim">未连接</span>';
  const portHtml = portOpen
    ? '<span style="color:var(--green)">端口在监听</span>'
    : '<span class="sl-adv-dim">端口未监听</span>';
  const diagText = connected ? '连接正常，能收发群消息' : (diag || '还没连上 —— 先确认协议端在运行、机器人 QQ 已登录');
  // 安装说明：没连上时默认展开（用户多半正需要它），连上后默认收起；
  // 用户手动开合过就按他的来（connSetupOpen）。
  const setupOpen = connSetupOpen === null ? !connected : connSetupOpen;

  return `
      <div class="snowluma-page-card">
        <div class="sl-head">
          <div class="sl-head-main">
            <h2>连接</h2>
            <div class="sl-head-sub">协议端（SnowLuma 或 NapCat）装好、机器人 QQ 登录后，这一页会自动变成「机器人工作中」</div>
          </div>
          <span class="sl-chip is-${overall}" id="conn-chip"><span class="sl-chip-dot"></span><b id="conn-chip-text">${overallText}</b></span>
          <button class="btn btn-small" id="conn-recheck-btn" title="立刻重读一次连接状态，不用等自动刷新">重新检测</button>
        </div>

        <div class="sl-section">
          <div class="sl-section-title">现在的状态<span class="sl-section-sub">随协议端变化自动刷新</span></div>

          <div class="conn-verdict ${verdict.cls}" id="conn-verdict">
            <span class="conn-verdict-dot"></span>
            <div class="conn-verdict-main">
              <div class="conn-verdict-title" id="conn-verdict-title">${esc(verdict.title)}</div>
              <div class="conn-verdict-sub" id="conn-verdict-sub">${esc(verdict.sub)}</div>
            </div>
            <span class="conn-verdict-meta" id="conn-port-meta">${connClock()}</span>
          </div>

          <div class="conn-facts">
            <div class="conn-fact"><span class="conn-fact-k">收消息（WS）</span><code class="conn-code" id="conn-ws">${esc(wsUrl || '（未设置）')}</code><span class="conn-fact-v" id="conn-port-state">${portHtml}</span></div>
            <div class="conn-fact"><span class="conn-fact-k">发消息（HTTP）</span><code class="conn-code" id="conn-http">${esc(httpUrl || '（未设置）')}</code></div>
            <div class="conn-fact"><span class="conn-fact-k">机器人账号</span><span class="conn-fact-v" id="conn-self">${selfHtml}</span></div>
          </div>

          <details class="conn-diag">
            <summary>诊断详情</summary>
            <div class="conn-diag-body">
              <div class="conn-diag-text" id="conn-diag">${esc(diagText)}</div>
              <div class="sl-adv-row" style="margin-top:8px">
                <button class="btn btn-small" id="conn-copy-diag" title="把连接状态和最近可疑日志复制成一段文字，反馈时直接粘贴">复制诊断信息</button>
                <span class="sl-hint" id="conn-copy-hint"></span>
              </div>
            </div>
          </details>
          <div class="conn-check-note" id="conn-check-note"></div>
        </div>

        <details class="conn-setup" id="conn-setup"${setupOpen ? ' open' : ''}>
          <summary><span>装一个协议端</span><span class="conn-setup-sub">二选一，装好就不用再管这一节</span></summary>
          <div class="conn-setup-body">
            <div class="sl-node-help">QQ Agent 不再自带、也不启动协议端 —— 这是 SnowLuma 许可协议的要求。你装哪个都行，两者默认端口一样，装完直接就能连上。</div>
            <div class="sl-proto-grid">
              <div class="sl-proto-card">
                <div class="sl-proto-head"><b>SnowLuma</b><span class="sl-proto-tag">第三方 · 自带 EULA</span></div>
                <ol class="sl-proto-list">
                  <li>从官方仓库获取并安装：<a href="https://github.com/SnowLuma/SnowLuma" target="_blank" rel="noopener">github.com/SnowLuma/SnowLuma</a>（本软件不再附带它）。</li>
                  <li>启动 SnowLuma，打开下面的控制台：初始账号 <code>admin</code>，密码见启动日志。</li>
                  <li>在控制台里按引导把 QQ 接进来（注入），登录<b>机器人专用号</b>；它默认开好 OneBot v11：WS <code>3001</code>、HTTP <code>3000</code>。</li>
                </ol>
                <div class="sl-proto-console">
                  <span class="sl-proto-console-k">控制台</span>
                  <code class="conn-code">http://localhost:5099</code>
                  <button class="btn btn-mini" type="button" data-console-open="snowluma">打开</button>
                  <button class="btn btn-mini btn-ghost" type="button" data-console-copy="http://localhost:5099">复制</button>
                  <span class="sl-proto-console-hint" data-console-hint>端口被占时以启动日志里的地址为准</span>
                </div>
                <div class="sl-proto-foot">旧版安装包里的 <code>snowluma/</code> 目录已移出安装包，避免随包分发。</div>
              </div>
              <div class="sl-proto-card">
                <div class="sl-proto-head"><b>NapCat</b><span class="sl-proto-tag">开源 · 免费</span></div>
                <ol class="sl-proto-list">
                  <li>从官方仓库获取并安装：<a href="https://github.com/NapNeko/NapCatQQ" target="_blank" rel="noopener">github.com/NapNeko/NapCatQQ</a></li>
                  <li>启动 NapCat，打开下面的控制台（首次启动的日志会打印带 token 的完整地址），登录<b>机器人专用号</b>。</li>
                  <li>进「网络配置」，新建「WebSocket 服务器」（正向 WS）端口 <code>3001</code>；再新建「HTTP 服务器」端口 <code>3000</code>。</li>
                </ol>
                <div class="sl-proto-console">
                  <span class="sl-proto-console-k">控制台</span>
                  <code class="conn-code">http://127.0.0.1:6099/webui</code>
                  <button class="btn btn-mini" type="button" data-console-open="napcat">打开</button>
                  <button class="btn btn-mini btn-ghost" type="button" data-console-copy="http://127.0.0.1:6099/webui">复制</button>
                  <span class="sl-proto-console-hint" data-console-hint>端口被占时以启动日志里的地址为准</span>
                </div>
                <div class="sl-proto-foot">两个服务都设了 token 的话，把 token 抄到下面的「端点设置」里。</div>
              </div>
            </div>
            <div class="sl-adv-row">
              <button class="btn btn-small" id="conn-setup-recheck">装好并登录了，重新检测</button>
              <span class="sl-hint">还连不上就看上面的「诊断详情」和下面的应用日志。</span>
            </div>
          </div>
        </details>

        <details class="sl-adv" id="conn-adv"${connAdvOpen ? ' open' : ''}>
          <summary>端点设置：换了端口、加了令牌才需要动</summary>
          <div class="sl-adv-body">
            <div class="field-row">
              <div class="field"><label>WebSocket 地址（收消息）</label>
                <input type="text" id="conn-wsurl" value="${esc(wsUrl)}" placeholder="ws://127.0.0.1:3001" /></div>
              <div class="field"><label>HTTP 地址（发消息）</label>
                <input type="text" id="conn-httpurl" value="${esc(httpUrl)}" placeholder="http://127.0.0.1:3000" /></div>
              <div class="field"><label>WebSocket 令牌</label>
                <div style="display:flex;gap:8px">
                  <input type="password" id="conn-wstoken" value="${esc(proto.hasAccessToken ? '******' : '')}" placeholder="协议端没设令牌就留空" autocomplete="new-password" style="flex:1" />
                  <button class="btn btn-small" id="conn-wstoken-toggle" type="button">显示</button>
                </div></div>
              <div class="field"><label>HTTP 令牌（与 WS 不同时才填）</label>
                <div style="display:flex;gap:8px">
                  <input type="password" id="conn-httptoken" value="${esc(proto.hasHttpAccessToken ? '******' : '')}" placeholder="留空 = 与 WS 令牌相同" autocomplete="new-password" style="flex:1" />
                  <button class="btn btn-small" id="conn-httptoken-toggle" type="button">显示</button>
                </div></div>
            </div>
            <div class="sl-adv-row">
              <button class="btn btn-small" id="conn-autofill-btn" title="直接读 SnowLuma 的 config/onebot_&lt;QQ号&gt;.json，把端点与令牌填好并立刻重连">自动读取协议端配置</button>
              <button class="btn btn-small btn-primary" id="conn-save-btn" title="保存地址与令牌，并立刻用新地址重连（不用重启应用）">保存并重连</button>
              <button class="btn btn-small" id="conn-test-btn" title="重新读一次状态：端口有没有开、机器人连上没有">测试连接</button>
              <span class="sl-hint" id="conn-save-hint"></span>
            </div>
            <div class="hint" style="margin-top:6px">两个实例（双开）会各自使用偏移后的端口；这里改的是当前这个实例的连接目标。</div>
          </div>
        </details>

        <details class="sl-adv sl-logs-adv" id="conn-logs"${connLogsOpen ? ' open' : ''}>
          <summary>应用日志：出问题才需要看</summary>
          <div class="sl-adv-body">
            <div class="sl-panel">
              <div class="sl-panel-head">
                <span class="sl-panel-title">应用日志</span>
                <span class="sl-panel-meta">最近 ${appLog.arr.length} 条 · 同时落盘 data/logs/</span>
                <span class="sl-panel-tools">
                  <label class="sl-level" for="app-log-level">
                    <span>写进文件的详细程度</span>
                    <select id="app-log-level" title="只有达到这个详细程度的日志才会写进文件；选得越详细，文件越大">
                      ${['debug', 'info', 'warn', 'error'].map((x) =>
                        `<option value="${x}" ${level === x ? 'selected' : ''}>${x}</option>`).join('')}
                    </select>
                  </label>
                  <button class="btn btn-small" id="app-logs-refresh-btn" title="重新拉取最近日志">刷新</button>
                </span>
              </div>
              <pre class="snowluma-logs-view${appLog.arr.length ? '' : ' is-empty'}" id="conn-logs-view">${esc(appLog.text)}</pre>
            </div>
          </div>
        </details>
      </div>`;
}

/** quiet 刷新：只改状态文字与日志，不碰输入框、不重建整页。 */
function updateConnectionLive(v, appLogsData) {
  const chip = $('#conn-chip');
  if (chip) chip.className = `sl-chip is-${v.overall}`;
  const chipText = $('#conn-chip-text');
  if (chipText) chipText.textContent = v.overallText;

  // 结论块：配色与两行文案一起换
  const verdict = connVerdict(v);
  const verdictBox = $('#conn-verdict');
  if (verdictBox) verdictBox.className = `conn-verdict ${verdict.cls}`;
  const verdictTitle = $('#conn-verdict-title');
  if (verdictTitle) verdictTitle.textContent = verdict.title;
  const verdictSub = $('#conn-verdict-sub');
  if (verdictSub) verdictSub.textContent = verdict.sub;
  // 手动检测的结论只活到下一次状态变化为止，避免留着一句过时的话
  const note = $('#conn-check-note');
  if (note) note.textContent = '';

  const meta = $('#conn-port-meta');
  if (meta) meta.textContent = connClock();
  const portState = $('#conn-port-state');
  if (portState) {
    portState.innerHTML = v.portOpen
      ? '<span style="color:var(--green)">端口在监听</span>'
      : '<span class="sl-adv-dim">端口未监听</span>';
  }
  const ws = $('#conn-ws');
  if (ws) ws.textContent = String(v.proto.wsUrl || '（未设置）');
  const http = $('#conn-http');
  if (http) http.textContent = String(v.proto.httpUrl || '（未设置）');

  const self = $('#conn-self');
  if (self) {
    self.innerHTML = v.connected
      ? `${esc(v.nick || '已登录')}${v.selfId ? ` <em style="opacity:.65;font-style:normal">${esc(v.selfId)}</em>` : ''}`
      : '<span class="sl-adv-dim">未连接</span>';
  }
  const diag = $('#conn-diag');
  if (diag) {
    diag.textContent = v.connected
      ? '连接正常，能收发群消息'
      : (v.diag || '还没连上 —— 先确认协议端在运行、机器人 QQ 已登录');
  }

  // 日志：内容没变就不动 DOM（避免滚动位置与文本选择被无谓重置）
  const pre = $('#conn-logs-view');
  if (pre) {
    const { text, arr } = connLogText(appLogsData);
    if (pre.textContent !== text) {
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
      pre.textContent = text;
      pre.classList.toggle('is-empty', !arr.length);
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    }
  }
}

/** 手动「重新检测」：只重读一次状态并把结论写回页面。
    不重建整页，端点设置里可能正有用户输入一半的地址（老坑）。 */
async function connRecheck(btn) {
  if (!btn || btn.disabled) return;
  const note = $('#conn-check-note');
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '检测中…';
  try {
    let s = await api('/api/status').catch(() => null);
    if (!s) { if (note) note.textContent = '读不到状态：后端没有应答。'; return; }
    let nv = connView(s);

    // 端口通了但仍没连上，最常见的不是"账号没登录"，而是令牌没填
    // （SnowLuma 每个账号随机生成一对，两枚还不一样）。这一步先替用户去协议端的
    // config/onebot_<QQ号>.json 里读一次，省掉他去 WebUI 抄两串 43 位字符串。
    // 已经连上、或端口没开都不试（避免无谓的 PowerShell 探测）。
    let fillNote = '';
    if (!nv.connected && nv.portOpen) {
      const filled = await api('/api/protocol/autofill', {
        method: 'POST',
        body: JSON.stringify({})
      }).catch(() => null);
      if (filled && filled.applied) {
        s = await api('/api/status').catch(() => s);
        nv = connView(s);
        fillNote = `✓ 已自动读取协议端配置（账号 ${filled.uin || '?'}）`;
      } else if (filled && filled.found === false) {
        fillNote = '没找到 SnowLuma 的配置文件';
      } else if (filled && filled.found && !filled.applied) {
        fillNote = filled.reason || '端点与令牌已是最新';
      }
    }

    updateConnectionLive(nv, connLogsCache);
    if (note) {
      note.textContent = nv.connected
        ? `${fillNote ? `${fillNote}，` : ''}✓ 已连上（${nv.nick || '机器人'}）`
        : nv.portOpen
          ? (fillNote
            ? `${fillNote} —— 仍然没连上，检查机器人 QQ 是否已登录。`
            : '端口通了，但仍没连上 —— 检查令牌，以及机器人 QQ 是否已登录。')
          : '端口还是没监听 —— 确认协议端已经启动、端口没填错。';
    }
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

async function loadConnectionPage({ quiet = false } = {}) {
  const boxEarly = $('#connection-page');
  if (!boxEarly) return;

  // 骨架先行：进页签时接口要跑一瞬，空容器就是"黑屏"。
  // 只在还没有正式内容时铺（quiet 刷新不动它，避免闪烁）。
  if (!boxEarly.querySelector('.snowluma-page-card') && !boxEarly.querySelector('.snowluma-error-card')) {
    boxEarly.innerHTML = `
      <div class="snowluma-page-card">
        <h2>连接</h2>
        <div class="sk-block">${'<div class="sk-row"></div>'.repeat(6)}</div>
        <div class="hint" style="margin-top:10px">正在读取连接状态…</div>
      </div>`;
  }

  const [status, appLogsData] = await Promise.all([
    api('/api/status').catch(() => null),
    api('/api/logs?limit=200').catch(() => ({ logs: [], level: 'info' }))
  ]);

  const box = $('#connection-page');
  if (!box) return;   // 页面已被切走

  if (!status) {
    // 只有非 quiet 才把错误卡顶上去：轮询期间的偶发失败不该把已经渲染好的
    // 页面（可能正被用户读着）换成错误页。
    if (!quiet) {
      box.innerHTML = `
        <div class="snowluma-page-card snowluma-error-card">
          <h2>连接</h2>
          <div class="empty-hint">⚠️ 状态读取失败（后端没有应答）。检查服务是否在运行，然后重试。</div>
          <button class="btn btn-small" id="conn-error-retry-btn" style="margin-top:10px">重试</button>
        </div>`;
      $('#conn-error-retry-btn')?.addEventListener('click', () => loadConnectionPage());
    }
    return;
  }

  const v = connView(status);
  connLogsCache = appLogsData || connLogsCache;   // 手检时复用，免得为刷新状态再拉一次日志

  if (quiet && box.querySelector('.snowluma-page-card')) {
    updateConnectionLive(v, appLogsData);
    return;
  }

  box.innerHTML = renderConnectionPage(v, appLogsData);
  bindConnectionPage(box, v, appLogsData);
}

function bindConnectionPage(box, v, appLogsData) {
  // ── 手动重新检测（页头一枚 + 安装说明底部一枚，同一套逻辑）──
  $('#conn-recheck-btn')?.addEventListener('click', (e) => connRecheck(e.currentTarget));
  $('#conn-setup-recheck')?.addEventListener('click', (e) => connRecheck(e.currentTarget));
  // 安装说明的开合态要记住，否则下一次渲染会被"按连接状态自动决定"覆盖掉
  const setup = $('#conn-setup');
  if (setup) setup.addEventListener('toggle', () => { connSetupOpen = setup.open; });

  // ── 协议端控制台（WebUI）：打开 / 复制 ──
  // 「打开」走 preload 的 openProtocolConsole(which)：只传枚举键，地址由主进程写死。
  // 网页版控制台没有这个桥，就退回"复制地址"，别让按钮点了没反应。
  for (const btn of $$('[data-console-open]')) {
    btn.addEventListener('click', async () => {
      const hint = btn.parentElement?.querySelector('[data-console-hint]');
      const bridge = window.qqaDesktop?.openProtocolConsole;
      if (typeof bridge !== 'function') {
        const url = btn.parentElement?.querySelector('[data-console-copy]')?.dataset.consoleCopy || '';
        try {
          await navigator.clipboard.writeText(url);
          if (hint) hint.textContent = '已复制，粘贴到浏览器打开';
        } catch {
          if (hint) hint.textContent = '请手动选中地址复制';
        }
        return;
      }
      btn.disabled = true;
      try {
        const r = await bridge(btn.dataset.consoleOpen || '');
        if (hint) hint.textContent = r?.ok ? '已用默认浏览器打开' : `没打开：${r?.error || '未知原因'}`;
      } catch (e) {
        if (hint) hint.textContent = `没打开：${(e && e.message) || e}`;
      } finally {
        btn.disabled = false;
      }
    });
  }
  for (const btn of $$('[data-console-copy]')) {
    btn.addEventListener('click', async () => {
      const hint = btn.parentElement?.querySelector('[data-console-hint]');
      try {
        await navigator.clipboard.writeText(btn.dataset.consoleCopy || '');
        if (hint) hint.textContent = '已复制';
      } catch {
        if (hint) hint.textContent = '复制失败，请手动选中地址';
      }
    });
  }

  // ── 折叠区展开态 ──
  const adv = $('#conn-adv');
  if (adv) adv.addEventListener('toggle', () => { connAdvOpen = adv.open; });
  const logs = $('#conn-logs');
  if (logs) {
    logs.addEventListener('toggle', () => { connLogsOpen = logs.open; });
    // 用户手点 summary 展开时贴底：他想看的是"最后发生了什么"。
    // ⚠️ 监听 summary 的 click 而不是 details 的 toggle，因为 toggle 在程序化
    //    open 时也会触发，会把阅读位置又拽回末尾。
    logs.querySelector('summary')?.addEventListener('click', () => {
      requestAnimationFrame(() => {
        const pre = $('#conn-logs-view');
        if (pre && logs.open) pre.scrollTop = pre.scrollHeight;
      });
    });
  }

  // ── 自动读取协议端配置 ──
  // 直接读 SnowLuma 的 config/onebot_<QQ号>.json，拿到端口和两枚令牌后落盘 + 重连。
  // 手动触发带 force：以协议端当前配置为准覆盖（用户点这个按钮就是这个意思）。
  // 令牌不会回传到页面（后端 publicView 已删除），所以这里只显示账号与结果。
  const autofillBtn = $('#conn-autofill-btn');
  if (autofillBtn) autofillBtn.addEventListener('click', async () => {
    const hint = $('#conn-save-hint');
    const oldText = autofillBtn.textContent;
    autofillBtn.disabled = true;
    autofillBtn.textContent = '读取中…';
    if (hint) hint.textContent = '';
    try {
      const r = await api('/api/protocol/autofill', {
        method: 'POST',
        body: JSON.stringify({ force: true })
      });
      if (hint) {
        if (r && r.applied) hint.textContent = `✓ 已读取（账号 ${r.uin || '?'}），正在用新端点重连…`;
        else if (r && r.found) hint.textContent = r.reason || '已读取，但无需改动';
        else hint.textContent = (r && r.reason) || '没找到协议端配置';
      }
      if (r && r.applied) setTimeout(() => loadConnectionPage({ quiet: true }), 1200);
    } catch (e) {
      if (hint) hint.textContent = `读取失败：${e.message}`;
    } finally {
      autofillBtn.disabled = false;
      autofillBtn.textContent = oldText;
    }
  });

  // ── 保存端点（保存 + 立刻重连，不用重启）──
  const saveBtn = $('#conn-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const hint = $('#conn-save-hint');
    const wsUrl = String($('#conn-wsurl')?.value || '').trim();
    const httpUrl = String($('#conn-httpurl')?.value || '').trim();
    const wsToken = String($('#conn-wstoken')?.value || '').trim();
    const httpToken = String($('#conn-httptoken')?.value || '').trim();
    if (!wsUrl || !httpUrl) {
      if (hint) hint.textContent = '两个地址都要填（默认 ws://127.0.0.1:3001 与 http://127.0.0.1:3000）';
      return;
    }
    saveBtn.disabled = true;
    const oldText = saveBtn.textContent;
    saveBtn.textContent = '保存中…';
    if (hint) hint.textContent = '';
    try {
      const r = await api('/api/protocol/apply', {
        method: 'POST',
        body: JSON.stringify({ wsUrl, httpUrl, accessToken: wsToken, httpAccessToken: httpToken })
      });
      if (r && r.ok) {
        if (hint) {
          hint.textContent = r.applied === false
            ? `已保存，但重连没跑起来：${r.error || '未知原因'} —— 重启应用后一定生效`
            : '✓ 已保存，正在用新地址重连…';
        }
        setTimeout(() => loadConnectionPage({ quiet: true }), 1200);
      } else if (hint) {
        hint.textContent = `保存失败：${(r && r.error) || '未知错误'}`;
      }
    } catch (e) {
      if (hint) hint.textContent = `保存失败：${e.message}`;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = oldText;
    }
  });

  // ── 测试连接：重读状态并给一句人话结论（不新增后端接口）──
  const testBtn = $('#conn-test-btn');
  if (testBtn) testBtn.addEventListener('click', async () => {
    const hint = $('#conn-save-hint');
    testBtn.disabled = true;
    const oldText = testBtn.textContent;
    testBtn.textContent = '测试中…';
    try {
      const s = await api('/api/status').catch(() => null);
      if (!s) {
        if (hint) hint.textContent = '读不到状态：后端没有应答';
      } else {
        const nv = connView(s);
        updateConnectionLive(nv, appLogsData);
        if (hint) {
          hint.textContent = nv.connected
            ? `✓ 已连上（${nv.nick || '机器人'}）`
            : (nv.portOpen
              ? '端口是通的，但 OneBot 还没连上 —— 多半是令牌不一致，或机器人 QQ 还没登录'
              : `端口没监听：${nv.proto.wsUrl || '（未设置）'} —— 确认协议端在运行、端口没填错`);
        }
      }
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = oldText;
    }
  });

  // ── 令牌显示 / 隐藏（明文走 /api/onebot-token，与设置页同一条）──
  const wireTokenToggle = (btnId, inputId, which) => {
    const btn = $(btnId);
    const inp = $(inputId);
    if (!btn || !inp) return;
    btn.addEventListener('click', async () => {
      if (btn.dataset.on === '1') {
        inp.value = '******';
        btn.dataset.on = '0';
        btn.textContent = '显示';
        return;
      }
      try {
        const r = await api(`/api/onebot-token?which=${which}`);
        inp.value = String((r && r.token) || '');
        btn.dataset.on = '1';
        btn.textContent = '隐藏';
      } catch (e) {
        const hint = $('#conn-save-hint');
        if (hint) hint.textContent = `读取令牌失败：${e.message}`;
      }
    });
  };
  wireTokenToggle('#conn-wstoken-toggle', '#conn-wstoken', 'ws');
  wireTokenToggle('#conn-httptoken-toggle', '#conn-httptoken', 'http');

  // ── 应用日志：级别切换 + 手动刷新 ──
  const levelSel = $('#app-log-level');
  if (levelSel) levelSel.addEventListener('change', async () => {
    try {
      const r = await api('/api/logs/level', { method: 'POST', body: JSON.stringify({ level: levelSel.value }) });
      if (r && r.level) levelSel.value = r.level;
      loadConnectionPage({ quiet: true });
    } catch (e) {
      qaAlert(`设置日志级别失败：${e.message}`);
    }
  });
  $('#app-logs-refresh-btn')?.addEventListener('click', () => loadConnectionPage());

  // ── 复制诊断信息（反馈用）：全部来自本页已取到的状态与日志，不新增请求 ──
  const copyBtn = $('#conn-copy-diag');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const hint = $('#conn-copy-hint');
    const { arr } = connLogText(appLogsData);
    const CLUE_RE = /error|fail|失败|EADDR|ECONN|EACCES|refuse|denied|timeout|超时|断开|异常|invalid|token|令牌/i;
    const clues = arr
      .filter((e) => CLUE_RE.test(String(e.text || '')))
      .slice(-5)
      .map((e) => `  [${new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false })}] ${String(e.text).slice(0, 140)}`);
    const lines = [
      '[QQ Agent 连接诊断] ' + new Date().toLocaleString('zh-CN', { hour12: false }),
      '结论: ' + (v.connected ? '已连接' : (v.portOpen ? '端口在监听但未连上' : '协议端未运行 / 端口未监听')),
      'WS 地址: ' + (v.proto.wsUrl || '（未设置）'),
      'HTTP 地址: ' + (v.proto.httpUrl || '（未设置）'),
      '端口监听: ' + (v.portOpen ? '是' : '否'),
      'OneBot: ' + (v.connected ? `已连接 ${v.nick || ''} ${v.selfId || ''}`.trim() : '未连接'),
      '后端诊断: ' + (v.diag || '（无）'),
      '最近可疑日志:',
      ...(clues.length ? clues : ['  （无）'])
    ].join('\n');
    try {
      await navigator.clipboard.writeText(lines);
      if (hint) hint.textContent = '已复制，可直接粘贴反馈 ✓';
    } catch (e) {
      if (hint) hint.textContent = `复制失败：${(e && e.message) || e}`;
    }
  });
}
