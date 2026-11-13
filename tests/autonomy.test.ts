import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaults } from '../src/contracts.ts';
import { ExecutionPolicy } from '../src/execution-policy.ts';
import { createRegistry } from '../src/tools.ts';
import { Runner } from '../src/runner.ts';
import { Store } from '../src/store.ts';
import { BrowserSession } from '../src/browser.ts';
import type { AgentModel, ToolCall } from '../src/model.ts';
import { clampPosition, panelNearCompanion, restingPosition, companionViewport, contains, dockedPosition, taskbarEdge, nearDock } from '../src/companion-geometry.ts';

const noops = { openUrl: async (_url: string) => {}, openPath: async (_path: string) => {}, launchTerminal: async (_args: string[]) => {} };
const toolCall = (name: string, args: object): ToolCall => ({ type: 'function_call', call_id: 'call-' + name, name, arguments: JSON.stringify(args) });

test('app identity and window IDs survive progress turns and large unrelated window lists', async () => {
  const store = new Store(':memory:');
  const calls: string[] = [];
  let turn = 0;
  const target = { windowId: '987', processId: 654, title: 'ChatGPT', processName: 'ChatGPT', productName: 'Codex' };
  const runner = new Runner(store, createRegistry({ ...noops, desktop: async ({ operation }) => {
    calls.push(operation.action);
    if (operation.action === 'closeWindow') {
      assert.equal(operation.windowId, target.windowId);
      assert.equal(operation.processId, target.processId);
      return { verification: 'desktop-observed', message: 'Verified the window closed.', data: { windowClosed: true, processStillRunning: true } };
    }
    const others = Array.from({ length: 20 }, (_, i) => ({ windowId: String(i + 100), processId: i + 200, title: 'Unrelated '.repeat(90), processName: 'Other', productName: 'Other' }));
    return { verification: 'desktop-observed', message: 'Observed product identities.', data: { windows: [...others, target] } };
  } }), () => {}, {
    configured: () => true, browser: {} as BrowserSession,
    model: async () => ({ async decide(_instructions, context) {
      turn++;
      if (turn === 3) {
        const observations = JSON.stringify(JSON.parse(context).desktopObservations);
        assert.ok(observations.includes('Codex'));
        assert.ok(observations.includes('ChatGPT'));
        assert.ok(observations.includes('987'), 'observed target survives intervening progress');
      }
      const call = turn === 1 ? toolCall('desktop', { operation: { action: 'listWindows' } })
        : turn === 2 ? toolCall('status_update', { message: 'Found the application by its product name.' })
          : turn === 3 ? toolCall('desktop', { operation: { action: 'closeWindow', windowId: target.windowId, processId: target.processId } })
            : toolCall('finish', { status: 'completed', message: 'Codex window closed; its background process remains.' });
      return { calls: [call], items: [call] };
    } }),
  });
  try {
    await runner.run('close codex');
    assert.deepEqual(calls, ['listWindows', 'closeWindow']);
    assert.equal(store.recent()[0].status, 'completed');
    assert.equal(turn, 4);
  } finally { store.close(); }
});

test('alternating successful desktop discovery cannot consume the execution limit', async () => {
  const store = new Store(':memory:');
  let actions = 0, turns = 0;
  const runner = new Runner(store, createRegistry({ ...noops, desktop: async ({ operation }) => {
    actions++;
    return { verification: 'desktop-observed', message: 'No matching application window.', data: operation.action === 'listWindows' ? { windows: [] } : { processes: [] } };
  } }), () => {}, {
    configured: () => true, browser: {} as BrowserSession,
    model: async () => ({ async decide() {
      const call = toolCall('desktop', { operation: ++turns % 2 ? { action: 'listWindows', query: 'Missing app' } : { action: 'listProcesses', name: 'Missing app' } });
      return { calls: [call], items: [call] };
    } }),
  });
  try {
    await runner.run('Close Missing app');
    assert.equal(actions, 4, 'identical reads are reused instead of repeatedly dispatching PowerShell');
    assert.equal(turns, 7);
    const run = store.recent()[0];
    assert.equal(run.status, 'failed');
    assert.match(run.message, /observed desktop state/);
    assert.doesNotMatch(run.message, /execution limit/);
  } finally { store.close(); }
});

