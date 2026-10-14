/** Clerk-backed CRM authentication and tenant request context. */
import {createWorkspaceCache} from './workspaceCache.js';

const workspaceCache = createWorkspaceCache();
let cacheIdentity = null, cacheTenant = null, cacheStaff = false;
const identity = () => {
  const session=getSession();
  return session ? JSON.stringify([apiUrl('/api/'),session.id,session.user.id,session.organization?.id || '']) : null;
};
export function configureWorkspaceCache(access) {
  cacheIdentity=identity();cacheTenant=getTenantId();cacheStaff=Boolean(access.capabilities?.platformStaff);
  workspaceCache.activate(cacheIdentity ? JSON.stringify([cacheIdentity,cacheTenant,access.tenants || [],cacheStaff]) : null);
}
export function invalidateWorkspaceCache() {workspaceCache.invalidate();}

let clerk = null;
export const runtimeConfig = globalThis.SMS_CONFIG || {};
export const apiUrl = url => runtimeConfig.apiBase && url.startsWith('/api/')
  ? runtimeConfig.apiBase.replace(/\/$/, '') + url.slice(4) : url;
let demoMode = false;
let localMode = false;
let bootstrapped = false;
const requestKeys = new Map();
let loginNode = null;
let loginMode = 'sign-in';
let loginUnsubscribe = null;
let organizationSwitcherNode = null;
let loginSession = null;
const TENANT_STORAGE_KEY = 'opek_sms_tenant_id';
const DEMO_TENANT_STORAGE_KEY = 'opek_sms_demo_tenant_id';

export function isDemoMode() {
  return demoMode;
}

const clerkAppearance = {
  theme: 'simple',
  captcha: { theme: 'light' },
  variables: {
    colorPrimary: '#087aa5',
    colorBackground: '#ffffff',
    colorForeground: '#172f36',
    colorInputBackground: '#ffffff',
    colorInputText: '#172f36',
    colorText: '#172f36',
    colorTextSecondary: '#536d76',
    colorDanger: '#b32637',
    borderRadius: '8px',
    fontFamily: '"Plus Jakarta Sans", Arial, sans-serif',
  },
  elements: {
    rootBox: { width: '100%', maxWidth: '520px' },
    cardBox: { width: '100%', maxWidth: '520px', margin: '0 auto', borderRadius: '24px', border: '2px solid #cbdfe8', boxShadow: '0 6px 0 #e4eef380, 0 20px 50px -30px #173e4c40' },
    card: {
      width: '100%',
      border: '0',
      background: '#ffffff',
      boxShadow: 'none',
    },
    headerTitle: { fontSize: '24px', fontWeight: 600, letterSpacing: '-.04em', color: '#172f36' },
    headerSubtitle: { color: '#536d76', lineHeight: '1.6' },
    socialButtonsBlockButton: { minHeight: '48px', fontSize: '14px', borderRadius: '999px', background: '#fff', color: '#172f36', border: '2px solid #cbdfe8', boxShadow: '0 1px 2px #173e4c0a' },
    socialButtonsBlockButtonText: { fontSize: '14px', fontWeight: 600, color: '#172f36' },
    formFieldLabel: { fontSize: '13px', fontWeight: 600, color: '#314952' },
    formButtonPrimary: {
      minHeight: '48px',
      fontSize: '14px',
      borderRadius: '999px',
      background: 'linear-gradient(180deg,#0e8fb9,#087aa5)',
      color: '#ffffff',
      boxShadow: '0 8px 16px -10px #087aa580',
    },
    formFieldInput: {
      minHeight: '48px',
      fontSize: '16px',
      border: '2px solid #cbdfe8',
      borderRadius: '10px',
      background: '#fbfdfd',
      boxShadow: 'none',
    },
    footer: { background: '#f0f7fa' },
    footerActionLink: { color: '#087aa5', fontWeight: 600 },
  },
};

