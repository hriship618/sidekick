import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BrowserSession } from '../src/browser.ts';
import { openAIModel, testModel } from '../src/model.ts';
import { defaults } from '../src/contracts.ts';
import { runAgent } from '../src/agent.ts';
import type { ToolCall } from '../src/model.ts';
import { Runner } from '../src/runner.ts';
import { Store } from '../src/store.ts';
import { createRegistry } from '../src/tools.ts';

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  let failure: unknown;
  const server = createServer((request, response) => {
    void Promise.resolve().then(() => handler(request, response)).catch(error => {
      failure = error;
      response.writeHead(500).end();
    });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return { error: () => failure, base: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
async function body(request: IncomingMessage) {
  let value = '';
  for await (const chunk of request) value += chunk;
  return JSON.parse(value);
}
function call(response: ServerResponse, name: string, args: object, index = 0) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    id: `resp_${index}`, status: 'completed', object: 'response',
    output: [{ type: 'function_call', name, arguments: JSON.stringify(args), call_id: `call_${index}`, id: `fc_${index}`, status: 'completed' }],
  }));
}

test('provider connection checks tool calling and sanitizes a rejected credential', async () => {
  const endpoint = await fixture(async (request, response) => {
    const input = await body(request);
    assert.equal(input.model, 'test-model');
    assert.equal(input.store, false);
    if (request.headers.authorization === 'Bearer rejected-secret') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'bad rejected-secret' } }));
      return;
    }
    call(response, 'connection_check', {});
  });
  try {
    await testModel(openAIModel('fixture-key', 'test-model', endpoint.base));
    await assert.rejects(testModel(openAIModel('rejected-secret', 'test-model', endpoint.base)), error => {
      assert.match(String(error), /OpenAI rejected the API key/);
      assert.doesNotMatch(String(error), /rejected-secret/);
      return true;
    });
  } finally { await endpoint.close(); }
});

