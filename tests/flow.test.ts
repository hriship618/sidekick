import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandGraph, matchLocalIntent, rankLocalIntents, windowsGraph } from '../src/local-router.ts';
import { PromptManager } from '../src/prompt-manager.ts';
import { TrajectoryCompressor } from '../src/trajectory.ts';
import { Runner } from '../src/runner.ts';
import { Store } from '../src/store.ts';
import { createRegistry } from '../src/tools.ts';
import { runAgent } from '../src/agent.ts';
import { defaults } from '../src/contracts.ts';
import type { BrowserSession } from '../src/browser.ts';
import type { ToolDefinition } from '../src/model.ts';

test('local router accepts complete supported commands and rejects semantic near misses', () => {
  assert.deepEqual(windowsGraph.order('Close-App'), ['App_Name', 'Close-App']);
  assert.equal(matchLocalIntent('could you shut down Notepad')?.node, 'Close-App');
  assert.equal(matchLocalIntent('show folder "C:\\My Files"')?.node, 'Open-Dir');
  assert.deepEqual(matchLocalIntent('turn the volume up by 7 percent')?.parameters, { amount: 7 });
  assert.deepEqual(matchLocalIntent('volume up')?.parameters, { amount: 5 });
  assert.equal(rankLocalIntents('raise volume')[0].node, 'Volume-Up');
  for (const query of ['do not close Notepad', 'close all apps', 'close Notepad then open Chrome', 'close Notepad if it is saved',
    'volume up then play music', 'volume up by 99', 'increase volume by 0', 'what does close Notepad do?',
    'open folder ..\\Downloads', 'open C:\\Temp and delete its contents', 'open folder "C:\\X" and run it',
    'close the account', 'close Rove', 'close Notepad or Chrome', 'close Notepad but keep its notes',
    'close Firefox tomorrow', 'close Notepad in 10 minutes', 'close Notepad at noon', 'close Notepad in ten minutes']) {
    assert.equal(matchLocalIntent(query), undefined, query);
  }
  assert.throws(() => new CommandGraph().add({ id: 'a', kind: 'command', description: '' }, ['b']).order('a'), /Unknown/);
  assert.throws(() => new CommandGraph().add({ id: 'a', kind: 'command', description: '' }, ['a']).order('a'), /cycle/);
});

test('graph open and volume routes use registry, persist progress and never construct a model', async () => {
  const store = new Store(':memory:'); const calls: unknown[] = [];
  const registry = createRegistry({ openUrl: async () => {}, openPath: async path => { calls.push(path); }, launchTerminal: async () => {},
    desktop: async ({ operation }) => { calls.push(operation); return { verification: 'desktop-observed', message: 'Setting read back.', data: { settingVerified: true } }; } });
  const runner = new Runner(store, registry, () => {}, { configured: () => false, fastDesktop: true,
    model: async () => { throw new Error('No model needed.'); }, browser: {} as BrowserSession });
  try {
    await runner.run('show folder "C:\\My Files"');
    await runner.run('raise volume by 3');
    assert.deepEqual(calls, ['C:\\My Files', { action: 'increaseVolume', amount: 3 }]);
    assert.ok(store.recent().every(run => run.status === 'completed' && run.steps.length === 1));
  } finally { store.close(); }
});

test('prompt manager snapshots static schema, rejects drift and appends dynamic data last', () => {
  const tools: ToolDefinition[] = [{ name: 'z', description: 'Z', parameters: { type: 'object' } }, { name: 'a', description: 'A', parameters: {} }];
  const manager = new PromptManager('Windows rules.', tools);
  const same = new PromptManager('Windows rules.', [...tools].reverse());
  assert.equal(manager.cacheKey, same.cacheKey);
  manager.assertCompatible('Windows rules.', [...tools].reverse());
  const copy = manager.tools(); copy[0].description = 'mutated';
  assert.equal(manager.tools()[0].description, 'A');
  assert.throws(() => manager.assertCompatible('new rules', tools), /static/);
  assert.throws(() => manager.assertCompatible('Windows rules.', tools.slice(1)), /static/);
  assert.deepEqual(manager.input('dynamic'), [{ role: 'user', content: 'dynamic' }]);
  assert.doesNotMatch(manager.instructions, /dynamic/);
});

test('trajectory compression enforces budget, retains full evidence and makes no inferred claims', () => {
  const text = 'first\n' + 'x'.repeat(10000) + '\nC:\\Docs\\invoice.pdf\nlast';
  let saved = '';
  const result = TrajectoryCompressor(text, { target: 'invoice.pdf', save: full => { saved = full; return 42; } });
  assert.equal(saved, text); assert.equal(result.evidenceId, 42); assert.equal(result.text.length <= 500, true);
  assert.match(result.text, /invoice.pdf/); assert.match(result.text, /evidence 42/);
  assert.doesNotMatch(result.text, /files found|successfully/);
  assert.equal(TrajectoryCompressor('small').text, 'small');
  assert.throws(() => TrajectoryCompressor('x', { limit: 2 }), /limit/);
});

test('agent compresses PowerShell observations, retains exact evidence, and keeps catalog stable', async () => {
  const store = new Store(':memory:'); const original = 'BEGIN\n' + 'verbose stdout\n'.repeat(1000) + 'END';
  const id = store.start('Run a local diagnostic', 'running', ''); let turn = 0; let tools = '';
  try {
    const result = await runAgent({ id, command: 'Run a local diagnostic', store, settings: defaults, browser: {} as BrowserSession,
      registry: createRegistry({ openUrl: async () => {}, openPath: async () => {}, launchTerminal: async () => {},
        desktop: async () => ({ verification: 'desktop-observed', message: 'Command finished.', data: { output: original, stderr: '', exitCode: 0 } }) }),
      model: { async decide(_instructions, context, definitions, previous) {
        const snapshot = JSON.stringify(definitions); tools ||= snapshot; assert.equal(snapshot, tools);
        assert.equal(context.includes(original), false);
        if (turn++ === 0) return { items: [], calls: [{ type: 'function_call', name: 'desktop', call_id: 'a', arguments: JSON.stringify({ operation: { action: 'runPowerShell', script: 'diagnostic', timeoutSeconds: 5 } }) }] };
        const output = previous!.outputs[0] as { output: string };
        const observed = JSON.parse(output.output);
        assert.ok(observed.data.output.length <= 500);
        const evidence = JSON.parse(store.evidence(id, observed.evidenceId)!.data.toString());
        assert.equal(evidence.output, original);
        return { items: [], calls: [{ type: 'function_call', name: 'finish', call_id: 'b', arguments: JSON.stringify({ status: 'completed', message: 'Diagnostic completed.' }) }] };
      } }, signal: new AbortController().signal, publish: () => {}, phase: () => {}, ask: async () => { throw new Error('No question expected.'); } });
    assert.equal(result.status, 'completed'); assert.equal(turn, 2);
  } finally { store.close(); }
});
