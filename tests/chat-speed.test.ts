import assert from 'node:assert/strict';
import { test } from 'node:test';
import { instantReply, isConversation } from '../src/conversation-mode.ts';
import { Store } from '../src/store.ts';
import { Runner } from '../src/runner.ts';
import { createRegistry } from '../src/tools.ts';
import type { BrowserSession } from '../src/browser.ts';

const registry = () => createRegistry({ openUrl: async () => { assert.fail('Chat opened a URL.'); }, openPath: async () => { assert.fail('Chat opened a file.'); }, launchTerminal: async () => { assert.fail('Chat opened SSH.'); } });
test('greetings and thanks are instant, offline, and cannot swallow an appended task', async () => {
  for (const command of ['hi', 'Hello!', 'hey Rove', 'thanks', 'how are you?']) assert.ok(instantReply(command));
  for (const command of ['hi, open Codex', 'thanks now delete the file', 'hey open Chrome', 'hi and close Notepad']) assert.equal(instantReply(command), undefined);
  const store = new Store(':memory:');
  const runner = new Runner(store, registry(), () => {}, { configured: () => false, browser: {} as BrowserSession, model: async () => { assert.fail('Greeting called a provider.'); } });
  try {
    await runner.run('hi'); const run = store.recent()[0];
    assert.equal(run.status, 'completed'); assert.equal(run.engine?.modelCalls, 0); assert.equal(run.steps.length, 0);
    assert.deepEqual(run.messages?.map(item => item.role), ['user', 'assistant']);
  } finally { store.close(); }
});

test('informational chat uses one small reply tool, not the execution loop', async () => {
  assert.equal(isConversation('Explain recursion'), true);
  for (const command of ['What apps are running?', 'What is my current volume?', 'What is the latest price?', 'Open Notepad']) assert.equal(isConversation(command), false);
  const store = new Store(':memory:'); let calls = 0;
  const runner = new Runner(store, registry(), () => {}, { configured: () => true, browser: {} as BrowserSession, model: async () => ({ async decide(instructions, _context, tools) {
    calls++; assert.ok(instructions.length < 1000); assert.equal(tools.length, 1); assert.equal(tools[0].name, 'reply');
    return { items: [], calls: [{ type: 'function_call', name: 'reply', call_id: 'reply1', arguments: JSON.stringify({ message: 'Recursion solves a problem by calling a smaller version of itself.' }) }] };
  } }) });
  try { await runner.run('Explain recursion'); assert.equal(calls, 1); assert.equal(store.recent()[0].status, 'completed'); assert.equal(store.recent()[0].steps.length, 0); }
  finally { store.close(); }
});

test('general conversational fallback may reply without an OS action', async () => {
  const store = new Store(':memory:'); let count = 0;
  const runner = new Runner(store, registry(), () => {}, { configured: () => true, browser: {} as BrowserSession, model: async () => ({ async decide() {
    count++; return { items: [], calls: [{ type: 'function_call', name: 'reply', call_id: 'r', arguments: JSON.stringify({ message: 'Octopuses have three hearts.' }) }] };
  } }) });
  try { await runner.run('Tell me something fun'); assert.equal(count, 1); assert.equal(store.recent()[0].status, 'completed'); }
  finally { store.close(); }
});

test('a chat response cannot claim completion of a requested computer action', async () => {
  const store = new Store(':memory:'); let count = 0;
  const runner = new Runner(store, registry(), () => {}, { configured: () => true, browser: {} as BrowserSession, model: async () => ({ async decide(_i, _c, _t, previous) {
    const first = count++ === 0;
    if (!first) assert.match(JSON.stringify(previous?.outputs), /cannot stand in for execution/);
    return { items: [], calls: [{ type: 'function_call', name: first ? 'reply' : 'finish', call_id: 'r' + count,
      arguments: JSON.stringify(first ? { message: 'Closed it.' } : { status: 'failed', message: 'No desktop action was performed.' }) }] };
  } }) });
  try { await runner.run('close Notepad'); assert.equal(count, 2); assert.equal(store.recent()[0].status, 'failed'); }
  finally { store.close(); }
});