test('desktop requests reach the native adapter and finish without routine approval questions', async () => {
  const store = new Store(':memory:');
  const operations: string[] = [];
  let turn = 0;
  const runner = new Runner(store, createRegistry({ ...noops, desktop: async ({ operation }) => {
    operations.push(operation.action);
    return { verification: 'desktop-observed', message: operation.action === 'listWindows' ? 'Observed the requested window.' : 'Verified the window closed.',
      data: operation.action === 'listWindows' ? { windows: [{ windowId: '123', processId: 456, title: 'Test app' }] } : { windowClosed: true } };
  } }), () => { assert.equal(runner.active()?.question, undefined); }, {
    configured: () => true,
    model: async () => ({ async decide(instructions, _context, definitions) {
      assert.ok(definitions.some(tool => tool.name === 'desktop'));
      assert.ok(instructions.includes('native Windows window/process controls'));
      const call = ++turn === 1 ? toolCall('desktop', { operation: { action: 'listWindows' } })
        : turn === 2 ? toolCall('desktop', { operation: { action: 'closeWindow', windowId: '123', processId: 456 } })
          : toolCall('finish', { status: 'completed', message: 'Closed the requested test app.' });
      return { calls: [call], items: [call] };
    } }), browser: {} as BrowserSession,
  });
  try {
    await runner.run('Close the Test app window');
    assert.deepEqual(operations, ['listWindows', 'closeWindow']);
    assert.equal(store.recent()[0].status, 'completed');
    assert.equal(store.recent()[0].steps[1].result?.verification, 'desktop-observed');
    store.save({ ...defaults, desktopAccess: false });
    assert.equal(store.settings().desktopAccess, false);
  } finally { store.close(); }
});

test('requested sites, multiple links, files and a saved SSH routine run without approvals', async () => {
  const store = new Store(':memory:');
  const calls: unknown[] = [];
  try {
    store.save({ ...defaults, routines: [{
      id: '8da85705-7ed6-4ee9-b3ab-086e0da120a7', name: 'Start shell lab',
      resources: ['https://example.com/handout', 'https://example.com/slides', 'C:\\Materials\\recitation.pdf'],
      sshAlias: 'campus', remoteDir: '~/workspace',
    }] });
    const runner = new Runner(store, createRegistry({
      openUrl: async value => { calls.push(value); }, openPath: async value => { calls.push(value); }, launchTerminal: async args => { calls.push(args); },
    }), () => { assert.equal(runner.active()?.question, undefined); });
    await runner.run('Open YouTube');
    await runner.run('Open these three links https://example.com/a https://example.com/b https://example.com/c');
    await runner.run('Start shell lab');
    assert.equal(calls.length, 8);
    assert.equal(calls[0], 'https://www.youtube.com/');
    assert.deepEqual(calls.at(-1), ['-t', 'campus', "cd ~/'workspace' && exec /bin/sh -i"]);
    assert.ok(store.recent().every(run => run.status === 'completed'));
  } finally { store.close(); }
});

test('answers carry into later tool calls while progress never becomes a question', async () => {
  const store = new Store(':memory:');
  let questions = 0;
  const calls: string[] = [];
  let turn = 0;
  const model: AgentModel = {
    async decide(_instructions, context, tools, previous) {
      assert.ok(tools.some(tool => tool.name === 'batch'));
      const script = [
        toolCall('status_update', { message: 'Finding the requested materials' }),
        toolCall('get_context', { query: 'resources' }),
        toolCall('ask_user', { question: 'Which three links should I open?', manualLogin: false }),
        toolCall('ask_user', { question: 'Which three links should I open?', manualLogin: false }),
        toolCall('batch', { actions: [
          { action: 'openUrl', url: 'https://example.com/a' }, { action: 'openUrl', url: 'https://example.com/b' }, { action: 'openUrl', url: 'https://example.com/c' },
        ] }),
        toolCall('finish', { status: 'completed', message: 'Sent the three links to the browser.' }),
      ];
      if (turn >= 3) assert.match(context, /Use these three links/);
      if (turn === 5) assert.match(JSON.stringify(previous?.outputs), /Actions processed/);
      const call = script[turn++];
      return { calls: [call], items: [call] };
    },
  };
  const runner = new Runner(store, createRegistry({ ...noops, openUrl: async url => { calls.push(url); } }), () => {
    const active = runner.active();
    if (active?.question) {
      questions++;
      assert.equal(active.question.kind, 'text');
      queueMicrotask(() => runner.answer(active.id, 'Use these three links https://example.com/a https://example.com/b https://example.com/c'));
    }
  }, { configured: () => true, model: async () => model, browser: new BrowserSession('unused') });
  try {
    await runner.run('Find and open my requested resource links');
    assert.equal(store.recent()[0].status, 'completed');
    assert.equal(questions, 1);
    assert.equal(calls.length, 3);
  } finally { store.close(); }
});

