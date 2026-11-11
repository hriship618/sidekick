import * as oauth from 'oauth4webapi';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { z } from 'zod';
import type { ChatGPTStatus } from './contracts.ts';
import type { Store } from './store.ts';

const issuer = new URL('https://auth.openai.com');
const resource = 'https://api.openai.com/v1';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const grant = 'chatgpt.tokens.use.direct';
const profileSchema = z.object({
  clientId: z.string().min(1), subject: z.string().optional(), email: z.string().optional(),
  accessToken: z.string().optional(), refreshToken: z.string().optional(), idToken: z.string().optional(),
  scopes: z.array(z.string()).default([]), expiresAt: z.number().default(0),
});
type Profile = z.infer<typeof profileSchema>;
type Protection = { encrypt(value: string): Promise<Buffer>; decrypt(value: Buffer): Promise<string> };
type Options = { protection: Protection; openBrowser(url: string): Promise<void>; publish(): void; fetch?: typeof fetch };

function authError(error: unknown) {
  if (error instanceof oauth.AuthorizationResponseError && error.error === 'access_denied') return 'ChatGPT sign-in was declined. You can try again in Settings.';
  return 'ChatGPT could not complete sign-in. Try again and approve plan access in the browser.';
}

export class ChatGPTConnection {
  private readonly store: Store;
  private readonly options: Options;
  private profiles = new Map<string, Profile>();
  private selectedId = '';
  private models: ChatGPTStatus['models'] = [];
  private notice = '';
  private welcome = false;
  private busy = false;
  private attempt?: AbortController;
  private readonly refreshing = new Map<string, Promise<void>>();
  private catalogRevision = 0;
  private metadata?: oauth.AuthorizationServer;
  private hostId = '';

  constructor(store: Store, options: Options) {
    this.store = store;
    this.options = options;
  }

  status(): ChatGPTStatus {
    const selected = this.profiles.get(this.selectedId);
    return {
      busy: this.busy, signingIn: Boolean(this.attempt), selectedId: this.selectedId, connected: Boolean(selected?.accessToken),
      sharing: Boolean(selected?.accessToken && selected.scopes.includes(grant)),
      profiles: [...this.profiles.entries()].map(([id, profile], index) => ({
        id, label: `${profile.email ?? 'ChatGPT connection'} · ${index + 1}`, connected: Boolean(profile.accessToken),
      })),
      models: this.models, notice: this.notice, welcome: this.welcome,
    };
  }

