// Called only AFTER app.js has applied its standard API authorization/origin checks.
import { skillManager } from './skills/manager.js';

export async function handleDesktopPetRequest({ req, res, url, readBody, json, desktopHost, emit }) {
  const pathname = typeof url === 'string' ? new URL(url, 'http://localhost').pathname : url.pathname;
  if (!pathname.startsWith('/api/desktop-pet/')) return false;
  try {
    const provider = skillManager.getCapabilityProviders('desktop.pet.service', {})[0];
    const service = provider?.fn?.();
    if (!service) { json(res, 503, { ok: false, error: '桌宠插件未启用，请在「插件」页启用 Live2D 桌面伙伴' }); return true; }
    if (desktopHost) service.bindHost(desktopHost);
    if (emit) service.setEmitter(emit);
    if (req.method === 'GET' && pathname === '/api/desktop-pet/state') { json(res, 200, service.getState()); return true; }
    if (req.method === 'GET' && pathname === '/api/desktop-pet/history') { json(res, 200, { ok: true, history: service.getHistory() }); return true; }
    if (req.method === 'GET' && pathname.startsWith('/api/desktop-pet/model/')) {
      const parts = pathname.slice('/api/desktop-pet/model/'.length).split('/').map((s) => decodeURIComponent(s));
      const id = parts.shift();
      if (parts.some((s) => /[\\/]/.test(s))) throw new Error('模型资源路径无效');
      const asset = service.getModelAsset(id, parts.join('/'));
      res.writeHead(200, { 'Content-Type': asset.mime, 'Content-Length': asset.data.length, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
      res.end(asset.data); return true;
    }
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: '不支持的请求方法' }); return true; }
    const raw = await readBody(req);
    const body = typeof raw === 'string' || Buffer.isBuffer(raw) ? JSON.parse(String(raw) || '{}') : raw || {};
    let out;
    if (pathname === '/api/desktop-pet/settings') out = service.updateSettings(body.settings ?? body);
    else if (pathname === '/api/desktop-pet/select') out = service.selectModel(body.modelId);
    else if (pathname === '/api/desktop-pet/command') out = await service.command(body);
    else if (pathname === '/api/desktop-pet/observe') {
      const controller = new AbortController();
      const onClose = () => { if (!res.writableEnded) controller.abort(new Error('观察页面已关闭')); };
      res.once?.('close', onClose);
      try { out = await service.observeNow({ manual: true, signal: controller.signal }); }
      finally { res.off?.('close', onClose); }
    }
    else if (pathname === '/api/desktop-pet/import') {
      if (!desktopHost?.available || typeof desktopHost.pickModel !== 'function') throw new Error('请通过 QQ Agent 桌面程序打开原生模型选择器');
      const entry = await desktopHost.pickModel();
      out = entry ? service.importModel(entry) : { ok: true, cancelled: true };
    } else { json(res, 404, { ok: false, error: '桌宠接口不存在' }); return true; }
    json(res, 200, out);
  } catch (error) {
    const code = pathname.startsWith('/api/desktop-pet/model/') ? 404 : 400;
    json(res, code, { ok: false, error: String(error?.message || error).slice(0, 500) });
  }
  return true;
}
