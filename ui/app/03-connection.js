// 〔连接页签〕
'use strict';

/* ── 这一页为什么长这样 ───────────────────────────────────────────────────
 * SnowLuma 的 EULA 5.4 明确禁止把它的专有原生组件并入第三方安装包、也禁止
 * 用自动化脚本部署，所以协议端不由本软件托管：
 *   · 协议端（SnowLuma 或 NapCat，二选一）= 用户自己安装、自己启动；
 *   · QQ Agent = 纯 OneBot v11 客户端，只负责连上 ws/http 端点。
 *
 * 这一页是「让机器人连上 QQ」的唯一入口，四件事按发生顺序排：
 *   ① 启动机器人用的 QQ（一键启动 / 便携副本，Windows 才有）；
 *   ② 现在连上没有（状态）；
 *   ③ 协议端要装什么、怎么配（协议端指引，两张卡）；
 *   ④ 端点地址 / 令牌在哪儿改（端点设置，默认展开）。
 * 「改配置 → 验证」的闭环必须落在同一页：设置页不再有「连接 QQ」分区，
 * 否则用户改完令牌还得跳到别的页才知道成没成。
 *
 * 日志已独立成「工具 → 日志」页，本页不再承载日志：协议端的日志归协议端自己
 * （SnowLuma 控制台 / NapCat 控制台），我们拿不到，也不该假装能拿到。
 *
 * 样式沿用 .snowluma-* / .sl-* 类名（style.css 里那一大段仍然有效）：
 * 换的只是内容与 id，没必要为了改名再动一遍 CSS。
 */

/* 折叠区展开态：页面每 15 秒被 startListPoller 重建一次（quiet），
   不记住的话用户刚展开某一节、一转眼就自己合上了。
   ⚠️ 端点设置里可能有用户正在输入的地址，所以 quiet 刷新只改状态文字、
   绝不重绘整页（见 updateConnectionLive），否则输入框打到一半会被重置。 */
let connAdvOpen = true;
/* 配置和安装指引默认展开，用户手动开合后保留选择。 */
let connSetupOpen = true;

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

/* ── 启动 QQ 区的状态（原「设置 → 连接 QQ」的一键启动 / 便携副本）─────────
 * 状态放模块级而不是 bindConnectionPage 的闭包里：这一页每次非 quiet 渲染都会
 * 重建 DOM 并重新绑定，而 quiet 刷新（SSE / 15 秒轮询）只改文字不重绑 ——
 * 闭包里的状态在那条路径上拿不到。
 * portableSupported 决定两个便携按钮是否出现：便携 QQ 依赖 QQNT，只有 Windows 版，
 * 在 macOS / Linux 上露出按钮只会让人点出一个必然失败的 spawn。 */
const connQb = {
  // loaded：首次 connQbRefresh 成功前不重画 —— 否则 quiet 刷新会拿默认值
  // （qqReady=false）把「正在读取 QQ 状态…」写成「没找到可用的 QQ」。
  loaded: false,
  qqReady: false,
  qqRunning: false,
  pid: null,
  protoUp: false,
  source: 'none',
  portableInstalled: false,
  portableSupported: true,
  connected: false
};

