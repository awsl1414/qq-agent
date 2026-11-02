// Use actual model definitions rather than group labels: imported groups and
// expression names can be renamed without changing an action's resource file.
const basename = (value, suffix) => String(value || '').replaceAll('\\', '/').split('/').pop().replace(suffix, '');
export function buildModelProfile(active = {}, model = null) {
  const manager = model?.internalModel?.motionManager;
  const definitions = manager?.definitions || {};
  const motionAliases = Object.fromEntries((active.motions || []).map((motion) => [motion.id, basename(definitions[motion.group]?.[motion.index]?.File || motion.file, /\.motion3\.json$/i)]));
  const aliases = new Set(Object.values(motionAliases));
  const daimeow = ['hold_pig', 'eat_two_chips', 'cheer'].every((name) => aliases.has(name));
  const expressionDefinitions = manager?.expressionManager?.definitions || [];
  const expressionIds = (active.expressions || []).map((expression) => expression.id);
  const poseForExpression = {};
  if (daimeow) {
    for (const expression of active.expressions || []) {
      const index = (active.expressions || []).indexOf(expression);
      const file = basename(expressionDefinitions[index]?.File, /\.exp3\.json$/i);
      if (file === 'expression1') poseForExpression[expression.id] = 'sit';
      if (file === 'stand-up') poseForExpression[expression.id] = 'stand';
    }
    if (Object.values(poseForExpression).includes('sit') && !Object.values(poseForExpression).includes('stand')) poseForExpression.__qqa_stand__ = 'stand';
  }
  const all = (active.motions || []).map((motion) => motion.id);
  const excludedSitting = new Set(['happy', 'surprised', 'sad', 'cheer']);
  const excludedClick = new Set(['look_left', 'look_right', 'look_up', 'look_down']);
  return {
    modelId: active.id || '', daimeow, motionAliases, expressionIds, poseForExpression,
    ...(daimeow ? { idleMotions: all, clickMotions: all.filter((id) => !excludedClick.has(motionAliases[id])), sittingSafeMotions: all.filter((id) => !excludedSitting.has(motionAliases[id])) } : {}),
  };
}

// SDK 0.4.0 clears its queue before starting a motion, bypassing Cubism's
// built-in fade-out. Opt this model into the existing queue transition path;
// motion files, priorities and explicit stop/replay behavior stay unchanged.
const transitionedManagers = new WeakSet();
const motionSource = new WeakMap();
const canCloneMotion = (motion) => !!motion?._motionData && Array.isArray(motion?._firedEventValues);
export function enableMotionTransitions(model) {
  const manager = model?.internalModel?.motionManager;
  if (!manager || transitionedManagers.has(manager) || typeof manager._startMotion !== 'function' || typeof manager.queueManager?.startMotion !== 'function') return false;
  const original = manager._startMotion;
  manager._startMotion = function (motion, onFinish) {
    // A replay needs its own mutable playback fields. Parsed Cubism curves are
    // read-only during evaluation; event buffers and finish handlers are not.
    // Keeping the outgoing instance lets its existing fade-out finish as well.
    const entries = this.queueManager?._motions;
    if (!Array.isArray(entries)) return original.call(this, motion, onFinish);
    if (entries.some((entry) => entry?._motion === motion || motionSource.get(entry?._motion) === motion)) {
      if (!canCloneMotion(motion)) return original.call(this, motion, onFinish);
      const source = motion;
      motion = Object.assign(Object.create(Object.getPrototypeOf(source)), source, { _firedEventValues: [] });
      motionSource.set(motion, source);
    }
    motion.setFinishedMotionHandler(onFinish);
    return this.queueManager.startMotion(motion, false, performance.now());
  };
  transitionedManagers.add(manager);
  return true;
}

