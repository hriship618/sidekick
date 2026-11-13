import { spawn } from 'node:child_process';
import { z } from 'zod';

const windowTarget = { windowId: z.string().regex(/^[1-9][0-9]{0,19}$/), processId: z.number().int().positive() };
const control = { ...windowTarget, controlId: z.string().regex(/^[0-9]+(?:\.[0-9]+)*$/) };
export const desktopInput = z.strictObject({ operation: z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('increaseVolume'), amount: z.number().int().min(1).max(20) }),
  z.strictObject({ action: z.literal('listWindows'), query: z.string().trim().min(1).max(100).optional() }),
  z.strictObject({ action: z.literal('listProcesses'), name: z.string().max(100).optional() }),
  z.strictObject({ action: z.literal('inspectWindow'), ...windowTarget }),
  z.strictObject({ action: z.literal('focusWindow'), ...windowTarget }),
  z.strictObject({ action: z.literal('closeWindow'), ...windowTarget }),
  z.strictObject({ action: z.literal('invokeControl'), ...control }),
  z.strictObject({ action: z.literal('fillControl'), ...control, value: z.string().max(10000) }),
  z.strictObject({ action: z.literal('stopProcess'), processId: z.number().int().positive() }),
  z.strictObject({ action: z.literal('runPowerShell'), script: z.string().min(1).max(16000), timeoutSeconds: z.number().int().min(1).max(120) }),
]) });
export type DesktopInput = z.infer<typeof desktopInput>;
export type DesktopResult = { verification: 'desktop-observed'; message: string; data: Record<string, unknown> };
export class DesktopExecutionError extends Error {
  readonly result: DesktopResult;
  constructor(result: DesktopResult) { super(result.message); this.result = result; }
}
export const desktopOutput = z.strictObject({ verification: z.literal('desktop-observed'), message: z.string(), data: z.record(z.string(), z.unknown()) });

export function executeDesktop(helper: string, value: unknown, signal?: AbortSignal): Promise<DesktopResult> {
  const { operation } = desktopInput.parse(value);
  if (process.platform !== 'win32') return Promise.reject(new Error('Windows desktop tools require Windows.'));
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Data goes over stdin, never interpolated into shell arguments or a command line.
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error?: Error, result?: DesktopResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => { child.kill(); finish(new Error('The desktop action was cancelled. A dispatched action may have finished.')); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('The desktop action timed out. Inspect its state before retrying.')); },
      operation.action === 'runPowerShell' ? (operation.timeoutSeconds + 3) * 1000 : 20000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 1_000_000) { child.kill(); finish(new Error('The desktop result exceeded its output limit. Use a narrower query.')); }
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', () => finish(new Error('Could not start Windows desktop tools. Check that Windows PowerShell is available.')));
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (settled) return;
      try {
        const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
        if (code !== 0 || result.error) throw new Error(result.error || 'The desktop action failed.');
        const parsed = desktopOutput.parse(result);
        if (typeof parsed.data.exitCode === 'number' && parsed.data.exitCode !== 0) finish(new DesktopExecutionError(parsed));
        else finish(undefined, parsed);
      } catch (error) {
        finish(error instanceof SyntaxError ? new Error('The desktop helper returned an invalid result. ' + (stderr.includes('Access') ? 'Windows denied access to the target.' : 'Inspect the target before retrying.')) : error as Error);
      }
    });
    child.stdin.end(JSON.stringify(operation));
  });
}
