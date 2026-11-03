// OneBot v11 客户端：WebSocket 只收事件，HTTP API 负责发送与查询。
// （原版经 @snowluma/sdk 收事件；这里直接实现标准 OneBot v11，去掉 SDK 补丁依赖。）
import WebSocket from 'ws';
import { sanitizeUserText, escapeCqText } from './util.js';
import { skillManager } from './skills/manager.js';
import { logger } from './logger.js';

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30000;
// 连上 WS 但 get_login_info 失败（SnowLuma 还在启动/账号还没挂好）时的补拉间隔。
const SELF_INFO_RETRY_MS = 15000;

/**
 * 正文 @ 规范化：把 `@昵称` 补成 `@昵称(QQ:xxx)`。
 * 走 `message.inline-at-normalize` 能力；没有提供者（Skill 未启用）时返回 null，
 * 调用方退回原文本，保证"关掉 Skill 就不再有该效果"。
 */
function normalizeInlineAt(text, atUserId, atName) {
  try {
    const fn = skillManager.getCapabilityProviders('message.inline-at-normalize')[0]?.fn;
    if (!fn || !atName) return null;
    return fn({ text, members: [{ userId: atUserId, nickname: atName }], atUserId }) ?? null;
  } catch {
    return null;
  }
}

/**
 * 语音转文字：走 `media.transcribe` 能力（speech-to-text 插件提供）。
 *
 * 返回 null 的三种情况都退回 `[语音]` 占位，等于"没装这个插件"：
 *   · 没有提供者（插件未启用 / 没配 whisper 路径）
 *   · 调用方没给 onebot 客户端（拿不到语音文件）
 *   · 识别失败（插件内部已吞错并 log，这里再兜一层）
 * 这样保证关掉插件行为完全回退，且识别失败绝不打断消息入库。
 */
async function transcribeVoice(record, onebot) {
  try {
    const fn = skillManager.getCapabilityProviders('media.transcribe')[0]?.fn;
    if (!fn || !onebot) return null;
    const r = await fn({ record, onebot });
    const text = String(r?.text ?? '').trim();
    return r?.ok && text ? text : null;
  } catch {
    return null;
  }
}

// ── OneBot HTTP 调用的超时与错误可读性 ────────────────────────────────────
const CALL_TIMEOUT_MS = 15000;    // 查询类：够用
const SEND_TIMEOUT_MS = 90000;    // 发送类：协议端要接收 body + 解码 + 上传腾讯，15 秒远不够
// 只有真的扛大 body 的 action 才给宽容超时。
//
// 为什么不能简单写 `send_`：`send_poke`（拍一拍）、`friend_poke`、`group_poke`
// 都是轻量交互，给它们 90 秒意味着协议端一旦不响应，用户要干等一分半才看到报错，
// 观感上等同于"卡死"。而 `send_group_msg` / `send_private_msg` 可能携带
// image/video/record 段，那才是需要长窗口的。
// `send_(group|private)` 同时覆盖了 `send_group_msg` 与 `send_group_forward_msg`。
const SLOW_ACTION = /^(send_(group|private)|upload_|_send)/i;

/**
 * 把 fetch 的 `cause` 链挖成人话。
 * fetch 网络层失败时 message 恒为 "fetch failed"，真因（ECONNREFUSED /
 * TimeoutError / socket hang up / 代理拦截）全在 cause 里，不挖出来，
 * 上层和用户都只看到一句"fetch failed"，完全无法排查。
 */
function describeCause(error, depth = 0) {
  if (!error) return '未知原因';
  if (depth > 3) return String(error?.message ?? error);
  const parts = [];
  const seen = new Set();
  let cur = error;
  while (cur && !seen.has(cur) && parts.length < 4) {
    seen.add(cur);
    const code = cur.code ? `[${cur.code}] ` : '';
    const msg = String(cur.message || cur.name || '').trim();
    const piece = `${code}${msg}`.trim();
    if (piece && !parts.includes(piece)) parts.push(piece);
    cur = cur.cause;
  }
  return parts.filter((p) => p && p !== 'fetch failed').join(' ← ')
    || parts.join(' ← ') || '未知原因';
}

