// Adapted from yubdey/DaiMeow v1.6.0 pet-app-esm.js (MIT source).
// Geometry, trajectories and timing retain the original action behavior.
// Character/prop artwork has separate terms; see daimeow-assets/THIRD_PARTY_NOTICES.md.
export function createDaiMeowEffects({ container, document = globalThis.document, now = () => performance.now(), report = () => {}, syncToModelFrame = false } = {}) {
let live2dModel = null, pawDrawables = null, currentScale = 1, currentCX = 0, currentCY = 0, visible = true;
let pendingAction;
let handoff = null, frameAt = null, renderedHandsOpacity = 1;
const HANDOFF_MS = 180;
const petAPI = { logError: report };
const point = () => ({ x: 0, y: 0, set(x,y) { this.x=x; this.y=y; } });
const propSrcPoint = point(), propDstPoint = point();
const elements = [];
function image(file) { const el = document.createElement('img'); el.className='daimeow-prop'; el.alt=''; el.draggable=false; el.hidden=true; el.dataset.src='./daimeow-assets/'+file; el.src=el.dataset.src; el.dataset.loaded='1'; container?.appendChild(el); elements.push(el); return el; }
const CHEER_ACTION = 'cheer';
const CHEER_PROP_MS = 2300;      // 球露出来的时长，和 cheer.motion3.json 的 2.35s 对齐
const PROP_CANVAS_SIZE = 460;    // 球的直径，按模型画布像素计（会和模型一起缩放）

// 「吃一片薯片 / 吃两片薯片」：袋子 / 两只手 / 单片薯片都是外部 PNG，位置每帧由模型手部中点算出来。
// 单次节奏按 55 帧 GIF 量过；双片动作连续播放同一套两轮。
const CHIPS_ACTION = 'eat_chips';
const CHIPS_TWO_ACTION = 'eat_two_chips';
const CHIPS_CYCLE_MS = 1650;       // 一轮时长，和参考 GIF 的 55 帧 × 30ms 对齐
const CHIPS_TWO_SECOND_START_MS = 1350;  // 第二片开始时刻，缩短两片之间的停顿
const CHIPS_CYCLE_START_MS = 0;
const PART_HANDS = 'shou';         // 模型里两只手所属的部件 id
const CHIPS_BAG_W = 850;           // 袋子图片宽度（画布像素）
const CHIPS_HAND_W = 369;          // 手部素材宽度 = 模型原爪 1:1（原生分辨率提取）
const CHIPS_CHIP_W = 200;          // 单片薯片宽度
const CHIPS_BAG_ANCHOR = [10, 0];  // 袋子中心相对两只模型手的中点
const CHIPS_BAG_ROT = -2;
const CHIPS_LEFT_HAND_OFFSET = [-220, -120];  // 左手在袋口左侧
const CHIPS_RIGHT_HAND_OFFSET = [220, 115];   // 右手扶在袋子右下角
const CHIPS_CHIP_FROM_BAG = [-44, -136];      // 薯片从袋口出现时的位置
// 一轮内的关键帧（t = 0~1 的比例；手部位移单位 = 画布像素，y 向下为正）。
// 数据按 GIF 55 帧逐帧测得：左手只做小幅提放，单片薯片独立沿弧线送到嘴边。
const CHIPS_KEY = [
  { t: 0.00, handX: 0,  handY: 0,    handRot: 0,  chip: 0, chipX: 0,   chipY: 0,    chipRot: 0 },
  { t: 0.20, handX: 0,  handY: 0,    handRot: 0,  chip: 0, chipX: 0,   chipY: 0,    chipRot: 0 },
  { t: 0.24, handX: 12, handY: -15,  handRot: -2, chip: 0, chipX: 0,   chipY: 0,    chipRot: 0 },
  { t: 0.30, handX: 28, handY: -56,  handRot: -4, chip: 1, chipX: -23, chipY: -75,  chipRot: -3 },
  { t: 0.36, handX: 34, handY: -90,  handRot: -6, chip: 1, chipX: -34, chipY: -160, chipRot: -5 },
  { t: 0.41, handX: 36, handY: -103, handRot: -7, chip: 1, chipX: -39, chipY: -196, chipRot: -5 },
  { t: 0.45, handX: 40, handY: -96,  handRot: -6, chip: 1, chipX: -40, chipY: -198, chipRot: -4 },
  { t: 0.51, handX: 35, handY: -65,  handRot: -4, chip: 0, chipX: -37, chipY: -172, chipRot: -3 },
  { t: 0.60, handX: 17, handY: -28,  handRot: -2, chip: 0, chipX: 0,   chipY: 0,    chipRot: 0 },
  { t: 0.70, handX: 2,  handY: -7,   handRot: 0,  chip: 0, chipX: 0,   chipY: 0,    chipRot: 0 },
  { t: 1.00, handX: 0,  handY: 0,    handRot: 0,  chip: 0, chipX: 0,   chipY: 0,    chipRot: 0 },
];

// 「Hello」：用模型原爪贴图挥手，另一只手保持模型原本的位置；文字素材独立叠在左上方。
const HELLO_ACTION = 'hello';
const HELLO_MOTION_MS = 1530;        // 3 轮挥手，每轮 510ms
const HELLO_RESTORE_MS = 300;        // 收尾时让外置原爪和模型手平滑交接
const HELLO_PROP_MS = HELLO_MOTION_MS + HELLO_RESTORE_MS;
const HELLO_CYCLE_MS = 510;
const HELLO_TEXT_W = 760;            // 文字图片宽度（画布像素）
const HELLO_TEXT_ANCHOR = [-450, -920];
const HELLO_TEXT_ROT = -3;
const HELLO_HAND_ANCHOR = [0, -540]; // 挥手原爪整体上移
// 17 帧挥手位置：相对模型原爪中心的画布像素偏移，数据来自 Hello.gif 的黄色手部轨迹。
const HELLO_WAVE_KEYS = [
  [0, 0], [67, 67], [79, 141], [5, 171], [-120, 162], [-248, 155], [-274, 157],
  [-280, 139], [-176, 106], [-43, 97], [56, 125], [71, 150], [13, 134],
  [-82, 85], [-167, 33], [-200, -3], [-162, -30],
];

// 「流口水」：小猪贴纸挂在额头，最后阶段从嘴下伸出口水。
const DROOL_ACTION = 'drool';
const DROOL_STICKER_W = 600;
const DROOL_STICKER_ANCHOR = [0, -500];
const DROOL_NOD_PERIOD_MS = 510;
const DROOL_NOD_Y = 90;
const DROOL_W = 54;
const DROOL_ANCHOR = [0, 20];
const DROOL_START_MS = 1620;
const DROOL_FULL_MS = 2220;
const DROOL_HOLD_MS = 300;
const DROOL_PROP_MS = DROOL_FULL_MS + DROOL_HOLD_MS;

// 「问号」：半睁眼疑惑，头顶和两侧依次冒出问号。
const QUESTION_ACTION = 'question';
const QUESTION_PROP_MS = 1800;       // 耳朵抖动1 + 问号逐个弹出，末尾延长 150ms
const QUESTION_W = 300;
const QUESTION_PARTICLES = [
  { id: 'question-0', delay: 600,  from: [-520, -620], to: [-560, -760], rot: -8 },
  { id: 'question-3', delay: 800,  from: [560, -560],  to: [620, -700],  rot: 9 },
  { id: 'question-4', delay: 1000, from: [-40, -790],  to: [-60, -920],  rot: -5 },
  { id: 'question-5', delay: 1200, from: [300, -380],  to: [340, -500],  rot: 6 },
];

// 「灵光一闪」：手部保持思考姿势，眼睛左右寻找，灯泡短暂出现。
const IDEA_ACTION = 'idea';
const IDEA_MOTION_MS = 1500;         // 手势来回 + 灯泡
const IDEA_RESTORE_MS = 250;         // 收尾恢复模型原手
const IDEA_PROP_MS = IDEA_MOTION_MS + IDEA_RESTORE_MS;
const IDEA_HAND_W = 350;
const IDEA_HAND_Y = 300;
const IDEA_HAND_LEFT_X = -380;
const IDEA_HAND_RIGHT_X = -140;
const IDEA_HAND_MOVE_MS = 800;
const IDEA_BULB_W = 320;
const IDEA_BULB_ANCHOR = [-560, -500];
const IDEA_BULB_IN_START_MS = 800;
const IDEA_BULB_FULL_MS = 1120;
const IDEA_BULB_OUT_START_MS = 1350;
const IDEA_BULB_END_MS = 1500;

// 「思考中」：思考手势保持在嘴下，额头加载图标持续旋转，眼睛左右寻找。
const THINKING_ACTION = 'thinking';
const THINKING_PROP_MS = 1800;       // 两轮手势后收尾（每轮 700ms）
const THINKING_HAND_W = IDEA_HAND_W;
const THINKING_HAND_Y = IDEA_HAND_Y;
const THINKING_HAND_CYCLE_MS = 700;
const THINKING_HAND_CYCLES = 2;
const THINKING_HAND_MOVE_MS = THINKING_HAND_CYCLE_MS * THINKING_HAND_CYCLES;
const THINKING_LOADING_W = 750;
const THINKING_LOADING_ANCHOR = [0, -450];
const THINKING_DROOL_W = 40;

// 「抱小猪」：小猪身体和小猪两侧的贴图手都是外部 PNG，位置由模型手部顶点算出来。
// 参考 GIF 17 帧 × 30ms 循环：小猪和头部轻轻上下蹭，左右前爪交替抬起/放下，形成抱住摇晃的感觉。
const PIG_ACTION = 'hold_pig';
const PIG_PROP_MS = 2040;         // 2.04s = 4 轮 GIF 循环，每轮 0.51s
const PIG_FADE_MS = 360;          // 开场/收尾淡入淡出
const PIG_CYCLE_MS = 510;         // 一轮时长，和参考 GIF 的 17 帧 × 30ms 对齐
const PIG_W = 620;                // 小猪图片宽度（画布像素）
const PIG_HAND_W = 369;           // 抱猪时贴图手的宽度 = 模型原爪 1:1
const PIG_PAW_SEP = 820;          // 两只贴图手中心的距离
const PIG_PAW_Y = 0;             // 贴图手中心在基准手部中心下方一点
const PIG_BASE_X = -220;                // 抱猪整体相对身体中心略微左移，贴近参考图
const PIG_ENTER_DROP = 120;        // 进入时小猪先位于手部中点下方一点，再抬到抱持位置
const PIG_CENTER_OFFSET = [18, -70]; // 小猪中心相对两只手中点的偏移
const PIG_MOTION_SCALE = 2.92;  // 把 GIF 的手部像素位移换算到 DaiMeow 画布单位
const PIG_ROT_GAIN = 0.65;        // 小猪整体倾斜跟随两只手的连线
// 17 帧的手部相对位置：[左手 x, 左手 y, 右手 x, 右手 y]；数据来自 GIF 逐帧测量
const PIG_PAW_KEYS = [
  [0, 0, 0, 0],
  [2.4, 10.6, -1.5, -13.2],
  [7.9, 13.4, -6.0, -28.8],
  [14.9, 17.1, -11.0, -44.1],
  [20.6, 18.9, -15.1, -55.1],
  [21.5, 17.7, -15.1, -57.2],
  [20.9, 13.7, -12.7, -51.2],
  [18.3, 10.6, -8.6, -39.4],
  [15.6, -1.5, -5.4, -25.7],
  [14.8, -13.6, -4.2, -12.7],
  [17.8, -26.7, -7.8, 1.6],
  [22.4, -40.8, -12.3, 7.9],
  [26.9, -51.8, -17.4, 14.5],
  [28.6, -56.4, -20.4, 19.4],
  [25.2, -51.8, -19.0, 19.9],
  [18.4, -39.9, -13.5, 15.9],
  [9.5, -24.3, -7.6, 11.0],
];


// 「玩游戏」：手柄和两只手都是外部 PNG；模型只做呼吸和轻微摆动，眼珠不跟随摇动。
const GAMEPAD_ACTION = 'play_game';
const GAMEPAD_PROP_MS = 2340;      // 3 轮，每轮 780ms
const GAMEPAD_FADE_MS = 300;
const GAMEPAD_CYCLE_MS = 780;      // 参考 GIF 的 26 帧 × 30ms
const GAMEPAD_W = 651;             // 手柄图片宽度（画布像素）
const GAMEPAD_HAND_W = 369;        // 与模型原手 1:1
const GAMEPAD_PAW_SEP = 700;       // 两只手中心距离
const GAMEPAD_PAW_Y = 0;
const GAMEPAD_CENTER_OFFSET = [0, -20];
const GAMEPAD_ENTER_DROP = 110;

const propLeft=image('pompom_yellow.png'), propRight=image('pompom_pink.png'), propHello=image('hello.png');
const propQuestions=QUESTION_PARTICLES.map(p=>({...p,el:image('question.png')}));
const propIdeaHand=image('idea_hand.png'), propLightbulb=image('lightbulb.png'), propThinkingHand=image('idea_hand.png'), propThinkingLoading=image('thinking_loading.gif');
const propPigSticker=image('pig_sticker.png'), propDrool=image('drool.png'), propChips=image('chips.png'), propPig=image('pig.png'), propGamepad=image('gamepad.png');
const propChip=image('chip.png'), propHandLeft=image('hand_left.png'), propHandRight=image('hand_right.png');
let propUntil=0, helloStartAt=0, droolStartAt=0, questionStartAt=0, ideaStartAt=0, thinkingStartAt=0, chipsStartAt=0, chipsCycles=0, pigStartAt=0, gamepadStartAt=0;
function chipsPlaybackMs() {
  if (chipsCycles === 2) return CHIPS_TWO_SECOND_START_MS + CHIPS_CYCLE_MS;
  return CHIPS_CYCLE_MS;
}

// 特殊道具动作的生命周期注册表：start 时点亮，stop 时清理，活动状态统一维护。
let activePropAction = null;

function createChipsPropHandler(cycles) {
  return {
    start(now) { chipsCycles = cycles; chipsStartAt = now; },
    stop() { chipsStartAt = 0; chipsCycles = 0; },
    isFinished(now) { return now - chipsStartAt >= chipsPlaybackMs(); },
    handsOpacity(now) { return handsOpacityAt(now - chipsStartAt); },
  };
}

const ACTION_PROP_HANDLERS = {
  [CHEER_ACTION]: {
    start(now) { propUntil = now + CHEER_PROP_MS; },
    stop() { propUntil = 0; },
    isFinished(now) { return !propUntil || now >= propUntil; },
  },
  [HELLO_ACTION]: {
    start(now) { helloStartAt = now; },
    stop() { helloStartAt = 0; },
    isFinished(now, startedAt) { return now - startedAt >= HELLO_PROP_MS; },
    handsOpacity(now, startedAt) { return helloHandsOpacityAt(now - startedAt); },
  },
  [DROOL_ACTION]: {
    start(now) { droolStartAt = now; },
    stop() { droolStartAt = 0; },
    isFinished(now, startedAt) { return now - startedAt >= DROOL_PROP_MS; },
  },
  [QUESTION_ACTION]: {
    start(now) { questionStartAt = now; },
    stop() { questionStartAt = 0; },
    isFinished(now, startedAt) { return now - startedAt >= QUESTION_PROP_MS; },
  },
  [IDEA_ACTION]: {
    start(now) { ideaStartAt = now; },
    stop() { ideaStartAt = 0; },
    isFinished(now, startedAt) { return now - startedAt >= IDEA_PROP_MS; },
    handsOpacity(now, startedAt) { return ideaHandsOpacityAt(now - startedAt); },
  },
  [THINKING_ACTION]: {
    start(now) { thinkingStartAt = now; },
    stop() { thinkingStartAt = 0; },
    isFinished(now, startedAt) { return now - startedAt >= THINKING_PROP_MS; },
    handsOpacity() { return 0; },
  },
  [CHIPS_ACTION]: createChipsPropHandler(1),
  [CHIPS_TWO_ACTION]: createChipsPropHandler(2),
  [PIG_ACTION]: {
    start(now) { pigStartAt = now; },
    stop() { pigStartAt = 0; },
    isFinished(now, startedAt) { return now - startedAt >= PIG_PROP_MS; },
    handsOpacity(now, startedAt) { return pigHandsOpacityAt(now - startedAt); },
  },
  [GAMEPAD_ACTION]: {
    start(now) { gamepadStartAt = now; },
    stop() { gamepadStartAt = 0; },
    isFinished(now, startedAt) { return now - startedAt >= GAMEPAD_PROP_MS; },
    handsOpacity(now, startedAt) { return gamepadHandsOpacityAt(now - startedAt); },
  },
};

function stopActivePropAction() {
  if (!activePropAction) return;
  if (activePropAction.handler.stop) activePropAction.handler.stop();
  activePropAction = null;
}

function startActivePropAction(name, now) {
  stopActivePropAction();
  const handler = ACTION_PROP_HANDLERS[name];
  if (!handler) return;
  activePropAction = { id: name, startedAt: now, handler };
  handler.start(now, name);
}

function refreshActivePropAction(now) {
  if (!activePropAction) return null;
  if (activePropAction.handler.isFinished(now, activePropAction.startedAt)) {
    stopActivePropAction();
    return null;
  }
  return activePropAction;
}

function resolvePawDrawables() {
  try {
    const internal = live2dModel.internalModel;
    const core = internal.coreModel.getModel();
    const partIds = [];
    for (let i = 0; i < core.parts.count; i++) partIds.push(core.parts.ids[i]);
    const handPart = partIds.indexOf('shou');
    let idx = [];
    if (handPart >= 0) {
      for (let i = 0; i < core.drawables.count; i++) {
        if (core.drawables.parentPartIndices[i] === handPart) idx.push(i);
      }
    }
    if (idx.length !== 2) {
      // 兜底：按这个模型当前的名字找
      idx = ['ArtMesh', 'ArtMesh2'].map((id) => core.drawables.ids.indexOf(id)).filter((i) => i >= 0);
    }
    if (idx.length !== 2) return null;
    const centers = idx.map((i) => {
      const v = internal.getDrawableVertices(i);
      let x = 0;
      for (let k = 0; k < v.length; k += 2) x += v[k];
      return x / (v.length / 2);
    });
    return centers[0] <= centers[1] ? idx : [idx[1], idx[0]];
  } catch (err) {
    petAPI.logError('找不到手部 drawable: ' + err.message);
    return null;
  }
}

/**
 * 两只手在窗口里的中心点：[[左手 x, y], [右手 x, y]]。
 * 顶点用引擎给的 getDrawableVertices（画布像素），再用 PIXI 的 toGlobal 换成窗口像素：
 * 缩放、位置、锚点都由 PIXI 算，模型怎么缩放/移动，道具都跟着手走。
 */
function pawCentersOnScreen() {
  try {
    const internal = live2dModel.internalModel;
    return pawDrawables.map((d) => {
      const v = internal.getDrawableVertices(d);
      let sx = 0, sy = 0;
      for (let k = 0; k < v.length; k += 2) {
        sx += v[k];
        sy += v[k + 1];
      }
      const n = v.length / 2;
      propSrcPoint.set(sx / n, sy / n);
      live2dModel.toGlobal(propSrcPoint, propDstPoint);
      return [propDstPoint.x, propDstPoint.y];
    });
  } catch (err) {
    return null;
  }
}

/* ---------------- 吃薯片：姿势求值 + 藏手 ---------------- */

/**
 * 吃薯片这一帧的姿势。每个动作周期对应 GIF 的一轮，
 * 一轮结束后回到中性姿势再收尾。
 * 关键帧之间用 Catmull-Rom 样条插值（位移连续、没有折角），时间比例用 easeInOutSine 控制快慢。
 */
function eatChipsPose(now) {
  const neutral = {
    handX: 0, handY: 0, handRot: 0,
    chip: 0, chipX: 0, chipY: 0, chipRot: 0,
  };
  const elapsed = now - chipsStartAt;
  if (!chipsStartAt || elapsed < 0 || elapsed >= chipsPlaybackMs()) return neutral;
  const cycleElapsed = chipsCycles === 2 && elapsed >= CHIPS_TWO_SECOND_START_MS
    ? elapsed - CHIPS_TWO_SECOND_START_MS
    : elapsed - CHIPS_CYCLE_START_MS;
  const u = cycleElapsed / CHIPS_CYCLE_MS;
  const keys = CHIPS_KEY;
  let a = keys[0], b = keys[keys.length - 1];
  for (let i = 1; i < keys.length; i++) {
    if (u <= keys[i].t) { a = keys[i - 1]; b = keys[i]; break; }
  }
  const span = b.t - a.t;
  const k = span <= 0 ? 1 : (u - a.t) / span;
  const e = -(Math.cos(Math.PI * k) - 1) / 2;
  const i2 = keys.indexOf(b);
  const p0 = keys[Math.max(0, i2 - 2)], p1 = a, p2 = b, p3 = keys[Math.min(keys.length - 1, i2 + 1)];
  const cr = (v0, v1, v2, v3) => 0.5 * ((2 * v1) + (-v0 + v2) * e
    + (2 * v0 - 5 * v1 + 4 * v2 - v3) * e * e
    + (-v0 + 3 * v1 - 3 * v2 + v3) * e * e * e);
  return {
    handX: cr(p0.handX, p1.handX, p2.handX, p3.handX),
    handY: cr(p0.handY, p1.handY, p2.handY, p3.handY),
    handRot: cr(p0.handRot, p1.handRot, p2.handRot, p3.handRot),
    chip: p1.chip + (p2.chip - p1.chip) * e,   // 薯片透明度：平滑淡入淡出
    chipX: cr(p0.chipX, p1.chipX, p2.chipX, p3.chipX),
    chipY: cr(p0.chipY, p1.chipY, p2.chipY, p3.chipY),
    chipRot: cr(p0.chipRot, p1.chipRot, p2.chipRot, p3.chipRot),
  };
}

/** Hello 的 17 帧挥手轨迹，使用周期 Catmull-Rom 插值保证循环处平顺。 */
function sampleHelloWave(u) {
  const keys = HELLO_WAVE_KEYS;
  const n = keys.length;
  const pos = (((u % 1) + 1) % 1) * n;
  const i = Math.floor(pos);
  const f = pos - i;
  const k0 = keys[(i - 1 + n) % n];
  const k1 = keys[i % n];
  const k2 = keys[(i + 1) % n];
  const k3 = keys[(i + 2) % n];
  const e = f * f * (3 - 2 * f);
  const cr = (v0, v1, v2, v3) => 0.5 * ((2 * v1) + (-v0 + v2) * e
    + (2 * v0 - 5 * v1 + 4 * v2 - v3) * e * e
    + (-v0 + 3 * v1 - 3 * v2 + v3) * e * e * e);
  return [0, 1].map((j) => cr(k0[j], k1[j], k2[j], k3[j]));
}

/** Hello 这一帧的挥手与文字浮动。 */
function helloPose(now) {
  const neutral = { handX: 0, handY: 0, handRot: 0, textY: 0, textRot: HELLO_TEXT_ROT };
  if (!helloStartAt) return neutral;
  const elapsed = now - helloStartAt;
  if (elapsed < 0 || elapsed >= HELLO_MOTION_MS) return neutral;
  const u = (elapsed % HELLO_CYCLE_MS) / HELLO_CYCLE_MS;
  const wave = sampleHelloWave(u);
  const phase = 2 * Math.PI * u;
  return {
    handX: wave[0],
    handY: wave[1],
    handRot: -4 * Math.sin(phase),
    textY: -10 * Math.sin(phase),
    textRot: HELLO_TEXT_ROT + 2 * Math.sin(phase),
  };
}

/** Hello 收尾时的交接进度：0 = 外置原爪，1 = 模型自带手。 */
function helloRestoreProgress(elapsed) {
  if (elapsed <= HELLO_MOTION_MS) return 0;
  if (elapsed >= HELLO_PROP_MS) return 1;
  const t = (elapsed - HELLO_MOTION_MS) / HELLO_RESTORE_MS;
  return t * t * (3 - 2 * t);
}

/** Hello 期间模型自带手的不透明度；只在收尾阶段平滑恢复。 */
function helloHandsOpacityAt(elapsed) {
  if (elapsed <= 0 || elapsed >= HELLO_PROP_MS) return 1;
  return helloRestoreProgress(elapsed);
}

/** 问号贴纸的逐个出现、上浮和轻微旋转。 */
function questionParticlePose(particle, elapsed) {
  const age = elapsed - particle.delay;
  if (age < 0) return null;
  const enter = Math.min(1, age / 180);
  const move = Math.min(1, age / 480);
  const ease = 1 - Math.pow(1 - move, 3);
  return {
    x: particle.from[0] + (particle.to[0] - particle.from[0]) * ease,
    y: particle.from[1] + (particle.to[1] - particle.from[1]) * ease,
    scale: 0.28 + 0.72 * (enter * enter * (3 - 2 * enter)),
    opacity: enter,
    rot: particle.rot * ease,
  };
}

/** 思考手在下巴位置完成一次左→右→左往返。 */
function ideaHandX(elapsed) {
  const t = Math.max(0, Math.min(1, elapsed / IDEA_HAND_MOVE_MS));
  const half = t < 0.5 ? t * 2 : (1 - t) * 2;
  const e = half * half * (3 - 2 * half);
  return IDEA_HAND_LEFT_X + (IDEA_HAND_RIGHT_X - IDEA_HAND_LEFT_X) * e;
}

/** 思考中手势的两轮横向往返，每轮 700ms。 */
function thinkingHandX(elapsed) {
  if (elapsed >= THINKING_HAND_MOVE_MS) return IDEA_HAND_LEFT_X;
  const cycleT = (elapsed % THINKING_HAND_CYCLE_MS) / THINKING_HAND_CYCLE_MS;
  const half = cycleT < 0.5 ? cycleT * 2 : (1 - cycleT) * 2;
  const e = half * half * (3 - 2 * half);
  return IDEA_HAND_LEFT_X + (IDEA_HAND_RIGHT_X - IDEA_HAND_LEFT_X) * e;
}

function ideaRestoreProgress(elapsed) {
  if (elapsed <= IDEA_MOTION_MS) return 0;
  if (elapsed >= IDEA_PROP_MS) return 1;
  const t = (elapsed - IDEA_MOTION_MS) / IDEA_RESTORE_MS;
  return t * t * (3 - 2 * t);
}

function ideaHandsOpacityAt(elapsed) {
  if (elapsed <= 0 || elapsed >= IDEA_PROP_MS) return 1;
  return ideaRestoreProgress(elapsed);
}

/** 从 17 帧循环数据中取一帧并做周期 Catmull-Rom 插值（抱小猪用）。 */
function samplePigLoop(u) {
  const keys = PIG_PAW_KEYS;
  const n = keys.length;
  const pos = (((u % 1) + 1) % 1) * n;
  const i = Math.floor(pos);
  const f = pos - i;
  const k0 = keys[(i - 1 + n) % n];
  const k1 = keys[i % n];
  const k2 = keys[(i + 1) % n];
  const k3 = keys[(i + 2) % n];
  const e = f * f * (3 - 2 * f);
  const cr = (v0, v1, v2, v3) => 0.5 * ((2 * v1) + (-v0 + v2) * e
    + (2 * v0 - 5 * v1 + 4 * v2 - v3) * e * e
    + (-v0 + 3 * v1 - 3 * v2 + v3) * e * e * e);
  return [0, 1, 2, 3].map((j) => cr(k0[j], k1[j], k2[j], k3[j]));
}

/** 抱小猪这一帧两只手的相对位移。 */
function pigPose(now) {
  const neutral = { lx: 0, ly: 0, rx: 0, ry: 0 };
  if (!pigStartAt) return neutral;
  const elapsed = now - pigStartAt;
  if (elapsed < 0 || elapsed >= PIG_PROP_MS) return neutral;
  const u = (elapsed % PIG_CYCLE_MS) / PIG_CYCLE_MS;
  const q = samplePigLoop(u).map((v) => v * PIG_MOTION_SCALE);
  return { lx: q[0], ly: q[1], rx: q[2], ry: q[3] };
}

/** 玩游戏时手柄和两只手的轻晃/按压轨迹：眼睛之外，手柄和手也会明显运动。 */
function gamepadPose(now) {
  const neutral = { px: 0, py: 0, rot: 0, scale: 1, lx: 0, ly: 0, rx: 0, ry: 0 };
  if (!gamepadStartAt) return neutral;
  const elapsed = now - gamepadStartAt;
  if (elapsed < 0 || elapsed >= GAMEPAD_PROP_MS) return neutral;
  const u = (elapsed % GAMEPAD_CYCLE_MS) / GAMEPAD_CYCLE_MS;
  const s = Math.sin(2 * Math.PI * u);
  const s2 = Math.sin(4 * Math.PI * u);
  const c2 = Math.cos(4 * Math.PI * u);
  const groupX = 55 * s + 8 * s2;
  const groupY = -34 * c2;
  return {
    px: groupX,
    py: groupY,
    rot: 6 * s,
    scale: 1 + 0.045 * c2,
    lx: groupX + 10 * s2,
    ly: groupY + 12 * s2,
    rx: groupX - 10 * s2,
    ry: groupY - 12 * s2,
  };
}

/** 抱小猪时贴图手在原位接管，模型自带手在动作期间保持隐藏。 */
function pigHandsOpacityAt(elapsed) {
  if (elapsed <= 0 || elapsed >= PIG_PROP_MS) return 1;
  // 贴图手与模型手同尺寸；进入时在原位接管，避免交叉淡化出现两双手重影。
  return 0;
}

/** 玩游戏中贴图手在模型手原位接管，模型自带手在动作期间隐藏。 */
function gamepadHandsOpacityAt(elapsed) {
  if (elapsed <= 0 || elapsed >= GAMEPAD_PROP_MS) return 1;
  return 0;
}

/** 模型自带的手的不透明度：开头淡出、收尾淡回（避免两只手同时出现或突然跳变） */
function handsOpacityAt(elapsed, totalMs = chipsPlaybackMs()) {
  if (elapsed <= 0 || elapsed >= totalMs) return 1;
  // 贴图手与模型原爪尺寸一致；进入时直接在原位置接管，避免交叉淡化出现两双手。
  return 0;
}

function ensurePropLoaded(el) {
  if (!el || el.dataset.loaded === '1') return;
  const src = el.dataset.src;
  if (!src) return;
  el.src = src;
  el.dataset.loaded = '1';
}

function setPropVisible(el, visible) {
  if (!el) return;
  if (visible) ensurePropLoaded(el);
  el.hidden = !visible;
  const cls = visible ? 'daimeow-prop show' : 'daimeow-prop';
  if (el.className !== cls) el.className = cls;
  if (!visible && el.style.opacity !== '') el.style.opacity = '';
}

/* ---------------- 逐帧道具渲染 ---------------- */

// 每个动作的渲染器只负责把已经调好的几何算到 DOM 上；updateProps 只负责选中当前
// 渲染器，不再把所有动作分支串在一个函数里。道具位置由引擎的 getDrawableVertices +
// toGlobal 换算成窗口像素，所以模型怎么缩放/移动，道具都跟着走。
function renderCheerProps(now, centers) {
    const size = PROP_CANVAS_SIZE * currentScale;
    for (let k = 0; k < 2; k++) {
      const el = k === 0 ? propLeft : propRight;
      el.style.left = centers[k][0] + 'px';
      el.style.top = centers[k][1] + 'px';
      el.style.width = size + 'px';
    }
}

function renderChipsProps(now, centers) {
    const pose = eatChipsPose(now);
    const mid = [
      (centers[0][0] + centers[1][0]) / 2,
      (centers[0][1] + centers[1][1]) / 2,
    ];
    const bagX = mid[0] + CHIPS_BAG_ANCHOR[0] * currentScale;
    const bagY = mid[1] + CHIPS_BAG_ANCHOR[1] * currentScale;
    const handW = CHIPS_HAND_W * currentScale;

    // 袋子固定在两只手的中点，不再跟着单只模型手摆动；这样头动时包装袋仍稳在胸前。
    propChips.style.left = bagX + 'px';
    propChips.style.top = bagY + 'px';
    propChips.style.width = (CHIPS_BAG_W * currentScale) + 'px';
    propChips.style.transform = 'translate(-50%, -50%) rotate(' + CHIPS_BAG_ROT + 'deg)';

    // 右手始终扶在袋子右下角，左手的起落幅度只对应 GIF 里的那一小段提手动作。
    propHandRight.style.left = (mid[0] + CHIPS_RIGHT_HAND_OFFSET[0] * currentScale) + 'px';
    propHandRight.style.top = (mid[1] + CHIPS_RIGHT_HAND_OFFSET[1] * currentScale) + 'px';
    propHandRight.style.width = handW + 'px';
    propHandRight.style.transform = 'translate(-50%, -50%) rotate(-3deg)';

    propHandLeft.style.left = (mid[0] + (CHIPS_LEFT_HAND_OFFSET[0] + pose.handX) * currentScale) + 'px';
    propHandLeft.style.top = (mid[1] + (CHIPS_LEFT_HAND_OFFSET[1] + pose.handY) * currentScale) + 'px';
    propHandLeft.style.width = handW + 'px';
    propHandLeft.style.transform = 'translate(-50%, -50%) rotate(' + pose.handRot + 'deg)';

    // 单片薯片独立从袋口沿弧线送到嘴边；透明度由关键帧平滑淡入淡出。
    propChip.style.opacity = String(Math.max(0, Math.min(1, pose.chip)));
    propChip.style.left = (bagX + (CHIPS_CHIP_FROM_BAG[0] + pose.chipX) * currentScale) + 'px';
    propChip.style.top = (bagY + (CHIPS_CHIP_FROM_BAG[1] + pose.chipY) * currentScale) + 'px';
    propChip.style.width = (CHIPS_CHIP_W * currentScale) + 'px';
    propChip.style.transform = 'translate(-50%, -50%) rotate(' + pose.chipRot + 'deg)';

}

function renderPigProps(now, centers) {
    const nowValue = now;
    const elapsed = nowValue - pigStartAt;
    const enterT = Math.max(0, Math.min(1, elapsed / PIG_FADE_MS));
    const enter = enterT * enterT * (3 - 2 * enterT);
    const exitT = Math.max(0, Math.min(1, (PIG_PROP_MS - elapsed) / PIG_FADE_MS));
    const exit = exitT * exitT * (3 - 2 * exitT);
    const opacity = enter * exit;
    const move = enter * exit;
    const pose = pigPose(nowValue);
    const handW = PIG_HAND_W * currentScale;
    const midX = (centers[0][0] + centers[1][0]) / 2 + PIG_BASE_X * currentScale;
    const midY = (centers[0][1] + centers[1][1]) / 2;
    const pawBaseY = midY + PIG_PAW_Y * currentScale;
    const targetLeftX = midX - PIG_PAW_SEP * 0.5 * currentScale + pose.lx * currentScale;
    const targetLeftY = pawBaseY + pose.ly * currentScale;
    const targetRightX = midX + PIG_PAW_SEP * 0.5 * currentScale + pose.rx * currentScale;
    const targetRightY = pawBaseY + pose.ry * currentScale;
    const baseAngle = Math.atan2(centers[1][1] - centers[0][1], centers[1][0] - centers[0][0]);
    const holdAngle = Math.atan2(targetRightY - targetLeftY, targetRightX - targetLeftX);
    const rot = ((holdAngle - baseAngle) * 180 / Math.PI * PIG_ROT_GAIN) * move;

    // 贴图手从模型手原位滑到抱持位；结束前再滑回原位，避免换手时突然跳变。
    const leftX = centers[0][0] + (targetLeftX - centers[0][0]) * move;
    const leftY = centers[0][1] + (targetLeftY - centers[0][1]) * move;
    const rightX = centers[1][0] + (targetRightX - centers[1][0]) * move;
    const rightY = centers[1][1] + (targetRightY - centers[1][1]) * move;
    const targetPigX = (targetLeftX + targetRightX) / 2 + PIG_CENTER_OFFSET[0] * currentScale;
    const targetPigY = (targetLeftY + targetRightY) / 2 + PIG_CENTER_OFFSET[1] * currentScale;
    const startPigX = (centers[0][0] + centers[1][0]) / 2 + PIG_CENTER_OFFSET[0] * currentScale;
    const startPigY = (centers[0][1] + centers[1][1]) / 2 + (PIG_CENTER_OFFSET[1] + PIG_ENTER_DROP) * currentScale;

    propPig.style.opacity = String(opacity);
    propPig.style.left = (startPigX + (targetPigX - startPigX) * move) + 'px';
    propPig.style.top = (startPigY + (targetPigY - startPigY) * move) + 'px';
    propPig.style.width = (PIG_W * currentScale * (0.86 + 0.14 * move)) + 'px';
    propPig.style.transform = 'translate(-50%, -50%) rotate(' + rot + 'deg)';

    propHandLeft.style.opacity = '1';
    propHandLeft.style.left = leftX + 'px';
    propHandLeft.style.top = leftY + 'px';
    propHandLeft.style.width = handW + 'px';
    propHandLeft.style.transform = 'translate(-50%, -50%) rotate(' + (rot * 0.35) + 'deg)';
    propHandRight.style.opacity = '1';
    propHandRight.style.left = rightX + 'px';
    propHandRight.style.top = rightY + 'px';
    propHandRight.style.width = handW + 'px';
    propHandRight.style.transform = 'translate(-50%, -50%) rotate(' + (-rot * 0.35) + 'deg)';

}

function renderGamepadProps(now, centers) {
    const pose = gamepadPose(now);
    const elapsed = now - gamepadStartAt;
    const enterT = Math.max(0, Math.min(1, elapsed / GAMEPAD_FADE_MS));
    const enter = enterT * enterT * (3 - 2 * enterT);
    const exitT = Math.max(0, Math.min(1, (GAMEPAD_PROP_MS - elapsed) / GAMEPAD_FADE_MS));
    const exit = exitT * exitT * (3 - 2 * exitT);
    const opacity = enter * exit;
    const move = enter * exit;
    const handW = GAMEPAD_HAND_W * currentScale;
    const midX = (centers[0][0] + centers[1][0]) / 2;
    const midY = (centers[0][1] + centers[1][1]) / 2;
    const pawY = midY + GAMEPAD_PAW_Y * currentScale;
    const targetLeftX = midX - GAMEPAD_PAW_SEP * 0.5 * currentScale + pose.lx * currentScale;
    const targetLeftY = pawY + pose.ly * currentScale;
    const targetRightX = midX + GAMEPAD_PAW_SEP * 0.5 * currentScale + pose.rx * currentScale;
    const targetRightY = pawY + pose.ry * currentScale;
    const leftX = centers[0][0] + (targetLeftX - centers[0][0]) * move;
    const leftY = centers[0][1] + (targetLeftY - centers[0][1]) * move;
    const rightX = centers[1][0] + (targetRightX - centers[1][0]) * move;
    const rightY = centers[1][1] + (targetRightY - centers[1][1]) * move;
    const targetPadX = (targetLeftX + targetRightX) / 2 + GAMEPAD_CENTER_OFFSET[0] * currentScale;
    const targetPadY = (targetLeftY + targetRightY) / 2 + GAMEPAD_CENTER_OFFSET[1] * currentScale;
    const startPadY = pawY + (GAMEPAD_CENTER_OFFSET[1] + GAMEPAD_ENTER_DROP) * currentScale;

    propGamepad.style.opacity = String(opacity);
    propGamepad.style.left = targetPadX + 'px';
    propGamepad.style.top = (startPadY + (targetPadY - startPadY) * move) + 'px';
    propGamepad.style.width = (GAMEPAD_W * currentScale * (0.9 + 0.1 * move) * pose.scale) + 'px';
    propGamepad.style.transform = 'translate(-50%, -50%) rotate(' + (pose.rot * move) + 'deg)';
    propHandLeft.style.opacity = '1';
    propHandLeft.style.left = leftX + 'px';
    propHandLeft.style.top = leftY + 'px';
    propHandLeft.style.width = handW + 'px';
    propHandLeft.style.transform = 'translate(-50%, -50%) rotate(' + (pose.rot * move) + 'deg)';
    propHandRight.style.opacity = '1';
    propHandRight.style.left = rightX + 'px';
    propHandRight.style.top = rightY + 'px';
    propHandRight.style.width = handW + 'px';
    propHandRight.style.transform = 'translate(-50%, -50%) rotate(' + (pose.rot * move) + 'deg)';

}

function renderHelloProps(now, centers) {
    const pose = helloPose(now);
    const restore = helloRestoreProgress(now - helloStartAt);
    const handW = CHIPS_HAND_W * currentScale;
    const mid = [
      (centers[0][0] + centers[1][0]) / 2,
      (centers[0][1] + centers[1][1]) / 2,
    ];

    // 左手做动图里的左右挥手，右手保持模型原本手位；两者都使用原爪贴图。
    propHandLeft.style.opacity = String(1 - restore);
    propHandLeft.style.left = (centers[0][0] + pose.handX * currentScale) + 'px';
    const handY = HELLO_HAND_ANCHOR[1] * (1 - restore) + pose.handY;
    propHandLeft.style.top = (centers[0][1] + handY * currentScale) + 'px';
    propHandLeft.style.width = handW + 'px';
    propHandLeft.style.transform = 'translate(-50%, -50%) rotate(' + pose.handRot + 'deg)';
    propHandRight.style.opacity = String(1 - restore);
    propHandRight.style.left = centers[1][0] + 'px';
    propHandRight.style.top = centers[1][1] + 'px';
    propHandRight.style.width = handW + 'px';
    propHandRight.style.transform = 'translate(-50%, -50%)';

    propHello.style.left = (mid[0] + HELLO_TEXT_ANCHOR[0] * currentScale) + 'px';
    propHello.style.top = (mid[1] + (HELLO_TEXT_ANCHOR[1] + pose.textY) * currentScale) + 'px';
    propHello.style.width = (HELLO_TEXT_W * currentScale) + 'px';
    propHello.style.transform = 'translate(-50%, -50%) rotate(' + pose.textRot + 'deg)';
    propHello.style.opacity = String(1 - restore);

}

function renderDroolProps(now, centers) {
    const elapsed = now - droolStartAt;
    const nodT = elapsed < DROOL_START_MS
      ? 0.5 - 0.5 * Math.cos(2 * Math.PI * elapsed / DROOL_NOD_PERIOD_MS)
      : 0;
    const bobY = DROOL_NOD_Y * nodT;

    propPigSticker.style.left = (currentCX + DROOL_STICKER_ANCHOR[0] * currentScale) + 'px';
    propPigSticker.style.top = (currentCY + (DROOL_STICKER_ANCHOR[1] + bobY) * currentScale) + 'px';
    propPigSticker.style.width = (DROOL_STICKER_W * currentScale) + 'px';
    propPigSticker.style.transform = 'translate(-50%, -50%)';

    let dropT = Math.max(0, Math.min(1, (elapsed - DROOL_START_MS) / (DROOL_FULL_MS - DROOL_START_MS)));
    dropT = dropT * dropT * (3 - 2 * dropT);
    propDrool.style.left = (currentCX + DROOL_ANCHOR[0] * currentScale) + 'px';
    propDrool.style.top = (currentCY + DROOL_ANCHOR[1] * currentScale) + 'px';
    propDrool.style.width = (DROOL_W * currentScale) + 'px';
    propDrool.style.transformOrigin = 'top center';
    propDrool.style.transform = 'translate(-50%, 0) scaleY(' + (0.12 + 0.88 * dropT) + ')';
    propDrool.style.opacity = String(dropT);

}

function renderQuestionProps(now, centers) {
    const elapsed = now - questionStartAt;
    for (const particle of propQuestions) {
      const pose = questionParticlePose(particle, elapsed);
      if (!pose || !particle.el) continue;
      particle.el.style.left = (currentCX + pose.x * currentScale) + 'px';
      particle.el.style.top = (currentCY + pose.y * currentScale) + 'px';
      particle.el.style.width = (QUESTION_W * currentScale * pose.scale) + 'px';
      particle.el.style.transform = 'translate(-50%, -50%) rotate(' + pose.rot + 'deg)';
      particle.el.style.opacity = String(pose.opacity);
    }

}

function renderIdeaProps(now, centers) {
    const elapsed = now - ideaStartAt;
    const restore = ideaRestoreProgress(elapsed);
    const handXModel = ideaHandX(elapsed);
    const handX = (currentCX + handXModel * currentScale) * (1 - restore) + centers[0][0] * restore;
    const handY = (currentCY + IDEA_HAND_Y * currentScale) * (1 - restore) + centers[0][1] * restore;
    propIdeaHand.style.opacity = String(1 - restore);
    propIdeaHand.style.left = handX + 'px';
    propIdeaHand.style.top = handY + 'px';
    propIdeaHand.style.width = (IDEA_HAND_W * currentScale) + 'px';
    propIdeaHand.style.transform = 'translate(-50%, -50%) rotate(10deg)';
    propHandLeft.style.opacity = '0';
    propHandRight.style.opacity = String(1 - restore);
    propHandRight.style.left = centers[1][0] + 'px';
    propHandRight.style.top = centers[1][1] + 'px';
    propHandRight.style.width = (CHIPS_HAND_W * currentScale) + 'px';
    propHandRight.style.transform = 'translate(-50%, -50%)';

    let bulbT = 0;
    if (elapsed < IDEA_BULB_FULL_MS) {
      const t = Math.max(0, Math.min(1, (elapsed - IDEA_BULB_IN_START_MS) / (IDEA_BULB_FULL_MS - IDEA_BULB_IN_START_MS)));
      bulbT = t * t * (3 - 2 * t);
    } else if (elapsed < IDEA_BULB_OUT_START_MS) {
      bulbT = 1;
    } else {
      const t = Math.max(0, Math.min(1, (elapsed - IDEA_BULB_OUT_START_MS) / (IDEA_BULB_END_MS - IDEA_BULB_OUT_START_MS)));
      bulbT = 1 - t * t * (3 - 2 * t);
    }
    propLightbulb.style.left = (currentCX + IDEA_BULB_ANCHOR[0] * currentScale) + 'px';
    propLightbulb.style.top = (currentCY + IDEA_BULB_ANCHOR[1] * currentScale) + 'px';
    propLightbulb.style.width = (IDEA_BULB_W * currentScale * (0.28 + 0.72 * bulbT)) + 'px';
    propLightbulb.style.transform = 'translate(-50%, -50%) rotate(-30deg)';
    propLightbulb.style.opacity = String(bulbT * (1 - restore));

}

function renderThinkingProps(now, centers) {
    // 思考手势复用「灵光一闪」的横向往返，模型原手由同尺寸贴图接管。
    // 每个 renderer 自行声明 elapsed；漏掉会在 ticker 回调里抛错，
    // 异常一旦从 ticker 回调里冒出去，PIXI 的渲染循环就不会再排下一帧，
    // 表现是「模型卡住不动、但其他功能都正常」，只能重启恢复。
    const elapsed = now - thinkingStartAt;
    const handXModel = thinkingHandX(elapsed);
    propThinkingHand.style.opacity = '1';
    propThinkingHand.style.left = (currentCX + handXModel * currentScale) + 'px';
    propThinkingHand.style.top = (currentCY + THINKING_HAND_Y * currentScale) + 'px';
    propThinkingHand.style.width = (THINKING_HAND_W * currentScale) + 'px';
    propThinkingHand.style.transform = 'translate(-50%, -50%) rotate(10deg)';
    propHandLeft.style.opacity = '0';
    propHandRight.style.opacity = '1';
    propHandRight.style.left = centers[1][0] + 'px';
    propHandRight.style.top = centers[1][1] + 'px';
    propHandRight.style.width = (CHIPS_HAND_W * currentScale) + 'px';
    propHandRight.style.transform = 'translate(-50%, -50%)';

    propThinkingLoading.style.left = (currentCX + THINKING_LOADING_ANCHOR[0] * currentScale) + 'px';
    propThinkingLoading.style.top = (currentCY + THINKING_LOADING_ANCHOR[1] * currentScale) + 'px';
    propThinkingLoading.style.width = (THINKING_LOADING_W * currentScale) + 'px';
    propThinkingLoading.style.transform = 'translate(-50%, -50%)';

    propDrool.style.left = (currentCX + DROOL_ANCHOR[0] * currentScale) + 'px';
    propDrool.style.top = (currentCY + DROOL_ANCHOR[1] * currentScale) + 'px';
    propDrool.style.width = (THINKING_DROOL_W * currentScale) + 'px';
    propDrool.style.transformOrigin = 'top center';
    propDrool.style.transform = 'translate(-50%, 0) scaleY(1)';
    propDrool.style.opacity = '1';
}

const PROP_RENDERERS = {
  [CHEER_ACTION]: renderCheerProps,
  [CHIPS_ACTION]: renderChipsProps,
  [CHIPS_TWO_ACTION]: renderChipsProps,
  [PIG_ACTION]: renderPigProps,
  [GAMEPAD_ACTION]: renderGamepadProps,
  [HELLO_ACTION]: renderHelloProps,
  [DROOL_ACTION]: renderDroolProps,
  [QUESTION_ACTION]: renderQuestionProps,
  [IDEA_ACTION]: renderIdeaProps,
  [THINKING_ACTION]: renderThinkingProps,
};

function updateProps(now) {
  if (!pawDrawables) return;
  const active = refreshActivePropAction(now);
  const activeId = active ? active.id : null;
  const ballsVisible = activeId === CHEER_ACTION && !!(propLeft && propRight);
  const helloVisible = activeId === HELLO_ACTION && !!propHello;
  const droolVisible = activeId === DROOL_ACTION;
  const questionVisible = activeId === QUESTION_ACTION;
  const ideaVisible = activeId === IDEA_ACTION;
  const thinkingVisible = activeId === THINKING_ACTION;
  const chipsVisible = (activeId === CHIPS_ACTION || activeId === CHIPS_TWO_ACTION) && !!propChips;
  const pigVisible = activeId === PIG_ACTION && !!propPig;
  const gamepadVisible = activeId === GAMEPAD_ACTION && !!propGamepad;
  setPropVisible(propLeft, ballsVisible);
  setPropVisible(propRight, ballsVisible);
  setPropVisible(propHello, helloVisible);
  setPropVisible(propPigSticker, droolVisible);
  setPropVisible(propDrool, droolVisible || thinkingVisible);
  setPropVisible(propIdeaHand, ideaVisible);
  setPropVisible(propLightbulb, ideaVisible);
  setPropVisible(propThinkingHand, thinkingVisible);
  setPropVisible(propThinkingLoading, thinkingVisible);
  for (const particle of propQuestions) {
    const pose = questionVisible ? questionParticlePose(particle, now - questionStartAt) : null;
    setPropVisible(particle.el, !!pose);
  }
  setPropVisible(propChips, chipsVisible);
  setPropVisible(propChip, chipsVisible);
  setPropVisible(propPig, pigVisible);
  setPropVisible(propGamepad, gamepadVisible);
  const handsVisible = ideaVisible || thinkingVisible || helloVisible || chipsVisible || pigVisible || gamepadVisible;
  setPropVisible(propHandLeft, handsVisible);
  setPropVisible(propHandRight, handsVisible);

  if (!ballsVisible && !handsVisible && !droolVisible && !questionVisible && !ideaVisible && !thinkingVisible) return;

  const centers = pawCentersOnScreen();
  if (!centers) return;

  const renderer = PROP_RENDERERS[activeId];
  if (renderer) renderer(now, centers);

}


function setHandsOpacity(value) {
  if (!live2dModel || !pawDrawables) return;
  renderedHandsOpacity = value;
  try { live2dModel.internalModel.coreModel.setPartOpacityById(PART_HANDS,value); } catch {}
}
const mix = (from, to, amount) => from + (to - from) * amount;
function handoffProgress(at) {
  if (!handoff) return 1;
  const t = Math.max(0, Math.min(1, (at - handoff.startedAt) / HANDOFF_MS));
  return t * t * (3 - 2 * t);
}
function handIndex(el) {
  if (el === propIdeaHand || el === propThinkingHand || el === propHandLeft) return 0;
  return el === propHandRight ? 1 : -1;
}
function propSnapshot(el) {
  if (el.hidden) return null;
  const opacity = el.style.opacity === '' || el.style.opacity === undefined ? 1 : Number(el.style.opacity);
  const left = parseFloat(el.style.left), top = parseFloat(el.style.top), width = parseFloat(el.style.width);
  if (!opacity || ![left, top, width].every(Number.isFinite) || !(currentScale > 0)) return null;
  return { left: (left - currentCX) / currentScale, top: (top - currentCY) / currentScale, width: width / currentScale,
    opacity, transform: el.style.transform, transformOrigin: el.style.transformOrigin,
    rotation: Number(/rotate\(([-\d.]+)deg\)/.exec(el.style.transform || '')?.[1]) || 0 };
}
function captureProps() {
  const snapshots = new Map();
  for (const el of elements) { const value = propSnapshot(el); if (value) snapshots.set(el, value); }
  return snapshots;
}
function beginHandoff(name, startedAt, at) {
  // Preserve the last rendered frame, even when another interaction interrupts
  // an unfinished handoff. Coordinates stay in model units across window resize.
  handoff = { startedAt: at, props: captureProps(), handsOpacity: renderedHandsOpacity };
  stopActivePropAction();
  hideAll();
  if (visible && live2dModel && pawDrawables && ACTION_PROP_HANDLERS[name]) startActivePropAction(name, startedAt);
}
function applyHandoff(at) {
  if (!handoff) return;
  const t = handoffProgress(at);
  if (t >= 1) { handoff = null; return; }
  const targets = captureProps();
  const centers = pawCentersOnScreen();
  const handIn = (snapshots, index) => [...snapshots].find(([el]) => handIndex(el) === index)?.[1];
  const neutral = (index, fallback) => centers?.[index] ? { ...fallback,
    left: (centers[index][0] - currentCX) / currentScale, top: (centers[index][1] - currentCY) / currentScale,
    width: CHIPS_HAND_W, rotation: 0 } : fallback;
  for (const el of elements) {
    const before = handoff.props.get(el), after = targets.get(el);
    if (!before && !after) continue;
    const index = handIndex(el);
    const from = before || { ...(index >= 0 ? handIn(handoff.props, index) || neutral(index, after) : after), opacity: 0 };
    const to = after || { ...(index >= 0 ? handIn(targets, index) || neutral(index, before) : before), opacity: 0 };
    el.hidden = false;
    el.style.left = currentCX + mix(from.left, to.left, t) * currentScale + 'px';
    el.style.top = currentCY + mix(from.top, to.top, t) * currentScale + 'px';
    el.style.width = mix(from.width, to.width, t) * currentScale + 'px';
    el.style.opacity = String(mix(from.opacity, to.opacity, t));
    el.style.transform = index >= 0 ? 'translate(-50%, -50%) rotate(' + mix(from.rotation, to.rotation, t) + 'deg)' : (after || before).transform;
    el.style.transformOrigin = (after || before).transformOrigin || '';
  }
}
function beforeModelUpdate() {
 const at=now();
 frameAt=at;
 if (pendingAction !== undefined) {
  const {name,startedAt}=pendingAction;
  pendingAction=undefined;
  beginHandoff(name,startedAt,at);
 }
 const active=visible ? refreshActivePropAction(at) : null;
 const target=active?.handler.handsOpacity ? active.handler.handsOpacity(at,active.startedAt) : 1;
 setHandsOpacity(handoff ? mix(handoff.handsOpacity,target,handoffProgress(at)) : target);
}
function hideAll() { for(const el of elements) { el.hidden=true; el.className='daimeow-prop'; el.style.opacity=''; el.style.transform=''; el.style.transformOrigin=''; } }
function stop() { pendingAction=undefined; handoff=null; frameAt=null; stopActivePropAction(); hideAll(); setHandsOpacity(1); }
function configure(next) {
 stop(); live2dModel?.internalModel?.off?.('beforeModelUpdate',beforeModelUpdate);
 live2dModel=next; pawDrawables=next ? resolvePawDrawables() : null;
 next?.internalModel?.on?.('beforeModelUpdate',beforeModelUpdate);
 if(container) container.hidden=!next;
}
function update(at=now()) {
 if(!visible || !live2dModel) return;
 try {
  // The post-render ticker uses the same instant as native hand opacity, and
  // now reads the newly drawn vertices rather than the preceding frame's paws.
  if(syncToModelFrame && frameAt !== null) at=frameAt;
  currentScale=live2dModel.scale.x;
  const center=live2dModel.toGlobal({x:live2dModel.internalModel.width/2,y:live2dModel.internalModel.height/2});
  currentCX=center.x; currentCY=center.y;
  // Render fresh target opacity instead of feeding the previous blended frame
  // back into renderers whose normal opacity is the stylesheet default.
  if(handoff) for(const el of elements) el.style.opacity='';
  updateProps(at);
  applyHandoff(at);
 } catch(error) { stop(); report('DaiMeow道具更新失败：'+error.message); }
}
return {
 configure, update, stop,
 start(name) {
  const supported=!!(visible&&live2dModel&&pawDrawables&&ACTION_PROP_HANDLERS[name]);
  // Keep the last rendered hands until the next model update. DOM overlays
  // and native-part opacity then change in the same canvas drawing frame.
  if(syncToModelFrame) { pendingAction={name:supported ? name : '',startedAt:Math.max(.001,now())}; return supported; }
  stop(); if(!supported) return false; startActivePropAction(name,Math.max(.001,now())); update(); return true;
 },
 setVisible(value) { visible=!!value; if(!visible) stop(); },
 destroy() { configure(null); for(const el of elements) el.remove?.(); },
 getState() { return { activeAction:activePropAction?.id||'', props:elements.filter(el=>!el.hidden).length, supported:!!pawDrawables }; },
};
}
