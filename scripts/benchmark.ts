import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, release } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron } from 'playwright';
import { matchLocalIntent } from '../src/local-router.ts';
import { TrajectoryCompressor } from '../src/trajectory.ts';
import { DesktopWorker } from '../src/desktop-worker.ts';
import { executeDesktop } from '../src/windows-desktop.ts';
import { PromptManager } from '../src/prompt-manager.ts';
import { Store } from '../src/store.ts';
import { runAgent } from '../src/agent.ts';
import { createRegistry } from '../src/tools.ts';
import { defaults } from '../src/contracts.ts';
import type { ToolDefinition } from '../src/model.ts';
import type { BrowserSession } from '../src/browser.ts';

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { n: values.length, minMs: sorted[0], medianMs: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1), samplesMs: values };
};
const measured = async <T>(run: () => T | Promise<T>) => { const start = performance.now(); const result = await run(); return { ms: performance.now() - start, result }; };
const folder = await mkdtemp(join(tmpdir(), 'rove-benchmark-'));
const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), environment: {
  platform: process.platform, osRelease: release(), node: process.version, cpu: cpus()[0]?.model,
  logicalProcessors: cpus().length, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
}, methodology: { liveProviderRequests: 0, tokensMeasured: false, timingUnit: 'milliseconds',
  limitations: ['Development build, not installed app.', 'No provider latency, TTFT, billed tokens or cache-hit savings measured.',
    'Router corpus is a small hand-labeled regression set, not a generalization guarantee.', 'No volume changes or real-user app closures.',
    'Native and launcher timings are sequential under current desktop load. IPC timing excludes typing and hotkey handling.'] } };