export class OneBotClient {
  constructor({ wsUrl, httpUrl, accessToken, httpToken, onEvent }) {
    this.wsUrl = String(wsUrl || 'ws://127.0.0.1:3001');
    this.httpUrl = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.accessToken = String(accessToken || '');
    // SnowLuma 允许给 WS 与 HTTP 配不同令牌；httpToken 缺省沿用 accessToken
    this.httpToken = String(httpToken || accessToken || '');
    this.onEvent = onEvent || (() => {});
    this.socket = null;
    this.connected = false;
    this.everConnected = false;
    this.lastConnectError = '';
    this.selfInfo = null;      // { user_id, nickname }
    this.#closedByUs = false;
    this.statusListeners = new Set();
    // HTTP 401 监听：WebSocket 的 status.error 只覆盖 WS 通道，
    // 而 send_message / get_group_info 等全走 HTTP，HTTP 401 此前完全静默，
    // 表现为「群友说机器人不说话了」，日志里一条记录都没有。
    this.authErrorListeners = new Set();
  }

  /** 注册 HTTP 鉴权失败回调（app.js 用它触发令牌轮换）。返回取消订阅函数。 */
  onAuthError(fn) {
    this.authErrorListeners.add(fn);
    return () => this.authErrorListeners.delete(fn);
  }