/** 按 connQb 重画启动区文字与按钮态；quiet 刷新与三步链共用。 */
function connQbPaint() {
  if (!connQb.loaded) return;
  const text = $('#quick-start-text');
  const btn = $('#quick-start-btn');
  if (!btn) return;
  btn.disabled = !!connQb.connected;
  // 已连接是终态：保留一个可见的锚点，但必须禁用，别让人以为还要再点什么。
  if (connQb.connected) {
    if (text) text.textContent = '机器人已连接，正常工作中 —— 状态见上方，出问题看「工具 → 日志」';
    btn.textContent = '已连接 ✓';
    btn.disabled = true;
  } else if (!connQb.portableSupported) {
    // 一键启动依赖 QQNT（只有 Windows 版）。非 Windows 上藏掉按钮，
    // 只留一句"自己登录 QQ + 自己起协议端"，否则用户点下去只会看到 spawn 失败。
    if (text) text.textContent = '这台机器上「一键启动 QQ」不可用（便携 QQ 仅 Windows）—— 请自行登录 QQ 并启动协议端（SnowLuma 或 NapCat）';
    btn.textContent = '不可用';
    btn.disabled = true;
  } else if (!connQb.qqReady) {
    if (text) text.textContent = '没找到可用的 QQ —— 装好新版 QQ（QQNT，官网下载即可）后点右边重新检测';
    btn.textContent = '重新检测 QQ';
  } else if (!connQb.qqRunning) {
    if (text) text.textContent = connQb.source === 'local'
      ? '已用上你电脑里的 QQ —— 点一下直接启动，机器人会另开一个窗口登录'
      : '点一下启动机器人用的 QQ（更推荐用你电脑里已装的 QQ）';
    btn.textContent = '启动机器人的 QQ';
  } else if (!connQb.protoUp) {
    if (text) text.textContent = 'QQ 已启动，但协议端没在运行 —— SnowLuma / NapCat 需要你自己启动';
    btn.textContent = '重新检查';
  } else {
    if (text) text.textContent = '协议端在运行 —— 正在等机器人上线…';
    btn.textContent = '等待连接…';
  }
  // 「QQ 来源」块：按状态显隐按钮 + 一句话现状
  const stateEl = $('#qq-portable-state');
  const pStart = $('#qq-portable-start-btn');
  const pInstall = $('#qq-install-btn');
  const intro = $('#qq-source-intro');
  if (!connQb.portableSupported) {
    // 便携 QQ 依赖 QQNT，只有 Windows 版。mac/Linux 上「装独立副本」永远
    // 只会得到「没找到本机安装的 QQ」—— 那条路在这里不可达，不是"还没装"。
    // 藏掉两个按钮，把这句话说清楚，免得用户反复点。
    if (intro) intro.textContent = '便携 QQ（含「装独立副本」）仅 Windows 可用 —— QQNT 没有 macOS / Linux 版。当前平台请用外部 OneBot 协议端（如 NapCat / LLOneBot）配合你已登录的 QQ。';
    if (stateEl) stateEl.textContent = '便携 QQ 仅 Windows 可用';
    if (pStart) pStart.style.display = 'none';
    if (pInstall) pInstall.style.display = 'none';
    return;
  }
  if (stateEl) stateEl.textContent = !connQb.portableInstalled
    ? (connQb.source === 'none' ? '未检测到 QQ，也没装独立副本 —— 先装一个新版 QQ（QQNT）'
      : '未装独立副本 —— 当前直接用你电脑里已装的 QQ ✓')
    : (connQb.qqRunning ? `独立副本 QQ 运行中（pid ${connQb.pid ?? '—'}）` : '已装独立副本，未运行');
  if (pStart) pStart.style.display = connQb.portableInstalled ? '' : 'none';
  if (pInstall) pInstall.style.display = connQb.portableInstalled ? 'none' : '';
}

/** 拉 QQ 运行态与协议端端口态，写进 connQb 后重画启动区。 */
async function connQbRefresh() {
  try {
    const [st, q] = await Promise.all([
      api('/api/status').catch(() => null),
      api('/api/qq-portable/status').catch(() => null)
    ]);
    if (!st) {
      const stateEl = $('#qq-portable-state');
      if (stateEl) stateEl.textContent = '状态读取失败（后端没有应答）';
      return;
    }
    const qq = q || st.qqPortable || {};
    connQb.qqReady = !!qq.ready;
    connQb.qqRunning = !!qq.running;
    connQb.pid = qq.pid ?? null;
    connQb.source = qq.source || (connQb.qqReady ? 'portable' : 'none');
    connQb.portableInstalled = qq.portableInstalled !== undefined ? !!qq.portableInstalled : (connQb.source === 'portable');
    // supported 缺省按 true：后端字段未就位时保持 Windows 的现有行为，
    // 不能因为读不到就突然把安装入口藏掉（与 ffmpeg 的 canAutoInstall 同口径）。
    connQb.portableSupported = qq.supported !== false;
    connQb.protoUp = !!st.protocol?.portOpen;
    connQb.connected = !!st.onebot?.connected;
    connQb.loaded = true;
    connQbPaint();
  } catch { /* 拉不到就保持占位文案，不打断连接页 */ }
}

