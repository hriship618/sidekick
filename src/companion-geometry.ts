import type { Settings } from './contracts.ts';
export type Area = { x: number; y: number; width: number; height: number };
export const creatureSize = 64;
export function creatureHit(point: { x: number; y: number }, position: { x: number; y: number }) {
  return [[16,16,32,4],[12,20,40,8],[4,28,56,16],[12,44,40,4],[16,48,12,8],[36,48,12,8]]
    .some(([x,y,width,height]) => contains({ x: position.x+x, y: position.y+y, width, height }, point));
}
export function nearDock(point: { x: number; y: number }, area: Area, edge: ReturnType<typeof taskbarEdge>) {
  return edge === 'bottom' ? point.y + 64 >= area.height - 20 : edge === 'top' ? point.y <= 20
    : edge === 'left' ? point.x <= 20 : point.x + 64 >= area.width - 20;
}
export function contains(rect: Area, point: { x: number; y: number }) {
  return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
}
export function companionViewport(point: { x: number; y: number }, area: Area) {
  const width = Math.min(380, area.width), height = Math.min(200, area.height);
  return { x: Math.round(Math.max(0, Math.min(point.x > 310 ? point.x - 310 : point.x - 8, area.width - width))),
    y: Math.round(Math.max(0, Math.min(point.y - 110, area.height - height))), width, height };
}
export function taskbarEdge(bounds: Area, work: Area): 'bottom' | 'top' | 'left' | 'right' {
  const gaps = { bottom: bounds.y + bounds.height - work.y - work.height, top: work.y - bounds.y,
    left: work.x - bounds.x, right: bounds.x + bounds.width - work.x - work.width };
  return (Object.keys(gaps) as (keyof typeof gaps)[]).reduce((a, b) => gaps[b] > gaps[a] ? b : a, 'bottom');
}
export function dockedPosition(point: { x: number; y: number }, area: Area, edge: ReturnType<typeof taskbarEdge>, tucked: boolean) {
  const result = clampPosition(point.x, point.y, area);
  // Only the head (including both eyes) remains above the usable desktop edge.
  if (edge === 'bottom') result.y = area.height - (tucked ? 40 : 64);
  if (edge === 'top') result.y = tucked ? -16 : 0;
  if (edge === 'left') result.x = tucked ? -32 : 0;
  if (edge === 'right') result.x = area.width - (tucked ? 32 : 64);
  return result;
}
export function clampPosition(x: number, y: number, area: Pick<Area, 'width' | 'height'>) {
  return { x: Math.round(Math.max(0, Math.min(x, area.width - creatureSize))),
    y: Math.round(Math.max(0, Math.min(y, area.height - creatureSize))) };
}
export function restingPosition(settings: Settings, displayId: string, area: Area) {
  const saved = settings.restingPosition;
  if (saved && saved.displayId === displayId) {
    return clampPosition(saved.x * (area.width - creatureSize), saved.y * (area.height - creatureSize), area);
  }
  return clampPosition(settings.restingCorner.endsWith('right') ? area.width - creatureSize - 22 : 22,
    settings.restingCorner.startsWith('bottom') ? area.height - creatureSize - 22 : 22, area);
}
export function panelNearCompanion(position: { x: number; y: number }, area: Area, width: number, height: number) {
  const x = Math.max(area.x + 8, Math.min(area.x + position.x + creatureSize - width, area.x + area.width - width - 8));
  const preferredY = position.y > height + 16 ? area.y + position.y - height - 10 : area.y + position.y + creatureSize + 10;
  const y = Math.max(area.y + 8, Math.min(preferredY, area.y + area.height - height - 8));
  return { x: Math.round(x), y: Math.round(y), width, height };
}