  #notifyAuthError(detail) {
    for (const fn of this.authErrorListeners) {
      try { fn(detail); } catch { /* ignore */ }
    }
  }

  #closedByUs;
  #failedAttempts = 0;   // 连续失败次数（指数退避用；连接成功即清零）
  #connectGeneration = 0;  // 连接循环代际号：新循环启动即作废旧循环（防并发僵尸循环）
  #reconnectTimer = null;  // 待执行的重连定时器（close/reconnect 时要清，防泄漏）
  #selfInfoTimer = null;   // get_login_info 延迟补拉定时器

  onStatus(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  #setStatus(connected) {
    this.connected = connected;
    if (connected) this.everConnected = true;
    for (const fn of this.statusListeners) {
      try { fn({ connected, everConnected: this.everConnected, error: this.lastConnectError }); } catch { /* ignore */ }
    }
  }

  async connect() {
    this.#closedByUs = false;
    this.#connectLoop();
  }

  /** 连接配置可能变了（比如用户在「连接」页改了端点/令牌），重连一次。 */
  async reconnect() {
    // 关键：先作废旧 socket，再启新连接。否则旧 socket 的 close 事件稍后到达时
    // 会误以为需要再次重连，造成两个 WebSocket 同时连着 SnowLuma，所有事件收到两份。
    const old = this.socket;
    this.socket = null;
    this.#closedByUs = false;
    // 退避必须清零：reconnect 是"配置变了主动换连接"，不是失败。
    // 之前不清零时，主动换 token 后的第一次连接仍背着旧循环涨到 30 秒的退避，
    // 表现为"切了正确令牌也要等半分钟才试"，多账号轮换恢复被人为拖慢。
    this.#failedAttempts = 0;
    if (this.#reconnectTimer) { clearTimeout(this.#reconnectTimer); this.#reconnectTimer = null; }
    // selfInfoTimer 也一并清掉：它的回调虽有 connected 守卫，但重连是"连接身份换代"，
    // 旧代际的补拉定时器留着只会在新连接上多打一拍（与 close() 的清理语义对齐）。
    if (this.#selfInfoTimer) { clearTimeout(this.#selfInfoTimer); this.#selfInfoTimer = null; }
    try { old?.close(); } catch { /* ignore */ }
    this.#connectLoop();
  }

  /**
   * 换端点（协议端解耦配套）。
   *
   * 为什么需要：协议端改由用户自行安装（SnowLuma / NapCat），端点地址与令牌
   * 是用户第一次运行就要填的东西。构造时快照的 wsUrl/httpUrl 改不动，
   * 旧做法是"改完配置重启应用"，对首次配置的人等于一次无谓的重启。
   *
   * 语义：先换字段再走 reconnect()，复用同一条"作废旧 socket → 清零退避 →
   * 重开连接循环"的路径，不另写一套连接逻辑。
   * 空值不覆盖（只传想改的字段），与 deepMerge 的口径一致。
   */
  async setEndpoint({ wsUrl, httpUrl, accessToken, httpToken } = {}) {
    const nextWs = String(wsUrl ?? '').trim();
    const nextHttp = String(httpUrl ?? '').trim();
    if (nextWs) this.wsUrl = nextWs;
    if (nextHttp) this.httpUrl = nextHttp.replace(/\/+$/, '');
    // 令牌允许显式清空（传空串），所以判据是"传了没传"而不是"是不是空"
    if (accessToken !== undefined) {
      this.accessToken = String(accessToken || '');
      // httpToken 缺省沿用 accessToken（与构造函数同口径）；只有显式传了
      // httpToken 才单独覆盖，避免"改了 WS 令牌把 HTTP 令牌意外抹掉"。
      if (httpToken === undefined) this.httpToken = this.accessToken;
    }
    if (httpToken !== undefined) this.httpToken = String(httpToken || this.accessToken || '');
    await this.reconnect();
  }

  #connectLoop() {
    this.selfInfo = null;
    // 单连接互斥：同一时刻只允许一个连接循环存活。
    // 为什么需要它（401 风暴复盘）：
    // 旧实现里每个 socket 的 close handler 都 setTimeout 一轮新的 connectLoop，
    // 而 app.js 的重连逻辑又会调 reconnect() 开另一轮。
    // 两轮循环并发后：一轮拿着正确令牌连上了（connected=true、UI 显示正常），
    // 另一轮还攥着被 401 拒过的旧令牌每 30 秒撞一次门。SnowLuma 日志里就是
    // 一片成对出现的 "rejected unauthorized WebSocket upgrade"，且永远不停，
    // 因为 401 的 error 事件在 everConnected=true 时不再广播状态，没人去杀它。
    // 互斥做法：循环入口记录"代际号"；新一轮开始时把旧代际作废，旧循环的
    // 定时器醒来后发现代际不匹配就自行退出，不再创建 socket。
    const generation = ++this.#connectGeneration;
    this.#scheduleConnect(generation, 0);
  }

  #scheduleConnect(generation, delayMs) {
    if (this.#closedByUs) return;
    if (generation !== this.#connectGeneration) return;   // 已有更新的循环接管
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        this.#reconnectTimer = null;
        this.#scheduleConnect(generation, 0);
      }, delayMs);
      this.#reconnectTimer = timer;
      return;
    }
    this.#openSocket(generation);
  }

  #openSocket(generation) {
    if (this.#closedByUs) return;
    if (generation !== this.#connectGeneration) return;
    let url = this.wsUrl;
    if (this.accessToken) url += (url.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(this.accessToken)}`;
    let socket;
    try {
      socket = new WebSocket(url, {
        headers: this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}
      });
    } catch (error) {
      this.lastConnectError = String(error?.message ?? error);
      this.#setStatus(false);
      // 指数退避：连续构造失败时间隔翻倍，封顶 RECONNECT_MAX_MS，
      // 曾经固定 RECONNECT_MIN_MS（3 秒一次重试风暴，RECONNECT_MAX_MS 形同虚设）
      this.#failedAttempts++;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** (this.#failedAttempts - 1));
      this.#scheduleConnect(generation, delay);
      return;
    }
    // 创建成功即接管"当前 socket"：更早的 socket（若有）全部作废。
    const stale = this.socket;
    this.socket = socket;
    if (stale && stale !== socket) {
      // 顺序即崩溃面：必须先 close、再摘监听，而且摘监听不能把 error 一起摘掉。
      // 原因：ws 8.x 在 CONNECTING 状态调 close() 会同步 `emit('error')`
      // （"WebSocket was closed before the connection was established"，
      // ws 库的 `emitErrorAndClose`）；更麻烦的是底层 net socket 随后还会异步报
      // ECONNREFUSED/ECONNRESET，ws 内部同样走 emit('error')。旧写法先
      // removeAllListeners() 把 'error' 一起拆了，这两次 emit 都没有监听者，
      // EventEmitter 直接抛出 → 主进程 uncaughtException → 弹窗后 app.exit(1)
      // （用户看到的就是"闪退"）。实测复现：一次「端口边沿触发 reconnect」正好
      // 撞上仍在连接的 socket，整个进程被这条 error 干掉。
      // 空 error 监听必须留到 socket 真正 close 之后。
      try { stale.on('error', () => { /* 已作废的 socket：错误一律吞掉 */ }); } catch { /* ignore */ }
      try { stale.close(); } catch { /* ignore */ }
    }
    // 每个 socket 的事件处理器都先验证"我还是不是当前 socket"，
    // 旧连接被作废后其迟到事件直接忽略，避免重复重连/状态错乱。
    const isCurrent = (s) => this.socket === s;

    socket.on('open', async () => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = '';
      this.#failedAttempts = 0;   // 连上了，退避计数清零
      this.#setStatus(true);
      try {
        const selfInfo = await this.call('get_login_info');
        if (!isCurrent(socket) || !this.connected) return;
        this.selfInfo = selfInfo;
      } catch (error) {
        if (!isCurrent(socket) || !this.connected) return;
        console.error('[onebot] 获取登录信息失败:', error?.message ?? error);
        // get_login_info 失败不代表连接不可用（可能是 SnowLuma 还在启动中）。
        // 挂一个延迟补拉：连着但 selfInfo 一直空 → /api/status 的 self 恒为 null，
        // UI 就"检测不到账号信息"。
        this.#refreshSelfInfoLater(socket);
      }
    });
    socket.on('message', (data) => {
      if (!isCurrent(socket)) return;
      let event = null;
      try { event = JSON.parse(String(data)); } catch { return; }
      if (!event || typeof event !== 'object') return;
      try { this.onEvent(event); } catch (error) { console.error('[onebot] 事件处理出错:', error); }
    });
    socket.on('close', () => {
      if (!isCurrent(socket)) return; // 旧连接的迟到 close：新连接已在处理
      this.selfInfo = null;
      if (this.#selfInfoTimer) { clearTimeout(this.#selfInfoTimer); this.#selfInfoTimer = null; }
      this.#setStatus(false);
      if (!this.#closedByUs) {
        // 指数退避：长断线时 3 秒一次的重试风暴既刷屏又占资源；
        // 连接成功过一次就重置计数。
        this.#failedAttempts++;
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** (this.#failedAttempts - 1));
        this.#scheduleConnect(generation, delay);
      }
    });
    socket.on('error', (error) => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = String(error?.message ?? error);
      // 广播状态不能只看 everConnected：曾经"连上过一次就不再广播
      // 失败状态"，导致长连接断开后的持续 401 在 UI 上毫无感知（状态一直是"已连接"），
      // 令牌轮换的恢复钩子也收不到信号。现在每次 error 都广播，由监听方自行去重。
      this.#setStatus(false);
    });
  }

  /** 连接活着但 selfInfo 为空时，定期补拉 get_login_info（SnowLuma 慢启动场景）。
   *  原来只补拉一次：SnowLuma 挂账号超过 15 秒时 selfId 会一直为空
   *  （@判定按 QQ 号、自我消息过滤都依赖它），直到下一次重连才恢复。
   *  现在改为：只要还连着且没拿到，就按固定间隔一直补拉。 */
  #refreshSelfInfoLater(socket) {
    if (this.#selfInfoTimer) return;
    const timer = setTimeout(async () => {
      this.#selfInfoTimer = null;
      if (this.socket !== socket || !this.connected || this.selfInfo) return;
      try {
        const selfInfo = await this.call('get_login_info');
        // HTTP 响应可能晚于重连或关闭；身份只属于发起查询的连接。
        if (this.socket !== socket || !this.connected) return;
        this.selfInfo = selfInfo;
        if (this.selfInfo) this.#setStatus(true);   // 触发一次状态广播，UI 拿到账号信息
      } catch { /* 还没就绪：继续按固定间隔补拉，直到拿到或断线 */ }
      if (this.socket === socket && this.connected && !this.selfInfo) this.#refreshSelfInfoLater(socket);
    }, SELF_INFO_RETRY_MS);
    this.#selfInfoTimer = timer;
  }

  close() {
    this.#closedByUs = true;
    this.selfInfo = null;
    if (this.#reconnectTimer) { clearTimeout(this.#reconnectTimer); this.#reconnectTimer = null; }
    if (this.#selfInfoTimer) { clearTimeout(this.#selfInfoTimer); this.#selfInfoTimer = null; }
    const old = this.socket;
    this.socket = null;
    try { old?.close(); } catch { /* ignore */ }
    this.#setStatus(false);
  }

  /** OneBot HTTP API（发送与查询都走这里）。 */
  async call(action, params = {}, timeoutMs = null) {
    // ── 超时按 action 分档 ─────────────────────────────────────────────────
    // 一律 15 秒的话查询类够用，但发送类不够：图片/视频以 base64 或大 body
    // 发出去时，协议端要走完「接收 body → 解码 → 上传腾讯服务器 → 返回」，
    // 实测 1.9MB 的图稳定超时、1.5MB 有时能过，表现就是"图画出来了但发不出去"。
    // 而超时抛的是 `fetch failed`（真因在 cause 里），用户完全看不懂。
    // 发送是不幂等但"重试代价低"的操作，宁可多等，也不要误判失败。
    const limit = timeoutMs ?? (SLOW_ACTION.test(action) ? SEND_TIMEOUT_MS : CALL_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${this.httpUrl}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.httpToken ? { authorization: `Bearer ${this.httpToken}` } : {})
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(limit)
      });
    } catch (error) {
      // fetch 只在网络层失败时抛，且 message 恒为 "fetch failed"，丢给上层
      // 只会得到一句没法排查的话。这里把 cause 链挖出来再抛。
      const cause = describeCause(error);
      const aborted = /timeout|abort/i.test(cause) || error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new Error(aborted
        ? `OneBot ${action} 超时（${Math.round(limit / 1000)} 秒未完成）：${cause}`
        : `OneBot ${action} 请求失败：${cause}`);
    }
    if (!res.ok) {
      // 401 = 令牌不对。HTTP 通道此前只抛错、既不通知也不轮换，
      // 于是「令牌轮换」这个只挂在 WS status.error 上的恢复机制永远等不到触发，
      // 所有走 HTTP 的能力（取群名/表情库/发消息）全线 401，且日志一字不留。
      // 这里补一条日志 + 通知上层，让 WS/HTTP 两条通道共用同一套轮换逻辑。
      if (res.status === 401) {
        // 完全静默是这次排查最大的障碍（群友只能看到"机器人不说话了"），
        // 所以这里必须落一条 warn，它是外部定位此故障的第一手证据。
        logger.warn('onebot', `HTTP 401：${action} 令牌无效（WS 与 HTTP 可能是不同令牌），已通知上层轮换`);
        this.#notifyAuthError({ action, status: 401 });
        throw new Error(`OneBot ${action} HTTP 401：访问令牌无效（已通知上层轮换令牌）`);
      }
      const hint = res.status === 426
        ? '（HTTP 426：httpUrl 可能指向了 WebSocket 端口，请检查 protocol.httpUrl 是否为 OneBot HTTP API 地址）'
        : '';
      throw new Error(`OneBot ${action} HTTP ${res.status}${hint}`);
    }
    const body = await res.json();
    if (body.status !== 'ok' && body.retcode !== 0) {
      // retcode / wording 必须挂到错误对象上，不能只塞进 message 字符串。
      // 上层要按 retcode 分流（例如 get_forward_msg 的 retcode=100 = 协议端拿不到
      // 长消息内容，和"不是转发"是两回事），字符串匹配一旦文案改了就会静默失效。
      const e = new Error(`OneBot ${action} 失败: retcode=${body.retcode ?? body.status} ${body.wording ?? ''}`);
      e.action = action;
      e.retcode = body.retcode ?? null;
      e.wording = body.wording ?? '';
      throw e;
    }
    return body.data;
  }

  get selfId() {
    return this.selfInfo?.user_id != null ? String(this.selfInfo.user_id) : '';
  }

  get selfNickname() {
    return this.selfInfo?.nickname ? String(this.selfInfo.nickname) : '';
  }

  /** 发送消息段。返回 OneBot 响应 data（含 message_id）。 */
  async sendSegments(kind, id, segments) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    return this.call(action, params);
  }

  /**
   * reply/at 前置段的公共构造（sendText / sendSticker / sendImage 三处共用）。
   *
   * 抽出来之前是三段逐行相同的复制粘贴，任何一处单独改校验规则，
   * 另外两处就会悄悄漂移（历史教训：sendText 修过"消息 id 可为负数"，
   * 另外两处当时各带着同样的旧正则）。这里统一三个约定：
   *   - replyToMessageId：非零整数（消息 id 可为负数；空串=不引用）
   *   - atUserId：正整数 QQ 号，禁止 "all"（全体成员用 CQ 码自己拼，不经此路径）
   */
  static #replyAtSegments({ replyToMessageId = null, atUserId = null } = {}) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    return segments;
  }

  async sendText(kind, id, text, { replyToMessageId = null, atUserId = null } = {}) {
    const segments = OneBotClient.#replyAtSegments({ replyToMessageId, atUserId });
    segments.push({ type: 'text', data: { text: escapeCqText(String(text ?? '')) } });
    return this.sendSegments(kind, id, segments);
  }

  async sendSticker(kind, id, imageUrl, { replyToMessageId = null, atUserId = null } = {}) {
    const segments = OneBotClient.#replyAtSegments({ replyToMessageId, atUserId });
    segments.push({ type: 'image', data: { file: String(imageUrl) } });
    return this.sendSegments(kind, id, segments);
  }

  /**
   * 发送一张图片（独立气泡）。
   *
   * fileRef 支持三种形态，交给 OneBot 自己解释：
   *   - base64://<b64>  本地已下载好的图（send_image 走这条）
   *   - http(s)://...   远端图片地址（已收藏的表情走这条）
   *   - 本地绝对路径     不推荐（会把宿主路径暴露给协议端）
   *
   * 段结构与 sendSticker 完全一样（都是 image 段），区别只是语义：
   * 那个是"发表情"，这个是"发一张图"。所以复用同一套 reply/at 处理。
   */
  async sendImage(kind, id, fileRef, { replyToMessageId = null, atUserId = null } = {}) {
    const ref = String(fileRef ?? '').trim();
    if (!ref) throw new Error('图片内容为空');
    const segments = OneBotClient.#replyAtSegments({ replyToMessageId, atUserId });
    segments.push({ type: 'image', data: { file: ref } });
    return this.sendSegments(kind, id, segments);
  }

  async sendPoke(kind, id, targetUserId) {
    if (kind === 'private') {
      return this.call('friend_poke', { user_id: Number(id) }).catch(() =>
        this.call('send_poke', { user_id: Number(id) }));
    }
    return this.call('group_poke', { group_id: Number(id), user_id: Number(targetUserId || id) }).catch(() =>
      this.call('send_poke', { group_id: Number(id), user_id: Number(targetUserId || id) }));
  }

  async getMsg(messageId) {
    return this.call('get_msg', { message_id: Number(messageId) });
  }

  async getGroupInfo(groupId) {
    return this.call('get_group_info', { group_id: Number(groupId) });
  }

  async getGroupMemberInfo(groupId, userId) {
    return this.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) });
  }
}

// ── 入站事件 → 文本（移植自原版 segmentsToText） ─────────────────────────

export function forwardIdFromData(d) {
  const raw = d?.id ?? d?.res_id ?? d?.forward_id ?? d?.data_id;
  if (raw == null || String(raw).trim() === '') return null;
  return String(raw);
}

/**
 * 从消息段数组里抠出合并转发段的 id（`{type:'forward', data:{id}}`，id 即转发 res_id）。
 * 找不到返回 null。
 */
export function forwardIdFromSegments(segments) {
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    if (String(seg.type ?? '') !== 'forward') continue;
    const id = forwardIdFromData(seg.data ?? {});
    if (id) return id;
  }
  return null;
}

/** 段里到底有没有 forward 段（不管取不取得到它的 id）。 */
function hasForwardSegment(segments) {
  return (segments ?? []).some((s) => String(s?.type ?? '') === 'forward');
}

/** 从 get_msg 结果里取消息段数组（兼容 {message} 与 {data:{message}} 两种形态）。 */
function segmentsOfMessage(msg) {
  if (Array.isArray(msg?.message)) return msg.message;
  if (Array.isArray(msg?.data?.message)) return msg.data.message;
  return null;
}

/**
 * 拉取合并转发的节点数组。必须优先用 forward 段自带的 id，别只传 message_id。
 *
 * 实测（本机 SnowLuma）：协议端 get_forward_msg 只在 `message_id > 0` 时才肯
 * 替我们"取原消息 → 翻出 forward 段 → 拿它的 id"；message_id 为负数
 * （QQ NT 里带转发的消息 id 经常是负的）时这个解析被跳过，负数被原样当成
 * 转发 res_id 去拉，ForwardApi.fetch 抛 "download forward message payload is empty"，
 * 转发永远展开不出来。日志实证：共 11 次失败，11 次全是负数 message_id，正数 17/17 成功。
 *
 * 所以：手上有 segments 就直接抠 id 传 `{ id }`（与协议端内部解析等价，且不受正负限制）；
 * 只有拿不到 id 时才退回 `{ message_id }`。没有 segments 时先用 get_msg 自己取一次。
 *
 * @param timeoutMs 单次 get_forward_msg 的超时（默认走 call() 的 15s 分档）。
 *   ingest 热路径上（引用块里内联展开转发）传个短值，别让协议端卡住整条入库队列。
 */
export async function fetchForwardNodes(onebot, messageId, segments = null, timeoutMs = null) {
  let segs = segments;
  if (!segs && messageId != null && String(messageId).trim() !== '') {
    try { segs = segmentsOfMessage(await onebot.getMsg(messageId)); } catch { segs = null; }
  }

  const attempts = [];
  const fwdId = forwardIdFromSegments(segs);
  // 原消息取到了、里面却没有 forward 段 → 这压根不是合并转发。
  // 实测：模型被引用块里的「[合并转发聊天记录]」勾着，拿外层消息的 mid
  // 来展开，此处若继续退回 `{ message_id }`，协议端必然回 retcode=100
  // （wording: download forward message payload is empty），把「不是转发」伪装成
  // 协议端故障，报错指不到真原因，模型还会反复重试。直接明说。
  // 注意：有 forward 段但抠不出 id 的情况不算在内（那是真转发，只是得退回 message_id）。
  if (segs && !hasForwardSegment(segs)) {
    const e = new Error('这条消息不是合并转发，没有可展开的聊天记录');
    e.code = 'NOT_FORWARD';
    throw e;
  }
  if (fwdId) attempts.push({ id: fwdId });
  if (messageId != null && String(messageId).trim() !== '') attempts.push({ message_id: Number(messageId) });

  let lastErr = null;
  for (const params of attempts) {
    try {
      const r = await onebot.call('get_forward_msg', params, timeoutMs);
      const nodes = Array.isArray(r?.messages) ? r.messages : (Array.isArray(r?.data?.messages) ? r.data.messages : []);
      if (nodes.length) return nodes;
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  return [];
}

/**
 * 把 OneBot 消息段数组转成 AI 可读的纯文本。
 * resolveReply: async (mid) => { sender, text } | null，解析引用原文。
 * resolveAtName: async (qq) => string | null，把 @ 的 QQ 号解析成群名片。
 * onebot: OneBot 客户端，仅语音转写需要（`media.transcribe` 取语音文件用）；
 *         不传则语音保持 `[语音]` 占位。
 */
export async function segmentsToText(segments, { resolveReply = null, resolveAtName = null, includeReply = true, onebot = null } = {}) {
  if (typeof segments === 'string') return sanitizeUserText(segments.trim());
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          const qq = String(d.qq ?? '').trim();
          let name = null;
          try { name = resolveAtName ? await resolveAtName(qq) : null; } catch { name = null; }
          const base = name ? `@${name}` : `@${qq}`;
          // 正文 @ 规范化走 `message.inline-at-normalize` 能力（speaker-identity Skill 提供）：
          // 把 @昵称 补成 @昵称(QQ:xxx)，让模型能区分"同名不同人"。
          // 这里天然同时握有 QQ 号与解析出的名字，是最合适的接入点。
          let piece = normalizeInlineAt(base, qq, name) ?? base;
          // 无论如何都要把 QQ 号带上。
          // 本函数是 @ 从「带 QQ 号的协议段」退化成「纯文本 @名字」的唯一环节：
          // 一旦这里丢掉 QQ 号，下游就只能拿文本里的名字去和配置比对，
          // 但群昵称（群名片）可以随时改、和配置的 botName/selfNickname 也常常不一致，
          // 结果就是「群友明明艾特了机器人，却完全叫不醒」。
          // 带上 QQ 号之后，艾特判定与名字彻底解耦，顺带也让模型区分得清同名群友。
          if (!/\(QQ:\d+\)\s*$/.test(piece)) piece = `${piece}(QQ:${qq})`;
          out.push(piece);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': {
        // 语音转文字走 `media.transcribe` 能力（speech-to-text 插件提供）。
        // 只在主消息路径转写（onebot 由调用方传入）：转发链里逐条跑 whisper
        // 会把 ingest 串行阻塞住，代价不划算，那里保持占位符。
        const spoken = onebot ? await transcribeVoice(d, onebot) : null;
        out.push(spoken ? `[语音转文字] ${spoken}` : '[语音]');
        break;
      }
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              // 引用者名字带 QQ 号（与发言人标签同口径）：有 id 才拼，解析不到就不编造
              const senderLabel = info.senderId
                ? `${info.sender}(QQ:${info.senderId})`
                : info.sender;
              const head = [
                // 被引用的那条本身是合并转发时，resolveReply 会带回它自己的 mid，
                // 引用块里的内容只截了前 300 字，模型想看全就展开这个 #数字。
                // 不带的话，模型只能用引用者那条的号去试，必然"不是合并转发"（实测两次）。
                info.mid ? `#${info.mid}` : '',
                senderLabel
              ].filter(Boolean).join(' ');
              const parts = [];
              if (head) parts.push(head);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch { /* 解析失败降级 */ }
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': out.push('[卡片消息]'); break;
      case 'forward': {
        // 不带 res_id：那个 id 会过期（payload is empty），打出来只会误导模型拿它当参数。
        // 模型要看内容用 read_forward 工具 + 消息前的 #数字。
        out.push('[合并转发聊天记录]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return sanitizeUserText(out.join('').trim());
}

/** 从消息段提取媒体定位信息（不下载）。 */
export function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      media.push({ kind: 'image', file: String(d.file ?? ''), url: String(d.url ?? ''), summary: String(d.summary ?? '') });
    } else if (seg.type === 'video') {
      // 视频段：提取文件定位信息（供 read_video 工具读取）
      media.push({ kind: 'video', file: String(d.file ?? ''), url: String(d.url ?? ''), path: String(d.path ?? '') });
    } else if (seg.type === 'face') {
      media.push({ kind: 'face', faceId: String(d.id ?? '') });
    }
  }
  return media;
}