export function getTenantId() {
  try {
    return localStorage.getItem(demoMode || runtimeConfig.previewReadOnly ? DEMO_TENANT_STORAGE_KEY : TENANT_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setTenantId(tenantId) {
  const value = String(tenantId || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw new Error('Invalid business account identifier');
  }
  localStorage.setItem(demoMode || runtimeConfig.previewReadOnly ? DEMO_TENANT_STORAGE_KEY : TENANT_STORAGE_KEY, value);
}

export function getSession() {
  if (localMode) return { id: 'local-development', user: { id: 'local-developer', name: 'Local developer', email: '' } };
  if (!clerk?.user || !clerk?.session) return null;
  const email = clerk.user.primaryEmailAddress?.emailAddress ||
    clerk.user.emailAddresses?.[0]?.emailAddress || '';
  return {
    id: clerk.session.id,
    user: {
      id: clerk.user.id,
      email,
      name: clerk.user.fullName || clerk.user.firstName || email,
      imageUrl: clerk.user.imageUrl || null,
    },
    organization: clerk.organization
      ? { id: clerk.organization.id, name: clerk.organization.name, slug: clerk.organization.slug }
      : null,
  };
}

export async function getAccessToken() {
  if (localMode) return 'local-development';
  const started=identity();
  const token=await ((clerk?.session || loginSession)?.getToken() || null);
  if(identity()!==started)throw new DOMException('The signed-in account changed.', 'AbortError');
  return token;
}

export function createOrganizationChangeHandler(sessionId, organizationId, onChange) {
  let activeSessionId = sessionId || null;
  let activeOrganizationId = organizationId || null;
  return ({ session, organization }) => {
    const nextSessionId = session?.id || null;
    const nextOrganizationId = organization?.id || null;
    if (nextSessionId !== activeSessionId) {
      activeSessionId = nextSessionId;
      activeOrganizationId = nextOrganizationId;
      return;
    }
    if (nextSessionId && nextOrganizationId !== activeOrganizationId) {
      activeOrganizationId = nextOrganizationId;
      onChange();
    }
  };
}

export async function initAuth() {
  if (bootstrapped) return { session: getSession(), configured: Boolean(clerk), demo: demoMode };
  bootstrapped = true;

  const cfgRes = await fetch(apiUrl('/api/auth/config'));
  if (!cfgRes.ok) throw new Error('Could not load authentication configuration.');
  const cfg = await cfgRes.json();
  const addBusinessButton = document.getElementById('add-business');
  if (addBusinessButton) addBusinessButton.hidden = cfg.manualBusinesses !== true;
  if (cfg?.mode === 'local') {
    localMode = true;
    document.getElementById('sign-out-btn')?.setAttribute('hidden', '');
    return { session: getSession(), configured: true };
  }
  if (cfg?.mode === 'demo' && cfg.demo === true) {
    demoMode = true;
    return { session: null, configured: false, demo: true };
  }
  if (!cfg?.configured || !cfg.publishableKey) {
    throw new Error(
      'CRM auth is not configured on the server (missing CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY).'
    );
  }

  const clerkOrigin = getClerkOrigin(cfg.frontendApiUrl);
  await loadScript(`${clerkOrigin}/npm/@clerk/ui@1/dist/ui.browser.js`);
  await loadScript(`${clerkOrigin}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, {
    'data-clerk-publishable-key': cfg.publishableKey,
  });

  clerk = globalThis.Clerk;
  if (!clerk || typeof clerk.load !== 'function') {
    throw new Error('The Clerk authentication client failed to load.');
  }
  await clerk.load({
    appearance: clerkAppearance,
    ui: { ClerkUI: globalThis.__internal_ClerkUICtor },
  });
  clerk.addListener(createOrganizationChangeHandler(
    clerk.session?.id,
    clerk.organization?.id,
    () => {
      if (!document.getElementById('crm-app')?.hidden) {
        window.dispatchEvent(new CustomEvent('clerk:organization-changed'));
      }
    },
  ));
  let observedSessionId=clerk.session?.id;
  clerk.addListener(({ session }) => {
    const ended=observedSessionId&&!session;
    const changed=observedSessionId&&session&&observedSessionId!==session.id;
    observedSessionId=session?.id;
    if (!session) {loginSession = null;workspaceCache.activate(null);}
    if (cacheIdentity && identity() !== cacheIdentity) {workspaceCache.activate(null);cacheIdentity=null;}
    if(ended||changed){loginSession=null;requestKeys.clear();}
    if(ended)globalThis.window?.dispatchEvent(new Event('clerk:session-ended'));
    else if(changed)globalThis.window?.dispatchEvent(new Event('clerk:session-changed'));
  });
  return { session: getSession(), configured: true };
}

export async function signOut() {
  workspaceCache.activate(null);cacheIdentity=null;
  loginSession = null;
  if (clerk) await clerk.signOut({ redirectUrl: '/' });
}

/** fetch() wrapper that attaches the current Clerk session token. */
export async function apiFetch(url, options = {}) {
  if ((demoMode || runtimeConfig.previewReadOnly) && !['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase())) {
    return new Response(JSON.stringify({ error: 'Read-only demo: changes, SMS, and calls are disabled.' }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    });
  }
  const { tenant = true, ...fetchOptions } = options;
  const headers = new Headers(options.headers || {});
  // Capture the request context before token retrieval can yield to navigation.
  // Platform tools may explicitly address another authorized business.
  const tenantId = headers.get('X-Tenant-ID') || (tenant ? getTenantId() : '');
  const requestIdentity=identity();
  const assertIdentity=()=>{
    if(identity()!==requestIdentity)throw new DOMException('The signed-in account changed.', 'AbortError');
  };
  const token = await getAccessToken();
  assertIdentity();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (tenantId) headers.set('X-Tenant-ID', tenantId);
  if (options.body && !headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const mutation = String(options.method || 'GET').toUpperCase() === 'POST';
  const fingerprint = `${requestIdentity}:${tenantId}:${url}:${options.body || ''}`;
  if (mutation && !headers.has('Idempotency-Key')) {
    if (!requestKeys.has(fingerprint)) requestKeys.set(fingerprint, crypto.randomUUID());
    headers.set('Idempotency-Key', requestKeys.get(fingerprint));
  }
  const method = String(options.method || 'GET').toUpperCase();
  const write = !['GET','HEAD'].includes(method);
  if (write) invalidateWorkspaceCache();
  if (cacheIdentity && (identity() !== cacheIdentity || getTenantId() !== cacheTenant)) {
    workspaceCache.activate(null);cacheIdentity=null;
  }
  const platformRead = url.startsWith('/api/platform/') && cacheStaff;
  const useCache = cacheIdentity && (platformRead || headers.get('X-Tenant-ID') === cacheTenant);
  const request = async requestOptions => {
    assertIdentity();
    const response=await fetch(apiUrl(url), {...requestOptions,headers});
    assertIdentity();
    return response;
  };
  const response = useCache
    ? await workspaceCache.fetch(url,fetchOptions,request)
    : await request(fetchOptions);
  assertIdentity();
  if (write || response.status === 401 || response.status === 403) invalidateWorkspaceCache();
  if (response.ok || (response.status >= 400 && response.status < 500)) requestKeys.delete(fingerprint);
  return response;
}

export function renderLoginScreen({ onSuccess, errorMessage = '' } = {}) {
  const root = document.getElementById('auth-root');
  const app = document.getElementById('crm-app');
  if (app) app.hidden = true;
  if (!root) return;

  unmountLogin();
  root.hidden = false;
  root.innerHTML = `
    <div class="login-shell">
      <div class="clerk-login-wrap">
        <div class="login-brand">
          <img class="e2-logo" src="/e2-dashboard-logo.svg" alt="E2 Local" width="165" height="60" />
          <span class="product-label">CRM</span>
        </div>
        <p class="login-error">${escapeHtml(errorMessage)}</p>
        <div id="clerk-sign-in"></div>
      </div>
    </div>
  `;

  loginNode = root.querySelector('#clerk-sign-in');
  if (!clerk || !loginNode) return;
  loginMode = new URLSearchParams(location.search).get('auth') === 'sign-up' ? 'sign-up' : 'sign-in';

  let completed = false;
  loginUnsubscribe = clerk.addListener(({ user, session }) => {
    if (!user || !session || completed) return;
    completed = true;
    loginSession = session;
    Promise.resolve(onSuccess?.()).catch((err) => {
      if(err.name==='AbortError')return;
      renderAccessScreen({ errorMessage: err?.message || 'Could not open the CRM.', onRetry: onSuccess });
    });
  });
  const options = {
    appearance: clerkAppearance,
    routing: 'hash',
    forceRedirectUrl: '/',
    signUpForceRedirectUrl: '/',
  };
  if (loginMode === 'sign-up') {
    clerk.mountSignUp(loginNode, { ...options, signInUrl: '/' });
  } else {
    clerk.mountSignIn(loginNode, { ...options, signUpUrl: '/?auth=sign-up', withSignUp: false });
  }
}

export function renderAccessScreen({ errorMessage = 'Could not open the CRM.', onRetry } = {}) {
  const root = document.getElementById('auth-root');
  const app = document.getElementById('crm-app');
  if (app) app.hidden = true;
  if (!root) return;
  unmountLogin();
  root.hidden = false;
  root.innerHTML = `
    <div class="login-shell">
      <div class="clerk-login-wrap">
        <div class="login-brand">
          <img class="e2-logo" src="/e2-dashboard-logo.svg" alt="E2 Local" width="165" height="60" />
          <span class="product-label">CRM</span>
        </div>
        <h1>Workspace unavailable</h1>
        <p class="login-error" role="alert">${escapeHtml(errorMessage)}</p>
        <div class="access-actions">
          <button type="button" class="btn" id="access-retry">Try again</button>
          <button type="button" class="btn ghost" id="access-sign-out">Sign out</button>
        </div>
      </div>
    </div>`;
  root.querySelector('#access-retry')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      await onRetry?.();
    } catch (err) {
      renderAccessScreen({ errorMessage: err?.message || 'Could not open the CRM.', onRetry });
    }
  });
  root.querySelector('#access-sign-out')?.addEventListener('click', async () => {
    await signOut();
    renderLoginScreen({ onSuccess: onRetry });
  });
}

export function showCrmApp() {
  const root = document.getElementById('auth-root');
  const app = document.getElementById('crm-app');
  unmountLogin();
  if (root) {
    root.hidden = true;
    root.innerHTML = '';
  }
  if (app) app.hidden = false;
  mountOrganizationSwitcher();
}

function unmountLogin() {
  if (loginUnsubscribe) loginUnsubscribe();
  loginUnsubscribe = null;
  if (clerk && loginNode) {
    try {
      if (loginMode === 'sign-up') clerk.unmountSignUp(loginNode);
      else clerk.unmountSignIn(loginNode);
    } catch {
      // The host node may already have been removed during navigation.
    }
  }
  loginNode = null;
}

function mountOrganizationSwitcher() {
  const node = document.getElementById('clerk-organization-switcher');
  if (!clerk || !node || organizationSwitcherNode === node) return;
  organizationSwitcherNode = node;
  clerk.mountOrganizationSwitcher(node, { hidePersonal: true });
}

function getClerkOrigin(frontendApiUrl) {
  try {
    const url = new URL(frontendApiUrl);
    if (url.protocol !== 'https:' || !url.hostname) throw new Error('Invalid Clerk domain');
    return url.origin;
  } catch {
    throw new Error('The Clerk Frontend API URL is invalid.');
  }
}

function loadScript(src, attributes = {}) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener(
      'error',
      () => reject(new Error('Could not load Clerk. Check the publishable key and network.')),
      { once: true }
    );
    document.head.appendChild(script);
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
