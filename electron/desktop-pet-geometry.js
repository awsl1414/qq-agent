// Electron screen and BrowserWindow both use device-independent pixels (DIP).
export const PET_BASE_SIZE = Object.freeze({ width: 360, height: 480 });

export function petSize(scale = 1) {
  const value = Math.min(3, Math.max(0.5, Number(scale) || 1));
  return { width: Math.round(PET_BASE_SIZE.width * value), height: Math.round(PET_BASE_SIZE.height * value) };
}

export function restorePetBounds(position, size, displays, primaryId) {
  const screens = displays.filter((d) => d?.workArea?.width > 0 && d?.workArea?.height > 0);
  if (!screens.length) return { x: 0, y: 0, width: size.width, height: size.height };
  const primary = screens.find((d) => String(d.id) === String(primaryId)) || screens[0];
  const hasPosition = Number.isFinite(position?.x) && Number.isFinite(position?.y);
  let x = hasPosition ? Math.round(position.x) : primary.workArea.x + primary.workArea.width - size.width - 24;
  let y = hasPosition ? Math.round(position.y) : primary.workArea.y + primary.workArea.height - size.height - 16;
  const overlap = (area) => Math.max(0, Math.min(x + size.width, area.x + area.width) - Math.max(x, area.x)) * Math.max(0, Math.min(y + size.height, area.y + area.height) - Math.max(y, area.y));
  const target = screens.reduce((best, next) => overlap(next.workArea) > overlap(best.workArea) ? next : best, primary);
  const area = target.workArea;
  const fit = Math.min(1, area.width / size.width, area.height / size.height);
  const width = Math.max(1, Math.floor(size.width * fit));
  const height = Math.max(1, Math.floor(size.height * fit));
  // Keep the full window accessible when a monitor is disconnected or scaled.
  x = Math.round(Math.max(area.x, Math.min(x, area.x + Math.max(0, area.width - width))));
  y = Math.round(Math.max(area.y, Math.min(y, area.y + Math.max(0, area.height - height))));
  return { x, y, width, height };
}

export function dragPetBounds(cursor, offset, size) {
  return { x: Math.round(cursor.x - offset.x), y: Math.round(cursor.y - offset.y), width: size.width, height: size.height };
}

// Grow the native frame around a fixed character scene, using DIP throughout.
export function layoutPetSpeechWindow(base, speech = {}, displays = [], primaryId) {
  const screens = displays.filter((display) => display?.workArea?.width > 0 && display?.workArea?.height > 0);
  const primary = screens.find((display) => String(display.id) === String(primaryId)) || screens[0];
  const overlap = (area) => Math.max(0, Math.min(base.x + base.width, area.x + area.width) - Math.max(base.x, area.x)) * Math.max(0, Math.min(base.y + base.height, area.y + area.height) - Math.max(base.y, area.y));
  const target = screens.length ? screens.reduce((best, next) => overlap(next.workArea) > overlap(best.workArea) ? next : best, primary) : null;
  const area = target?.workArea || { x: base.x, y: base.y, width: base.width, height: base.height };
  const speechLimit = { width: Math.max(1, Math.floor(area.width - 12)), height: Math.max(1, Math.floor(area.height - 12)) };
  const requestedWidth = Math.min(speechLimit.width, Math.max(0, Math.ceil(Number(speech.width) || 0)));
  const requestedHeight = Math.min(speechLimit.height, Math.max(0, Math.ceil(Number(speech.height) || 0)));
  const active = requestedWidth > 0 && requestedHeight > 0;
  const extraTop = active ? requestedHeight + 12 : 0;
  const width = Math.min(area.width, Math.max(base.width, active ? requestedWidth + 12 : 0));
  const height = Math.min(area.height, base.height + extraTop);
  const x = Math.round(Math.max(area.x, Math.min(base.x + (base.width - width) / 2, area.x + area.width - width)));
  const y = Math.round(Math.max(area.y, Math.min(base.y - extraTop, area.y + area.height - height)));
  return { bounds: { x, y, width: Math.round(width), height: Math.round(height) }, scene: { left: Math.round(base.x - x), top: Math.round(base.y - y), width: base.width, height: base.height }, speechLimit };
}

// Reply geometry belongs to a separate surface. Never translate or enlarge the
// character window to make room: Windows can composite that move before its DOM.
export function layoutDetachedPetSpeech(base, anchor, size, displays = [], primaryId) {
  const { speechLimit } = layoutPetSpeechWindow(base, {}, displays, primaryId);
  const screens = displays.filter((d) => d?.workArea?.width > 0 && d?.workArea?.height > 0);
  const primary = screens.find((d) => String(d.id) === String(primaryId)) || screens[0];
  const overlap = (d) => Math.max(0, Math.min(base.x + base.width, d.workArea.x + d.workArea.width) - Math.max(base.x, d.workArea.x)) * Math.max(0, Math.min(base.y + base.height, d.workArea.y + d.workArea.height) - Math.max(base.y, d.workArea.y));
  const target = screens.reduce((best, d) => overlap(d) > overlap(best) ? d : best, primary);
  const area = target?.workArea || { x: base.x, y: base.y, width: base.width, height: base.height };
  const width = Math.min(area.width, Math.max(1, Math.ceil(size.width) + 12));
  const height = Math.min(area.height, Math.max(1, Math.ceil(size.height) + 18));
  const center = base.x + (anchor ? anchor.left + anchor.width / 2 : base.width / 2);
  const head = base.y + (anchor ? anchor.top : base.height * .2);
  const x = Math.round(Math.max(area.x, Math.min(center - width / 2, area.x + area.width - width)));
  const y = Math.round(Math.max(area.y, Math.min(head - height, area.y + area.height - height)));
  return { bounds: { x, y, width, height }, tail: Math.max(16, Math.min(center - x - 6, width - 28)), speechLimit };
}