/**
 * 展开合并转发节点为可读文本（纯函数，便于测试）。
 *
 * 背景：OneBot 事件里的 forward 段只有一个 res_id 占位符，
 * 需要 get_forward_msg 拿回节点数组（本函数处理的就是这个数组）。
 * 实测 NapCat：{ message_id } 可用；res_id 会过期（payload is empty），别依赖。
 *
 * 规则：
 *   - 每个节点一行「昵称: 内容」，内容复用 segmentsToText（@/图片/表情等占位一致）
 *   - 嵌套转发不再展开（深度 1 封顶，套娃截断）
 *   - 封顶：maxNodes 条 / maxChars 字符，超出注明"还有 N 条未展开"
 *   - 节点里的图片段同时提取到 media（url 新鲜，可用于取图/金句）
 *
 * @param {Array} nodes get_forward_msg 返回的 messages 数组
 * @returns {{ text: string, media: Array } | null} 无可用节点返回 null
 */
export async function expandForwardNodes(nodes, { maxNodes = 30, maxChars = 3000 } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  const lines = [];
  const media = [];
  let truncated = 0;

  for (let i = 0; i < nodes.length; i++) {
    if (lines.length >= maxNodes) { truncated = nodes.length - i; break; }
    const n = nodes[i] || {};
    // 发言人带 QQ 号（与主历史同口径）：转发记录里的人也要能被稳定识别
    const rawName = String(n.sender?.card || n.sender?.nickname || n.user_id || '?');
    const nid = String(n.sender?.user_id ?? n.user_id ?? '').trim();
    const name = nid && nid !== rawName ? `${rawName}(QQ:${nid})` : rawName;
    const nm = n.message ?? n.content;
    let body = '';
    if (typeof nm === 'string') {
      // 字符串形态一般是 CQ 码原文，剥掉 [CQ:xxx] 段保留纯文本
      body = nm.replace(/\[CQ:[^\]]*\]/g, '').trim();
    } else if (Array.isArray(nm)) {
      // 嵌套 forward 段清空 data → segmentsToText 输出 [转发消息] 占位（深度 1 封顶）
      const segs = nm.map((s) => (s?.type === 'forward' ? { type: 'forward', data: {} } : s));
      body = await segmentsToText(segs, {});
      media.push(...extractMediaFromSegments(segs));
    }
    body = body.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!body) continue;
    lines.push(`${name}: ${body}`);
    if (lines.join('\n').length > maxChars) { truncated = nodes.length - i - 1; break; }
  }

  const head = `[合并转发 共${nodes.length}条]`;
  if (!lines.length) return { text: head, media };
  const tail = truncated > 0 ? `\n…（还有 ${truncated} 条未展开）` : '';
  return { text: `${head}\n${lines.join('\n')}${tail}`, media };
}
