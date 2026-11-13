import type { BrowserWindow, WebContents } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function lifecycleLog(directory: string, event: string, detail: Record<string, unknown> = {}) {
  try {
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, 'lifecycle.log'), JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + '\n');
  } catch { /* Logging must not take down the app. No task text or secrets are written here. */ }
}
const heartbeats = new WeakMap<WebContents, () => void>();
export function rendererHeartbeat(contents: WebContents) { heartbeats.get(contents)?.(); }

export function recoverRenderer(window: BrowserWindow, kind: string, directory: string, restored: () => void, replace?: () => void) {
  const contents = window.webContents;
  let attempts: number[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let source = window.webContents.getURL();
  let lastBeat = Date.now();
  heartbeats.set(window.webContents, () => { lastBeat = Date.now(); });
  const restart = (reason: string, exitCode?: number) => {
    if (window.isDestroyed()) return;
    lifecycleLog(directory, reason === 'heartbeat-missed' ? 'renderer-unresponsive' : 'renderer-gone', { window: kind, reason, exitCode });
    attempts = attempts.filter(at => Date.now() - at < 60_000);
    if (attempts.length >= 3) return;
    attempts.push(Date.now());
    lastBeat = Date.now();
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (window.isDestroyed()) return;
      if (replace) replace();
      else void contents.loadURL(source || contents.getURL()).catch(() => lifecycleLog(directory, 'renderer-reload-failed', { window: kind }));
    }, 250 * attempts.length);
  };
  window.webContents.on('render-process-gone', (_event, detail) => restart(detail.reason, detail.exitCode));
  window.on('show', () => { lastBeat = Date.now(); });
  const watchdog = setInterval(() => {
    if (window.isDestroyed()) return;
    if (!window.isVisible()) { lastBeat = Date.now(); return; }
    if (Date.now() - lastBeat > 6000) restart('heartbeat-missed');
  }, 1000);
  window.webContents.on('did-finish-load', () => {
    if (!window.isDestroyed()) { lastBeat = Date.now(); source = window.webContents.getURL(); lifecycleLog(directory, 'renderer-ready', { window: kind }); restored(); }
  });
  window.once('closed', () => { clearTimeout(timer); clearInterval(watchdog); heartbeats.delete(contents); });
}
