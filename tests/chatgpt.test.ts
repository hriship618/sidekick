import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { ChatGPTConnection } from '../src/chatgpt.ts';
import { chatGPTModel, testModel } from '../src/model.ts';
import { Store } from '../src/store.ts';

test('ChatGPT registration verifies the callback and signed identity, renews the grant, and signs out', async () => {
  const store = new Store(':memory:');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
  const issuer = 'https://auth.openai.com';
  const client = 'oaiapp_fixture';
  const planScope = 'openid offline_access chatgpt.tokens.use.direct';
  let nonce = '';
  let callback = '';
  let hostId = '';
  let authCount = 0;
  let refreshCount = 0;
  let revokeCount = 0;
  let signInScope = planScope;
  const options = {
    protection: { encrypt: async (value: string) => Buffer.from(value, 'utf8'), decrypt: async (value: Buffer) => value.toString('utf8') },
    publish: () => {},
    async openBrowser(target: string) {
      const url = new URL(target);
      assert.equal(url.origin, issuer);
      assert.equal(url.searchParams.get('client_id'), authCount ? client : 'dynamic_agent_client');
      assert.equal(url.searchParams.get('agent_name_hint'), authCount ? null : 'Rove');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.match(url.searchParams.get('scope')!, /chatgpt.tokens.use.direct/);
      const host = url.searchParams.get('ext_agent_host_id')!;
      if (!hostId) hostId = host;
      assert.equal(host, hostId);
      nonce = url.searchParams.get('nonce')!;
      callback = url.searchParams.get('redirect_uri')!;
      assert.equal((await fetch(callback + '?state=wrong')).status, 400);
      const response = new URL(callback);
      response.searchParams.set('state', url.searchParams.get('state')!);
      response.searchParams.set('code', 'fixture-code');
      if (!authCount) response.searchParams.set('client_id', client);
      assert.equal((await fetch(response)).status, 200);
      authCount++;
    },
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) return Response.json({
        issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token',
        jwks_uri: issuer + '/jwks', revocation_endpoint: issuer + '/revoke', id_token_signing_alg_values_supported: ['RS256'],
      });
      if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
      if (url.endsWith('/token')) {
        const body = new URLSearchParams(init?.body?.toString());
        assert.equal(body.get('client_id'), client);
        assert.equal(body.get('resource'), 'https://api.openai.com/v1');
        if (body.get('grant_type') === 'refresh_token') {
          assert.equal(body.get('refresh_token'), 'fixture-refresh');
          refreshCount++;
          return Response.json({ access_token: 'fixture-renewed', refresh_token: 'fixture-rotated', token_type: 'Bearer', expires_in: 3600 });
        }
        assert.equal(body.get('code'), 'fixture-code');
        assert.equal(body.get('redirect_uri'), callback);
        assert.ok(body.get('code_verifier')!.length > 42);
        const encoded = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const now = Math.floor(Date.now() / 1000);
        const head = encoded({ alg: 'RS256', kid: 'fixture' });
        const claims = encoded({ iss: issuer, aud: client, sub: 'fixture-user', email: 'fixture@example.com', nonce, iat: now, exp: now + 600 });
        const payload = `${head}.${claims}`;
        const jwt = `${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`;
        return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer',
          expires_in: 1, scope: signInScope, id_token: jwt });
      }
      if (url.endsWith('/models')) {
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-renewed');
        return Response.json({ models: [
          { slug: 'fixture-model', display_name: 'Fixture model', visibility: 'list' },
          { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' },
        ] });
      }
      if (url.endsWith('/revoke')) {
        const body = new URLSearchParams(init?.body?.toString());
        assert.equal(body.get('token'), 'fixture-rotated');
        assert.equal(body.get('client_id'), client);
        revokeCount++;
        return new Response(null, { status: 200 });
      }
      throw new Error('Unexpected fixture request.');
    },
  };

  try {
    const connection = new ChatGPTConnection(store, options);
    await connection.initialize();
    await connection.signIn();
    assert.equal(connection.status().sharing, true, connection.status().notice);
    assert.equal(refreshCount, 1);
    assert.deepEqual(connection.status().models, [{ slug: 'fixture-model', name: 'Fixture model' }]);
    assert.doesNotMatch(JSON.stringify(connection.status()), /fixture-renewed|fixture-rotated/);
    connection.dismissWelcome();
    const reopened = new ChatGPTConnection(store, options);
    await reopened.initialize();
    assert.equal(await reopened.accessToken(), 'fixture-renewed');
    await reopened.signOut();
    assert.equal(revokeCount, 1);
    assert.equal(reopened.status().connected, false);
    await assert.rejects(reopened.accessToken(), /Continue with ChatGPT/);
    signInScope = 'openid offline_access';
    await reopened.signIn();
    assert.equal(reopened.status().connected, true);
    assert.equal(reopened.status().sharing, false);
    assert.equal(refreshCount, 1);
    assert.equal(authCount, 2);
  } finally { store.close(); }
});

test('ChatGPT model sends a plan-compatible tool stream and surfaces plan exhaustion', async () => {
  let exhausted = false;
  let requested = 0;
  let failure: unknown;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(request.headers.authorization, 'Bearer plan-fixture');
      assert.equal(body.model, 'eligible-model');
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.equal(body.max_output_tokens, undefined);
      assert.equal(body.tools[0].type, 'namespace');
      assert.equal(body.tools[0].tools[0].name, 'connection_check');
      requested++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = exhausted ? {
        type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } },
      } : {
        type: 'response.completed', response: { status: 'completed', output: [
          { type: 'function_call', namespace: 'sidekick', name: 'connection_check', arguments: '{}', call_id: 'fixture' },
        ] },
      };
      response.end(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch (error) { failure = error; response.writeHead(500).end(); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const model = chatGPTModel(async () => 'plan-fixture', 'eligible-model', `http://127.0.0.1:${address.port}`);
    await testModel(model).catch(error => { throw failure ?? error; });
    exhausted = true;
    await assert.rejects(testModel(model), /ChatGPT plan usage limit reached/);
    assert.equal(requested, 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

