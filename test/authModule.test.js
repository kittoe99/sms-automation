import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const authUrl = file => new URL(source(file).match(/from ['"]([^'"]*auth\.js[^'"]*)['"]/)[1], new URL(`../public/${file}`, import.meta.url));

test('app, platform management and live updates resolve the same authentication module', () => {
  assert.equal(authUrl('platform.js').href, authUrl('app.js').href);
  assert.equal(authUrl('live.js').href, authUrl('app.js').href);
});

test('initializing app authentication supplies tokens to Users, Businesses, Websites and live updates', async t => {
  const originals = Object.fromEntries(['fetch', 'document', 'Clerk', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
  const requests = [], listeners = [];
  let activeToken = 'synthetic-crm-session';
  const session = { id: 'test-session', getToken: async () => activeToken };
  globalThis.Clerk = { user: { id: 'test-user', emailAddresses: [] }, session, load: async () => {},
    addListener: fn => { listeners.push(fn); return () => {}; } };
  globalThis.localStorage = { getItem: () => null };
  globalThis.document = { getElementById: () => null,
    createElement: () => { const events = {}; return { setAttribute() {}, addEventListener: (name, callback) => { events[name] = callback; }, loaded: () => events.load() }; },
    head: { appendChild: script => script.loaded() } };
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/auth/config')) return Response.json({ configured: true, publishableKey: 'pk_test_fixture', frontendApiUrl: 'https://clerk.example.test' });
    const authorization = options.headers.get('Authorization');
    requests.push({ url, authorization });
    if (authorization !== `Bearer ${activeToken}`) return Response.json({ error: 'Sign in required' }, { status: 401 });
    return Response.json({ rows: [], total: 0, totalPages: 1 });
  };
  const appAuth = await import(authUrl('app.js'));
  await appAuth.initAuth();
  const { createPlatform } = await import('../public/platform.js');
  const root = { innerHTML: '', classList: { add() {} }, querySelectorAll: () => [], querySelector: () => null, insertAdjacentHTML(_position, html) { this.innerHTML += html; } };
  const platform = createPlatform({ root, title: {}, subtitle: {}, pager: {} });
  for (const view of ['accounts', 'businesses', 'websites']) {
    await platform.render(`platform-${view}`);
    assert.doesNotMatch(root.innerHTML, /Sign in required/);
    assert.equal(requests.at(-1).authorization, 'Bearer synthetic-crm-session');
    assert.match(requests.at(-1).url, new RegExp(`/platform/${view}`));
  }
  const liveAuth = await import(authUrl('live.js'));
  activeToken = 'synthetic-refreshed-session';
  assert.equal(await liveAuth.getAccessToken(), activeToken);
  globalThis.Clerk.session = null;
  listeners.forEach(fn => fn({ session: null }));
  assert.equal(await appAuth.getAccessToken(), null);
  assert.equal(await liveAuth.getAccessToken(), null);
});