function renderConnectionPage(v) {
  const { proto, connected, portOpen, selfId, nick, diag, overall, overallText } = v;
  const wsUrl = String(proto.wsUrl || '');
  const httpUrl = String(proto.httpUrl || '');
  const verdict = connVerdict(v);

  const selfHtml = connected
    ? `${esc(nick || '已登录')}${selfId ? ` <em style="opacity:.65;font-style:normal">${esc(selfId)}</em>` : ''}`
    : '<span class="sl-adv-dim">未连接</span>';
  const portHtml = portOpen
    ? '<span style="color:var(--green)">端口在监听</span>'
    : '<span class="sl-adv-dim">端口未监听</span>';
  const diagText = connected ? '连接正常，能收发群消息' : (diag || '还没连上 —— 先确认协议端在运行、机器人 QQ 已登录');
  // 连接状态变化不覆盖用户对安装指引的开合选择。

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

        <div class="sl-section" id="conn-qq">
          <div class="sl-section-title">启动机器人用的 QQ<span class="sl-section-sub">协议端另装另起</span></div>

          <div class="sl-quickbar">
            <span class="sl-quickbar-text" id="quick-start-text">正在读取 QQ 状态…</span>
            <button class="btn btn-small btn-primary" id="quick-start-btn" disabled>…</button>
            <span id="quick-start-hint" class="sl-hint"></span>
          </div>

          <div class="hint" id="qq-source-intro">推荐直接用你电脑里已装的 QQ（检测到就自动用它，无需任何安装步骤）。下面的「装独立副本」是给想要彻底隔离的人准备的「可选项」，不装也完全能用。</div>
          <div class="sl-adv-row">
            <button class="btn btn-small" id="qq-portable-start-btn" title="启动应用自带的便携版 QQ（装了独立副本才有意义）" style="display:none">单独启动便携 QQ</button>
            <button class="btn btn-small" id="qq-install-btn" title="复制一份独立的 QQ 副本（1~2GB，需几分钟），和你自己的 QQ 完全分开；需要先把 QQ 完全退出" style="display:none">装独立副本（可选）</button>
            <span id="qq-portable-state" class="sl-hint" style="margin:0">正在读取 QQ 状态…</span>
          </div>
          <div class="hint" id="qq-portable-hint"></div>
        </div>

        <details class="conn-setup" id="conn-setup"${connSetupOpen ? ' open' : ''}>
          <summary><span>协议端需要自行下载安装</span><span class="conn-setup-sub">SnowLuma 或 NapCat，二选一，装好就不用再管这一节</span></summary>
          <div class="conn-setup-body">
            <div class="sl-node-help">协议端要你自己装、自己启动。SnowLuma 和 NapCat 的默认端口一样，装完就能连上，所以这页把两边的安装步骤都写全了。</div>
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
              <span class="sl-hint">还连不上就看上面的「诊断详情」，完整日志在「工具 → 日志」页。</span>
            </div>
          </div>
        </details>

        <details class="sl-adv" id="conn-adv"${connAdvOpen ? ' open' : ''}>
          <summary>端点设置：换了端口、加了令牌才需要动</summary>
          <div class="sl-adv-body">
            <div class="field-row">
              <div class="field"><label for="conn-wsurl">WebSocket 地址（收消息）</label>
                <input type="text" id="conn-wsurl" value="${esc(wsUrl)}" placeholder="ws://127.0.0.1:3001" /></div>
              <div class="field"><label for="conn-httpurl">HTTP 地址（发消息）</label>
                <input type="text" id="conn-httpurl" value="${esc(httpUrl)}" placeholder="http://127.0.0.1:3000" /></div>
            </div>
            <div class="field-row">
              <div class="field"><label for="conn-wstoken">WebSocket 令牌</label>
                <div class="conn-token-control">
                  <input type="password" id="conn-wstoken" value="${esc(proto.hasAccessToken ? '******' : '')}" placeholder="输入 WS 令牌" autocomplete="new-password" aria-describedby="conn-wstoken-hint" />
                  <button class="btn btn-small" id="conn-wstoken-toggle" type="button" aria-controls="conn-wstoken" aria-label="显示 WebSocket 令牌">显示</button>
                </div>
                <div class="hint" id="conn-wstoken-hint">与协议端一致；未设置则留空。</div>
              </div>
              <div class="field"><label for="conn-httptoken">HTTP 令牌</label>
                <div class="conn-token-control">
                  <input type="password" id="conn-httptoken" value="${esc(proto.hasHttpAccessToken ? '******' : '')}" placeholder="输入独立 HTTP 令牌" autocomplete="new-password" aria-describedby="conn-httptoken-hint" />
                  <button class="btn btn-small" id="conn-httptoken-toggle" type="button" aria-controls="conn-httptoken" aria-label="显示 HTTP 令牌">显示</button>
                </div>
                <div class="hint" id="conn-httptoken-hint">留空沿用 WS 令牌；不同时才填。</div>
              </div>
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
      </div>`;
}

/** quiet 刷新：只改状态文字，不碰输入框、不重建整页。 */
function updateConnectionLive(v) {
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

  // 启动区跟着状态走：quiet 刷新不重绑事件，只把连接 / 端口两位同步过来再重画。
  connQb.connected = !!v.connected;
  connQb.protoUp = !!v.portOpen;
  connQbPaint();
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

    updateConnectionLive(nv);
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

  // 状态是这一页唯一的取数：日志已独立成「工具 → 日志」页，本页不再拉日志。
  const status = await api('/api/status').catch(() => null);

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

  if (quiet && box.querySelector('.snowluma-page-card')) {
    updateConnectionLive(v);
    return;
  }

  box.innerHTML = renderConnectionPage(v);
  bindConnectionPage(box, v);
}

function bindConnectionPage(box, v) {
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
        updateConnectionLive(nv);
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

  // ── 令牌显示 / 隐藏（明文走 /api/onebot-token）──
  const wireTokenToggle = (btnId, inputId, which, label) => {
    const btn = $(btnId);
    const inp = $(inputId);
    if (!btn || !inp) return;
    let edited = false;
    inp.addEventListener('input', () => { edited = true; });
    const setVisible = (visible) => {
      inp.type = visible ? 'text' : 'password';
      btn.textContent = visible ? '隐藏' : '显示';
      btn.setAttribute('aria-label', `${btn.textContent} ${label}令牌`);
    };
    btn.addEventListener('click', async () => {
      if (inp.type === 'text') {
        // 未编辑的已存令牌恢复掩码；新输入或清空的值必须保留给保存操作。
        if (!edited && inp.value) inp.value = '******';
        setVisible(false);
        return;
      }
      btn.disabled = true;
      try {
        // 未编辑时按需读取，避免自动读取协议端配置后显示旧令牌；不缓存明文。
        if (!edited) {
          const r = await api(`/api/onebot-token?which=${which}`);
          if (!inp.isConnected) return;
          // 请求期间仍允许编辑，迟到的响应不能覆盖用户刚输入的内容。
          if (!edited) inp.value = String(r.token ?? '');
        }
        setVisible(true);
      } catch (e) {
        const hint = $('#conn-save-hint');
        if (hint) hint.textContent = `读取令牌失败：${e.message}`;
      } finally {
        btn.disabled = false;
      }
    });
  };
  wireTokenToggle('#conn-wstoken-toggle', '#conn-wstoken', 'ws', 'WebSocket ');
  wireTokenToggle('#conn-httptoken-toggle', '#conn-httptoken', 'http', 'HTTP ');

  // ── 启动 QQ + 便携副本（原「设置 → 连接 QQ」，随分区一起搬到这里）──
  // 步骤 0（重新检测）只在本页；步骤 1–3 是 00-core.js 的 launchBotQq，左栏「开始对话」共用。
  const quickStartBtn = $('#quick-start-btn');
  if (quickStartBtn) {
    quickStartBtn.addEventListener('click', async () => {
      const btn = quickStartBtn;
      const hint = $('#quick-start-hint');
      btn.disabled = true;
      if (hint) hint.textContent = '';
      try {
        // 步骤 0：没检测到 QQ → 重新检测（force=1 跳过 30s 探测缓存）
        if (!connQb.qqReady) {
          if (hint) hint.textContent = '正在重新检测…';
          const r = await api('/api/qq-portable/status?force=1');
          if (r?.ready) {
            if (hint) hint.textContent = '✓ 检测到 QQ，可以启动了';
            connQb.qqReady = true;
            connQb.source = r.source || (connQb.source === 'none' ? 'local' : connQb.source);
            connQbPaint();
          } else {
            if (hint) hint.textContent = '还是没检测到 —— 确认装的是新版 QQ（QQNT），装完再点一次';
            btn.disabled = false;
          }
          return;
        }
        // 步骤 1–3：启动 QQ → 确认协议端端口 → 等 OneBot 上线。
        // 流程本体在 00-core.js 的 launchBotQq（左栏「开始对话」共用同一份），这里只负责
        // 把进度写进本页的提示行与按钮，并用 connQb 落终态。
        const res = await launchBotQq({
          // 页面切走后按钮脱离 DOM：别让轮询继续每 2 秒打一次 /api/status
          isAborted: () => !btn.isConnected,
          onProgress: (e) => {
            btn.textContent = e.phase === 'launching' ? '启动 QQ 中…' : '等待机器人上线…';
            if (hint) hint.textContent = e.message;
          }
        });
        // 页面已切走：写什么都没人看，也不再重画
        if (res.phase === 'aborted') return;
        if (res.phase === 'launch-failed') {
          if (hint) hint.textContent = res.message;
          connQbPaint();
          return;
        }
        // 走到这里 QQ 已经起来了（协议端是否在跑见下一步）
        connQb.qqRunning = true;
        if (res.phase === 'proto-down') {
          // 协议端不由本软件启动：明说去哪儿装 / 怎么启动，在这里干等 5 分钟只会让人
          // 以为程序坏了。
          connQb.protoUp = false;
          if (hint) hint.textContent = 'QQ 已启动，但协议端没在运行 —— 按本页「协议端需要自行下载安装」里的步骤启动 SnowLuma 或 NapCat';
          connQbPaint();
          return;
        }
        connQb.protoUp = true;
        if (res.phase === 'connected') {
          if (hint) hint.textContent = '✅ 已连接！机器人开始工作';
          // ⚠️ 走 connQbPaint() 落终态，别手写 btn.textContent：紧随其后的
          //    connQbRefresh() 会重画一次，手写的字样会被覆盖。
          connQb.connected = true;
          connQbPaint();
          connQbRefresh();
          return;
        }
        // 剩 'timeout'：最多等 5 分钟仍没上线，把"现在该查什么"写清楚
        if (hint) {
          hint.textContent = '等了 5 分钟还没连上 —— 看本页上方的状态：'
            + '最常见是机器人 QQ 还没登录，或协议端的端口/令牌与这里不一致。';
        }
        connQbPaint();
      } catch (e) {
        if (hint) hint.textContent = `启动失败：${e.message}`;
        connQbPaint();
      }
    });

    // 「单独启动便携 QQ」（仅装了独立副本时显示）
    const pStartBtn = $('#qq-portable-start-btn');
    if (pStartBtn) pStartBtn.addEventListener('click', async () => {
      const btn = pStartBtn;
      const hint = $('#qq-portable-hint');
      btn.disabled = true;
      if (hint) hint.textContent = '';
      try {
        const r = await api('/api/qq-portable/launch', { method: 'POST', body: '{}' });
        if (hint) hint.textContent = r.alreadyRunning
          ? '便携 QQ 已在运行 ✓'
          : (r.ok ? '已启动 —— QQ 不会自动弹窗，到任务栏/托盘把窗口调出来登录' : `启动失败：${r.error}`);
      } catch (e) {
        if (hint) hint.textContent = `启动失败：${e.message}`;
      }
      connQbRefresh();
    });

    // 「装独立副本（可选）」：从本机 QQ 复制一份（1~2GB，分钟级），带进度轮询。
    // ⚠️ 判断"装没装完"要看 portableInstalled / setup.ok，不能看 ready：
    //    本机有 QQ 时 ready 本来就是 true，用它会一进来就误判"装好了"。
    const pInstallBtn = $('#qq-install-btn');
    if (pInstallBtn) pInstallBtn.addEventListener('click', async () => {
      const btn = pInstallBtn;
      const hint = $('#qq-portable-hint');
      btn.disabled = true;
      btn.textContent = '安装中…';
      if (hint) hint.textContent = '正在从你电脑里的 QQ 复制一份 —— 请先完全退出 QQ（包括托盘图标）';
      try {
        const r0 = await api('/api/qq-portable/setup', { method: 'POST', body: '{}' });
        if (!r0.ok && !r0.alreadyInstalled) {
          if (hint) hint.textContent = r0.error || '安装失败';
        } else if (r0.alreadyInstalled) {
          if (hint) hint.textContent = '独立副本已装好 ✓';
        } else {
          // 后端已开始复制 → 每秒看一眼进度（上限 30 分钟）
          for (let i = 0; i < 1800; i++) {
            // 同启动链：切走后按钮脱离 DOM，别让这个每秒一次的进度轮询继续空转。
            if (!btn.isConnected) break;
            await new Promise((r) => setTimeout(r, 1000));
            const s = await api('/api/status');
            const setup = s.qqPortable?.setup;
            if (setup?.running) {
              if (hint) hint.textContent = `复制中 ${setup.done}/${setup.total}（${setup.step}）…预计几分钟`;
              continue;
            }
            if (setup?.error) { if (hint) hint.textContent = setup.error; break; }
            if (setup?.ok || s.qqPortable?.portableInstalled) { if (hint) hint.textContent = '✓ 独立副本装好了'; break; }
          }
        }
      } catch (e) {
        if (hint) hint.textContent = `安装失败：${e.message}`;
      }
      btn.disabled = false;
      btn.textContent = '装独立副本（可选）';
      connQbRefresh();
    });

    // 首次渲染先摆占位文案，拉到运行态后原地重画（不重建表单，绑定不丢）。
    connQbRefresh();
  }

  // ── 复制诊断信息（反馈用）：连接状态来自本页已取到的 v，日志现场拉一次 ──
  const copyBtn = $('#conn-copy-diag');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const hint = $('#conn-copy-hint');
    copyBtn.disabled = true;
    try {
      // 日志面板已从本页移除，进页时不再预取；只在用户真要反馈时才拉一次，
      // 失败就当没有可疑日志（诊断结论本身仍然可用）。
      const appLogs = await api('/api/logs?limit=200').catch(() => ({ logs: [] }));
      const arr = Array.isArray(appLogs.logs) ? appLogs.logs : [];
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
      await navigator.clipboard.writeText(lines);
      if (hint) hint.textContent = '已复制，可直接粘贴反馈 ✓';
    } catch (e) {
      if (hint) hint.textContent = `复制失败：${(e && e.message) || e}`;
    } finally {
      copyBtn.disabled = false;
    }
  });
}