try {
  // Include supported commands, paraphrases, negation, compound goals and deliberately unsupported simple intents.
  const positives: [string, string][] = [
    ['close Notepad', 'Close-App'], ['Please close "Calculator".', 'Close-App'], ['could you shut down Notepad', 'Close-App'],
    ['can you dismiss Calculator', 'Close-App'], ['close the Firefox', 'Close-App'], ['close Visual Studio Code', 'Close-App'],
    ['close Steam please', 'Close-App'], ['shut Calculator', 'Close-App'], ['show folder "C:\\My Files"', 'Open-Dir'],
    ['open C:\\Users\\Public', 'Open-Dir'], ['show directory C:\\Temp', 'Open-Dir'], ['open file "C:\\Docs\\report.pdf"', 'Open-Dir'],
    ['please show path C:\\Temp', 'Open-Dir'], ['volume up', 'Volume-Up'], ['turn the volume up', 'Volume-Up'],
    ['raise volume by 3', 'Volume-Up'], ['increase volume by 20 percent', 'Volume-Up'], ['volume up by 1%', 'Volume-Up'],
    ['can you increase the volume', 'Volume-Up'], ['volume up please', 'Volume-Up'],
    ['turn up the volume', 'Volume-Up'], ['make the sound louder', 'Volume-Up'], ['open my Downloads folder', 'Open-Dir'],
    ['exit Notepad', 'Close-App'], ['bring up C:\\Temp', 'Open-Dir'],
  ];
  const negatives = [
    'do not close Notepad', 'close all apps', 'close Notepad then open Chrome', 'close Notepad if it is saved',
    'volume up then play music', 'volume up by 99', 'increase volume by 0', 'what does close Notepad do?',
    'open folder ..\\Downloads', 'open C:\\Temp and delete its contents', 'open folder "C:\\X" and run it',
    'close the account', 'close Rove', 'close Notepad or Chrome', 'close Notepad but keep its notes',
    'close Firefox tomorrow', 'close Notepad in 10 minutes', 'close Notepad without saving', 'close this window',
    'close the issue', 'increase volume to 5 percent', 'open folder "C:\\Temp" after closing Chrome',
    'search for a folder named tax', 'delete C:\\Temp', 'close my bank account',
  ];
  const corpus = [...positives.map(([query, expected]) => ({ query, expected })), ...negatives.map(query => ({ query, expected: undefined }))];
  const cases = corpus.map(item => ({ ...item, actual: matchLocalIntent(item.query)?.node }));
  const accepted = cases.filter(item => item.actual);
  const correct = accepted.filter(item => item.actual === item.expected);
  const falsePositives = accepted.filter(item => item.actual !== item.expected);
  for (let i = 0; i < 1000; i++) matchLocalIntent(corpus[i % corpus.length].query);
  const batches: number[] = [];
  for (let i = 0; i < 100; i++) {
    const start = performance.now(); for (const item of corpus) matchLocalIntent(item.query);
    batches.push((performance.now() - start) / corpus.length);
  }
  report.router = { corpusSize: cases.length, supportedIntentRequests: positives.length, complexOrUnsupportedRequests: negatives.length,
    accepted: accepted.length, correctAccepted: correct.length, falsePositiveCount: falsePositives.length,
    precision: accepted.length ? correct.length / accepted.length : 0, simpleIntentCoverage: correct.length / positives.length,
    latency: stats(batches), latencyMethod: '100 batches of 50 queries, per-query batch average after 1000 warmup queries', cases };
  console.log('Router measured:', { accepted: accepted.length, falsePositives: falsePositives.map(item => item.query) });

  const store = new Store(join(folder, 'bench.sqlite'));
  try {
    const id = store.start('Synthetic output benchmark', 'running', '');
    const text = Array.from({ length: 10000 }, (_, i) => `C:\\Synthetic\\folder-${i}\\report-${i}.txt`).join('\n');
    const samples: number[] = []; let compressed = '';
    for (let i = 0; i < 30; i++) {
      const value = await measured(() => TrajectoryCompressor(text, { save: full => store.saveEvidence(id, 'text', Buffer.from(full)) }));
      samples.push(value.ms); compressed = value.result.text;
      assert.equal(store.evidence(id, value.result.evidenceId!)!.data.toString(), text);
    }
    report.compression = { inputChars: text.length, modelVisibleChars: compressed.length,
      characterReductionPercent: 100 * (1 - compressed.length / text.length), fullEvidenceRecovered: true,
      latencyIncludingSQLiteWrite: stats(samples), fixture: 'Synthetic 10000-path listing; character counts are not tokenizer counts.' };
    let instructions = '', definitions: ToolDefinition[] = [];
    const runId = store.start('Local diagnostic', 'running', '');
    await runAgent({ id: runId, command: 'Local diagnostic', settings: defaults, store,
      registry: createRegistry({ openUrl: async () => {}, openPath: async () => {}, launchTerminal: async () => {} }),
      browser: {} as BrowserSession, model: { async decide(prompt, _context, tools) {
        instructions = prompt; definitions = tools;
        return { items: [], calls: [{ type: 'function_call', name: 'finish', call_id: 'fixture', arguments: JSON.stringify({ status: 'failed', message: 'No execution; catalog capture only.' }) }] };
      } }, signal: new AbortController().signal, publish: () => {}, phase: () => {}, ask: async () => undefined });
    const manager = new PromptManager(instructions, definitions);
    const samplesPrompt: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const result = await measured(() => { manager.assertCompatible(instructions, definitions); return manager.input(JSON.stringify({ goal: 'diagnostic ' + i, timestamp: new Date().toISOString() })); });
      samplesPrompt.push(result.ms);
    }
    report.prefix = { tools: definitions.length, instructionChars: manager.instructions.length,
      toolSchemaChars: JSON.stringify(manager.tools()).length, keyStableAcrossDynamicRequests: true,
      localBuildLatency: stats(samplesPrompt), providerCacheHits: null, providerLatencySavings: null };
  } finally { store.close(); }
  console.log('Context and prompt benchmarks completed.');

  if (process.platform === 'win32') {
    const helper = resolve('src/windows-desktop.ps1');
    const operation = { operation: { action: 'listWindows' as const, query: 'RoveBenchmarkNoMatchingWindow' } };
    const cold: number[] = [], warm: number[] = []; const worker = new DesktopWorker(helper);
    try {
      for (let i = 0; i < 5; i++) cold.push((await measured(() => executeDesktop(helper, operation))).ms);
      const first = await measured(() => worker.execute(operation));
      for (let i = 0; i < 20; i++) warm.push((await measured(() => worker.execute(operation))).ms);
      report.desktopHelper = { identicalReadOnlyQuery: true, oneShot: stats(cold), persistentFirstRequestMs: first.ms,
        persistentWarm: stats(warm), medianSpeedup: stats(cold).medianMs / stats(warm).medianMs };
    } finally { worker.close(); }
    console.log('Native helper benchmark completed.');
    let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      const startup = performance.now();
      app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['.', '--user-data-dir=' + join(folder, 'profile')], cwd: resolve('.'), timeout: 30000 });
      const deadline = Date.now() + 30000;
      let panel;
      while (!panel && Date.now() < deadline) {
        panel = app.windows().find(page => !page.url().endsWith('#companion'));
        if (!panel) await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(panel, 'Launcher created');
      await panel.locator('input[aria-label=Command]').waitFor();
      const startupMs = performance.now() - startup;
      const snapshot = await panel.evaluate(() => (window as any).sidekick.snapshot());
      assert.equal(snapshot.chatgpt.connected, false, 'No live user credentials in benchmark profile');
      const latencies: number[] = []; let firstMs = 0;
      for (let i = 0; i < 21; i++) {
        const title = 'RoveBenchmarkFixture' + Date.now() + 'n' + i;
        await app.evaluate(async ({ BrowserWindow }, title) => {
          const fixture = new BrowserWindow({ title, width: 240, height: 100, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
          fixture.on('page-title-updated', event => event.preventDefault());
          await fixture.loadURL('data:text/html,<body>Disposable benchmark</body>'); fixture.showInactive();
          (globalThis as any).roveBenchmarkFixture = fixture;
        }, title);
        const result = await measured(() => panel!.evaluate(command => (window as any).sidekick.run(command), 'close ' + title));
        if (i === 0) firstMs = result.ms; else latencies.push(result.ms);
        assert.equal(await app.evaluate(() => (globalThis as any).roveBenchmarkFixture.isDestroyed()), true);
        const saved = await panel.evaluate(() => (window as any).sidekick.snapshot());
        assert.equal(saved.runs[0].status, 'completed'); assert.equal(saved.runs[0].steps.length, 2);
      }
      report.launcher = { startupToInputReadyMs: startupMs, firstLocalCloseMs: firstMs, verifiedCloses: 21,
        warmIPCToVerifiedCompletion: stats(latencies), modelCalls: 0, profile: 'Disposable; no user credentials',
        exclusions: ['Fixture creation', 'Typing', 'Global hotkey', 'Real provider', 'App-specific save prompts'] };
      console.log('Launcher benchmark completed.');
    } finally { await app?.close(); }
  }
  await mkdir('docs/benchmarks', { recursive: true });
  await writeFile('docs/benchmarks/latest.json', JSON.stringify(report, null, 2) + '\n');
  console.log('Saved docs/benchmarks/latest.json');
} finally {
  assert.ok(folder.startsWith(join(tmpdir(), 'rove-benchmark-')));
  await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
