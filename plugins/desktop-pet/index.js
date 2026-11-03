import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, getConfig } from '../../src/config.js';
import { currentProviders } from '../../src/providers.js';
import { chatCompletion, estimateCost } from '../../src/llm.js';
import { modelImageVerdict } from '../../src/vision-scan.js';
// The loader refreshes this entry only; version the helper URL to bypass its
// previous ESM cache when installing this update into a running desktop app.
import { createDesktopPetService } from './lib/service.js?v=1.3.7';

let service;
let warn = () => {};
export function setup(api) {
  warn = api.warn;
  service = createDesktopPetService({ dataDir: DATA_DIR, getConfig, getProviders: currentProviders, chatCompletion, estimateCost, modelImageVerdict });
  api.log('桌面伙伴已加载；在「桌宠」页导入角色，自动屏幕观察默认关闭');
}
export function available() { return true; }
export function activate() {
  service?.start();
  // 首次启动（模型列表为空）时补种随包的默认角色。
  // 只补种到 data 目录，不覆盖已有角色；列表非空时完全不动。
  const entry = path.join(ROOT, 'assets', 'desktop-pet', 'DS鼠控版', 'c_0120.model3.json');
  if (service && service.getState().models.length === 0 && fs.existsSync(entry)) {
    try { service.importModel(entry, { name: 'DS鼠控版' }); }
    catch (error) { warn(`默认角色导入失败：${error.message}`); service.onModelLoaded({ error: `默认角色导入失败：${error.message}` }); }
  }
}
export function deactivate() { service?.shutdown(); }
export function dispose() { service?.shutdown(); }
export const providers = { 'desktop.pet.service': () => service };
