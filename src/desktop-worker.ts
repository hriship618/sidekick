import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { desktopInput, desktopOutput, DesktopExecutionError, type DesktopResult } from './windows-desktop.ts';

/** One owned helper, one validated request at a time; no PowerShell startup/compilation per step. */
export class DesktopWorker {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private buffer = '';
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: { id: number; finish(error?: Error, result?: DesktopResult): void };
  private helper: string;
  constructor(helper: string) { this.helper = helper; }
  execute(value: unknown, signal?: AbortSignal): Promise<DesktopResult> {
    const input = desktopInput.parse(value);
    const run = this.queue.catch(() => {}).then(() => {
      signal?.throwIfAborted();
      return new Promise<DesktopResult>((resolve, reject) => {
        const child = this.start(), id = ++this.nextId;
        const abort = () => { this.stop(new Error('The desktop action was cancelled. A dispatched action may still finish.')); };
        const timeout = input.operation.action === 'runPowerShell' ? input.operation.timeoutSeconds * 1000 + 3000 : 20000;
        const timer = setTimeout(() => this.stop(new Error('The desktop action timed out. Check the target before retrying.')), timeout);
        this.pending = { id, finish: (error, result) => {
          clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending = undefined;
          if (error) reject(error); else resolve(result!);
        } };
        signal?.addEventListener('abort', abort, { once: true });
        child.stdin.write(JSON.stringify({ id, operation: input.operation }) + '\n');
      });
    });
    this.queue = run;
    return run;
  }
  private start() {
    if (this.child) return this.child;
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.helper, '-Worker'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child; this.buffer = '';
    child.stdin.on('error', () => this.stop(new Error('Windows desktop helper stopped. Retry the task.')));
    child.stderr.on('data', () => {});
    child.stdout.setEncoding('utf8').on('data', chunk => {
      if (this.child !== child) return;
      this.buffer += chunk;
      if (this.buffer.length > 1_000_000) { this.stop(new Error('The desktop result was too large. Use a narrower request.')); return; }
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim(); this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        try {
          const response = JSON.parse(line);
          if (response.error) throw new Error(response.error);
          const pending = this.pending;
          if (!pending || response.id !== pending.id) throw new Error('The desktop helper returned an unexpected response.');
          if (response.result?.error) pending.finish(new Error(response.result.error));
          else {
            const result = desktopOutput.parse(response.result);
            if (typeof result.data.exitCode === 'number' && result.data.exitCode !== 0) pending.finish(new DesktopExecutionError(result));
            else pending.finish(undefined, result);
          }
        } catch (error) { this.stop(error instanceof Error ? error : new Error('Invalid desktop response.')); }
      }
    });
    child.on('error', () => { if (this.child === child) this.stop(new Error('Windows desktop helper could not start.')); });
    child.on('exit', () => { if (this.child === child) this.stop(new Error('Windows desktop helper exited. Retry the task.')); });
    return child;
  }
  private stop(error = new Error('Desktop helper closed.')) {
    const child = this.child; this.child = undefined;
    this.pending?.finish(error); this.buffer = '';
    if (child && !child.killed) child.kill();
  }
  close() { this.stop(); }
}
