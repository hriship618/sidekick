import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaults, settingsSchema, type Settings } from '../src/contracts.ts';
import { createRegistry, sshArguments, type PlatformTools } from '../src/tools.ts';
import { Store } from '../src/store.ts';
import { Runner } from '../src/runner.ts';
import { planCommand } from '../src/workflow.ts';

const configured: Settings = { ...defaults, shortcut: 'Ctrl+Alt+F9' };
const noops: PlatformTools = { openUrl: async () => {}, openPath: async () => {}, launchTerminal: async () => {} };

test('settings validation and shortcut canonicalization', () => {
  assert.equal(settingsSchema.parse({ ...configured, shortcut: ' alt + ctrl + space ' }).shortcut, defaults.shortcut);
  assert.equal(settingsSchema.safeParse({ ...configured, shortcut: 'A' }).success, false);
});

test('legacy example fields are ignored when loading preferences', () => {
  const store = new Store(':memory:');
  try {
    const legacy = { ...configured, courses: [{ name: 'Example' }], shellLabCourseId: 'legacy' };
    store.save(legacy);
    assert.deepEqual(store.settings(), configured);
  } finally { store.close(); }
});
test('registry validates every dispatch and declares verification and retry behavior', async () => {
  const calls: string[] = [];
  const registry = createRegistry({ ...noops, openPath: async path => { calls.push(path); } });
  for (const invalid of ['javascript:alert(1)', 'https://user:password@example.com', 'file:///C:/file']) {
    await assert.rejects(registry.openUrl.run({ url: invalid }));
  }
  for (const invalid of ['-oProxyCommand=bad', 'name;new-tab', 'user@host']) {
    assert.throws(() => sshArguments({ alias: invalid, directory: '/home/user' }));
  }
  for (const invalid of ['/home/evil;wt', '/home/$(bad)', "/home/quote'bad", '/home/line\nbreak']) {
    assert.throws(() => sshArguments({ alias: 'server', directory: invalid }));
  }
  await assert.rejects(registry.openLocal.run({ path: '\\\\server\\share' }));
  await assert.rejects(registry.openLocal.run({ path: 'C:\\file.txt:stream' }));
  assert.equal((await registry.openLocal.run({ path: 'C:\\My files\\lab.txt' })).verification, 'dispatch-only');
  assert.deepEqual(calls, ['C:\\My files\\lab.txt']);
  for (const tool of Object.values(registry)) {
    assert.equal(tool.retryMayDuplicate, true);
    assert.ok(tool.input && tool.output && tool.verification);
  }
});

test('explicit commands report failures and persist their results', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sidekick-'));
  const file = join(directory, 'test.sqlite');
  try {
    const store = new Store(file);
    try {
      store.save(configured);
      const runner = new Runner(store, createRegistry({
        ...noops, async openUrl() { throw new Error('Browser rejected request'); },
      }), () => {});
      await runner.run('open https://example.com');
    } finally { store.close(); }
    const reopened = new Store(file);
    try {
      assert.deepEqual(reopened.settings(), configured);
      const [run] = reopened.recent();
      assert.equal(run.status, 'failed');
      assert.equal(run.steps[0].error, 'Browser rejected request');
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('reopening the database marks an unfinished run without replaying it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sidekick-'));
  const file = join(directory, 'test.sqlite');
  try {
    const store = new Store(file);
    const plan = planCommand('open https://example.com');
    assert.ok(plan);
    const id = store.start('Open two links', 'running', '', [...plan.actions, ...plan.actions]);
    store.updateStep(id, 0, 'running');
    store.close();
    const reopened = new Store(file);
    try {
      const [run] = reopened.recent();
      assert.equal(run.status, 'interrupted');
      assert.deepEqual(run.steps.map(step => step.status), ['failed', 'skipped']);
      assert.match(run.steps[0].error!, /may have happened/);
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('cancellation preserves an in-flight dispatch and rejects another run', async () => {
  const store = new Store(':memory:');
  try {
    store.save(configured);
    const calls: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const runner = new Runner(store, createRegistry({
      ...noops,
      async openUrl(url) { calls.push(url); await pending; },
    }), () => {});
    const result = runner.run('open https://example.com');
    const active = runner.active()!;
    await assert.rejects(runner.run('open https://example.com'), /already running/);
    runner.cancel('old-run');
    assert.equal(runner.active()?.cancelling, false);
    runner.cancel(active.id);
    assert.equal(runner.active()?.cancelling, true);
    release();
    await result;
    const [run] = store.recent();
    assert.equal(run.status, 'cancelled');
    assert.deepEqual(calls, ['https://example.com']);
    assert.deepEqual(run.steps.map(step => step.status), ['completed']);
    assert.ok(run.finishedAt);
    assert.equal(runner.active(), null);
  } finally { store.close(); }
});

test('opening executable content checks its effect once and can be declined', async () => {
  const store = new Store(':memory:');
  try {
    const calls: string[] = [];
    const path = 'C:\\Rove\\helper.cmd';
    const runner = new Runner(store, createRegistry({ ...noops, openPath: async value => { calls.push(value); } }), () => {});
    const declined = runner.run('open ' + path);
    const first = runner.active()!;
    assert.equal(first.question?.kind, 'approval');
    runner.answer('old-run', true);
    assert.deepEqual(calls, []);
    runner.answer(first.id, false);
    await declined;
    assert.equal(store.recent()[0].status, 'failed');
    assert.equal(store.recent()[0].steps[0].status, 'failed');
    assert.deepEqual(calls, []);
    const approved = runner.run('open ' + path);
    runner.answer(runner.active()!.id, true);
    await approved;
    assert.equal(store.recent()[0].status, 'completed');
    assert.deepEqual(calls, [path]);
  } finally { store.close(); }
});

test('preference defaults preserve earlier settings', () => {
  const { showCompanion, animateCompanion, model: _model, ...old } = configured;
  assert.equal(showCompanion, true);
  assert.equal(animateCompanion, true);
  assert.deepEqual(settingsSchema.parse(old), configured);
});
