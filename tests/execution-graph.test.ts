import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeGraph, graphOrder, linearGraph } from '../src/execution-graph.ts';
import { Store } from '../src/store.ts';
import { Runner } from '../src/runner.ts';
import { createRegistry } from '../src/tools.ts';
import { runAgent } from '../src/agent.ts';
import { defaults } from '../src/contracts.ts';
import type { BrowserSession } from '../src/browser.ts';

test('execution graph validates every dependency before dispatch and orders prerequisites', async () => {
  assert.deepEqual(graphOrder([{ id: 'use', after: ['find'], action: 2 }, { id: 'find', after: [], action: 1 }]).map(node => node.action), [1, 2]);
  for (const nodes of [
    [{ id: 'a', after: ['b'], action: 0 }],
    [{ id: 'a', after: ['b'], action: 0 }, { id: 'b', after: ['a'], action: 0 }],
    [{ id: 'a', after: [], action: 0 }, { id: 'a', after: [], action: 0 }],
  ]) {
    await assert.rejects(executeGraph(nodes, { signal: new AbortController().signal, execute: async () => { assert.fail('Invalid graph dispatched.'); } }));
  }
});

test('graph failure blocks the suffix, retains checkpoints, and never retries completed actions', async () => {
  const calls: number[] = [];
  const receipt = await executeGraph(linearGraph([1, 2, 3]), { signal: new AbortController().signal,
    execute: async node => { calls.push(node.action); return { ok: node.action !== 2, message: 'Observed result.' }; } });
  assert.deepEqual(calls, [1, 2]); assert.deepEqual(receipt.completed, ['step1']);
  assert.deepEqual(receipt.blocked, ['step3']); assert.equal(receipt.failedNode, 'step2'); assert.equal(receipt.ok, false);
  const controller = new AbortController();
  const cancelled = await executeGraph(linearGraph([1, 2]), { signal: controller.signal,
    execute: async () => { controller.abort(); return { ok: true, message: 'Already dispatched.' }; } });
  assert.equal(cancelled.cancelled, true); assert.deepEqual(cancelled.completed, ['step1']); assert.deepEqual(cancelled.blocked, ['step2']);
});

test('launcher saved routine executes a graph locally and persists blocked steps after failure', async () => {
  const store = new Store(':memory:'); const calls: string[] = [];
  store.save({ ...defaults, routines: [{ id: '8a0fe76f-a141-4ff2-b846-2f93d6909880', name: 'Prepare project workspace',
    resources: ['https://example.com/docs', 'C:\\Project\\brief.pdf', 'https://example.com/issues'], sshAlias: '', remoteDir: '' }] });
  const runner = new Runner(store, createRegistry({ openUrl: async url => { calls.push(url); },
    openPath: async path => { calls.push(path); throw new Error('Could not open the local brief.'); }, launchTerminal: async () => {} }), () => {});
  try {
    await runner.run('Prepare project workspace'); const run = store.recent()[0];
    assert.equal(run.status, 'failed'); assert.deepEqual(run.steps.map(step => step.status), ['completed', 'failed', 'skipped']);
    assert.equal(calls.length, 2); assert.equal(run.engine?.modelCalls, 0); assert.equal(run.engine?.graphPlans, 1);
  } finally { store.close(); }
});

test('oversized local plans fail before dispatch and never leave a running task', async () => {
  const store = new Store(':memory:');
  try {
    const runner = new Runner(store, createRegistry({ openUrl: async () => { assert.fail('Oversized plan dispatched.'); }, openPath: async () => {}, launchTerminal: async () => {} }), () => {});
    await runner.run('open ' + Array.from({ length: 33 }, (_, i) => `https://example.com/${i}`).join(' '));
    assert.equal(runner.active(), null); assert.equal(store.recent()[0].status, 'failed');
    assert.match(store.recent()[0].message, /at most 32/);
  } finally { store.close(); }
});

test('natural-language agent uses dependency graphs and reports provider usage in actual task history', async () => {
  const store = new Store(':memory:'); const calls: string[] = []; let turn = 0;
  const id = store.start('Prepare project documents', 'running', '');
  try {
    const result = await runAgent({ id, command: 'Prepare project documents', settings: defaults, store, browser: {} as BrowserSession,
      registry: createRegistry({ openUrl: async url => { calls.push(url); }, openPath: async path => { calls.push(path); throw new Error('Could not open the local brief.'); }, launchTerminal: async () => {} }),
      model: { async decide(_instructions, _context, definitions, previous) {
        assert.ok(definitions.some(tool => tool.name === 'execute_graph'));
        let name = 'execute_graph'; let args: object;
        if (turn === 0) args = { nodes: [{ id: 'invalid', after: ['missing'], action: { action: 'openUrl', url: 'https://example.com/never' } }] };
        else if (turn === 1) {
          assert.match(JSON.stringify(previous?.outputs), /Unknown graph prerequisite/); assert.equal(calls.length, 0);
          args = { nodes: [
            { id: 'brief', after: ['docs'], action: { action: 'openLocal', path: 'C:\\Project\\brief.pdf' } },
            { id: 'docs', after: [], action: { action: 'openUrl', url: 'https://example.com/docs' } },
            { id: 'issues', after: ['brief'], action: { action: 'openUrl', url: 'https://example.com/issues' } },
          ] };
        } else {
          assert.deepEqual(calls, ['https://example.com/docs', 'C:\\Project\\brief.pdf']);
          const output = JSON.parse((previous!.outputs[0] as { output: string }).output);
          assert.deepEqual(output.completedNodes, ['docs']); assert.deepEqual(output.blockedNodes, ['issues']);
          assert.equal(output.failedNode, 'brief'); name = 'finish'; args = { status: 'failed', message: 'The local brief could not be opened; remaining work stopped.' };
        }
        turn++;
        return { items: [], calls: [{ type: 'function_call', name, call_id: 'call' + turn, arguments: JSON.stringify(args) }],
          usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 } };
      } }, signal: new AbortController().signal, publish: () => {}, phase: () => {}, ask: async () => { throw new Error('Unexpected question.'); } });
    assert.equal(result.status, 'failed'); const metrics = store.recent()[0].engine!;
    assert.equal(metrics.modelCalls, 3); assert.equal(metrics.graphPlans, 1); assert.equal(metrics.inputTokens, 300);
    assert.equal(metrics.cachedInputTokens, 120); assert.equal(metrics.outputTokens, 30); assert.equal(metrics.usageReported, true);
  } finally { store.close(); }
});