test('policy distinguishes navigation, task approvals and explicit stopping conditions', async () => {
  let prompts = 0;
  const ask = async () => { prompts++; return true; };
  const policy = new ExecutionPolicy('Fill the form, then stop at review.', ask);
  await policy.authorize({ effect: 'edit', label: 'Name', origin: 'https://example.com', review: false });
  await policy.authorize({ effect: 'navigation', label: 'Review', origin: 'https://example.com', review: false });
  policy.observedReview(true);
  assert.throws(() => policy.beforeAction('openUrl'), /review boundary/);
  await assert.rejects(policy.authorize({ effect: 'submission', label: 'Submit', origin: 'https://example.com', review: true }), /review boundary/);
  assert.equal(prompts, 0);
  const ordinary = new ExecutionPolicy('Prepare my registration.', ask);
  const final = { effect: 'submission' as const, label: 'Submit', origin: 'https://example.com', destination: '/registration', review: true };
  await ordinary.authorize(final);
  await ordinary.authorize(final);
  assert.equal(prompts, 1);
  const another = new ExecutionPolicy('Prepare my registration.', ask);
  await another.authorize(final);
  assert.equal(prompts, 2);
  const explicit = new ExecutionPolicy('Submit my registration.', ask);
  await explicit.authorize(final);
  assert.equal(prompts, 2);
  await explicit.authorize({ ...final, label: 'Pay now' });
  assert.equal(prompts, 3);
});

test('companion and attached panels stay within usable monitor bounds', () => {
  const area = { x: -1280, y: 40, width: 1280, height: 720 };
  for (const corner of ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const) {
    const point = restingPosition({ ...defaults, restingCorner: corner }, 'monitor', area);
    const bounds = panelNearCompanion(point, area, 580, 212);
    assert.ok(bounds.x >= area.x && bounds.y >= area.y);
    assert.ok(bounds.x + bounds.width <= area.x + area.width);
    assert.ok(bounds.y + bounds.height <= area.y + area.height);
  }
  assert.deepEqual(clampPosition(9999, -100, area), { x: 1216, y: 0 });
  assert.deepEqual(restingPosition({ ...defaults, restingPosition: { displayId: 'monitor', x: 1, y: 1 } }, 'monitor', { ...area, width: 800, height: 500 }), { x: 736, y: 436 });
});

test('docked head and compact host never occupy the taskbar, including scaled and negative-origin displays', () => {
  for (const area of [{ x: 0, y: 0, width: 1536, height: 816 }, { x: -1280, y: 40, width: 1280, height: 680 }]) {
    const bottom = dockedPosition({ x: area.width - 86, y: 0 }, area, 'bottom', true);
    assert.equal(bottom.y + 16, area.height - 24);
    assert.equal(bottom.y + 36, area.height - 4, 'both eyes remain visible');
    const host = companionViewport(bottom, area);
    assert.ok(host.width <= 380 && host.height <= 200);
    assert.ok(host.x >= 0 && host.y >= 0);
    assert.ok(host.x + host.width <= area.width && host.y + host.height <= area.height);
    assert.equal(contains(host, { x: bottom.x + 20, y: area.height }), false, 'taskbar receives its own clicks');
    assert.equal(contains(host, { x: bottom.x + 20, y: area.height - 8 }), true);
    assert.equal(dockedPosition(bottom, area, 'bottom', false).y, area.height - 64);
  }
  const full = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.equal(taskbarEdge(full, { ...full, height: 1032 }), 'bottom');
  assert.equal(taskbarEdge(full, { ...full, x: 48, width: 1872 }), 'left');
  assert.equal(taskbarEdge(full, { ...full, y: 48, height: 1032 }), 'top');
  assert.equal(taskbarEdge(full, { ...full, width: 1872 }), 'right');
  assert.equal(nearDock({ x: 100, y: 980 }, full, 'bottom'), false);
  assert.equal(nearDock({ x: 100, y: 1040 }, full, 'bottom'), true);
  assert.equal(nearDock({ x: 15, y: 100 }, full, 'left'), true);
  assert.equal(nearDock({ x: 100, y: 15 }, full, 'top'), true);
  assert.equal(nearDock({ x: 1860, y: 100 }, full, 'right'), true);
});


test('unchanged failed targets stop after two browser attempts', async () => {
  const store = new Store(':memory:');
  let executed = 0;
  let requested = 0;
  const missing = 'The requested heading was not found. Use the observed page content.';
  const runner = new Runner(store, createRegistry(noops), () => {}, {
    configured: () => true,
    model: async () => ({
      async decide() {
        requested++;
        const call = toolCall('inspect', { target: { by: 'role', role: 'heading', name: 'Missing' } });
        return { calls: [call], items: [call] };
      },
    }),
    browser: {
      location: () => 'https://example.com/',
      execute: async () => { executed++; throw new Error(missing); },
    } as unknown as BrowserSession,
  });
  try {
    await runner.run('Inspect the page heading');
    assert.equal(executed, 2);
    assert.equal(requested, 3);
    assert.equal(store.recent()[0].status, 'failed');
    assert.equal(store.recent()[0].message, missing);
  } finally { store.close(); }
});
