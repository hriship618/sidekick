import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.ts';
import { Runner } from '../src/runner.ts';
import { createRegistry } from '../src/tools.ts';
import { AttentionController } from '../src/attention.ts';
import { launchIntent, selectApplications } from '../src/app-discovery.ts';
import type { BrowserSession } from '../src/browser.ts';

test('questions summon once and a second question in the same task can summon again', () => {
  const attention = new AttentionController();
  const active = { id: 'run', cancelling: false, questionId: 'one', question: { kind: 'text' as const, text: 'Which app?' } };
  assert.ok(attention.take(active)); assert.equal(attention.take(active), undefined);
  assert.equal(attention.take(null), undefined); assert.equal(attention.take(active), undefined);
  assert.ok(attention.take({ ...active, questionId: 'two' }));
});

test('app discovery matches observed product/package evidence instead of arbitrary parent directory names', () => {
  assert.equal(launchIntent('open Codex'), 'Codex');
  assert.equal(launchIntent('launch Visual Studio Code'), 'Visual Studio Code');
  for (const query of ['open it', 'open Notepad then close Chrome', 'open https://example.com', 'open C:\\Temp', 'open app if it is installed']) assert.equal(launchIntent(query), undefined);
  const candidates = [
    { applicationId: 'app:' + 'a'.repeat(24), name: 'ChatGPT', target: 'OpenAI.Codex_abc!App', source: 'Start menu' },
    { applicationId: 'app:' + 'b'.repeat(24), name: 'Rove', target: 'C:\\Documents\\Codex\\electron.exe', source: 'Windows shortcut' },
  ];
  assert.equal(selectApplications('Codex', candidates)[0].name, 'ChatGPT');
  assert.equal(selectApplications('Codex', candidates).length, 1);
  assert.equal(selectApplications('微信', [{ applicationId: 'app:' + 'd'.repeat(24), name: '微信' }]).length, 1);
  assert.equal(selectApplications('Code', [{ ...candidates[0], name: 'Visual Studio Code', productName: 'Code' }])[0].name, 'Visual Studio Code');
});

test('local launch uses app identity metadata, records conversation, and never constructs a model', async () => {
  const store = new Store(':memory:'); const actions: string[] = [];
  const appId = 'app:' + 'c'.repeat(24);
  const runner = new Runner(store, createRegistry({ openUrl: async () => {}, openPath: async () => {}, launchTerminal: async () => {},
    desktop: async ({ operation }) => {
      actions.push(operation.action);
      if (operation.action === 'listApps') return { verification: 'desktop-observed', message: 'Observed installed app.', data: { apps: [{ applicationId: appId, name: 'ChatGPT', target: 'OpenAI.Codex_abc!App', source: 'Start menu' }] } };
      assert.equal(operation.action, 'launchApp'); assert.equal(operation.applicationId, appId);
      return { verification: 'dispatch-only', message: 'Launch requested for ChatGPT. Readiness unverified.', data: { launchRequested: true } };
    } }), () => {}, { fastDesktop: true, configured: () => false, model: async () => { assert.fail('Local app launch must not use a model.'); }, browser: {} as BrowserSession });
  try {
    await runner.run('open codex'); const run = store.recent()[0];
    assert.deepEqual(actions, ['listApps', 'launchApp']); assert.equal(run.status, 'completed');
    assert.equal(run.engine?.modelCalls, 0); assert.deepEqual(run.messages?.map(message => message.role), ['user', 'assistant']);
  } finally { store.close(); }
});

test('question answers and follow-ups retain message history and pass bounded conversation to the model', async () => {
  const store = new Store(':memory:'); let answering = false; let turns = 0; let sawPriorAnswer = false;
  const runner = new Runner(store, createRegistry({ openUrl: async () => {}, openPath: async () => {}, launchTerminal: async () => {} }), () => {
    const active = runner.active();
    if (active?.question && !answering) { answering = true; queueMicrotask(() => runner.answer(active.id, 'Project Atlas')); }
  }, { configured: () => true, browser: {} as BrowserSession, model: async () => ({ async decide(_instructions, context) {
    const state = JSON.parse(context);
    const name = turns++ === 0 ? 'ask_user' : 'finish';
    if (state.goal === 'What did I say?') sawPriorAnswer = JSON.stringify(state.conversation).includes('Project Atlas');
    return { items: [], calls: [{ type: 'function_call', name, call_id: 'c' + turns,
      arguments: JSON.stringify(name === 'ask_user' ? { question: 'Which project?', manualLogin: false } : { status: 'failed', message: 'Fixture finished without OS actions.' }) }] };
  } }) });
  try {
    await runner.run('Prepare my project'); const first = store.recent()[0];
    assert.deepEqual(first.messages?.map(message => message.text), ['Prepare my project', 'Which project?', 'Project Atlas', 'Fixture finished without OS actions.']);
    await runner.followUp(first.id, 'What did I say?');
    assert.equal(sawPriorAnswer, true); assert.ok(store.recent()[0].messages!.some(message => message.text === 'Project Atlas'));
  } finally { store.close(); }
});