export function createLive2DPlayback({ getModel, getActive, getProfile, isVisible = () => true, effects, reportActivity = () => {} }) {
  let motionVersion = 0, expressionVersion = 0;
  const ready = () => {
    const model = getModel();
    if (!model || !isVisible()) throw new Error(!isVisible() ? '桌宠已隐藏，请先显示桌宠' : '当前角色尚未加载完成');
    return model;
  };
  const activity = (value) => { try { reportActivity({ modelId: getActive()?.id, ...value }); } catch {} };
  async function playMotion(action, priority, context = {}) {
    const version = ++motionVersion;
    const model = ready();
    const modelId = getActive()?.id;
    const manager = model.internalModel?.motionManager;
    const index = Number(action.index);
    try {
      if (manager?.definitions && !manager.definitions[action.group]?.[index]) throw new Error('模型内没有这个动作定义');
      // Preload without reserving first. SDK FORCE still refuses a motion whose
      // group/index is current or reserved, so an explicit replay must reset it.
      const loaded = manager?.loadMotion ? await manager.loadMotion(action.group, index) : null;
      if (manager?.loadMotion && !loaded) throw new Error('动作文件加载失败，请检查模型资源');
      if (version !== motionVersion || model !== getModel() || !isVisible()) throw new Error('动作请求已被新的操作替代');
      const current = manager?.state;
      if (manager?.isFinished?.()) current?.complete?.();
      const same = current && ((current.currentGroup === action.group && current.currentIndex === index) || (current.reservedGroup === action.group && current.reservedIndex === index) || (current.reservedIdleGroup === action.group && current.reservedIdleIndex === index));
      if (priority >= 3 && same) {
        // Clear the SDK's duplicate reservation guard without erasing the
        // rendered motion. The adapted queue can fade it into a fresh replay.
        if (transitionedManagers.has(manager) && canCloneMotion(loaded) && typeof current.reset === 'function') current.reset();
        else manager.stopAllMotions();
      }
      const ok = await model.motion(action.group, index, priority);
      if (ok === false) throw new Error(same ? '该动作仍在播放或加载，请稍后重试' : '动作被更高优先级的动作占用，请稍后重试');
      if (version !== motionVersion || model !== getModel()) return false;
      effects?.start(getProfile()?.motionAliases?.[action.id] || '');
      activity({ modelId, motionId: action.id, trigger: context.trigger || 'motion', ok: true });
      return true;
    } catch (error) { activity({ modelId, motionId: action.id, trigger: context.trigger || 'motion', ok: false, error: error.message }); throw error; }
  }
  async function playExpression(id, context = {}) {
    const version = ++expressionVersion;
    const model = ready();
    const active = getActive();
    const modelId = active?.id;
    const index = (active?.expressions || []).findIndex((expression) => expression.id === id);
    try {
      if (index < 0) throw new Error('当前模型没有此表情');
      const manager = model.internalModel?.motionManager?.expressionManager;
      if (manager?.loadExpression) {
        const expression = await manager.loadExpression(index);
        if (!expression) throw new Error('表情文件加载失败');
        if (version !== expressionVersion || model !== getModel() || !isVisible()) throw new Error('表情请求已被新的操作替代');
        // resetExpression does not clear currentExpression in SDK 0.4.0.
        // Reapply a cached expression explicitly so sit -> stand -> sit works.
        manager.reserveExpressionIndex = -1;
        manager.currentExpression = expression;
        manager.restoreExpression();
      } else if (await model.expression(index) === false) throw new Error('表情暂时无法播放');
      if (!context.silent) activity({ modelId, expressionId: id, trigger: context.trigger || 'expression', ok: true });
      return true;
    } catch (error) { if (!context.silent) activity({ modelId, expressionId: id, trigger: context.trigger || 'expression', ok: false, error: error.message }); throw error; }
  }
  async function setPosture(pose, context = {}) {
    const model = ready();
    const modelId = getActive()?.id;
    const profile = getProfile();
    try {
      if (!profile?.daimeow) throw new Error('当前角色没有可切换的坐站姿态');
      if (pose === 'sit') {
        const id = Object.keys(profile.poseForExpression).find((key) => profile.poseForExpression[key] === 'sit');
        if (!id) throw new Error('当前角色缺少坐姿表情');
        await playExpression(id, { ...context, silent: true });
      } else if (pose === 'stand') {
        expressionVersion++;
        const manager = model.internalModel?.motionManager?.expressionManager;
        if (!manager?.resetExpression) throw new Error('模型不支持表情重置');
        manager.reserveExpressionIndex = -1;
        manager.currentExpression = manager.defaultExpression;
        manager.resetExpression();
      } else throw new Error('未知坐站姿态');
      activity({ modelId, posture: pose, trigger: context.trigger || 'posture', ok: true });
      return true;
    } catch (error) { activity({ modelId, posture: pose, trigger: context.trigger || 'posture', ok: false, error: error.message }); throw error; }
  }
  function resetExpression(context = {}) {
    expressionVersion++;
    const model = ready();
    const manager = model.internalModel?.motionManager?.expressionManager;
    if (!manager?.resetExpression) throw new Error('模型没有可重置的表情');
    manager.reserveExpressionIndex = -1;
    manager.currentExpression = manager.defaultExpression;
    manager.resetExpression();
    activity({ expressionId: '', posture: getProfile()?.daimeow ? 'stand' : undefined, trigger: context.trigger || 'reset-expression', ok: true });
    return true;
  }
  return { playMotion, playExpression, setPosture, resetExpression, invalidate() { motionVersion++; expressionVersion++; effects?.stop(); } };
}
