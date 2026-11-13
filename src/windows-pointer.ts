import { loadNative } from './native-bindings.ts';
import { spawn } from 'node:child_process';
export type PrimaryReader = (() => boolean) & { dispose?: () => void };

/** Reads the primary mouse button for sprite hit-testing and dragging. Never injects input. */
export function primaryButtonReader(helper?: string): PrimaryReader | undefined {
  if (process.platform !== 'win32') return;
  const koffi = loadNative();
  if (koffi) {
    const user32 = koffi.load('user32.dll');
    const keyState = user32.func('__stdcall', 'GetAsyncKeyState', 'int16', ['int']);
    const metrics = user32.func('__stdcall', 'GetSystemMetrics', 'int', ['int']);
    return () => (keyState(metrics(23) ? 2 : 1) & 0x8000) !== 0;
  }
  if (!helper) return;
  let down = false, buffer = '';
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
    for (const line of lines) if (line === '0' || line === '1') down = line === '1';
  });
  child.on('error', () => { down = false; });
  child.on('exit', () => { down = false; });
  const read: PrimaryReader = () => down;
  read.dispose = () => child.kill();
  return read;
}