  private requestOptions(signal?: AbortSignal) {
    return { [oauth.customFetch]: this.options.fetch ?? fetch, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) };
  }

  private async server(signal?: AbortSignal) {
    if (this.metadata) return this.metadata;
    const response = await oauth.discoveryRequest(issuer, this.requestOptions(signal));
    const metadata = await oauth.processDiscoveryResponse(issuer, response);
    for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri, metadata.revocation_endpoint]) {
      if (!endpoint || new URL(endpoint).origin !== issuer.origin) throw new Error('Unexpected ChatGPT authorization endpoint.');
    }
    this.metadata = metadata;
    return metadata;
  }

  async initialize() {
    this.hostId = this.store.metadata('chatgpt-host') ?? this.store.metadata('chatgpt-host', `urn:uuid:${randomUUID()}`)!;
    this.selectedId = this.store.metadata('chatgpt-selected') ?? '';
    for (const row of this.store.authProfiles()) {
      try { this.profiles.set(row.id, profileSchema.parse(JSON.parse(await this.options.protection.decrypt(row.encrypted)))); }
      catch { this.notice = 'Windows could not unlock a saved ChatGPT connection. Sign in again.'; }
    }
  }

  private async save(id: string, profile: Profile) {
    const encrypted = await this.options.protection.encrypt(JSON.stringify(profile));
    this.store.saveAuthProfile(id, encrypted);
    this.profiles.set(id, profile);
  }

  private selectId(id: string) {
    this.store.metadata('chatgpt-selected', id);
    this.selectedId = id;
    this.catalogRevision++;
    this.models = [];
  }

  cancel() { this.attempt?.abort(new Error('ChatGPT sign-in cancelled.')); }
  dismissWelcome() { this.welcome = false; this.store.metadata('chatgpt-welcomed', 'true'); this.options.publish(); }

  async signIn(newAccount = false) {
    if (this.busy) throw new Error('Finish or cancel the current ChatGPT account action.');
    this.busy = true;
    this.notice = '';
    const controller = new AbortController();
    this.attempt = controller;
    const timeout = setTimeout(() => controller.abort(new Error('ChatGPT sign-in timed out. Try again.')), 300_000);
    this.options.publish();
    try {
      const signal = controller.signal;
      const metadata = await this.server(signal);
      const id = !newAccount && this.profiles.has(this.selectedId) ? this.selectedId : randomUUID();
      let profile = this.profiles.get(id);
      const state = oauth.generateRandomState();
      const nonce = oauth.generateRandomNonce();
      const verifier = oauth.generateRandomCodeVerifier();
      const challenge = await oauth.calculatePKCECodeChallenge(verifier);
      const oldClient = profile?.clientId;
      const client: oauth.Client = { client_id: oldClient ?? 'dynamic_agent_client' };
      const callbackServer = createServer();
      let finish!: (value: URL) => void;
      let fail!: (reason: unknown) => void;
      const callback = new Promise<URL>((resolve, reject) => { finish = resolve; fail = reject; });
      // Attach a rejection handler before opening the browser or cancelling.
      void callback.catch(() => {});
      const abort = () => fail(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      try {
        await new Promise<void>((resolve, reject) => {
          callbackServer.once('error', reject);
          callbackServer.listen(0, '127.0.0.1', resolve);
        });
        const address = callbackServer.address();
        if (!address || typeof address === 'string') throw new Error('Could not start the sign-in callback.');
        const redirect = `http://127.0.0.1:${address.port}/auth/callback`;
        callbackServer.on('request', (request, response) => {
          const path = request.url ?? '/';
          const url = URL.canParse(path, redirect) ? new URL(path, redirect) : undefined;
          const returnedState = Buffer.from(url?.searchParams.get('state') ?? '');
          const expected = Buffer.from(state);
          const sameState = returnedState.length === expected.length
            && timingSafeEqual(returnedState, expected);
          if (request.method !== 'GET' || url?.pathname !== '/auth/callback'
              || request.headers.host !== `127.0.0.1:${address.port}` || !sameState) {
            response.writeHead(400, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Invalid sign-in response.');
            return;
          }
          response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
            'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          }).end('<!doctype html><title>Sidekick</title><h1>Return to Sidekick</h1><p>Your sign-in response has been received.</p>');
          finish(url);
        });
        const authorization = new URL(metadata.authorization_endpoint!);
        authorization.search = new URLSearchParams({
          client_id: client.client_id, response_type: 'code', redirect_uri: redirect, scope: scopes, resource,
          state, nonce, code_challenge_method: 'S256', code_challenge: challenge, ext_agent_host_id: this.hostId,
          ...(!oldClient ? { agent_name_hint: 'Sidekick' } : {}),
          ...(profile?.idToken ? { id_token_hint: profile.idToken } : {}),
          ...(profile?.email ? { login_hint: profile.email } : {}),
          ...(profile && !profile.scopes.includes(grant) ? { prompt: 'consent' } : {}),
        }).toString();
        signal.throwIfAborted();
        await this.options.openBrowser(authorization.href);
        const returned = await callback;
        signal.throwIfAborted();
        const params = oauth.validateAuthResponse(metadata, client, returned, state);
        const issued = params.get('client_id');
        if (oldClient && issued && issued !== oldClient) throw new Error('The ChatGPT registration did not match.');
        const clientId = oldClient ?? issued;
        if (!clientId || clientId === 'dynamic_agent_client') throw new Error('ChatGPT did not return a client registration.');
        profile ??= { clientId, scopes: [], expiresAt: 0 };
        // Preserve a newly issued registration even if the one-time code expires.
        await this.save(id, profile);
        if (!this.selectedId) this.selectId(id);
        const registered: oauth.Client = { client_id: clientId };
        const response = await oauth.authorizationCodeGrantRequest(metadata, registered, oauth.None(), params, redirect, verifier, {
          ...this.requestOptions(signal), additionalParameters: { resource },
        });
        const tokens = await oauth.processAuthorizationCodeResponse(metadata, registered, response, { expectedNonce: nonce, requireIdToken: true });
        await oauth.validateApplicationLevelSignature(metadata, response, this.requestOptions(signal));
        const identity = oauth.getValidatedIdTokenClaims(tokens)!;
        if (profile.subject && identity.sub !== profile.subject) throw new Error('The selected ChatGPT account did not match.');
        signal.throwIfAborted();
        await this.save(id, {
          clientId, subject: identity.sub, email: typeof identity.email === 'string' ? identity.email : undefined,
          accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token,
          scopes: (tokens.scope ?? '').split(' ').filter(Boolean), expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        });
        this.selectId(id);
        if (this.status().sharing && !this.store.metadata('chatgpt-welcomed')) this.welcome = true;
      } finally {
        signal.removeEventListener('abort', abort);
        callbackServer.closeAllConnections();
        await new Promise<void>(resolve => callbackServer.close(() => resolve()));
      }
      if (this.status().sharing) await this.refreshModels();
      else this.notice = 'Signed in. ChatGPT plan access was not granted. Continue with ChatGPT again to enable it.';
    } catch (error) {
      this.notice = controller.signal.aborted ? String(controller.signal.reason.message) : authError(error);
      throw new Error(this.notice);
    } finally {
      clearTimeout(timeout);
      this.attempt = undefined;
      this.busy = false;
      this.options.publish();
    }
  }

  async select(id: string) {
    if (this.busy || !this.profiles.has(id)) throw new Error('Choose an available ChatGPT connection.');
    this.selectId(id);
    this.notice = '';
    if (this.status().sharing) await this.refreshModels();
    this.options.publish();
  }

  async accessToken(id = this.selectedId, signal?: AbortSignal): Promise<string> {
    if (id !== this.selectedId) throw new Error('The ChatGPT account changed. Start the task again.');
    const profile = this.profiles.get(id);
    if (!profile?.accessToken || !profile.scopes.includes(grant)) throw new Error('Continue with ChatGPT in Settings and approve plan access.');
    if (profile.expiresAt <= Date.now() + 60_000) {
      let refresh = this.refreshing.get(id);
      if (!refresh) {
        refresh = this.refresh(id).finally(() => { this.refreshing.delete(id); });
        this.refreshing.set(id, refresh);
      }
      await refresh;
    }
    signal?.throwIfAborted();
    if (id !== this.selectedId) throw new Error('The ChatGPT account changed. Start the task again.');
    const latest = this.profiles.get(id);
    if (!latest?.accessToken || !latest.scopes.includes(grant)) throw new Error('Sign in to ChatGPT again and approve plan access.');
    return latest.accessToken;
  }

  private async refresh(id: string, signal?: AbortSignal) {
    const profile = this.profiles.get(id)!;
    if (!profile.refreshToken) throw new Error('Sign in to ChatGPT again in Settings.');
    try {
      const metadata = await this.server(signal);
      const client: oauth.Client = { client_id: profile.clientId };
      const response = await oauth.refreshTokenGrantRequest(metadata, client, oauth.None(), profile.refreshToken, {
        ...this.requestOptions(signal), additionalParameters: { resource },
      });
      const tokens = await oauth.processRefreshTokenResponse(metadata, client, response);
      if (tokens.id_token) {
        await oauth.validateApplicationLevelSignature(metadata, response, this.requestOptions(signal));
        if (oauth.getValidatedIdTokenClaims(tokens)?.sub !== profile.subject) throw new Error('ChatGPT identity changed during refresh.');
      }
      await this.save(id, {
        ...profile, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? profile.refreshToken,
        idToken: tokens.id_token ?? profile.idToken,
        scopes: tokens.scope === undefined ? profile.scopes : tokens.scope.split(' ').filter(Boolean),
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      });
    } catch (error) {
      if (error instanceof oauth.ResponseBodyError && ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(error.error)) {
        await this.save(id, { clientId: profile.clientId, subject: profile.subject, email: profile.email, scopes: [], expiresAt: 0 });
        this.models = [];
        this.notice = 'The ChatGPT session expired or was revoked. Continue with ChatGPT again.';
      } else this.notice = 'ChatGPT could not refresh the session. Try again shortly.';
      this.options.publish();
      throw new Error(this.notice);
    }
  }

  async refreshModels() {
    const revision = ++this.catalogRevision;
    try {
      const accessToken = await this.accessToken();
      const response = await (this.options.fetch ?? fetch)(resource + '/models', {
        headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error('ChatGPT model access could not be checked.');
      const catalog = z.object({ models: z.array(z.object({
        slug: z.string().min(1).max(160), display_name: z.string().max(160), visibility: z.string(),
      })) }).parse(await response.json());
      if (revision !== this.catalogRevision) return;
      this.models = catalog.models.filter(model => model.visibility === 'list').map(model => ({ slug: model.slug, name: model.display_name }));
      this.notice = this.models.length ? '' : 'This ChatGPT account has no available models for Sidekick.';
    } catch {
      if (revision !== this.catalogRevision) return;
      this.models = [];
      this.notice ||= 'Could not load ChatGPT models. Refresh the connection in Settings.';
    }
    this.options.publish();
  }

  async signOut() {
    if (this.busy) throw new Error('Finish or cancel sign-in first.');
    this.busy = true;
    this.options.publish();
    const id = this.selectedId;
    this.catalogRevision++;
    await this.refreshing.get(id)?.catch(() => {});
    const profile = this.profiles.get(id);
    let revoked = !profile?.refreshToken;
    try {
      if (profile?.refreshToken) {
        try {
          const metadata = await this.server();
          const response = await oauth.revocationRequest(metadata, { client_id: profile.clientId }, oauth.None(), profile.refreshToken, {
            ...this.requestOptions(), additionalParameters: { token_type_hint: 'refresh_token' },
          });
          revoked = response.status === 200;
        } catch { revoked = false; }
      }
      if (profile) await this.save(id, { clientId: profile.clientId, subject: profile.subject, email: profile.email, scopes: [], expiresAt: 0 });
      this.models = [];
      this.notice = revoked ? 'Signed out of ChatGPT.' : 'Signed out locally. Remote revocation was not confirmed. Review access in ChatGPT usage settings.';
    } finally { this.busy = false; this.options.publish(); }
  }
}

