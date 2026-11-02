// The scheduler owns timing and priority; character-specific poses/effects stay
// in the renderer callbacks and the optional model profile.
export function createPetActionController({ play, playExpression = null, setPosture: applyPosture = null, isPlaying = () => false, now = Date.now, random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let motions = [], config = {}, profile = {};
  let visible = true, priority = 0, pending = null, deferredState = null, stateRevision = 0, sequence = 0, generation = 0;
  let state = 'idle', posture = 'stand', lastPlayed = '', lastExpression = '', lastRejectedReason = '', idleEntered = false;
  let lastClick = -Infinity;
  const timers = new Map();
  const lastAt = new Map();
  const unit = () => Math.min(0.999999999, Math.max(0, Number(random()) || 0));
  const reject = (reason) => { lastRejectedReason = reason; return false; };
  const cooldown = () => Math.min(60, Math.max(0.2, Number(config.clickCooldownSeconds) || 1.5)) * 1000;
  const autonomous = () => config.autonomous !== false;
  const randomMotions = () => autonomous() && config.randomEnabled !== false;
  const randomExpressions = () => autonomous() && config.expressionEnabled !== false;
  const randomPostures = () => autonomous() && config.postureEnabled !== false;
  const canSit = () => typeof applyPosture === 'function' && Object.values(profile.poseForExpression || {}).includes('sit') && Object.values(profile.poseForExpression || {}).includes('stand');
  const sittingSafe = (motion) => posture !== 'sit' || (profile.sittingSafeMotions || []).includes(motion.id);
  function discardDeferredState() { const deferred = deferredState; deferredState = null; deferred?.resolve(false); }

  function enabled(pool = null) {
    const disabled = new Set(Array.isArray(config.disabled) ? config.disabled : []);
    return motions.filter((motion) => (!Array.isArray(pool) || pool.includes(motion.id)) && !disabled.has(motion.id) && Number(config.weights?.[motion.id] ?? 1) > 0 && sittingSafe(motion));
  }
  function choose(pool, previous = lastPlayed, weighted = true) {
    const candidates = pool.length > 1 ? pool.filter((item) => (typeof item === 'string' ? item : item.id) !== previous) : pool;
    const weight = (item) => weighted ? Math.max(0, Number(config.weights?.[item.id] ?? 1) || 0) : 1;
    const total = candidates.reduce((sum, item) => sum + weight(item), 0);
    if (!total) return null;
    let selected = unit() * total;
    for (const item of candidates) { selected -= weight(item); if (selected < 0) return item; }
    return candidates.at(-1);
  }
  function mapped(name, pool = null) { return enabled(pool).find((motion) => motion.id === config.stateMap?.[name]); }
  function manualAllowed() {
    if (!visible) return reject('桌宠已隐藏，显示后才能预览');
    const remaining = cooldown() - (now() - lastClick);
    if (remaining > 0) return reject('点击互动冷却中，请等待 ' + (remaining / 1000).toFixed(1) + ' 秒再预览');
    if (pending !== null) return reject('动作仍在加载，请稍后重试');
    return true;
  }
  async function perform(operation, nextPriority, { force = false, replaceEqual = false, label = '动作', onStarted = null } = {}) {
    if (!visible) return reject('桌宠已隐藏，无法播放');
    if (pending !== null) return reject('动作仍在加载，请稍后重试');
    const busy = Boolean(isPlaying());
    if (!busy) priority = 0;
    if (!force && busy && (priority > nextPriority || (priority === nextPriority && !replaceEqual))) return reject(priority === 3 ? '点击互动或手动动作仍在播放，请稍后重试' : '更高优先级的动作仍在播放，请稍后重试');
    const previousPriority = priority;
    const attempt = ++sequence;
    pending = attempt;
    priority = nextPriority;
    try {
      const sdkPriority = force || (busy && replaceEqual && previousPriority === nextPriority) ? 3 : nextPriority;
      const started = await operation(sdkPriority);
      if (attempt !== sequence || !visible) return false;
      if (started === false) { priority = isPlaying() ? previousPriority : 0; return reject('模型没有开始播放这个' + label + '，请稍后重试'); }
      onStarted?.();
      lastRejectedReason = '';
      return true;
    } catch (error) {
      if (attempt !== sequence) return false;
      priority = isPlaying() ? previousPriority : 0;
      return reject(typeof error?.message === 'string' && error.message.trim() ? error.message.trim().slice(0, 300) : label + '播放失败，请检查模型是否支持');
    } finally {
      if (pending === attempt) {
        pending = null;
        const deferred = deferredState;
        deferredState = null;
        // Loading is serialized, but status events can arrive before it ends.
        // Apply only the latest desired state after the current load settles,
        // through the same priority checks that protect manual interactions.
        // A just-loaded manual action keeps priority even before the SDK has
        // reported its first playing frame.
        if (deferred) {
          let applied = false;
          try {
            if (nextPriority < 3 && visible && deferred.revision === stateRevision) applied = await playState(deferred.value, { replaceEqual: true, skipCurrent: true });
          } finally { deferred.resolve(applied && visible && deferred.revision === stateRevision); }
        }
      }
    }
  }
  function run(motion, nextPriority, { force = false, replaceEqual = false, trigger = 'idle' } = {}) {
    if (!motion) return Promise.resolve(reject('当前姿态没有可用动作，请检查禁用、权重和姿态设置'));
    const time = now();
    if (!force && time - (lastAt.get(motion.id) ?? -Infinity) < 1000) return Promise.resolve(reject('这个动作刚刚播放过，请稍后重试'));
    return perform((sdkPriority) => play(motion, sdkPriority, { trigger }), nextPriority, { force, replaceEqual, onStarted: () => { lastPlayed = motion.id; lastAt.set(motion.id, time); } });
  }
  function playState(value, { replaceEqual = false, skipCurrent = false } = {}) {
    const action = mapped(value) || (value === 'idle' ? null : mapped('idle')) || choose(enabled(profile.idleMotions));
    if (skipCurrent && action?.id === lastPlayed && isPlaying()) return Promise.resolve(true);
    return run(action, value === 'idle' ? 1 : 2, { replaceEqual, trigger: 'state' });
  }
  async function changePosture(next, { manual = true } = {}) {
    if (!['sit', 'stand'].includes(next) || !canSit()) return reject('当前角色没有可用的站坐姿态');
    if (manual && !manualAllowed()) return false;
    if (!manual && (state !== 'idle' || isPlaying() || pending !== null)) return false;
    if (next === posture && !manual) return true;
    return perform(() => applyPosture(next, { trigger: manual ? 'manual' : 'posture' }), manual ? 3 : 1, { force: manual, label: '姿态', onStarted: () => { posture = next; } });
  }
  async function expression(id, { manual = true } = {}) {
    if (!Array.isArray(profile.expressionIds) || !profile.expressionIds.includes(id)) return reject('当前角色没有这个表情');
    if (manual && !manualAllowed()) return false;
    const pose = profile.poseForExpression?.[id];
    if (pose) return changePosture(pose, { manual });
    if (typeof playExpression !== 'function') return reject('当前角色不支持播放表情');
    if (!manual && (state !== 'idle' || isPlaying() || pending !== null)) return false;
    return perform(() => playExpression(id, { trigger: manual ? 'manual' : 'expression' }), manual ? 3 : 1, { force: manual, label: '表情', onStarted: () => { lastExpression = id; } });
  }
  async function idle() {
    if (!visible || !randomMotions()) return false;
    if (isPlaying() || pending !== null) return false;
    if (state !== 'idle') return run(mapped(state) || choose(enabled(profile.idleMotions)), 2, { trigger: 'state' });
    // The idle binding is an entry reaction, not a replacement for the random pool.
    return run(choose(enabled(profile.idleMotions)), 1, { trigger: 'idle' });
  }
  function clearTimers() { for (const timer of timers.values()) clearTimer(timer); timers.clear(); }
  function schedule(kind) {
    if (timers.has(kind)) clearTimer(timers.get(kind));
    timers.delete(kind);
    if (!visible || !autonomous()) return;
    const expressions = (profile.expressionIds || []).filter((id) => !profile.poseForExpression?.[id]);
    if (kind === 'idle' && (!randomMotions() || !motions.length)) return;
    if (kind === 'expression' && (!randomExpressions() || typeof playExpression !== 'function' || !expressions.length)) return;
    if (kind === 'posture' && (!randomPostures() || !canSit())) return;
    const stamp = generation;
    const maximum = Math.min(600, Math.max(5, Number(config.idleIntervalSeconds) || 20));
    const delay = kind === 'posture' ? 60000 + unit() * 60000 : (5 + unit() * (maximum - 5)) * 1000;
    const timer = setTimer(async () => {
      if (timers.get(kind) === timer) timers.delete(kind);
      if (stamp !== generation || !visible) return;
      if (kind === 'idle') await idle();
      else if (kind === 'expression') { const id = choose(expressions, lastExpression, false); if (id) await expression(id, { manual: false }); }
      else await changePosture(unit() < 0.3 ? 'sit' : 'stand', { manual: false });
      if (stamp === generation && visible) schedule(kind);
    }, Math.round(delay));
    timers.set(kind, timer);
  }
  function reschedule() { generation++; clearTimers(); for (const kind of ['idle', 'expression', 'posture']) schedule(kind); }
  return {
    configure(nextMotions, nextConfig, nextProfile = {}) {
      const changedModel = profile.modelId !== nextProfile.modelId || (!profile.modelId && motions !== nextMotions);
      motions = Array.isArray(nextMotions) ? nextMotions : [];
      config = nextConfig || {};
      profile = nextProfile || {};
      if (changedModel) { sequence++; stateRevision++; pending = null; discardDeferredState(); priority = 0; posture = 'stand'; lastPlayed = ''; lastExpression = ''; lastClick = -Infinity; lastAt.clear(); idleEntered = false; }
      reschedule();
    },
    setVisible(value) {
      if (visible === !!value) return;
      visible = !!value;
      if (!visible) { sequence++; stateRevision++; pending = null; discardDeferredState(); priority = 0; }
      reschedule();
    },
    async click() {
      if (!visible) return reject('桌宠已隐藏，无法互动');
      if (now() - lastClick < cooldown()) return reject('点击互动正在冷却，请稍后重试');
      const motion = mapped('click', profile.clickMotions) || choose(enabled(profile.clickMotions));
      if (!motion) return reject('当前姿态没有可用的点击动作');
      if (pending !== null) return reject('动作仍在加载，请稍后重试');
      lastClick = now();
      return run(motion, 3, { force: true, trigger: 'click' });
    },
    async setState(value) {
      const next = ['idle', 'thinking', 'reply', 'error'].includes(value) ? value : 'idle';
      const changed = next !== state;
      state = next;
      if (changed) stateRevision++;
      const repeatedIdle = state === 'idle' && !changed && idleEntered;
      if (state === 'idle') idleEntered = true;
      if (pending !== null) {
        if (priority >= 3) return reject('点击互动或手动动作仍在加载，请稍后重试');
        if (deferredState?.value === state) return deferredState.promise;
        if (changed) {
          discardDeferredState();
          const deferred = { value: state, revision: stateRevision };
          // Callers start reply/reset timers after playback is ready, rather
          // than while a preceding motion is still loading.
          deferred.promise = new Promise((resolve) => { deferred.resolve = resolve; });
          deferredState = deferred;
          return deferred.promise;
        }
        return reject('动作仍在加载，请稍后重试');
      }
      if (repeatedIdle) return false;
      return playState(state, { replaceEqual: changed });
    },
    async preview(id) {
      if (!manualAllowed()) return false;
      const motion = motions.find((item) => item.id === id);
      if (!motion) return reject('当前角色没有这个动作');
      if (!sittingSafe(motion) && !await changePosture('stand')) return false;
      return run(motion, 3, { force: true, trigger: 'manual' });
    },
    expression,
    setPosture: changePosture,
    idle,
    stop() { generation++; sequence++; stateRevision++; clearTimers(); pending = null; discardDeferredState(); priority = 0; visible = false; },
    getState() { return { state, posture, priority, pending: pending !== null, lastPlayed, lastExpression, lastRejectedReason }; },
  };
}