const edgeInstalled = process.platform === 'win32' && [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
  .some(root => root && existsSync(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')));

test('runner resumes a question, verifies a real browser batch, and stops a later batch on failure', { skip: !edgeInstalled }, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'sidekick-agent-'));
  const store = new Store(':memory:');
  const browser = new BrowserSession(folder, { channel: 'msedge', headless: true });
  let neverVisited = false;
  let next: (() => void) | undefined;
  const questionReached = new Promise<void>(resolve => { next = resolve; });
  const page = await fixture((request, response) => {
    if (request.url === '/never') neverVisited = true;
    if (request.url === '/missing') { response.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Missing</h1>'); return; }
    if (request.url === '/cookie') {
      response.setHeader('content-type', 'text/html');
      response.end(request.headers.cookie?.includes('sidekick=ready') ? '<h1>Profile persisted</h1>' : '<h1>Missing cookie</h1>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sidekick=ready; Max-Age=3600; Path=/' });
    response.end('<h1>Lab form</h1><label>Name <input></label><button onclick="document.querySelector(\'output\').textContent=\'Saved\'">Preview</button><output></output>');
  });
  let turn = 0;
  let staticPrefix: string | undefined;
  const endpoint = await fixture(async (request, response) => {
    const req = await body(request);
    const index = turn++;
    const prefix = JSON.stringify({ instructions: req.instructions, tools: req.tools, cacheKey: req.prompt_cache_key });
    staticPrefix ??= prefix;
    assert.equal(prefix, staticPrefix, 'prefix and tool catalog remain byte-stable across turns');
    assert.equal(req.input.at(-1).role, 'user', 'volatile context is last');
    const last = req.input.filter((item: { type?: string }) => item.type === 'function_call_output').at(-1);
    const visible = (name: string) => ({ by: 'text', name });
    const outputs = [
      () => call(response, 'ask_user', { question: 'What name should I enter?', manualLogin: false }, index),
      () => {
        assert.match(last.output, /Ada/);
        const actions = [
          { action: 'navigate', url: page.base, expect: { origin: page.base, visible: visible('Lab form') } },
          { action: 'fill', origin: page.base, target: { by: 'label', name: 'Name' }, value: 'Ada', expect: { origin: page.base } },
          { action: 'click', origin: page.base, target: { by: 'role', role: 'button', name: 'Preview' }, expect: { origin: page.base, visible: visible('Saved') } },
        ];
        call(response, 'execute_graph', { nodes: actions.map((action, i) => ({ id: `step${i + 1}`, after: i ? [`step${i}`] : [], action })) }, index);
      },
      () => {
        assert.match(last.output, /Field value verified/);
        call(response, 'inspect', {}, index);
      },
      () => {
        const result = JSON.parse(last.output);
        assert.match(result.text, /Saved/);
        call(response, 'read_evidence', { id: result.evidenceId }, index);
      },
      () => {
        assert.match(last.output, /Lab form/);
        call(response, 'batch', { actions: [
          { action: 'navigate', url: page.base + '/missing', expect: { origin: page.base } },
          { action: 'navigate', url: page.base + '/never' },
        ] }, index);
      },
      () => {
        assert.match(last.output, /HTTP 404/);
        call(response, 'finish', { status: 'completed', message: 'Verified the form preview. A later navigation returned HTTP 404.' }, index);
      },
    ];
    outputs[index]();
  });
  try {
    const registry = createRegistry({ openUrl: async () => {}, openPath: async () => {}, launchTerminal: async () => {} });
    const runner = new Runner(store, registry, () => {
      const active = runner.active();
      if (active?.question?.kind === 'text') next?.();
      assert.notEqual(active?.question?.kind, 'approval', 'ordinary form preparation must not ask permission');
    }, { configured: () => true, model: async () => openAIModel('fixture-key', 'test-model', endpoint.base), browser });
    const run = runner.run('Fill in the browser form and preview it.');
    await questionReached;
    const waiting = runner.active()!;
    assert.equal(waiting.question?.kind, 'text');
    runner.answer(waiting.id, 'Ada');
    await run;
    if (endpoint.error()) throw endpoint.error();
    const [saved] = store.recent();
    assert.equal(saved.status, 'completed');
    assert.deepEqual(saved.steps.map(step => step.tool), ['navigate', 'fill', 'click', 'inspect', 'navigate']);
    assert.equal(saved.steps.at(-1)?.status, 'failed');
    assert.equal(neverVisited, false);
    await browser.close();
    const signal = new AbortController().signal;
    await browser.execute('navigate', { url: page.base + '/cookie' }, signal);
    assert.match((await browser.execute('inspect', { target: { by: 'role', role: 'heading', name: 'Profile persisted' } }, signal)).text!, /Profile persisted/);
    const screenshot = await browser.execute('screenshot', {}, signal);
    assert.equal(screenshot.data?.kind, 'image');
    assert.deepEqual(screenshot.data?.bytes.subarray(0, 2), Buffer.from([0xff, 0xd8]));
  } finally {
    await browser.close();
    await Promise.all([endpoint.close(), page.close()]);
    store.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test('browser form stops at review even when the model attempts a final batch', { skip: !edgeInstalled }, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'sidekick-review-'));
  const browser = new BrowserSession(folder, { channel: 'msedge', headless: true });
  const store = new Store(':memory:');
  let submitted = false;
  const page = await fixture((request, response) => {
    if (request.url === '/submit') submitted = true;
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<h1>Registration</h1><form method="post" action="/submit"><label>Name <input name="name"></label><button type="button" onclick="document.querySelector(\'h1\').textContent=\'Review your request\'">Review</button><button>Submit</button></form>');
  });
  let turn = 0;
  const id = store.start('Fill my form and stop at review', 'running', '');
  try {
    const result = await runAgent({
      id, command: 'Fill my form and stop at review', settings: defaults,
      store, browser, registry: createRegistry({ openUrl: async () => { assert.fail('boundary bypass'); }, openPath: async () => {}, launchTerminal: async () => {} }),
      signal: new AbortController().signal, phase: () => {}, publish: () => {},
      ask: async () => { assert.fail('unexpected approval'); },
      model: {
        async decide(_instructions, context, _tools, previous) {
          const script = [
            { name: 'navigate', args: { url: page.base } },
            { name: 'fill', args: { origin: page.base, target: { by: 'label', name: 'Name' }, value: 'Ada' } },
            { name: 'click', args: { origin: page.base, target: { by: 'role', role: 'button', name: 'Review' }, expect: { origin: page.base, visible: { by: 'role', role: 'heading', name: 'Review your request' } } } },
            { name: 'batch', args: { actions: [
              { action: 'click', origin: page.base, target: { by: 'role', role: 'button', name: 'Submit' }, expect: { origin: page.base, visible: { by: 'text', name: 'Done' } } },
              { action: 'openUrl', url: page.base + '/submit' },
            ] } },
            { name: 'finish', args: { status: 'completed', message: 'The form is ready at review. No submission was made.' } },
          ];
          if (turn === 4) {
            assert.match(JSON.stringify(previous?.outputs), /review boundary/);
            assert.match(context, /"boundaryReached":true/);
          }
          const item = script[turn++];
          const call: ToolCall = { type: 'function_call', name: item.name, arguments: JSON.stringify(item.args), call_id: 'review-' + turn };
          return { calls: [call], items: [call] };
        },
      },
    });
    assert.equal(result.status, 'completed');
    assert.equal(submitted, false);
    assert.equal(store.recent()[0].steps.length, 3);
  } finally {
    await browser.close();
    await page.close();
    store.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});
